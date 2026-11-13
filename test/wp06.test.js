'use strict';

const { HISTORICAL_SKIP } = require('./helpers/historical');

// WP-06 (release candidate): the package itself. Builds the VSIX with
// scripts/package-vsix.js into temporary folders (never dist/ or releases/)
// and inspects the actual file, not only the packaging rules.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { makeOwnedTempDir } = require('./helpers/owned-temp');
const { readZipEntry } = require('./helpers/read-zip-entry');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

// Central-directory names of a zip file.
function zipNames(file) {
  const data = fs.readFileSync(file);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = data.readUInt16LE(offset + 28);
    const extra = data.readUInt16LE(offset + 30);
    const comment = data.readUInt16LE(offset + 32);
    names.push(data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extra + comment;
  }
  return names;
}

function build(epoch = '1761696000', label = 'test') {
  const out = makeOwnedTempDir('plan-chat-vsix-');
  const file = execFileSync(process.execPath, [path.join(root, 'scripts', 'package-vsix.js'), '--out', out, '--label', label], { env: { ...process.env, SOURCE_DATE_EPOCH: epoch }, encoding: 'utf8' }).trim();
  return file;
}

const EXPECTED = [
  'extension/CHANGELOG.md', 'extension/LICENSE', 'extension/package.json', 'extension/README.md', 'extension/SECURITY.md',
  'extension/media/chat.svg', 'extension/media/chat-tab.svg', 'extension/media/icon.png',
  ...fs.readdirSync(path.join(root, 'src')).filter((name) => name.endsWith('.js')).sort().map((name) => `extension/src/${name}`),
  '[Content_Types].xml', 'extension.vsixmanifest'
];

test('T06-02 the default instructions name no particular editor and keep their meaning', () => {
  const setting = Object.values(pkg.contributes.configuration.properties || {}).find((entry) => typeof entry.default === 'string' && /helpful assistant/.test(entry.default))
    || pkg.contributes.configuration.find?.((section) => section.properties)?.properties;
  const text = JSON.stringify(pkg.contributes.configuration);
  assert.doesNotMatch(text, /inside Antigravity IDE/);
  assert.match(text, /You are a helpful assistant inside the user's code editor\. Be concise, accurate, and use the supplied conversation context\./);
  assert.ok(setting);
});

test('T06-02/T06-04 the built VSIX: only runtime files, manifest identical to package.json, version and identity unchanged, icon present', () => {
  const file = build();
  assert.deepEqual(zipNames(file), EXPECTED, 'exactly the runtime files, in order');
  for (const name of zipNames(file)) {
    assert.doesNotMatch(name, /test|backup|\.jsonl$|conversations|credential|token|secret|\.key$|\.bak$|\.tmp$|\.log$|transcript|docs\/|design\/|node_modules|\.git/i, name);
  }
  const manifest = String(readZipEntry(file, 'extension.vsixmanifest'));
  const packaged = JSON.parse(String(readZipEntry(file, 'extension/package.json')));
  assert.deepEqual(packaged, pkg, 'package.json is packaged unchanged');
  assert.match(manifest, new RegExp(`<Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version.replace(/\./g, '\\.')}" Publisher="${pkg.publisher}" />`));
  assert.match(manifest, new RegExp(`<DisplayName>${pkg.displayName.replace(/[()]/g, '\\$&')}</DisplayName>`));
  assert.ok(manifest.includes(`<Description xml:space="preserve">${pkg.description.replace(/'/g, '\'')}</Description>`), 'description equals package.json (R-24)');
  assert.ok(manifest.includes(`<Tags>${pkg.keywords.join(',')}</Tags>`));
  assert.ok(manifest.includes(`Value="${pkg.engines.vscode}"`));
  assert.equal(`${packaged.publisher}.${packaged.name}`, 'local-open-source.plan-chat-antigravity');
  assert.ok(!('test-main.js' in {}) && !zipNames(file).some((name) => /test-main|test-scenario/.test(name)), 'no test entry');
  assert.equal(packaged.main, './src/extension.js');
  const icon = readZipEntry(file, 'extension/media/icon.png', { raw: true });
  assert.equal(crypto.createHash('sha256').update(icon).digest('hex'), crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'media', 'icon.png'))).digest('hex'), 'the approved icon');
});

// ---------------------------------------------------------------------------
// T06-05/T06-06 sign-in storage identity across upgrade and rollback: the
// authentic 0.1.2 AuthService (from its release VSIX) and the candidate's
// (built from this source) on one simulated SecretStorage and global state.
// Synthetic tokens from the scripted fake server; no network.

const { calls, createContext } = require('./helpers/fake-vscode');
const { CLIENT_ID, FakeOpenAI, idToken, json, tokenResponse } = require('./helpers/fake-openai');

function loadAuthFrom(vsix) {
  const dir = makeOwnedTempDir('plan-chat-auth-');
  for (const name of ['auth.js', 'fsutil.js', 'lock.js', 'util.js']) {
    fs.writeFileSync(path.join(dir, name), readZipEntry(vsix, `extension/src/${name}`));
  }
  return require(path.join(dir, 'auth.js'));
}

test('T06-05/T06-06 a 0.1.2 sign-in is used by 0.2.0 after upgrade, and a 0.2.0 renewal and sign-out are honoured by 0.1.2 after rollback', { skip: HISTORICAL_SKIP }, async () => {
  const server = new FakeOpenAI().install();
  try {
    const old = loadAuthFrom(path.join(root, 'releases', 'plan-chat-antigravity-0.1.2.vsix'));
    const now = loadAuthFrom(build('1761696000', 'auth'));
    assert.equal(old.CREDENTIALS_KEY, now.CREDENTIALS_KEY, 'same SecretStorage key');
    const context = createContext();
    // 0.1.2 signs in (browser step answered by the fake server).
    calls.onOpenExternal = (value) => {
      const url = new URL(value);
      server.lastNonce = url.searchParams.get('nonce');
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', url.searchParams.get('state'));
      redirect.searchParams.set('code', 'synthetic-code');
      redirect.searchParams.set('client_id', CLIENT_ID);
      setImmediate(() => fetch(redirect).catch(() => undefined));
      return true;
    };
    server.tokenHandler = (request) => request.form.grant_type === 'refresh_token'
      ? json(200, tokenResponse({ access_token: 'synthetic-access-2', refresh_token: 'synthetic-refresh-2' }))
      : json(200, tokenResponse({ id_token: idToken({ nonce: server.lastNonce }) }));
    await new old.AuthService(context).signIn();

    // Upgrade: 0.2.0 reads the same session and token, without signing in again.
    const upgraded = new now.AuthService(context);
    assert.equal((await upgraded.getSession()).email, 'synthetic@example.test');
    assert.equal(await upgraded.getAccessToken(), 'synthetic-access-1');

    // 0.2.0 renews the token; after rollback 0.1.2 uses the renewed one.
    const stored = JSON.parse(context.secretValues.get(now.CREDENTIALS_KEY));
    context.secretValues.set(now.CREDENTIALS_KEY, JSON.stringify({ ...stored, expiresAt: Date.now() + 5_000 }));
    assert.equal(await upgraded.getAccessToken(), 'synthetic-access-2');
    assert.equal(await new old.AuthService(context).getAccessToken(), 'synthetic-access-2');

    // Sign-out in 0.2.0 is honoured by 0.1.2.
    await upgraded.signOut();
    assert.equal(await new old.AuthService(context).getSession(), undefined);
  } finally {
    server.uninstall();
    calls.onOpenExternal = undefined;
  }
});

test('T06-04 the same source and SOURCE_DATE_EPOCH give a byte-identical VSIX; the script refuses to overwrite', () => {
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const first = build('1761696000', 'repro');
  const second = build('1761696000', 'repro');
  assert.notEqual(first, second, 'two folders');
  assert.equal(hash(first), hash(second));
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'package-vsix.js'), '--out', path.dirname(first), '--label', 'repro'], { env: { ...process.env, SOURCE_DATE_EPOCH: '1761696000' }, stdio: 'pipe' }), /Refusing to overwrite|Command failed/);
});
