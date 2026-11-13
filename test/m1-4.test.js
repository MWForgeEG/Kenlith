'use strict';

// M1-4: project context in the real view. Retrieval, the consent card, the
// gate and the request builder together, with synthetic projects and a stub
// model service that behaves like the real transport (it runs the preflight
// gate, then "sends"). Every negative case checks what was actually sent.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, createWebviewView, makeTempDir, setWorkspaceFolders, vscode } = require('./helpers/fake-vscode');
const { ConsentStore, accountRefFor } = require('../src/consent');
const { isBuiltRequest } = require('../src/request-builder');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('Network is blocked in this test file.'); }; });
test.after(() => { globalThis.fetch = realFetch; });
test.afterEach(() => {
  setWorkspaceFolders(undefined);
  config.reset();
  vscode.workspace.isTrusted = true;
  calls.warningChoice = 'Sign Out';
  calls.quickPick = undefined;
});

const SECRET = 'AK' + 'IAABCDEFGHIJKLMNOP';
function projectFolder(name = 'calc') {
  const directory = path.join(makeTempDir(), name);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('src/calculator.js', 'function addAll(list) {\n  // sums every number in the list\n  return list.reduce((sum, value) => sum + value);\n}\nmodule.exports = { addAll };\n');
  write('src/other.js', 'module.exports = 1;\n');
  write('.env', `API_KEY=${SECRET}\n`);
  write('src/keys.js', `const key = '${SECRET}'; // addAll credentials\n`);
  return directory;
}

// One window. `session.subject` is the account; the stub transport records
// what would go out and runs `preflight` exactly where the real one does.
async function openWindow({ storageDir = makeTempDir(), subject = 'user-1', behaviour = {} } = {}) {
  const context = createContext({ storageDir });
  const session = { email: 'synthetic.user@example.test', subject, scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const sent = [];
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ request, onDelta, signal, preflight }) {
      assert.ok(isBuiltRequest(request), 'only built requests reach the transport');
      if (behaviour.beforePreflight) await behaviour.beforePreflight();
      if (preflight) await preflight();
      sent.push({ instructions: request.instructions, messages: request.messages.map((m) => ({ ...m })) });
      if (behaviour.hang) {
        onDelta('partial ');
        behaviour.started?.();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      onDelta(`reply ${sent.length}`);
    }
  };
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, openai, store, { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  const posted = (type) => view.posted.filter((message) => message.type === type);
  return {
    context, session, store, provider, view, sent, posted,
    send: (text) => view.send({ type: 'send', text, model: 'model-a' }),
    decide: (choice) => view.send({ type: 'consentDecision', choice }),
    card: () => posted('consent').at(-1)?.consent,
    notes: () => posted('contextNote').map((m) => m.text).filter(Boolean)
  };
}
const body = (request) => [request.instructions, ...request.messages.map((m) => m.content)].join('\n');
const historyFile = (w) => fs.readFileSync(path.join(w.context.storageDir, 'conversations.json'), 'utf8');

test('M1-4 a. first project question: retrieval finds files, nothing is sent or stored until the user decides', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  const before = (await w.store.getCurrent()).messages.length;
  await w.send('Why does addAll fail on an empty list?');
  assert.equal(w.sent.length, 0, 'no request while consent is pending');
  assert.equal((await w.store.getCurrent()).messages.length, before, 'nothing stored');
  const card = w.card();
  assert.equal(card.label, 'calc');
  assert.equal(card.provider, 'OpenAI');
  assert.equal(card.account, 'synthetic.user@example.test');
  assert.ok(card.excerpts.some((e) => e.relPath === 'src/calculator.js'));
  assert.ok(card.excerpts.every((e) => !e.text.includes(SECRET)), 'credential files are not offered');
  assert.ok(card.withheld >= 1, 'withheld files are counted');
  assert.equal(w.posted('restoreDraft').length, 0, 'the question waits in the card');
});

test('M1-4 b. Allow sends the original question once, with labelled excerpts; only metadata is stored', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  assert.equal(w.sent.length, 1);
  const turn = w.sent[0].messages.at(-1).content;
  assert.ok(turn.startsWith('Why does addAll fail on an empty list?\n\n[Project context:'));
  assert.match(turn, /File: src\/calculator\.js \(lines \d+-\d+\)/);
  assert.doesNotMatch(body(w.sent[0]), new RegExp(SECRET), 'no credential content');
  assert.doesNotMatch(body(w.sent[0]), /API_KEY/, 'no .env content');
  const history = historyFile(w);
  assert.doesNotMatch(history, /sums every number in the list/, 'excerpt text never stored');
  const [user, reply] = JSON.parse(history).conversations[0].messages.slice(-2);
  assert.equal(user.content, 'Why does addAll fail on an empty list?');
  assert.ok(user.contextUsed.some((entry) => entry.relPath === 'src/calculator.js'));
  assert.equal(reply.provenance, 'project-derived');
  assert.equal(reply.contextPolicy, 'excluded');
  // Consent is user-level, never in the project.
  assert.ok(fs.existsSync(path.join(w.context.storageDir, 'consents.json')));
  assert.deepEqual(fs.readdirSync(directory).sort(), ['.env', 'src']);
});

test('M1-4 c. later questions use the grant automatically; earlier project answers go with them', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  await w.send('And how would you fix addAll?');
  assert.equal(w.sent.length, 2, 'no second card');
  assert.ok(w.sent[1].messages.some((m) => m.role === 'assistant' && m.content === 'reply 1'), 'the earlier project-derived reply is re-sent under the same grant');
  assert.match(w.sent[1].messages.at(-1).content, /\[Project context:/);
});

test('M1-4 d. Send without project files: text only, an honest instruction, a labelled reply, no consent written', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail?');
  await w.decide('without');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].messages.at(-1).content, 'Why does addAll fail?');
  assert.match(w.sent[0].instructions, /No files from the user's project were provided/);
  assert.doesNotMatch(body(w.sent[0]), /calculator|\[Project context/);
  assert.equal(JSON.parse(historyFile(w)).conversations[0].messages.at(-1).withoutProjectFiles, true);
  const record = await new ConsentStore(w.context.storageDir).list();
  assert.equal(record.filter((r) => r.state === 'active').length, 0);
});

test('M1-4 e. Cancel sends nothing and gives the text back; a question with no relevant files never asks', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail?');
  await w.decide('cancel');
  assert.equal(w.sent.length, 0);
  assert.equal(w.posted('restoreDraft').at(-1).text, 'Why does addAll fail?');
  assert.equal(w.posted('consent').at(-1).consent, null);
  await w.send('Tell me a haiku about autumn rain');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].messages.at(-1).content, 'Tell me a haiku about autumn rain');
  assert.equal(w.posted('consent').filter((m) => m.consent).length, 1, 'no card for the unrelated question');
});

test('M1-4 f. after revoke and re-grant, earlier project answers stay out of requests (DEC-PLANCHAT-012)', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  // Another window stops sharing.
  const other = new ConsentStore(w.context.storageDir);
  const [record] = await other.list();
  await other.revoke({ projectKey: record.projectKey, provider: record.provider, accountRef: record.accountRef }, 'user');
  await w.send('How would you fix addAll?');
  assert.equal(w.sent.length, 1, 'revoked: the card again, nothing sent');
  assert.ok(w.card());
  await w.decide('allow');
  assert.equal(w.sent.length, 2);
  assert.ok(!w.sent[1].messages.some((m) => m.content === 'reply 1'), 'the reply made under the revoked grant is not re-sent');
  assert.ok(w.notes().some((text) => /1 earlier answer that used project files was not re-sent/.test(text)));
});

test('M1-4 g. General chats, untrusted workspaces and the user setting never read or share project files', async () => {
  // General: no folder.
  setWorkspaceFolders(undefined);
  const general = await openWindow();
  await general.send('Why does addAll fail?');
  assert.equal(general.sent.length, 1);
  assert.equal(general.posted('consent').length, 0);
  assert.doesNotMatch(body(general.sent[0]), /\[Project context/);

  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  vscode.workspace.isTrusted = false;
  const untrusted = await openWindow();
  await untrusted.send('Why does addAll fail?');
  assert.equal(untrusted.posted('consent').length, 0);
  assert.doesNotMatch(body(untrusted.sent[0]), /\[Project context|calculator/);
  vscode.workspace.isTrusted = true;

  // Turned off in user settings; a workspace cannot turn it back on.
  config.enforceScopes = true;
  config.layers.global['planChat.projectContext.enabled'] = false;
  config.layers.workspace['planChat.projectContext.enabled'] = true;
  const off = await openWindow();
  await off.send('Why does addAll fail?');
  assert.equal(off.posted('consent').length, 0);
  assert.doesNotMatch(body(off.sent[0]), /\[Project context|calculator/);
});

test('M1-4 h. a workspace setting can add exclusions but cannot re-include a blocked file', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  config.layers.workspace['files.exclude'] = { '**/.env': false, 'src/calculator.js': true };
  config.layers.workspace['search.exclude'] = { '**/.env': false };
  // A second matching file, so a card is shown and its contents can be checked.
  fs.writeFileSync(path.join(directory, 'src', 'sum-notes.js'), '// addAll notes: an empty list has no first value\n');
  const w = await openWindow();
  await w.send('Why does addAll fail? Check .env and keys too');
  const card = w.card();
  assert.ok(card, 'a card for the remaining matching file');
  assert.ok(card.excerpts.some((e) => e.relPath === 'src/sum-notes.js'));
  assert.ok(card.excerpts.every((e) => e.relPath !== 'src/calculator.js' && e.relPath !== '.env' && !e.text.includes(SECRET)));
});

test('M1-4 i. another account is a different grant: an approval made for the first account is not used', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow({ subject: 'user-1' });
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  assert.equal(w.sent.length, 1);
  w.session.subject = 'user-2';
  w.session.email = 'second@example.test';
  await w.send('How would you fix addAll?');
  assert.equal(w.sent.length, 1, 'nothing sent for the second account');
  assert.equal(w.card().account, 'second@example.test');
});

test('M1-4 j. the gate runs just before sending: a revoke at that moment sends nothing and is recorded', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const behaviour = {};
  const w = await openWindow({ behaviour });
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  behaviour.beforePreflight = async () => {
    const other = new ConsentStore(w.context.storageDir);
    const [record] = await other.list();
    await other.revoke({ projectKey: record.projectKey, provider: record.provider, accountRef: record.accountRef }, 'user');
  };
  await w.send('How would you fix addAll?');
  assert.equal(w.sent.length, 1, 'the second request never went out');
  const messages = JSON.parse(historyFile(w)).conversations[0].messages;
  const user = messages.filter((m) => m.role === 'user').at(-1);
  assert.equal(user.projectNotSent, true);
  assert.match(messages.at(-1).content, /Project sharing changed just before sending.*Nothing was sent/);
});

test('M1-4 k. a file edited after it was read is not sent: the gate sees the change', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const behaviour = {};
  const w = await openWindow({ behaviour });
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  behaviour.beforePreflight = async () => {
    fs.appendFileSync(path.join(directory, 'src', 'calculator.js'), '// edited while sending\n');
  };
  await w.send('Explain addAll again');
  assert.equal(w.sent.length, 1);
  assert.match(JSON.parse(historyFile(w)).conversations[0].messages.at(-1).content, /sources-changed/);
});

test('M1-4 l. a revoke in another window stops a reply that is streaming with project context', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const behaviour = { hang: true, started };
  const w = await openWindow({ behaviour });
  await w.send('Why does addAll fail on an empty list?');
  const deciding = w.decide('allow');
  await running;
  const other = new ConsentStore(w.context.storageDir);
  const [record] = await other.list();
  await other.revoke({ projectKey: record.projectKey, provider: record.provider, accountRef: record.accountRef }, 'user');
  await Promise.race([deciding, new Promise((resolve, reject) => setTimeout(() => reject(new Error('the stream was not stopped within 6 s')), 6000))]);
  assert.ok(w.notes().some((text) => /Project sharing was stopped during this reply\. What was already sent cannot be recalled\./.test(text)));
  other.dispose();
});

test('M1-4 m. switching chats or starting a new chat drops a waiting question and gives the text back', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail?');
  assert.ok(w.card());
  await w.provider.newChat();
  assert.equal(w.posted('consent').at(-1).consent, null);
  assert.equal(w.posted('restoreDraft').at(-1).text, 'Why does addAll fail?');
  await w.decide('allow');
  assert.equal(w.sent.length, 0, 'a late Allow for a dropped question does nothing');
});

test('M1-4 n. Manage Project Sharing lists this project and stops sharing after confirmation', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  let shown;
  calls.quickPick = (items) => { shown = items; return items[0]; };
  calls.warningChoice = 'Stop Sharing';
  await w.provider.manageProjectSharing();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].label, 'calc');
  assert.match(shown[0].description, /this ChatGPT account/);
  assert.match(calls.warning.at(-1), /Stop sharing calc with OpenAI\?/);
  const records = await new ConsentStore(w.context.storageDir).list();
  assert.equal(records[0].state, 'revoked');
  await w.send('How would you fix addAll?');
  assert.equal(w.sent.length, 1, 'asks again after stopping');
  assert.ok(w.card());
});

test('M1-4 o. the consent record never holds the raw account id or email', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow({ subject: 'user-raw-subject-123' });
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  const raw = fs.readFileSync(path.join(w.context.storageDir, 'consents.json'), 'utf8');
  assert.doesNotMatch(raw, /user-raw-subject-123|synthetic\.user@example\.test/);
  assert.equal(typeof accountRefFor, 'function');
});
