'use strict';

// M1-0: Sign in with ChatGPT UX compliance (OpenAI SIWC "UI and UX
// guidelines" and "Errors and recovery"): the plan label with Manage usage,
// the usage-limit recovery action, the first-sign-in welcome, and that none
// of it changes sign-in, the request body or what is sent.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, createContext, createWebviewView } = require('./helpers/fake-vscode');
const { CLIENT_ID, FakeOpenAI, completedStream, json, sse, storedCredentials } = require('./helpers/fake-openai');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');
const siwc = require('../src/siwc');
const { RequestError } = require('../src/util');

const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';

let server;
test.beforeEach(() => {
  server = new FakeOpenAI().install();
  server.responsesHandler = (request) => completedStream(`reply from ${request.json.model}`);
  calls.info.length = 0;
  calls.infoDetails.length = 0;
  calls.warning.length = 0;
  calls.openExternal.length = 0;
  calls.warningChoice = 'Sign Out';
});
test.afterEach(() => server.uninstall());

// The real AuthService and OpenAIService against the fake OpenAI server.
async function activate() {
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return { context, auth, store, provider, view };
}

// A stand-in sign-in whose session the test controls; the provider is the real one.
function stubAuth({ signedIn = false, scopes = [siwc.PLAN_SCOPE], failSignIn = false } = {}) {
  const auth = {
    signedIn,
    signIns: 0,
    getSession: async () => (auth.signedIn ? { email: 'synthetic.user@example.test', scopes } : undefined),
    signIn: async () => {
      auth.signIns += 1;
      if (failSignIn) throw new Error('Sign-in was cancelled.');
      auth.signedIn = true;
    },
    signOut: async () => { auth.signedIn = false; return { remoteRevoked: true }; },
    getAccessToken: async () => 'synthetic-not-a-token'
  };
  return auth;
}

async function stubProvider(context, auth, listModels = async () => [{ id: 'model-a', name: 'Model A' }]) {
  const store = new ConversationStore(context);
  const openAI = { listModels, streamResponse: async () => '' };
  const provider = new ChatViewProvider(context, auth, openAI, store);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return { provider, view };
}

const lastHydrate = (view) => view.posted.filter((message) => message.type === 'hydrate').at(-1);
const failure = (view) => view.posted.filter((message) => message.type === 'messageUpdated' && message.error).at(-1);
const welcomes = () => calls.info.filter((message) => message.startsWith(siwc.WELCOME_TITLE));

// ---------- classification ----------

test('M1-0 a. only the structured usage-limit code is a usage-limit error', () => {
  assert.equal(siwc.isUsageLimitError(new RequestError('x', { status: 429, code: USAGE_LIMIT })), true);
  assert.equal(siwc.isUsageLimitError({ code: USAGE_LIMIT }), true);
  // An unrelated 429, a 429 without a code, and text that only mentions a limit.
  assert.equal(siwc.isUsageLimitError(new RequestError('Rate limit', { status: 429, code: 'rate_limit_exceeded' })), false);
  assert.equal(siwc.isUsageLimitError(new RequestError('Too many requests', { status: 429 })), false);
  assert.equal(siwc.isUsageLimitError(new Error('ChatGPT plan usage limit reached (429 usage_limit_reached).')), false);
  assert.equal(siwc.isUsageLimitError(new RequestError('x', { status: 503, code: 'subscription_sharing_usage_unavailable' })), false);
  assert.equal(siwc.isUsageLimitError(undefined), false);
});

test('M1-0 b. the plan label applies only to a session with ChatGPT plan usage', () => {
  assert.equal(siwc.usesPlan({ scopes: ['openid', siwc.PLAN_SCOPE] }), true);
  assert.equal(siwc.usesPlan({ scopes: ['openid', 'email'] }), false);
  assert.equal(siwc.usesPlan({}), false);
  assert.equal(siwc.usesPlan(undefined), false);
  assert.equal(siwc.USAGE_SETTINGS_URL, 'https://chatgpt.com/settings/usage');
});

test('M1-0 c. the usage-limit message names Manage usage, claims no reset time and keeps the diagnostics', async () => {
  const { auth } = await activate();
  server.responsesHandler = () => json(429, { error: { code: USAGE_LIMIT, message: 'Usage limit reached' } }, { 'x-request-id': 'req_synthetic' });
  const error = await new OpenAIService(auth).streamResponse({ model: 'gpt-alpha', request: require('../src/request-builder').buildRequest({ instructions: 'i', history: [], text: 'q' }), onDelta() {} })
    .then(() => undefined, (failed) => failed);
  assert.equal(error.code, USAGE_LIMIT);
  assert.equal(error.status, 429);
  assert.match(error.message, /usage limit reached/i);
  assert.match(error.message, /Manage usage/);
  assert.match(error.message, /did not retry/);
  assert.match(error.message, /429 subscription_sharing_usage_limit_exceeded/);
  assert.match(error.message, /req_synthetic/);
  assert.doesNotMatch(error.message, /\b(reset|resets|until|tomorrow|hours?|minutes?)\b/i);
  assert.equal(server.requestsTo('/v1/responses').length, 1, 'not retried');
});

// ---------- the view ----------

test('M1-0 d. a signed-in plan session shows the plan label; the request body is unchanged', async () => {
  const { view } = await activate();
  assert.equal(lastHydrate(view).planUsage, true);
  const html = view.webview.html;
  assert.match(html, /id="planRow"[^>]*>\s*<span>Using ChatGPT plan<\/span>\s*<button id="manageUsage"[^>]*>Manage usage<\/button>/);
  assert.match(html, /Kenlith is free\. Messages you send count toward your ChatGPT plan’s usage limits\./);

  await view.send({ type: 'send', text: 'hello', model: 'gpt-alpha' });
  const [request] = server.requestsTo('/v1/responses');
  // The 0.2.0 body: the same five fields, nothing added.
  assert.deepEqual(Object.keys(request.json).sort(), ['input', 'instructions', 'model', 'store', 'stream']);
  assert.deepEqual(request.json.input, [{ role: 'user', content: 'hello' }]);
  assert.equal(request.json.store, false);
  assert.equal(request.json.stream, true);
});

test('M1-0 e. a usage-limit error before the stream offers Manage usage; no banner, no retry', async () => {
  const { view } = await activate();
  server.responsesHandler = () => json(429, { error: { code: USAGE_LIMIT, message: 'Usage limit reached' } });
  const bannersBefore = view.posted.filter((message) => message.type === 'error').length;
  await view.send({ type: 'send', text: 'hello', model: 'gpt-alpha' });
  const failed = failure(view);
  assert.equal(failed.action, 'manageUsage');
  assert.match(failed.content, /^Request failed: .*ChatGPT plan usage limit reached/);
  assert.equal(view.posted.filter((message) => message.type === 'error').length, bannersBefore);
  assert.equal(server.requestsTo('/v1/responses').length, 1);
});

test('M1-0 f. a usage-limit error in response.failed, after part of the reply, also offers Manage usage', async () => {
  const { view, store } = await activate();
  server.responsesHandler = () => sse([
    { type: 'response.output_text.delta', delta: 'Partial ' },
    { type: 'response.failed', response: { error: { code: USAGE_LIMIT, message: 'Usage limit reached' } } }
  ]);
  await view.send({ type: 'send', text: 'hello', model: 'gpt-alpha' });
  const failed = failure(view);
  assert.equal(failed.action, 'manageUsage');
  assert.equal(failed.content, 'Partial ');
  assert.match(failed.errorText, /usage limit reached/i);
  const stored = (await store.getCurrent()).messages.at(-1);
  assert.equal(stored.error, true);
  assert.equal('action' in stored, false, 'the action is shown live, not stored');
});

test('M1-0 g. an unrelated 429 and other plan errors keep their own handling, without Manage usage', async () => {
  const { view } = await activate();
  server.responsesHandler = () => json(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' } });
  await view.send({ type: 'send', text: 'one', model: 'gpt-alpha' });
  assert.equal(failure(view).action, undefined);
  assert.match(failure(view).content, /Rate limit reached for requests.*429 rate_limit_exceeded/);

  server.responsesHandler = () => json(429, { detail: 'Too many requests' });
  await view.send({ type: 'send', text: 'two', model: 'gpt-alpha' });
  assert.equal(failure(view).action, undefined);

  server.responsesHandler = () => sse([
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } } }
  ]);
  await view.send({ type: 'send', text: 'three', model: 'gpt-alpha' });
  assert.equal(failure(view).action, undefined);
  assert.match(failure(view).content, /temporarily unavailable.*subscription_sharing_usage_unavailable/);
});

test('M1-0 h. Manage usage asks first, then opens only the ChatGPT usage page; nothing goes to the model', async () => {
  const { view } = await activate();
  const before = server.requests.length;
  calls.warningChoice = undefined;
  await view.send({ type: 'manageUsage' });
  assert.equal(calls.warning.at(-1), 'Open this link in your browser?');
  assert.deepEqual(calls.openExternal, [], 'cancelled: nothing opened');

  calls.warningChoice = 'Open Link';
  // The webview cannot choose the address.
  await view.send({ type: 'manageUsage', url: 'https://example.test/elsewhere' });
  assert.deepEqual(calls.openExternal, ['https://chatgpt.com/settings/usage']);
  assert.equal(server.requests.length, before, 'no request to OpenAI');
});

test('M1-0 i. a usage-limit error while listing models offers Manage usage in the banner', async () => {
  const limited = async () => { throw new RequestError('ChatGPT plan usage limit reached. (429 ' + USAGE_LIMIT + ')', { status: 429, code: USAGE_LIMIT }); };
  const { view } = await stubProvider(createContext(), stubAuth({ signedIn: true }), limited);
  const hydrate = lastHydrate(view);
  assert.match(hydrate.modelError, /usage limit reached/i);
  assert.equal(hydrate.modelErrorAction, 'manageUsage');
});

// ---------- first-sign-in welcome ----------

test('M1-0 j. the welcome appears once, after the first plan sign-in, with a single Got it; later sign-ins do not show it', async () => {
  const context = createContext();
  const auth = stubAuth();
  const { provider, view } = await stubProvider(context, auth);
  assert.equal(lastHydrate(view).planUsage, false, 'signed out: no plan label');

  await provider.signIn();
  assert.equal(welcomes().length, 1);
  // 0.7.0: a notification (not modal), so it never covers a card; the
  // explanation is in the message itself.
  const index = calls.info.findIndex((message) => message.startsWith(siwc.WELCOME_TITLE));
  const text = calls.info[index];
  const items = calls.infoDetails[index];
  assert.ok(!items.some((item) => item && typeof item === 'object' && item.modal), 'not modal');
  assert.match(text, /count toward its usage limits/);
  assert.match(text, /Kenlith itself is free and makes no charges of its own/);
  assert.doesNotMatch(text, /unlimited/i);
  assert.deepEqual(items, ['Got it']);
  assert.equal(context.globalState.get(siwc.WELCOME_KEY).dismissed, true);
  assert.equal(lastHydrate(view).planUsage, true);
  assert.equal(calls.info.includes('Kenlith is connected to ChatGPT.'), false, 'the welcome replaces the toast once');

  await provider.signOut();
  await provider.signIn();
  assert.equal(welcomes().length, 1, 'not shown on a later sign-in');
  assert.equal(calls.info.at(-1), 'Kenlith is connected to ChatGPT.');
});

test('M1-0 k. after a restart the welcome is not shown again', async () => {
  const context = createContext();
  const first = await stubProvider(context, stubAuth());
  await first.provider.signIn();
  assert.equal(welcomes().length, 1);

  // Same profile, new activation (the stored state is shared).
  const restarted = createContext({ stateValues: context.stateValues, secretValues: context.secretValues, storageDir: context.storageDir });
  const auth = stubAuth({ signedIn: true });
  const second = await stubProvider(restarted, auth);
  await second.provider.noteExistingSession();
  auth.signedIn = false;
  await second.provider.signIn();
  assert.equal(welcomes().length, 1);
});

test('M1-0 l. a user already signed in when this version starts is not interrupted and does not get the welcome later', async () => {
  const context = createContext();
  const auth = stubAuth({ signedIn: true });
  const { provider } = await stubProvider(context, auth);
  await provider.noteExistingSession();
  assert.equal(calls.info.length, 0, 'nothing shown at activation');
  assert.equal(context.globalState.get(siwc.WELCOME_KEY).existingSession, true);

  await provider.signOut();
  await provider.signIn();
  assert.equal(welcomes().length, 0);
});

test('M1-0 m. no welcome for a failed sign-in or a session without ChatGPT plan usage', async () => {
  const failed = createContext();
  const failing = await stubProvider(failed, stubAuth({ failSignIn: true }));
  await failing.provider.signIn();
  assert.equal(welcomes().length, 0);
  assert.equal(failed.globalState.get(siwc.WELCOME_KEY), undefined, 'can still be shown after a later successful sign-in');

  const other = createContext();
  const { provider, view } = await stubProvider(other, stubAuth({ scopes: ['openid', 'email'] }));
  await provider.signIn();
  assert.equal(welcomes().length, 0);
  assert.equal(lastHydrate(view).planUsage, false, 'no plan label');
  await provider.noteExistingSession();
  assert.equal(other.globalState.get(siwc.WELCOME_KEY), undefined);
});

// ---------- scope ----------

test('M1-0 n. sign-in code and token storage are unchanged by M1-0', () => {
  // src/auth.js must stay byte-identical to the M1-0 baseline, apart from the
  // Kenlith 0.4.1 rename (docs/kenlith-rebrand.md): with the product name
  // mapped back to Plan Chat it must hash exactly as recorded, so any other
  // change to sign-in code still fails here.
  // The M1-0 baseline hash of src/auth.js (recorded 2026-10-30).
  const recorded = 'd259df53b70b4500031876180172a89647873adc5f225ca3575f2c0aaef8422b';
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.js'), 'utf8');
  assert.match(source, /set\('agent_name_hint', 'Kenlith'\)/, 'the sign-in page is told the app name Kenlith');
  const beforeRename = source
    .replace("set('agent_name_hint', 'Kenlith')", "set('agent_name_hint', 'Plan Chat for Antigravity')")
    .split('Kenlith').join('Plan Chat');
  const actual = require('node:crypto').createHash('sha256').update(beforeRename).digest('hex');
  assert.ok(recorded, 'baseline hash for src/auth.js present');
  assert.equal(actual, recorded);
});

test('M1-0 o. the webview page script still parses, and wires Manage usage to the host only', async () => {
  const { view } = await activate();
  const scripts = [...view.webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) assert.doesNotThrow(() => new (require('node:vm').Script)(code));
  const page = scripts.join('\n');
  assert.match(page, /elements\.manageUsage\.addEventListener\('click', \(\) => post\('manageUsage'\)\)/);
  assert.match(page, /if \(message && \(action === 'manageUsage' \|\| action === 'usagePaused'\)\) elements\.error\.append\(usageButton\(\)\)/);
  assert.match(page, /resume\.addEventListener\('click', \(\) => post\('resumeUsage'\)\)/);
  assert.match(page, /if \(item\.error && item\.action === 'manageUsage'\) item\.bubble\.append\(usageButton\(\)\)/);
  // The reason and the action survive the chat being re-rendered after each send.
  assert.match(page, /if \(item\.error\) state\.liveFailures\.set\(id, \{ errorText, action \}\); else state\.liveFailures\.delete\(id\);/);
  assert.match(page, /errorText: state\.liveFailures\.get\(message\.id\)\?\.errorText, action: state\.liveFailures\.get\(message\.id\)\?\.action/);
  assert.doesNotMatch(page, /chatgpt\.com/, 'the address lives in the host, not the page');
});

test('M1-0 p. with the view hidden, the usage-limit notification offers Manage usage; other errors do not', async () => {
  const { view } = await activate();
  view.visible = false;
  calls.error.length = 0;
  calls.errorItems.length = 0;
  calls.errorChoice = 'Manage usage';
  calls.warningChoice = 'Open Link';
  server.responsesHandler = () => json(429, { error: { code: USAGE_LIMIT, message: 'Usage limit reached' } });
  await view.send({ type: 'send', text: 'hello', model: 'gpt-alpha' });
  assert.match(calls.error.at(-1), /^Kenlith: .*usage limit reached/i);
  assert.deepEqual(calls.errorItems.at(-1), ['Manage usage']);
  assert.deepEqual(calls.openExternal, ['https://chatgpt.com/settings/usage'], 'through the confirmed link');

  // Sending is paused after that error; Resume (an explicit action) ends it.
  await view.send({ type: 'resumeUsage' });
  server.responsesHandler = () => json(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit' } });
  await view.send({ type: 'send', text: 'again', model: 'gpt-alpha' });
  assert.deepEqual(calls.errorItems.at(-1), [], 'no action for an unrelated 429');
  assert.equal(calls.openExternal.length, 1);
  calls.errorChoice = undefined;
});

test('M1-0 q. unreadable stored credentials at activation are still reported when the view loads', async () => {
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, 'not json');
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  const auth = new AuthService(context);
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), new ConversationStore(context));
  await provider.noteExistingSession();
  assert.equal(context.globalState.get(siwc.WELCOME_KEY), undefined);
  const view = createWebviewView();
  // As in 0.2.0, where the first hydrate read the credentials: the view's
  // first load fails with this message (the check at activation no longer
  // swallows it).
  await assert.rejects(provider.resolveWebviewView(view), /Stored ChatGPT credentials were invalid and have been cleared/);
  // Reported once; the view then loads signed out.
  await view.send({ type: 'ready' });
  assert.equal(lastHydrate(view).session, undefined);
});

test('M1-0 r. after the usage-limit error, sending is paused: nothing stored or sent, the text comes back, until Resume', async () => {
  const { view, store, context } = await activate();
  server.responsesHandler = () => json(429, { error: { code: USAGE_LIMIT, message: 'Usage limit reached' } });
  await view.send({ type: 'send', text: 'first', model: 'gpt-alpha' });
  assert.ok(context.globalState.get(siwc.USAGE_PAUSE_KEY), 'pause recorded');
  server.responsesHandler = (request) => completedStream(`reply from ${request.json.model}`);
  const stored = (await store.getCurrent()).messages.length;

  await view.send({ type: 'send', text: 'second', model: 'gpt-alpha' });
  assert.equal(server.requestsTo('/v1/responses').length, 1, 'no request while paused');
  assert.equal((await store.getCurrent()).messages.length, stored, 'nothing stored');
  assert.equal(view.posted.filter((message) => message.type === 'restoreDraft').at(-1).text, 'second');
  const banner = view.posted.filter((message) => message.type === 'error').at(-1);
  assert.equal(banner.action, 'usagePaused');
  assert.match(banner.message, /paused.*usage limit.*Resume.*Nothing was sent/);

  await view.send({ type: 'resumeUsage' });
  assert.equal(context.globalState.get(siwc.USAGE_PAUSE_KEY), undefined);
  assert.equal(view.posted.filter((message) => message.type === 'error').at(-1).message, '', 'banner cleared');
  await view.send({ type: 'send', text: 'third', model: 'gpt-alpha' });
  assert.equal(server.requestsTo('/v1/responses').length, 2, 'sends again after Resume');
  // No automatic retry happened at any point: two requests, both user sends.
  assert.deepEqual(server.requestsTo('/v1/responses').map((request) => request.json.input.at(-1).content), ['first', 'third']);
});

test('M1-0 s. a new sign-in ends the pause; other errors never start one', async () => {
  const context = createContext();
  const auth = stubAuth({ signedIn: true });
  const { provider } = await stubProvider(context, auth);
  await context.globalState.update(siwc.USAGE_PAUSE_KEY, { at: 'x' });
  await provider.signOut();
  await provider.signIn();
  assert.equal(context.globalState.get(siwc.USAGE_PAUSE_KEY), undefined);

  const { view, context: other } = await activate();
  server.responsesHandler = () => json(429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit' } });
  await view.send({ type: 'send', text: 'one', model: 'gpt-alpha' });
  server.responsesHandler = () => json(503, { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } });
  await view.send({ type: 'send', text: 'two', model: 'gpt-alpha' });
  assert.equal(other.globalState.get(siwc.USAGE_PAUSE_KEY), undefined);
  assert.equal(server.requestsTo('/v1/responses').length, 2);
});

test('M1-0 t. with the view hidden, a paused send offers Manage usage and Resume; Resume ends the pause', async () => {
  const { view, context } = await activate();
  await context.globalState.update(siwc.USAGE_PAUSE_KEY, { at: 'x' });
  view.visible = false;
  calls.errorItems.length = 0;
  calls.errorChoice = 'Resume';
  await view.send({ type: 'send', text: 'while hidden', model: 'gpt-alpha' });
  assert.deepEqual(calls.errorItems.at(-1), ['Manage usage', 'Resume']);
  assert.equal(context.globalState.get(siwc.USAGE_PAUSE_KEY), undefined);
  assert.equal(server.requestsTo('/v1/responses').length, 0);
  calls.errorChoice = undefined;
});
