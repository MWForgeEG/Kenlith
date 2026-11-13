'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, createContext, createWebviewView } = require('./helpers/fake-vscode');
const {
  CLIENT_ID,
  FakeOpenAI,
  completedStream,
  hangingStream,
  json,
  sse,
  storedCredentials,
  waitFor
} = require('./helpers/fake-openai');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { ConversationStore, titleFrom } = require('../src/store');
const { ChatViewProvider } = require('../src/view');
const { redactSecrets, safeError } = require('../src/util');

const ARABIC = 'مرحبا، كيف حالك؟ اشرح لي **Markdown** مع `code` 👋🏽';

let server;
test.beforeEach(() => {
  server = new FakeOpenAI().install();
  server.responsesHandler = (request) => completedStream(`reply from ${request.json.model}`);
});
test.afterEach(() => server.uninstall());

// One "activation": real AuthService/OpenAIService/store wired to a fake webview.
async function activate(shared) {
  const context = createContext(shared);
  if (!shared) {
    context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
    context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  }
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  // Not opened here: as in activateWith(), the view sets the window's context first.
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return { context, auth, store, provider, view };
}

function storedFile(context) {
  return JSON.parse(fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8'));
}

function lastHydrate(view) {
  return view.posted.filter((message) => message.type === 'hydrate').at(-1);
}

test('7. the model chosen in the UI is the model sent, and switching takes effect', async () => {
  const { view, store, context } = await activate();
  assert.deepEqual(lastHydrate(view).models.map((model) => model.id), ['gpt-alpha', 'gpt-beta']);

  await view.send({ type: 'send', text: 'first', model: 'gpt-beta' });
  await view.send({ type: 'selectModel', model: 'gpt-alpha' });
  await view.send({ type: 'send', text: 'second', model: 'gpt-alpha' });

  const sent = server.requestsTo('/v1/responses').map((request) => request.json);
  assert.deepEqual(sent.map((body) => body.model), ['gpt-beta', 'gpt-alpha']);
  assert.equal(sent[0].store, false);
  assert.equal(sent[0].stream, true);
  assert.equal(sent[0].instructions, 'Test instructions.');
  assert.equal(sent[0].input.some((item) => item.role === 'system'), false);
  assert.equal(context.stateValues.get('planChat.selectedModel.v1'), 'gpt-alpha');

  const messages = (await store.getCurrent()).messages;
  assert.deepEqual(messages.map((message) => message.content), ['first', 'reply from gpt-beta', 'second', 'reply from gpt-alpha']);
});

test('7b. an unavailable model or a failed request produces a clear error', async () => {
  const { view } = await activate();

  await view.send({ type: 'send', text: 'hello', model: 'gpt-hidden' });
  assert.equal(server.requestsTo('/v1/responses').length, 0);
  assert.match(view.posted.find((message) => message.type === 'error').message, /"gpt-hidden" is not available/);

  server.responsesHandler = () => json(429, {
    error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached' }
  }, { 'x-request-id': 'req_synthetic' });
  // A failed reply is shown once, in the failed message (UI slice 2), not
  // repeated in the banner.
  const banners = () => view.posted.filter((message) => message.type === 'error').length;
  const failure = () => view.posted.filter((message) => message.type === 'messageUpdated' && message.error).at(-1).content;
  const bannersBefore = banners();
  await view.send({ type: 'send', text: 'hello', model: 'gpt-alpha' });
  const error = failure();
  assert.match(error, /usage limit reached/i);
  assert.match(error, /429 subscription_sharing_usage_limit_exceeded/);
  assert.match(error, /req_synthetic/);
  assert.equal(banners(), bannersBefore, 'request failures are not repeated in the banner');

  // M1-0: sending is paused after the usage-limit error until Resume; the
  // pause itself is a banner (nothing was sent, so no message shows it).
  const sentBefore = server.requestsTo('/v1/responses').length;
  await view.send({ type: 'send', text: 'while paused', model: 'gpt-alpha' });
  assert.equal(server.requestsTo('/v1/responses').length, sentBefore, 'nothing sent while paused');
  assert.equal(view.posted.filter((message) => message.type === 'error').at(-1).action, 'usagePaused');
  await view.send({ type: 'resumeUsage' });

  const bannersAfterResume = banners();
  server.responsesHandler = () => json(401, { detail: 'Direct permission not accepted' });
  await view.send({ type: 'send', text: 'again', model: 'gpt-alpha' });
  assert.match(failure(), /Direct permission not accepted.*401/);
  assert.equal(banners(), bannersAfterResume, 'request failures are not repeated in the banner');
});

test('8. stopping a stream keeps the partial reply; the next request recovers', async () => {
  const { view, provider, store } = await activate();
  server.responsesHandler = (request) => hangingStream(['partial ', 'reply'], request.signal);

  const sending = view.send({ type: 'send', text: 'tell me', model: 'gpt-alpha' });
  await waitFor(() => view.posted.filter((message) => message.type === 'assistantDelta').length === 2);
  provider.stop();
  await sending;

  let messages = (await store.getCurrent()).messages;
  assert.equal(messages[1].content, 'partial reply');
  assert.equal(messages[1].stopped, true);
  assert.equal(view.posted.at(-1).type, 'streamState');
  assert.equal(view.posted.at(-1).streaming, false);

  server.responsesHandler = (request) => completedStream(`saw ${request.json.input.length} messages`);
  await view.send({ type: 'send', text: 'continue', model: 'gpt-alpha' });
  messages = (await store.getCurrent()).messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[3].content, 'saw 3 messages');
});

test('8b. a stream that ends without response.completed is marked failed and kept out of context', async () => {
  const { view, store } = await activate();
  server.responsesHandler = () => sse([{ type: 'response.output_text.delta', delta: 'cut off' }]);

  await view.send({ type: 'send', text: 'q1', model: 'gpt-alpha' });
  const failed = (await store.getCurrent()).messages[1];
  assert.equal(failed.content, 'cut off');
  assert.equal(failed.error, true);

  server.responsesHandler = (request) => {
    assert.deepEqual(request.json.input.map((item) => item.content), ['q1', 'q2']);
    return completedStream('ok');
  };
  await view.send({ type: 'send', text: 'q2', model: 'gpt-alpha' });
  assert.equal((await store.getCurrent()).messages.at(-1).content, 'ok');
});

test('8c. response.failed surfaces the plan error code', async () => {
  const { view, store } = await activate();
  server.responsesHandler = () => sse([
    { type: 'response.output_text.delta', delta: '' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } } }
  ]);

  await view.send({ type: 'send', text: 'q', model: 'gpt-alpha' });
  const last = (await store.getCurrent()).messages.at(-1);
  assert.equal(last.error, true);
  assert.match(last.content, /temporarily unavailable.*subscription_sharing_usage_unavailable/);
});

test('8d. starting a new chat mid-stream saves the partial reply to the original chat', async () => {
  const { view, store } = await activate();
  server.responsesHandler = (request) => hangingStream(['half'], request.signal);

  const sending = view.send({ type: 'send', text: 'original question', model: 'gpt-alpha' });
  await waitFor(() => view.posted.some((message) => message.type === 'assistantDelta'));
  const originalId = (await store.getCurrent()).id;
  await view.send({ type: 'newChat' });
  await sending;

  const fresh = await store.getCurrent();
  assert.notEqual(fresh.id, originalId);
  assert.deepEqual(fresh.messages, []);
  const original = await store.selectConversation(originalId);
  assert.deepEqual(original.messages.map((message) => message.content), ['original question', 'half']);
  assert.equal(original.messages[1].stopped, true);
});

test('8e. a double send while one is starting does not start a second request', async () => {
  const { view, store } = await activate();
  await Promise.all([
    view.send({ type: 'send', text: 'once', model: 'gpt-alpha' }),
    view.send({ type: 'send', text: 'twice', model: 'gpt-alpha' })
  ]);
  assert.equal(server.requestsTo('/v1/responses').length, 1);
  assert.deepEqual((await store.getCurrent()).messages.map((message) => message.content), ['once', 'reply from gpt-alpha']);
});

test('9. new chats get independent IDs and histories; switching does not mix messages', async () => {
  const { view, store } = await activate();
  await view.send({ type: 'send', text: 'chat A question', model: 'gpt-alpha' });
  const first = await store.getCurrent();

  await view.send({ type: 'newChat' });
  const second = await store.getCurrent();
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.messages, []);

  server.responsesHandler = (request) => {
    assert.deepEqual(request.json.input, [{ role: 'user', content: 'chat B question' }]);
    return completedStream('B answer');
  };
  await view.send({ type: 'send', text: 'chat B question', model: 'gpt-alpha' });

  await view.send({ type: 'selectConversation', conversationId: first.id });
  const conversationPost = view.posted.filter((message) => message.type === 'conversation').at(-1);
  assert.deepEqual(conversationPost.conversation.messages.map((message) => message.content), ['chat A question', 'reply from gpt-alpha']);

  const list = await store.listConversations();
  assert.equal(list.items.length, 2);
  assert.equal(new Set(list.items.map((item) => item.id)).size, 2);
});

test('9b. pressing + repeatedly never evicts conversations that have messages', async () => {
  const { store } = await activate();
  for (let index = 0; index < 35; index += 1) {
    await store.newConversation();
    await store.addMessage('user', `question ${index}`);
  }
  for (let index = 0; index < 10; index += 1) {
    await store.newConversation();
  }
  const list = await store.listConversations();
  assert.equal(list.items.filter((item) => item.title.startsWith('question')).length, 35);
  assert.equal(list.items.filter((item) => item.title === 'New chat').length, 1);
});

test('9c. each window keeps its own open chat; the view shows other windows\' messages after a send', async () => {
  const first = await activate();
  await first.view.send({ type: 'send', text: 'shared chat', model: 'gpt-alpha' });
  const shared = await first.store.getCurrent();

  const second = await activate(first.context);
  assert.equal((await second.store.getCurrent()).id, shared.id, 'a new window opens the last-used chat');
  await second.view.send({ type: 'newChat' });
  assert.notEqual((await second.store.getCurrent()).id, shared.id);
  assert.equal((await first.store.getCurrent()).id, shared.id, 'the first window did not move');

  // The second window writes into the shared chat; the first window then sends.
  await second.store.addMessage('user', 'from window two', shared.id);
  await first.view.send({ type: 'send', text: 'again', model: 'gpt-alpha' });
  const shown = first.view.posted.filter((message) => message.type === 'conversation').at(-1).conversation;
  assert.deepEqual(shown.messages.map((message) => message.content), [
    'shared chat', 'reply from gpt-alpha', 'from window two', 'again', 'reply from gpt-alpha'
  ]);
});

test('10. conversations persist across activation with Arabic, emoji and Markdown intact', async () => {
  const first = await activate();
  await first.view.send({ type: 'send', text: ARABIC, model: 'gpt-alpha' });
  await first.view.send({ type: 'newChat' });
  await first.view.send({ type: 'send', text: 'second chat', model: 'gpt-beta' });
  const before = await first.store.listConversations();

  const second = await activate(first.context);
  const after = await second.store.listConversations();
  assert.deepEqual(after, before);
  const hydrate = lastHydrate(second.view);
  assert.equal(hydrate.selectedModel, 'gpt-beta');
  const arabicChat = await second.store.selectConversation(before.items[1].id);
  assert.equal(arabicChat.messages[0].content, ARABIC);
  assert.equal(arabicChat.title, titleFrom(ARABIC));
});

test('10b. the existing v1 history file format still loads unchanged', async () => {
  const context = createContext();
  const legacy = {
    version: 1,
    currentId: 'c1',
    conversations: [{
      id: 'c1',
      title: 'مرحبا',
      createdAt: '2026-10-23T18:00:00.000Z',
      updatedAt: '2026-10-23T18:00:00.000Z',
      messages: [
        { id: 'm1', role: 'user', content: 'مرحبا', createdAt: '2026-10-23T18:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'أهلاً', createdAt: '2026-10-23T18:00:01.000Z' }
      ]
    }]
  };
  fs.writeFileSync(path.join(context.storageDir, 'conversations.json'), JSON.stringify(legacy));
  const store = new ConversationStore(context);
  assert.deepEqual(await store.getCurrent(), legacy.conversations[0]);
  assert.deepEqual(await store.contextMessages('c1'), [
    { role: 'user', content: 'مرحبا' },
    { role: 'assistant', content: 'أهلاً' }
  ]);
});

test('10c. titles never split an emoji', () => {
  const title = titleFrom('😀'.repeat(60));
  assert.equal(Array.from(title).length, 48);
  assert.equal(title.isWellFormed(), true);
});

test('11. signing out from the view keeps local conversations', async () => {
  const { view, context, store } = await activate();
  await view.send({ type: 'send', text: 'keep me', model: 'gpt-alpha' });
  const before = fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8');

  calls.warningChoice = 'Sign Out';
  await view.send({ type: 'signOut' });

  assert.equal(context.secretValues.has(CREDENTIALS_KEY), false);
  assert.equal(fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8'), before);
  assert.equal(lastHydrate(view).session, undefined);
  assert.equal((await store.getCurrent()).messages[0].content, 'keep me');
});

test('11b. a revoked session during chat switches the view to sign-in and keeps history', async () => {
  const { view, context, store } = await activate();
  await view.send({ type: 'send', text: 'before revoke', model: 'gpt-alpha' });
  const stored = JSON.parse(context.secretValues.get(CREDENTIALS_KEY));
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify({ ...stored, expiresAt: Date.now() - 1000 }));
  server.tokenHandler = () => json(400, { error: 'invalid_grant' });

  await view.send({ type: 'send', text: 'after revoke', model: 'gpt-alpha' });

  assert.equal(context.secretValues.has(CREDENTIALS_KEY), false);
  assert.equal(lastHydrate(view).session, undefined);
  assert.match(view.posted.at(-1).message || view.posted.filter((m) => m.type === 'error').at(-1).message, /Sign in again/);
  assert.equal((await store.getCurrent()).messages[0].content, 'before revoke');
});

test('12. secrets never reach the webview, the history file, or logs', async () => {
  const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl';
  const logged = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const { view, context } = await activate();
    // A server error that echoes credentials back must be redacted before display or storage.
    server.responsesHandler = () => json(400, {
      error: { message: `bad header Bearer synthetic-access-0 token ${fakeJwt} refresh_token=synthetic-refresh-0` }
    });
    await view.send({ type: 'send', text: 'trigger', model: 'gpt-alpha' });

    const stored = JSON.parse(context.secretValues.get(CREDENTIALS_KEY));
    const secrets = [stored.accessToken, stored.refreshToken, stored.idToken, fakeJwt];
    const surfaces = {
      webview: JSON.stringify(view.posted),
      history: fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8'),
      notifications: JSON.stringify(calls),
      logs: logged.join('\n'),
      globalState: JSON.stringify([...context.stateValues])
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const secret of secrets) {
        assert.equal(text.includes(secret), false, `${surface} leaked a credential`);
      }
    }
    assert.match(surfaces.history, /\[REDACTED/);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('12b. redaction covers common token shapes without touching ordinary text', () => {
  assert.equal(redactSecrets('Bearer abcdefghijk123'), 'Bearer [REDACTED]');
  assert.equal(redactSecrets('sk-abcdefghijklmnop'), '[REDACTED_KEY]');
  assert.equal(redactSecrets('{"access_token":"abc.def"}'), '{"access_token":"[REDACTED]"}');
  assert.equal(redactSecrets('code_verifier=xyz&state=1'), 'code_verifier=[REDACTED]&state=1');
  assert.equal(redactSecrets(ARABIC), ARABIC);
  assert.equal(safeError(new Error('eyJa.eyJb.c')), '[REDACTED_JWT]');
});
