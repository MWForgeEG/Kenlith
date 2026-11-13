'use strict';

// The boundary between Kenlith and the files of a project folder (M1-1A,
// C7-R1, DEC-PLANCHAT-011). Every project file Kenlith reads goes through
// readContained(); nothing here sends anything anywhere.
//
// API
//   resolveRoot(folderPath) -> Promise<{ ok: true, root } | { ok: false, reason }>
//     The folder's path as the file system stores it (native realpath).
//     Refuses relative, UNC (\\server\share), device and namespace paths
//     (\\?\, \\.\), and anything that is not a local directory.
//   checkRelative(relPath) -> { ok: true, segments, relPath } | { ok: false, reason: 'invalid-path', detail }
//     A folder-relative path: no absolute path or drive letter, no "." or
//     "..", no ":" (alternate data streams), no reserved device name (CON,
//     PRN, AUX, NUL, COM0-9, LPT0-9, with any extension), no trailing dot or
//     space, no control or wildcard characters.
//   classifySensitive(relPath) -> { withheld: 'sensitive', category } | {}
//     Layer C names: everything src/attachments.js classifyPath blocks, plus
//     Git internals, more key and credential files, Terraform state and
//     kubeconfig. Compared without case distinction. No setting changes it.
//   statContained(root, relPath) -> Promise<{ ok: true, ino, size, mtimeMs } | { ok: false, reason }>
//     The checks of readContained() without opening or reading.
//   readContained(root, relPath, { maxBytes, hooks }) -> Promise<{ ok: true, text, sha256, size, mtimeMs, ino } | { ok: false, reason, category? }>
//     Reads one file inside `root` (a value from resolveRoot) and returns its
//     text, or why it was refused. `hooks.beforeOpen(path)` and
//     `hooks.afterOpen(path)` exist only for tests that swap files.
//
// Reason codes: invalid-path, sensitive, missing, link, not-file, alias,
// outside-root, hard-link, changed, too-large, binary, credential-content,
// unreadable; for roots also root-unsupported, root-unavailable.
//
// How a read is checked (all on the actual Windows file system):
//   1. The relative path is valid (checkRelative) and not sensitive.
//   2. lstat: not a symbolic link, junction or other link; a regular file.
//   3. The native realpath equals the path built from the root and the
//      segments exactly. Any alias (case, short 8.3 name, link in a parent
//      folder) is refused rather than interpreted. It is inside the root.
//   4. The file is opened read-only. After opening, the handle's identity
//      (device and file index, from fstat) must equal both the identity seen
//      before opening and the identity of the path checked again now, so a
//      file swapped between the checks and the open is refused.
//   5. The handle reports exactly one link: a hard link inside the folder can
//      point at a file elsewhere and still resolve inside, so any file with
//      more than one link is refused (fail closed; Node reports NTFS link
//      counts correctly, see the WP-03 evidence).
//   6. The bytes are read from the verified handle, within the size limit;
//      binary content and credential-like lines withhold the whole file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { classifyPath, credentialLines, isInside } = require('./attachments');
const { hasSensitiveText } = require('./sensitive-text');

const fsp = fs.promises;
const realpathNative = promisify(fs.realpath.native);

const DEFAULT_MAX_BYTES = 512 * 1024;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tif', 'tiff', 'psd', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'war', 'o', 'obj', 'a', 'lib', 'pdb', 'pyc', 'pyo', 'woff', 'woff2', 'ttf',
  'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg', 'avi', 'mov', 'mkv', 'webm', 'sqlite', 'db', 'vsix', 'node', 'wasm', 'iso', 'dmg', 'msi'
]);

// Layer C additions to classifyPath (C7-R1).
const SENSITIVE_DIRECTORIES = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker']);
const SENSITIVE_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', 'kubeconfig', 'credentials', 'credentials.json']);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.kdbx', '.p8'];

function hasBinaryExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function checkRelative(relPath) {
  const fail = (detail) => ({ ok: false, reason: 'invalid-path', detail });
  if (typeof relPath !== 'string' || !relPath) return fail('empty');
  if (/[\u0000-\u001f]/.test(relPath)) return fail('control character');
  // Direction controls could make a name display as a different one.
  if (/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(relPath)) return fail('direction control character');
  if (/^[a-z]:/i.test(relPath) || /^[\\/]/.test(relPath) || path.isAbsolute(relPath)) return fail('absolute');
  const segments = relPath.split(/[\\/]+/).filter((segment) => segment !== '');
  if (!segments.length) return fail('empty');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return fail('dot segment');
    if (segment.includes(':')) return fail('stream or drive');
    if (/[<>"|?*]/.test(segment)) return fail('wildcard or reserved character');
    if (/[. ]$/.test(segment)) return fail('trailing dot or space');
    if (RESERVED.test(segment.replace(/[. ]+$/, ''))) return fail('reserved device name');
  }
  return { ok: true, segments, relPath: segments.join('/') };
}

function classifySensitive(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  const name = parts.at(-1) || '';
  const blocked = classifyPath(relPath).blocked;
  if (blocked) return { withheld: 'sensitive', category: blocked };
  if (parts.slice(0, -1).some((part) => SENSITIVE_DIRECTORIES.has(part)) || SENSITIVE_DIRECTORIES.has(name)) {
    return { withheld: 'sensitive', category: name === '.git' || parts.includes('.git') ? 'Git internals' : 'a credentials folder' };
  }
  if (SENSITIVE_NAMES.has(name)) return { withheld: 'sensitive', category: 'a credential store' };
  if (SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension)) || name.startsWith('id_')) {
    return { withheld: 'sensitive', category: 'a private key or certificate' };
  }
  if (name.includes('.tfstate')) return { withheld: 'sensitive', category: 'a credential store' };
  return {};
}

async function resolveRoot(folderPath) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) return { ok: false, reason: 'root-unsupported' };
  if (/^[\\/]{2}/.test(folderPath)) return { ok: false, reason: 'root-unsupported' };
  let root;
  try {
    root = await realpathNative(folderPath);
  } catch {
    return { ok: false, reason: 'root-unavailable' };
  }
  // A mapped network drive can resolve to a UNC path: not a local folder.
  if (/^[\\/]{2}/.test(root)) return { ok: false, reason: 'root-unsupported' };
  try {
    if (!(await fsp.stat(root)).isDirectory()) return { ok: false, reason: 'root-unavailable' };
  } catch {
    return { ok: false, reason: 'root-unavailable' };
  }
  return { ok: true, root: path.normalize(root) };
}

// A file id of 0 (some network or virtual file systems) proves nothing, so it
// never counts as the same file: the read is refused (fail closed).
const sameFile = (a, b) => Boolean(a.ino) && a.ino === b.ino && a.dev === b.dev;

// Steps 1 to 3 of the module header. Returns the checked absolute path and
// its lstat (bigint), or a refusal.
async function checkPath(root, relPath) {
  const relative = checkRelative(relPath);
  if (!relative.ok) return relative;
  const sensitive = classifySensitive(relative.relPath);
  if (sensitive.withheld) return { ok: false, reason: 'sensitive', category: sensitive.category };
  const candidate = path.join(root, ...relative.segments);
  let link;
  try {
    link = await fsp.lstat(candidate, { bigint: true });
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (link.isSymbolicLink()) return { ok: false, reason: 'link' };
  if (!link.isFile()) return { ok: false, reason: 'not-file' };
  let real;
  try {
    real = path.normalize(await realpathNative(candidate));
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isInside(real, root)) return { ok: false, reason: 'outside-root' };
  if (real !== path.normalize(candidate)) return { ok: false, reason: 'alias' };
  if (link.nlink !== 1n) return { ok: false, reason: 'hard-link' };
  return { ok: true, candidate, link, relPath: relative.relPath };
}

async function statContained(root, relPath) {
  const checked = await checkPath(root, relPath);
  if (!checked.ok) return checked;
  return { ok: true, ino: checked.link.ino, size: Number(checked.link.size), mtimeMs: Number(checked.link.mtimeMs) };
}

// RC3: whether a text holds a withheld value. Long values anywhere; short
// ones (4 to 7 characters) only as whole words, and never all digits (a short
// number is too common to refuse files for).
function holdsValue(text, value) {
  if (value.length < 4 || !text.includes(value)) return false;
  if (value.length >= 8) return true;
  if (/^\d+$/.test(value)) return false;
  const re = new RegExp(`(?<![A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}(?![A-Za-z0-9])`);
  return re.test(text);
}

async function readContained(root, relPath, { maxBytes = DEFAULT_MAX_BYTES, hooks = {}, sending = false, withheldValues = [] } = {}) {
  const checked = await checkPath(root, relPath);
  if (!checked.ok) return checked;
  const { candidate, link } = checked;
  if (hasBinaryExtension(candidate)) return { ok: false, reason: 'binary' };
  if (link.size > BigInt(maxBytes)) return { ok: false, reason: 'too-large' };

  if (hooks.beforeOpen) await hooks.beforeOpen(candidate);
  let handle;
  try {
    handle = await fsp.open(candidate, 'r');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    if (hooks.afterOpen) await hooks.afterOpen(candidate);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return { ok: false, reason: 'not-file' };
    if (!sameFile(opened, link)) return { ok: false, reason: 'changed' };
    if (opened.nlink !== 1n) return { ok: false, reason: 'hard-link' };
    // The path, checked again now that the file is open, must still be the
    // same contained file.
    let again;
    try {
      again = await fsp.lstat(candidate, { bigint: true });
    } catch {
      return { ok: false, reason: 'changed' };
    }
    if (again.isSymbolicLink() || !sameFile(again, opened)) return { ok: false, reason: 'changed' };
    let real;
    try {
      real = path.normalize(await realpathNative(candidate));
    } catch {
      return { ok: false, reason: 'changed' };
    }
    if (real !== path.normalize(candidate) || !isInside(real, root)) return { ok: false, reason: 'changed' };
    if (opened.size > BigInt(maxBytes)) return { ok: false, reason: 'too-large' };

    // Read from the verified handle; one byte more shows growth past the limit.
    const capacity = Number(opened.size) + 1;
    const buffer = Buffer.alloc(Math.min(capacity, maxBytes + 1));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { ok: false, reason: 'too-large' };
    const bytes = buffer.subarray(0, filled);
    if (bytes.subarray(0, 8192).includes(0)) return { ok: false, reason: 'binary' };
    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (credentialLines(text).length) return { ok: false, reason: 'credential-content' };
    // RC3 (DEC-PLANCHAT-036): content that will be sent to ChatGPT (read tools,
    // excerpts) is also refused when it holds other sensitive text.
    if (sending && (hasSensitiveText(text) || withheldValues.some((value) => holdsValue(text, value)))) return { ok: false, reason: 'credential-content' };
    return {
      ok: true,
      text,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: filled,
      mtimeMs: Number(opened.mtimeMs),
      ino: opened.ino
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

module.exports = {
  BINARY_EXTENSIONS,
  DEFAULT_MAX_BYTES,
  checkRelative,
  classifySensitive,
  hasBinaryExtension,
  readContained,
  resolveRoot,
  statContained
};
