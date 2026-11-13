'use strict';

// Kenlith 0.4.1: the rename from Plan Chat (docs/kenlith-rebrand.md,
// DEC-PLANCHAT-020). What users see says Kenlith; every identifier that stored
// data, sign-in, keybindings or the upgrade path depend on is unchanged. The
// settings move to kenlith.* (test/settings-migration.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
// SHA-256 of media/chat-tab.svg, the approved coloured editor-tab icon (Kenlith 0.7.0).
const CHAT_TAB_SHA256 = 'a05feadb0bed3759a541b7470e89994fb90f38b1aa600c88cc71e55e575b657d';
const SHIPPED = ['package.json', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE',
  ...fs.readdirSync(path.join(root, 'src')).filter((name) => name.endsWith('.js')).map((name) => `src/${name}`)];

test('Kenlith 1. the product name: display name, version, Activity Bar, views, settings section', () => {
  assert.equal(pkg.displayName, 'Kenlith');
  assert.equal(pkg.version, '0.8.0'); // Kenlith 0.8.0 (the name and identity of 0.4.1 are kept)
  assert.ok(pkg.keywords.includes('kenlith'));
  assert.doesNotMatch(pkg.description, /Plan Chat|ScopeArc/);
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].title, 'Kenlith');
  for (const view of pkg.contributes.views.planChat) assert.equal(view.contextualTitle, 'Kenlith', view.id);
  assert.equal(pkg.contributes.configuration.title, 'Kenlith');
  assert.equal(pkg.icon, 'media/icon.png');
});

test('Kenlith 2. command palette: every category is Kenlith; titles that name the product say Kenlith', () => {
  for (const command of pkg.contributes.commands) {
    if (command.category !== undefined) assert.equal(command.category, 'Kenlith', command.command);
    assert.doesNotMatch(command.title, /Plan Chat|ScopeArc/, command.command);
  }
  const title = (id) => pkg.contributes.commands.find((command) => command.command === id).title;
  assert.equal(title('planChat.open'), 'Open Kenlith');
  assert.equal(title('planChat.attachSelection'), 'Attach Selection to Kenlith');
});

test('Kenlith 3. legacy identifiers are unchanged: extension ID, command and view IDs, view type', () => {
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'local-open-source.plan-chat-antigravity');
  assert.ok(pkg.contributes.commands.every((command) => command.command.startsWith('planChat.')));
  assert.equal(pkg.contributes.commands.length, 26);
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].id, 'planChat');
  assert.deepEqual(pkg.contributes.views.planChat.map((view) => view.id), ['planChat.account', 'planChat.sidebar']);
  assert.ok(pkg.activationEvents.includes('onWebviewPanel:planChat.conversation'));
  assert.match(read('src/panels.js'), /const VIEW_TYPE = 'planChat\.conversation';/);
  const manifest = read('build/extension.vsixmanifest');
  assert.match(manifest, /<Identity [^>]*Id="plan-chat-antigravity"[^>]*Publisher="local-open-source"/);
});

test('Kenlith 4. settings: kenlith.* is canonical; planChat.* is still read as the fallback', () => {
  assert.match(read('src/settings.js'), /const SECTION = 'kenlith';/);
  assert.match(read('src/settings.js'), /const LEGACY_SECTION = 'planChat';/);
  assert.match(read('src/extension.js'), /await migrateLegacySettings\(context\.globalState\)/);
  assert.match(read('src/budget.js'), /Shorten kenlith\.instructions in your user settings\./);
  assert.doesNotMatch(read('src/budget.js'), /planChat\./);
});

test('Kenlith 5. stored data keys are unchanged: sign-in secrets, model, open tabs, project choice, welcome, usage pause', () => {
  const keys = {
    'src/auth.js': ["'planChat.credentials.v1'", "'planChat.hostId.v1'", "'planChat.registration.v1'"],
    'src/engine.js': ["'planChat.selectedModel.v1'"],
    'src/panels.js': ["'planChat.openChats.v1'"],
    'src/project.js': ["'planChat.projectChoice.v1'"],
    'src/siwc.js': ["'planChat.siwcWelcome.v1'", "'planChat.usagePause.v1'"]
  };
  for (const [file, list] of Object.entries(keys)) for (const key of list) assert.ok(read(file).includes(key), `${file} keeps ${key}`);
});

test('Kenlith 6. sign-in: the app name sent to the sign-in page and the browser page title are Kenlith', () => {
  const auth = read('src/auth.js');
  assert.match(auth, /searchParams\.set\('agent_name_hint', 'Kenlith'\)/);
  assert.match(auth, /<title>Kenlith<\/title>/);
  assert.doesNotMatch(auth, /Plan Chat|ScopeArc/);
});

test('Kenlith 7. no current user-facing Plan Chat text in any shipped file; the rest is migration text', () => {
  for (const file of SHIPPED) {
    const text = read(file);
    const lines = (text.match(/[^\n]*Plan Chat[^\n]*/g) || []).map((line) => line.trim());
    if (file === 'README.md') {
      // One migration note, by design.
      assert.deepEqual(lines, ['Kenlith was named Plan Chat up to version 0.4.0. Version 0.4.1 changes the'], file);
      continue;
    }
    if (file === 'CHANGELOG.md') {
      // The 0.4.1 entry names the rename; older entries keep the name of their time.
      const current = text.slice(0, text.indexOf('\n## 0.4.0'));
      assert.deepEqual(current.match(/[^\n]*Plan Chat[^\n]*/g).map((line) => line.trim()), [
        '**Summary.** Plan Chat is now named Kenlith. Chats, groups, drafts, the model',
        'choice, project sharing and sign-in carry over from Plan Chat 0.4.0, and Plan',
        'kept, marked as replaced, so that Plan Chat 0.4.0 still finds them after a',
        'packages keep their Plan Chat names.'
      ]);
      continue;
    }
    if (file === 'package.json') {
      // Only the four deprecated planChat.* settings name Plan Chat (3 strings each).
      const legacy = Object.entries(JSON.parse(text).contributes.configuration.properties).filter(([name]) => name.startsWith('planChat.'));
      const allowed = legacy.flatMap(([, def]) => [def.description, def.deprecationMessage, def.markdownDeprecationMessage]);
      assert.equal(lines.length, allowed.length, file);
      for (const line of lines) assert.ok(allowed.some((value) => line.includes(JSON.stringify(value).slice(1, -1))), `${file}: ${line}`);
      continue;
    }
    if (['src/settings.js', 'src/extension.js', 'src/engine.js'].includes(file)) {
      // Comments that explain the settings migration.
      for (const line of lines) assert.match(line, /^\/\//, `${file}: ${line}`);
      continue;
    }
    assert.deepEqual(lines, [], file);
    assert.doesNotMatch(text, /PlanChat(?!Markdown)/, file);
  }
});

test('Kenlith 8. the name is spelled Kenlith; ScopeArc appears nowhere in a shipped file', () => {
  const forbidden = /KenLith|Ken Lith|Kenlyth|KENLITH|\bkenLith\b|Kenlith (Chat|GPT|AI)\b|(GPT|ChatGPT) Kenlith/;
  for (const file of SHIPPED) {
    assert.doesNotMatch(read(file), forbidden, file);
    assert.doesNotMatch(read(file), /scope ?arc/i, file);
  }
  // Lowercase only where a technical form is needed.
  assert.ok(pkg.keywords.includes('kenlith'));
});

test('Kenlith 9. the chat page: title, account note, reply status and consent text', () => {
  const view = read('src/view.js');
  assert.match(view, /<title>Kenlith<\/title>/);
  assert.match(view, /Kenlith is an unofficial client\. Chats are saved on this computer only\./);
  assert.match(view, /Kenlith is replying… Press Escape or Stop to stop it\./);
  assert.match(view, /'To answer, Kenlith would send '/);
  // The notes added to requests name Kenlith; the matched prefix is unchanged.
  assert.match(read('src/request-builder.js'), /'\[Project context: excerpts from files in the user\\'s open project, chosen by Kenlith/);
  assert.match(require('../src/store').STOPPED_NOTE, /^\n\n\[Note from Kenlith: /);
});

test('Kenlith 10. packaging: a Kenlith file name around the unchanged extension identity', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-pack-'));
  try {
    const file = execFileSync(process.execPath, [path.join(root, 'scripts', 'package-vsix.js'), '--out', out, '--label', 'test', '--artifact', 'kenlith-antigravity'], { encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600' } }).trim();
    assert.equal(path.basename(file), 'kenlith-antigravity-0.8.0-test.vsix');
    // Read the manifest entry from its local file header (method 8 = deflate).
    const zip = fs.readFileSync(file);
    const at = zip.indexOf(Buffer.from('extension.vsixmanifest')) - 30;
    assert.equal(zip.readUInt32LE(at), 0x04034b50, 'local file header of extension.vsixmanifest');
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
    const body = zip.subarray(start, start + size);
    const manifest = (method === 8 ? require('node:zlib').inflateRawSync(body) : body).toString('utf8');
    assert.match(manifest, /<Identity [^>]*Id="plan-chat-antigravity"[^>]*Version="0\.8\.0"[^>]*Publisher="local-open-source"/);
    assert.match(manifest, /<DisplayName>Kenlith<\/DisplayName>/);
    assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'package-vsix.js'), '--out', out, '--artifact', 'Bad Name'], { stdio: 'pipe' }));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('Kenlith 11. the icons are the approved Signal Rings files of Plan Chat 0.4.0, unchanged', () => {
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  // Hashes of media/ at the Plan Chat 0.4.0 baseline (commit 1be0dad).
  assert.equal(sha('media/icon.png'), '93f05ff15570dcd333d9215523d28c61418eed53c0abc469e4ed5bc89a685e19');
  assert.equal(sha('media/chat.svg'), '5b07b6cd6262f7e9b2d6862866f659c0866c37c61fe104a39e9776dcb5177394');
});

test('Kenlith 0.7.0 editor tab icon (DEC-PLANCHAT-033, 034): the approved Signal Rings in brand greens for every theme, colours written in, never currentColor', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const svg = read('media/chat-tab.svg');
  assert.doesNotMatch(svg, /currentColor/);
  // The approved Signal Rings vector with its ring colour written in (Signal Mint,
  // a light brand green), never white, off-white or black: pinned byte for byte.
  assert.equal(crypto.createHash('sha256').update(svg).digest('hex'), CHAT_TAB_SHA256);
  assert.match(svg, /#7FD8A4/);
  assert.doesNotMatch(svg, /#F1F3EE|#FFFFFF|#000000/i);
  assert.match(svg, /fill="#103D32"/);
  assert.ok(!fs.existsSync(path.join(root, 'media', 'chat-tab-light.svg')) && !fs.existsSync(path.join(root, 'media', 'chat-tab-dark.svg')), 'the 0.6.0 themed tab icons are gone');
  const panels = read('src/panels.js');
  assert.match(panels, /panel\.iconPath = vscode\.Uri\.joinPath\(this\.context\.extensionUri, 'media', 'chat-tab\.svg'\);/);
  // The Activity Bar and the views keep the single-colour icon the editor tints.
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/chat.svg');
  assert.ok(manifest.contributes.views.planChat.every((view) => view.icon === 'media/chat.svg'));
});
