'use strict';

const { HISTORICAL_SKIP } = require('./helpers/historical');

// WP-04 (security and privacy): cases not already covered by
// test/stage3.test.js (attachments), test/markdown.test.js, test/view-ui.test.js,
// test/chat.test.js (secrets) and test/auth.test.js. Synthetic folders,
// documents and histories in temporary directories; fake sign-in and model;
// global fetch blocked for the whole file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  calls, config, createContext, createEditor, createTextDocument, createWebviewView, makeTempDir,
  setActiveEditor, setActiveTextEditor, setWorkspaceFolders
} = require('./helpers/fake-vscode');
const { captureSelection, classifyPath } = require('../src/attachments');
const { parse, render, safeUrl } = require('../src/markdown');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');
const { createDocument, elements } = require('./helpers/fake-dom');

const MARKER = 'SYNTHETIC_WP04_SOURCE_9c1';
const CODE = `function secretSauce(input) {\n  // ${MARKER}\n  return input * 42;\n}\n`;

const realFetch = globalThis.fetch;
const network = [];
test.before(() => { globalThis.fetch = async (target) => { network.push(String(target)); throw new Error('Network is blocked in this test file.'); }; });
test.after(() => { globalThis.fetch = realFetch; });
test.afterEach(() => {
  setWorkspaceFolders(undefined);
  setActiveEditor(undefined);
  config.reset();
  calls.warningChoice = 'Sign Out';
  calls.quickPick = undefined;
});

const folder = (name, parent = makeTempDir()) => { const target = path.join(parent, name); fs.mkdirSync(target, { recursive: true }); return target; };
const file = (target, text) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target; };
const historyFile = (dir) => path.join(dir, 'conversations.json');
const readHistory = (dir) => JSON.parse(fs.readFileSync(historyFile(dir), 'utf8'));
const editorOn = (filePath, { text = CODE, selection = [0, 0, 4, 0], languageId = 'javascript' } = {}) => createEditor(createTextDocument({ path: filePath, text, languageId }), [selection]);

// Every file under a folder, recursively, as text.
function allFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else out.push({ file: full, text: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

// One window; `behaviour.mode`: 'ok', 'fail', 'hang', 'echo' (the reply quotes the code).
async function openWindow(storageDir, shared) {
  const context = createContext({ storageDir, ...shared });
  const requests = [];
  const behaviour = { mode: 'ok' };
  // Reply texts unique to this window, so a payload check cannot match another window's reply.
  const windowTag = Math.random().toString(36).slice(2, 8);
  const auth = { getSession: async () => ({ email: 'synthetic.user@example.test' }), signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ messages, onDelta, signal }) {
      requests.push(messages.map((message) => message.content));
      if (behaviour.mode === 'fail') throw new Error('synthetic server failure');
      if (behaviour.mode === 'hang') {
        onDelta('partial');
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      onDelta(behaviour.mode === 'echo' ? `The code says: ${MARKER}` : `reply ${windowTag}-${requests.length}`);
    }
  };
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, openai, store, { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return {
    context, store, provider, view, requests, behaviour,
    attach: () => view.send({ type: 'attachSelection' }),
    approve: (reviewed) => view.send({ type: 'approveAttachment', id: provider.attachment?.snapshot.id, reviewed }),
    send: (text, attachmentId) => view.send({ type: 'send', text, model: 'model-a', attachmentId })
  };
}

async function projectWindow() {
  const storage = makeTempDir();
  const project = folder('alpha');
  const source = file(path.join(project, 'src', 'sauce.js'), CODE);
  setWorkspaceFolders([project]);
  const window = await openWindow(storage);
  setActiveTextEditor(editorOn(source));
  return { storage, project, source, window };
}

// ---------------------------------------------------------------------------
// T04-01 attachment persistence

test('T04-01 attached source is in no file, state store, log, notice or error after success, failure, stop, refusal and restart', async () => {
  const logged = [];
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { original[level] = console[level]; console[level] = (...args) => logged.push(args.map(String).join(' ')); }
  try {
    const { storage, window } = await projectWindow();
    // Success.
    await window.attach(); await window.approve(); await window.send('first', window.provider.attachment.snapshot.id);
    // Server failure after sending.
    await window.attach(); await window.approve(); window.behaviour.mode = 'fail'; await window.send('second', window.provider.attachment.snapshot.id);
    // Stop after sending.
    window.behaviour.mode = 'hang';
    await window.attach(); await window.approve();
    const sending = window.send('third', window.provider.attachment.snapshot.id);
    for (let index = 0; index < 100 && window.requests.length < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await window.view.send({ type: 'stop' });
    await sending;
    // Refused before sending (budget), then cancelled.
    window.behaviour.mode = 'ok';
    await window.attach(); await window.approve(); await window.send('q'.repeat(79_990), window.provider.attachment.snapshot.id);
    await window.view.send({ type: 'removeAttachment', id: window.provider.attachment.snapshot.id });
    // Restart.
    const restarted = await openWindow(storage, { stateValues: window.context.stateValues, secretValues: window.context.secretValues });
    assert.equal(restarted.provider.attachment, undefined);

    assert.equal(window.requests.filter((request) => request.join('\n').includes(MARKER)).length, 3, 'sent only in the three approved requests');
    const surfaces = [
      ...allFiles(storage).map((entry) => [entry.file, entry.text]),
      ['globalState', JSON.stringify([...window.context.stateValues])],
      ['secrets', JSON.stringify([...window.context.secretValues])],
      ['console', logged.join('\n')],
      ['notifications', JSON.stringify([calls.info, calls.warning, calls.error])],
      ['webview errors and notices', JSON.stringify(window.view.posted.filter((message) => message.type === 'error' || message.type === 'attachment').map((message) => message.message || message.notice))]
    ];
    for (const [where, text] of surfaces) assert.ok(!text.includes(MARKER), `source text found in ${where}`);
  } finally {
    Object.assign(console, original);
  }
});

test('T04-01 a reply that quotes the code is stored as a reply (the model\'s text), marked excluded; the attachment record still holds no code', async () => {
  const { storage, window } = await projectWindow();
  window.behaviour.mode = 'echo';
  await window.attach(); await window.approve(); await window.send('Explain', window.provider.attachment.snapshot.id);
  const messages = readHistory(storage).conversations.flatMap((item) => item.messages);
  const reply = messages.find((message) => message.attachmentTurn);
  assert.ok(reply.content.includes(MARKER), 'the reply text is kept, as every reply is');
  assert.equal(reply.contextPolicy, 'excluded');
  const user = messages.find((message) => message.attachments);
  assert.ok(!JSON.stringify(user).includes(MARKER), 'the user message and its attachment record hold no code');
  window.behaviour.mode = 'ok';
  await window.send('follow-up');
  assert.ok(!window.requests.at(-1).join('\n').includes(MARKER), 'the quoting reply is not sent with the follow-up');
});

// ---------------------------------------------------------------------------
// T04-02 approval and resending

test('T04-02 an approved attachment cannot be sent while another reply streams; it is kept, unsent, for later', async () => {
  const { window } = await projectWindow();
  window.behaviour.mode = 'hang';
  const streaming = window.send('a long question');
  for (let index = 0; index < 100 && window.requests.length < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await window.attach(); await window.approve();
  const id = window.provider.attachment.snapshot.id;
  await window.send('with code, during the stream', id);
  assert.equal(window.requests.length, 1, 'no second request');
  assert.equal(window.provider.attachment.snapshot.id, id, 'still pending');
  await window.view.send({ type: 'stop' });
  await streaming;
  window.behaviour.mode = 'ok';
  await window.send('now', id);
  assert.equal(window.requests.filter((request) => request.join('\n').includes(MARKER)).length, 1);
});

test('T04-02 a forged send message carrying its own code text is ignored: only the host\'s approved snapshot is sent', async () => {
  const { window } = await projectWindow();
  await window.attach(); await window.approve();
  await window.view.send({ type: 'send', text: 'Explain', model: 'model-a', attachmentId: window.provider.attachment.snapshot.id, attachment: { text: 'FORGED_CODE' }, code: 'FORGED_CODE', snapshot: { text: 'FORGED_CODE' } });
  const sent = window.requests.at(-1).join('\n');
  assert.ok(sent.includes(MARKER) && !sent.includes('FORGED_CODE'));
});

test('T04-02 the source file deleted after approval: the approved snapshot is what is sent, once; Refresh then refuses', async () => {
  const { source, window } = await projectWindow();
  await window.attach(); await window.approve();
  const id = window.provider.attachment.snapshot.id;
  fs.rmSync(source);
  setActiveTextEditor(undefined);
  await window.view.send({ type: 'refreshAttachment', id });
  assert.equal(window.provider.attachment.snapshot.id, id, 'Refresh cannot reach the document; the attachment is unchanged');
  await window.send('Explain', id);
  assert.equal(window.requests.length, 1);
  await window.send('again', id);
  assert.equal(window.requests.length, 1, 'the used id sends nothing');
});

// ---------------------------------------------------------------------------
// T04-03 follow-up context

test('T04-03 Include applies to one reply only; two windows and a restart see the same settings; payloads checked', async () => {
  const { storage, source, window } = await projectWindow();
  await window.attach(); await window.approve(); await window.send('first code', window.provider.attachment.snapshot.id);
  setActiveTextEditor(editorOn(source, { selection: [2, 0, 3, 1] }));
  await window.attach(); await window.approve(); await window.send('second code', window.provider.attachment.snapshot.id);
  const replies = readHistory(storage).conversations.flatMap((item) => item.messages).filter((message) => message.attachmentTurn);
  assert.equal(replies.length, 2);
  calls.warningChoice = 'Include in Follow-ups';
  await window.view.send({ type: 'setReplyContext', messageId: replies[0].id, include: true });

  // Another window on the same project, same chat.
  const other = await openWindow(storage);
  await other.send('from the other window');
  const payload = other.requests.at(-1);
  assert.ok(payload.includes(replies[0].content), 'the included reply is sent: ' + JSON.stringify({ payload, replies: replies.map((r) => r.content) }));
  assert.ok(!payload.includes(replies[1].content), 'the other reply stays out');
  assert.ok(!payload.join('\n').includes(MARKER), 'no attached code');

  // Stop including in that window; the first window's next request follows it.
  await other.view.send({ type: 'setReplyContext', messageId: replies[0].id, include: false });
  await window.send('after stop including');
  assert.ok(!window.requests.at(-1).includes(replies[0].content));

  // Restart keeps it.
  const restarted = await openWindow(storage);
  await restarted.send('after restart');
  assert.ok(!restarted.requests.at(-1).includes(replies[0].content) && !restarted.requests.at(-1).includes(replies[1].content));
});

// ---------------------------------------------------------------------------
// T04-04 prohibited files and boundaries

test('T04-04 blocked names: case and extension variants, nested credential folders', () => {
  for (const name of ['.ENV', '.Env.Local', '.env.PRODUCTION', 'ID_RSA', 'id_ed25519.PUB', 'Server.PEM', 'tls.Key', 'store.P12', 'Credentials', 'CREDENTIALS.JSON', 'Vault.KDBX', 'prod.TFSTATE', 'prod.tfstate.BACKUP', '.NPMRC', '_NETRC', '.Git-Credentials']) {
    assert.ok(classifyPath(path.join('C:\\proj', name)).blocked, name);
  }
  for (const dir of ['.SSH', '.Aws', '.AZURE', '.GnuPG', '.KUBE', '.Docker']) {
    assert.ok(classifyPath(path.join('C:\\proj', dir, 'notes.txt')).blocked, dir);
  }
  for (const name of ['.ENV.EXAMPLE', '.env.Sample']) assert.deepEqual(classifyPath(path.join('C:\\proj', name)), { envExample: true }, name);
});

test('T04-04 Windows aliases of a blocked file (trailing dot, 8.3 short name) are refused through the resolved path', async (t) => {
  const project = folder('alpha');
  const env = file(path.join(project, '.env'), 'NOT_A_REAL_KEY=synthetic\n');
  const context = { kind: 'project', key: 'k'.repeat(32), label: 'alpha' };
  const options = { maxChars: 12_000, folderPath: project };
  // "…\.env." names the same file on Windows.
  if (process.platform === 'win32') {
    // Refused as blocked, or as a path that cannot be resolved: never attached.
    await assert.rejects(captureSelection(editorOn(`${env}.`, { text: 'NOT_A_REAL_KEY=synthetic\n', selection: [0, 0, 1, 0] }), context, options), (error) => ['blocked', 'unresolved'].includes(error.code));
  }
  // 8.3 short name, where the volume has them.
  const credentials = file(path.join(project, 'credentials.json'), '{}\n');
  let short;
  try {
    short = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:PLAN_CHAT_TARGET).ShortPath'], { encoding: 'utf8', env: { ...process.env, PLAN_CHAT_TARGET: credentials } }).trim();
  } catch {
    short = undefined;
  }
  if (!short || short.toLowerCase() === credentials.toLowerCase()) {
    t.diagnostic('8.3 short names are not available on this volume');
    return;
  }
  await assert.rejects(captureSelection(editorOn(short, { text: '{}\n', selection: [0, 0, 1, 0] }), context, options), { code: 'blocked' }, short);
});

// R-27 and R-29: two physically distinct folders must be two projects. The
// earlier scheme hashed the lower-cased, NFC path, so folders whose names
// differ only in Unicode composition (R-27) or that JavaScript lower-casing
// joins (R-29) shared a key. The authentic earlier implementation is the
// release baseline (backups/release-baseline-2026-10-28, hash-verified in
// WP-00); the legacy histories below are written by running it.

const cp = String.fromCodePoint;
// The confirmed pairs (docs/release-evidence/WP-04/fs-identity-probe-*.txt).
const PAIRS = [
  ['composition: Café NFC / NFD', `Caf${cp(0xE9)}`, `Cafe${cp(0x301)}`],
  ['Kelvin sign / k', cp(0x212A), 'k'],
  ['Ohm sign / omega', cp(0x2126), cp(0x3C9)],
  ['Angstrom sign / a-ring', cp(0x212B), cp(0xE5)],
  ['I with dot / i + combining dot', cp(0x130), `i${cp(0x307)}`],
  ['x capital sigma / x final sigma', `x${cp(0x3A3)}`, `x${cp(0x3C2)}`]
];
const BASELINE = path.join(__dirname, '..', 'backups', 'release-baseline-2026-10-28', 'src');
const baselineProject = HISTORICAL_SKIP ? null : require(path.join(BASELINE, 'project'));
const { ConversationStore: BaselineStore } = HISTORICAL_SKIP ? {} : require(path.join(BASELINE, 'store'));
const { ChatViewProvider: BaselineView } = HISTORICAL_SKIP ? {} : require(path.join(BASELINE, 'view'));
const { folderIdentityInput, projectKey, tagFor } = require('../src/project');
const { isInside } = require('../src/attachments');
const { IDENTITY_SCHEME, sectionOf } = require('../src/store');

// Two folders side by side, or two parent folders each holding "app".
function pairFolders(a, b, { level = 'leaf' } = {}) {
  const parent = makeTempDir();
  const one = folder(a, parent);
  const two = folder(b, parent);
  assert.equal(fs.readdirSync(parent).length, 2, `two physical folders: ${a} / ${b}`);
  return level === 'leaf' ? [one, two] : [folder('app', one), folder('app', two)];
}

// One window of the authentic earlier implementation.
async function openBaselineWindow(storageDir) {
  const context = createContext({ storageDir });
  const auth = { getSession: async () => ({ email: 'synthetic.user@example.test' }), signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const openai = { listModels: async () => [{ id: 'model-a', name: 'Model A' }], async streamResponse({ onDelta }) { onDelta('baseline reply'); } };
  const provider = new BaselineView(context, auth, openai, new BaselineStore(context), { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return { send: (text) => view.send({ type: 'send', text, model: 'model-a' }), provider };
}

// A history written by the earlier implementation: one chat per folder, each
// with a private marker, plus unknown fields that must survive.
async function baselineHistory(folders) {
  const storage = makeTempDir();
  const ids = [];
  for (const [index, target] of folders.entries()) {
    setWorkspaceFolders([target]);
    const old = await openBaselineWindow(storage);
    await old.provider.store.newConversation?.();
    await old.send(`LEGACY-PRIVATE-${index}`);
    ids.push((await old.provider.store.getCurrent()).id);
  }
  const history = readHistory(storage);
  for (const item of history.conversations) { item.futureChatField = 'kept'; item.messages[0].futureMessageField = 'kept'; }
  fs.writeFileSync(historyFile(storage), JSON.stringify(history));
  const tags = ids.map((id) => history.conversations.find((item) => item.id === id).context);
  return { storage, ids, tags };
}

const sectionIn = async (window, id) => sectionOf((await window.store.getConversation(id)), window.provider.windowContext);
const listedAsThis = async (window, id) => (await window.store.listConversations()).items.some((item) => item.id === id && item.section === 'this');
const sentAny = (window, pattern) => window.requests.some((request) => request.some((content) => pattern.test(content)));

test('T04-04 R-27/R-29 every confirmed pair is two physical folders and gets two keys, at leaf and parent level; spellings, case aliases and junctions of one folder keep one key', async () => {
  const key = 'a'.repeat(64);
  const keyOf = async (target) => projectKey(key, (await folderIdentityInput(target)).input);
  for (const [name, a, b] of PAIRS) {
    for (const level of ['leaf', 'parent']) {
      const [one, two] = pairFolders(a, b, { level });
      assert.notEqual(await keyOf(one), await keyOf(two), `${name} (${level})`);
      for (const target of [one, two]) {
        const link = path.join(makeTempDir(), 'link');
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        for (const variant of [target.toUpperCase(), target.toLowerCase(), `${target}${path.sep}`, link, link.toUpperCase()]) {
          // A case alias of one folder names that folder only if the file system says so.
          if (fs.existsSync(variant) && fs.statSync(variant, { bigint: true }).ino === fs.statSync(target, { bigint: true }).ino) {
            assert.equal(await keyOf(variant), await keyOf(target), `${name} (${level}) ${JSON.stringify(variant)}`);
          } else {
            assert.notEqual(await keyOf(variant), await keyOf(target), `${name} (${level}) ${JSON.stringify(variant)} names another folder or none`);
          }
        }
      }
    }
  }
});

test('T04-04 R-27/R-29 fresh history: two windows on each pair (leaf and parent) list, open and send only their own chats, across a restart', async () => {
  for (const [name, a, b] of PAIRS) {
    for (const level of ['leaf', 'parent']) {
      const [one, two] = pairFolders(a, b, { level });
      const storage = makeTempDir();
      setWorkspaceFolders([one]);
      const first = await openWindow(storage);
      await first.send('PRIVATE-ONE');
      const chatOne = (await first.store.getCurrent()).id;
      setWorkspaceFolders([two]);
      const second = await openWindow(storage);
      await second.send('PRIVATE-TWO');
      const chatTwo = (await second.store.getCurrent()).id;
      const label = `${name} (${level})`;
      assert.notEqual(chatOne, chatTwo, label);
      assert.ok(!(await listedAsThis(second, chatOne)) && !(await listedAsThis(first, chatTwo)), label);
      await assert.rejects(second.store.selectConversation(chatOne), /another project/, label);
      await assert.rejects(second.store.contextMessages(chatOne), /another project/, label);
      // Both windows keep writing; neither request carries the other folder's text.
      await first.send('more one'); await second.send('more two');
      assert.ok(!sentAny(second, /PRIVATE-ONE/) && !sentAny(first, /PRIVATE-TWO/), label);
      // Restart.
      setWorkspaceFolders([one]);
      const again = await openWindow(storage);
      assert.equal((await again.store.getCurrent()).id, chatOne, label);
      await again.send('after restart');
      assert.ok(!sentAny(again, /PRIVATE-TWO/), label);
      for (const item of readHistory(storage).conversations) assert.equal(item.context.scheme, IDENTITY_SCHEME, `${label}: new tags carry the scheme`);
    }
  }
});

test('T04-04 R-27/R-29 histories written by the earlier implementation: no earlier project chat is opened, continued or sent automatically, for twins at leaf and parent level', { skip: HISTORICAL_SKIP }, async () => {
  for (const [name, a, b] of [PAIRS[0], PAIRS[1], PAIRS[5]]) {
    for (const level of ['leaf', 'parent']) {
      const label = `${name} (${level})`;
      const [one, two] = pairFolders(a, b, { level });
      const { storage, ids, tags } = await baselineHistory([one, two]);
      for (const tag of tags) assert.ok(tag?.kind === 'project' && typeof tag.key === 'string' && tag.key.length === 32, `${label}: precondition, a project tag from the earlier implementation`);
      assert.equal(tags[0].key, tags[1].key, `${label}: precondition, the earlier scheme gave both folders one key`);
      assert.equal(tags[0].scheme, undefined);
      const before = fs.readFileSync(historyFile(storage), 'utf8');
      for (const target of [one, two]) {
        setWorkspaceFolders([target]);
        const window = await openWindow(storage);
        for (const id of ids) {
          assert.ok(!(await listedAsThis(window, id)), `${label}: ${id} not this project's`);
          assert.equal(await sectionIn(window, id), 'earlier-key', `${label}: offered for an explicit Relink only`);
          await assert.rejects(window.store.selectConversation(id), /another project/);
          await assert.rejects(window.store.contextMessages(id), /another project/);
        }
        assert.notEqual((await window.store.getCurrent()).id, ids[0]);
        assert.notEqual((await window.store.getCurrent()).id, ids[1]);
        await window.send('a new question');
        assert.ok(!sentAny(window, /LEGACY-PRIVATE/), `${label}: nothing earlier is sent`);
      }
      // Opening windows rewrote no earlier chat.
      const after = readHistory(storage);
      for (const item of JSON.parse(before).conversations) assert.deepEqual(after.conversations.find((other) => other.id === item.id), item, `${label}: ${item.id} unchanged`);
    }
  }
});

test('T04-04 R-27/R-29 explicit Relink recovers an earlier chat: ids, messages and unknown fields kept; it then belongs to that folder only', { skip: HISTORICAL_SKIP }, async () => {
  const [one, two] = pairFolders(cp(0x212A), 'k');
  const { storage, ids } = await baselineHistory([one, two]);
  setWorkspaceFolders([two]);
  const window = await openWindow(storage);
  const before = readHistory(storage).conversations.find((item) => item.id === ids[1]);
  await window.provider.openReadOnly(ids[1]);
  assert.equal(window.provider.readOnly?.id, ids[1], 'shown read-only');
  assert.equal(window.view.posted.filter((message) => message.type === 'conversation').at(-1).readOnly.action.label, 'Relink to this project');
  await window.provider.moveReadOnlyHere();
  const after = readHistory(storage).conversations.find((item) => item.id === ids[1]);
  assert.equal(after.id, before.id);
  assert.deepEqual(after.messages, before.messages, 'messages and their unknown fields kept');
  assert.equal(after.futureChatField, 'kept');
  assert.equal(after.context.scheme, IDENTITY_SCHEME);
  assert.ok(await listedAsThis(window, ids[1]));
  await window.send('continue after relink');
  assert.ok(sentAny(window, /LEGACY-PRIVATE-1/) && !sentAny(window, /LEGACY-PRIVATE-0/));
  // The twin folder does not see it, and its own earlier chat is still only offered.
  setWorkspaceFolders([one]);
  const twin = await openWindow(storage);
  assert.ok(!(await listedAsThis(twin, ids[1])));
  assert.equal(await sectionIn(twin, ids[0]), 'earlier-key');
});

test('T04-04 R-27/R-29 an ordinary folder\'s earlier chats are recognized as its own and offered for Relink; never sent before it', { skip: HISTORICAL_SKIP }, async () => {
  const project = folder('alpha-ordinary');
  const { storage, ids } = await baselineHistory([project]);
  setWorkspaceFolders([project]);
  const window = await openWindow(storage);
  assert.equal(await sectionIn(window, ids[0]), 'earlier-key');
  await window.send('new');
  assert.ok(!sentAny(window, /LEGACY-PRIVATE/));
  await window.store.moveConversation(ids[0], tagFor(window.provider.windowContext));
  assert.ok(await listedAsThis(window, ids[0]));
});

test('T04-04 R-27/R-29 missing or inconsistent identity markers fail closed', async () => {
  const project = folder('beta');
  const storage = makeTempDir();
  setWorkspaceFolders([project]);
  const window = await openWindow(storage);
  const context = window.provider.windowContext;
  const good = tagFor(context);
  const cases = {
    'later scheme': [{ ...good, scheme: 3 }, 'unknown'],
    'scheme as text': [{ ...good, scheme: '2' }, 'unknown'],
    'scheme null': [{ ...good, scheme: null }, 'unknown'],
    'no key': [{ kind: 'project', keyId: good.keyId, label: 'beta', scheme: IDENTITY_SCHEME }, 'unknown'],
    'no keyId': [{ ...good, keyId: undefined }, 'earlier-key'],
    'current key, no scheme': [{ kind: 'project', key: good.key, keyId: good.keyId, label: 'beta' }, 'other-project'],
    'another folder': [{ ...good, key: 'f'.repeat(32) }, 'other-project']
  };
  for (const [name, [tag, section]] of Object.entries(cases)) {
    assert.equal(sectionOf({ context: tag }, context), section, name);
  }
  assert.equal(sectionOf({ context: good }, context), 'this');
});

test('T04-04 R-27/R-29 a folder that cannot be resolved has no verified identity: it never matches the resolved folder, takes no Move or Relink, attaches nothing', async () => {
  const parent = makeTempDir();
  const project = folder('gamma', parent);
  const storage = makeTempDir();
  setWorkspaceFolders([project]);
  const live = await openWindow(storage);
  await live.send('GAMMA-PRIVATE');
  const chat = (await live.store.getCurrent()).id;
  fs.renameSync(project, path.join(parent, 'gamma-moved'));
  const offline = await openWindow(storage);
  assert.equal(offline.provider.windowContext.available, false);
  assert.notEqual(offline.provider.windowContext.key, live.provider.windowContext.key);
  assert.equal(offline.provider.windowContext.legacyKey, undefined);
  assert.ok(!(await listedAsThis(offline, chat)));
  await offline.provider.openReadOnly(chat);
  const shown = offline.view.posted.filter((message) => message.type === 'conversation').at(-1);
  assert.equal(shown.readOnly.action, undefined, 'no Move or Relink into an unresolved folder');
  await offline.provider.moveReadOnlyHere();
  assert.notEqual(readHistory(storage).conversations.find((item) => item.id === chat).context.key, offline.provider.windowContext.key);
  await offline.send('offline question');
  assert.ok(!sentAny(offline, /GAMMA-PRIVATE/));
  await assert.rejects(captureSelection(editorOn(path.join(project, 'src', 'x.js')), offline.provider.windowContext, { maxChars: 12_000, folderPath: offline.provider.windowContext.folderPath }), { code: 'unresolved' });
});

test('T04-04 R-27/R-29 Attach Selection: a file in the other folder of every pair is outside this project', async () => {
  for (const [name, a, b] of PAIRS) {
    for (const level of ['leaf', 'parent']) {
      const [one, two] = pairFolders(a, b, { level });
      const context = { kind: 'project', key: 'k'.repeat(32), label: path.basename(one) };
      const options = { maxChars: 12_000, folderPath: one };
      const own = file(path.join(one, 'src', 'x.js'), CODE);
      const other = file(path.join(two, 'src', 'x.js'), CODE);
      await assert.rejects(captureSelection(editorOn(other), context, options), { code: 'outside' }, `${name} (${level})`);
      assert.equal((await captureSelection(editorOn(own), context, options)).source.displayPath, 'src/x.js', `${name} (${level})`);
      assert.equal(isInside(fs.realpathSync.native(other), fs.realpathSync.native(one)), false);
    }
  }
});

test('T04-04 R-27/R-29 a chat moved away by another window after a message was added is not sent by this window', async () => {
  const project = folder('delta');
  const storage = makeTempDir();
  setWorkspaceFolders([project]);
  const window = await openWindow(storage);
  await window.send('DELTA-PRIVATE');
  const chat = (await window.store.getCurrent()).id;
  // Another process moves the chat to General between this window's steps.
  const other = new ConversationStore(createContext({ storageDir: storage }));
  await other.moveConversation(chat, { kind: 'general' });
  await assert.rejects(window.store.contextMessages(chat), /another project/);
});

// ---------------------------------------------------------------------------
// T04-05 Markdown and links (additions to test/markdown.test.js)

const doc = createDocument();
const tree = (text) => { const root = doc.createElement('div'); root.append(render(doc, text)); return root; };
const links = (root) => elements(root).filter((element) => element.localName === 'a').map((element) => element.getAttribute('href'));

test('T04-05 encoded and disguised script links never become links', () => {
  const corpus = [
    '[x](&#106;avascript:alert(1))',
    '[x](&#x6A;avascript:alert(1))',
    '[x](%6Aavascript:alert(1))',
    '[x](javascript%3Aalert(1))',
    '[x](javascript\uFF1Aalert(1))',
    '[x](java\nscript:alert(1))',
    '[x](\u200Bjavascript:alert(1))',
    '[x](JAVASCRIPT:alert(1))',
    '[x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
    '[x](blob:https://ok.test/123)',
    '[x](ftp://ok.test/file)',
    '[x](mailto:someone@example.test)',
    '[x](http:/\\evil.test)',
    '[x](https:evil.test)'
  ];
  for (const input of corpus) {
    const hrefs = links(tree(input));
    for (const href of hrefs) {
      assert.match(href, /^https?:\/\//, `${input} → ${href}`);
      assert.equal(safeUrl(href), href, input);
    }
  }
});

test('T04-05 raw HTML inside Arabic and mixed-direction text stays text; bidi overrides cannot change an address', () => {
  const input = 'مرحبا <img src=x onerror=alert(1)> و <a href="javascript:alert(1)">رابط</a> \u202Eتجربة\u202C [موقع](https://ok.test/\u202Eexe.txt)';
  const root = tree(input);
  assert.ok(!elements(root).some((element) => ['img', 'script', 'iframe'].includes(element.localName)));
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'), 'shown as text');
  for (const href of links(root)) assert.equal(safeUrl(href), href);
  // An address with a bidi control is never used raw: the control is percent-encoded.
  const encoded = safeUrl('https://ok.test/\u202Eexe.txt');
  assert.ok(encoded === undefined || (!encoded.includes('\u202E') && encoded.includes('%E2%80%AE')), encoded);
});

test('T04-05 a 5 MB message is bounded: shown without Markdown parsing, in bounded time', () => {
  const huge = `${'**bold** [x](https://ok.test/) '.repeat(180000)}`;
  assert.ok(huge.length > 5_000_000);
  const started = Date.now();
  const root = tree(huge);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.equal(elements(root).some((element) => element.localName === 'a' || element.localName === 'strong'), false);
  assert.equal(typeof parse, 'function');
});

test('T04-05 the webview Content Security Policy allows no remote script, style, frame, connection or image', () => {
  const { getWebviewHtml } = require('../src/view');
  const html = getWebviewHtml({ cspSource: 'vscode-resource:' });
  const csp = /content="(default-src[^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(csp, /style-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(csp, /img-src vscode-resource: data:/);
  assert.match(csp, /font-src 'none'/);
  assert.doesNotMatch(csp, /https?:|unsafe-inline|unsafe-eval|\*/);
  assert.equal((html.match(/<script nonce=/g) || []).length, 2);
  assert.doesNotMatch(html, /<script(?! nonce=)/);
});

// ---------------------------------------------------------------------------
// T04-07 test isolation guards (fail closed)

test('T04-07 the real-editor harness refuses the real editor profiles and any folder outside the temp folder, before launching', () => {
  const { assertIsolatedProfile, launch } = require('./integration/lib/editor-driver');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const refused = [
    path.join(appData, 'Code'),
    path.join(appData, 'Antigravity IDE'),
    path.join(appData, 'Antigravity'),
    path.join(appData, 'Code - Insiders', 'User'),
    os.homedir(),
    path.join(os.homedir(), 'Documents', 'profile')
  ];
  for (const userData of refused) {
    assert.throws(() => assertIsolatedProfile(userData), /not an isolated throwaway profile/, userData);
    assert.throws(() => launch('C:\\does-not-exist.exe', { developmentPaths: [], userData, sandbox: os.tmpdir() }), /not an isolated throwaway profile/, `launch refused for ${userData}`);
  }
  assert.equal(assertIsolatedProfile(path.join(os.tmpdir(), 'plan-chat-x', 'user-data')), true);
});

test('T04-07 no network request was attempted by any test in this file', () => {
  assert.deepEqual(network, []);
});
