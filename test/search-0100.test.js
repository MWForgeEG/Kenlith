'use strict';

// Kenlith 0.10.0 Search (DEC-PLANCHAT-045), without a real model: the engine,
// the request builder and the real src/openai.js against the scripted fake
// /v1/responses. Every request body that "leaves" is inspected.
//   Path A: a request already free of project data offers hosted web_search
//           with tool_choice "auto"; the model decides.
//   Path B: a request that can reach the project offers the internal signal
//           kenlith.request_web_search instead; on the signal Kenlith runs no
//           call and sends an isolated web-only request (tool_choice "required").
//   Search web: one Send, the isolated request directly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, makeTempDir, setActiveTextEditor, setWorkspaceFolders, vscode } = require('./helpers/fake-vscode');
const { FakeOpenAI, completedStream, json, sse } = require('./helpers/fake-openai');
const { createDocument, elements, serialize } = require('./helpers/fake-dom');
// 0.11.0 (DEC-PLANCHAT-048): requests need a capability record; these wrappers add
// a genuine one from the real resolver (test/helpers/capability.js).
const { boundBuilder, boundService, capabilityReady } = require('./helpers/capability');
require('node:test').before(() => capabilityReady);
const { OpenAIService: RawOpenAIService } = require('../src/openai');
const OpenAIService = boundService(RawOpenAIService);
const { ConversationStore } = require('../src/store');
const { ChatEngine } = require('../src/engine');
const { ChatPanels } = require('../src/panels');
const { buildRequest: buildRawRequest, withoutTools } = require('../src/request-builder');
const buildRequest = boundBuilder(buildRawRequest);
const research = require('../src/research');
const { placeCitations } = require('../src/citations');
const md = require('../src/markdown');
const { getWebviewHtml } = require('../src/view');

const SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-5.6-luna';
const UNKNOWN = 'gpt-7-nova';
const MODELS = [
  { slug: SOL, display_name: 'GPT-6.1-Sol', visibility: 'list' },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
  { slug: LUNA, display_name: 'GPT-5.6-Luna', visibility: 'list' },
  { slug: UNKNOWN, display_name: 'GPT-7-Nova', visibility: 'list' }
];
const WEATHER = 'ايه أخبار الطقس الكام يوم الجايين في القاهرة؟';
const TIMELESS = 'Explain dependency injection.';

let server;
test.beforeEach(() => {
  calls.panels.length = 0;
  server = new FakeOpenAI().install();
  server.models = MODELS.map((m) => ({ ...m }));
});
test.afterEach(() => {
  server.uninstall();
  setWorkspaceFolders(undefined);
  setActiveTextEditor(undefined);
  config.reset();
  vscode.workspace.isTrusted = true;
});

// --- request shapes, as the fake model sees them ----------------------------
const isPathA = (body) => JSON.stringify(body.tools) === JSON.stringify([{ type: 'web_search' }]) && body.tool_choice === 'auto';
const isWebOnly = (body) => JSON.stringify(body.tools) === JSON.stringify([{ type: 'web_search' }]) && body.tool_choice === 'required';
const hasSignal = (body) => Array.isArray(body.tools) && body.tools.some((t) => t.type === 'namespace' && t.name === 'kenlith' && t.tools?.[0]?.name === 'request_web_search');
const projectTools = (body) => (body.tools || []).filter((t) => t.type === 'function').map((t) => t.name);

// --- streams --------------------------------------------------------------
const TEXT_CITED = 'Cairo: 28° today, 27° tomorrow ([weather.example](https://weather.example/cairo)).';
function searchEvents({ text = TEXT_CITED, cite = true, extra = [] } = {}) {
  const start = text.indexOf('([');
  return [
    { type: 'response.created' },
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
    { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
    { type: 'response.web_search_call.completed', item_id: 'ws_1' },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'weather: Cairo, Egypt' } } },
    ...extra,
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', delta: text },
    ...(cite && start >= 0 ? [{ type: 'response.output_text.annotation.added', item_id: 'msg_1', annotation: { type: 'url_citation', start_index: start, end_index: text.length - 1, url: 'https://weather.example/cairo', title: 'Cairo weather' } }] : []),
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ];
}
function signalEvents(extraCalls = []) {
  return [
    { type: 'response.created' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', name: 'request_web_search', namespace: 'kenlith' } },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_sig', name: 'request_web_search', namespace: 'kenlith', arguments: '{}', status: 'completed' } },
    ...extraCalls.map((call, i) => ({ type: 'response.output_item.done', item: { type: 'function_call', id: `fc_x${i}`, call_id: `call_x${i}`, name: call.name, arguments: call.arguments || '{}', status: 'completed' } })),
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ];
}
function callEvents(name, args) {
  return [
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_r', call_id: 'call_read', name, arguments: JSON.stringify(args), status: 'completed' } },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ];
}

function model(script = () => ({ text: 'ok' })) {
  const requests = [];
  server.responsesHandler = (request) => {
    requests.push(request.json);
    const decision = script(request.json, requests.length, request);
    if (decision instanceof Response) return decision;
    if (decision.status) return json(decision.status, decision.body, decision.headers);
    if (decision.events) return sse(decision.events);
    return completedStream(decision.text || 'ok');
  };
  return requests;
}

async function openWindow({ storageDir = makeTempDir() } = {}) {
  const context = createContext({ storageDir });
  const session = { email: 'synthetic.user@example.test', subject: 'user-1', scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, getAccessToken: async () => 'synthetic-access', signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const store = new ConversationStore(context);
  const engine = new ChatEngine(context, auth, new OpenAIService(auth), store, { writeClipboard: async () => {}, openExternal: async () => {} });
  await engine.prepare();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const tab = async () => {
    store.currentId = undefined;
    const chat = await store.newConversation();
    await panels.openChat(chat.id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    const posted = (type) => panel.posted.filter((message) => message.type === type);
    return {
      id: chat.id,
      panel,
      posted,
      send: (text, { model: chosen = SOL, effort, web, attachmentId } = {}) => panel.send({ type: 'send', text, model: chosen, effort, attachmentId, ...(web === 'search' ? { search: true } : web === 'deep-research' ? { research: true } : {}) }),
      decide: (choice) => panel.send({ type: 'consentDecision', choice }),
      card: () => posted('consent').at(-1)?.consent,
      banners: () => posted('error').filter((m) => m.message)
    };
  };
  const messages = async (id) => (await store.getConversation(id)).messages;
  return { context, store, engine, panels, tab, messages, storageDir };
}

function projectFolder() {
  const base = makeTempDir();
  const directory = path.join(base, 'calc');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('README.md', '# Calculator\n\nAdds numbers. The entry point is src/calculator.js. PROJECT_MARKER_7Q\n');
  write('src/calculator.js', 'function addAll(list) {\n  return list.reduce((sum, value) => sum + value, 0);\n}\nmodule.exports = { addAll };\n');
  write('.env', 'API_KEY=SEARCH_SECRET_93X\n');
  return directory;
}

// A project chat with sharing allowed and project tools on: one ordinary
// question answered with text, Allow on the card.
async function projectChat(requests) {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('How does addAll in the calculator work? PROJECT_MARKER_7Q');
  if (chat.card()) await chat.decide('allow');
  return { w, chat, firstRequests: requests.length };
}

// ---------------------------------------------------------------------------
// Path A: general chat

test('SR-01 timeless question in a general chat: one Path A request, the model does not search, an ordinary reply', async () => {
  const requests = model(() => ({ text: 'Dependency injection gives an object its collaborators from outside.' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(TIMELESS);
  assert.equal(requests.length, 1);
  assert.ok(isPathA(requests[0]), 'web_search with tool_choice auto');
  assert.ok(!hasSignal(requests[0]), 'no signal in Path A');
  assert.match(requests[0].instructions, /You can use web search\. Use it when the user's latest message needs current or niche public information/);
  assert.equal(Object.hasOwn(requests[0], 'parallel_tool_calls'), false);
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.research, undefined, 'not a search reply');
  assert.equal(chat.posted('researchProgress').length, 0, 'no search status');
});

test('SR-02 current question in a general chat: one request, the model searches, a cited Search reply', async () => {
  const requests = model(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(WEATHER);
  assert.equal(requests.length, 1, 'no routing request');
  assert.ok(isPathA(requests[0]));
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.content, TEXT_CITED);
  assert.equal(reply.research.mode, 'search');
  assert.equal(reply.research.trigger, 'auto');
  assert.equal(reply.research.searchCompleted, true);
  assert.equal(reply.research.citations.length, 1);
  assert.equal(reply.research.citations[0].url, 'https://weather.example/cairo');
  const progress = chat.posted('researchProgress');
  assert.ok(progress.length && progress.every((p) => p.mode === 'search'), 'Searching the web… from the first search item');
  // Rendered with the existing citation renderer.
  const fragment = md.renderCited(createDocument(), reply.content, reply.research.citations);
  assert.ok(elements(fragment).some((n) => n.localName === 'a' && String(n.getAttribute('href')) === 'https://weather.example/cairo'));
});

test('SR-03 (D3) a completed search without a URL citation is a Search answer: proof of the search kept, no invented source', async () => {
  const text = 'Cairo: warm days, cool nights; no rain expected this week.';
  model(() => ({ events: searchEvents({ text, cite: false }) }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(WEATHER);
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.error, undefined, 'not a failure');
  assert.equal(reply.content, text);
  assert.equal(reply.research.mode, 'search');
  assert.equal(reply.research.searchCompleted, true, 'a real search completed');
  assert.equal(reply.research.searches, 1);
  assert.deepEqual(reply.research.citations, [], 'no citation invented');
  // The page shows "Searched the web" and no Sources, and no "unverified" note for Search.
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.ok(page.includes("? (sources.length ? 'Searched the web · ' + plural(sources.length, 'source', 'sources') : 'Searched the web')"));
  assert.ok(page.includes("else if (!search && !item.error && !item.stopped && !item.interrupted && item.content) {"), 'the unverified note is for Deep Research only');
  assert.ok(!/google\./i.test(page), 'no Google link anywhere');
});

test('SR-04 no web search happened is not a Search reply (it is told apart from a search without citations)', async () => {
  model(() => ({ events: [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', delta: 'An answer without search.' },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ] }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(TIMELESS);
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.research, undefined);
  assert.equal(reply.error, undefined);
});

test('SR-05 a reasoning item in a Path A search is ignored: nothing of it is shown or stored', async () => {
  const SECRET = 'REASONING_TEXT_0100';
  model(() => ({ events: searchEvents({ extra: [
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: SECRET }], encrypted_content: SECRET } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: SECRET }
  ] }) }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(WEATHER);
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.content, TEXT_CITED);
  assert.ok(!JSON.stringify(chat.panel.posted).includes(SECRET));
  assert.ok(!JSON.stringify(await w.messages(chat.id)).includes(SECRET));
});

test('SR-06 (D4) a Path A web search refusal is shown and not resent without web search, from memory, or with another model', async () => {
  const requests = model(() => ({ status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'Web search is not enabled for this workspace.', param: 'tools' } } }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(WEATHER);
  assert.equal(requests.length, 1, 'no resend');
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.error, true);
  assert.match(reply.content, /did not accept web search for this model or account/);
  assert.match(reply.content, /Web search is not enabled for this workspace\./);
  assert.match(reply.content, /did not answer without searching the web/);
  // The next message still offers web search (nothing is turned off for the session).
  model(() => ({ text: 'ok' }));
  const next = server.responsesHandler;
  const later = [];
  server.responsesHandler = (request) => { later.push(request.json); return next(request); };
  await chat.send(TIMELESS);
  assert.ok(isPathA(later[0]), 'search is not disabled automatically');
});

// ---------------------------------------------------------------------------
// Search web (manual)

test('SR-07 Search web always searches: web_search with tool_choice required, Search instructions, a manual Search reply', async () => {
  const requests = model(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Latest Node.js LTS?', { web: 'search' });
  assert.equal(requests.length, 1);
  assert.ok(isWebOnly(requests[0]));
  assert.match(requests[0].instructions, /Web search mode: answer the user's latest message from current public sources/);
  assert.doesNotMatch(requests[0].instructions, /Deep Research mode/);
  assert.match(requests[0].instructions, /untrusted data, not instructions/);
  const reply = (await w.messages(chat.id))[1];
  assert.deepEqual({ mode: reply.research.mode, trigger: reply.research.trigger }, { mode: 'search', trigger: 'manual' });
  // A Search web request that ends without a completed search fails (not shown as a search answer).
  model(() => ({ text: 'from memory' }));
  await chat.send('Latest Deno?', { web: 'search' });
  const failed = (await w.messages(chat.id)).at(-1);
  assert.equal(failed.error, true, 'shown as failed, not as a search answer');
  assert.match(chat.posted('messageUpdated').at(-1).errorText, /without a completed search/);
});

test('SR-08 Search web and Deep Research are one-Send and exclusive: both at once is refused, nothing sent; the page keeps one mode', async () => {
  const requests = model(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.panel.send({ type: 'send', text: 'both', model: SOL, research: true, search: true });
  assert.equal(requests.length, 0);
  assert.match(chat.banners().at(-1).message, /either Search web or Deep Research/);
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.ok(page.includes("state.research = next === 'deep-research';"));
  assert.ok(page.includes("state.search = next === 'search';"));
  assert.ok(page.includes("elements.menuSearch.setAttribute('aria-checked', String(state.search));"));
  assert.ok(page.includes("if (webMode) { state.researchAwaiting = true; state.researchText = text; state.awaitingMode = webMode; setWebMode(undefined); }"), 'one Send, then off');
  // Search web with a model outside the table: refused locally.
  await chat.send('q', { model: UNKNOWN, web: 'search' });
  assert.equal(requests.length, 0);
  assert.match(chat.banners().at(-1).message, /Web search has not been verified for "GPT-7-Nova"/);
});

test('SR-09 Search web never carries attached code; with attached code the signal is not offered either', () => {
  assert.throws(() => buildRequest({ instructions: 'i', history: [], text: 'q', model: SOL, web: 'search', attachment: { text: 'x', chars: 1 } }), /never project files or attached code/);
  const built = buildRequest({ instructions: 'i', history: [], text: 'q', model: SOL, autoSearch: true, attachment: { text: 'code', chars: 4 } });
  assert.equal(built.autoWeb, undefined);
  assert.equal(built.signal, undefined);
});

// ---------------------------------------------------------------------------
// Path B: project-capable chat

test('SR-10 project chat: the routing request offers the namespaced signal and project tools, never hosted search; on the signal an isolated web request follows', async () => {
  const requests = model((body, n) => {
    if (n === 1) return { text: 'calc answer PROJECT_ANSWER_5K' };
    if (hasSignal(body)) return { events: signalEvents() };
    if (isWebOnly(body)) return { events: searchEvents() };
    return { text: 'unexpected' };
  });
  const { w, chat } = await projectChat(requests);
  const cards = chat.posted('consent').length;
  await chat.send('What is the weather in Cairo tomorrow?');
  const routing = requests.at(-2);
  const web = requests.at(-1);
  assert.ok(hasSignal(routing), 'the signal');
  assert.ok(projectTools(routing).includes('project_read_file'), 'with the project tools');
  assert.ok(!routing.tools.some((t) => t.type === 'web_search'), 'no hosted search next to project tools');
  assert.match(routing.instructions, /call kenlith\.request_web_search \(it takes no arguments\) before answering/);
  assert.ok(isWebOnly(web), 'isolated web request');
  const text = JSON.stringify(web);
  // File text, secrets, the project-derived answer, tools: none. (What the user typed is web-safe history.)
  for (const leak of ['calculator.js', 'module.exports', 'Adds numbers. The entry point', 'SEARCH_SECRET_93X', 'PROJECT_ANSWER_5K', 'project_', 'kenlith']) assert.ok(!text.includes(leak), leak);
  assert.equal(chat.posted('consent').length, cards, 'no new card');
  const stored = await w.messages(chat.id);
  const reply = stored.at(-1);
  assert.equal(reply.research.mode, 'search');
  assert.equal(reply.research.trigger, 'auto');
  assert.equal(reply.provenance, undefined, 'the search reply is not project-derived');
  assert.equal(stored.filter((m) => m.role === 'assistant').length, 2, 'the routing placeholder was removed');
  assert.ok(chat.posted('messageRemoved').length >= 1);
});

test('SR-11 signal together with a project call: none of the calls runs, no read, no card; the isolated search answers', async () => {
  const requests = model((body, n) => {
    if (n === 1) return { text: 'first' };
    if (hasSignal(body)) return { events: signalEvents([{ name: 'project_read_file', arguments: JSON.stringify({ path: 'src/calculator.js' }) }, { name: 'project_run_command', arguments: JSON.stringify({ program: 'npm', args: ['test'] }) }]) };
    if (isWebOnly(body)) return { events: searchEvents() };
    return { text: 'unexpected' };
  });
  const { w, chat } = await projectChat(requests);
  const before = requests.length;
  await chat.send('Weather in Cairo now?');
  assert.equal(requests.length, before + 2, 'routing and web request only: no continuation carrying tool output');
  assert.ok(!requests.some((body) => JSON.stringify(body).includes('function_call_output')), 'no tool output was ever sent');
  assert.equal(chat.posted('command').length, 0, 'no command card');
  const reply = (await w.messages(chat.id)).at(-1);
  assert.equal(reply.research.mode, 'search');
  assert.equal(reply.commands, undefined, 'no run recorded');
});

test('SR-12 mixed turn: project data already read, then the signal: no web request, one boundary sentence, no partial answer', async () => {
  const requests = model((body, n) => {
    if (n === 1) return { text: 'first' };
    const continuation = Array.isArray(body.input) && body.input.some((item) => item.type === 'function_call_output');
    if (hasSignal(body) && !continuation) return { events: callEvents('project_read_file', { path: 'src/calculator.js' }) };
    if (hasSignal(body) && continuation) return { events: signalEvents() };
    return { text: 'unexpected' };
  });
  const { w, chat } = await projectChat(requests);
  const before = requests.length;
  await chat.send('Is the reduce call in addAll still recommended in the latest Node.js release?');
  assert.equal(requests.length, before + 2, 'routing and its continuation; no web request');
  assert.ok(!requests.slice(before).some(isWebOnly), 'nothing went to the web');
  const reply = (await w.messages(chat.id)).at(-1);
  assert.equal(reply.content, research.MIXED_STOP_TEXT);
  assert.equal(reply.research, undefined);
  assert.equal(reply.provenance, 'project-derived', 'made under the grant');
});

test('SR-13 the web-safe history: project-derived and attached-code replies never reach a web request; a follow-up keeps the earlier Search', async () => {
  const requests = model((body, n) => {
    if (n === 1) return { text: 'calc answer PROJECT_ANSWER_5K' };
    if (hasSignal(body)) return { events: signalEvents() };
    if (isWebOnly(body)) return { events: searchEvents() };
    return { text: 'unexpected' };
  });
  const { chat } = await projectChat(requests);
  await chat.send('Weather in Cairo for the next few days?');
  await chat.send('What about tomorrow evening?');
  const web = requests.at(-1);
  assert.ok(isWebOnly(web));
  const input = JSON.stringify(web.input);
  assert.ok(input.includes('Weather in Cairo for the next few days?'), 'the earlier question');
  assert.ok(input.includes('Cairo: 28° today'), 'the earlier Search answer');
  assert.ok(input.includes('What about tomorrow evening?'));
  assert.ok(!input.includes('PROJECT_ANSWER_5K'), 'the project-derived answer is not carried');
});

test('SR-14 a general-chat follow-up carries the earlier question and Search answer in the same one-request path', async () => {
  const requests = model(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Weather in Cairo for the next few days?');
  await chat.send('What about tomorrow evening?');
  assert.equal(requests.length, 2);
  assert.ok(isPathA(requests[1]));
  const input = JSON.stringify(requests[1].input);
  assert.ok(input.includes('Weather in Cairo') && input.includes('Cairo: 28° today'));
});

test('SR-15 secret-like text: never Path A; the isolated search sends it redacted', async () => {
  const token = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwx123456';
  const requests = model((body) => (hasSignal(body) ? { events: signalEvents() } : isWebOnly(body) ? { events: searchEvents() } : { text: 'x' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send(`Is this key format current? ${token}`);
  assert.ok(hasSignal(requests[0]), 'Path B for text that redaction would change');
  assert.ok(!isPathA(requests[0]));
  assert.ok(isWebOnly(requests[1]));
  assert.ok(!JSON.stringify(requests[1]).includes(token), 'redacted in the web request');
});

test('SR-16 the signal is recognised only with its namespace; a model outside the table gets neither path', () => {
  assert.equal(research.isSignalCall({ name: 'request_web_search', namespace: 'kenlith' }), true);
  assert.equal(research.isSignalCall({ name: 'request_web_search' }), false);
  assert.equal(research.isSignalCall({ name: 'request_web_search', namespace: 'other' }), false);
  const unknown = buildRequest({ instructions: 'i', history: [], text: 'q', model: UNKNOWN, autoSearch: true });
  assert.equal(unknown.autoWeb, undefined);
  assert.equal(unknown.signal, undefined);
  // The 0.5.0 fallback without project tools also drops the signal (a plain request).
  const withTools = buildRequest({ instructions: 'i', history: [], text: 'q', model: SOL, autoSearch: true, tools: [{ type: 'function', name: 'project_read_file', parameters: {} }] });
  assert.ok(withTools.signal);
  const plain = withoutTools(withTools);
  assert.equal(plain.signal, undefined);
  assert.doesNotMatch(plain.instructions, /request_web_search/);
  // A web request can never carry project content or secrets.
  assert.throws(() => buildRequest({ instructions: 'i', history: [{ role: 'assistant', content: 'x', attachmentReply: true }], text: 'q', model: SOL, web: 'search' }), /replies to attached code/);
  assert.throws(() => buildRequest({ instructions: 'i', history: [{ role: 'assistant', content: 'x', projectDerived: true }], text: 'q', model: SOL, web: 'search' }), /earlier answers that used project files/);
});

// ---------------------------------------------------------------------------
// Deep Research semantics

test('SR-17 Deep Research has its own research instructions and limits; Search has its own', async () => {
  const requests = model(() => ({ events: searchEvents() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Compare the release schedules of Node.js, Deno and Bun.', { web: 'deep-research' });
  const body = requests[0];
  assert.ok(isWebOnly(body));
  for (const phrase of ['Identify the aspects that need evidence', 'refine your searches based on what you learn', 'Prefer primary and official sources', 'confirm important claims with independent sources', 'When sources disagree, say so and weigh them', 'Keep evidence separate from your own inference', 'write a structured report', 'Support every material factual claim with a citation']) {
    assert.ok(body.instructions.includes(phrase), phrase);
  }
  assert.doesNotMatch(body.instructions, /\b\d+ searches\b/, 'no fixed number of searches');
  assert.equal(research.timeoutFor('search'), 5 * 60 * 1000);
  assert.equal(research.timeoutFor('deep-research'), 20 * 60 * 1000);
  const reply = (await w.messages(chat.id))[1];
  assert.equal(reply.research.mode, 'deep-research');
  assert.equal(Object.hasOwn(body, 'include'), false);
  assert.equal(JSON.stringify(body.tools), '[{"type":"web_search"}]', 'no new web_search field');
  // The page states a shallow run honestly (counts only).
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.ok(page.includes("'This run used few sources; the report may be less thorough than usual.'"));
});

// ---------------------------------------------------------------------------
// Storage

test('SR-18 storage: Search and Deep Research are kept apart; 0.9.x records load unchanged', async () => {
  const w = await openWindow();
  const chat = await w.tab();
  const a = await w.store.addMessage('assistant', '', chat.id, { research: true });
  const b = await w.store.addMessage('assistant', '', chat.id, { research: { mode: 'search', trigger: 'auto' } });
  const c = await w.store.addMessage('assistant', '', chat.id, { research: { mode: 'search', trigger: 'bogus' } });
  assert.deepEqual(a.research, { mode: 'deep-research' });
  assert.deepEqual(b.research, { mode: 'search', trigger: 'auto' });
  assert.deepEqual(c.research, { mode: 'search' });
  // A stored 0.9.x Deep Research reply is read as is.
  const old = { mode: 'deep-research', searches: 2, pagesRead: 3, citations: [] };
  await w.store.finishReply(chat.id, a.id, 'old answer', { research: old });
  assert.deepEqual((await w.messages(chat.id)).find((m) => m.id === a.id).research, old);
});

// ---------------------------------------------------------------------------
// Markdown tables

test('SR-19 tables: GFM header and delimiter rows, alignment, escaped bars, code spans, inline formatting, no HTML', () => {
  const doc = createDocument();
  const html = serialize(md.render(doc, 'Intro\n| A | B \\| x | `c\\|d` |\n|:--|--:|:-:|\n| **1** | [l](https://a.example) | <b>3</b> |\n| only |\n\nafter'));
  assert.match(html, /<p dir="auto">Intro<\/p><div class="table-wrap"><table><thead><tr><th dir="auto" class="align-start">A<\/th><th dir="auto" class="align-end">B \| x<\/th><th dir="auto" class="align-center"><code dir="ltr">c\|d<\/code><\/th><\/tr><\/thead>/);
  assert.match(html, /<td dir="auto" class="align-start"><strong>1<\/strong><\/td><td dir="auto" class="align-end"><a href="https:\/\/a\.example\/"/);
  assert.match(html, /&lt;b&gt;3&lt;\/b&gt;/, 'raw HTML is text');
  assert.match(html, /<tr><td dir="auto" class="align-start">only<\/td><td dir="auto" class="align-end"><\/td><td dir="auto" class="align-center"><\/td><\/tr>/, 'short rows padded');
  assert.match(html, /<\/table><\/div><p dir="auto">after<\/p>/);
  // Without leading and trailing bars.
  assert.match(serialize(md.render(createDocument(), 'a | b\n--- | ---\n1 | 2')), /<table><thead><tr><th dir="auto">a<\/th><th dir="auto">b<\/th><\/tr><\/thead><tbody><tr><td dir="auto">1<\/td><td dir="auto">2<\/td><\/tr><\/tbody><\/table>/);
  // Not a table: inside a code fence, a delimiter row of another width, no delimiter row.
  assert.doesNotMatch(serialize(md.render(createDocument(), '```\n| a |\n|---|\n```')), /<table>/);
  assert.doesNotMatch(serialize(md.render(createDocument(), '| a | b |\n|---|\n| 1 | 2 |')), /<table>/);
  assert.doesNotMatch(serialize(md.render(createDocument(), '| a | b |\n| 1 | 2 |')), /<table>/);
  // Bounded: more than 50 columns is a paragraph.
  const wide = `${Array.from({ length: 51 }, (_, i) => `c${i}`).join(' | ')}\n${Array.from({ length: 51 }, () => '---').join(' | ')}`;
  assert.doesNotMatch(serialize(md.render(createDocument(), wide)), /<table>/);
  // RTL: each cell takes its own direction.
  assert.match(serialize(md.render(createDocument(), '| المدينة | الحرارة |\n|---|---|\n| القاهرة | 28° |')), /<th dir="auto">المدينة<\/th>/);
});

test('SR-20 tables: citations inside cells are drawn like in paragraphs', () => {
  const text = '| City | Source |\n|---|---|\n| Cairo | ([weather.example](https://weather.example/cairo)) |';
  const start = text.indexOf('([');
  const end = text.lastIndexOf(')') + 1;
  const cites = placeCitations(text, [{ type: 'url_citation', start_index: start, end_index: end, url: 'https://weather.example/cairo', title: 'Cairo weather' }]).citations;
  assert.equal(cites.length, 1);
  const fragment = md.renderCited(createDocument(), text, cites);
  const cell = elements(fragment).filter((n) => n.localName === 'td')[1];
  assert.ok(cell, 'the source cell');
  assert.ok(elements(cell).some((n) => n.localName === 'a' && /citation/.test(String(n.getAttribute('class'))) && String(n.getAttribute('href')) === 'https://weather.example/cairo'), 'a citation link in the cell');
});

// ---------------------------------------------------------------------------
// Page: composer colour, activity indicator, widths

test('SR-21 the page: Kenlith colour tokens per theme kind, High Contrast keeps theme colours, the indicator, reduced motion, widths', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.match(page, /--kl-mint: #B4F0CD; --kl-green: #2FA36B; --kl-deep: #1E7A4E;/);
  assert.match(page, /--kl-edge: color-mix\(in srgb, var\(--kl-mint\) 25%, var\(--field-border\)\);/);
  assert.match(page, /body\.vscode-light \{\s*--kl-edge: color-mix\(in srgb, var\(--kl-green\) 50%, var\(--field-border\)\);/);
  assert.match(page, /body\.vscode-high-contrast, body\.vscode-high-contrast-light \{\s*--kl-edge: var\(--vscode-contrastBorder, var\(--field-border\)\);[\s\S]*?--kl-focus: var\(--vscode-focusBorder\);/);
  assert.match(page, /\.composer-box\.web-on \{ border-color: var\(--kl-active\); \}/);
  assert.match(page, /\.composer-box:focus-within \{ border-color: var\(--kl-focus\); box-shadow: 0 0 0 1px var\(--kl-focus\); \}/);
  // Indicator: two rings, the outer one pulses; the global reduced-motion rule stops it.
  assert.match(page, /<template id="klRings"><svg class="kl-rings" viewBox="0 0 14 14" aria-hidden="true" focusable="false"><circle class="kl-ring-outer" cx="7" cy="7" r="6"\/><circle cx="7" cy="7" r="2\.6"\/><\/svg><\/template>/);
  assert.match(page, /@keyframes kl-pulse/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{\s*\* \{ scroll-behavior: auto !important; transition: none !important; animation: none !important; \}/);
  assert.ok(page.includes("item.bubble.prepend(activityElement('Working…'));"));
  assert.ok(page.includes("? 'Searching the web…'"));
  assert.doesNotMatch(page, /percent|%<\/|progress-bar/i);
  // Width: workspace 76rem, prose 48rem, logical properties; tables scroll inside.
  assert.match(page, /#messages \{ padding: 16px max\(16px, calc\(\(100% - 76rem\) \/ 2\)\); \}/);
  assert.match(page, /\.composer \{ padding-inline: max\(16px, calc\(\(100% - 76rem\) \/ 2\)\); \}/);
  assert.match(page, /\.header \{ padding-inline: max\(16px, calc\(\(100% - 76rem\) \/ 2\)\); \}/);
  assert.match(page, /\.bubble > :is\(p, ul, ol, blockquote, h3, h4, h5, h6, \.reply-state, \.error-note, \.research-meta, \.depth-note, details\.sources\) \{ max-inline-size: 48rem; margin-inline-end: auto; \}/);
  assert.match(page, /\.table-wrap \{ overflow-x: auto; max-inline-size: 100%; margin-block: 6px; \}/);
  assert.doesNotMatch(page, /56rem/);
  // The + menu: Search web first; still no setting or extra composer control.
  assert.match(page, /<button id="menuSearch" class="menu-item" type="button" role="menuitemcheckbox" aria-checked="false"><span class="menu-label">Search web/);
});
