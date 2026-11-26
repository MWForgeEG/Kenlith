'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-050/051): web search and Deep Research in the
// capability resolver, automatic search eligibility, session-scoped rejection
// handling, explicit no-internet suppression in requests and continuations,
// and the privacy boundary with project sharing on and off. Synthetic catalogs
// and the fake OpenAI server only; no network, no model request.
// Design: docs/kenlith-0.12.0/SEARCH-CAPABILITY.md, AUTOMATIC-SEARCH.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, makeTempDir, setActiveTextEditor, setWorkspaceFolders } = require('./helpers/fake-vscode');
const { FakeOpenAI, completedStream, json } = require('./helpers/fake-openai');
const { ModelCatalog, SEARCH_TOOL_TYPES, SEARCH_VERIFIED, RESEARCH_VERIFIED, checkRecord } = require('../src/capabilities');
const { buildRequest, buildToolContinuation, withoutTools } = require('../src/request-builder');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatEngine } = require('../src/engine');
const { ChatPanels } = require('../src/panels');
const research = require('../src/research');
const { getWebviewHtml } = require('../src/view');

const ACCOUNT = 'user-1|synthetic.user@example.test';
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort }));
const VERIFIED = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra'];

// A synthetic account list: two advertised models with valid search metadata
// (synthetic future models; GPT-6.2 is verified since DEC-PLANCHAT-054), verified ones, and models whose search
// metadata is missing, malformed or unknown. No real account data.
function catalogEntries(extra = []) {
  const entry = (slug, more = {}) => ({ slug, display_name: slug.toUpperCase(), visibility: 'list', supported_reasoning_levels: LEVELS, supports_reasoning_effort_updates: true, ...more });
  return [
    entry('future-model-search-a', { web_search_tool_type: 'text_and_image', supports_search_tool: true }),
    entry('future-model-search-b', { web_search_tool_type: 'text', supports_search_tool: true }),
    entry('gpt-6.1-sol', { web_search_tool_type: 'text_and_image', supports_search_tool: true }),
    entry('gpt-6.2-sol', { web_search_tool_type: 'text_and_image', supports_search_tool: true }),
    entry('gpt-6.2-astra', { web_search_tool_type: 'text_and_image', supports_search_tool: true }),
    entry('future-model-absent'),
    entry('future-model-null', { web_search_tool_type: null }),
    entry('future-model-image', { web_search_tool_type: 'image' }),
    entry('future-model-upper', { web_search_tool_type: 'TEXT' }),
    entry('future-model-number', { web_search_tool_type: 1 }),
    entry('future-model-array', { web_search_tool_type: ['text'] }),
    entry('future-model-flag-only', { supports_search_tool: true }),
    entry('hidden-model-a', { visibility: 'hide', web_search_tool_type: 'text_and_image', supports_search_tool: true }),
    ...extra
  ];
}

async function catalogOf(entries, account = ACCOUNT) {
  const catalog = new ModelCatalog();
  await catalog.load(account, async () => entries);
  return catalog;
}
const args = (extra) => ({ instructions: 'i', history: [], text: 'q', ...extra });
const plain = (record) => ({ ...record });

// ---------------------------------------------------------------------------
// Resolver: web search tiers (W1 to W6) and Deep Research tiers (D1 to D4)

test('SC-W1 verified models are offered web search and Deep Research whatever their metadata says', async () => {
  const catalog = await catalogOf(VERIFIED.map((slug) => ({ slug, display_name: slug, visibility: 'list' })));
  for (const slug of VERIFIED) {
    assert.deepEqual(plain(catalog.resolve(slug).search), { tier: 'verified', offered: true, diagnostic: undefined }, slug);
    assert.deepEqual(plain(catalog.resolve(slug).research), { tier: 'verified', allowed: true, diagnostic: undefined }, slug);
  }
  assert.deepEqual(Object.keys(SEARCH_VERIFIED).sort(), [...VERIFIED].sort());
  assert.equal(RESEARCH_VERIFIED, SEARCH_VERIFIED);
  assert.equal(research.RESEARCH_MODELS, RESEARCH_VERIFIED);
});

// DEC-PLANCHAT-054: stage F (2026-11-26) verified both GPT-6.2 models for
// automatic search and Deep Research on the plan route.
test('SC-W8 (DEC-PLANCHAT-054) GPT-6.2-Sol and GPT-6.2-Astra are verified for web search and Deep Research, with or without metadata', async () => {
  for (const extra of [{ web_search_tool_type: 'text_and_image' }, {}, { web_search_tool_type: 'bogus' }]) {
    const catalog = await catalogOf(['gpt-6.2-sol', 'gpt-6.2-astra'].map((slug) => ({ slug, display_name: slug, visibility: 'list', ...extra })));
    for (const slug of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      assert.deepEqual(plain(catalog.resolve(slug).search), { tier: 'verified', offered: true, diagnostic: undefined }, slug);
      assert.deepEqual(plain(catalog.resolve(slug).research), { tier: 'verified', allowed: true, diagnostic: undefined }, slug);
      assert.equal(catalog.rejectSearch(catalog.resolve(slug)), false, 'a verified model is never suppressed');
    }
  }
  assert.match(SEARCH_VERIFIED['gpt-6.2-sol'], /stage F passed 2026-11-26 \(DEC-PLANCHAT-054\)/);
  // Hidden stays hidden whatever the table says.
  const hidden = await catalogOf([{ slug: 'gpt-6.2-sol', display_name: 'S', visibility: 'hide' }, { slug: 'gpt-6.1-sol', display_name: 'T', visibility: 'list' }]);
  assert.equal(hidden.resolve('gpt-6.2-sol').search.offered, false);
});

test('SC-W2 a model without a verified entry and with web_search_tool_type exactly "text" or "text_and_image" is advertised: offered search, never Deep Research', async () => {
  const catalog = await catalogOf(catalogEntries());
  assert.deepEqual(SEARCH_TOOL_TYPES, ['text', 'text_and_image']);
  for (const slug of ['future-model-search-a', 'future-model-search-b']) {
    assert.deepEqual(plain(catalog.resolve(slug).search), { tier: 'advertised', offered: true, diagnostic: undefined }, slug);
    assert.deepEqual(plain(catalog.resolve(slug).research), { tier: 'unverified', allowed: false, diagnostic: 'not-live-verified' }, slug);
  }
});

test('SC-W3 absent, null, unknown, wrong-case, number and array metadata are unknown: no search', async () => {
  const catalog = await catalogOf(catalogEntries());
  const want = {
    'future-model-absent': 'search-type-absent',
    'future-model-null': 'search-type-absent',
    'future-model-image': 'search-type-malformed',
    'future-model-upper': 'search-type-malformed',
    'future-model-number': 'search-type-malformed',
    'future-model-array': 'search-type-malformed'
  };
  for (const [slug, diagnostic] of Object.entries(want)) {
    assert.deepEqual(plain(catalog.resolve(slug).search), { tier: 'unknown', offered: false, diagnostic }, slug);
    assert.equal(catalog.resolve(slug).research.allowed, false, slug);
  }
});

test('SC-W4 supports_search_tool is never proof of web search: true alone gives no search, and it changes no tier', async () => {
  const catalog = await catalogOf(catalogEntries());
  assert.equal(catalog.resolve('future-model-flag-only').search.offered, false);
  const flipped = await catalogOf(catalogEntries().map((entry) => ({ ...entry, supports_search_tool: !entry.supports_search_tool })));
  for (const { slug } of catalogEntries()) {
    assert.deepEqual(plain(flipped.resolve(slug).search), plain(catalog.resolve(slug).search), slug);
  }
});

test('SC-W5 duplicate entries that disagree on web_search_tool_type are ambiguous: no search', async () => {
  const catalog = await catalogOf(catalogEntries([
    { slug: 'twin-model', display_name: 'Twin', visibility: 'list', web_search_tool_type: 'text' },
    { slug: 'twin-model', display_name: 'Twin', visibility: 'list', web_search_tool_type: 'text_and_image' }
  ]));
  assert.deepEqual(plain(catalog.resolve('twin-model').search), { tier: 'unknown', offered: false, diagnostic: 'search-type-ambiguous' });
  const agreeing = await catalogOf([
    { slug: 'twin-model', display_name: 'Twin', visibility: 'list', web_search_tool_type: 'text' },
    { slug: 'twin-model', display_name: 'Twin', visibility: 'list', web_search_tool_type: 'text' }
  ]);
  assert.equal(agreeing.resolve('twin-model').search.tier, 'advertised');
});

test('SC-W6 hidden, unlisted and unknown slugs have no capability at all', async () => {
  const catalog = await catalogOf(catalogEntries());
  for (const slug of ['hidden-model-a', 'not-in-the-list', '', 'FUTURE-MODEL-SEARCH-A']) {
    const record = catalog.resolve(slug);
    assert.equal(record.available, false, slug);
    assert.equal(record.search.offered, false, slug);
    assert.equal(record.research.allowed, false, slug);
  }
});

test('SC-W7 records are frozen and only the validated web_search_tool_type subset is kept', async () => {
  const catalog = await catalogOf(catalogEntries());
  const record = catalog.resolve('future-model-search-a');
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.search) && Object.isFrozen(record.research));
  assert.throws(() => { record.search.offered = false; });
  assert.equal(JSON.stringify(record).includes('supports_search_tool'), false);
});

// ---------------------------------------------------------------------------
// Rejection state (D-04c): in memory, session-scoped, specific errors only

test('SC-R1 searchUnsupported accepts only an error naming the search tool', () => {
  const yes = [
    { code: 'subscription_sharing_unsupported_capability', param: 'tools' },
    { code: 'subscription_sharing_unsupported_capability', param: 'tools[0]' },
    { code: 'subscription_sharing_unsupported_capability', param: 'tools[0].type' },
    { code: 'subscription_sharing_unsupported_capability', param: 'tool_choice' },
    { status: 400, param: 'tools', message: 'Hosted tool web_search is not supported with this model.' }
  ];
  const no = [
    undefined,
    null,
    { code: 'subscription_sharing_unsupported_capability' },
    { code: 'subscription_sharing_unsupported_capability', param: 'reasoning.effort' },
    { status: 400, param: 'tools', message: 'Invalid tools array' },
    { status: 400, message: 'web_search is not supported' },
    { status: 401, param: 'tools', message: 'web_search' },
    { status: 429, code: 'subscription_sharing_usage_limit_exceeded', param: 'tools' },
    { status: 500, param: 'tools', message: 'web search backend error' },
    { status: 503 },
    { name: 'AbortError', code: 'subscription_sharing_unsupported_capability', param: 'tools' },
    { name: 'TypeError', message: 'fetch failed' },
    { code: 'subscription_sharing_route_not_supported', status: 403 },
    { code: 'subscription_sharing_user_not_eligible', status: 403 }
  ];
  for (const error of yes) assert.equal(research.searchUnsupported(error), true, JSON.stringify(error));
  for (const error of no) assert.equal(research.searchUnsupported(error), false, JSON.stringify(error));
});

test('SC-R2 rejectSearch suppresses an advertised model for this session only, never a verified one, and records become stale', async () => {
  const catalog = await catalogOf(catalogEntries());
  const before = catalog.resolve('future-model-search-a');
  assert.equal(catalog.rejectSearch(catalog.resolve('gpt-6.1-sol')), false, 'verified: never suppressed');
  assert.equal(catalog.rejectSearch(catalog.resolve('future-model-absent')), false, 'unknown: nothing to suppress');
  assert.equal(catalog.rejectSearch(catalog.resolve('hidden-model-a')), false);
  assert.equal(catalog.rejectSearch(catalog.resolve('future-model-search-a')), true);
  assert.equal(catalog.isCurrent(before), false, 'earlier records are stale');
  assert.deepEqual(plain(catalog.resolve('future-model-search-a').search), { tier: 'rejected', offered: false, diagnostic: 'rejected-this-session' });
  assert.equal(catalog.resolve('future-model-search-b').search.offered, true, 'other models unaffected');
  assert.deepEqual(catalog.resolve('future-model-search-a').efforts, ['default', 'low', 'medium', 'high', 'xhigh', 'max'], 'Thinking unchanged');
  assert.equal(catalog.resolve('gpt-6.1-sol').search.offered, true);
});

test('SC-R3 a stale record (earlier session or model list) never changes the rejection state', async () => {
  const catalog = await catalogOf(catalogEntries());
  const old = catalog.resolve('future-model-search-a');
  catalog.invalidate();
  await catalog.load(ACCOUNT, async () => catalogEntries());
  assert.equal(catalog.rejectSearch(old), false);
  assert.equal(catalog.resolve('future-model-search-a').search.tier, 'advertised');
  const other = await catalogOf(catalogEntries());
  assert.equal(catalog.rejectSearch(other.resolve('future-model-search-a')), false, 'a record of another catalog');
  assert.equal(catalog.resolve('future-model-search-a').search.tier, 'advertised');
});

test('SC-R4 the rejection is reset by sign-out, account change and reauthentication (invalidate / noteAccount)', async () => {
  const catalog = await catalogOf(catalogEntries());
  assert.equal(catalog.rejectSearch(catalog.resolve('future-model-search-a')), true);
  catalog.invalidate();
  await catalog.load(ACCOUNT, async () => catalogEntries());
  assert.equal(catalog.resolve('future-model-search-a').search.tier, 'advertised', 'after sign-out/reauthentication');
  assert.equal(catalog.rejectSearch(catalog.resolve('future-model-search-a')), true);
  assert.equal(catalog.noteAccount('user-2|other.user@example.test'), true);
  await catalog.load('user-2|other.user@example.test', async () => catalogEntries());
  assert.equal(catalog.resolve('future-model-search-a').search.tier, 'advertised', 'after an account change');
  assert.equal(catalog.noteAccount('user-2|other.user@example.test'), false, 'same account: kept');
});

test('SC-R5 a late model list from an earlier session never installs (session race)', async () => {
  const catalog = new ModelCatalog();
  let release;
  const late = catalog.load(ACCOUNT, () => new Promise((resolve) => { release = resolve; }));
  catalog.invalidate();
  await catalog.load('user-2|other.user@example.test', async () => [{ slug: 'gpt-6.1-sol', display_name: 'S', visibility: 'list' }]);
  release(catalogEntries());
  await assert.rejects(late, /session changed/);
  assert.equal(catalog.resolve('future-model-search-a').available, false);
});

// ---------------------------------------------------------------------------
// Request builder and service gates

test('SC-B1 automatic search reads the record: advertised and verified get Path A, unknown and rejected get nothing', async () => {
  const catalog = await catalogOf(catalogEntries());
  for (const slug of ['future-model-search-a', 'future-model-search-b', 'gpt-6.1-sol']) {
    const request = buildRequest(args({ model: slug, autoSearch: true, capability: catalog.resolve(slug) }));
    assert.deepEqual([request.autoWeb?.toolChoice, request.autoWeb?.tools], ['auto', [{ type: 'web_search' }]], slug);
    assert.match(request.instructions, /explicitly asks you to search the web/);
  }
  for (const slug of ['future-model-absent', 'future-model-image', 'future-model-flag-only']) {
    const request = buildRequest(args({ model: slug, autoSearch: true, capability: catalog.resolve(slug) }));
    assert.equal(request.autoWeb, undefined, slug);
    assert.equal(request.signal, undefined, slug);
  }
  catalog.rejectSearch(catalog.resolve('future-model-search-a'));
  const rejected = buildRequest(args({ model: 'future-model-search-a', autoSearch: true, capability: catalog.resolve('future-model-search-a') }));
  assert.equal(rejected.autoWeb, undefined);
});

test('SC-B2 Deep Research and the isolated search need the record: unverified Deep Research and unoffered search throw', async () => {
  const catalog = await catalogOf(catalogEntries());
  assert.throws(() => buildRequest(args({ model: 'future-model-search-a', web: 'deep-research', capability: catalog.resolve('future-model-search-a') })), /Deep Research is not available for this model/);
  assert.ok(buildRequest(args({ model: 'future-model-search-a', web: 'search', capability: catalog.resolve('future-model-search-a') })).research);
  assert.throws(() => buildRequest(args({ model: 'future-model-absent', web: 'search', capability: catalog.resolve('future-model-absent') })), /Web search is not available for this model/);
  assert.ok(buildRequest(args({ model: 'gpt-6.1-sol', web: 'deep-research', capability: catalog.resolve('gpt-6.1-sol') })).research);
});

test('SC-B3 noWeb removes hosted search and the signal, from the request and every continuation; web requests with it throw', async () => {
  const catalog = await catalogOf(catalogEntries());
  const tool = { type: 'function', name: 'project_read_file', parameters: { type: 'object', properties: {} } };
  for (const slug of ['gpt-6.1-sol', 'future-model-search-a']) {
    const capability = catalog.resolve(slug);
    const pathA = buildRequest(args({ model: slug, autoSearch: true, noWeb: true, capability }));
    assert.deepEqual([pathA.autoWeb, pathA.signal, pathA.research, pathA.noWeb], [undefined, undefined, undefined, true], slug);
    assert.doesNotMatch(pathA.instructions, /You can use web search|request_web_search/);
    const pathB = buildRequest(args({ model: slug, autoSearch: true, noWeb: true, tools: [tool], capability }));
    assert.deepEqual([pathB.autoWeb, pathB.signal], [undefined, undefined], slug);
    const next = buildToolContinuation(pathB, { calls: [{ callId: 'c1', name: 'project_read_file', arguments: '{}' }], outputs: [{ callId: 'c1', output: '{}' }] });
    assert.deepEqual([next.autoWeb, next.signal, next.research, next.noWeb], [undefined, undefined, undefined, true]);
    const last = buildToolContinuation(next, { calls: [{ callId: 'c2', name: 'project_read_file', arguments: '{}' }], outputs: [{ callId: 'c2', output: '{}' }], final: true });
    assert.deepEqual([last.autoWeb, last.signal, last.noWeb], [undefined, undefined, true]);
    assert.deepEqual([withoutTools(pathB).autoWeb, withoutTools(pathB).signal], [undefined, undefined]);
    // Without noWeb the same requests can search (control).
    assert.ok(buildRequest(args({ model: slug, autoSearch: true, capability })).autoWeb);
    assert.ok(buildRequest(args({ model: slug, autoSearch: true, tools: [tool], capability })).signal);
    for (const web of ['search', 'deep-research']) {
      assert.throws(() => buildRequest(args({ model: 'gpt-6.1-sol', web, noWeb: true, capability: catalog.resolve('gpt-6.1-sol') })), /asks not to use the internet/);
    }
  }
});

test('SC-B4 the service refuses a request that could reach the web against its record or its noWeb mark', async () => {
  const server = new FakeOpenAI().install();
  let sent = 0;
  server.responsesHandler = () => { sent += 1; return completedStream('ok'); };
  try {
    const catalog = await catalogOf(catalogEntries());
    const service = new OpenAIService({ getAccessToken: async () => 'synthetic-access' });
    service.useCatalog(catalog);
    const good = buildRequest(args({ model: 'future-model-search-a', autoSearch: true, capability: catalog.resolve('future-model-search-a') }));
    // Forged: the same built request with search but a noWeb mark, or with
    // a record that offers no search. Built-ness is kept by the spread symbol.
    const forge = (patch) => Object.freeze({ ...good, ...patch });
    await assert.rejects(service.streamResponse({ model: 'future-model-search-a', request: forge({ noWeb: true }), onDelta() {} }), /This message asks not to use the internet, but the request can reach the web\. Nothing was sent\./);
    const unknown = catalog.resolve('future-model-absent');
    await assert.rejects(service.streamResponse({ model: 'future-model-absent', request: forge({ capability: unknown, autoWeb: { ...good.autoWeb, model: 'future-model-absent' } }), onDelta() {} }), /Web search is not available for this model in this session\. Nothing was sent\./);
    assert.equal(sent, 0);
    await service.streamResponse({ model: 'future-model-search-a', request: good, onDelta() {} });
    assert.equal(sent, 1);
  } finally {
    server.uninstall();
  }
});

// ---------------------------------------------------------------------------
// The engine

const SESSION = { email: 'synthetic.user@example.test', subject: 'user-1', scopes: ['chatgpt.tokens.use.direct'] };
const SECRET = 'SYNTHETIC-PROJECT-SECRET-7f3a';

function projectFolder() {
  const directory = path.join(makeTempDir(), 'weather-app');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('README.md', '# Weather app\n\nShows the weather forecast for Cairo. The entry point is src/forecast.js.\n');
  write('src/forecast.js', `// forecast for Cairo\nconst INTERNAL_NOTE = '${SECRET}';\nfunction forecast(city) {\n  return fetchWeather(city);\n}\nmodule.exports = { forecast };\n`);
  return directory;
}

let server;
test.beforeEach(() => {
  calls.panels.length = 0;
  server = new FakeOpenAI().install();
  server.models = catalogEntries();
});
test.afterEach(() => {
  server.uninstall();
  setWorkspaceFolders(undefined);
  setActiveTextEditor(undefined);
  config.reset();
});

function searchEvents() {
  const text = 'It is sunny ([example.org](https://example.org/weather)).';
  const link = '([example.org](https://example.org/weather))';
  return [
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'weather' } } },
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', start_index: text.indexOf(link), end_index: text.indexOf(link) + link.length, url: 'https://example.org/weather', title: 'Weather' } },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ];
}

function scripted(script = () => ({ text: 'ok' })) {
  const bodies = [];
  server.responsesHandler = (request) => {
    bodies.push(request.json);
    const decision = script(request.json, bodies.length);
    if (decision.status) return json(decision.status, decision.body);
    if (decision.events) return require('./helpers/fake-openai').sse(decision.events);
    return completedStream(decision.text || 'ok');
  };
  return bodies;
}

async function openWindow() {
  const context = createContext({ storageDir: makeTempDir() });
  const state = { session: SESSION };
  const auth = {
    sessionEpoch: 0,
    getSession: async () => state.session,
    getAccessToken: async () => 'synthetic-access',
    signIn: async () => { auth.sessionEpoch += 1; state.session = SESSION; },
    signOut: async () => { auth.sessionEpoch += 1; state.session = undefined; return { remoteRevoked: true }; }
  };
  const store = new ConversationStore(context);
  const engine = new ChatEngine(context, auth, new OpenAIService(auth), store, { writeClipboard: async () => {}, openExternal: async () => {} });
  await engine.prepare();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const tab = async () => {
    store.currentId = undefined;
    const id = (await store.newConversation()).id;
    await panels.openChat(id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    const posted = (type) => panel.posted.filter((m) => m.type === type);
    return {
      id,
      panel,
      send: (text, { model = 'future-model-search-a', effort, research: deep, search } = {}) => panel.send({ type: 'send', text, model, effort, ...(deep ? { research: true } : {}), ...(search ? { search: true } : {}) }),
      decide: (choice) => panel.send({ type: 'consentDecision', choice }),
      card: () => posted('consent').at(-1)?.consent,
      updates: () => posted('messageUpdated'),
      errors: () => [...posted('messageUpdated').filter((m) => m.error).map((m) => `${m.content} ${m.errorText || ''}`), ...posted('error').map((m) => String(m.message))]
    };
  };
  return { context, auth, store, engine, panels, tab, messages: async (id) => (await store.getConversation(id)).messages };
}

const REFUSAL = { status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'This capability is not supported.', param: 'tools' } } };

test('SC-E1 an advertised model searches automatically; sources and citations are stored like any Search reply', async () => {
  const bodies = scripted(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('What is the weather in Cairo today?', { effort: 'high' });
  assert.equal(bodies.length, 1);
  assert.deepEqual([bodies[0].tools, bodies[0].tool_choice, bodies[0].reasoning], [[{ type: 'web_search' }], 'auto', { effort: 'high' }]);
  const reply = (await w.messages(chat.id)).at(-1);
  assert.deepEqual({ mode: reply.research.mode, trigger: reply.research.trigger, completed: reply.research.searchCompleted }, { mode: 'search', trigger: 'auto', completed: true });
  assert.equal(reply.research.citations.length, 1);
});

test('SC-E2 a normal question to an eligible model is one request; no search runs unless the model searches', async () => {
  const bodies = scripted(() => ({ text: 'A closure keeps its scope.' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Explain JavaScript closures.');
  assert.equal(bodies.length, 1, 'no classification request');
  assert.equal(bodies[0].tool_choice, 'auto', 'offered, not forced');
  const reply = (await w.messages(chat.id)).at(-1);
  assert.equal(reply.research, undefined);
  assert.equal(reply.content, 'A closure keeps its scope.');
});

test('SC-E3 explicit no-internet messages (English and Arabic) carry no web tool; the next message can search again', async () => {
  const bodies = scripted(() => ({ text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  const lines = ["Don't use the internet: what is a monad?", 'بدون بحث، ما هي عاصمة فرنسا؟', 'متبحثش على النت، اشرح الـ closures', 'Answer from memory only. Who wrote Hamlet?'];
  for (const line of lines) await chat.send(line, { model: 'gpt-6.1-sol' });
  assert.equal(bodies.length, lines.length);
  for (const body of bodies) {
    assert.equal(body.tools, undefined, JSON.stringify(body.input.at(-1)));
    assert.equal(body.tool_choice, undefined);
  }
  await chat.send('What is the weather in Cairo today?', { model: 'gpt-6.1-sol' });
  assert.deepEqual(bodies.at(-1).tools, [{ type: 'web_search' }], 'applies to that message only');
});

test('SC-E4 quoted no-internet text is material, not an instruction: search stays available', async () => {
  const bodies = scripted(() => ({ text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('The policy says "do not use the internet". Is that still current guidance?', { model: 'gpt-6.1-sol' });
  assert.deepEqual(bodies.at(-1).tools, [{ type: 'web_search' }]);
});

test('SC-E5 Deep Research selected with a no-internet instruction: nothing is sent until the conflict is resolved', async () => {
  const bodies = scripted(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send("Research EU AI rules, but don't use the internet.", { model: 'gpt-6.1-sol', research: true });
  assert.equal(bodies.length, 0);
  assert.ok(chat.errors().some((e) => e.includes(research.NO_WEB_RESEARCH_CONFLICT)));
  assert.equal((await w.messages(chat.id)).length, 0, 'nothing stored');
  await chat.send('Research EU AI rules.', { model: 'gpt-6.1-sol', research: true });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tool_choice, 'required');
});

test('SC-E6 Deep Research is refused locally for an advertised (unverified) model; never escalated from a search', async () => {
  const bodies = scripted(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research the history of HTTP/3.', { model: 'future-model-search-a', research: true });
  assert.equal(bodies.length, 0);
  assert.ok(chat.errors().some((e) => /Deep Research has not been verified for "FUTURE-MODEL-SEARCH-A"/.test(e)));
  await chat.send('Research the history of HTTP/3.', { model: 'future-model-search-a' });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].tool_choice, 'auto', 'an ordinary message is never turned into Deep Research');
  assert.doesNotMatch(bodies[0].instructions, /Deep Research mode/);
});

test('SC-E7 a specific search refusal for an advertised model: shown once, not resent, search suppressed for the session only', async () => {
  let refuse = true;
  const bodies = scripted(() => (refuse ? REFUSAL : { text: 'answer without the web' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('What is the weather in Cairo today?', { effort: 'high' });
  assert.equal(bodies.length, 1, 'not resent');
  assert.ok(chat.errors().some((e) => e.includes(research.SEARCH_SUPPRESSED_NOTE)));
  refuse = false;
  await chat.send('What is the weather in Cairo today?', { effort: 'high' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tools, undefined, 'no search for this model in this session');
  assert.deepEqual([bodies[1].model, bodies[1].reasoning], ['future-model-search-a', { effort: 'high' }], 'same model and level');
  await chat.send('Weather in Cairo?', { model: 'future-model-search-b' });
  assert.deepEqual(bodies[2].tools, [{ type: 'web_search' }], 'other models keep search');
  // Sign out and in again: the state is gone.
  await w.engine.signOut?.();
  w.engine.catalog.invalidate();
  await chat.send('Weather in Cairo?');
  assert.deepEqual(bodies.at(-1).tools, [{ type: 'web_search' }], 'reset with the session');
});

test('SC-E8 generic, rate-limit, auth and server errors never suppress search; a verified model is never suppressed', async () => {
  const errors = [
    { status: 500, body: { error: { message: 'server error' } } },
    { status: 503, body: { error: { message: 'unavailable' } } },
    { status: 429, body: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit', param: 'tools' } } },
    { status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'unsupported' } } },
    { status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'unsupported', param: 'reasoning.effort' } } }
  ];
  for (const failure of errors) {
    let fail = true;
    const bodies = scripted(() => (fail ? failure : { text: 'ok' }));
    const w = await openWindow();
    const chat = await w.tab();
    await w.context.globalState.update('planChat.usagePause', undefined);
    await chat.send('Weather in Cairo?', { effort: 'high' });
    fail = false;
    await w.context.globalState.update('planChat.usagePause', undefined);
    w.engine.catalog.resolve('future-model-search-a');
    assert.equal(w.engine.catalog.resolve('future-model-search-a').search.tier, 'advertised', JSON.stringify(failure));
    assert.equal(bodies.length, 1, 'never resent');
  }
  // A verified model's specific refusal stays an ordinary error (D4).
  const bodies = scripted(() => REFUSAL);
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Weather in Cairo?', { model: 'gpt-6.1-sol' });
  assert.equal(bodies.length, 1);
  assert.equal(w.engine.catalog.resolve('gpt-6.1-sol').search.tier, 'verified');
  assert.ok(!chat.errors().some((e) => e.includes(research.SEARCH_SUPPRESSED_NOTE)));
});

test('SC-P1 project sharing off (no grant): an advertised model never carries project text to the web; the card still asks first', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const bodies = scripted(() => ({ text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('How does forecast() in src/forecast.js get the weather for Cairo?');
  assert.ok(chat.card(), 'the sharing card appears before anything is sent');
  assert.equal(bodies.length, 0);
  await chat.decide('without');
  assert.equal(bodies.length, 1);
  const body = bodies[0];
  assert.equal(JSON.stringify(body).includes(SECRET), false);
  // Without project files: Path A may offer hosted search, but the request
  // carries only the typed text and history (no excerpt, no tool).
  for (const tool of body.tools || []) assert.notEqual(tool.type, 'function');
});

const SIGNAL_EVENTS = [
  { type: 'response.created' },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', name: 'request_web_search', namespace: 'kenlith' } },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'sig_1', namespace: 'kenlith', name: 'request_web_search', arguments: '{}', status: 'completed' } },
  { type: 'response.completed', response: { status: 'completed', output: [] } }
];
const signalled = (body) => (body.tools || []).some((t) => t.type === 'namespace');
async function waitFor(predicate, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
}

// Sharing on, project excerpts in the turn: on the signal nothing goes to the
// web at all; the reply is the mixed-turn boundary sentence (0.10.0 rule).
test('SC-P2a project sharing allowed and excerpts sent: the signal sends nothing to the web; one boundary sentence', async () => {
  setWorkspaceFolders([projectFolder()]);
  const bodies = scripted((body) => (signalled(body) ? { events: SIGNAL_EVENTS } : body.tools?.[0]?.type === 'web_search' ? { events: searchEvents() } : { text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('What is the weather in Cairo today, for forecast() in my forecast app?');
  assert.ok(chat.card(), 'the sharing card appears first');
  assert.equal(bodies.length, 0, 'nothing before the decision');
  await chat.decide('allow');
  await waitFor(() => chat.updates().some((u) => u.content === research.MIXED_STOP_TEXT));
  assert.equal(bodies.length, 1, 'no web request after project data entered the turn');
  assert.ok(signalled(bodies[0]));
  assert.equal((bodies[0].tools || []).some((t) => t.type === 'web_search'), false);
  assert.ok(JSON.stringify(bodies[0].input).includes('forecast'), 'the excerpts went only to the project request');
  assert.ok(chat.updates().some((u) => u.content === research.MIXED_STOP_TEXT));
});

// Sharing answered "without project files": no project data in the turn, so
// the request may offer hosted search (Path A) and carries no project text.
test('SC-P2b project sharing declined: the request carries no project text; hosted search only without local tools', async () => {
  setWorkspaceFolders([projectFolder()]);
  const bodies = scripted((body) => (body.tools?.[0]?.type === 'web_search' ? { events: searchEvents() } : { text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('What is the weather in Cairo today, for forecast() in my forecast app?');
  assert.ok(chat.card());
  await chat.decide('without');
  await waitFor(() => bodies.length >= 1);
  assert.equal(bodies.length, 1);
  assert.equal(JSON.stringify(bodies[0]).includes(SECRET), false);
  assert.equal(JSON.stringify(bodies[0].input).includes('INTERNAL_NOTE'), false);
  for (const body of bodies) {
    const hosted = (body.tools || []).some((t) => t.type === 'web_search');
    const local = (body.tools || []).some((t) => t.type === 'function' || t.type === 'namespace');
    assert.ok(!(hosted && local), 'hosted search never next to local tools');
    if (hosted) {
      assert.equal(JSON.stringify(body).includes(SECRET), false, 'no project text in a web request');
      assert.equal(JSON.stringify(body.input).includes('forecast.js'), false, 'no excerpt in a web request');
    }
  }
});

test('SC-P3 web content cannot authorize local actions: search requests never offer project tools, commands or proposals', async () => {
  const catalog = await catalogOf(catalogEntries());
  for (const slug of ['future-model-search-a', 'gpt-6.1-sol']) {
    const capability = catalog.resolve(slug);
    assert.throws(() => buildRequest(args({ model: slug, web: 'search', tools: [{ type: 'function', name: 'project_run_command' }], capability })), /never project files or attached code/);
    const auto = buildRequest(args({ model: slug, autoSearch: true, capability }));
    assert.equal(auto.tools, undefined);
    assert.match(research.SEARCH_INSTRUCTIONS, /untrusted data, not instructions/);
  }
});

test('SC-U1 the page: no Search web anywhere; Retry of a saved Search reply puts the question back with no mode', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.doesNotMatch(page, /menuSearch|>Search web<|Search web is on|Ask a question to search the web/);
  assert.match(page, /if \(retried && retried\.research && retried\.research\.mode === 'search'\) \{\s*setWebMode\(undefined\);/);
  assert.match(page, /Your question is back in the message box\. Press Send to ask again\./);
  const sidebar = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'sidebar');
  assert.doesNotMatch(sidebar, />Search web</);
});

test('SC-L1 saved Search web and automatic Search replies keep rendering their sources after the upgrade', async () => {
  const w = await openWindow();
  const chat = await w.tab();
  await w.store.addMessage('user', 'Latest Node LTS?', chat.id);
  for (const trigger of ['manual', 'auto']) {
    const saved = await w.store.addMessage('assistant', '', chat.id, { research: { mode: 'search', trigger }, inProgress: true });
    await w.store.finishReply(chat.id, saved.id, 'Node 24 ([nodejs.org](https://nodejs.org/)).', { research: { mode: 'search', trigger, searchCompleted: true, searches: 1, pagesRead: 0, citations: [{ url: 'https://nodejs.org/', title: 'Node.js' }] } });
  }
  const messages = await w.messages(chat.id);
  assert.deepEqual(messages.slice(1).map((m) => [m.research.mode, m.research.trigger, m.research.citations.length]), [['search', 'manual', 1], ['search', 'auto', 1]]);
});

test('SC-C1 checkRecord still guards every record: forged search fields are never trusted', async () => {
  const catalog = await catalogOf(catalogEntries());
  const forged = Object.freeze({ ...catalog.resolve('future-model-absent'), search: Object.freeze({ tier: 'verified', offered: true }) });
  assert.throws(() => checkRecord(forged, 'future-model-absent'), /could not confirm the capabilities/);
  assert.throws(() => buildRequest(args({ model: 'future-model-absent', autoSearch: true, capability: forged })), /could not confirm the capabilities/);
});
