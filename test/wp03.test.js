'use strict';

const { HISTORICAL_SKIP } = require('./helpers/historical');

// WP-03 (data integrity): the cases not already covered by
// test/stage2.test.js (U1–U7, U21, U22, U29–U31), test/concurrency-store.test.js
// and test/stage3.test.js. Synthetic folders and histories in temporary
// directories; fake sign-in and model; no network. Earlier releases run from
// their authentic VSIX files (test/helpers/old-release.js), never installed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { calls, createContext, createWebviewView, makeTempDir, setActiveEditor, setWorkspaceFolders } = require('./helpers/fake-vscode');
const { loadOldStore } = require('./helpers/old-release');
const { runWorker } = require('./helpers/processes');
const { acquireLock } = require('../src/lock');
const { folderIdentityInput, projectKey } = require('../src/project');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');

test.afterEach(() => {
  setWorkspaceFolders(undefined);
  setActiveEditor(undefined);
  calls.quickPick = undefined;
  calls.warningChoice = 'Sign Out';
  calls.warning.length = 0;
});

const KEY = 'a'.repeat(64);
const keyOf = async (folderPath) => projectKey(KEY, (await folderIdentityInput(folderPath)).input);
const historyFile = (dir) => path.join(dir, 'conversations.json');
const readHistory = (dir) => JSON.parse(fs.readFileSync(historyFile(dir), 'utf8'));
const folder = (name, parent = makeTempDir()) => { const target = path.join(parent, name); fs.mkdirSync(target, { recursive: true }); return target; };
const chat = (id, title, extra = {}) => ({ id, title, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', messages: [{ id: `${id}-m1`, role: 'user', content: title, createdAt: '2026-10-20T00:00:00.000Z' }], ...extra });
const writeHistory = (dir, conversations, extra = {}) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(historyFile(dir), JSON.stringify({ version: 1, currentId: conversations[0]?.id, conversations, ...extra }, null, 2)); };

async function openWindow(storageDir) {
  const context = createContext({ storageDir });
  const requests = [];
  const auth = { getSession: async () => ({ email: 'synthetic.user@example.test' }), signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ messages, onDelta }) { requests.push(messages.map((message) => message.content)); onDelta(`reply ${requests.length}`); }
  };
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, openai, store, { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return { context, store, provider, view, requests, send: (text) => view.send({ type: 'send', text, model: 'model-a' }) };
}

async function worker(dir, ops, extra = {}) {
  const run = await runWorker('store-worker.js', { storageDir: dir, ops, ...extra });
  assert.equal(run.code, 0, `worker failed: ${run.stdout}${run.stderr}`);
  assert.equal(run.result.ok, true, run.stdout);
  return run.result;
}

// ---------------------------------------------------------------------------
// T03-01 workspace identity

test('T03-01 Arabic and English folder names: case, trailing separator, Unicode form and a junction give one key; siblings differ', async () => {
  const parent = makeTempDir();
  const target = folder('مشروع Alpha مثال', parent);
  const base = await keyOf(target);
  for (const variant of [target.toUpperCase(), target.toLowerCase(), `${target}${path.sep}`, target.normalize('NFD'), target[0].toLowerCase() + target.slice(1)]) {
    assert.equal(await keyOf(variant), base, JSON.stringify(variant));
  }
  const link = path.join(parent, 'رابط-link');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await keyOf(link), base, 'a junction to the folder');
  assert.equal((await folderIdentityInput(target)).label, 'مشروع Alpha مثال', 'the label keeps the name as written');
  // Unrelated folders, including a sibling sharing the name as a prefix and a subfolder, differ.
  for (const other of [folder('مشروع Alpha مثال-2', parent), folder('sub', target), folder('مشروع Beta', parent)]) {
    assert.notEqual(await keyOf(other), base, other);
  }
});

test('T03-01 equivalent file URI encodings decode to one folder and one key', async () => {
  const target = folder('مشروع Alpha مثال');
  const base = await keyOf(target);
  const standard = pathToFileURL(target).href; // percent-encoded Arabic and space
  const lowerDrive = standard.replace(/^file:\/\/\/([A-Z]):/, (whole, drive) => `file:///${drive.toLowerCase()}:`);
  const encodedColon = standard.replace(/^file:\/\/\/([A-Za-z]):/, (whole, drive) => `file:///${drive}%3A`);
  for (const href of [standard, lowerDrive, encodedColon]) {
    assert.equal(await keyOf(fileURLToPath(href)), base, href);
  }
});

test('T03-01 two distinct folders whose names differ only in Unicode form get different keys on Windows (R-27, fixed in WP-04)', async (t) => {
  // NTFS keeps "Café" (NFC) and "Café" (NFD) as two different folders. WP-03
  // recorded the shared key as a known limit; WP-04 found it leaked chats
  // between the two, and the identity now uses the stored path (§3.3).
  const parent = makeTempDir();
  const nfc = path.join(parent, 'Café');
  const nfd = path.join(parent, 'Café');
  fs.mkdirSync(nfc);
  try {
    fs.mkdirSync(nfd);
  } catch {
    t.diagnostic('this file system treats both names as one folder: no collision possible here');
    return;
  }
  assert.equal(fs.readdirSync(parent).length, 2, 'two folders exist');
  assert.notEqual(await keyOf(nfc), await keyOf(nfd), 'two folders, two keys');
});

// ---------------------------------------------------------------------------
// T03-02 identity key loss and transfer

test('T03-02 history restored without its key files: project chats kept byte for byte, listed under Earlier identity key, never relinked silently', async () => {
  const source = makeTempDir();
  const project = folder('alpha');
  setWorkspaceFolders([project]);
  const first = await openWindow(source);
  await first.send('alpha question');
  const original = readHistory(source).conversations.find((item) => item.title === 'alpha question');

  // Only conversations.json copied to a fresh installation.
  const restored = makeTempDir();
  fs.copyFileSync(historyFile(source), historyFile(restored));
  const second = await openWindow(restored);
  const all = await second.store.listAll();
  assert.equal(all.find((item) => item.id === original.id).section, 'earlier-key');
  assert.ok(!(await second.store.listConversations()).items.some((item) => item.id === original.id), 'not in the project list');
  await second.send('a new question in the restored installation');
  const after = readHistory(restored).conversations.find((item) => item.id === original.id);
  assert.deepEqual(after, original, 'the restored chat is untouched (tag, messages, ids)');
  assert.notEqual(second.provider.windowContext.keyId, original.context.keyId, 'a new identity key');
});

test('T03-02 history moved with its key files: the same project, the same chats', async () => {
  const source = makeTempDir();
  const project = folder('alpha');
  setWorkspaceFolders([project]);
  const first = await openWindow(source);
  await first.send('alpha question');
  const moved = makeTempDir();
  for (const name of ['conversations.json', 'project-identity.key', 'project-identity.key.bak']) fs.copyFileSync(path.join(source, name), path.join(moved, name));
  const second = await openWindow(moved);
  assert.equal((await second.store.getCurrent()).title, 'alpha question');
  assert.equal(second.provider.windowContext.key, first.provider.windowContext.key);
});

test('T03-02 key recreated while the folder stays: earlier chats keep their tags until Relink; nothing is rewritten by opening or sending', async () => {
  const storage = makeTempDir();
  const project = folder('alpha');
  setWorkspaceFolders([project]);
  const first = await openWindow(storage);
  await first.send('made with the first key');
  const before = readHistory(storage).conversations.find((item) => item.title === 'made with the first key');
  for (const name of ['project-identity.key', 'project-identity.key.bak']) fs.rmSync(path.join(storage, name));
  const second = await openWindow(storage);
  assert.equal((await second.store.listAll()).find((item) => item.id === before.id).section, 'earlier-key');
  await second.send('made with the new key');
  assert.deepEqual(readHistory(storage).conversations.find((item) => item.id === before.id), before);
});

// ---------------------------------------------------------------------------
// T03-03 contexts

test('T03-03 multi-root: an active file outside every workspace folder gives General ("choose"), never a folder', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  setWorkspaceFolders([folder('alpha', parent), folder('beta', parent)]);
  setActiveEditor(path.join(makeTempDir(), 'elsewhere.txt'));
  const window = await openWindow(storage);
  assert.deepEqual([window.provider.windowContext.kind, window.provider.windowContext.reason], ['general', 'choose']);
});

test('T03-03 multi-root: switching the active editor later does not switch the project', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const alpha = folder('alpha', parent);
  const beta = folder('beta', parent);
  setWorkspaceFolders([alpha, beta]);
  setActiveEditor(path.join(alpha, 'a.txt'));
  const window = await openWindow(storage);
  assert.equal(window.provider.windowContext.label, 'alpha');
  setActiveEditor(path.join(beta, 'b.txt'));
  await window.view.send({ type: 'showHistory' });
  await window.provider.workspaceChanged();
  assert.equal(window.provider.windowContext.label, 'alpha', 'only an explicit choice changes the project');
});

test('T03-03 a forged reply id from another project cannot change what that chat sends', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  setWorkspaceFolders([folder('alpha', parent)]);
  const a = await openWindow(storage);
  await a.send('alpha question');
  const chatA = (await a.store.getCurrent()).id;
  const replyA = readHistory(storage).conversations.find((item) => item.id === chatA).messages.find((message) => message.role === 'assistant');
  // Mark it as a reply to attached code, excluded (as stage 3 would).
  const history = readHistory(storage);
  Object.assign(history.conversations.find((item) => item.id === chatA).messages.find((message) => message.id === replyA.id), { attachmentTurn: true, contextPolicy: 'excluded' });
  fs.writeFileSync(historyFile(storage), JSON.stringify(history, null, 2));

  setWorkspaceFolders([folder('beta', parent)]);
  const b = await openWindow(storage);
  await assert.rejects(b.store.setContextPolicy(chatA, replyA.id, 'included'), /another project or context/);
  calls.warningChoice = 'Include in Follow-ups';
  await b.view.send({ type: 'setReplyContext', messageId: replyA.id, include: true });
  assert.equal(readHistory(storage).conversations.find((item) => item.id === chatA).messages.find((message) => message.id === replyA.id).contextPolicy, 'excluded');
});

// ---------------------------------------------------------------------------
// T03-04 legacy history and explicit moves

test('T03-04 unknown fields on chats and messages survive appends, moves, reply settings and outcomes', async () => {
  const storage = makeTempDir();
  writeHistory(storage, [chat('legacy-1', 'legacy chat', { futureChatField: { kept: 1 }, messages: [{ id: 'm1', role: 'user', content: 'legacy chat', createdAt: '2026-10-20T00:00:00.000Z', futureMessageField: 'kept' }, { id: 'm2', role: 'assistant', content: 'old reply', createdAt: '2026-10-20T00:00:00.000Z', attachmentTurn: true, contextPolicy: 'excluded' }] })], { futureTopField: [1, 2] });
  const window = await openWindow(storage);
  await window.send('continued in General');
  await window.store.setContextPolicy('legacy-1', 'm2', 'included');
  await window.store.moveConversation('legacy-1', { kind: 'general' });
  await window.store.moveConversation('legacy-1', undefined);
  const after = readHistory(storage);
  const legacy = after.conversations.find((item) => item.id === 'legacy-1');
  assert.deepEqual(after.futureTopField, [1, 2]);
  assert.deepEqual(legacy.futureChatField, { kept: 1 });
  assert.equal(legacy.messages[0].futureMessageField, 'kept');
  assert.deepEqual(legacy.messages.slice(0, 2).map((message) => message.id), ['m1', 'm2'], 'message ids unchanged');
  assert.equal(legacy.context, undefined, 'moved back: untagged again');
});

test('T03-04 Move and Move back keep the chat\'s id, messages and dates; only the tag changes', async () => {
  const storage = makeTempDir();
  writeHistory(storage, [chat('legacy-1', 'legacy chat')]);
  const before = readHistory(storage).conversations[0];
  setWorkspaceFolders([folder('alpha')]);
  const window = await openWindow(storage);
  await window.provider.openReadOnly('legacy-1');
  await window.provider.moveReadOnlyHere();
  const moved = readHistory(storage).conversations.find((item) => item.id === 'legacy-1');
  assert.deepEqual({ ...moved, context: undefined, updatedAt: undefined }, { ...before, context: undefined, updatedAt: undefined });
  assert.equal(moved.context.kind, 'project');
  await window.store.moveConversation('legacy-1', undefined);
  assert.deepEqual({ ...readHistory(storage).conversations.find((item) => item.id === 'legacy-1'), updatedAt: undefined }, { ...before, updatedAt: undefined });
});

test('T03-04 a cancelled move and a move that cannot take the lock leave the history byte for byte', async () => {
  const storage = makeTempDir();
  setWorkspaceFolders([folder('alpha')]);
  const window = await openWindow(storage);
  await window.send('a project chat');
  const before = fs.readFileSync(historyFile(storage));
  calls.warningChoice = undefined; // the confirmation is cancelled
  await window.provider.moveToGeneral();
  assert.deepEqual(fs.readFileSync(historyFile(storage)), before, 'cancelled');

  const lock = await acquireLock(path.join(storage, 'conversations.lock'));
  window.store.lockOptions = { ...window.store.lockOptions, timeoutMs: 300 };
  await assert.rejects(window.store.moveConversation((await window.store.getCurrent()).id, { kind: 'general' }), /busy|not saved/i);
  await lock.release();
  assert.deepEqual(fs.readFileSync(historyFile(storage)), before, 'failed: unchanged');
});

// ---------------------------------------------------------------------------
// T03-05 concurrency (separate processes)

test('T03-05 conflicting changes to one chat: moves in one process, appends in another; every message kept, ids unique', async () => {
  const dir = makeTempDir();
  await worker(dir, [{ op: 'init' }, { op: 'add', content: 'seed' }]);
  const chatId = readHistory(dir).currentId;
  const startAt = Date.now() + 1500;
  const tags = [{ kind: 'general' }, { kind: 'project', key: 'b'.repeat(32), keyId: 'c'.repeat(12), label: 'alpha' }];
  await Promise.all([
    worker(dir, Array.from({ length: 20 }, (_, index) => ({ op: 'move', conversationId: chatId, tag: tags[index % 2] })), { startAt }),
    worker(dir, Array.from({ length: 25 }, (_, index) => ({ op: 'add', content: `append ${index}`, conversationId: chatId })), { startAt }),
    worker(dir, Array.from({ length: 10 }, () => ({ op: 'select', conversationId: chatId })), { startAt })
  ]);
  const final = readHistory(dir);
  const messages = final.conversations.find((item) => item.id === chatId).messages;
  assert.deepEqual(messages.map((message) => message.content), ['seed', ...Array.from({ length: 25 }, (_, index) => `append ${index}`)], 'all appends, in order');
  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length, 'no duplicate message ids');
  assert.equal(new Set(final.conversations.map((item) => item.id)).size, final.conversations.length, 'no duplicate chat ids');
  assert.ok(tags.some((tag) => JSON.stringify(tag) === JSON.stringify(final.conversations.find((item) => item.id === chatId).context)), 'the tag is one of the written values');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
});

test('T03-05 simultaneous selection in several processes: each keeps its own chat; the file\'s currentId is one of them', async () => {
  const dir = makeTempDir();
  const seed = await worker(dir, [{ op: 'init' }, { op: 'new', as: 'a' }, { op: 'add', content: 'a', conversationVar: 'a' }, { op: 'new', as: 'b' }, { op: 'add', content: 'b', conversationVar: 'b' }]);
  const ids = [seed.vars.a, seed.vars.b];
  const startAt = Date.now() + 1500;
  await Promise.all(ids.flatMap((id) => [0, 1].map(() => worker(dir, Array.from({ length: 8 }, () => ({ op: 'select', conversationId: id })), { startAt }))));
  const final = readHistory(dir);
  assert.ok(ids.includes(final.currentId));
  assert.equal(final.conversations.length, 2);
});

// ---------------------------------------------------------------------------
// T03-06 corruption and recovery

for (const [name, text] of [
  ['valid JSON, conversations is an object', JSON.stringify({ version: 1, conversations: { a: { id: 'a', title: 'SYNTHETIC-KEEP', messages: [] } } })],
  ['valid JSON, conversations is a string', JSON.stringify({ version: 1, conversations: 'SYNTHETIC-KEEP' })],
  ['valid JSON, top level is a list', JSON.stringify([{ id: 'a', title: 'SYNTHETIC-KEEP', messages: [] }])],
  ['valid JSON, top level is a string', JSON.stringify('SYNTHETIC-KEEP')],
  ['truncated JSON', '{"version":1,"conversations":[{"id":"a","title":"SYNTHETIC-KEEP","messages":[{"content":"مهم']
]) {
  test(`T03-06 ${name}: kept aside unchanged, never overwritten; a new history starts; the user is told`, async () => {
    const storage = makeTempDir();
    fs.writeFileSync(historyFile(storage), text);
    const window = await openWindow(storage);
    await window.send('after recovery');
    const kept = fs.readdirSync(storage).filter((file) => file.startsWith('conversations.corrupt-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(storage, kept[0]), 'utf8'), text, 'the original text, byte for byte');
    assert.ok(readHistory(storage).conversations.some((item) => item.title === 'after recovery'));
    assert.ok(calls.warning.some((message) => message.includes('could not read its chat history file') && message.includes(kept[0])), 'a visible notice naming the kept file');
  });
}

test('T03-06 a read-only history file: the change fails visibly; the file is unchanged; no temporary file is left', async () => {
  const storage = makeTempDir();
  const window = await openWindow(storage);
  await window.send('first');
  const before = fs.readFileSync(historyFile(storage));
  fs.chmodSync(historyFile(storage), 0o444);
  try {
    window.store.lockOptions = { ...window.store.lockOptions };
    await assert.rejects(window.store.addMessage('user', 'cannot be saved'));
  } finally {
    fs.chmodSync(historyFile(storage), 0o644);
  }
  assert.deepEqual(fs.readFileSync(historyFile(storage)), before);
  assert.deepEqual(fs.readdirSync(storage).filter((file) => file.endsWith('.tmp')), []);
});

test('T03-06 a write that fails part-way (disk full): the history is unchanged and the error reaches the caller', async () => {
  const storage = makeTempDir();
  const window = await openWindow(storage);
  await window.send('first');
  const before = fs.readFileSync(historyFile(storage));
  const open = fs.promises.open;
  fs.promises.open = async (file, flags) => {
    const handle = await open(file, flags);
    if (String(file).endsWith('.tmp')) {
      handle.writeFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    }
    return handle;
  };
  try {
    await assert.rejects(window.store.addMessage('user', 'disk full'), /ENOSPC/);
  } finally {
    fs.promises.open = open;
  }
  assert.deepEqual(fs.readFileSync(historyFile(storage)), before);
});

test('T03-06 an inaccessible history path: the error reaches the caller and nothing is deleted', async () => {
  const storage = makeTempDir();
  fs.mkdirSync(historyFile(storage)); // a folder where the file should be
  fs.writeFileSync(path.join(historyFile(storage), 'inside.txt'), 'synthetic');
  const store = new ConversationStore(createContext({ storageDir: storage }));
  await assert.rejects(store.initialize());
  assert.equal(fs.readFileSync(path.join(historyFile(storage), 'inside.txt'), 'utf8'), 'synthetic');
});

test('T03-06 restoring a backup of the whole storage folder brings back every chat and its project', async () => {
  // Inside a temporary folder, so the restore replaces only this folder and
  // the temporary folder is still removed at the end (test/helpers/owned-temp.js).
  const storage = path.join(makeTempDir(), 'storage');
  fs.mkdirSync(storage);
  const project = folder('alpha');
  setWorkspaceFolders([project]);
  const first = await openWindow(storage);
  await first.send('before the backup');
  const backup = path.join(makeTempDir(), 'backup');
  fs.cpSync(storage, backup, { recursive: true });
  await first.send('after the backup (lost by the restore)');
  // Restore: the whole folder replaced by the backup.
  fs.rmSync(storage, { recursive: true, force: true });
  fs.cpSync(backup, storage, { recursive: true });
  const restored = await openWindow(storage);
  const titles = (await restored.store.listConversations()).items.map((item) => item.title);
  assert.ok(titles.includes('before the backup'), 'restored chats listed in their project');
  assert.equal(restored.provider.windowContext.key, first.provider.windowContext.key);
});

// ---------------------------------------------------------------------------
// T03-07 / T03-08 downgrade, with the released stores

// Tags as the current 3.1 writes them (identity scheme 2, WP-04 R-27/R-29).
const tag = { kind: 'project', key: 'c'.repeat(32), keyId: 'd'.repeat(12), label: 'alpha', scheme: 2 };
const otherTag = { kind: 'project', key: 'e'.repeat(32), keyId: 'd'.repeat(12), label: 'beta', scheme: 2 };
const metadata = [{ id: 'att-1', kind: 'selection', displayPath: 'src/app.js', languageId: 'javascript', startLine: 1, endLine: 4, chars: 70, utf8Bytes: 70, flags: { unsaved: false, untitled: false, credentialPatternConfirmed: false }, outcome: 'sent', sentAt: '2026-10-28T00:00:00.000Z' }];
function stage3History(count = 3) {
  const conversations = [
    { ...chat('p1', 'Explain this'), context: tag, messages: [
      { id: 'p1-u', role: 'user', content: 'Explain this', createdAt: '2026-10-28T00:00:00.000Z', attachments: metadata },
      { id: 'p1-a', role: 'assistant', content: 'ATTACHED-REPLY quoting the code', createdAt: '2026-10-28T00:00:01.000Z', attachmentTurn: true, contextPolicy: 'excluded' }
    ] },
    { ...chat('p2', 'beta chat'), context: otherTag },
    { ...chat('g1', 'general chat'), context: { kind: 'general' } }
  ];
  for (let index = conversations.length; index < count; index += 1) conversations.push({ ...chat(`x${index}`, `extra ${index}`), updatedAt: `2026-10-${String(1 + (index % 19)).padStart(2, '0')}T00:00:00.000Z` });
  return conversations;
}

test('T03-07 0.1.2 reads and writes a 3.1 history: the file stays usable and every tag, attachment record and reply marker is kept', { skip: HISTORICAL_SKIP }, async () => {
  const { ConversationStore: Old } = loadOldStore('0.1.2');
  const storage = makeTempDir();
  writeHistory(storage, stage3History(), { futureTopField: true });
  const old = new Old(createContext({ storageDir: storage }));
  await old.initialize();
  await old.selectConversation('p1');
  await old.addMessage('user', 'written by 0.1.2', 'p1');
  const after = readHistory(storage);
  const p1 = after.conversations.find((item) => item.id === 'p1');
  assert.deepEqual(p1.context, tag);
  assert.deepEqual(p1.messages[0].attachments, metadata);
  assert.equal(p1.messages[1].contextPolicy, 'excluded');
  assert.equal(after.futureTopField, true);
  // Back on 3.1: the project and the exclusion are in force again.
  setWorkspaceFolders(undefined);
  const current = new ConversationStore(createContext({ storageDir: storage }));
  current.setContext({ kind: 'project', key: tag.key, keyId: tag.keyId, label: 'alpha' });
  assert.ok((await current.listConversations()).items.some((item) => item.id === 'p1'));
  assert.ok(!(await current.contextMessages('p1')).some((message) => message.content.startsWith('ATTACHED-REPLY')));
});

test('T03-07 0.1.2 does not separate projects: it lists every chat and can continue another project\'s chat', { skip: HISTORICAL_SKIP }, async () => {
  const { ConversationStore: Old } = loadOldStore('0.1.2');
  const storage = makeTempDir();
  writeHistory(storage, stage3History());
  const old = new Old(createContext({ storageDir: storage }));
  const list = await old.listConversations();
  assert.deepEqual(list.items.map((item) => item.id).sort(), ['g1', 'p1', 'p2']);
  await old.addMessage('user', 'sent into beta from anywhere', 'p2');
  assert.equal(readHistory(storage).conversations.find((item) => item.id === 'p2').messages.at(-1).content, 'sent into beta from anywhere');
});

test('T03-07 0.1.0 keeps only 30 chats when it saves: with 35, five are lost from the file', { skip: HISTORICAL_SKIP }, async () => {
  const { ConversationStore: Old } = loadOldStore('0.1.0');
  const storage = makeTempDir();
  const conversations = stage3History(35);
  writeHistory(storage, conversations);
  const old = new Old(createContext({ storageDir: storage }));
  await old.initialize();
  await old.addMessage('user', 'written by 0.1.0');
  const after = readHistory(storage);
  assert.equal(after.conversations.length, 30, 'documented 0.1.0 limit');
  const lost = conversations.map((item) => item.id).filter((id) => !after.conversations.some((item) => item.id === id));
  assert.equal(lost.length, 5);
});

test('T03-08 0.1.2 sends a reply marked "not sent with follow-ups" again; 3.1 does not; the attached code is in neither', { skip: HISTORICAL_SKIP }, async () => {
  const { ConversationStore: Old } = loadOldStore('0.1.2');
  const storage = makeTempDir();
  writeHistory(storage, stage3History());
  const old = new Old(createContext({ storageDir: storage }));
  const oldContext = await old.contextMessages('p1');
  assert.ok(oldContext.some((message) => message.content.startsWith('ATTACHED-REPLY')), '0.1.2 includes the excluded reply');
  const current = new ConversationStore(createContext({ storageDir: storage }));
  const newContext = await current.contextMessages('p1');
  assert.ok(!newContext.some((message) => message.content.startsWith('ATTACHED-REPLY')), '3.1 leaves it out');
  // The stored user message holds the typed text only; the attachment is metadata.
  assert.ok(!fs.readFileSync(historyFile(storage), 'utf8').includes('function'), 'no attached source in the file');
});

test('T03-07 chats started in 0.1.2 have no project tag: after re-upgrading they are Earlier chats (General), never assigned to a project', { skip: HISTORICAL_SKIP }, async () => {
  const { ConversationStore: Old } = loadOldStore('0.1.2');
  const storage = makeTempDir();
  writeHistory(storage, stage3History());
  const old = new Old(createContext({ storageDir: storage }));
  await old.initialize();
  const created = await old.newConversation();
  await old.addMessage('user', 'asked while on 0.1.2', created.id);
  const current = new ConversationStore(createContext({ storageDir: storage }));
  current.setContext({ kind: 'project', key: tag.key, keyId: tag.keyId, label: 'alpha' });
  const item = (await current.listAll()).find((entry) => entry.id === created.id);
  assert.equal(item.section, 'earlier');
  assert.equal(item.allowed, false, 'read-only in a project window until moved');
  assert.equal(readHistory(storage).conversations.find((entry) => entry.id === created.id).context, undefined);
});
