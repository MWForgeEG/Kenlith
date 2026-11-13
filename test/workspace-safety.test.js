'use strict';

// M1-1A security boundary on the real Windows file system (SG-M1-1).
// Every fixture is created under the system temp folder and removed after.
// A file named OUTSIDE.txt holding the marker OUTSIDE_SECRET lives outside
// each project root; no check may ever return that marker.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkRelative, classifySensitive, readContained, resolveRoot, statContained } = require('../src/workspace-safety');

const MARKER = 'OUTSIDE_SECRET';
const created = [];
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ws-'));
  created.push(base);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'OUTSIDE.txt'), `${MARKER}\n`);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const app = 1;\n');
  return { base, root: fs.realpathSync.native(root), outside: fs.realpathSync.native(outside) };
}
test.after(() => {
  for (const base of created) {
    const sentinel = path.join(base, 'outside', 'OUTSIDE.txt');
    // Removing a junction must not remove its target.
    fs.rmSync(path.join(base, 'project'), { recursive: true, force: true });
    assert.ok(!fs.existsSync(sentinel) || fs.readFileSync(sentinel, 'utf8').includes(MARKER));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const neverOutside = (result) => assert.ok(!(result.text || '').includes(MARKER), 'outside content was returned');

test('SG1 relative paths: traversal, absolute, UNC, device, streams, reserved names and bad characters are refused', () => {
  const refused = [
    '../OUTSIDE.txt', 'a/../../OUTSIDE.txt', '..', '.', './app.js', 'C:/Windows/win.ini', 'c:app.js', '/etc/passwd', '\\Windows',
    '\\\\server\\share\\x', '\\\\?\\C:\\x', '\\\\.\\C:\\x', '//server/share', 'app.js:hidden', 'app.js::$DATA', 'dir:stream/x',
    'CON', 'con.txt', 'NUL.js', 'com1', 'COM9.log', 'LPT1.md', 'aux ', 'prn.', 'conin$', 'name.', 'name ', 'a\u0000b', 'tab\tname',
    'a*b', 'what?', 'a<b', 'a|b', 'a"b', ''
  ];
  for (const candidate of refused) {
    const result = checkRelative(candidate);
    assert.equal(result.ok, false, `accepted: ${JSON.stringify(candidate)}`);
    assert.equal(result.reason, 'invalid-path');
  }
  assert.deepEqual(checkRelative('src\\lib/app.js'), { ok: true, segments: ['src', 'lib', 'app.js'], relPath: 'src/lib/app.js' });
  assert.equal(checkRelative('a b/c.d.ts').ok, true);
  assert.equal(checkRelative('console.js').ok, true, 'a name that merely starts with con');
  assert.equal(checkRelative('مشروع/ملف.js').ok, true);
});

test('SG2 roots: relative, UNC and namespace roots are refused; a missing root is unavailable; the stored spelling is used', async () => {
  assert.equal((await resolveRoot('project')).reason, 'root-unsupported');
  assert.equal((await resolveRoot('\\\\server\\share\\project')).reason, 'root-unsupported');
  assert.equal((await resolveRoot('\\\\?\\C:\\Windows')).reason, 'root-unsupported');
  assert.equal((await resolveRoot('\\\\.\\C:\\Windows')).reason, 'root-unsupported');
  const { base, root } = sandbox();
  assert.equal((await resolveRoot(path.join(base, 'missing'))).reason, 'root-unavailable');
  assert.equal((await resolveRoot(path.join(root, 'app.js'))).reason, 'root-unavailable', 'a file is not a root');
  const resolved = await resolveRoot(root.toUpperCase());
  assert.equal(resolved.ok, true);
  assert.equal(resolved.root, root, 'the stored spelling, not the typed one');
});

test('SG3 alternate data streams: a real stream is never read, by name or through the main file', async () => {
  const { root } = sandbox();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'main text\n');
  fs.writeFileSync(path.join(root, 'notes.txt:hidden'), `${MARKER}\n`);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt:hidden'), 'utf8').trim(), MARKER, 'the stream exists on this volume');
  const byName = await readContained(root, 'notes.txt:hidden');
  assert.deepEqual([byName.ok, byName.reason], [false, 'invalid-path']);
  const main = await readContained(root, 'notes.txt');
  assert.equal(main.ok, true);
  assert.equal(main.text, 'main text\n');
  neverOutside(main);
});

test('SG4 a junction inside the project pointing outside is refused at the link and through it', async (t) => {
  const { root, outside } = sandbox();
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  assert.equal(fs.readFileSync(path.join(root, 'linked', 'OUTSIDE.txt'), 'utf8').trim(), MARKER, 'the junction works on this volume');
  const through = await readContained(root, 'linked/OUTSIDE.txt');
  assert.equal(through.ok, false);
  assert.equal(through.reason, 'outside-root');
  neverOutside(through);
  const link = await readContained(root, 'linked');
  assert.deepEqual([link.ok, link.reason], [false, 'link']);
  t.diagnostic(`junction through-read reason: ${through.reason}; link reason: ${link.reason}`);
});

test('SG5 a junction pointing to another folder inside the project is refused as an alias', async () => {
  const { root } = sandbox();
  fs.mkdirSync(path.join(root, 'real'));
  fs.writeFileSync(path.join(root, 'real', 'x.js'), 'x\n');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'junction');
  const result = await readContained(root, 'alias/x.js');
  assert.deepEqual([result.ok, result.reason], [false, 'alias']);
  assert.equal((await readContained(root, 'real/x.js')).ok, true);
});

for (const kind of ['file', 'dir']) {
  test(`SG6 ${kind} symbolic link pointing outside`, async (t) => {
    const { root, outside } = sandbox();
    const target = kind === 'file' ? path.join(outside, 'OUTSIDE.txt') : outside;
    const link = path.join(root, kind === 'file' ? 'leak.txt' : 'leakdir');
    try {
      fs.symlinkSync(target, link, kind);
    } catch (error) {
      // Creating symbolic links needs Developer Mode or an elevated process.
      // Unit runs stay non-elevated. The same refusal is proven with genuine
      // links by SG6-F1/F2 (test/sg-m1-1-symlinks.test.js, fixtures made once,
      // elevated; final gate 2026-11-09) and with a junction in SG4.
      t.skip(`NOT RUN: creating a ${kind} symbolic link failed with ${error.code} (needs Developer Mode or elevation); covered by SG6-F${kind === 'file' ? 1 : 2} with a genuine link and by the junction in SG4`);
      return;
    }
    const direct = await readContained(root, kind === 'file' ? 'leak.txt' : 'leakdir/OUTSIDE.txt');
    assert.equal(direct.ok, false);
    neverOutside(direct);
  });
}

test('SG7 a hard link inside the project to a file outside is refused (link count), and Node reports NTFS link counts', async (t) => {
  const { root, outside } = sandbox();
  fs.linkSync(path.join(outside, 'OUTSIDE.txt'), path.join(root, 'hard.txt'));
  const stat = fs.statSync(path.join(root, 'hard.txt'));
  const real = fs.realpathSync.native(path.join(root, 'hard.txt'));
  t.diagnostic(`hard link: nlink=${stat.nlink}; realpath stays inside the project: ${real.startsWith(root)}`);
  assert.equal(stat.nlink, 2, 'Node reports the NTFS link count');
  assert.ok(real.startsWith(root), 'containment alone would not catch this (the reason for the link-count rule)');
  const result = await readContained(root, 'hard.txt');
  assert.deepEqual([result.ok, result.reason], [false, 'hard-link']);
  neverOutside(result);
  assert.equal((await statContained(root, 'hard.txt')).reason, 'hard-link');
  // A hard link between two files inside the project is refused too (fail closed).
  fs.writeFileSync(path.join(root, 'one.txt'), 'one\n');
  fs.linkSync(path.join(root, 'one.txt'), path.join(root, 'two.txt'));
  assert.equal((await readContained(root, 'one.txt')).reason, 'hard-link');
});

test('SG8 case and Unicode aliases: another spelling of a stored name is refused; distinct NFC and NFD names stay distinct', async () => {
  const { root } = sandbox();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'Store.js'), 'store\n');
  assert.equal((await readContained(root, 'src/Store.js')).ok, true);
  const upper = await readContained(root, 'SRC/STORE.JS');
  assert.deepEqual([upper.ok, upper.reason], [false, 'alias'], 'NTFS opens it, but the spelling is not the stored one');
  const nfc = 'caf\u00e9.txt';
  const nfd = 'cafe\u0301.txt';
  fs.writeFileSync(path.join(root, nfc), 'composed\n');
  fs.writeFileSync(path.join(root, nfd), 'decomposed\n');
  assert.equal((await readContained(root, nfc)).text, 'composed\n');
  assert.equal((await readContained(root, nfd)).text, 'decomposed\n');
});

test('SG9 8.3 short names are refused as aliases', async (t) => {
  const { root } = sandbox();
  const long = 'Long Folder Name For Alias';
  fs.mkdirSync(path.join(root, long));
  fs.writeFileSync(path.join(root, long, 'inner.js'), 'inner\n');
  let short;
  try {
    const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/ad', root], { encoding: 'utf8', windowsHide: true });
    const line = listing.split(/\r?\n/).find((entry) => entry.endsWith(long));
    short = line && line.slice(0, -long.length).trim().split(/\s+/).pop();
    if (short === '<DIR>' || !short) short = undefined;
  } catch {
    short = undefined;
  }
  if (!short) {
    t.skip('NOT RUN: this volume does not generate 8.3 short names (dir /x shows none); the alias rule is proven with case aliases in SG8');
    return;
  }
  t.diagnostic(`short name: ${short}`);
  const result = await readContained(root, `${short}/inner.js`);
  assert.deepEqual([result.ok, result.reason], [false, 'alias']);
});

test('SG10 time-of-check/time-of-use: a file swapped for an outside hard link or a junction before opening is refused', async (t) => {
  const { root, outside } = sandbox();
  const file = path.join(root, 'victim.txt');
  fs.writeFileSync(file, 'harmless\n');
  const hardSwap = await readContained(root, 'victim.txt', {
    hooks: { beforeOpen: (candidate) => { fs.unlinkSync(candidate); fs.linkSync(path.join(outside, 'OUTSIDE.txt'), candidate); } }
  });
  assert.equal(hardSwap.ok, false);
  neverOutside(hardSwap);
  t.diagnostic(`hard-link swap reason: ${hardSwap.reason}`);

  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, 'harmless\n');
  const junctionSwap = await readContained(root, 'victim.txt', {
    hooks: { beforeOpen: (candidate) => { fs.unlinkSync(candidate); fs.symlinkSync(outside, candidate, 'junction'); } }
  });
  assert.equal(junctionSwap.ok, false);
  neverOutside(junctionSwap);
  t.diagnostic(`junction swap reason: ${junctionSwap.reason}`);
  fs.rmSync(file, { force: true });

  // Swapped after opening: the handle and the path no longer agree.
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
  const afterOpen = await readContained(root, 'b.txt', {
    hooks: { afterOpen: (candidate) => { fs.renameSync(candidate, path.join(root, 'b-moved.txt')); fs.copyFileSync(path.join(root, 'c.txt'), candidate); } }
  });
  assert.deepEqual([afterOpen.ok, afterOpen.reason], [false, 'changed']);
});

test('SG11 size and type: oversized, binary content, binary extensions, folders and missing files are refused', async () => {
  const { root } = sandbox();
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(600 * 1024));
  fs.writeFileSync(path.join(root, 'blob.txt'), Buffer.from([0x41, 0x00, 0x42]));
  fs.writeFileSync(path.join(root, 'image.png'), 'not really an image');
  fs.mkdirSync(path.join(root, 'folder'));
  assert.equal((await readContained(root, 'big.txt')).reason, 'too-large');
  assert.equal((await readContained(root, 'big.txt', { maxBytes: 700 * 1024 })).ok, true);
  assert.equal((await readContained(root, 'blob.txt')).reason, 'binary');
  assert.equal((await readContained(root, 'image.png')).reason, 'binary');
  assert.equal((await readContained(root, 'folder')).reason, 'not-file');
  assert.equal((await readContained(root, 'nothing.js')).reason, 'missing');
});

const SENSITIVE = [
  '.env', '.env.local', '.ENV', 'config/.env.production', '.npmrc', 'sub/.npmrc', '.netrc', '_netrc', '.pypirc', '.git-credentials', '.htpasswd',
  '.git/config', '.git/HEAD', 'pkg/.git/objects/ab', '.ssh/id_rsa', '.ssh/config', '.aws/credentials', '.azure/config', '.gnupg/pubring.kbx',
  '.kube/config', 'kubeconfig', '.docker/config.json', 'id_rsa', 'id_ed25519', 'id_custom', 'deploy.pem', 'Deploy.PEM', 'server.key',
  'cert.pfx', 'cert.p12', 'store.jks', 'app.keystore', 'putty.ppk', 'auth.p8', 'vault.kdbx', 'terraform.tfstate', 'terraform.tfstate.backup',
  'infra/prod.tfstate.1700000000.backup', 'credentials', 'credentials.json'
];

test('SG12 sensitive names are withheld without reading, whatever the case', async () => {
  const { root } = sandbox();
  for (const relPath of SENSITIVE) {
    assert.equal(classifySensitive(relPath).withheld, 'sensitive', relPath);
    const full = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${MARKER}\n`);
    const result = await readContained(root, relPath);
    assert.deepEqual([result.ok, result.reason], [false, 'sensitive'], relPath);
    neverOutside(result);
  }
  assert.deepEqual(classifySensitive('.env.example'), {}, 'an example env file is allowed');
  assert.deepEqual(classifySensitive('src/keys.js'), {});
  assert.deepEqual(classifySensitive('docs/identity.md'), {});
});

test('SG13 credential-like content withholds the whole file', async () => {
  const { root } = sandbox();
  const cases = {
    'aws.js': 'const key = "AK' + 'IAABCDEFGHIJKLMNOP";\n',
    'key.txt': '-----BEGIN RSA PRI' + 'VATE KEY-----\nabc\n',
    'conf.ini': 'password=hunter2\n',
    'jwt.js': 'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc";\n'
  };
  for (const [name, text] of Object.entries(cases)) {
    fs.writeFileSync(path.join(root, name), text);
    const result = await readContained(root, name);
    assert.deepEqual([result.ok, result.reason], [false, 'credential-content'], name);
    assert.equal(result.text, undefined);
  }
  // The rule over-blocks on purpose: an assignment to "password" is withheld
  // even when its value is code, not a secret.
  fs.writeFileSync(path.join(root, 'vault.js'), 'const password = getFromVault();\n');
  assert.equal((await readContained(root, 'vault.js')).reason, 'credential-content');
  fs.writeFileSync(path.join(root, 'clean.js'), 'const user = getUser();\n');
  assert.equal((await readContained(root, 'clean.js')).ok, true);
});

test('SG14 a successful read returns the file text, its hash and identity, and reads nothing else', async () => {
  const { root } = sandbox();
  const text = 'line 1\r\nline 2\n\u0627\u0644\u0639\u0631\u0628\u064a\u0629\n';
  fs.writeFileSync(path.join(root, 'ok.js'), `\ufeff${text}`);
  const result = await readContained(root, 'ok.js');
  assert.equal(result.ok, true);
  assert.equal(result.text, text, 'BOM removed, line endings kept');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof result.ino, 'bigint');
  const stat = await statContained(root, 'ok.js');
  assert.equal(stat.ok, true);
  assert.equal(stat.ino, result.ino);
});

test('SG15 neither module loads a network module', () => {
  for (const file of ['workspace-safety.js', 'retrieval.js', 'glob.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    assert.doesNotMatch(source, /require\(['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici)['"]\)/, file);
    assert.doesNotMatch(source, /\bfetch\(|require\(['"]vscode['"]\)/, file);
  }
});
