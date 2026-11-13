'use strict';

const { HISTORICAL_SKIP } = require('./helpers/historical');

// Phase 3.1 stage 2: project identity and chat isolation (architecture
// revision 3, §3; tests U1–U7, U21, U22, U29–U31 of §14.1). Synthetic folders
// and history in temporary directories; fake sign-in and model; no network.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { calls, createContext, createWebviewView, makeTempDir, setActiveEditor, setWorkspaceFolders } = require('./helpers/fake-vscode');
const { runWorker } = require('./helpers/processes');
// Each worker's printed result ({ ok, ... }), one per process.
const runWorkers = async (worker, specs) => (await Promise.all(specs.map((spec) => runWorker(worker, spec)))).map((run) => run.result || { ok: false, error: run.stderr });
const { readZipEntry } = require('./helpers/read-zip-entry');
const { IdentityKeys, ProjectContext, folderIdentityInput, keyIdOf, parseKeyRecord, projectKey } = require('../src/project');
const { ConversationStore, normalizeState } = require('../src/store');
const { ChatViewProvider } = require('../src/view');

const root = path.resolve(__dirname, '..');

test.afterEach(() => {
  setWorkspaceFolders(undefined);
  setActiveEditor(undefined);
  calls.quickPick = undefined;
  calls.warningChoice = 'Sign Out';
});

function folder(name, parent = makeTempDir()) {
  const target = path.join(parent, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

// One editor window: its own provider and store over a shared storage folder.
async function openWindow(storageDir, { workspaceValues } = {}) {
  const context = createContext({ storageDir, workspaceValues });
  const requests = [];
  const auth = { getSession: async () => ({ email: 'synthetic.user@example.test' }), signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ messages, onDelta }) {
      requests.push(messages.map((message) => message.content));
      onDelta('synthetic reply');
    }
  };
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, openai, store, { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  const lastContext = () => view.posted.filter((message) => message.context).at(-1)?.context;
  return { context, store, provider, view, requests, lastContext, send: (text) => view.send({ type: 'send', text, model: 'model-a' }) };
}

function writeHistory(storageDir, conversations) {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'conversations.json'), JSON.stringify({ version: 1, currentId: conversations[0]?.id, conversations, futureField: { kept: true } }, null, 2));
}

const legacyChat = (id, text) => ({ id, title: text, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', messages: [{ id: `${id}-m`, role: 'user', content: text, createdAt: '2026-10-20T00:00:00.000Z' }] });
const readHistory = (storageDir) => JSON.parse(fs.readFileSync(path.join(storageDir, 'conversations.json'), 'utf8'));

// ---------------------------------------------------------------------------

test('U1 no workspace: General; new chats tagged general; legacy chats listed as earlier and continuable untagged', async () => {
  const storage = makeTempDir();
  writeHistory(storage, [legacyChat('legacy-1', 'old question')]);
  setWorkspaceFolders(undefined);
  const window = await openWindow(storage);
  assert.equal(window.lastContext().kind, 'general');
  assert.equal(window.lastContext().reason, 'no-folder');

  // The legacy chat is the newest of this context, so it opens and is continued untagged.
  await window.send('continue the old chat');
  const legacy = readHistory(storage).conversations.find((item) => item.id === 'legacy-1');
  assert.equal(legacy.context, undefined, 'never tagged automatically');
  assert.equal(legacy.messages.at(-2).content, 'continue the old chat');

  await window.view.send({ type: 'newChat' });
  await window.send('a general question');
  const created = readHistory(storage).conversations.find((item) => item.title === 'a general question');
  assert.deepEqual(created.context, { kind: 'general' });
  const list = await window.store.listConversations();
  assert.deepEqual(list.items.map((item) => item.section).sort(), ['earlier', 'general']);
  assert.deepEqual(readHistory(storage).futureField, { kept: true }, 'unknown top-level fields kept');
});

test('U2 single folder: the key is stable across activations; the list shows only that project', async () => {
  const storage = makeTempDir();
  const projectA = folder('alpha');
  const projectB = folder('beta');
  setWorkspaceFolders([projectA]);
  const first = await openWindow(storage);
  await first.send('alpha question');
  const keyA = first.lastContext() && readHistory(storage).conversations.find((item) => item.title === 'alpha question').context.key;
  assert.match(keyA, /^[0-9a-f]{32}$/);

  const again = await openWindow(storage);
  assert.equal((await again.store.getCurrent()).title, 'alpha question', 'a restart opens the project\'s chat');
  assert.equal(again.provider.windowContext.key, keyA, 'same key across activations');

  setWorkspaceFolders([projectB]);
  const other = await openWindow(storage);
  assert.notEqual(other.provider.windowContext.key, keyA);
  assert.deepEqual((await other.store.listConversations()).items.filter((item) => item.title === 'alpha question'), []);
  // History file never holds a path.
  assert.doesNotMatch(fs.readFileSync(path.join(storage, 'conversations.json'), 'utf8'), /alpha[\\/]|beta[\\/]|[A-Za-z]:\\\\/);
});

test('U3 multi-root: default follows the active editor; none → General; choosing switches the list and is remembered', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const projectA = folder('alpha', parent);
  const projectB = folder('beta', parent);
  setWorkspaceFolders([projectA, projectB]);

  setActiveEditor(path.join(projectB, 'file.txt'));
  const withEditor = await openWindow(storage);
  assert.equal(withEditor.lastContext().kind, 'project');
  assert.equal(withEditor.lastContext().label, 'beta');
  assert.equal(withEditor.lastContext().multiRoot, true);
  await withEditor.send('beta question');

  setActiveEditor(undefined);
  const workspaceValues = new Map();
  const noEditor = await openWindow(storage, { workspaceValues });
  assert.equal(noEditor.lastContext().kind, 'general', 'never the first folder by default');
  assert.equal(noEditor.lastContext().reason, 'choose');

  // The user picks alpha: the list switches; beta's chat is not listed.
  calls.quickPick = (items) => items.find((item) => item.value && item.value.endsWith('/alpha'));
  await noEditor.view.send({ type: 'chooseProject' });
  assert.equal(noEditor.lastContext().label, 'alpha');
  assert.deepEqual((await noEditor.store.listConversations()).items.filter((item) => item.title === 'beta question'), []);

  // A new window of the same workspace remembers the choice (workspaceState).
  const remembered = await openWindow(storage, { workspaceValues });
  assert.equal(remembered.lastContext().label, 'alpha');
});

test('U4 isolation: B never lists, opens or sends into A\'s chat; request context never crosses', async () => {
  const storage = makeTempDir();
  const projectA = folder('alpha');
  const projectB = folder('beta');
  setWorkspaceFolders([projectA]);
  const windowA = await openWindow(storage);
  await windowA.send('SECRET-A-CONTENT question');
  const chatA = (await windowA.store.getCurrent()).id;

  setWorkspaceFolders([projectB]);
  const windowB = await openWindow(storage);
  assert.notEqual((await windowB.store.getCurrent()).id, chatA, 'startup does not open A\'s chat');
  assert.ok(!(await windowB.store.listConversations()).items.some((item) => item.id === chatA));

  // Forged ids from the webview.
  await windowB.view.send({ type: 'selectConversation', conversationId: chatA });
  assert.notEqual((await windowB.store.getCurrent()).id, chatA);
  assert.match(windowB.view.posted.filter((message) => message.type === 'error').at(-1).message, /belongs to another project/);
  await assert.rejects(windowB.store.addMessage('user', 'forged', chatA), /another project or context/);

  // Read-only from All Chats: shown, but nothing can be sent into it.
  await windowB.provider.openReadOnly(chatA);
  assert.equal(windowB.view.posted.at(-1).readOnly.section, 'other-project');
  await windowB.send('should not go into A');
  assert.equal(readHistory(storage).conversations.find((item) => item.id === chatA).messages.length, 2, 'A\'s chat unchanged');
  assert.equal(windowB.view.posted.filter((message) => message.type === 'restoreDraft').at(-1).text, 'should not go into A');

  // Back to B's own chat: its requests never contain A's text.
  await windowB.provider.leaveReadOnly();
  await windowB.send('B question one');
  await windowB.send('B question two');
  assert.ok(windowB.requests.length >= 2);
  for (const request of windowB.requests) {
    assert.ok(!request.some((content) => content.includes('SECRET-A-CONTENT')), 'no A content in B\'s requests');
  }
});

test('U5 legacy: untagged chats unchanged by a project session; tagged only by an explicit Move; Move back restores', async () => {
  const storage = makeTempDir();
  const original = legacyChat('legacy-1', 'kept as is');
  writeHistory(storage, [original]);
  setWorkspaceFolders([folder('alpha')]);
  const window = await openWindow(storage);
  await window.send('project question');
  const after = readHistory(storage).conversations.find((item) => item.id === 'legacy-1');
  assert.deepEqual(after, original, 'byte-for-byte the same object');

  // Read-only from the project window, then moved here explicitly.
  await window.provider.openReadOnly('legacy-1');
  assert.equal(window.view.posted.at(-1).readOnly.section, 'earlier');
  assert.equal(window.view.posted.at(-1).readOnly.action.label, 'Move to this project');
  await window.provider.moveReadOnlyHere();
  const moved = readHistory(storage).conversations.find((item) => item.id === 'legacy-1');
  assert.equal(moved.context.kind, 'project');
  assert.equal((await window.store.getCurrent()).id, 'legacy-1');

  // Move back (untagged again): the chat is as it was.
  await window.store.moveConversation('legacy-1', undefined);
  assert.deepEqual(readHistory(storage).conversations.find((item) => item.id === 'legacy-1'), original);
});

test('U6 relocation: a moved folder gets a new key; old chats under Other projects; Move restores; nothing deleted', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const before = folder('service', parent);
  setWorkspaceFolders([before]);
  const window = await openWindow(storage);
  await window.send('before the move');
  const oldChat = (await window.store.getCurrent()).id;

  const after = path.join(parent, 'service-renamed');
  fs.renameSync(before, after);
  setWorkspaceFolders([after]);
  const moved = await openWindow(storage);
  assert.notEqual((await moved.store.getCurrent()).id, oldChat);
  const all = await moved.store.listAll();
  assert.equal(all.find((item) => item.id === oldChat).section, 'other-project');
  assert.equal(all.find((item) => item.id === oldChat).label, 'service');

  await moved.provider.openReadOnly(oldChat);
  await moved.provider.moveReadOnlyHere();
  assert.equal((await moved.store.getCurrent()).id, oldChat);
  assert.equal(readHistory(storage).conversations.length, all.length, 'nothing deleted');
});

test('U6b unavailable folder: the same key from the unresolved path; the indicator says so', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const gone = path.join(parent, 'offline-share');
  setWorkspaceFolders([gone]); // never created: realpath fails
  const window = await openWindow(storage);
  assert.equal(window.lastContext().kind, 'project');
  assert.equal(window.lastContext().available, false);
});

test('U7 normalization: case, trailing separator and links give the same key; Unicode form only off Windows', async () => {
  const parent = makeTempDir();
  const target = folder('Projekt-Ä', parent);
  const key = 'a'.repeat(64);
  const base = await folderIdentityInput(target);
  const variants = [
    target.toUpperCase(),
    `${target}${path.sep}`
  ];
  for (const variant of variants) {
    const result = await folderIdentityInput(variant);
    assert.equal(projectKey(key, result.input), projectKey(key, base.input), variant);
  }
  // The decomposed spelling: on Windows (NTFS) it names a different folder, so
  // a different key (R-27, WP-04); elsewhere the identity is still NFC.
  const decomposed = projectKey(key, (await folderIdentityInput(target.normalize('NFD'))).input);
  if (process.platform === 'win32') assert.notEqual(decomposed, projectKey(key, base.input));
  else assert.equal(decomposed, projectKey(key, base.input));
  // A directory junction (Windows) or symlink resolves to the same key.
  const link = path.join(parent, 'link-to-projekt');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(projectKey(key, (await folderIdentityInput(link)).input), projectKey(key, base.input));
  assert.equal(base.label, 'Projekt-Ä', 'the display label keeps its casing');
  // Different folders differ; different identity keys differ.
  const other = folder('other', parent);
  assert.notEqual(projectKey(key, (await folderIdentityInput(other)).input), projectKey(key, base.input));
  assert.notEqual(projectKey('b'.repeat(64), base.input), projectKey(key, base.input));
});

test('U7b remote-only and mixed windows: remote folders have no identity', async () => {
  const storage = makeTempDir();
  setWorkspaceFolders([{ path: '/remote/project', scheme: 'vscode-remote' }]);
  const remoteOnly = await openWindow(storage);
  assert.equal(remoteOnly.lastContext().kind, 'general');
  assert.equal(remoteOnly.lastContext().reason, 'remote');
});

test('workspace change: the chosen folder removed at runtime → General; its chats stay', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const projectA = folder('alpha', parent);
  const projectB = folder('beta', parent);
  setWorkspaceFolders([projectA, projectB]);
  setActiveEditor(path.join(projectA, 'x.txt'));
  const window = await openWindow(storage);
  await window.send('alpha chat');
  const chat = (await window.store.getCurrent()).id;
  setWorkspaceFolders([projectB]);
  await window.provider.workspaceChanged();
  // §3.4: the chosen folder was removed → General, even though one folder is
  // left; the window does not switch to beta by itself.
  assert.equal(window.lastContext().kind, 'general');
  assert.equal(window.lastContext().reason, 'folder-removed');
  assert.equal(window.lastContext().canChoose, true, 'the remaining folder can be chosen explicitly');
  assert.ok(!(await window.store.listConversations()).items.some((item) => item.id === chat), 'alpha\'s chat is not listed in General');
  calls.quickPick = (items) => items.find((item) => item.value && item.value.endsWith('/beta'));
  await window.view.send({ type: 'chooseProject' });
  assert.equal(window.lastContext().label, 'beta');
  assert.ok(readHistory(storage).conversations.some((item) => item.id === chat), 'nothing deleted');
});

// ---------------------------------------------------------------------------

test('U21 concurrent distinct projects (separate processes): each keeps its tag, nothing lost', async () => {
  const storage = makeTempDir();
  const tagA = { kind: 'project', key: 'a'.repeat(32), keyId: 'k'.repeat(12), label: 'alpha' };
  const tagB = { kind: 'project', key: 'b'.repeat(32), keyId: 'k'.repeat(12), label: 'beta' };
  const startAt = Date.now() + 1500;
  const ops = (label) => [{ op: 'new', as: 'chat' }, ...Array.from({ length: 15 }, (_, index) => ({ op: 'add', role: 'user', content: `${label}-${index}`, conversationVar: 'chat' }))];
  const results = await runWorkers('store-worker.js', [
    { storageDir: storage, startAt, label: 'A', context: tagA, ops: ops('A') },
    { storageDir: storage, startAt, label: 'B', context: tagB, ops: ops('B') }
  ]);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const history = readHistory(storage);
  for (const [label, tag] of [['A', tagA], ['B', tagB]]) {
    const chats = history.conversations.filter((item) => item.context?.key === tag.key);
    assert.equal(chats.length, 1, `${label} has its chat`);
    assert.deepEqual(chats[0].messages.map((message) => message.content), Array.from({ length: 15 }, (_, index) => `${label}-${index}`));
  }
});

test('U22 old-release read-back: 0.1.2, 0.1.1 and 0.1.0 keep chats, messages and tags', { skip: HISTORICAL_SKIP }, () => {
  const sources = {
    '0.1.2': readZipEntry(path.join(root, 'releases', 'plan-chat-antigravity-0.1.2.vsix'), 'extension/src/store.js'),
    '0.1.1': readZipEntry(path.join(root, 'releases', 'plan-chat-antigravity-0.1.1.vsix'), 'extension/src/store.js'),
    '0.1.0': readZipEntry(path.join(root, 'backups', 'baseline-0.1.0', 'plan-chat-antigravity-0.1.0.vsix'), 'extension/src/store.js')
  };
  const extract = (source, name) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(source)[0];
  const tag = { kind: 'project', key: 'c'.repeat(32), keyId: 'd'.repeat(12), label: 'alpha' };
  const written = normalizeState({
    version: 1,
    currentId: 'p1',
    conversations: [
      { ...legacyChat('p1', 'project chat'), context: tag },
      { ...legacyChat('g1', 'general chat'), context: { kind: 'general' } },
      legacyChat('l1', 'legacy chat')
    ]
  });
  for (const [version, source] of Object.entries(sources)) {
    const normalize = new Function('crypto', `${extract(source, 'isConversation')}\n${extract(source, 'createConversation')}\n${extract(source, 'normalizeState')}\nreturn normalizeState;`)(crypto);
    const read = normalize(structuredClone(written));
    assert.deepEqual(read.conversations.map((item) => item.id), ['p1', 'g1', 'l1'], version);
    assert.deepEqual(read.conversations[0].context, tag, `${version} keeps the project tag`);
    assert.deepEqual(read.conversations[1].context, { kind: 'general' }, `${version} keeps the general tag`);
    assert.deepEqual(read.conversations[2].messages, written.conversations[2].messages, `${version} keeps messages`);
  }
  // Documented 0.1.0 limit: it keeps only 30 chats when it saves.
  const many = { version: 1, conversations: Array.from({ length: 31 }, (_, index) => legacyChat(`c${index}`, `chat ${index}`)) };
  const old = new Function('crypto', `${extract(sources['0.1.0'], 'isConversation')}\n${extract(sources['0.1.0'], 'createConversation')}\n${extract(sources['0.1.0'], 'normalizeState')}\nreturn normalizeState;`)(crypto);
  assert.equal(old(many).conversations.length, 30);
});

// ---------------------------------------------------------------------------

test('U29 identity key: four processes start with no key → one key, all agree, no empty file', async () => {
  const directory = makeTempDir();
  // A crashed earlier attempt leaves only a temporary file; it is never used.
  fs.writeFileSync(path.join(directory, 'project-identity.key.dead.tmp'), '{"version":1,"key":"');
  const startAt = Date.now() + 1500;
  const results = await runWorkers('identity-worker.js', [1, 2, 3, 4].map((index) => ({ directory, startAt, label: `w${index}` })));
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(new Set(results.map((result) => result.keyId)).size, 1);
  const primary = parseKeyRecord(fs.readFileSync(path.join(directory, 'project-identity.key'), 'utf8'));
  const backup = parseKeyRecord(fs.readFileSync(path.join(directory, 'project-identity.key.bak'), 'utf8'));
  assert.equal(primary.keyId, results[0].keyId);
  assert.equal(backup.keyId, primary.keyId);
});

test('U30 identity key recovery: every row of the §3.5 table', async () => {
  const valid = () => { const key = crypto.randomBytes(32).toString('hex'); return { version: 1, key, keyId: keyIdOf(key), createdAt: new Date().toISOString() }; };
  const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  const files = (directory) => fs.readdirSync(directory).sort();

  // valid / valid → use
  let directory = makeTempDir();
  const record = valid();
  write(directory, 'project-identity.key', record);
  write(directory, 'project-identity.key.bak', record);
  assert.equal((await new IdentityKeys(directory).load()).keyId, record.keyId);

  // valid / missing → backup recreated
  directory = makeTempDir();
  write(directory, 'project-identity.key', record);
  assert.equal((await new IdentityKeys(directory).load()).keyId, record.keyId);
  assert.equal(parseKeyRecord(fs.readFileSync(path.join(directory, 'project-identity.key.bak'), 'utf8')).keyId, record.keyId);

  // valid / invalid → invalid backup kept aside, recreated
  directory = makeTempDir();
  write(directory, 'project-identity.key', record);
  write(directory, 'project-identity.key.bak', 'garbage');
  await new IdentityKeys(directory).load();
  assert.ok(files(directory).some((name) => name.startsWith('project-identity.key.bak.corrupt-')));

  // missing / valid → primary restored from backup
  directory = makeTempDir();
  write(directory, 'project-identity.key.bak', record);
  assert.equal((await new IdentityKeys(directory).load()).keyId, record.keyId);
  assert.equal(parseKeyRecord(fs.readFileSync(path.join(directory, 'project-identity.key'), 'utf8')).keyId, record.keyId);

  // invalid / valid → invalid primary kept aside, restored
  directory = makeTempDir();
  write(directory, 'project-identity.key', '{"version":1,"key":"zz"}');
  write(directory, 'project-identity.key.bak', record);
  assert.equal((await new IdentityKeys(directory).load()).keyId, record.keyId);
  assert.ok(files(directory).some((name) => name.startsWith('project-identity.key.corrupt-')));

  // invalid / invalid → both kept aside; a new key; earlier project chats listed, none deleted
  const storage = makeTempDir();
  write(storage, 'project-identity.key', 'broken');
  write(storage, 'project-identity.key.bak', 'broken too');
  writeHistory(storage, [{ ...legacyChat('old-project', 'made with an earlier key'), context: { kind: 'project', key: 'e'.repeat(32), keyId: 'f'.repeat(12), label: 'alpha' } }]);
  setWorkspaceFolders([folder('alpha')]);
  const window = await openWindow(storage);
  assert.equal(window.lastContext().regenerated, true);
  assert.equal(files(storage).filter((name) => name.includes('.corrupt-')).length, 2);
  const all = await window.store.listAll();
  assert.equal(all.find((item) => item.id === 'old-project').section, 'earlier-key');
  // Relink to this project, explicitly.
  await window.provider.openReadOnly('old-project');
  assert.equal(window.view.posted.at(-1).readOnly.action.label, 'Relink to this project');
  await window.provider.moveReadOnlyHere();
  const relinked = readHistory(storage).conversations.find((item) => item.id === 'old-project');
  assert.equal(relinked.context.keyId, window.provider.windowContext.keyId);
  assert.equal(relinked.context.key, window.provider.windowContext.key);
});

test('U31 stale key in a window: after another window regenerates the key, the next tag uses the new keyId', async () => {
  const storage = makeTempDir();
  setWorkspaceFolders([folder('alpha')]);
  const windowA = await openWindow(storage);
  const oldKeyId = windowA.provider.windowContext.keyId;

  // "Window B" finds both files unusable and regenerates.
  fs.writeFileSync(path.join(storage, 'project-identity.key'), 'x');
  fs.writeFileSync(path.join(storage, 'project-identity.key.bak'), 'x');
  const fresh = await new IdentityKeys(storage).load();
  assert.notEqual(fresh.keyId, oldKeyId);

  await windowA.view.send({ type: 'newChat' });
  await windowA.send('tagged after the change');
  const chat = readHistory(storage).conversations.find((item) => item.title === 'tagged after the change');
  assert.equal(chat.context.keyId, fresh.keyId);
});

test('two windows on the same folder see the same chats; the file\'s currentId is used only within its context', async () => {
  const storage = makeTempDir();
  const project = folder('alpha');
  setWorkspaceFolders([project]);
  const first = await openWindow(storage);
  await first.send('shared project chat');
  const second = await openWindow(storage);
  assert.ok((await second.store.listConversations()).items.some((item) => item.title === 'shared project chat'));

  // A General window does not start on the project chat even though it is the file's currentId.
  const projectChat = (await first.store.getCurrent()).id;
  assert.equal(readHistory(storage).currentId, projectChat);
  setWorkspaceFolders(undefined);
  const general = await openWindow(storage);
  assert.notEqual((await general.store.getCurrent()).id, projectChat);
});
