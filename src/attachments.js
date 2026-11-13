'use strict';

// Selected code attachments (Phase 3.1 stage 3; architecture revision 3,
// §4–§6, owner decisions DEC-PLANCHAT-003 to -005 in docs/DECISIONS.md).
//
// - Only the primary selection of the active editor, captured when the user
//   asks. No workspace file is ever read or scanned: the text comes from the
//   editor's document, once, and the file on disk is only resolved (realpath)
//   for the folder and blocked-file checks.
// - The size is known from offsets before reading; an oversized selection is
//   refused unread. Nothing is truncated or redacted.
// - The snapshot is frozen. Its text lives in this window's memory until it
//   is sent once, removed or replaced; only metadata is ever stored.
// - The selected text never goes to a log, a notification or an error: refusal
//   reasons name the file, the size and line numbers, never the text.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { SECRET_PATTERNS } = require('./util');

const realpathNative = promisify(fs.realpath.native);

// ---------- blocked files (§4.4; DEC-PLANCHAT-005: no override) ----------

const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'];
const KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const CREDENTIAL_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', 'credentials', 'credentials.json']);
const CREDENTIAL_EXTENSIONS = ['.kdbx', '.tfstate', '.tfstate.backup'];
const BLOCKED_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker']);

// For one path: { blocked: category } or { envExample: true } or {}.
function classifyPath(filePath) {
  const parts = String(filePath).split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  const name = parts.at(-1) || '';
  if (parts.slice(0, -1).some((part) => BLOCKED_DIRECTORIES.has(part))) {
    return { blocked: 'a credentials folder' };
  }
  if (name === '.env' || name.startsWith('.env.')) {
    return ENV_EXAMPLES.has(name) ? { envExample: true } : { blocked: 'an environment file' };
  }
  if (KEY_EXTENSIONS.some((extension) => name.endsWith(extension)) || KEY_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { blocked: 'a private key or certificate' };
  }
  if (CREDENTIAL_NAMES.has(name) || CREDENTIAL_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return { blocked: 'a credential store' };
  }
  return {};
}

const trimSeparators = (value) => {
  let result = value;
  while (result.length > 1 && /[\\/]$/.test(result) && !/^[a-z]:[\\/]$/i.test(result)) result = result.slice(0, -1);
  return result;
};

// A path as typed compared loosely with its resolved form, only to word a
// refusal "(through a link)": case-insensitive on Windows (the editor reports
// "c:\", the file system "C:\"), no trailing separator.
function fold(value, platform = process.platform) {
  let result = path.normalize(value);
  result = platform === 'win32' ? result.toLowerCase() : result.normalize('NFC');
  return trimSeparators(result);
}

// Containment of two paths that are both resolved by the native realpath,
// with a separator boundary. On Windows they are compared exactly as stored,
// as the project identity is (§3.3 amendment): lower-casing or NFC would let a
// file in a different folder ("Café" decomposed, or a name with the Kelvin
// sign) count as inside this one.
function isInside(child, parent, platform = process.platform) {
  const exact = (value) => trimSeparators(path.normalize(value));
  const [inner, outer] = platform === 'win32' ? [exact(child), exact(parent)] : [fold(child, platform), fold(parent, platform)];
  return inner === outer || inner.startsWith(/[\\/]$/.test(outer) ? outer : outer + path.sep);
}

// ---------- possible credentials (§4.4) ----------

const EXTRA_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|pwd)\s*=\s*[^\s;'"]+/i
];
const CREDENTIAL_PATTERNS = [
  ...SECRET_PATTERNS.map(([pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', ''))),
  ...EXTRA_PATTERNS
];

// 1-based line numbers (of the selection) where a pattern matches.
function credentialLines(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const found = [];
  lines.forEach((line, index) => {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(line))) found.push(index + 1);
  });
  return found;
}

// ---------- sizes and composition (§4.5, §5.2) ----------

function sizeOf(text) {
  const utf8Bytes = Buffer.byteLength(text, 'utf8');
  return { chars: text.length, utf8Bytes, tokens: Math.ceil(utf8Bytes / 4) };
}

// A backtick fence one longer than the longest run inside, at least 3.
function fenceFor(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

// The last user item of an attachment turn. No path, file name, language or
// label is included (§5.2, §8); the snapshot is not escaped or altered.
function composeTurn(typed, snapshotText) {
  const fence = fenceFor(snapshotText);
  return `${typed}\n\n[Code selection attached by the user for this message]\n${fence}\n${snapshotText}\n${fence}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------- capture (§4.1–§4.4) ----------

class AttachmentRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttachmentRefusal';
    this.code = code;
  }
}

const refuse = (code, message) => { throw new AttachmentRefusal(code, message); };
const formatCount = (value) => value.toLocaleString('en-US');

const SCHEME_NAMES = {
  'vscode-remote': 'a remote file',
  'vscode-vfs': 'a virtual file',
  'vscode-notebook-cell': 'a notebook cell',
  git: 'a Git version of a file',
  output: 'an output panel',
  'vscode-userdata': 'an editor settings file'
};

function lineRange(selection) {
  const startLine = selection.start.line + 1;
  // A selection that ends at the start of a line does not include that line.
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1;
  return { startLine, endLine };
}

// Captures the primary selection of `editor` for a window in `context` (from
// src/project.js). Returns a deep-frozen snapshot, or throws
// AttachmentRefusal with a reason that never contains the selected text.
//
// options: { maxChars, folderPath (the project folder's local path), trusted,
//            realpath (for tests), platform, now }
async function captureSelection(editor, context, options) {
  const { maxChars, folderPath, trusted = true, realpath = realpathNative, platform = process.platform, now = Date.now() } = options;
  if (!editor?.document || !editor.selection) {
    refuse('no-editor', 'Open a file and select the code to attach. Kenlith attaches only code you select.');
  }
  if (!trusted) {
    refuse('untrusted', 'This workspace is not trusted, so code from it cannot be attached.');
  }
  const { document, selection } = editor;
  const selections = editor.selections?.length ? editor.selections : [selection];
  if (selection.isEmpty) {
    refuse('empty', 'Nothing is selected. Select the code to attach; Kenlith never attaches a whole file.');
  }

  const scheme = document.uri.scheme;
  const untitled = scheme === 'untitled';
  let displayPath;
  let folderKey;
  let envExample = false;
  if (scheme === 'file') {
    if (context?.kind !== 'project') {
      refuse('general-file', 'In General, only code from an untitled editor can be attached. Open the file\'s folder in this window to attach code from it.');
    }
    const opened = document.uri.fsPath;
    let resolved;
    let folderResolved;
    try {
      resolved = await realpath(opened);
      folderResolved = await realpath(folderPath);
    } catch {
      refuse('unresolved', 'This file could not be found on disk, so it cannot be checked. Save it inside the project folder, or copy the code into an untitled editor.');
    }
    const linked = fold(resolved, platform) !== fold(opened, platform);
    if (!isInside(resolved, folderResolved, platform)) {
      refuse('outside', `This file is outside the project folder ${context.label}${linked ? ' (through a link)' : ''}, so it cannot be attached in this window.`);
    }
    for (const candidate of linked ? [opened, resolved] : [opened]) {
      const result = classifyPath(candidate);
      if (result.blocked) {
        refuse('blocked', `${path.basename(candidate)} is ${result.blocked}${candidate === resolved ? ' (through a link)' : ''}. Code from these files is never attached.`);
      }
      envExample ||= Boolean(result.envExample);
    }
    displayPath = path.relative(folderResolved, resolved).split(path.sep).join('/');
    folderKey = context.key;
  } else if (untitled) {
    displayPath = path.basename(document.uri.path || document.fileName || 'Untitled');
  } else {
    refuse('scheme', `This editor shows ${SCHEME_NAMES[scheme] || `a "${scheme}" document`}. Only files on this computer and untitled editors can be attached.`);
  }

  // Size from offsets, before any text is read.
  const size = document.offsetAt(selection.end) - document.offsetAt(selection.start);
  if (size > maxChars) {
    refuse('too-large', `The selection is ${formatCount(size)} characters; the limit is ${formatCount(maxChars)}. Select less code. Nothing was read or attached.`);
  }

  const text = document.getText(selection);
  if (!text.trim()) {
    refuse('empty', 'The selection contains only spaces or line breaks. Select the code to attach.');
  }
  const { chars, utf8Bytes, tokens } = sizeOf(text);
  const lines = lineRange(selection);
  return deepFreeze({
    id: crypto.randomUUID(),
    text,
    sha256: sha256(text),
    chars,
    utf8Bytes,
    tokens,
    source: {
      uri: document.uri.toString(),
      scheme,
      displayPath,
      folderKey,
      languageId: document.languageId || 'plaintext',
      startLine: lines.startLine,
      endLine: lines.endLine,
      untitled,
      unsaved: Boolean(document.isDirty) && !untitled,
      documentVersion: document.version
    },
    flags: {
      credentialPattern: credentialLines(text),
      multipleSelections: selections.length > 1 ? selections.length : 0,
      envExample
    },
    capturedAt: new Date(now).toISOString()
  });
}

// What a user message stores about its attachment (§6): no text, no hash.
function attachmentMetadata(snapshot, { credentialPatternConfirmed = false, sentAt = new Date().toISOString() } = {}) {
  return {
    id: snapshot.id,
    kind: 'selection',
    displayPath: snapshot.source.displayPath,
    languageId: snapshot.source.languageId,
    startLine: snapshot.source.startLine,
    endLine: snapshot.source.endLine,
    chars: snapshot.chars,
    utf8Bytes: snapshot.utf8Bytes,
    flags: { unsaved: snapshot.source.unsaved, untitled: snapshot.source.untitled, credentialPatternConfirmed },
    outcome: 'sent',
    sentAt
  };
}

module.exports = {
  AttachmentRefusal,
  attachmentMetadata,
  captureSelection,
  classifyPath,
  composeTurn,
  credentialLines,
  fenceFor,
  isInside,
  sha256,
  sizeOf
};
