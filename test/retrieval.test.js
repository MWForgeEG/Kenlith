'use strict';

// M1-1B local retrieval on real folders under the system temp folder.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compileExcludes, globToRegExp } = require('../src/glob');
const { DEFAULT_LIMITS, createCache, retrieve, tokenize } = require('../src/retrieval');

const MARKER = 'OUTSIDE_SECRET';
const created = [];
function folder(files = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-rt-'));
  created.push(base);
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'OUTSIDE.txt'), `function outsideSecret() { return "${MARKER}"; }\n`);
  for (const [relPath, text] of Object.entries(files)) {
    const full = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return { base, root: fs.realpathSync.native(root), outside: path.join(base, 'outside') };
}
test.after(() => {
  for (const base of created) {
    fs.rmSync(path.join(base, 'project'), { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// No retrieval may touch the network.
const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error('network used'); }; });
test.after(() => { globalThis.fetch = realFetch; });

const all = (result) => JSON.stringify(result);

// A small, realistic codebase.
const CODEBASE = {
  'src/store.js': [
    "'use strict';",
    'class ConversationStore {',
    '  constructor(context) { this.context = context; }',
    '  async addMessage(role, content, conversationId) {',
    '    const message = { id: crypto.randomUUID(), role, content };',
    '    await this.#save(conversationId, message);',
    '    return message;',
    '  }',
    '  async removeMessage(conversationId, id) { return this.#remove(conversationId, id); }',
    '}',
    'module.exports = { ConversationStore };'
  ].join('\n'),
  'src/budget.js': [
    'const REQUEST_BUDGET = 80000;',
    'function composeWithinBudget({ instructions, history, text, limit = REQUEST_BUDGET }) {',
    '  const fixed = instructions.length + text.length;',
    '  if (fixed > limit) throw new Error("too long");',
    '  return { messages: history.concat([{ role: "user", content: text }]) };',
    '}',
    'module.exports = { composeWithinBudget };'
  ].join('\n'),
  'src/view.js': 'class ChatViewProvider {\n  render() { return "<main></main>"; }\n}\nmodule.exports = { ChatViewProvider };\n',
  'src/calculator.js': 'function addAll(values) {\n  if (!values.length) return 0;\n  return values.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { addAll };\n',
  'test/store.test.js': "const { ConversationStore } = require('../src/store');\ntest('addMessage stores a message', async () => {});\n",
  'README.md': '# Example\nA chat sidebar that stores conversations locally.\n',
  'docs/guide.md': 'How the budget works: see composeWithinBudget in src/budget.js.\n'
};

test('R1 tokenize keeps identifiers, their parts and named files; drops stop words', () => {
  const parsed = tokenize('How does addMessage work in store.js and the REQUEST_BUDGET? Why?');
  assert.ok(parsed.files.includes('store.js'));
  for (const term of ['addmessage', 'add', 'message', 'store', 'request_budget', 'request', 'budget']) assert.ok(parsed.terms.includes(term), term);
  for (const dropped of ['how', 'does', 'work', 'the', 'why', 'and']) assert.ok(!parsed.terms.includes(dropped), dropped);
  assert.deepEqual(tokenize('  '), { terms: [], files: [] });
});

test('R2 globs follow the VS Code exclude syntax; false never re-includes; when needs the sibling', () => {
  const regex = (pattern) => globToRegExp(pattern);
  assert.ok(regex('**/node_modules').test('node_modules'));
  assert.ok(regex('**/node_modules').test('a/b/node_modules'));
  assert.ok(regex('**/*.min.js').test('lib/x.min.js'));
  assert.ok(!regex('*.js').test('lib/x.js'), 'a single star stays in one segment');
  assert.ok(regex('docs/**').test('docs/a/b.md'));
  assert.ok(regex('**/{gen,tmp}').test('src/gen'));
  assert.ok(regex('**/file[0-9].txt').test('x/file7.txt'));
  assert.ok(regex('**/NODE_MODULES').test('node_modules'), 'no case distinction');
  const matcher = compileExcludes({ '**/gen': true, 'keep/**': false }, { '**/*.js': { when: '$(basename).ts' } });
  assert.ok(matcher.excludes('src/gen'));
  assert.ok(!matcher.excludes('keep/a.md'));
  assert.ok(matcher.excludes('src/a.js', (name) => name === 'a.ts'));
  assert.ok(!matcher.excludes('src/b.js', (name) => name === 'a.ts'));
  assert.ok(matcher.excludes('src/c.js'), 'no sibling information: excluded (conservative)');
});

test('R3 an empty project, an empty question and a question in another language give no match', async () => {
  const { root } = folder();
  fs.rmSync(path.join(root, 'project-x'), { force: true });
  assert.equal((await retrieve({ root, query: 'addMessage' })).status, 'no-match');
  const coded = folder(CODEBASE);
  assert.equal((await retrieve({ root: coded.root, query: '' })).status, 'no-match');
  assert.equal((await retrieve({ root: coded.root, query: 'ما هذا؟' })).status, 'no-match');
});

test('R4 ranking: the file and lines a question is about come first, deterministically', async () => {
  const { root } = folder(CODEBASE);
  const first = await retrieve({ root, query: 'How does addMessage work in store.js?' });
  assert.equal(first.status, 'ok');
  assert.equal(first.excerpts[0].relPath, 'src/store.js');
  assert.match(first.excerpts[0].text, /async addMessage\(role, content, conversationId\)/);
  assert.ok(first.excerpts[0].startLine >= 1 && first.excerpts[0].endLine >= first.excerpts[0].startLine);
  assert.match(first.excerpts[0].fileSha256, /^[0-9a-f]{64}$/);
  const again = await retrieve({ root, query: 'How does addMessage work in store.js?' });
  assert.deepEqual(again.excerpts, first.excerpts, 'same input, same output');

  const budget = await retrieve({ root, query: 'Why does composeWithinBudget throw when the text is too long?' });
  assert.equal(budget.excerpts[0].relPath, 'src/budget.js');
  const empty = await retrieve({ root, query: 'Does addAll handle an empty list?' });
  assert.equal(empty.excerpts[0].relPath, 'src/calculator.js');
  assert.match(empty.excerpts[0].text, /if \(!values\.length\) return 0;/);
  for (const result of [first, budget, empty]) {
    for (const excerpt of result.excerpts) {
      assert.ok(!excerpt.relPath.includes('\\'), 'forward slashes');
      assert.equal(excerpt.chars, excerpt.text.length);
    }
  }
});

test('R5 built-in, files.exclude and search.exclude folders are never read; false does not re-include them', async () => {
  const { root } = folder({
    ...CODEBASE,
    'node_modules/pkg/store.js': 'addMessage from a dependency',
    'dist/store.js': 'addMessage built',
    'gen/store.js': 'addMessage generated',
    'docs/store-notes.md': 'addMessage documentation'
  });
  const result = await retrieve({
    root,
    query: 'addMessage store',
    settings: { filesExclude: { '**/gen': true, '**/node_modules': false }, searchExclude: { 'docs/**': true } }
  });
  const paths = result.excerpts.map((excerpt) => excerpt.relPath);
  for (const excluded of ['node_modules/pkg/store.js', 'dist/store.js', 'gen/store.js', 'docs/store-notes.md']) assert.ok(!paths.includes(excluded), excluded);
  assert.ok(paths.includes('src/store.js'));
});

test('R6 security rules cannot be weakened by settings; sensitive and credential files are reported as withheld, never read', async () => {
  const { root } = folder({
    ...CODEBASE,
    '.env': `STORE_TOKEN=${MARKER}`,
    'config/store.pem': MARKER,
    '.git/store.js': MARKER,
    'src/store-config.js': `const awsKey = "AK${''}IAABCDEFGHIJKLMNOP"; // ${MARKER}`
  });
  const result = await retrieve({ root, query: 'store config env pem', settings: { filesExclude: { '**/.env': false, '**/.git': false } } });
  assert.ok(!all(result.excerpts).includes(MARKER), 'no sensitive content');
  const withheld = Object.fromEntries(result.withheld.map((item) => [item.relPath, item.reason]));
  assert.equal(withheld['config/store.pem'], 'sensitive');
  assert.equal(withheld['src/store-config.js'], 'credential-content');
  assert.ok(!result.excerpts.some((excerpt) => excerpt.relPath.startsWith('.git/')));
});

test('R7 links are never followed: a junction to an outside folder and an outside hard link are withheld, the outside text never appears', async () => {
  const { root, outside } = folder(CODEBASE);
  fs.symlinkSync(outside, path.join(root, 'secret-junction'), 'junction');
  fs.linkSync(path.join(outside, 'OUTSIDE.txt'), path.join(root, 'secret-hardlink.txt'));
  const result = await retrieve({ root, query: 'outsideSecret secret junction hardlink' });
  assert.ok(!all(result).includes(MARKER), 'outside text returned');
  const withheld = Object.fromEntries(result.withheld.map((item) => [item.relPath, item.reason]));
  assert.equal(withheld['secret-junction'], 'link');
  assert.equal(withheld['secret-hardlink.txt'], 'hard-link');
});

test('R8 budgets: excerpts, characters, per-file size, total bytes and listed files are bounded', async () => {
  const files = {};
  for (let index = 0; index < 30; index += 1) {
    files[`src/module${String(index).padStart(2, '0')}.js`] = Array.from({ length: 200 }, (_, line) => `function widget${line}() { return "widget ${index}.${line}"; }`).join('\n');
  }
  files['src/huge-widget.js'] = 'widget '.repeat(120 * 1024);
  const { root } = folder(files);
  const result = await retrieve({ root, query: 'widget' });
  assert.ok(result.excerpts.length <= DEFAULT_LIMITS.maxExcerpts);
  assert.ok(result.excerpts.reduce((sum, excerpt) => sum + excerpt.chars, 0) <= DEFAULT_LIMITS.maxChars);
  assert.ok(!result.excerpts.some((excerpt) => excerpt.relPath === 'src/huge-widget.js'), 'over 512 KB is not read');
  const tight = await retrieve({ root, query: 'widget', limits: { maxReadBytes: 20 * 1024, maxFiles: 5, maxExcerpts: 2, maxChars: 500 } });
  assert.ok(tight.stats.listed <= 5);
  assert.ok(tight.stats.bytesRead <= 20 * 1024);
  assert.ok(tight.excerpts.length <= 2);
  assert.ok(tight.excerpts.reduce((sum, excerpt) => sum + excerpt.chars, 0) <= 500);
  assert.equal(tight.stats.truncated, true);
});

test('R9 cancellation: an aborted signal returns cancelled promptly, before or during the walk', async () => {
  const { root } = folder(CODEBASE);
  const before = new AbortController();
  before.abort();
  assert.equal((await retrieve({ root, query: 'addMessage', signal: before.signal })).status, 'cancelled');
  const files = {};
  for (let index = 0; index < 3000; index += 1) files[`d${index % 50}/f${index}.js`] = `const value${index} = ${index};\n`;
  const big = folder(files);
  const during = new AbortController();
  const started = Date.now();
  setTimeout(() => during.abort(), 5);
  const result = await retrieve({ root: big.root, query: 'value', signal: during.signal });
  assert.equal(result.status, 'cancelled');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('R10 cache: a repeated question uses it; an edited file is read again; invalidate() clears it', async () => {
  const { root } = folder(CODEBASE);
  const cache = createCache({ listingTtlMs: 60000 });
  const first = await retrieve({ root, query: 'addAll empty list', cache });
  assert.equal(first.stats.cacheHits, 0);
  const second = await retrieve({ root, query: 'addAll empty list', cache });
  assert.ok(second.stats.cacheHits > 0);
  assert.deepEqual(second.excerpts, first.excerpts);
  fs.writeFileSync(path.join(root, 'src', 'calculator.js'), 'function addAll(values) {\n  // CHANGED for an empty list\n  return values.reduce((a, b) => a + b, 0);\n}\n');
  const edited = await retrieve({ root, query: 'addAll empty list', cache });
  assert.match(edited.excerpts[0].text, /CHANGED/);
  assert.notEqual(edited.excerpts[0].fileSha256, first.excerpts[0].fileSha256);
  fs.writeFileSync(path.join(root, 'src', 'added-later.js'), 'function addAll2() { /* empty list */ }\n');
  const stale = await retrieve({ root, query: 'addAll empty list', cache });
  assert.ok(!stale.excerpts.some((excerpt) => excerpt.relPath === 'src/added-later.js'), 'the listing is cached for its lifetime');
  cache.invalidate();
  const fresh = await retrieve({ root, query: 'addAll empty list', cache });
  assert.ok(fresh.excerpts.some((excerpt) => excerpt.relPath === 'src/added-later.js'));
});

test('R11 symbols snap an excerpt to its enclosing function; failing or slow providers are ignored', async () => {
  const lines = ['// header'];
  for (let index = 1; index <= 60; index += 1) lines.push(`// filler ${index}`);
  lines.push('function target() {', '  const answer = 42;', '  return answer;', '}');
  for (let index = 1; index <= 40; index += 1) lines.push(`// tail ${index}`);
  const { root } = folder({ 'src/big.js': lines.join('\n') });
  const snapped = await retrieve({ root, query: 'answer', symbols: () => [{ startLine: 62, endLine: 65 }, { startLine: 1, endLine: 200 }] });
  assert.deepEqual([snapped.excerpts[0].startLine, snapped.excerpts[0].endLine], [62, 65]);
  const failing = await retrieve({ root, query: 'answer', symbols: () => { throw new Error('no provider'); } });
  assert.equal(failing.status, 'ok');
  const started = Date.now();
  const slow = await retrieve({ root, query: 'answer', symbols: () => new Promise(() => {}) });
  assert.equal(slow.status, 'ok');
  assert.ok(Date.now() - started < 2000);
});

test('R12 malformed and unusual names, deep trees and an unavailable root', async () => {
  const deep = Array.from({ length: 30 }, (_, index) => `d${index}`).join('/');
  const { root, base } = folder({
    'with space/odd name.js': 'const oddity = true;\n',
    'مشروع/ملف.js': 'const oddity2 = true;\n',
    [`${deep}/leaf.js`]: 'const oddity3 = true;\n',
    [`${'x'.repeat(120)}.js`]: 'const oddity4 = true;\n'
  });
  const result = await retrieve({ root, query: 'oddity oddity2 oddity3 oddity4' });
  const paths = result.excerpts.map((excerpt) => excerpt.relPath);
  assert.ok(paths.includes('with space/odd name.js'));
  assert.ok(paths.includes('مشروع/ملف.js'));
  assert.ok(paths.some((relPath) => relPath.endsWith('leaf.js')));
  assert.equal((await retrieve({ root: path.join(base, 'gone'), query: 'x' })).status, 'unavailable');
  assert.equal((await retrieve({ root: '\\\\server\\share', query: 'x' })).reason, 'root-unsupported');
});

test('R13 a large project (25,000 files): the listing stops at 20,000 within the time budget; memory and time are recorded', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-rt-large-'));
  created.push(base);
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const madeAt = Date.now();
  for (let dir = 0; dir < 250; dir += 1) {
    const folderPath = path.join(root, `pkg${String(dir).padStart(3, '0')}`);
    fs.mkdirSync(folderPath);
    for (let file = 0; file < 100; file += 1) {
      fs.writeFileSync(path.join(folderPath, `file${file}.js`), `export function item${dir}_${file}() { return ${dir * 100 + file}; }\n`);
    }
  }
  fs.mkdirSync(path.join(root, 'zz'));
  fs.writeFileSync(path.join(root, 'zz', 'needle.js'), 'export const uniqueNeedle = "found";\n');
  t.diagnostic(`fixture: 25,001 files created in ${Date.now() - madeAt} ms`);
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const result = await retrieve({ root, query: 'uniqueNeedle needle' });
  const heapAfter = process.memoryUsage().heapUsed;
  t.diagnostic(`retrieve: ${result.stats.ms} ms, listed ${result.stats.listed}, scanned ${result.stats.scanned}, read ${result.stats.read}, bytes ${result.stats.bytesRead}, truncated ${result.stats.truncated}, timedOut ${result.stats.timedOut}, heap +${Math.round((heapAfter - heapBefore) / 1024 / 1024)} MB`);
  assert.ok(result.stats.listed <= 20000);
  assert.ok(result.stats.truncated, 'over 20,000 files: truncated');
  assert.ok(result.stats.ms < 2000 + 1500 + 1000, `took ${result.stats.ms} ms`);
  const quick = await retrieve({ root, query: 'item', limits: { discoveryMs: 30 } });
  t.diagnostic(`discovery limited to 30 ms: listed ${quick.stats.listed}, timedOut ${quick.stats.timedOut}, ${quick.stats.ms} ms`);
  assert.equal(quick.stats.timedOut, true);
});
