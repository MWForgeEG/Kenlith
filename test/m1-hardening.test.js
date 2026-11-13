'use strict';

// WP-09: regression tests for the findings of the independent security
// review of M1 (one high, five medium, and the low findings fixed). Same
// setup as test/m1-4.test.js: the real view with a stub transport that runs
// the gate where the real one does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, createEditor, createTextDocument, createWebviewView, makeTempDir, setActiveEditor, setActiveTextEditor, setWorkspaceFolders, vscode } = require('./helpers/fake-vscode');
const { ConsentStore } = require('../src/consent');
const { OpenAIService } = require('../src/openai');
const { mayReplay } = require('../src/provenance');
const { buildRequest, isBuiltRequest } = require('../src/request-builder');
const { tokenize } = require('../src/retrieval');
const { userProjectContextEnabled } = require('../src/settings');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('Network is blocked in this test file.'); }; });
test.after(() => { globalThis.fetch = realFetch; });
test.afterEach(() => {
  setActiveEditor(undefined);
  setActiveTextEditor(undefined);
  setWorkspaceFolders(undefined);
  config.reset();
  vscode.workspace.isTrusted = true;
  calls.warningChoice = 'Sign Out';
  calls.quickPick = undefined;
});

function projectFolder(name = 'calc') {
  const directory = path.join(makeTempDir(), name);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('src/calculator.js', 'function addAll(list) {\n  // sums every number in the list\n  return list.reduce((sum, value) => sum + value);\n}\nmodule.exports = { addAll };\n');
  return directory;
}

async function openWindow({ subject = 'user-1', behaviour = {} } = {}) {
  const context = createContext({ storageDir: makeTempDir() });
  const session = { email: 'synthetic.user@example.test', subject, scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const sent = [];
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ request, onDelta, signal, preflight }) {
      assert.ok(isBuiltRequest(request));
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
    notes: () => posted('contextNote').map((m) => m.text).filter(Boolean),
    history: () => JSON.parse(fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8')).conversations[0].messages
  };
}
const revokeAll = async (storageDir) => {
  const other = new ConsentStore(storageDir);
  for (const record of await other.list()) await other.revoke({ projectKey: record.projectKey, provider: record.provider, accountRef: record.accountRef }, 'user');
};

test('WP-09 H1. a reply to attached code that replays project answers is project-derived and cannot be included separately', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  // An approved attachment turn in the same chat, while the earlier project answer is replayed.
  const conversationId = (await w.store.getCurrent()).id;
  const filePath = path.join(directory, 'src', 'calculator.js');
  const document = createTextDocument({ path: filePath, text: fs.readFileSync(filePath, 'utf8'), languageId: 'javascript' });
  setActiveTextEditor(createEditor(document, [[0, 0, 2, 0]]));
  await w.view.send({ type: 'attachSelection' });
  await w.view.send({ type: 'approveAttachment', id: w.provider.attachment.snapshot.id, reviewed: true });
  await w.view.send({ type: 'send', text: 'what about this code', model: 'model-a', attachmentId: w.provider.attachment.snapshot.id });
  setActiveEditor(undefined);
  const reply = w.history().at(-1);
  assert.equal(w.sent.length, 2, 'the attachment turn was sent');
  assert.equal(reply.attachmentReply, true);
  assert.equal(reply.attachmentTurn, undefined, 'not marked as an ordinary attachment reply (0.2.0 would offer Include)');
  assert.equal(reply.provenance, 'project-derived', 'it replayed a project answer, so it is project-derived');
  assert.equal(reply.contextPolicy, 'excluded');
  await assert.rejects(w.store.setContextPolicy(conversationId, reply.id, 'included'), /not a reply to attached code|follows the project's sharing permission/);
  await revokeAll(w.context.storageDir);
  const history = await w.store.contextMessages(conversationId, 30, Infinity);
  assert.ok(!history.some((m) => m.content === reply.content), 'never re-sent without the grant');
  assert.equal(mayReplay({ ...reply }, undefined), false);
  // After a downgrade, the authentic 0.2.0 store neither includes it on request nor sends it.
  // (Needs the historical 0.2.0 package; see test/helpers/historical.js.)
  if (require('./helpers/historical').HISTORICAL_SKIP) return;
  const { ConversationStore: Old } = require('./helpers/old-release').loadOldStore('0.2.0');
  const old = new Old(createContext({ storageDir: w.context.storageDir }));
  await assert.rejects(old.setContextPolicy(conversationId, reply.id, 'included'));
  assert.ok(!(await old.contextMessages(conversationId, 30, Infinity)).some((m) => m.content === reply.content));
});

test('WP-09 V1. exclude globs from workspace settings match in bounded time (no catastrophic backtracking)', () => {
  const { compileExcludes } = require('../src/glob');
  const matcher = compileExcludes({ '*a*a*a*a*a*a*a*a*b': true, '**a**a**a**a**a**a**a**a**b': true });
  const started = Date.now();
  assert.equal(matcher.excludes('a'.repeat(5000)), false);
  assert.equal(matcher.excludes('a/'.repeat(2000)), false);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('WP-09 V2. a request that replays earlier project answers also requires the last check', () => {
  const request = buildRequest({ instructions: '', history: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', projectDerived: true }], text: 'next' });
  assert.equal(request.requiresGate, true);
  assert.deepEqual(request.messages.map((m) => Object.keys(m).sort()), [['content', 'role'], ['content', 'role'], ['content', 'role']], 'the flag never reaches the request');
});

test('WP-09 M1. a request stopped by the last check is not shown or stored as having used project files', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const behaviour = {};
  const w = await openWindow({ behaviour });
  await w.send('Why does addAll fail on an empty list?');
  await w.decide('allow');
  behaviour.beforePreflight = () => revokeAll(w.context.storageDir);
  await w.send('Explain addAll in calculator.js');
  const reply = w.history().at(-1);
  assert.equal(reply.projectNotSent, true);
  assert.deepEqual(reply.contextUsed, []);
  assert.equal(w.posted('messageUpdated').at(-1).projectNotSent, true);
  assert.equal(w.sent.length, 1);
});

test('WP-09 M2. a waiting question is dropped when the project or the account changes before the decision', async () => {
  const one = projectFolder('one');
  const two = projectFolder('two');
  setWorkspaceFolders([one]);
  const w = await openWindow();
  await w.send('Why does addAll fail?');
  assert.ok(w.card());
  setWorkspaceFolders([two]);
  await w.provider.workspaceChanged();
  assert.equal(w.posted('consent').at(-1).consent, null);
  assert.equal(w.posted('restoreDraft').at(-1).text, 'Why does addAll fail?');
  await w.decide('allow');
  assert.equal(w.sent.length, 0);
  assert.equal((await new ConsentStore(w.context.storageDir).list()).length, 0, 'no grant written');

  // After its folder left, that window is in General (DEC-PLANCHAT-002): no project reading.
  await w.send('Why does addAll fail again?');
  assert.equal(w.card(), null);
  assert.doesNotMatch(w.sent.at(-1).messages.at(-1).content, /\[Project context/);

  setWorkspaceFolders([one]);
  const second = await openWindow();
  await second.send('Why does addAll fail?');
  assert.ok(second.card());
  second.session.subject = 'someone-else';
  await second.decide('allow');
  assert.equal(second.sent.length, 0);
  assert.match(second.posted('consent').at(-1).notice, /account changed, so nothing was sent/);
  assert.equal((await new ConsentStore(second.context.storageDir).list()).filter((r) => r.state === 'active').length, 0);
});

test('WP-09 M3. Manage Project Sharing stops a reply streaming in this window right away', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const w = await openWindow({ behaviour: { hang: true, started } });
  await w.send('Why does addAll fail on an empty list?');
  const deciding = w.decide('allow');
  await running;
  calls.quickPick = (items) => items[0];
  calls.warningChoice = 'Stop Sharing';
  await w.provider.manageProjectSharing();
  await Promise.race([deciding, new Promise((resolve, reject) => setTimeout(() => reject(new Error('not stopped')), 3000))]);
  assert.ok(w.notes().some((text) => /stopped during this reply/.test(text)));
});

test('WP-09 M4. ranking work is bounded for very long messages', () => {
  const long = Array.from({ length: 20000 }, (_, i) => `word${i}abc file${i}.js`).join(' ');
  const started = Date.now();
  const { terms, files } = tokenize(long);
  assert.ok(terms.length <= 32, `terms ${terms.length}`);
  assert.ok(files.length <= 16, `files ${files.length}`);
  assert.ok(Date.now() - started < 1000);
});

test('WP-09 M5. Allow sends exactly the excerpts the card showed; a shown file that changed sends nothing', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail on an empty list?');
  const shown = w.card().excerpts.map((e) => `${e.relPath}:${e.startLine}-${e.endLine}`).sort();
  // A new matching file appears while the card is open.
  fs.writeFileSync(path.join(directory, 'src', 'addall-extra.js'), '// addAll addAll addAll empty list\n');
  await w.decide('allow');
  const sentRefs = [...w.sent[0].messages.at(-1).content.matchAll(/File: (\S+) \(lines (\d+)-(\d+)\)/g)].map((m) => `${m[1]}:${m[2]}-${m[3]}`).sort();
  assert.deepEqual(sentRefs, shown);

  await revokeAll(w.context.storageDir);
  await w.send('Why does addAll fail on an empty list?');
  assert.ok(w.card());
  fs.appendFileSync(path.join(directory, 'src', 'calculator.js'), '// changed while the card was open\n');
  const stored = w.history().length;
  await w.decide('allow');
  assert.equal(w.sent.length, 1, 'a shown file changed: nothing sent');
  assert.equal(w.history().length, stored, 'nothing stored');
  assert.match(w.posted('error').at(-1).message, /sources-changed.*Nothing was sent/);
  assert.equal(w.posted('restoreDraft').at(-1).text, 'Why does addAll fail on an empty list?');
});

test('WP-09 L7/L10. the setting: non-boolean values count as off; turning it off drops a waiting card', async () => {
  config.layers.global['planChat.projectContext.enabled'] = 'false';
  assert.equal(userProjectContextEnabled(), false);
  config.layers.global['planChat.projectContext.enabled'] = true;
  assert.equal(userProjectContextEnabled(), true);
  delete config.layers.global['planChat.projectContext.enabled'];
  assert.equal(userProjectContextEnabled(), true, 'default on');

  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  await w.send('Why does addAll fail?');
  assert.ok(w.card());
  config.layers.global['planChat.projectContext.enabled'] = false;
  w.provider.configurationChanged({ affectsConfiguration: (key) => key === 'planChat.projectContext.enabled' });
  assert.equal(w.posted('consent').at(-1).consent, null);
  assert.match(w.posted('consent').at(-1).notice, /turned off/);
});

test('WP-09 L8. a request with project excerpts cannot be sent without the last check', async () => {
  const request = buildRequest({ instructions: '', history: [], text: 'q', excerpts: [{ relPath: 'a.js', startLine: 1, endLine: 1, text: 'x', fileSha256: 'f'.repeat(64) }] });
  assert.equal(request.requiresGate, true);
  assert.equal(buildRequest({ instructions: '', history: [], text: 'q' }).requiresGate, false);
  const openai = new OpenAIService({ getAccessToken: async () => 'synthetic' });
  await assert.rejects(openai.streamResponse({ model: 'm', request, onDelta() {} }), /last permission check/);
});
