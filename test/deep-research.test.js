'use strict';

// Kenlith 0.9.0 Deep Research, without a real model: the engine, the request
// builder, the real src/openai.js and src/citations.js against the scripted
// fake /v1/responses. Every request body that "leaves" is inspected.
// The research stream is test/fixtures-090/live-run2-stream.json: the event
// sequence of the live feasibility run 2 (2026-11-14), rebuilt from its
// recorded evidence (Arabic answer, 7 url_citation annotations, 5 searches,
// response.metadata, response.completed with an empty output).

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
const { buildRequest: buildRawRequest } = require('../src/request-builder');
const buildRequest = boundBuilder(buildRawRequest);
const research = require('../src/research');
const { placeCitations, codePointOffsets } = require('../src/citations');
const md = require('../src/markdown');
const { getWebviewHtml } = require('../src/view');

const ASTRA = 'gpt-6-astra';
const SOL = 'gpt-6.1-sol';
// 0.9.1: a model the account lists but Kenlith has not reviewed for web search.
const UNKNOWN = 'gpt-7-nova';
const VERIFIED_090_1 = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const MODELS = [
  { slug: SOL, display_name: 'GPT-6.1-Sol', visibility: 'list' },
  { slug: ASTRA, display_name: 'GPT-6-Astra', visibility: 'list' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' },
  { slug: UNKNOWN, display_name: 'GPT-7-Nova', visibility: 'list' }
];
// The live account list of 2026-11-14 (eight listed models, two hidden), plus one unreviewed model.
const LIVE_MODELS_091 = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-astra', 'GPT-6-Astra'], ['gpt-6.1-terra', 'GPT-6.1 Terra'], ['gpt-6-sol', 'GPT-6-Sol'],
  ['gpt-reserve', 'GPT-Reserve', 'hide'], ['gpt-6-luna', 'GPT-6-Luna'], ['gpt-5.6-sol', 'GPT-5.6-Sol'], ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'], ['codex-auto-review', 'Codex Auto Review', 'hide'], [UNKNOWN, 'GPT-7-Nova']
].map(([slug, name, visibility = 'list']) => ({ slug, display_name: name, visibility }));
const KEYS_080 = ['input', 'instructions', 'model', 'store', 'stream'];
// 0.10.0 Path A: a general-chat request to a verified model also offers hosted web search, tool_choice auto.
const KEYS_0100 = [...KEYS_080, 'tool_choice', 'tools'].sort();
const isPathA = (body) => JSON.stringify(body.tools) === JSON.stringify([{ type: 'web_search' }]) && body.tool_choice === 'auto' && !Object.hasOwn(body, 'parallel_tool_calls');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-090', 'live-run2-stream.json'), 'utf8'));
const LIVE_ANNOTATIONS = FIXTURE.events.filter((e) => e.type === 'response.output_text.annotation.added').map((e) => e.annotation);
const DEFAULT_TIMEOUT = research.RESEARCH_TIMEOUT_MS;

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
  research.RESEARCH_TIMEOUT_MS = DEFAULT_TIMEOUT;
});

// The fake model: `script(body, n)` returns a Response, or { text } for a plain answer.
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

// A research stream that sends `events`, then stays open until aborted.
function hangingEvents(events, signal) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// A small research stream: one search, an answer with one cited link.
function smallResearch(text = 'Node.js 26 is LTS ([nodejs.org](https://nodejs.org/en/about/previous-releases)).', { extra = [] } = {}) {
  const start = text.indexOf('(');
  const end = text.length - 1;
  return [
    { type: 'response.created' },
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
    { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
    { type: 'response.web_search_call.completed', item_id: 'ws_1' },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'node lts', sources: [{ type: 'url', url: 'https://consulted.example/only-consulted' }] } } },
    ...extra,
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_text.annotation.added', item_id: 'msg_1', annotation: { type: 'url_citation', start_index: start, end_index: end, url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js Releases' } },
    { type: 'response.metadata', metadata: {}, response_id: 'resp_1' },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ];
}

async function openWindow({ storageDir = makeTempDir() } = {}) {
  const context = createContext({ storageDir });
  const session = { email: 'synthetic.user@example.test', subject: 'user-1', scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, getAccessToken: async () => 'synthetic-access', signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const store = new ConversationStore(context);
  const opened = [];
  const engine = new ChatEngine(context, auth, new OpenAIService(auth), store, { writeClipboard: async () => {}, openExternal: async (url) => { opened.push(url); } });
  await engine.prepare();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const wrap = (id, panel) => {
    const posted = (type) => panel.posted.filter((message) => message.type === type);
    return {
      id,
      panel,
      posted,
      // research: true (default), false, or 'omit' (no field, as from a 0.8.0 page).
      send: (text, { model: chosen = ASTRA, effort, research: on = true, attachmentId } = {}) => panel.send({ type: 'send', text, model: chosen, effort, attachmentId, ...(on === 'omit' ? {} : { research: on }) }),
      decide: (choice) => panel.send({ type: 'consentDecision', choice }),
      stop: () => panel.send({ type: 'stop' }),
      card: () => posted('consent').at(-1)?.consent,
      banners: () => posted('error').filter((m) => m.message),
      restored: () => posted('restoreDraft').map((m) => m.text),
      progress: () => posted('researchProgress')
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
  const messages = async (id) => (await store.getConversation(id)).messages;
  return { context, store, engine, panels, tab, messages, storageDir, opened };
}

function projectFolder() {
  const base = makeTempDir();
  const directory = path.join(base, 'calc');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('README.md', '# Calculator\n\nAdds numbers. The entry point is src/calculator.js. PROJECT_MARKER_7Q\n');
  write('src/calculator.js', 'function addAll(list) {\n  return list.reduce((sum, value) => sum + value, 0);\n}\nmodule.exports = { addAll };\n');
  write('.env', 'API_KEY=RESEARCH_SECRET_93X\n');
  return directory;
}

async function waitFor(predicate, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 15)); }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Policy and request shape

test('DR-01 policy (0.9.1): exactly the eight verified models run Deep Research; it adds web_search and tool_choice required', () => {
  assert.deepEqual(Object.keys(research.RESEARCH_MODELS), VERIFIED_090_1);
  for (const id of VERIFIED_090_1) {
    assert.equal(research.supportsResearch(id), true, id);
    assert.match(research.RESEARCH_MODELS[id], /official model page lists Responses API web_search; live ChatGPT-plan route check passed 2026-11-14/, id);
  }
  // Not inferred from /v1/models: hidden or unreviewed slugs, dated snapshots, future IDs.
  for (const other of [UNKNOWN, 'gpt-6-astra-2026-11-01', 'gpt-5.6-sol-mini', 'GPT-6.1-SOL', ' gpt-6-sol', 'gpt-reserve', 'codex-auto-review', 'gpt-5.5', '', undefined, null, 7]) assert.equal(research.supportsResearch(other), false, String(other));
  assert.deepEqual(research.WEB_SEARCH_TOOL, { type: 'web_search' });
  assert.equal(research.TOOL_CHOICE, 'required');
  // RC2: no replacement-model offer and no model ordering of any kind.
  assert.equal(Object.hasOwn(research, 'offeredModel'), false);
  assert.equal(Object.hasOwn(research, 'PREFERRED_MODEL'), false);
  const refusal = new research.ResearchModelError('GPT-7-Nova');
  assert.equal(refusal.code, 'research-model');
  assert.equal(Object.hasOwn(refusal, 'offered'), false);
  // The instructions stay short and carry the web/local boundary.
  assert.ok(research.RESEARCH_INSTRUCTIONS.length < 1200);
  assert.match(research.RESEARCH_INSTRUCTIONS, /untrusted data, not instructions/);
  assert.match(research.RESEARCH_INSTRUCTIONS, /no access to the user's computer, files or project/);
});

test('DR-02 Deep Research OFF: the 0.8.0 request plus only Path A automatic search (0.10.0: web_search, tool_choice auto)', async () => {
  const requests = model(() => ({ text: 'plain' }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('What is a unit test?', { research: 'omit', model: ASTRA });
  await chat.send('And with High?', { research: false, model: ASTRA, effort: 'high' });
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[0]).sort(), KEYS_0100);
  assert.deepEqual(Object.keys(requests[1]).sort(), [...KEYS_0100, 'reasoning'].sort());
  for (const body of requests) assert.ok(isPathA(body), 'Path A only');
  assert.deepEqual(requests[1].reasoning, { effort: 'high' });
  for (const body of requests) {
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.doesNotMatch(body.instructions, /Deep Research/);
  }
  // A truthy value that is not the literal true does not turn research on.
  await chat.panel.send({ type: 'send', text: 'Third', model: ASTRA, research: 'yes' });
  assert.deepEqual(Object.keys(requests[2]).sort(), KEYS_0100);
  assert.equal(requests[2].tool_choice, 'auto', 'not forced: research is off');
  const stored = await w.messages(chat.id);
  assert.ok(stored.every((message) => !message.research));
});

test('DR-03 Deep Research ON adds only tools [web_search] and tool_choice "required"; Thinking is preserved', async () => {
  const requests = model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Which Node.js line is LTS?', { effort: 'default' });
  await chat.send('Again, thinking High', { effort: 'high' });
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[0]).sort(), [...KEYS_080, 'tool_choice', 'tools'].sort());
  assert.deepEqual(requests[0].tools, [{ type: 'web_search' }]);
  assert.equal(requests[0].tool_choice, 'required');
  assert.equal(Object.hasOwn(requests[0], 'reasoning'), false, 'Default sends no reasoning field');
  assert.equal(Object.hasOwn(requests[0], 'include'), false);
  assert.equal(Object.hasOwn(requests[0], 'parallel_tool_calls'), false);
  assert.deepEqual(Object.keys(requests[1]).sort(), [...KEYS_080, 'reasoning', 'tool_choice', 'tools'].sort());
  assert.deepEqual(requests[1].reasoning, { effort: 'high' });
  for (const body of requests) {
    assert.equal(body.model, ASTRA);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    for (const field of ['background', 'max_tool_calls', 'max_output_tokens', 'metadata', 'previous_response_id', 'temperature', 'truncation', 'user']) assert.equal(Object.hasOwn(body, field), false, field);
    assert.match(body.instructions, /Deep Research mode/);
    assert.ok(!body.input.some((item) => item.role === 'system'));
  }
});

test('DR-04 (0.9.1 RC2) a model not in the table: refused locally, nothing sent, the model stays selected, the text and Deep Research come back, no replacement offered', async () => {
  const requests = model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  const chat = await w.tab();
  const postedBefore = chat.panel.posted.length;
  await chat.send('Research this with Nova', { model: UNKNOWN });
  assert.equal(requests.length, 0, 'no request');
  assert.deepEqual(chat.restored(), ['Research this with Nova'], 'the message text comes back unchanged');
  const banner = chat.banners().at(-1);
  assert.equal(banner.message, 'Deep Research has not been verified for "GPT-7-Nova". Choose a supported model in the Model selector, or turn Deep Research off. Nothing was sent.');
  assert.doesNotMatch(banner.message, /Astra|GPT-6|GPT-5|such as/);
  assert.equal(banner.action, undefined, 'no action');
  assert.equal(Object.hasOwn(banner, 'model'), false, 'no model offered');
  // The selection stays the user's: stored, and in every state the page received afterwards.
  assert.equal(w.context.globalState.get('planChat.selectedModel.v1'), UNKNOWN);
  const later = chat.panel.posted.slice(postedBefore);
  for (const message of later) {
    if (Object.hasOwn(message, 'selectedModel')) assert.equal(message.selectedModel, UNKNOWN, message.type);
    if (Object.hasOwn(message, 'model')) assert.ok(message.model === undefined || message.model === UNKNOWN || message.model?.id === UNKNOWN, message.type);
  }
  assert.equal((await w.messages(chat.id)).length, 0, 'nothing stored');
  // The page: a refused Deep Research Send turns the chip back on for that text,
  // and the banner carries no button (no "Use …").
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  // 0.10.0: the mode the refused Send carried comes back (Deep Research here).
  assert.ok(page.includes("if (state.researchAwaiting && message.text === state.researchText && !elements.prompt.value) setWebMode(state.awaitingMode || 'deep-research');"), 'Deep Research comes back on with the refused text');
  assert.doesNotMatch(page, /research-model-action|researchModel/);
  // The same with only unsupported models listed.
  server.models = [{ slug: UNKNOWN, display_name: 'GPT-7-Nova', visibility: 'list' }];
  const w2 = await openWindow();
  const chat2 = await w2.tab();
  await chat2.send('Research', { model: UNKNOWN });
  assert.equal(chat2.banners().at(-1).action, undefined);
  assert.equal(chat2.banners().at(-1).message, banner.message);
  assert.equal(requests.length, 0);
});

test('DR-05 the builder refuses research with attached code, excerpts, project tools or project-derived history', () => {
  const base = { instructions: 'i', history: [], text: 'q', model: ASTRA, research: true };
  assert.ok(buildRequest(base).research);
  assert.throws(() => buildRequest({ ...base, model: UNKNOWN }), /not available for this model/);
  for (const id of VERIFIED_090_1) assert.equal(buildRequest({ ...base, model: id }).research.model, id, id);
  assert.throws(() => buildRequest({ ...base, attachment: { text: 'x', chars: 1 } }), /never project files or attached code/);
  assert.throws(() => buildRequest({ ...base, excerpts: [{ relPath: 'a', startLine: 1, endLine: 1, text: 'x', fileSha256: 'f' }] }), /never project files/);
  assert.throws(() => buildRequest({ ...base, tools: [{ type: 'function', name: 'project_read_file' }] }), /never project files/);
  assert.throws(() => buildRequest({ ...base, history: [{ role: 'assistant', content: 'x', projectDerived: true }] }), /earlier answers that used project files/);
  const built = buildRequest(base);
  assert.equal(built.tools, undefined, 'no project tools');
  assert.equal(built.requiresGate, false);
  assert.deepEqual(built.research.tools, [{ type: 'web_search' }]);
});

test('DR-06 the transport refuses a research request for another model before anything is sent', async () => {
  const requests = model(() => ({ events: smallResearch() }));
  const auth = { getAccessToken: async () => 'synthetic-access' };
  const service = new OpenAIService(auth);
  const request = buildRequest({ instructions: 'i', history: [], text: 'q', model: ASTRA, research: true });
  await assert.rejects(service.streamResponse({ model: SOL, request, onDelta: () => {} }), /not built for this model/);
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// Streaming (the recorded live sequence)

test('DR-07 the live run-2 sequence: text and citations come from the stream; completed.output is empty; metadata is ignored', async () => {
  const requests = model(() => ({ events: FIXTURE.events }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Compare Node.js, Deno and Bun release schedules', { effort: 'high' });
  assert.equal(requests.length, 1);
  const [question, answer] = await w.messages(chat.id);
  assert.equal(question.content, 'Compare Node.js, Deno and Bun release schedules');
  assert.equal(answer.content, FIXTURE.text, 'the streamed text, exactly');
  assert.equal(answer.error, undefined);
  assert.equal(answer.inProgress, undefined);
  assert.equal(answer.research.mode, 'deep-research');
  assert.equal(answer.research.searches, 2);
  assert.equal(answer.research.pagesRead, 3);
  assert.equal(answer.research.citations.length, 7);
  assert.ok(answer.research.citations.every((c) => Number.isInteger(c.start) && c.end > c.start));
  assert.deepEqual(answer.research.citations.map((c) => c.url), LIVE_ANNOTATIONS.map((a) => a.url));
  for (const c of answer.research.citations) assert.ok(answer.content.slice(c.start, c.end).includes(c.url), 'each place covers its link');
  // Only what is needed: no consulted-source list, queries, reasoning or raw events.
  assert.deepEqual(Object.keys(answer.research).sort(), ['citations', 'mode', 'pagesRead', 'searches']);
  assert.ok(answer.research.citations.every((c) => Object.keys(c).sort().join() === 'end,start,title,url'));
  // Observable progress, in order, never a percentage.
  const phases = chat.progress().map((m) => m.phase);
  const order = [...new Set(phases)];
  assert.deepEqual(order, ['preparing', 'searching', 'reading', 'synthesizing']);
  assert.ok(chat.progress().every((m) => !('percent' in m) && !('reasoning' in m)));
  const final = chat.posted('messageUpdated').at(-1);
  assert.equal(final.research.citations.length, 7);
});

test('DR-08 unknown and undocumented stream events are ignored; a function_call item from the web is not run', async () => {
  const requests = model(() => ({ events: smallResearch(undefined, { extra: [
    { type: 'response.future_event', anything: { nested: true } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'x1', name: 'project_run_command', arguments: '{"program":"rm","args":["-rf","/"]}' } },
    { type: 'response.reasoning_summary_text.delta', delta: 'hidden thoughts' },
    { notJson: true }
  ] }) }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research with noise');
  assert.equal(requests.length, 1, 'no continuation was sent: no tool ran');
  const answer = (await w.messages(chat.id))[1];
  assert.equal(answer.error, undefined);
  assert.doesNotMatch(answer.content, /hidden thoughts/);
  assert.equal(answer.research.citations.length, 1);
});

test('DR-09 a research reply in which no web search completed fails; it is not shown as a research answer', async () => {
  const requests = model(() => ({ events: [
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', delta: 'An answer from memory.' },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ] }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research without search');
  assert.equal(requests.length, 1, 'not retried');
  const answer = (await w.messages(chat.id))[1];
  assert.equal(answer.error, true);
  assert.equal(answer.research.mode, 'deep-research');
  assert.match(chat.posted('messageUpdated').at(-1).errorText, /without a completed web search/);
});

// ---------------------------------------------------------------------------
// Citation mapping

test('DR-10 Arabic: every live citation maps with UTF-16 offsets onto its link', () => {
  const placed = placeCitations(FIXTURE.text, LIVE_ANNOTATIONS);
  assert.equal(placed.citations.length, 7);
  assert.equal(placed.unplaced, 0);
  assert.equal(placed.codepoint, 0);
  for (const c of placed.citations) assert.match(FIXTURE.text.slice(c.start, c.end), /^\(\[[^\]]+\]\(https:\/\/[^)]+\)\)$/);
});

test('DR-11 characters outside the BMP before and inside a citation: UTF-16 or code-point offsets, whichever validates', () => {
  const link = '([news 🟢 site](https://news.example/a?utm_source=openai))';
  const text = `🚀 Rocket 🚀 launched today ${link} and more.`;
  const start16 = text.indexOf(link);
  const end16 = start16 + link.length;
  const points = [...text];
  const startCp = [...text.slice(0, start16)].length;
  const endCp = startCp + [...link].length;
  assert.notEqual(startCp, start16, 'the offsets really differ');
  const url = 'https://news.example/a?utm_source=openai';
  const as16 = placeCitations(text, [{ type: 'url_citation', start_index: start16, end_index: end16, url, title: 'News' }]);
  assert.deepEqual([as16.citations[0].start, as16.citations[0].end, as16.codepoint], [start16, end16, 0]);
  const asCp = placeCitations(text, [{ type: 'url_citation', start_index: startCp, end_index: endCp, url, title: 'News' }]);
  assert.deepEqual([asCp.citations[0].start, asCp.citations[0].end, asCp.codepoint], [start16, end16, 1], 'mapped back to UTF-16');
  assert.equal(points.slice(startCp, endCp).join(''), link);
  assert.deepEqual(codePointOffsets('a🟢b'), [0, 1, 3, 4]);
  // One character off in either unit does not validate.
  for (const [s, e] of [[start16 + 1, end16], [start16, end16 - 1], [start16 - 1, end16 - 1]]) {
    assert.equal(placeCitations(text, [{ type: 'url_citation', start_index: s, end_index: e, url, title: 'News' }]).unplaced, 1, `${s}-${e}`);
  }
  // An address that itself ends in a parenthesised part.
  const wiki = 'See ([en.wikipedia.org](https://en.wikipedia.org/wiki/Bun_(software))).';
  const w0 = wiki.indexOf('([');
  const wc = placeCitations(wiki, [{ type: 'url_citation', start_index: w0, end_index: wiki.length - 1, url: 'https://en.wikipedia.org/wiki/Bun_(software)', title: 'Bun' }]);
  assert.equal(wc.unplaced, 0);
  const bare = 'Source: https://a.example/p and more';
  const b0 = bare.indexOf('https');
  assert.equal(placeCitations(bare, [{ type: 'url_citation', start_index: b0, end_index: b0 + 'https://a.example/p'.length, url: 'https://a.example/p', title: 'A' }]).unplaced, 0);
});

test('DR-12 offsets that cannot be proven fail safely: no place, text unchanged, still listed as a source', () => {
  const text = 'Claim one ([a.example](https://a.example/x)). 🟢 Claim two.';
  const good = { type: 'url_citation', start_index: text.indexOf('(['), end_index: text.indexOf(')).') + 2, url: 'https://a.example/x', title: 'A' };
  const cases = [
    { ...good, start_index: 500, end_index: 520 },
    { ...good, start_index: 5, end_index: 5 },
    { ...good, start_index: -1 },
    { ...good, start_index: '3' },
    { ...good, url: 'https://other.example/y' },
    { ...good, start_index: text.indexOf('🟢') + 1, end_index: text.indexOf('🟢') + 2 }
  ];
  for (const annotation of cases) {
    const placed = placeCitations(text, [annotation]);
    assert.equal(placed.unplaced, placed.citations.length, JSON.stringify(annotation));
    const doc = createDocument();
    const html = serialize(md.renderCited(doc, text, placed.citations));
    assert.equal(serialize(md.renderCited(doc, text, placed.citations)), serialize(md.render(doc, text)), 'rendered as plain Markdown');
    assert.ok(!html.includes('class="citation"'));
  }
  // Overlap: the first in the text keeps its place.
  const overlap = placeCitations(text, [good, { ...good, start_index: good.start_index + 1 }]);
  assert.equal(overlap.citations.filter((c) => Number.isInteger(c.start)).length, 1);
  // Malformed: other kinds, unsafe or missing addresses.
  const bad = placeCitations(text, [null, 'x', { type: 'file_citation', file_id: 'f' }, { ...good, url: 'javascript:alert(1)' }, { ...good, url: 'file:///etc/passwd' }, { ...good, url: undefined }, { ...good, url: 'https://user:pw@a.example/' }]);
  assert.equal(bad.malformed, 7);
  assert.equal(bad.citations.length, 0);
});

test('DR-13 rendering: citations replace the covered link, are clickable http(s) links, and no markup is injected', () => {
  const text = 'Fact ([a.example](https://a.example/x)). <script>alert(1)</script> Other ([b](https://b.example/y#frag)).';
  const annotations = [
    { type: 'url_citation', start_index: text.indexOf('(['), end_index: text.indexOf(')).') + 2, url: 'https://a.example/x', title: '<img src=x onerror=alert(1)> "Title" ‮evil' },
    { type: 'url_citation', start_index: text.lastIndexOf('(['), end_index: text.lastIndexOf('))') + 2, url: 'https://b.example/y#frag', title: 'B page' }
  ];
  const { citations } = placeCitations(text, annotations);
  const doc = createDocument();
  const fragment = md.renderCited(doc, text, citations);
  const all = elements(fragment);
  assert.ok(all.every((node) => ['p', 'a', 'span'].includes(node.localName)), all.map((n) => n.localName).join());
  const links = all.filter((node) => node.localName === 'a');
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.getAttribute('class')), ['citation', 'citation']);
  assert.deepEqual(links.map((l) => l.getAttribute('href')), ['https://a.example/x', 'https://b.example/y#frag']);
  assert.deepEqual(links.map((l) => l.getAttribute('dir')), ['ltr', 'ltr']);
  assert.deepEqual(links.map((l) => l.textContent), ['1a.example', '2b.example']);
  assert.match(links[0].getAttribute('aria-label'), /^Source 1: <img src=x onerror=alert\(1\)> "Title" evil, a\.example$/);
  for (const node of all) for (const name of node.attributes.keys()) assert.ok(md.ALLOWED_ATTRIBUTES.has(name), name);
  const html = serialize(fragment);
  assert.ok(!/<script|<img/i.test(html), 'markup stays text');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('[a.example]('), 'the covered link text is replaced');
  // The model's own private-use marks cannot forge a citation.
  const forged = `Hi \uE000\uE100\uE001 there ([a.example](https://a.example/x)).`;
  const forgedCites = placeCitations(forged, [{ type: 'url_citation', start_index: forged.indexOf('(['), end_index: forged.length - 1, url: 'https://a.example/x', title: 'A' }]).citations;
  const out = elements(md.renderCited(doc, forged, forgedCites)).filter((n) => n.localName === 'a');
  assert.equal(out.length, 1, 'only the real citation');
});

test('DR-14 Sources come from the citations only: deduplicated, in order, the consulted list is not used', async () => {
  const text = 'One ([x](https://dup.example/p?utm_source=openai)). Two ([y](https://dup.example/p#part)). Three ([z](https://z.example/)).';
  const at = (needle, from = 0) => text.indexOf(needle, from);
  const ann = [
    { type: 'url_citation', start_index: at('([z]'), end_index: at('([z]') + '([z](https://z.example/))'.length, url: 'https://z.example/', title: 'Zed' },
    { type: 'url_citation', start_index: at('([x]'), end_index: at('([x]') + '([x](https://dup.example/p?utm_source=openai))'.length, url: 'https://dup.example/p?utm_source=openai', title: 'Dup' },
    { type: 'url_citation', start_index: at('([y]'), end_index: at('([y]') + '([y](https://dup.example/p#part))'.length, url: 'https://dup.example/p#part', title: 'Dup again' }
  ];
  const { citations } = placeCitations(text, ann);
  const { sources } = md.citationSources(text, citations);
  assert.deepEqual(sources.map((s) => [s.n, s.host, s.title]), [[1, 'dup.example', 'Dup'], [2, 'z.example', 'Zed']]);
  // In a run, the consulted URL from web_search_call.action.sources is never stored or shown.
  model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research');
  const stored = JSON.stringify(await w.messages(chat.id));
  assert.ok(!stored.includes('consulted.example'));
  assert.ok(!JSON.stringify(chat.panel.posted).includes('consulted.example'));
});

// ---------------------------------------------------------------------------
// Persistence and restart

test('DR-15 citations persist: a new window on the same storage restores them; old messages load unchanged', async () => {
  model(() => ({ events: FIXTURE.events }));
  const storageDir = makeTempDir();
  const w = await openWindow({ storageDir });
  const chat = await w.tab();
  await chat.send('Compare runtimes');
  const before = await w.messages(chat.id);
  const again = new ConversationStore(createContext({ storageDir }));
  const after = (await again.getConversation(chat.id)).messages;
  assert.deepEqual(after[1].research, before[1].research);
  assert.equal(after[1].content, FIXTURE.text);
  // Rendering after the restart uses the stored offsets.
  const links = elements(md.renderCited(createDocument(), after[1].content, after[1].research.citations)).filter((n) => n.getAttribute('class') === 'citation');
  assert.equal(links.length, 7);
  // A 0.8.0 chat record (no research field) is read as it is, and never rewritten.
  const file = fs.readdirSync(storageDir, { recursive: true }).map((f) => path.join(storageDir, f)).find((f) => /conversations.*\.json$|history.*\.json$/.test(f) && fs.statSync(f).isFile());
  assert.ok(file, 'history file');
  const old = { role: 'assistant', id: 'old-1', content: 'An 0.8.0 answer', createdAt: '2026-11-13T00:00:00.000Z' };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.conversations.find((c) => c.id === chat.id).messages.push(old);
  fs.writeFileSync(file, JSON.stringify(state));
  const third = new ConversationStore(createContext({ storageDir }));
  const loaded = (await third.getConversation(chat.id)).messages.at(-1);
  assert.deepEqual(loaded, old);
});

test('DR-16 Stop aborts the research request; the run is kept as stopped (with no answer claimed); nothing is retried', async () => {
  let signal;
  const requests = model((body, n, request) => { signal = request.signal; return hangingEvents(smallResearch().slice(0, 5), request.signal); });
  const w = await openWindow();
  const chat = await w.tab();
  const sending = chat.send('Long research');
  await waitFor(() => chat.progress().some((m) => m.phase === 'searching'), 'searching');
  await chat.stop();
  await sending;
  assert.equal(signal.aborted, true, 'the stream was aborted');
  assert.equal(requests.length, 1, 'no retry');
  const answer = (await w.messages(chat.id))[1];
  assert.equal(answer.stopped, true);
  assert.equal(answer.content, '');
  assert.equal(answer.research.mode, 'deep-research');
  assert.equal(answer.research.searches, 1);
  assert.equal(answer.error, undefined);
  // A stopped run without text is not sent as history.
  model(() => ({ text: 'next' }));
  const next = model(() => ({ text: 'next' }));
  await chat.send('Plain follow-up', { research: false });
  assert.ok(!next[0].input.some((item) => item.role === 'assistant'));
});

test('DR-17 an editor quit during research: interrupted after restart, the question kept, nothing re-sent automatically', async () => {
  const requests = model((body, n, request) => hangingEvents(smallResearch().slice(0, 5), request.signal));
  const storageDir = makeTempDir();
  const w = await openWindow({ storageDir });
  const chat = await w.tab();
  const sending = chat.send('Research before quitting');
  await waitFor(() => chat.progress().some((m) => m.phase === 'searching'), 'searching');
  w.engine.dispose();
  await sending.catch(() => undefined);
  await waitFor(async () => (await w.messages(chat.id))[1]?.interrupted === true, 'interrupted');
  const w2 = await openWindow({ storageDir });
  const reopened = await w2.panels.openChat(chat.id).then(() => calls.panels.at(-1));
  await reopened.send({ type: 'ready' });
  const shown = reopened.posted.filter((m) => (m.type === 'conversation' || m.type === 'hydrate') && m.conversation).at(-1).conversation.messages;
  assert.equal(shown[0].content, 'Research before quitting');
  assert.equal(shown[1].interrupted, true);
  assert.equal(shown[1].research.mode, 'deep-research');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, 1, 'no automatic second request');
});

test('DR-18 Retry is explicit: the page puts the question back with Deep Research on and posts nothing', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  const body = /function retryResearch\(messageId\) \{([\s\S]*?)\n    \}/.exec(page);
  assert.ok(body, 'retryResearch exists');
  assert.doesNotMatch(body[1], /post\(/, 'Retry sends nothing by itself');
  assert.match(body[1], /setResearch\(true\)/);
  assert.match(page, /button\[data-research-retry\]/);
  // Shown only for a run that did not complete.
  assert.match(page, /if \(item\.error \|\| item\.stopped \|\| item\.interrupted\) \{\s*const retry/);
});

// ---------------------------------------------------------------------------
// Errors

test('DR-19 usage limit and capability refusals: shown as failures, never as research answers, not retried', async () => {
  const usage = model(() => ({ events: [
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1' } },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }
  ] }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research at the limit');
  assert.equal(usage.length, 1);
  let answer = (await w.messages(chat.id))[1];
  assert.equal(answer.error, true);
  assert.deepEqual(answer.research.citations, []);
  assert.equal(chat.posted('messageUpdated').at(-1).action, 'manageUsage');
  // Capability refusal (HTTP 400 before the stream): one request, research explanation.
  const refused = model(() => ({ status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'unsupported', param: 'tools' } } }));
  const w2 = await openWindow();
  const chat2 = await w2.tab();
  await chat2.send('Research refused', { effort: 'high' });
  assert.equal(refused.length, 1, 'not retried without tools or without research');
  answer = (await w2.messages(chat2.id))[1];
  assert.equal(answer.error, true);
  assert.match(answer.content, /did not accept this Deep Research request/);
  assert.match(answer.content, /did not answer without searching the web/);
  assert.equal(chat2.posted('messageUpdated').at(-1).action, 'effortDefault');
  // Network failure.
  server.responsesHandler = () => { throw new TypeError('fetch failed'); };
  const w3 = await openWindow();
  const chat3 = await w3.tab();
  await chat3.send('Research offline');
  answer = (await w3.messages(chat3.id))[1];
  assert.equal(answer.error, true);
  assert.equal(answer.research.mode, 'deep-research');
});

test('DR-20 the research time limit ends the request as a failure (not a Stop), without a retry', async () => {
  research.RESEARCH_TIMEOUT_MS = 120;
  const requests = model((body, n, request) => hangingEvents(smallResearch().slice(0, 5), request.signal));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Slow research');
  assert.equal(requests.length, 1);
  const answer = (await w.messages(chat.id))[1];
  assert.equal(answer.error, true);
  assert.equal(answer.stopped, undefined);
  assert.match(answer.content, /did not finish within 1 minutes|did not finish within/);
  assert.match(answer.content, /did not retry/);
});

// ---------------------------------------------------------------------------
// Privacy and security

test('DR-21 a project chat with sharing allowed: research sends no excerpt, tool, secret or earlier project answer', async () => {
  setWorkspaceFolders([projectFolder()]);
  const requests = model((body) => (body.tools && body.tools[0]?.type === 'web_search' ? { events: smallResearch() } : { text: 'calc answer PROJECT_ANSWER_5K' }));
  const w = await openWindow();
  const chat = await w.tab();
  // An ordinary question shares project excerpts after Allow (0.8.0 behaviour).
  await chat.send('How does addAll in the calculator work? PROJECT_MARKER_7Q', { research: false, model: ASTRA });
  assert.ok(chat.card(), 'the sharing card');
  await chat.decide('allow');
  assert.equal(requests.length, 1);
  assert.ok(JSON.stringify(requests[0]).includes('src/calculator.js'), 'excerpts went with the ordinary question');
  // Now Deep Research in the same project chat, with the grant active.
  const cards = chat.posted('consent').length;
  await chat.send('Research the history of Array.prototype.reduce in addAll');
  assert.equal(requests.length, 2);
  const body = requests[1];
  const text = JSON.stringify(body);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.ok(!text.includes('calculator.js'), 'no excerpt');
  assert.ok(!text.includes('module.exports'), 'no file text');
  assert.ok(!text.includes('RESEARCH_SECRET_93X'), 'no secret');
  assert.ok(!text.includes('PROJECT_ANSWER_5K'), 'the earlier project-derived answer is not replayed');
  assert.ok(!text.includes('project_'), 'no project tool');
  assert.equal(chat.posted('consent').length, cards, 'no sharing card');
  const answer = (await w.messages(chat.id)).at(-1);
  assert.equal(answer.provenance, undefined, 'not project-derived');
});

test('DR-22 research never carries attached code', async () => {
  const requests = model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research with code', { attachmentId: 'att-1' });
  assert.equal(requests.length, 0);
  assert.match(chat.banners().at(-1).message, /never attached code/);
  assert.deepEqual(chat.restored(), ['Research with code']);
});

test('DR-23 citation links open only through the existing confirm-first opener', async () => {
  model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  const chat = await w.tab();
  calls.warningChoice = 'Open Link';
  await chat.panel.send({ type: 'openLink', url: 'https://nodejs.org/en/about/previous-releases' });
  assert.deepEqual(w.opened, ['https://nodejs.org/en/about/previous-releases']);
  await chat.panel.send({ type: 'openLink', url: 'javascript:alert(1)' });
  assert.equal(w.opened.length, 1);
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  // Citations are ordinary a[href] elements, handled by openLinkFrom (post('openLink')).
  assert.match(page, /const link = event\.target\.closest && event\.target\.closest\('a\[href\]'\);/);
});

// ---------------------------------------------------------------------------
// The page

test('DR-24 the page: one + item, a compact chip that turns it off, a one-shot research flag, nothing else changed', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.match(page, /<button id="researchChip" class="research-chip" type="button" aria-pressed="true" aria-describedby="researchHint"/);
  assert.match(page, /<div id="researchRow" class="research-row hidden">/);
  // The bar keeps +, Model, Thinking, Stop and Send; the chip is not in it.
  const bar = /<div id="composerBar"[^>]*>([\s\S]*?)<div id="effortNote"/.exec(page)[1];
  assert.doesNotMatch(bar, /researchChip/);
  for (const id of ['plus', 'modelSlot', 'stop', 'send']) assert.match(bar, new RegExp(`id="${id}"`));
  // Send carries research (or, 0.10.0, search) only as true, only when on, never both; then it turns off.
  assert.match(page, /\.\.\.\(research \? \{ research: true \} : search \? \{ search: true \} : \{\}\)/);
  // A refused Send turns its mode back on, only for that same text, into an empty box; the wait always ends.
  assert.match(page, /if \(state\.researchAwaiting && message\.text === state\.researchText && !elements\.prompt\.value\) setWebMode\(state\.awaitingMode \|\| 'deep-research'\);\s*state\.researchAwaiting = false;/);
  assert.match(page, /if \(webMode\) \{ state\.researchAwaiting = true; state\.researchText = text; state\.awaitingMode = webMode; setWebMode\(undefined\); \}/);
  // The menu item reports its state to assistive technology.
  assert.match(page, /elements\.menuResearch\.setAttribute\('aria-checked', String\(state\.research\)\)/);
  // No percentage, no reasoning text in the research status.
  assert.doesNotMatch(page, /research[^\n]*percent/i);
});

test('DR-25 RTL: citations and source addresses are isolated left-to-right inside an Arabic answer', () => {
  const placed = placeCitations(FIXTURE.text, LIVE_ANNOTATIONS).citations;
  const fragment = md.renderCited(createDocument(), FIXTURE.text, placed);
  const all = elements(fragment);
  const paragraphs = all.filter((n) => n.localName === 'p');
  assert.ok(paragraphs.length >= 3);
  assert.ok(paragraphs.every((p) => p.getAttribute('dir') === 'auto'));
  const cites = all.filter((n) => n.getAttribute('class') === 'citation');
  assert.equal(cites.length, 7);
  assert.ok(cites.every((c) => c.getAttribute('dir') === 'ltr'));
  // The Arabic words around the citations are intact.
  const text = fragment.childNodes ? all.map((n) => n.textContent).join(' ') : '';
  assert.match(text, /أحدث إصدار مستقر/);
  const page = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  assert.match(page, /host\.dir = 'ltr';/);
  assert.match(page, /address\.dir = 'ltr';/);
  assert.match(page, /link\.dir = 'auto';/);
});

// ---------------------------------------------------------------------------
// Independent review (2026-11-14) follow-ups

test('DR-26 overlapping places from stored or tampered data: the page keeps only non-overlapping ones', () => {
  const text = 'A https://x.y/https://z.com and more';
  const cites = [
    { url: 'https://x.y/https://z.com', title: 'X', start: 2, end: 27 },
    { url: 'https://x.y/https://z.com', title: 'X', start: 2, end: 15 },
    { url: 'https://z.com/', title: 'Z', start: 15, end: 28 }
  ];
  const kept = md.placeable(text, cites);
  for (let i = 1; i < kept.length; i += 1) assert.ok(kept[i].start >= kept[i - 1].end, 'no overlap');
  const links = elements(md.renderCited(createDocument(), text, cites)).filter((n) => n.getAttribute('class') === 'citation');
  assert.equal(links.length, 1);
});

test('DR-27 a citation right after a bare address is still drawn; the address stays a plain link', () => {
  const text = 'See https://example.com/a([b.example](https://b.example/)) now.';
  const start = text.indexOf('([b');
  const cites = placeCitations(text, [{ type: 'url_citation', start_index: start, end_index: start + '([b.example](https://b.example/))'.length, url: 'https://b.example/', title: 'B' }]).citations;
  const links = elements(md.renderCited(createDocument(), text, cites)).filter((n) => n.localName === 'a');
  assert.deepEqual(links.map((l) => [l.getAttribute('class'), l.getAttribute('href')]), [[null, 'https://example.com/a'], ['citation', 'https://b.example/']]);
});

test('DR-28 a cited link inside code is shown as its own text, not as a token', () => {
  const text = 'Run `([a.example](https://a.example/x))` now.\n\n```\n([a.example](https://a.example/x))\n```';
  const s1 = text.indexOf('([');
  const s2 = text.lastIndexOf('([');
  const len = '([a.example](https://a.example/x))'.length;
  const cites = placeCitations(text, [
    { type: 'url_citation', start_index: s1, end_index: s1 + len, url: 'https://a.example/x', title: 'A' },
    { type: 'url_citation', start_index: s2, end_index: s2 + len, url: 'https://a.example/x', title: 'A' }
  ]).citations;
  const fragment = md.renderCited(createDocument(), text, cites);
  const html = serialize(fragment);
  assert.ok(!/[\uE000-\uF8FF]/.test(html), 'no private-use mark is shown');
  const codes = elements(fragment).filter((n) => n.localName === 'code');
  assert.ok(codes.length >= 2);
  for (const code of codes) assert.equal(code.textContent.trim(), '([a.example](https://a.example/x))');
  const copy = elements(fragment).find((n) => n.getAttribute('data-copy') !== null);
  assert.equal(copy.copySource.trim(), '([a.example](https://a.example/x))');
});

test('DR-29 a reply to attached code that the user included is not sent with Deep Research (it still is with ordinary messages)', async () => {
  const requests = model((body) => (body.tools ? { events: smallResearch() } : { text: 'plain' }));
  const w = await openWindow();
  const chat = await w.tab();
  await w.store.addMessage('user', 'Explain this code', chat.id);
  await w.store.addMessage('assistant', 'ATTACHED_CODE_REPLY_4Z explains the snippet', chat.id, { attachmentTurn: true, contextPolicy: 'included' });
  await chat.send('Research something public');
  assert.ok(!JSON.stringify(requests[0]).includes('ATTACHED_CODE_REPLY_4Z'), 'not in the research request');
  await chat.send('Ordinary follow-up', { research: false });
  assert.ok(JSON.stringify(requests[1]).includes('ATTACHED_CODE_REPLY_4Z'), 'the included reply still goes with ordinary messages (0.8.0)');
});

// ---------------------------------------------------------------------------
// 0.9.1: model compatibility (the Astra-only gate removed; the table is the only gate)

const { supportedEfforts } = require('../src/reasoning');

// Every file under a directory, as text (to prove what was not persisted).
function allStoredText(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? allStoredText(full) : fs.readFileSync(full, 'utf8');
  }
  return out;
}

test('DR-30 each of the eight verified models runs Deep Research with itself: same request shape, no switch, Default sends no reasoning', async () => {
  server.models = LIVE_MODELS_091.map((m) => ({ ...m }));
  const requests = model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  for (const id of VERIFIED_090_1) {
    const chat = await w.tab();
    await chat.send(`Research with ${id}`, { model: id, effort: 'default' });
    const body = requests.at(-1);
    assert.equal(body.model, id, `${id}: the selected model, not another`);
    assert.deepEqual(Object.keys(body).sort(), [...KEYS_080, 'tool_choice', 'tools'].sort(), id);
    assert.deepEqual(body.tools, [{ type: 'web_search' }], id);
    assert.equal(body.tool_choice, 'required', id);
    assert.equal(Object.hasOwn(body, 'reasoning'), false, `${id}: Default omits reasoning`);
    assert.equal(Object.hasOwn(body, 'include'), false, id);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(chat.banners().length, 0, `${id}: no refusal`);
    const answer = (await w.messages(chat.id))[1];
    assert.equal(answer.error, undefined, id);
    assert.equal(answer.research.mode, 'deep-research', id);
    assert.equal(answer.research.citations.length, 1, id);
  }
  assert.equal(requests.length, VERIFIED_090_1.length, 'one request per Send, none re-sent with another model');
  // The unreviewed model the account lists is still refused locally.
  const chat = await w.tab();
  await chat.send('Research with Nova', { model: UNKNOWN });
  assert.equal(requests.length, VERIFIED_090_1.length, 'nothing sent for an unknown model');
  assert.match(chat.banners().at(-1).message, /has not been verified for "GPT-7-Nova"\. Choose a supported model in the Model selector/);
  assert.equal(chat.banners().at(-1).action, undefined, 'no replacement offered');
});

test('DR-31 Thinking is unchanged: GPT-6 models keep their explicit levels with research; GPT-5.6 models stay Default only', async () => {
  server.models = LIVE_MODELS_091.map((m) => ({ ...m }));
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna']) assert.deepEqual([...supportedEfforts(id)], ['default', 'low', 'medium', 'high', 'xhigh', 'max'], id);
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', UNKNOWN]) assert.deepEqual([...supportedEfforts(id)], ['default'], id);
  const requests = model(() => ({ events: smallResearch() }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research at High', { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].reasoning, { effort: 'high' });
  assert.equal(requests[0].tool_choice, 'required');
  // An explicit level for a GPT-5.6 model is refused locally, research or not, as in 0.8.0.
  for (const on of [true, false]) {
    const other = await w.tab();
    await other.send('Research at High on 5.6', { model: 'gpt-5.6-luna', effort: 'high', research: on });
    assert.equal(requests.length, 1, 'nothing sent');
    assert.match(other.banners().at(-1).message, /thinking level "High" is not available for this model/);
  }
  const plain = await w.tab();
  await plain.send('Research on 5.6 at Default', { model: 'gpt-5.6-luna', effort: 'default' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].model, 'gpt-5.6-luna');
  assert.equal(Object.hasOwn(requests[1], 'reasoning'), false);
});

test('DR-32 ordinary chat on the verified models: the 0.8.0 request plus Path A automatic search; an unreviewed model gets exactly the 0.8.0 request', async () => {
  server.models = LIVE_MODELS_091.map((m) => ({ ...m }));
  const requests = model(() => ({ text: 'plain' }));
  const w = await openWindow();
  const chat = await w.tab();
  for (const id of ['gpt-6.1-sol', 'gpt-5.6-luna', UNKNOWN]) {
    await chat.send(`Plain question on ${id}`, { model: id, research: false });
    await chat.send(`Plain question on ${id}, older page`, { model: id, research: 'omit' });
  }
  assert.equal(requests.length, 6);
  for (const body of requests) {
    if (body.model === UNKNOWN) assert.deepEqual(Object.keys(body).sort(), KEYS_080, body.model);
    else { assert.deepEqual(Object.keys(body).sort(), KEYS_0100, body.model); assert.ok(isPathA(body), body.model); }
    assert.doesNotMatch(body.instructions, /Deep Research/);
  }
  assert.ok((await w.messages(chat.id)).every((message) => !message.research));
});

test('DR-33 a reasoning item before the search (live gpt-5.6-sol order) is ignored: research completes, nothing of it is shown or stored', async () => {
  server.models = LIVE_MODELS_091.map((m) => ({ ...m }));
  const SECRET = 'REASONING_CONTENT_7Y';
  const text = 'The current **Active LTS** release line is **Node.js 26.x (“Lithium”)**. It is scheduled to reach end of life on **April 30, 2029**. ([github.com](https://github.com/nodejs/Release?utm_source=openai))';
  const start = text.indexOf('([github.com]');
  const annotation = { type: 'url_citation', start_index: start, end_index: text.length, url: 'https://github.com/nodejs/Release?utm_source=openai', title: 'GitHub - nodejs/Release: Node.js Release Working Group · GitHub' };
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: `${SECRET} summary` }], content: [{ type: 'reasoning_text', text: `${SECRET} content` }], encrypted_content: `${SECRET}_encrypted` };
  const search = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'node lts', queries: ['node lts', 'node release schedule'] } };
  const message = { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [annotation] }] };
  // The event order recorded live for gpt-5.6-sol (compat-probe/result-2), with reasoning text added to prove it is ignored.
  const events = [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.in_progress', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: `${SECRET} delta` },
    { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: `${SECRET} raw` },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
    { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
    { type: 'response.web_search_call.searching', item_id: 'ws_1' },
    { type: 'response.web_search_call.completed', item_id: 'ws_1' },
    { type: 'response.output_item.done', output_index: 1, item: search },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'message', id: 'msg_1', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_1', part: { type: 'output_text', text: '' } },
    ...[text.slice(0, 40), text.slice(40, 120), text.slice(120)].map((delta) => ({ type: 'response.output_text.delta', item_id: 'msg_1', delta })),
    { type: 'response.output_text.annotation.added', item_id: 'msg_1', content_index: 0, annotation_index: 0, annotation },
    { type: 'response.metadata', metadata: {}, response_id: 'resp_1' },
    { type: 'response.output_text.done', item_id: 'msg_1', text },
    { type: 'response.content_part.done', item_id: 'msg_1', part: message.content[0] },
    { type: 'response.output_item.done', output_index: 2, item: message },
    { type: 'response.completed', response: { status: 'completed', output: [reasoning, search, message] } }
  ];
  const requests = model(() => ({ events }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('What is the current Active LTS release line of Node.js?', { model: 'gpt-5.6-sol', effort: 'default' });
  assert.equal(requests.length, 1, 'one request; no continuation for the reasoning item');
  assert.equal(requests[0].model, 'gpt-5.6-sol');
  const answer = (await w.messages(chat.id))[1];
  assert.equal(answer.error, undefined);
  assert.equal(answer.content, text, 'the answer is the streamed text, exactly');
  assert.equal(answer.research.citations.length, 1);
  assert.equal(answer.research.citations[0].url, annotation.url);
  assert.equal(answer.research.searches, 1, 'the web search counted');
  // Rendered normally: the cited link becomes a clickable citation.
  const fragment = md.renderCited(createDocument(), answer.content, answer.research.citations);
  assert.ok(elements(fragment).some((n) => n.localName === 'a' && String(n.getAttribute('href')) === annotation.url), 'citation link rendered');
  // Never displayed, posted, or persisted.
  assert.ok(!JSON.stringify(chat.panel.posted).includes(SECRET), 'not posted to the page');
  assert.ok(!allStoredText(w.storageDir).includes(SECRET), 'not in storage');
  assert.ok(!/"reasoning/.test(JSON.stringify(answer)), 'no reasoning field on the stored reply');
});

test('DR-34 a provider refusal of web search on a supported model is shown as OpenAI gave it: no Astra, no switch, no retry', async () => {
  server.models = LIVE_MODELS_091.map((m) => ({ ...m }));
  const refused = model(() => ({ status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability', message: 'Web search is not enabled for this workspace.', param: 'tools' } }, headers: { 'x-request-id': 'req_policy_1' } }));
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('Research refused by policy', { model: 'gpt-5.6-terra', effort: 'default' });
  assert.equal(refused.length, 1, 'not retried, not re-sent with another model or without research');
  assert.equal(refused[0].model, 'gpt-5.6-terra');
  const answer = (await w.messages(chat.id))[1];
  assert.equal(answer.error, true);
  assert.match(answer.content, /did not accept Deep Research \(web search\) for this model or account/);
  assert.match(answer.content, /Web search is not enabled for this workspace\./, 'the provider message, as given');
  assert.match(answer.content, /subscription_sharing_unsupported_capability/);
  assert.match(answer.content, /req_policy_1/);
  assert.doesNotMatch(answer.content, /Astra|verified only/);
  const update = chat.posted('messageUpdated').at(-1);
  assert.notEqual(update.action, 'researchModel', 'no model offered for a provider refusal');
  assert.ok(chat.banners().every((b) => b.action !== 'researchModel'));
});

test('DR-35 no Astra-only wording and no model offer remain in what the user sees', () => {
  const html = getWebviewHtml({ cspSource: 'vscode-resource:', asWebviewUri: (u) => u }, {}, 'panel');
  for (const text of [html, ...['research.js', 'engine.js', 'view.js', 'request-builder.js', 'openai.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))]) {
    assert.doesNotMatch(text, /verified only with|Use GPT-6-Astra|Choose GPT-6-Astra|only GPT-6-Astra|research-model-action|'researchModel'|offeredModel/i);
  }
  // Astra appears in src only as a table key (the Deep Research and Thinking tables).
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8').split('\n').filter((line) => /astra\b/i.test(line));
    for (const line of lines) assert.match(line, /^\s*'gpt-6-astra': /, `${file}: ${line.trim()}`);
  }
});
