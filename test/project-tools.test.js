'use strict';

// Kenlith 0.5.0 read-only project tools (src/project-tools.js) and the
// Project Context service (src/project-context.js), on real folders under
// the system temp folder. Phase 4 path and file-system boundary tests and
// Phase 6 capability tests (docs/kenlith-0.5.0/THREAT-MODEL.md §3).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TOOL_DEFINITIONS, TOOL_LIMITS, TOOL_NAMES, ToolTurn, checkToolPath, relativeInside, validateCall } = require('../src/project-tools');
const { ProjectContextService } = require('../src/project-context');
const { createCache } = require('../src/retrieval');
const { buildRequest, buildToolContinuation, isBuiltRequest, withoutTools } = require('../src/request-builder');

const MARKER = 'OUTSIDE_SECRET_7f3a';
const SECRET = 'sk-proj-' + 'A'.repeat(48);
const created = [];
function project(files = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-pc-'));
  created.push(base);
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'OUTSIDE.txt'), `const leaked = "${MARKER}";\n`);
  fs.mkdirSync(path.join(base, 'other-root'));
  fs.writeFileSync(path.join(base, 'other-root', 'other.js'), `// other root ${MARKER}\n`);
  for (const [relPath, text] of Object.entries(files)) {
    const full = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return { base, root, real: fs.realpathSync.native(root), outside: path.join(base, 'outside'), otherRoot: path.join(base, 'other-root') };
}
test.after(() => {
  for (const base of created) fs.rmSync(base, { recursive: true, force: true });
});
const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error('network used'); }; });
test.after(() => { globalThis.fetch = realFetch; });

const CODEBASE = {
  'README.md': '# Demo service\n\nA small demo service that authenticates users and stores notes.\n',
  'package.json': JSON.stringify({ name: 'demo', description: 'Demo service', scripts: { test: 'node --test' } }, null, 2),
  'src/auth/login.js': ['function login(user, password) {', '  return verifyPassword(user, password);', '}', 'module.exports = { login };'].join('\n'),
  'src/auth/session.js': 'function createSession(user) { return { user, token: randomToken() }; }\n',
  'src/notes/store.js': 'class NoteStore { add(note) { this.notes.push(note); } }\n',
  'config/settings.json': '{ "port": 8080, "featureX": true }\n',
  'node_modules/lib/index.js': `module.exports = "${MARKER} in node_modules";\n`,
  'dist/bundle.js': `/* ${MARKER} in dist */\n`,
  '.git/config': `[remote] url = ${MARKER}\n`,
  '.env': `API_KEY=${MARKER}\n`,
  'keys/id_rsa': `${MARKER}\n`,
  'certs/server.pem': `${MARKER}\n`,
  'src/config/credentials.js': `const key = "${SECRET}";\n`,
  'tmp/scratch.js': `// ${MARKER} temp\n`
};

function serviceFor(paths, { folderPath = paths.root, editor = {}, excludes = {}, trusted = true, kind = 'project', available = true } = {}) {
  const context = kind === 'project'
    ? { kind: 'project', label: path.basename(folderPath), folderPath, folderUri: `file:///${folderPath}`, available, multiRoot: Boolean(editor.multiRoot) }
    : { kind: 'general', reason: 'no-folder' };
  return new ProjectContextService({
    getWindowContext: () => context,
    workspace: {
      isTrusted: () => trusted,
      activeDocument: () => editor.active,
      openDocuments: () => editor.open || [],
      excludes: () => excludes
    },
    cache: createCache()
  });
}

// Wide bounds for tests that use one turn for many separate checks.
const WIDE = { maxRounds: 100, maxCalls: 100, maxTurnChars: 1e7 };
const call = (name, args, id = name) => ({ callId: id, name, arguments: JSON.stringify(args) });
const one = async (turn, name, args) => (await turn.runRound([call(name, args)]))[0];

test('T1 tool definitions are strict, fixed and read-only', () => {
  assert.deepEqual(TOOL_NAMES, ['project_summary', 'project_list_directory', 'project_find_files', 'project_search_text', 'project_read_file', 'project_open_documents']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
    assert.ok(Object.isFrozen(tool));
    assert.doesNotMatch(tool.name, /write|edit|delete|run|exec|shell|command|apply|patch|upload/);
  }
});

test('T2 arguments are validated before any file is touched', () => {
  assert.equal(validateCall('project_delete_file', '{}').reason, 'unknown-tool');
  assert.equal(validateCall('run_command', '{"command":"dir"}').reason, 'unknown-tool');
  assert.equal(validateCall('project_read_file', '{"path":"a.js"}').detail, 'missing start_line');
  assert.equal(validateCall('project_read_file', '{"path":"a.js","start_line":null,"end_line":null,"root":"C:/"}').detail, 'unknown field');
  assert.equal(validateCall('project_read_file', '{"path":5,"start_line":null,"end_line":null}').detail, 'type of path');
  assert.equal(validateCall('project_read_file', '{"path":"a.js","start_line":1.5,"end_line":null}').detail, 'type of start_line');
  assert.equal(validateCall('project_find_files', '{"query":"' + 'x'.repeat(201) + '"}').detail, 'query too long');
  assert.equal(validateCall('project_find_files', 'not json').detail, 'not JSON');
  assert.equal(validateCall('project_find_files', '[1]').detail, 'not an object');
  assert.equal(validateCall('project_find_files', 'x'.repeat(5000)).detail, 'size');
  assert.equal(validateCall('project_summary', '').ok, true);
  assert.equal(validateCall('project_summary', '{}').ok, true);
});

test('T3 path grammar: traversal, absolute, drive, UNC, namespace, streams, devices, dots, controls are refused', () => {
  for (const bad of ['../outside/OUTSIDE.txt', 'src/../../outside/OUTSIDE.txt', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', '/etc/passwd', '\\\\server\\share\\x', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0',
    'src/a.js:secret', 'CON', 'src/nul.txt', 'COM1.js', 'src/file.', 'src/file ', 'src/\u202Egnp.js', 'src/a\nb.js', 'src/*.js', './src/a.js', '']) {
    const result = checkToolPath(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.reason, 'invalid-path', JSON.stringify(bad));
  }
  assert.equal(checkToolPath('node_modules/lib/index.js').reason, 'excluded');
  assert.equal(checkToolPath('src/.git/config').reason, 'excluded');
  assert.equal(checkToolPath('.env').reason, 'sensitive');
  assert.equal(checkToolPath('keys/id_rsa').reason, 'sensitive');
  assert.equal(checkToolPath('.ssh', { directory: true }).reason, 'sensitive');
  assert.deepEqual(checkToolPath('src\\auth\\login.js'), { ok: true, relPath: 'src/auth/login.js' });
});

test('T4 excluded, sensitive and outside content never appears in any tool output', async () => {
  const paths = project(CODEBASE);
  const turn = await serviceFor(paths).createTurn();
  const outputs = [];
  for (const target of ['node_modules/lib/index.js', 'dist/bundle.js', '.git/config', '.env', 'keys/id_rsa', 'certs/server.pem', 'src/config/credentials.js', 'tmp/scratch.js', '../outside/OUTSIDE.txt', path.join(paths.outside, 'OUTSIDE.txt')]) {
    const turnFor = await serviceFor(paths).createTurn();
    const out = await one(turnFor, 'project_read_file', { path: target, start_line: null, end_line: null });
    assert.equal(out.result.ok, false, target);
    outputs.push(out.output);
  }
  for (const [name, args] of [['project_summary', {}], ['project_list_directory', { path: null }], ['project_find_files', { query: 'index bundle config id_rsa server credentials scratch env' }], ['project_search_text', { query: 'in node_modules' }], ['project_search_text', { query: 'API_KEY' }], ['project_search_text', { query: 'sk-proj-' }]]) {
    outputs.push((await one(await serviceFor(paths).createTurn(), name, args)).output);
  }
  const all = outputs.join('\n');
  assert.ok(!all.includes(MARKER), 'a refused or excluded file leaked');
  assert.ok(!all.includes(SECRET), 'credential content leaked');
  const listing = JSON.parse(outputs.at(-5));
  for (const hidden of ['node_modules/', 'dist/', '.git/', '.env', 'keys/', 'certs/', 'tmp/']) assert.ok(!listing.entries.includes(hidden), hidden);
  assert.equal(turn.sentSources().length, 0);
});

test('T5 links: a junction to an outside folder is never listed or read; a file replaced by a junction is refused', async (t) => {
  const paths = project(CODEBASE);
  try {
    fs.symlinkSync(paths.outside, path.join(paths.root, 'src', 'linked'), 'junction');
  } catch (error) {
    t.skip(`junctions unavailable: ${error.code}`);
    return;
  }
  const service = serviceFor(paths);
  const turn = await service.createTurn({ limits: WIDE });
  const read = await one(turn, 'project_read_file', { path: 'src/linked/OUTSIDE.txt', start_line: null, end_line: null });
  assert.equal(read.result.ok, false);
  const dir = await one(turn, 'project_list_directory', { path: 'src' });
  assert.ok(!dir.result.entries.includes('linked/'));
  const search = await one(turn, 'project_search_text', { query: 'leaked' });
  assert.equal(search.result.matches.length, 0);
  // A listed file swapped for a junction after the listing was cached.
  const session = path.join(paths.root, 'src', 'auth', 'session.js');
  await one(turn, 'project_find_files', { query: 'session' });
  fs.rmSync(session);
  fs.symlinkSync(paths.outside, session, 'junction');
  const swapped = await one(turn, 'project_read_file', { path: 'src/auth/session.js', start_line: null, end_line: null });
  assert.equal(swapped.result.ok, false);
  assert.ok(['link', 'not-file', 'missing', 'changed'].includes(swapped.result.reason), swapped.result.reason);
  assert.ok(![read, dir, search, swapped].some((out) => out.output.includes(MARKER)));
});

test('T6 multi-root: only the chosen folder is readable; another root of the window is not', async () => {
  const paths = project(CODEBASE);
  const turn = await serviceFor(paths, { editor: { multiRoot: true } }).createTurn({ limits: WIDE });
  for (const target of ['../other-root/other.js', path.join(paths.otherRoot, 'other.js'), 'other-root/other.js', 'other.js']) {
    const out = await one(turn, 'project_read_file', { path: target, start_line: null, end_line: null });
    assert.equal(out.result.ok, false, target);
    assert.ok(!out.output.includes(MARKER));
  }
  assert.equal((await one(turn, 'project_search_text', { query: 'other root' })).result.matches.length, 0);
});

test('T7 capabilities return bounded, structured, sourced results', async () => {
  const lines = Array.from({ length: 450 }, (_, index) => `line ${index + 1} token`);
  const paths = project({ ...CODEBASE, 'src/big.js': lines.join('\n'), 'docs/many.md': Array.from({ length: 60 }, () => 'needle here').join('\n') });
  const service = serviceFor(paths, { editor: { active: { fsPath: path.join(paths.root, 'src', 'auth', 'login.js'), dirty: true }, open: [{ fsPath: path.join(paths.root, '.env') }, { fsPath: path.join(paths.outside, 'OUTSIDE.txt') }, { fsPath: path.join(paths.root, 'src', 'notes', 'store.js') }] } });
  const turn = await service.createTurn({ limits: WIDE });

  const summary = (await one(turn, 'project_summary', {})).result;
  assert.equal(summary.ok, true);
  assert.ok(summary.topLevel.includes('src/') && summary.topLevel.includes('README.md'));
  assert.equal(summary.overview[0].path, 'README.md');
  assert.match(summary.overview[0].text, /authenticates users/);

  const found = (await one(turn, 'project_find_files', { query: 'login session' })).result;
  assert.deepEqual(found.paths.slice(0, 2).sort(), ['src/auth/login.js', 'src/auth/session.js']);

  const read = (await one(turn, 'project_read_file', { path: 'src/big.js', start_line: 10, end_line: null })).result;
  assert.equal(read.lines.split('-')[0], '10');
  assert.ok(Number(read.lines.split('-')[1]) - 10 + 1 <= TOOL_LIMITS.maxReadLines);
  assert.match(read.text, /^10: line 10 token/);
  assert.equal(read.truncated, true);
  assert.ok(read.text.length <= TOOL_LIMITS.maxOutputChars);

  const search = (await one(turn, 'project_search_text', { query: 'needle' })).result;
  assert.equal(search.matches.length, TOOL_LIMITS.maxSearchResults);
  assert.equal(search.truncated, true);
  assert.ok(search.matches.every((match) => match.preview.length <= TOOL_LIMITS.maxPreviewChars));

  const open = (await one(turn, 'project_open_documents', {})).result;
  assert.deepEqual(open.documents, [{ path: 'src/auth/login.js', active: true, dirty: true }, { path: 'src/notes/store.js', active: false, dirty: false }]);

  const sources = turn.sentSources();
  assert.ok(sources.some((source) => source.relPath === 'src/big.js' && source.startLine === 10 && /^[0-9a-f]{64}$/.test(source.fileSha256)));
  assert.ok(sources.some((source) => source.relPath === 'docs/many.md'));
  assert.ok(sources.some((source) => source.relPath === 'README.md'));
  assert.ok(sources.every((source) => source.via === 'tool'));
});

test('T8 per-turn bounds: calls, rounds and characters stop with a budget refusal', async () => {
  const paths = project({ ...CODEBASE, 'src/wide.js': Array.from({ length: 200 }, (_, index) => `${'w'.repeat(25)} ${index}`).join('\n') });
  const turn = await serviceFor(paths).createTurn();
  const calls = Array.from({ length: 14 }, (_, index) => call('project_find_files', { query: 'login' }, `c${index}`));
  const outputs = await turn.runRound(calls);
  assert.equal(outputs.filter((out) => out.result.ok).length, TOOL_LIMITS.maxCalls);
  assert.ok(outputs.slice(TOOL_LIMITS.maxCalls).every((out) => out.result.reason === 'budget'));
  assert.equal(turn.exhausted, true);

  const rounds = await serviceFor(paths).createTurn();
  for (let round = 0; round < TOOL_LIMITS.maxRounds; round += 1) assert.equal((await rounds.runRound([call('project_summary', {})]))[0].result.ok, true);
  assert.equal((await rounds.runRound([call('project_summary', {})]))[0].result.reason, 'budget');

  const chars = await serviceFor(paths).createTurn();
  let total = 0;
  for (let index = 0; index < 4; index += 1) {
    const out = (await chars.runRound([call('project_read_file', { path: 'src/wide.js', start_line: 1 + index * 50, end_line: null })]))[0];
    if (out.result.ok) total += out.output.length;
  }
  assert.ok(total <= TOOL_LIMITS.maxTurnChars, `${total}`);
  assert.ok(chars.chars <= TOOL_LIMITS.maxTurnChars);
});

test('T9 cancellation and vanishing files', async () => {
  const paths = project(CODEBASE);
  const turn = await serviceFor(paths).createTurn();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await turn.runRound([call('project_search_text', { query: 'login' })], { signal: controller.signal });
  assert.equal(cancelled[0].result.reason, 'cancelled');
  const live = await serviceFor(paths).createTurn();
  await one(live, 'project_find_files', { query: 'store' });
  fs.rmSync(path.join(paths.root, 'src', 'notes', 'store.js'));
  const gone = await one(live, 'project_read_file', { path: 'src/notes/store.js', start_line: null, end_line: null });
  assert.equal(gone.result.ok, false);
  assert.ok(['missing', 'unreadable'].includes(gone.result.reason));
});

test('T10 the service: awareness state needs no file reads; general, restricted and unavailable states', async () => {
  const paths = project(CODEBASE);
  const service = serviceFor(paths, { editor: { active: { fsPath: path.join(paths.root, 'src', 'auth', 'login.js') }, open: [{ fsPath: path.join(paths.root, 'keys', 'id_rsa') }] } });
  const state = service.state({ sharing: 'none' });
  assert.deepEqual(state, { kind: 'project', label: 'project', trusted: true, sharing: 'none', multiRoot: false, activeFile: 'src/auth/login.js', openFiles: ['src/auth/login.js'] });
  assert.equal(serviceFor(paths, { kind: 'general' }).state().kind, 'general');
  assert.equal(serviceFor(paths, { trusted: false }).state().kind, 'restricted');
  assert.equal(serviceFor(paths, { trusted: false }).state().sharing, 'off');
  assert.equal(serviceFor(paths, { available: false }).state().kind, 'unavailable');
  assert.equal(await serviceFor(paths, { kind: 'general' }).createTurn(), undefined);
  assert.equal(relativeInside(paths.root, path.join(paths.outside, 'OUTSIDE.txt')), undefined);
  assert.equal(relativeInside(paths.root, path.join(paths.root, '.env')), undefined);
});

test('T11 selection: active file, open files, overview questions; every excerpt says why it was chosen', async () => {
  const paths = project(CODEBASE);
  const active = path.join(paths.root, 'src', 'notes', 'store.js');
  const service = serviceFor(paths, { editor: { active: { fsPath: active }, open: [{ fsPath: path.join(paths.root, 'src', 'auth', 'session.js') }] } });
  const explain = await service.select({ query: 'explain this' });
  assert.equal(explain.status, 'ok');
  assert.equal(explain.excerpts[0].relPath, 'src/notes/store.js');
  assert.ok(explain.excerpts[0].reasons.includes('active editor file'));

  const overview = await serviceFor(paths).select({ query: 'What does this project do?' });
  assert.equal(overview.status, 'ok');
  assert.equal(overview.excerpts[0].relPath, 'README.md');
  assert.ok(overview.excerpts[0].reasons.includes('describes the project'));

  const auth = await service.select({ query: 'where is the login password verification implemented?' });
  assert.equal(auth.excerpts[0].relPath, 'src/auth/login.js');
  assert.ok(auth.excerpts[0].reasons.some((reason) => /matches/.test(reason)));
  // An open file without any match is not chosen just for being open.
  const unrelated = await service.select({ query: 'featureX port' });
  assert.ok(!unrelated.excerpts.some((excerpt) => excerpt.relPath === 'src/auth/session.js'));
  assert.equal(unrelated.excerpts[0].relPath, 'config/settings.json');
  // Deterministic.
  assert.deepEqual((await service.select({ query: 'login session store' })).excerpts.map((e) => e.relPath), (await service.select({ query: 'login session store' })).excerpts.map((e) => e.relPath));
});

test('T12 the request builder: tools never with an attachment or without project files; continuations stay built and gated', () => {
  assert.throws(() => buildRequest({ instructions: 'i', history: [], text: 'q', noProjectFiles: true, tools: TOOL_DEFINITIONS }), /not offered/);
  assert.throws(() => buildRequest({ instructions: 'i', history: [], text: 'q', attachment: { text: 'x', chars: 1 }, tools: TOOL_DEFINITIONS }), /not offered/);
  const request = buildRequest({ instructions: 'i', history: [], text: 'q', tools: TOOL_DEFINITIONS });
  assert.equal(request.requiresGate, true);
  assert.equal(request.toolChoice, 'auto');
  assert.throws(() => buildToolContinuation(request, { calls: [{ callId: 'a', name: 'project_summary', arguments: '{}' }], outputs: [] }), /exactly one output/);
  assert.throws(() => buildToolContinuation(buildRequest({ instructions: 'i', history: [], text: 'q' }), { calls: [], outputs: [] }), /built with project tools/);
  const next = buildToolContinuation(request, { calls: [{ callId: 'a', name: 'project_summary', arguments: '{}' }], outputs: [{ callId: 'a', output: '{"ok":true}' }], final: true });
  assert.ok(isBuiltRequest(next));
  assert.equal(next.toolChoice, 'none');
  assert.deepEqual(next.continuation.map((item) => item.type), ['function_call', 'function_call_output']);
  const plain = withoutTools(request);
  assert.ok(isBuiltRequest(plain));
  assert.equal(plain.tools, undefined);
  assert.equal(plain.requiresGate, false);
  assert.doesNotMatch(plain.instructions, /project_\* tools/);
  assert.match(request.instructions, /project_\* tools/, 'the check above can fail');
  assert.throws(() => { next.continuation.push({}); }, TypeError);
});

test('T13 intents: overview and active-file questions are recognised narrowly; noise files are never listed', async () => {
  const { tokenize } = require('../src/retrieval');
  for (const question of ['What does this project do?', 'give me an overview of the repo', 'explain the architecture', 'ما هو هذا المشروع؟']) assert.equal(tokenize(question).overview, true, question);
  for (const question of ['where is authentication implemented in this app?', 'fix the project build in webpack.config.js', 'and again?']) assert.notEqual(tokenize(question).overview, true, question);
  for (const question of ['explain this', 'what does this file do?', 'review this function', 'اشرح هذا الملف']) assert.equal(tokenize(question).active, true, question);
  for (const question of ['and again?', 'how does addAll work?', 'thanks']) assert.notEqual(tokenize(question).active, true, question);
  const paths = project({ ...CODEBASE, '.DS_Store': 'x', 'src/desktop.ini': 'x', 'Thumbs.db': 'x' });
  const listing = await serviceFor(paths).listing();
  for (const noise of ['.DS_Store', 'src/desktop.ini', 'Thumbs.db']) assert.ok(!listing.files.includes(noise), noise);
  // A vague message with a file open selects nothing (no consent card for it).
  const vague = await serviceFor(paths, { editor: { active: { fsPath: path.join(paths.root, 'src', 'auth', 'login.js') } } }).select({ query: 'and again?' });
  assert.equal(vague.status, 'no-match');
});

test('T14 no write, process or network capability in the project-context modules', () => {
  const forbidden = /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|rmSync|rm\(|rename|mkdir|copyFile|cpSync|symlink|truncate|chmod|chown|utimes|spawn|exec|execFile|fork|child_process|fetch\(|http\.|https\.|net\.|WorkspaceEdit|applyEdit|openTextDocument|executeCommand)\b/;
  for (const file of ['src/project-tools.js', 'src/project-context.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    const hit = code.match(forbidden);
    assert.equal(hit, null, `${file}: ${hit?.[0]}`);
    assert.doesNotMatch(code, /require\('vscode'\)/, `${file} reaches the editor only through the adapter`);
  }
  // The tool names cannot express a write either (T1), and the only file
  // access in these modules is through workspace-safety and retrieval.
  const tools = fs.readFileSync(path.join(__dirname, '..', 'src', 'project-tools.js'), 'utf8');
  assert.doesNotMatch(tools, /require\('node:fs'\)|require\('fs'\)/, 'project-tools.js has no direct file-system access');
});
