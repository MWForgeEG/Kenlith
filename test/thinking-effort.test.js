'use strict';

// Kenlith 0.8.0 Thinking effort (DEC-PLANCHAT-040), without a real model: the
// engine, the request builder and the real src/openai.js against the scripted
// fake /v1/responses. Every request body that "leaves" is inspected.
// The model slugs are the five documented ones (src/reasoning.js) plus one
// that is not, to stand for a new model.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, makeTempDir, setActiveTextEditor, setWorkspaceFolders, vscode } = require('./helpers/fake-vscode');
const { FakeOpenAI, completedStream, json, sse } = require('./helpers/fake-openai');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatEngine } = require('../src/engine');
const { ChatPanels } = require('../src/panels');
const { ExecutionStore } = require('../src/exec-store');
const { ExecutionService } = require('../src/exec-service');
const { buildRequest, buildToolContinuation, withoutTools } = require('../src/request-builder');
const reasoning = require('../src/reasoning');
const { getWebviewHtml } = require('../src/view');

const SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-6-luna';
const NEW = 'gpt-7-preview';
const MODELS = [
  { slug: SOL, display_name: 'GPT-6.1-Sol', visibility: 'list' },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
  { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', visibility: 'list' },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' },
  { slug: LUNA, display_name: 'GPT-6-Luna', visibility: 'list' },
  { slug: NEW, display_name: 'GPT-7 Preview', visibility: 'list' }
];
// The body keys of a 0.7.0 request without tools.
const KEYS_070 = ['input', 'instructions', 'model', 'store', 'stream'];

let server;
test.beforeEach(() => {
  calls.panels.length = 0;
  server = new FakeOpenAI().install();
  server.models = MODELS.map((model) => ({ ...model }));
});
test.afterEach(() => {
  server.uninstall();
  setWorkspaceFolders(undefined);
  setActiveTextEditor(undefined);
  config.reset();
  vscode.workspace.isTrusted = true;
});

// The fake model: `script(body, n)` gives { calls }, { status, body } or { text }.
function model(script = () => ({ text: 'ok' })) {
  const requests = [];
  server.responsesHandler = (request) => {
    requests.push(request.json);
    const decision = script(request.json, requests.length);
    if (decision.status) return json(decision.status, decision.body, decision.headers);
    if (decision.calls) {
      return sse([
        ...decision.calls.map(([name, args], index) => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call_${requests.length}_${index}`, name, arguments: JSON.stringify(args) } })),
        { type: 'response.completed', response: { status: 'completed', output: [] } }
      ]);
    }
    return completedStream(decision.text || 'ok');
  };
  return requests;
}
const outputsOf = (body) => (body?.input || []).filter((item) => item.type === 'function_call_output').map((item) => JSON.parse(item.output));

async function openWindow({ storageDir = makeTempDir(), exec: withExec = false } = {}) {
  const context = createContext({ storageDir });
  const session = { email: 'synthetic.user@example.test', subject: 'user-1', scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, getAccessToken: async () => 'synthetic-access', signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const store = new ConversationStore(context);
  const exec = withExec ? new ExecutionService({ store: new ExecutionStore(storageDir), isTrusted: () => vscode.workspace.isTrusted !== false, commandsEnabled: () => true, fetchTasks: async () => [] }) : undefined;
  const engine = new ChatEngine(context, auth, new OpenAIService(auth), store, { writeClipboard: async () => {}, openExternal: async () => {} }, undefined, exec ? { exec } : undefined);
  await engine.prepare();
  if (exec) await exec.loaded;
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const wrap = (id, panel) => {
    const posted = (type) => panel.posted.filter((message) => message.type === type);
    const shown = () => {
      const last = panel.posted.filter((message) => message.type === 'reasoning' || message.type === 'hydrate').at(-1);
      return last?.reasoning;
    };
    return {
      id,
      panel,
      posted,
      shown,
      send: (text, { model: chosen = SOL, effort } = {}) => panel.send({ type: 'send', text, model: chosen, effort }),
      selectEffort: (effort) => panel.send({ type: 'selectEffort', effort }),
      selectModel: (chosen) => panel.send({ type: 'selectModel', model: chosen }),
      decide: (choice) => panel.send({ type: 'consentDecision', choice }),
      card: () => posted('consent').at(-1)?.consent,
      commandCards: () => posted('command').map((m) => m.command).filter(Boolean),
      runDecision: (card, choice) => panel.send({ type: 'commandDecision', id: card.id, digest: card.digest, choice }),
      errors: () => posted('messageUpdated').filter((m) => m.error),
      banners: () => posted('error').map((m) => m.message),
      restored: () => posted('restoreDraft').map((m) => m.text)
    };
  };
  const tab = async () => {
    store.currentId = undefined;
    const chat = await store.newConversation();
    await panels.openChat(chat.id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    return wrap(chat.id, panel);
  };
  const reopen = async (id) => {
    await panels.openChat(id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    return wrap(id, panel);
  };
  return { context, store, engine, panels, tab, reopen, storageDir };
}

function projectFolder() {
  const base = makeTempDir();
  const directory = path.join(base, 'calc');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('README.md', '# Calculator\n\nAdds numbers. The entry point is src/calculator.js.\n');
  write('src/calculator.js', 'function addAll(list) {\n  return list.reduce((sum, value) => sum + value, 0);\n}\nmodule.exports = { addAll };\n');
  write('package.json', JSON.stringify({ name: 'calc', scripts: { test: 'node --test' } }));
  return directory;
}

async function waitFor(predicate, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 15)); }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// The capability policy

test('TE-P1 the policy: six choices; the five documented models accept low to max; anything else offers Default only', () => {
  assert.deepEqual(reasoning.EFFORTS, ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const slug of [SOL, 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', LUNA]) {
    assert.deepEqual(reasoning.supportedEfforts(slug), ['default', 'low', 'medium', 'high', 'xhigh', 'max'], slug);
  }
  // Exact slugs only: a new model, a dated snapshot, a different case, junk.
  for (const slug of [NEW, 'gpt-6.1-sol-2026-10-01', 'GPT-6.1-SOL', '', undefined, null, 42, '__proto__', 'constructor', 'hasOwnProperty']) {
    assert.deepEqual(reasoning.supportedEfforts(slug), ['default'], String(slug));
  }
  // none and minimal are never offered.
  for (const slug of Object.keys(reasoning.MODEL_EFFORTS)) {
    assert.ok(!reasoning.supportedEfforts(slug).some((effort) => effort === 'none' || effort === 'minimal'), slug);
  }
  assert.deepEqual(reasoning.LABELS, { default: 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' });
  assert.equal(reasoning.SHORT_LABELS.xhigh, 'XHigh');
});

test('TE-P2 precedence: the chat choice, then the user setting, then the model default; then checked against the model', () => {
  const r = (chatEffort, userDefault, model = SOL) => reasoning.resolveEffort({ chatEffort, userDefault, model });
  assert.deepEqual({ ...r(undefined, 'default') }, { choice: 'default', source: 'model', effective: 'default', note: '' });
  assert.deepEqual({ ...r(undefined, 'low') }, { choice: 'low', source: 'setting', effective: 'low', note: '' });
  assert.deepEqual({ ...r('max', 'low') }, { choice: 'max', source: 'chat', effective: 'max', note: '' });
  // An explicit Default in the chat wins over the setting.
  assert.deepEqual({ ...r('default', 'high') }, { choice: 'default', source: 'chat', effective: 'default', note: '' });
  // A bad stored value or setting counts as absent.
  assert.equal(r('ultra', 'high').choice, 'high');
  assert.equal(r({ effort: 'max' }, 'nonsense').choice, 'default');
  // A model that does not accept the choice: Default, with the note.
  assert.deepEqual({ ...r('high', undefined, NEW) }, { choice: 'high', source: 'chat', effective: 'default', note: reasoning.FALLBACK_NOTE });
  assert.equal(reasoning.FALLBACK_NOTE, 'This model uses its default thinking level.');
});

// ---------------------------------------------------------------------------
// 1 to 6, 8: the request body

test('TE-1 Default omits reasoning: the body is the 0.7.0 body', async () => {
  const requests = model();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('one', { effort: 'default' });
  await chat.send('two'); // no effort in the message (an older page): the chat's level, Default
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(Object.hasOwn(body, 'reasoning'), false);
    assert.deepEqual(Object.keys(body).sort(), KEYS_070);
  }
});

for (const [n, effort] of [[2, 'low'], [3, 'medium'], [4, 'high'], [5, 'xhigh'], [6, 'max']]) {
  test(`TE-${n} ${reasoning.LABELS[effort]} sends reasoning.effort = ${effort}, and nothing else changes`, async () => {
    const requests = model();
    const w = await openWindow();
    const chat = await w.tab();
    await chat.selectEffort(effort);
    await chat.send('question', { effort });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].reasoning, { effort });
    assert.deepEqual(Object.keys(requests[0]).sort(), [...KEYS_070, 'reasoning'].sort());
    assert.equal(requests[0].store, false);
    assert.equal(requests[0].stream, true);
  });
}

test('TE-7 invalid values from the page are refused by the host: nothing is stored, nothing is sent, the text comes back', async () => {
  const requests = model();
  const w = await openWindow();
  const chat = await w.tab();
  const bad = ['none', 'minimal', 'HIGH', 'extra high', '', 'ultra', 5, true, null, { effort: 'high' }, ['high'], '__proto__', 'toString'];
  for (const effort of bad) {
    await chat.send(`typed ${String(effort)}`, { effort });
  }
  assert.equal(requests.length, 0, 'no request for any invalid value');
  // null is sent through postMessage as null, not undefined: refused too.
  assert.equal(chat.restored().length, bad.length, 'every typed text is given back');
  assert.ok(chat.banners().every((message) => /Nothing was sent/.test(message)));
  for (const effort of bad) await chat.selectEffort(effort);
  assert.equal((await w.store.getConversation(chat.id)).reasoningEffort, undefined, 'nothing stored');
  // A valid value that the model does not accept is refused as well.
  await chat.send('to the new model', { model: NEW, effort: 'high' });
  assert.equal(requests.length, 0);
  assert.match(chat.banners().at(-1), /"High" is not available for this model.*Nothing was sent/);
});

test('TE-8 unknown values never enter a request: the builder and the service refuse them', () => {
  const base = { instructions: 'i', history: [], text: 't', model: SOL };
  assert.equal(buildRequest({ ...base, effort: 'default' }).reasoning, undefined);
  assert.equal(buildRequest({ ...base }).reasoning, undefined);
  assert.deepEqual({ ...buildRequest({ ...base, effort: 'xhigh' }).reasoning }, { effort: 'xhigh' });
  for (const effort of ['none', 'minimal', 'ultra', '', 7, null, { effort: 'max' }]) {
    assert.throws(() => buildRequest({ ...base, effort }), /Nothing was sent/, String(effort));
  }
  // A documented effort for an unknown model is refused too.
  assert.throws(() => buildRequest({ ...base, model: NEW, effort: 'low' }), /not available for this model/);
  // The field is frozen with the request; it cannot be changed afterwards.
  const request = buildRequest({ ...base, effort: 'high' });
  assert.throws(() => { request.reasoning.effort = 'ultra'; }, TypeError);
  assert.throws(() => { request.reasoning = { effort: 'ultra' }; }, TypeError);
});

test('TE-8b the service sends reasoning only to the model it was checked for, and only from a built request', async () => {
  const requests = model();
  const auth = { getAccessToken: async () => 'synthetic-access' };
  const service = new OpenAIService(auth);
  const request = buildRequest({ instructions: 'i', history: [], text: 't', model: SOL, effort: 'high' });
  await assert.rejects(service.streamResponse({ model: LUNA, request, onDelta: () => {} }), /checked for another model\. Nothing was sent/);
  const forged = { ...request };
  await assert.rejects(service.streamResponse({ model: SOL, request: forged, onDelta: () => {} }), /not built by Kenlith/);
  assert.equal(requests.length, 0);
  await service.streamResponse({ model: SOL, request, onDelta: () => {} });
  assert.deepEqual(requests[0].reasoning, { effort: 'high' });
});

// ---------------------------------------------------------------------------
// 9 to 12: persistence and precedence

test('TE-9 a 0.7.0 chat (no effort field) resolves to Default, sends no reasoning, and its record is not rewritten with one', async () => {
  const requests = model();
  const storageDir = makeTempDir();
  const old = {
    version: 1,
    currentId: 'c070',
    conversations: [{ id: 'c070', title: 'From 0.7.0', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', model: SOL, context: { kind: 'general' }, messages: [] }]
  };
  fs.writeFileSync(path.join(storageDir, 'conversations.json'), JSON.stringify(old));
  const w = await openWindow({ storageDir });
  const chat = await w.reopen('c070');
  assert.deepEqual([chat.shown().choice, chat.shown().source, chat.shown().effective], ['default', 'model', 'default']);
  await chat.send('hello again');
  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0], 'reasoning'), false);
  const stored = JSON.parse(fs.readFileSync(path.join(storageDir, 'conversations.json'), 'utf8'));
  assert.equal(Object.hasOwn(stored.conversations.find((c) => c.id === 'c070'), 'reasoningEffort'), false, 'no field added by sending');
});

test('TE-10 a chat\'s level is saved with the chat and survives a restart; other chats keep theirs', async () => {
  const requests = model();
  const storageDir = makeTempDir();
  const first = await openWindow({ storageDir });
  const a = await first.tab();
  await a.selectEffort('high');
  const b = await first.tab();
  await b.selectEffort('low');
  // "Restart": a new engine and store on the same storage.
  const second = await openWindow({ storageDir });
  const a2 = await second.reopen(a.id);
  const b2 = await second.reopen(b.id);
  assert.equal(a2.shown().effective, 'high');
  assert.equal(b2.shown().effective, 'low');
  await a2.send('in a', { effort: a2.shown().effective });
  await b2.send('in b', { effort: b2.shown().effective });
  assert.deepEqual(requests.map((body) => body.reasoning), [{ effort: 'high' }, { effort: 'low' }]);
});

test('TE-11 the user setting is the level of a new chat; a workspace value is ignored', async () => {
  const requests = model();
  config.layers.global['kenlith.reasoning.defaultEffort'] = 'medium';
  config.layers.workspace['kenlith.reasoning.defaultEffort'] = 'max';
  config.enforceScopes = false; // a host that does not hide workspace values: Kenlith ignores them itself
  const w = await openWindow();
  const chat = await w.tab();
  assert.deepEqual([chat.shown().choice, chat.shown().source], ['medium', 'setting']);
  await chat.send('new chat', { effort: chat.shown().effective });
  assert.deepEqual(requests[0].reasoning, { effort: 'medium' });
  assert.equal((await w.store.getConversation(chat.id)).reasoningEffort, undefined, 'following the setting writes nothing to the chat');
  // A bad setting value counts as Default.
  config.layers.global['kenlith.reasoning.defaultEffort'] = 'turbo';
  const other = await w.tab();
  assert.equal(other.shown().effective, 'default');
});

test('TE-11b changing the setting updates open chats that follow it, not chats with their own level', async () => {
  model();
  const w = await openWindow();
  const follows = await w.tab();
  const own = await w.tab();
  await own.selectEffort('low');
  await vscode.workspace.getConfiguration('kenlith').update('reasoning.defaultEffort', 'xhigh', vscode.ConfigurationTarget.Global);
  w.engine.configurationChanged({ affectsConfiguration: (key) => key === 'kenlith.reasoning.defaultEffort' });
  await waitFor(() => follows.shown().effective === 'xhigh', 'the following chat to show XHigh');
  assert.equal(own.shown().effective, 'low');
});

test('TE-12 the chat\'s own level wins over the setting, Default included', async () => {
  const requests = model();
  config.layers.global['kenlith.reasoning.defaultEffort'] = 'low';
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('default');
  assert.deepEqual([chat.shown().choice, chat.shown().source], ['default', 'chat']);
  await chat.send('explicit default', { effort: 'default' });
  await chat.selectEffort('max');
  await chat.send('explicit max', { effort: 'max' });
  assert.equal(Object.hasOwn(requests[0], 'reasoning'), false);
  assert.deepEqual(requests[1].reasoning, { effort: 'max' });
});

// ---------------------------------------------------------------------------
// 13 to 15: model changes and unknown models

test('TE-13 a model change keeps a level the new model accepts', async () => {
  const requests = model();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('high');
  await chat.selectModel(LUNA);
  assert.deepEqual([chat.shown().effective, chat.shown().note], ['high', '']);
  await chat.send('on luna', { model: LUNA, effort: 'high' });
  assert.equal(requests[0].model, LUNA);
  assert.deepEqual(requests[0].reasoning, { effort: 'high' });
});

test('TE-14 TE-15 a model without a documented level: Default with a short note; the saved level comes back with a model that accepts it', async () => {
  const requests = model();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('xhigh');
  await chat.selectModel(NEW);
  const shown = chat.shown();
  assert.deepEqual(shown.options, ['default']);
  assert.deepEqual([shown.choice, shown.effective, shown.note], ['xhigh', 'default', 'This model uses its default thinking level.']);
  assert.equal((await w.store.getConversation(chat.id)).reasoningEffort, 'xhigh', 'the saved choice is not changed');
  // The view's byModel lets it update at once; it matches the host.
  assert.deepEqual(shown.byModel[NEW], ['default']);
  assert.deepEqual(shown.byModel[SOL], ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  await chat.send('on the new model', { model: NEW, effort: 'default' });
  await chat.send('older page, no effort', { model: NEW });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((body) => body.model === NEW && !Object.hasOwn(body, 'reasoning')), 'no unverified effort is sent');
  await chat.selectModel(SOL);
  assert.deepEqual([chat.shown().effective, chat.shown().note], ['xhigh', '']);
});

// ---------------------------------------------------------------------------
// Errors: no retry, Default offered, the choice kept

test('TE-E1 OpenAI refuses the level: status and request ID kept, one request only, Default offered, the saved choice unchanged', async () => {
  const requests = model(() => ({ status: 400, body: { error: { code: 'unsupported_value', param: 'reasoning.effort', message: "Unsupported value: 'max' is not supported with this model." } }, headers: { 'x-request-id': 'req_synthetic_effort' } }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('max');
  await chat.send('deep question', { effort: 'max' });
  assert.equal(requests.length, 1, 'not retried at another level');
  const failure = chat.errors().at(-1);
  assert.equal(failure.action, 'effortDefault');
  assert.match(failure.content, /did not accept the thinking level "Max" for this model\. Kenlith did not retry\. Choose Default/);
  assert.match(failure.content, /400 unsupported_value/);
  assert.match(failure.content, /req_synthetic_effort/);
  assert.equal((await w.store.getConversation(chat.id)).reasoningEffort, 'max', 'kept until the user chooses');
  // Use Default (the page posts selectEffort default).
  await chat.selectEffort('default');
  assert.equal((await w.store.getConversation(chat.id)).reasoningEffort, 'default');
});

test('TE-E2 with tools and an explicit level, a plan-route capability refusal is not retried without tools', async () => {
  setWorkspaceFolders([projectFolder()]);
  const requests = model((body) => (body.tools ? { status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'unsupported' } } } : { text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('high');
  await chat.send('How does addAll sum the list?', { effort: 'high' });
  await chat.decide('allow');
  const before = requests.length;
  await chat.send('Where is addAll?', { effort: 'high' });
  assert.equal(requests.length, before + 1, 'one request, no second one without tools');
  assert.equal(chat.errors().at(-1).action, 'effortDefault');
  // With Default, 0.7.0's behaviour is unchanged: the same request once more without tools.
  await chat.selectEffort('default');
  await chat.send('Where is addAll, again?', { effort: 'default' });
  assert.equal(requests.length, before + 3);
  assert.ok(requests.at(-2).tools && !requests.at(-1).tools);
  assert.ok(!Object.hasOwn(requests.at(-1), 'reasoning'));
});

test('TE-E3 an unrelated failure keeps its own handling (usage limit: Manage usage, not the Default action)', async () => {
  model(() => ({ status: 429, body: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('high');
  await chat.send('q', { effort: 'high' });
  assert.equal(chat.errors().at(-1).action, 'manageUsage');
});

// ---------------------------------------------------------------------------
// In-flight requests

test('TE-F1 changing the level while a reply streams changes only the next request', async () => {
  let release;
  const requests = [];
  server.responsesHandler = (request) => {
    requests.push(request.json);
    if (requests.length === 1) return new Promise((resolve) => { release = () => resolve(completedStream('first')); });
    return completedStream('second');
  };
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('low');
  const sending = chat.send('first', { effort: 'low' });
  await waitFor(() => requests.length === 1 && release, 'the first request');
  await chat.selectEffort('max');
  release();
  await sending;
  await chat.send('second', { effort: 'max' });
  assert.deepEqual(requests.map((body) => body.reasoning), [{ effort: 'low' }, { effort: 'max' }]);
  const messages = (await w.store.getConversation(chat.id)).messages.map((m) => m.content);
  assert.deepEqual(messages, ['first', 'first', 'second', 'second'], 'earlier messages are not rewritten');
});

// ---------------------------------------------------------------------------
// 16 to 19: tools, commands, sharing, Review Before Apply

test('TE-16 the project tool loop keeps the chosen level in every request; Default keeps none', async () => {
  setWorkspaceFolders([projectFolder()]);
  const requests = model((body, n) => {
    if (body.tools && (n === 2 || n === 5)) return { calls: [['project_search_text', { query: 'addAll' }]] };
    if (body.tools && (n === 3 || n === 6)) return { calls: [['project_read_file', { path: 'src/calculator.js', start_line: null, end_line: null }]] };
    return { text: 'addAll uses reduce.' };
  });
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('high');
  await chat.send('How does addAll sum the list?', { effort: 'high' });
  assert.ok(chat.card(), 'the first share still asks first');
  assert.equal(requests.length, 0, 'nothing sent while the card waits');
  await chat.decide('allow');
  assert.equal(requests.length, 1);
  await chat.send('Where is addAll defined?', { effort: 'high' });
  assert.equal(requests.length, 4, 'question, two tool rounds and the answer');
  assert.ok(requests.slice(1).every((body) => body.tools), 'the tools stay offered');
  assert.deepEqual(outputsOf(requests[2]).map((out) => out.tool), ['project_search_text']);
  // Each continuation carries every earlier call and output of the turn.
  assert.deepEqual(outputsOf(requests[3]).map((out) => out.tool), ['project_search_text', 'project_read_file']);
  for (const body of requests) assert.deepEqual(body.reasoning, { effort: 'high' });
  // Default: the same loop, no reasoning field anywhere.
  await chat.selectEffort('default');
  await chat.send('And again with Default?', { effort: 'default' });
  assert.equal(requests.length, 7);
  for (const body of requests.slice(4)) assert.equal(Object.hasOwn(body, 'reasoning'), false);
});

test('TE-16b the builder keeps the level in continuations and without tools', () => {
  const tools = [{ type: 'function', name: 'project_search_text', parameters: {} }];
  const request = buildRequest({ instructions: 'i', history: [], text: 't', model: SOL, effort: 'xhigh', tools });
  const next = buildToolContinuation(request, { calls: [{ callId: 'c1', name: 'project_search_text', arguments: '{}' }], outputs: [{ callId: 'c1', output: '{}' }] });
  assert.deepEqual({ ...next.reasoning }, { effort: 'xhigh' });
  assert.equal(next.reasoningModel, SOL);
  assert.deepEqual({ ...withoutTools(request).reasoning }, { effort: 'xhigh' });
});

test('TE-17 commands: classification and approval are unchanged with a level; every request carries it', async () => {
  setWorkspaceFolders([projectFolder()]);
  const run = (executable, args) => ['project_run_command', { executable, args, cwd: null, timeout_seconds: null, env: [], purpose: 'check' }];
  const requests = model((body, n) => {
    if (body.tools && n === 2) return { calls: [run('node', ['--check', 'src/calculator.js'])] };
    if (body.tools && n === 4) return { calls: [run('npm', ['install', 'left-pad'])] };
    return { text: 'done' };
  });
  const w = await openWindow({ exec: true });
  const chat = await w.tab();
  await chat.selectEffort('medium');
  await chat.send('How does addAll sum the list?', { effort: 'medium' });
  await chat.decide('allow');
  // Class A, a read-only syntax check: runs with no card.
  await chat.send('Is calculator.js valid?', { effort: 'medium' });
  assert.deepEqual(chat.commandCards(), [], 'no card for a safe local check');
  assert.equal(outputsOf(requests[2])[0].status, 'succeeded');
  // Class B (network and install): waits for approval; declined, nothing runs.
  const sending = chat.send('Install left-pad.', { effort: 'medium' });
  await waitFor(() => chat.commandCards().length, 'the approval card');
  const [card] = chat.commandCards();
  assert.match(path.basename(String(card.executable)), /^npm(\.cmd)?$/i, 'the card names the resolved program');
  assert.deepEqual(card.args, ['install', 'left-pad']);
  await chat.runDecision(card, 'decline');
  await sending;
  const replies = (await w.store.getConversation(chat.id)).messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(replies.at(-2).commands.map((c) => [c.cls, c.status]), [['A', 'succeeded']]);
  assert.deepEqual(replies.at(-1).commands.map((c) => [c.cls, c.status]), [['B', 'declined']]);
  const declined = requests.slice(4).flatMap(outputsOf).find((out) => out.tool === 'project_run_command');
  assert.equal(declined.status, 'declined');
  assert.equal(fs.existsSync(path.join(w.storageDir, 'node_modules')), false);
  for (const body of requests) assert.deepEqual(body.reasoning, { effort: 'medium' });
});

test('TE-18 TE-19 sharing and Review Before Apply are unchanged: the effort code touches neither', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['consent.js', 'context-gate.js', 'provenance.js', 'proposal.js', 'proposal-apply.js', 'proposal-review.js', 'proposal-store.js', 'exec-boundary.js', 'exec-policy.js', 'exec-request.js', 'exec-runner.js', 'exec-service.js', 'auth.js', 'siwc.js', 'project-tools.js']) {
    const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(text, /require\('\.\/reasoning'\)|reasoningField|reasoningEffort|isEffort|effortRejection|selectEffort|reasoning\.effort/, file);
  }
  // Behaviour: test/consent.test.js, test/project-engine.test.js, test/review-apply.test.js,
  // test/exec-*.test.js run unchanged in the same suite.
});

// ---------------------------------------------------------------------------
// 20: the page

const page = getWebviewHtml({ cspSource: 'vscode-resource:' }, { mode: 'panel' });

test('TE-20 the page: a native select after the model, labelled, described by its note; logical CSS only; short labels when narrow', () => {
  assert.match(page, /<label id="effortLabel" class="effort-label" for="effort">Thinking<\/label>\s*<select id="effort" class="effort-select" aria-label="Thinking" aria-describedby="effortNote"><\/select>/);
  assert.match(page, /<div id="effortNote" class="effort-note hidden" role="status" aria-live="polite"><\/div>/);
  assert.match(page, /elements\.modelSlot\.append\(elements\.models\);[\s\S]*elements\.modelSlot\.append\(elements\.effortLabel, elements\.effort\);/);
  // The effort rules use logical properties (RTL mirrors them), no left/right.
  const css = page.match(/\.effort-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length >= 3);
  for (const rule of css) assert.doesNotMatch(rule, /(?:margin|padding)-(?:left|right)|\b(?:left|right)\s*:/, rule);
  // Narrow composers: the short labels and the word Thinking hidden (still named).
  assert.match(page, /const labels = state\.narrow \? info\.shortLabels : info\.labels;/);
  assert.match(page, /body\[data-narrow\] \.effort-label \{ display: none; \}/);
  // One line in the editor tab (the 0.7.0 compact composer): no wrapping.
  assert.match(page, /body\[data-mode="panel"\] \.composer-bar \{ flex-wrap: nowrap; \}/);
  // The page sends only the selected value; the host validates it.
  assert.match(page, /post\('selectEffort', \{ effort: elements\.effort\.value \}\);/);
  assert.match(page, /effort: state\.reasoning && elements\.effort\.value \? elements\.effort\.value : undefined/);
  assert.doesNotMatch(page, /reasoning:\s*\{\s*effort/, 'the page never builds a reasoning field');
  // The recovery action posts Default; it does not resend.
  assert.match(page, /button\.textContent = 'Use Default';[\s\S]*post\('selectEffort', \{ effort: 'default' \}\);/);
});

test('TE-20b the Arabic chat title and an RTL page do not change the values sent', async () => {
  const requests = model();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.selectEffort('high');
  await chat.send('اشرح لي الدالة addAll بالتفصيل', { effort: 'high' });
  assert.deepEqual(requests[0].reasoning, { effort: 'high' });
  assert.match(requests[0].input.at(-1).content, /اشرح لي/);
});

test('TE-21 a surface that switches chats shows the level of the chat it now shows', async () => {
  const { CLIENT_ID, storedCredentials } = require('./helpers/fake-openai');
  const { createWebviewView } = require('./helpers/fake-vscode');
  const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
  const { ChatViewProvider } = require('../src/view');
  model();
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  const lastState = () => view.posted.filter((m) => m.reasoning).at(-1).reasoning;
  await view.send({ type: 'selectEffort', effort: 'max' });
  // A chat with a message (New Chat reuses an empty one).
  await view.send({ type: 'send', text: 'first', model: SOL, effort: 'max' });
  const first = (await store.getCurrent()).id;
  assert.equal(lastState().effective, 'max');
  await view.send({ type: 'newChat' });
  assert.equal(lastState().effective, 'default', 'a new chat follows the setting (Default)');
  await view.send({ type: 'selectConversation', conversationId: first });
  assert.equal(lastState().effective, 'max');
});

test('TE-E4 only a refusal that names the effort blames it; other 400s keep their own text', () => {
  const r = (error, effort = 'high', tools = false) => reasoning.effortRejection(error, effort, { tools });
  assert.match(r({ status: 400, param: 'reasoning.effort', message: 'x' }), /did not accept the thinking level "High"/);
  assert.match(r({ status: 400, message: "Unsupported value: 'xhigh' is not supported with the 'reasoning.effort' parameter." }), /"High"/);
  // A 400 about something else that mentions reasoning (for example reasoning items).
  assert.equal(r({ status: 400, message: 'Item of type reasoning was provided without its required following item.' }), undefined);
  assert.equal(r({ status: 400, param: 'input', message: 'bad input' }), undefined);
  assert.equal(r({ status: 500, message: 'effort' }), undefined);
  // Default (no level) is never blamed.
  assert.equal(r({ status: 400, param: 'reasoning.effort' }, 'default'), undefined);
  // The plan route's capability refusal: with tools, both are named.
  assert.match(r({ code: 'subscription_sharing_unsupported_capability' }, 'max', true), /thinking level "Max" or the project tools/);
  assert.match(r({ code: 'subscription_sharing_unsupported_capability' }, 'max', false), /did not accept the thinking level "Max" for this model/);
});

test('TE-20c the page draws a Thinking state only for the chat it shows, checked against its own model selector', () => {
  assert.match(page, /case 'reasoning':\s*if \(message\.chatId && state\.shownChat && message\.chatId !== state\.shownChat\) break;\s*renderEffort\(message\.reasoning\);\s*effortForModel\(elements\.models\.value\);/);
  assert.equal((page.match(/state\.shownChat = message\.conversation \? message\.conversation\.id : undefined;/g) || []).length, 2, 'set by hydrate and conversation');
});

test('TE-22 no Kenlith setting is found by a Settings search for the old name "Plan Chat"', () => {
  const properties = require('../package.json').contributes.configuration.properties;
  for (const [key, value] of Object.entries(properties)) {
    if (!key.startsWith('kenlith.')) continue;
    const text = [value.description, value.markdownDescription, ...(value.enumDescriptions || []), ...(value.enumItemLabels || [])].filter(Boolean).join(' ');
    // The editor matches the words of a search anywhere in the text ("ChatGPT plan" matched in RC2).
    assert.ok(!(/\bplan/i.test(text) && /\bchat/i.test(text)), key);
  }
});
