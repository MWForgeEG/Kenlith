'use strict';

// Stage 1 C: hard request budget. Unit tests for the composition rule, then
// end-to-end tests through the chat view with a fake OpenAI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, createWebviewView } = require('./helpers/fake-vscode');
const { CLIENT_ID, FakeOpenAI, completedStream, storedCredentials } = require('./helpers/fake-openai');
const { REQUEST_BUDGET, RequestBudgetError, composeWithinBudget } = require('../src/budget');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');

const INSTRUCTIONS = 'Test instructions.'; // the fake's user-level value, 18 code units
const ROOM = REQUEST_BUDGET - INSTRUCTIONS.length;

function totalOf(body) {
  return (body.instructions || '').length + body.input.reduce((sum, item) => sum + item.content.length, 0);
}

// ---------- composition rule ----------

test('budget is 80,000 UTF-16 code units', () => {
  assert.equal(REQUEST_BUDGET, 80_000);
});

test('boundary: exactly at the limit is sent, one unit over is refused', () => {
  const ok = composeWithinBudget({ instructions: INSTRUCTIONS, history: [], text: 'x'.repeat(ROOM) });
  assert.equal(ok.total, 80_000);
  assert.throws(
    () => composeWithinBudget({ instructions: INSTRUCTIONS, history: [], text: 'x'.repeat(ROOM + 1) }),
    (error) => error instanceof RequestBudgetError && /Shorten it by 1 characters/.test(error.message) && error.details.limit === 80_000
  );
});

test('instructions that fill the budget are reported as the cause', () => {
  assert.throws(
    () => composeWithinBudget({ instructions: 'i'.repeat(80_000), history: [], text: 'hi' }),
    /instructions are 80,000 characters.*Shorten kenlith\.instructions/
  );
});

test('Unicode: emoji count 2, Arabic 1, combining marks separately; the text is never altered', () => {
  const emoji = '😀'; // one code point, two UTF-16 units
  assert.equal(emoji.length, 2);
  const fits = emoji.repeat((ROOM) / 2);
  const ok = composeWithinBudget({ instructions: INSTRUCTIONS, history: [], text: fits });
  assert.equal(ok.total, 80_000);
  assert.equal(ok.messages.at(-1).content, fits);
  assert.throws(() => composeWithinBudget({ instructions: INSTRUCTIONS, history: [], text: `${fits}${emoji}` }), RequestBudgetError);

  const arabic = 'مرحبا';
  assert.equal(composeWithinBudget({ instructions: '', history: [], text: arabic }).total, 5);
  const combined = 'é'; // é as letter + combining accent
  assert.equal(composeWithinBudget({ instructions: '', history: [], text: combined.repeat(10) }).total, 20);
  const mixed = `أهلًا 👋🏽 é **bold** \`code\``;
  assert.equal(composeWithinBudget({ instructions: '', history: [], text: mixed }).messages[0].content, mixed);
});

test('history: whole messages only, newest first; no reply without its question', () => {
  const history = [
    { role: 'user', content: 'q1 ' + 'a'.repeat(30_000) },
    { role: 'assistant', content: 'r1 ' + 'b'.repeat(30_000) },
    { role: 'user', content: 'q2 ' + 'c'.repeat(20_000) },
    { role: 'assistant', content: 'r2 ' + 'd'.repeat(20_000) }
  ];
  const result = composeWithinBudget({ instructions: INSTRUCTIONS, history, text: 'new question' });
  // r1 would fit only partly → excluded whole; q2/r2 fit; r1 alone never leads.
  assert.deepEqual(result.messages.map((m) => m.content.slice(0, 2)), ['q2', 'r2', 'ne']);
  assert.equal(result.omitted, 2);
  assert.ok(result.total <= 80_000);
  for (const message of result.messages.slice(0, -1)) {
    assert.ok(history.some((item) => item.content === message.content), 'history messages are never shortened');
  }

  // Budget leaves room for r2 but not q2: r2 would lead as an orphan → dropped.
  const tight = composeWithinBudget({ instructions: INSTRUCTIONS, history, text: 'z'.repeat(ROOM - 20_003) });
  assert.deepEqual(tight.messages.map((m) => m.role), ['user']);
  assert.equal(tight.omitted, 4);
});

// ---------- end to end through the view ----------

let server;
test.beforeEach(() => {
  config.reset();
  calls.error.length = 0;
  server = new FakeOpenAI().install();
  server.responsesHandler = (request) => completedStream(`reply to ${request.json.input.length} items`);
});
test.afterEach(() => server.uninstall());

async function activate() {
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  await store.initialize();
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  const historyFile = path.join(context.storageDir, 'conversations.json');
  return { context, store, provider, view, historyFile };
}

test('oversized message: refused before storing or sending; the exact text is given back', async () => {
  const { view, store, historyFile } = await activate();
  await view.send({ type: 'send', text: 'first', model: 'gpt-alpha' });
  const before = fs.readFileSync(historyFile);
  const requestsBefore = server.requestsTo('/v1/responses').length;
  view.posted.length = 0;

  const raw = `  ${'م'.repeat(ROOM + 5)}  `; // surrounding spaces are part of what the user typed
  await view.send({ type: 'send', text: raw, model: 'gpt-alpha' });

  assert.equal(server.requestsTo('/v1/responses').length, requestsBefore, 'no request sent');
  assert.deepEqual(fs.readFileSync(historyFile), before, 'history unchanged');
  assert.equal(view.posted.some((m) => m.type === 'messageAdded'), false);
  assert.deepEqual(view.posted.find((m) => m.type === 'restoreDraft'), { type: 'restoreDraft', text: raw });
  assert.match(view.posted.find((m) => m.type === 'error').message, /too long to send.*Shorten it by 5 characters.*Nothing was sent or saved/);
  assert.equal(view.posted.filter((m) => m.type === 'streamState').at(-1).streaming, false, 'composer unlocked');
  assert.equal((await store.getCurrent()).messages.length, 2);
});

test('a message that exactly fills the budget is sent whole; older history is left out and reported', async () => {
  const { view } = await activate();
  await view.send({ type: 'send', text: 'earlier', model: 'gpt-alpha' });
  view.posted.length = 0;
  const text = 'x'.repeat(ROOM);
  await view.send({ type: 'send', text, model: 'gpt-alpha' });

  const body = server.requestsTo('/v1/responses').at(-1).json;
  assert.deepEqual(body.input, [{ role: 'user', content: text }]);
  assert.equal(totalOf(body), 80_000);
  assert.match(view.posted.find((m) => m.type === 'contextNote').text, /2 earlier messages were not included/);
});

test('large history: every request stays within budget and starts with a question', async () => {
  const { view, store } = await activate();
  server.responsesHandler = () => completedStream('r'.repeat(25_000));
  for (const n of [1, 2, 3, 4]) {
    await view.send({ type: 'send', text: `q${n} ${'q'.repeat(15_000)}`, model: 'gpt-alpha' });
  }
  for (const request of server.requestsTo('/v1/responses')) {
    assert.ok(totalOf(request.json) <= 80_000, `total ${totalOf(request.json)}`);
    assert.equal(request.json.input[0].role, 'user');
  }
  assert.equal((await store.getCurrent()).messages.length, 8, 'every exchange still stored in full');
});

test('maxHistoryMessages counts the new message (as in 0.1.2) and never starts with an orphaned reply', async () => {
  config.layers.global['planChat.maxHistoryMessages'] = 4;
  const { view } = await activate();
  for (const n of [1, 2, 3]) {
    await view.send({ type: 'send', text: `q${n}`, model: 'gpt-alpha' });
  }
  const input = server.requestsTo('/v1/responses').at(-1).json.input;
  // Last 3 stored messages are r1, q2, r2; r1's question is outside the limit,
  // so r1 is dropped instead of being sent without its question (0.1.2 sent it).
  assert.deepEqual(input.map((item) => item.content), ['q2', 'reply to 3 items', 'q3']);
  assert.ok(input.length <= 4);
});

test('limits that existed before keep working and give the text back', async () => {
  const { view } = await activate();
  view.posted.length = 0;
  const huge = 'h'.repeat(100_001);
  await view.send({ type: 'send', text: huge, model: 'gpt-alpha' });
  assert.equal(view.posted.find((m) => m.type === 'restoreDraft').text, huge);
  assert.match(view.posted.find((m) => m.type === 'error').message, /under 100,000 characters/);
  assert.equal(server.requestsTo('/v1/responses').length, 0);
});

test('empty and whitespace-only text: nothing sent, stored or restored', async () => {
  const { view, store } = await activate();
  view.posted.length = 0;
  for (const text of ['', '   ', '\n\t']) {
    await view.send({ type: 'send', text, model: 'gpt-alpha' });
  }
  assert.equal(server.requestsTo('/v1/responses').length, 0);
  assert.equal(view.posted.some((m) => m.type === 'restoreDraft' || m.type === 'error'), false);
  assert.equal((await store.getCurrent()).messages.length, 0);
});

test('an unavailable model refuses before storing and gives the text back', async () => {
  const { view, store } = await activate();
  view.posted.length = 0;
  await view.send({ type: 'send', text: 'keep me', model: 'gpt-hidden' });
  assert.equal(view.posted.find((m) => m.type === 'restoreDraft').text, 'keep me');
  assert.equal((await store.getCurrent()).messages.length, 0);
});

test('a second send while one is starting is given back instead of lost', async () => {
  const { view, store } = await activate();
  view.posted.length = 0;
  await Promise.all([
    view.send({ type: 'send', text: 'once', model: 'gpt-alpha' }),
    view.send({ type: 'send', text: 'twice', model: 'gpt-alpha' })
  ]);
  assert.deepEqual(view.posted.filter((m) => m.type === 'restoreDraft').map((m) => m.text), ['twice']);
  assert.deepEqual((await store.getCurrent()).messages.map((m) => m.content), ['once', 'reply to 1 items']);
});

test('a network failure after the budget check keeps 0.1.2 behaviour: question stored, error reply', async () => {
  const { view, store } = await activate();
  server.responsesHandler = () => { throw new TypeError('fetch failed'); };
  await view.send({ type: 'send', text: 'will fail', model: 'gpt-alpha' });
  const messages = (await store.getCurrent()).messages;
  assert.equal(messages[0].content, 'will fail');
  assert.equal(messages[1].error, true);
  assert.equal(view.posted.some((m) => m.type === 'restoreDraft'), false, 'stored questions are not handed back');
});

test('Arabic, emoji and combining marks arrive byte-identical in the request', async () => {
  const { view } = await activate();
  const text = 'السلام عليكم 👋🏽 café é ✅';
  await view.send({ type: 'send', text, model: 'gpt-alpha' });
  assert.equal(server.requestsTo('/v1/responses')[0].json.input.at(-1).content, text);
});
