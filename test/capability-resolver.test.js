'use strict';

// Kenlith 0.11.0 hybrid model capability resolver (DEC-PLANCHAT-048,
// docs/kenlith-0.11.0/CAPABILITY-RESOLVER.md). Synthetic catalogs and the fake
// OpenAI server only; no network, no model request. Every row of the decision
// table has a case (CR-A*, CR-T*), then the catalog store, the records, the
// builder and service gates, and the engine paths.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, makeTempDir, setActiveTextEditor, setWorkspaceFolders, vscode } = require('./helpers/fake-vscode');
const { FakeOpenAI, completedStream, json } = require('./helpers/fake-openai');
const capabilities = require('../src/capabilities');
const { APPROVED_EFFORTS, ModelCatalog, RESTRICTED, StaleCatalogError, checkRecord, parseModelEntry, pickCapabilityFields } = capabilities;
const reasoning = require('../src/reasoning');
const { buildRequest, buildToolContinuation, withoutTools } = require('../src/request-builder');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatEngine } = require('../src/engine');
const { ChatPanels } = require('../src/panels');
const { RESEARCH_MODELS } = require('../src/research');

const ALL = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const LEVELS_OBJ = (list) => list.map((effort) => ({ effort, description: `${effort} description` }));
const ACCOUNT = 'user-1|synthetic.user@example.test';

// The MC-01 catalog shape (2026-11-25), written by hand from the accepted
// capability matrix: only the fields the resolver reads, plus a decoy field
// that must never be kept. Not the raw server response.
function mc01Catalog() {
  const six = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const five = ['low', 'medium', 'high', 'xhigh', 'max'];
  const entry = (slug, name, visibility, levels, flag) => ({ slug, display_name: name, visibility, supported_reasoning_levels: LEVELS_OBJ(levels), supports_reasoning_effort_updates: flag, base_instructions: 'decoy instructions that must not be kept', supports_search_tool: true });
  return [
    entry('gpt-6.2-sol', 'GPT-6.2-Sol', 'list', six, true),
    entry('gpt-6.2-astra', 'GPT-6.2-Astra', 'list', six, true),
    entry('gpt-6.1-terra', 'GPT-6.1 Terra', 'list', six, true),
    entry('hidden-model-a', 'Hidden Model A', 'hide', five, false),
    entry('gpt-6.1-sol', 'GPT-6.1-Sol', 'list', six, true),
    entry('gpt-6-astra', 'GPT-6-Astra', 'list', six, true),
    entry('gpt-6-sol', 'GPT-6-Sol', 'list', six, true),
    entry('gpt-6-luna', 'GPT-6-Luna', 'list', five, true),
    entry('gpt-5.6-sol', 'GPT-5.6-Sol', 'list', six, false),
    entry('gpt-5.6-terra', 'GPT-5.6-Terra', 'list', six, false),
    entry('gpt-5.6-luna', 'GPT-5.6-Luna', 'list', five, false),
    entry('hidden-model-b', 'Hidden Model B', 'hide', five, false)
  ];
}

async function catalogOf(entries, account = ACCOUNT) {
  const catalog = new ModelCatalog();
  await catalog.load(account, async () => entries);
  return catalog;
}
const effortsOf = async (entries, slug) => (await catalogOf(entries)).resolve(slug).efforts;
const one = (slug, extra = {}) => ({ slug, display_name: slug.toUpperCase(), visibility: 'list', ...extra });

// ---------------------------------------------------------------------------
// Validation (src/capabilities.js parseModelEntry)

test('CR-V1 levels in string and object form; unknown values, ultra, none, minimal and other case forms are dropped', () => {
  const p = (levels) => parseModelEntry(one('x', { supported_reasoning_levels: levels, supports_reasoning_effort_updates: true })).levels;
  assert.deepEqual(p(['low', 'high']), { state: 'valid', set: ['low', 'high'] });
  assert.deepEqual(p(LEVELS_OBJ(['max', 'low', 'ultra'])), { state: 'valid', set: ['low', 'max'] });
  assert.deepEqual(p(['low', { effort: 'medium' }]), { state: 'valid', set: ['low', 'medium'] });
  assert.deepEqual(p(['ultra', 'none', 'minimal', 'High', ' high', 'HIGH', 'turbo']), { state: 'valid', set: [] });
  assert.deepEqual(p(['high', 'high', { effort: 'high' }]), { state: 'valid', set: ['high'] });
  assert.deepEqual(p([]), { state: 'valid', set: [] });
});

test('CR-V2 absent and malformed levels', () => {
  const p = (extra) => parseModelEntry(one('x', extra)).levels.state;
  assert.equal(p({}), 'absent');
  assert.equal(p({ supported_reasoning_levels: null }), 'absent');
  for (const bad of ['low,high', 7, { low: true }, true, [['low']], [null], [7], [{ effort: 7 }], [{ level: 'low' }], new Array(17).fill('low')]) {
    assert.equal(p({ supported_reasoning_levels: bad }), 'malformed', JSON.stringify(bad));
  }
  assert.equal(p({ supported_reasoning_levels: new Array(16).fill('low') }), 'valid');
});

test('CR-V3 the effort-update flag: true, explicit false, absent, null, and wrongly typed', () => {
  const f = (extra) => parseModelEntry(one('x', extra)).flag;
  assert.equal(f({ supports_reasoning_effort_updates: true }), 'true');
  assert.equal(f({ supports_reasoning_effort_updates: false }), 'false');
  assert.equal(f({}), 'absent');
  assert.equal(f({ supports_reasoning_effort_updates: null }), 'absent');
  for (const bad of ['true', 'false', 1, 0, {}, []]) assert.equal(f({ supports_reasoning_effort_updates: bad }), 'invalid', JSON.stringify(bad));
});

test('CR-V4 only the capability fields are kept from a model-list entry', () => {
  const [raw] = mc01Catalog();
  const picked = pickCapabilityFields(raw);
  // 0.12.0 (DEC-PLANCHAT-050): web_search_tool_type is the one field added;
  // supports_search_tool is still never kept.
  assert.deepEqual(Object.keys(picked).sort(), ['display_name', 'id', 'name', 'slug', 'supported_reasoning_levels', 'supports_reasoning_effort_updates', 'visibility', 'web_search_tool_type']);
  assert.equal(Object.hasOwn(pickCapabilityFields(one('x', { supports_search_tool: true })), 'supports_search_tool'), false);
  assert.equal(parseModelEntry(pickCapabilityFields(one('x', { web_search_tool_type: { type: 'text' } }))).searchType, 'malformed');
  assert.equal(parseModelEntry(pickCapabilityFields(one('x', { web_search_tool_type: 'text_and_image' }))).searchType, 'text_and_image');
  assert.equal(JSON.stringify(picked).includes('decoy'), false);
  assert.equal(JSON.stringify(picked).includes('description'), false);
  assert.deepEqual(picked.supported_reasoning_levels[0], { effort: 'low' });
  // Malformed shapes stay malformed after picking (no repair).
  assert.equal(parseModelEntry(pickCapabilityFields(one('x', { supported_reasoning_levels: [7] }))).levels.state, 'malformed');
  assert.equal(parseModelEntry(pickCapabilityFields(one('x', { supported_reasoning_levels: [{ effort: 7 }] }))).levels.state, 'malformed');
});

// ---------------------------------------------------------------------------
// Decision table: availability (A1 to A6)

test('CR-A1 A2 absent, nameless and hidden models are unavailable: no levels at all', async () => {
  const catalog = await catalogOf([one('a'), { slug: '', display_name: 'x' }, { slug: 'nameless' }, one('h', { visibility: 'hide' }), one('o', { visibility: 'other' })]);
  assert.deepEqual(catalog.models.map((m) => m.id), ['a', 'nameless']);
  for (const slug of ['absent', 'h', 'o', '', undefined, 7]) {
    const record = catalog.resolve(slug);
    assert.equal(record.available, false, String(slug));
    assert.deepEqual(record.efforts, []);
    assert.equal(record.tier, 'unavailable');
  }
  assert.equal(catalog.resolve('h').diagnostic, 'hidden');
  assert.equal(catalog.resolve('absent').diagnostic, 'not-listed');
});

test('CR-A3 duplicate entries with conflicting visibility: unavailable (ambiguous identity)', async () => {
  const catalog = await catalogOf([one('gpt-6.2-sol'), one('gpt-6.1-sol'), one('gpt-6.2-sol', { visibility: 'hide' })]);
  assert.deepEqual(catalog.models.map((m) => m.id), ['gpt-6.1-sol']);
  assert.equal(catalog.resolve('gpt-6.2-sol').diagnostic, 'ambiguous-identity');
  // Missing visibility and "list" are the same class (0.10.0 rule): not a conflict.
  const same = await catalogOf([one('m1'), { slug: 'm1', display_name: 'M1' }]);
  assert.deepEqual(same.models.map((m) => m.id), ['m1']);
});

test('CR-A4 A5 duplicates listed once; identical metadata is kept, differing metadata is ambiguous', async () => {
  const meta = { supported_reasoning_levels: ['low', 'high'], supports_reasoning_effort_updates: true };
  const identical = await catalogOf([one('new-x', meta), one('new-x', meta)]);
  assert.deepEqual(identical.models.map((m) => m.id), ['new-x']);
  assert.deepEqual(identical.resolve('new-x').efforts, ['default', 'low', 'high']);
  const differing = await catalogOf([one('new-x', meta), one('new-x', { ...meta, supported_reasoning_levels: ['max'] })]);
  assert.deepEqual(differing.models.map((m) => m.id), ['new-x']);
  assert.deepEqual(differing.resolve('new-x').efforts, ['default']);
  // T8 comes before T9: for a model without a rule the disagreeing flag is reported.
  assert.equal(differing.resolve('new-x').diagnostic, 'effort-updates-ambiguous');
  // An approved model with ambiguous duplicates keeps its approved rule (T3).
  const approved = await catalogOf([one('gpt-6.1-sol', meta), one('gpt-6.1-sol', { ...meta, supports_reasoning_effort_updates: false })]);
  assert.deepEqual(approved.resolve('gpt-6.1-sol').efforts, ALL);
  assert.equal(approved.resolve('gpt-6.1-sol').diagnostic, 'metadata-ambiguous');
});

// ---------------------------------------------------------------------------
// Decision table: Thinking (T1 to T11)

test('CR-T1 restricted GPT-5.6 models: Default only with any metadata', async () => {
  assert.deepEqual(Object.keys(RESTRICTED).sort(), ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  for (const slug of Object.keys(RESTRICTED)) {
    for (const meta of [{}, { supported_reasoning_levels: ['low', 'high', 'max'], supports_reasoning_effort_updates: true }, { supported_reasoning_levels: 'bad' }]) {
      const record = (await catalogOf([one(slug, meta)])).resolve(slug);
      assert.deepEqual([record.tier, record.efforts], ['restricted', ['default']], `${slug} ${JSON.stringify(meta)}`);
    }
  }
});

test('CR-T2 approved rule with an explicit false flag: Default only (conservative; meaning not assumed)', async () => {
  const record = (await catalogOf([one('gpt-6.1-sol', { supported_reasoning_levels: ['low', 'high'], supports_reasoning_effort_updates: false })])).resolve('gpt-6.1-sol');
  assert.deepEqual([record.tier, record.efforts, record.diagnostic], ['approved', ['default'], 'effort-updates-false']);
  assert.deepEqual(await effortsOf([one('gpt-6-sol', { supports_reasoning_effort_updates: false })], 'gpt-6-sol'), ['default']);
});

test('CR-T3 approved rule with absent, malformed or ambiguous levels: the approved levels (0.10.0 compatibility)', async () => {
  for (const slug of Object.keys(APPROVED_EFFORTS)) {
    assert.deepEqual(await effortsOf([one(slug)], slug), ALL, `${slug} absent`);
    assert.deepEqual(await effortsOf([one(slug, { supported_reasoning_levels: 'low' })], slug), ALL, `${slug} malformed`);
    assert.deepEqual(await effortsOf([one(slug, { supported_reasoning_levels: [{}], supports_reasoning_effort_updates: true })], slug), ALL);
  }
  // A missing or mistyped flag does not reduce an approved rule.
  assert.deepEqual(await effortsOf([one('gpt-6-luna', { supports_reasoning_effort_updates: 'yes' })], 'gpt-6-luna'), ALL);
});

test('CR-T4 approved rule with valid metadata and no recognized level: Default only (valid contradictory evidence)', async () => {
  for (const levels of [[], ['ultra'], ['none', 'minimal']]) {
    const record = (await catalogOf([one('gpt-6-astra', { supported_reasoning_levels: levels, supports_reasoning_effort_updates: true })])).resolve('gpt-6-astra');
    assert.deepEqual([record.efforts, record.diagnostic], [['default'], 'no-recognized-levels'], JSON.stringify(levels));
  }
});

test('CR-T5 T6 approved rule narrowed by valid metadata, never widened', async () => {
  // T6: intersection.
  const narrowed = (await catalogOf([one('gpt-6.1-terra', { supported_reasoning_levels: ['low', 'high', 'ultra'], supports_reasoning_effort_updates: true })])).resolve('gpt-6.1-terra');
  assert.deepEqual([narrowed.tier, narrowed.efforts, narrowed.diagnostic], ['approved', ['default', 'low', 'high'], undefined]);
  // A flag that is missing or mistyped is reported, not used against the rule.
  const noFlag = (await catalogOf([one('gpt-6.1-terra', { supported_reasoning_levels: ['medium'] })])).resolve('gpt-6.1-terra');
  assert.deepEqual([noFlag.efforts, noFlag.diagnostic], [['default', 'medium'], 'effort-updates-absent']);
  // The MC-01 metadata of the approved models gives exactly the approved levels.
  for (const slug of Object.keys(APPROVED_EFFORTS)) assert.deepEqual(await effortsOf(mc01Catalog(), slug), ALL, slug);
});

test('CR-T5 empty intersection: with today\'s approved rules (all five levels) it cannot occur; any recognized set intersects', async () => {
  // Row T5 guards a future approved rule narrower than the five levels. Today
  // every approved rule has all five, so a non-empty recognized set S always
  // gives approved ∩ S = S (T6), and S empty is T4.
  for (const slug of Object.keys(APPROVED_EFFORTS)) assert.deepEqual(APPROVED_EFFORTS[slug], ['low', 'medium', 'high', 'xhigh', 'max']);
  const subsets = [['low'], ['max'], ['medium', 'xhigh'], ['low', 'medium', 'high', 'xhigh', 'max']];
  for (const set of subsets) {
    const record = (await catalogOf([one('gpt-6-sol', { supported_reasoning_levels: set, supports_reasoning_effort_updates: true })])).resolve('gpt-6-sol');
    assert.deepEqual(record.efforts, ['default', ...set], JSON.stringify(set));
  }
});

test('CR-T7 T8 no rule: the flag must be exactly true', async () => {
  const levels = { supported_reasoning_levels: ['low', 'high'] };
  for (const [flag, note] of [[false, 'effort-updates-false'], [undefined, 'effort-updates-absent'], [null, 'effort-updates-absent'], ['true', 'effort-updates-invalid'], [1, 'effort-updates-invalid']]) {
    const extra = flag === undefined ? levels : { ...levels, supports_reasoning_effort_updates: flag };
    const record = (await catalogOf([one('gpt-9-nova', extra)])).resolve('gpt-9-nova');
    assert.deepEqual([record.tier, record.efforts, record.diagnostic], ['fallback', ['default'], note], String(flag));
  }
});

test('CR-T9 T10 no rule, flag true, but levels absent, malformed, ambiguous or none recognized: Default only', async () => {
  const flag = { supports_reasoning_effort_updates: true };
  for (const [extra, note] of [[{}, 'metadata-absent'], [{ supported_reasoning_levels: 'low' }, 'metadata-malformed'], [{ supported_reasoning_levels: ['ultra'] }, 'no-recognized-levels'], [{ supported_reasoning_levels: [] }, 'no-recognized-levels']]) {
    const record = (await catalogOf([one('gpt-9-nova', { ...flag, ...extra })])).resolve('gpt-9-nova');
    assert.deepEqual([record.tier, record.efforts, record.diagnostic], ['fallback', ['default'], note], JSON.stringify(extra));
  }
});

test('CR-T11 no rule, flag true, recognized levels: advertised, in canonical order, never ultra', async () => {
  const record = (await catalogOf([one('gpt-9-nova', { supported_reasoning_levels: ['max', 'ultra', 'low', 'medium'], supports_reasoning_effort_updates: true })])).resolve('gpt-9-nova');
  assert.deepEqual([record.tier, record.efforts, record.diagnostic], ['advertised', ['default', 'low', 'medium', 'max'], undefined]);
});

test('CR-M1 the MC-01 catalog resolves to the reconciled table', async () => {
  const catalog = await catalogOf(mc01Catalog());
  assert.deepEqual(catalog.models.map((m) => m.id), ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  const table = Object.fromEntries(catalog.models.map((m) => { const r = catalog.resolve(m.id); return [m.id, `${r.tier}:${r.efforts.join(',')}`]; }));
  assert.deepEqual(table, {
    'gpt-6.2-sol': 'advertised:default,low,medium,high,xhigh,max',
    'gpt-6.2-astra': 'advertised:default,low,medium,high,xhigh,max',
    'gpt-6.1-terra': 'approved:default,low,medium,high,xhigh,max',
    'gpt-6.1-sol': 'approved:default,low,medium,high,xhigh,max',
    'gpt-6-astra': 'approved:default,low,medium,high,xhigh,max',
    'gpt-6-sol': 'approved:default,low,medium,high,xhigh,max',
    'gpt-6-luna': 'approved:default,low,medium,high,xhigh,max',
    'gpt-5.6-sol': 'restricted:default',
    'gpt-5.6-terra': 'restricted:default',
    'gpt-5.6-luna': 'restricted:default'
  });
  for (const hidden of ['hidden-model-a', 'hidden-model-b']) assert.equal(catalog.resolve(hidden).available, false);
  // No resolution anywhere offers a value outside the six choices.
  for (const m of catalog.models) for (const e of catalog.resolve(m.id).efforts) assert.ok(ALL.includes(e));
});

// 0.12.0 (DEC-PLANCHAT-050): the record now carries web search and Deep
// Research next to Thinking. The verified table is the DEC-PLANCHAT-044 table
// plus the two GPT-6.2 models (DEC-PLANCHAT-054); supports_search_tool still
// has no effect on anything.
test('CR-M2 (0.12.0) web capability is in the record; the verified table is the 044 table plus GPT-6.2; supports_search_tool has no effect', async () => {
  assert.deepEqual(Object.keys(RESEARCH_MODELS).sort(), ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-astra', 'gpt-6.2-sol']);
  const catalog = await catalogOf([...mc01Catalog(), one('gpt-7-nova')]);
  for (const field of Object.keys(catalog.resolve('gpt-6.2-sol'))) assert.ok(['slug', 'available', 'tier', 'efforts', 'diagnostic', 'search', 'research'].includes(field), field);
  // MC-01 shape has no web_search_tool_type: GPT-6.2 is verified all the same
  // (DEC-PLANCHAT-054); a model with no entry and no metadata is not eligible.
  assert.deepEqual({ ...catalog.resolve('gpt-6.2-sol').search }, { tier: 'verified', offered: true, diagnostic: undefined });
  assert.deepEqual({ ...catalog.resolve('gpt-6.2-sol').research }, { tier: 'verified', allowed: true, diagnostic: undefined });
  assert.deepEqual({ ...catalog.resolve('gpt-7-nova').search }, { tier: 'unknown', offered: false, diagnostic: 'search-type-absent' });
  assert.deepEqual({ ...catalog.resolve('gpt-7-nova').research }, { tier: 'unverified', allowed: false, diagnostic: 'not-live-verified' });
  for (const flag of [true, false, 'yes', undefined]) {
    const entries = [...mc01Catalog(), one('gpt-7-nova')].map((entry) => ({ ...entry, supports_search_tool: flag }));
    const other = await catalogOf(entries);
    for (const slug of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-luna', 'gpt-7-nova']) {
      assert.deepEqual({ ...other.resolve(slug).search }, { ...catalog.resolve(slug).search }, `${slug} ${flag}`);
      assert.deepEqual({ ...other.resolve(slug).research }, { ...catalog.resolve(slug).research }, `${slug} ${flag}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Catalog store: single-flight, generations, staleness

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('CR-C1 concurrent loads for one account share one fetch; sequential loads reuse the result', async () => {
  const catalog = new ModelCatalog();
  let fetches = 0;
  const gate = deferred();
  const fetchList = () => { fetches += 1; return gate.promise; };
  const a = catalog.load(ACCOUNT, fetchList);
  const b = catalog.load(ACCOUNT, fetchList);
  assert.equal(a, b);
  gate.resolve([one('gpt-6.1-sol')]);
  await Promise.all([a, b]);
  await catalog.load(ACCOUNT, fetchList);
  await catalog.load(ACCOUNT, fetchList);
  assert.equal(fetches, 1);
});

test('CR-C2 a late response from an invalidated generation never installs', async () => {
  const catalog = new ModelCatalog();
  const gate = deferred();
  const late = catalog.load(ACCOUNT, () => gate.promise);
  catalog.invalidate();
  gate.resolve([one('stale-model')]);
  await assert.rejects(late, StaleCatalogError);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.resolve('stale-model').available, false);
});

test('CR-C3 sign-out then sign-in to the same account: the response from before is discarded', async () => {
  const catalog = new ModelCatalog();
  const before = deferred();
  const old = catalog.load(ACCOUNT, () => before.promise);
  catalog.invalidate(); // sign-out
  catalog.invalidate(); // sign-in, same account
  const now = catalog.load(ACCOUNT, async () => [one('fresh')]);
  await now;
  before.resolve([one('from-before')]);
  await assert.rejects(old, StaleCatalogError);
  assert.deepEqual(catalog.models.map((m) => m.id), ['fresh']);
});

test('CR-C4 account switch: a load for another account invalidates first; the first account never installs', async () => {
  const catalog = new ModelCatalog();
  const gateA = deferred();
  const loadA = catalog.load('A|a', () => gateA.promise);
  const loadB = catalog.load('B|b', async () => [one('model-b')]);
  await loadB;
  gateA.resolve([one('model-a')]);
  await assert.rejects(loadA, StaleCatalogError);
  assert.deepEqual([catalog.accountKey, catalog.models.map((m) => m.id)], ['B|b', ['model-b']]);
  // A cached account is replaced when another account loads.
  await catalog.load('A|a', async () => [one('model-a2')]);
  assert.deepEqual([catalog.accountKey, catalog.models.map((m) => m.id)], ['A|a', ['model-a2']]);
});

test('CR-C5 noteAccount: same account (cached or loading) keeps; another account or signed out invalidates', async () => {
  const catalog = new ModelCatalog();
  const gate = deferred();
  const loading = catalog.load(ACCOUNT, () => gate.promise);
  const generation = catalog.generation;
  assert.equal(catalog.noteAccount(ACCOUNT), false);
  assert.equal(catalog.generation, generation);
  gate.resolve([one('gpt-6.1-sol')]);
  await loading;
  assert.equal(catalog.noteAccount(ACCOUNT), false);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.noteAccount('other|x'), true);
  assert.deepEqual(catalog.models, []);
  await catalog.load(ACCOUNT, async () => [one('gpt-6.1-sol')]);
  assert.equal(catalog.noteAccount(''), true);
  assert.deepEqual(catalog.models, []);
});

test('CR-C6 a failed load caches nothing; an empty list is an error; no account, no load', async () => {
  const catalog = new ModelCatalog();
  let fetches = 0;
  await assert.rejects(catalog.load(ACCOUNT, async () => { fetches += 1; throw new Error('network'); }), /network/);
  await assert.rejects(catalog.load(ACCOUNT, async () => { fetches += 1; return [one('h', { visibility: 'hide' })]; }), /No eligible models/);
  await catalog.load(ACCOUNT, async () => { fetches += 1; return [one('gpt-6.1-sol')]; });
  assert.equal(fetches, 3);
  await assert.rejects(new ModelCatalog().load('', async () => [one('x')]), /Continue with ChatGPT/);
});

// ---------------------------------------------------------------------------
// Capability records and the builder and service gates

test('CR-R1 records are frozen, issued by their catalog, and stale after any change', async () => {
  const catalog = await catalogOf(mc01Catalog());
  const record = catalog.resolve('gpt-6.2-sol');
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.efforts));
  assert.equal(checkRecord(record, 'gpt-6.2-sol', 'max'), true);
  assert.throws(() => checkRecord({ ...record }, 'gpt-6.2-sol', 'high'), /could not confirm/);
  assert.throws(() => checkRecord(record, 'gpt-6.1-sol', 'high'), /another model/);
  assert.throws(() => checkRecord(record, 'gpt-6.2-sol', 'ultra'), /not available/);
  assert.throws(() => checkRecord(catalog.resolve('hidden-model-a'), 'hidden-model-a'), /not available for this ChatGPT account/);
  const other = await catalogOf(mc01Catalog());
  assert.equal(other.isCurrent(record), false, 'a record belongs to the catalog that issued it');
  catalog.invalidate();
  assert.throws(() => checkRecord(record, 'gpt-6.2-sol', 'high'), /changed after this message was prepared/);
});

const args = (extra) => ({ instructions: 'i', history: [], text: 'q', ...extra });

test('CR-B1 the builder refuses a missing, forged, foreign-model, stale or unavailable record, and levels outside it', async () => {
  const catalog = await catalogOf(mc01Catalog());
  const sol = catalog.resolve('gpt-6.2-sol');
  assert.throws(() => buildRequest(args({ model: 'gpt-6.2-sol' })), /could not confirm/);
  assert.throws(() => buildRequest(args({ model: 'gpt-6.2-sol', effort: 'high' })), /could not confirm/);
  assert.throws(() => buildRequest(args({ model: 'gpt-6.2-sol', capability: { slug: 'gpt-6.2-sol', available: true, efforts: ALL } })), /could not confirm/);
  assert.throws(() => buildRequest(args({ model: 'gpt-6.2-sol', effort: 'high', capability: { ...sol } })), /could not confirm/);
  assert.throws(() => buildRequest(args({ model: 'gpt-6.1-sol', capability: sol })), /another model/);
  assert.throws(() => buildRequest(args({ model: 'hidden-model-a', capability: catalog.resolve('hidden-model-a') })), /not available for this ChatGPT account/);
  assert.throws(() => buildRequest(args({ model: 'gpt-5.6-sol', effort: 'high', capability: catalog.resolve('gpt-5.6-sol') })), /"High" is not available/);
  assert.throws(() => buildRequest(args({ model: 'gpt-6.2-sol', effort: 'ultra', capability: sol })), /did not recognise/);
  const stale = catalog.resolve('gpt-6.2-sol');
  catalog.invalidate();
  assert.throws(() => buildRequest(args({ model: 'gpt-6.2-sol', capability: stale })), /changed after this message was prepared/);
});

test('CR-B2 Default omits reasoning for every tier; an advertised level is sent as it is', async () => {
  const catalog = await catalogOf(mc01Catalog());
  for (const slug of ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-sol']) {
    const request = buildRequest(args({ model: slug, effort: 'default', capability: catalog.resolve(slug) }));
    assert.equal(request.reasoning, undefined, slug);
    assert.equal(buildRequest(args({ model: slug, capability: catalog.resolve(slug) })).reasoning, undefined);
  }
  const max = buildRequest(args({ model: 'gpt-6.2-astra', effort: 'max', capability: catalog.resolve('gpt-6.2-astra') }));
  assert.deepEqual([max.reasoning, max.reasoningModel, max.capability.tier], [{ effort: 'max' }, 'gpt-6.2-astra', 'advertised']);
});

function serviceFor(catalog) {
  const auth = { getAccessToken: async () => 'synthetic-access' };
  const service = new OpenAIService(auth);
  if (catalog) service.useCatalog(catalog);
  return service;
}

test('CR-S1 the service sends nothing without its window catalog, for another catalog, or for a stale record', async () => {
  const server = new FakeOpenAI().install();
  let sent = 0;
  server.responsesHandler = () => { sent += 1; return completedStream('ok'); };
  try {
    const catalog = await catalogOf(mc01Catalog());
    const request = buildRequest(args({ model: 'gpt-6.2-sol', effort: 'high', capability: catalog.resolve('gpt-6.2-sol') }));
    await assert.rejects(serviceFor(undefined).streamResponse({ model: 'gpt-6.2-sol', request, onDelta() {} }), /not checked for this window/);
    await assert.rejects(serviceFor(await catalogOf(mc01Catalog())).streamResponse({ model: 'gpt-6.2-sol', request, onDelta() {} }), /not checked for this window/);
    await assert.rejects(serviceFor(catalog).streamResponse({ model: 'gpt-6.1-sol', request, onDelta() {} }), /checked for another model/);
    const bound = serviceFor(catalog);
    catalog.invalidate();
    await assert.rejects(bound.streamResponse({ model: 'gpt-6.2-sol', request, onDelta() {} }), /changed after this message was prepared/);
    assert.equal(sent, 0);
    assert.equal(server.requestsTo('/v1/responses').length, 0);
    // The same request with a current record of the bound catalog is sent, with its level.
    const fresh = await catalogOf(mc01Catalog());
    const ok = buildRequest(args({ model: 'gpt-6.2-sol', effort: 'high', capability: fresh.resolve('gpt-6.2-sol') }));
    await serviceFor(fresh).streamResponse({ model: 'gpt-6.2-sol', request: ok, onDelta() {} });
    assert.equal(sent, 1);
    assert.deepEqual(server.requestsTo('/v1/responses')[0].json.reasoning, { effort: 'high' });
  } finally {
    server.uninstall();
  }
});

test('CR-S2 continuations and the request without tools keep the record and stay checked', async () => {
  const catalog = await catalogOf(mc01Catalog());
  const record = catalog.resolve('gpt-6.2-sol');
  const tools = [{ type: 'function', name: 'project_read_file', parameters: { type: 'object', properties: {} } }];
  const request = buildRequest(args({ model: 'gpt-6.2-sol', effort: 'medium', capability: record, tools }));
  const next = buildToolContinuation(request, { calls: [{ callId: 'c1', name: 'project_read_file', arguments: '{}' }], outputs: [{ callId: 'c1', output: '{}' }] });
  assert.equal(next.capability, record);
  assert.equal(withoutTools(request).capability, record);
  catalog.invalidate();
  const server = new FakeOpenAI().install();
  try {
    await assert.rejects(serviceFor(catalog).streamResponse({ model: 'gpt-6.2-sol', request: next, preflight: async () => {}, onDelta() {} }), /changed after this message was prepared/);
    assert.equal(server.requestsTo('/v1/responses').length, 0);
  } finally {
    server.uninstall();
  }
});

test('CR-S3 the rejection text names an advertised level and never retries', () => {
  const error = { status: 400, param: 'reasoning.effort', message: 'unsupported' };
  assert.match(reasoning.effortRejection(error, 'high', { tier: 'advertised' }), /listed for your ChatGPT account but was not accepted/);
  assert.doesNotMatch(reasoning.effortRejection(error, 'high', { tier: 'approved' }), /listed for your ChatGPT account/);
  assert.match(reasoning.effortRejection({ code: 'subscription_sharing_unsupported_capability' }, 'max', { tier: 'advertised' }), /did not retry[\s\S]*listed for your ChatGPT account/);
});

// ---------------------------------------------------------------------------
// The view model (effortView) and saved selections

test('CR-U1 the composer options come from records; ultra never appears; an unavailable saved level is named', async () => {
  const catalog = await catalogOf(mc01Catalog());
  const view = reasoning.effortView({ chatEffort: 'xhigh', model: 'gpt-6.2-sol', models: catalog.models, catalog });
  assert.deepEqual([view.options, view.effective, view.note], [ALL, 'xhigh', '']);
  assert.deepEqual(view.byModel['gpt-5.6-sol'], ['default']);
  assert.deepEqual(view.byModel['gpt-6.2-astra'], ALL);
  assert.equal(JSON.stringify(view).includes('ultra'), false);
  const luna = reasoning.effortView({ chatEffort: 'high', model: 'gpt-5.6-luna', models: catalog.models, catalog });
  assert.deepEqual([luna.choice, luna.effective, luna.note], ['high', 'default', "High isn't available for this model. Your next message uses Default."]);
  assert.equal(luna.unavailableNotes.xhigh, "Extra High isn't available for this model. Your next message uses Default.");
});

// ---------------------------------------------------------------------------
// The engine

const SESSION = { email: 'synthetic.user@example.test', subject: 'user-1', scopes: ['chatgpt.tokens.use.direct'] };

function projectFolder() {
  const base = makeTempDir();
  const directory = path.join(base, 'calc');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('README.md', '# Calculator\n\nAdds numbers. The entry point is src/calculator.js.\n');
  write('src/calculator.js', 'function addAll(list) {\n  return list.reduce((sum, value) => sum + value, 0);\n}\nmodule.exports = { addAll };\n');
  return directory;
}

let server;
test.beforeEach(() => {
  calls.panels.length = 0;
  server = new FakeOpenAI().install();
  server.models = mc01Catalog();
});
test.afterEach(() => {
  server.uninstall();
  setWorkspaceFolders(undefined);
  setActiveTextEditor(undefined);
  config.reset();
  vscode.workspace.isTrusted = true;
});

function scripted(script = () => ({ text: 'ok' })) {
  const bodies = [];
  server.responsesHandler = (request) => {
    bodies.push(request.json);
    const decision = script(request.json, bodies.length);
    if (decision.status) return json(decision.status, decision.body);
    return completedStream(decision.text || 'ok');
  };
  return bodies;
}

async function openWindow({ session = SESSION, service } = {}) {
  const context = createContext({ storageDir: makeTempDir() });
  const state = { session };
  // Like src/auth.js: the session epoch rises at each sign-in (before the new
  // credentials exist) and at each sign-out.
  const auth = {
    sessionEpoch: 0,
    getSession: async () => state.session,
    getAccessToken: async () => 'synthetic-access',
    signIn: async () => { auth.sessionEpoch += 1; state.session = SESSION; },
    signOut: async () => { auth.sessionEpoch += 1; state.session = undefined; return { remoteRevoked: true }; }
  };
  const store = new ConversationStore(context);
  const engine = new ChatEngine(context, auth, service || new OpenAIService(auth), store, { writeClipboard: async () => {}, openExternal: async () => {} });
  await engine.prepare();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const tab = async (id) => {
    if (!id) { store.currentId = undefined; id = (await store.newConversation()).id; }
    await panels.openChat(id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    const posted = (type) => panel.posted.filter((m) => m.type === type);
    return {
      id,
      panel,
      shown: () => panel.posted.filter((m) => m.type === 'reasoning' || m.type === 'hydrate').at(-1)?.reasoning,
      send: (text, { model, effort, search } = {}) => panel.send({ type: 'send', text, model, effort, ...(search ? { search: true } : {}) }),
      decide: (choice) => panel.send({ type: 'consentDecision', choice }),
      selectModel: (model) => panel.send({ type: 'selectModel', model }),
      card: () => posted('consent').at(-1)?.consent,
      errors: () => [...posted('messageUpdated').filter((m) => m.error).map((m) => String(m.content)), ...posted('error').map((m) => String(m.message))]
    };
  };
  return { context, state, auth, store, engine, panels, tab };
}

test('CR-E1 an advertised level reaches the body; Default omits reasoning; ultra is refused before anything', async () => {
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  assert.deepEqual(chat.shown().byModel['gpt-6.2-sol'], ALL);
  await chat.send('first', { model: 'gpt-6.2-sol', effort: 'max' });
  await chat.send('second', { model: 'gpt-6.2-sol', effort: 'default' });
  await chat.send('third', { model: 'gpt-6.2-sol', effort: 'ultra' });
  assert.equal(bodies.length, 2);
  assert.deepEqual([bodies[0].model, bodies[0].reasoning], ['gpt-6.2-sol', { effort: 'max' }]);
  assert.equal(Object.hasOwn(bodies[1], 'reasoning'), false);
  assert.ok(chat.errors().some((e) => /did not recognise/.test(e)));
});

test('CR-E2 GPT-5.6 stays Default only; a level for it is refused and nothing is sent', async () => {
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  assert.deepEqual(chat.shown().byModel['gpt-5.6-sol'], ['default']);
  await chat.send('q', { model: 'gpt-5.6-sol', effort: 'high' });
  assert.equal(bodies.length, 0);
  assert.ok(chat.errors().some((e) => /"High" is not available for this model/.test(e)));
});

test('CR-E3 hidden and ambiguous models are not offered and cannot be sent to', async () => {
  server.models = [...mc01Catalog(), { slug: 'twin', display_name: 'Twin', visibility: 'list' }, { slug: 'twin', display_name: 'Twin', visibility: 'hide' }];
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  const offered = w.engine.models.map((m) => m.id);
  for (const slug of ['hidden-model-a', 'hidden-model-b', 'twin']) {
    assert.equal(offered.includes(slug), false, slug);
    await chat.send(`to ${slug}`, { model: slug });
  }
  assert.equal(bodies.length, 0);
  assert.equal(chat.errors().filter((e) => /not available for this ChatGPT account/.test(e)).length, 3);
});

// 0.12.0 (DEC-PLANCHAT-050/051/054): Search web is gone. A legacy `search:
// true` is an ordinary message (automatic search, never forced). A model with
// no verified entry and no web_search_tool_type is offered no web search;
// verified models (GPT-6.1-Sol, and GPT-6.2-Sol since DEC-PLANCHAT-054) are.
test('CR-E4 (0.12.0) legacy Search web is an ordinary send; no automatic search without eligible metadata, offered for a verified model', async () => {
  server.models = [...mc01Catalog(), one('gpt-7-nova')];
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('current news', { model: 'gpt-7-nova', search: true });
  assert.equal(bodies.length, 1, 'sent once, as an ordinary message');
  assert.equal(bodies.at(-1).tools, undefined, 'never a forced search, and no search without eligible metadata');
  assert.equal(bodies.at(-1).tool_choice, undefined);
  await chat.send('plain question', { model: 'gpt-7-nova' });
  assert.equal(bodies.at(-1).tools, undefined, 'no automatic web search for a model without eligible metadata');
  for (const model of ['gpt-6.1-sol', 'gpt-6.2-sol']) {
    await chat.send('current news', { model, search: true });
    assert.deepEqual(bodies.at(-1).tools, [{ type: 'web_search' }], model);
    assert.equal(bodies.at(-1).tool_choice, 'auto', `${model}: automatic, never forced`);
  }
});

test('CR-E5 one /v1/models request: sign-in and the session check right after it share one load', async () => {
  const w = await openWindow({ session: undefined });
  assert.equal(server.requestsTo('/v1/models').length, 0);
  // Sign-in hydrates; the secrets change event runs the 0.4.0 session check at the same time.
  await Promise.all([w.engine.signIn(), w.engine.sessionChanged()]);
  await w.engine.sessionChanged();
  await w.engine.ensureModels();
  const chat = await w.tab();
  await chat.send('q', { model: 'gpt-6.2-sol' });
  assert.equal(server.requestsTo('/v1/models').length, 1);
});

test('CR-E6 sequential hydrations and sends reuse the catalog; sign-out and sign-in load it again once', async () => {
  scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('a', { model: 'gpt-6.1-sol' });
  await chat.send('b', { model: 'gpt-6.2-sol', effort: 'low' });
  await w.engine.sessionChanged();
  assert.equal(server.requestsTo('/v1/models').length, 1);
  await w.engine.signOut();
  assert.deepEqual(w.engine.models, []);
  await w.engine.signIn();
  assert.equal(server.requestsTo('/v1/models').length, 2);
});

test('CR-E7 a model-list answer from before sign-out never fills the catalog after sign-in to the same account', async () => {
  const gates = [];
  let fetches = 0;
  const service = {
    listModelCatalog: () => { fetches += 1; const gate = deferred(); gates.push(gate); return gate.promise; },
    streamResponse: async () => ''
  };
  const w = await openWindow({ session: undefined, service });
  w.state.session = SESSION;
  const hydrating = w.engine.ensureModels().catch((error) => error);
  await w.engine.signOut().catch(() => undefined);
  const signingIn = w.engine.signIn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  gates.at(-1).resolve([one('fresh-model')]);
  await signingIn;
  gates[0].resolve([one('from-before')]);
  assert.ok((await hydrating) instanceof StaleCatalogError);
  assert.deepEqual(w.engine.models.map((m) => m.id), ['fresh-model']);
  assert.ok(fetches >= 2);
});

test('CR-E8 account switch: the catalog is replaced; a record of the old account cannot be sent', async () => {
  scripted();
  const w = await openWindow();
  await w.engine.ensureModels();
  // As at activation (src/extension.js): the session check knows the account.
  await w.engine.rememberSession();
  const old = w.engine.catalog.resolve('gpt-6.2-sol');
  w.state.session = { ...SESSION, subject: 'user-2', email: 'second.user@example.test' };
  server.models = [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' }];
  await w.engine.sessionChanged();
  assert.deepEqual(w.engine.models.map((m) => m.id), ['gpt-6.1-sol']);
  assert.equal(w.engine.catalog.isCurrent(old), false);
  assert.throws(() => checkRecord(old, 'gpt-6.2-sol'), /changed after this message was prepared/);
  assert.equal(server.requestsTo('/v1/models').length, 2);
});

test('CR-E9 a held request keeps its model and level, and is checked again after Allow: refused when no longer valid', async () => {
  setWorkspaceFolders([projectFolder()]);
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('How does addAll sum the list?', { model: 'gpt-6.2-sol', effort: 'high' });
  assert.ok(chat.card(), 'the sharing card holds the request');
  assert.equal(bodies.length, 0);
  // The page changes model meanwhile; the held request keeps gpt-6.2-sol High.
  await chat.selectModel('gpt-6.1-sol');
  // The model list changes: gpt-6.2-sol now explicitly false (the session loads it again).
  server.models = mc01Catalog().map((m) => (m.slug === 'gpt-6.2-sol' ? { ...m, supports_reasoning_effort_updates: false } : m));
  w.engine.catalog.invalidate();
  await chat.decide('allow');
  assert.equal(bodies.length, 0, 'nothing was sent');
  assert.ok(chat.errors().some((e) => /"High" is not available for this model/.test(e)));
  const stored = await w.store.getConversation(chat.id);
  assert.equal(stored.messages.length, 0);
});

test('CR-E10 a held request still valid after Allow is sent with the held model and level, not the page\'s new choice', async () => {
  setWorkspaceFolders([projectFolder()]);
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('How does addAll sum the list?', { model: 'gpt-6.2-sol', effort: 'high' });
  await chat.selectModel('gpt-6.1-sol');
  await chat.decide('without');
  assert.equal(bodies.length, 1);
  assert.deepEqual([bodies[0].model, bodies[0].reasoning], ['gpt-6.2-sol', { effort: 'high' }]);
});

test('CR-E11 a held request whose model disappeared is refused after the sharing answer; nothing changed', async () => {
  setWorkspaceFolders([projectFolder()]);
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('How does addAll sum the list?', { model: 'gpt-6.2-astra', effort: 'xhigh' });
  server.models = mc01Catalog().filter((m) => m.slug !== 'gpt-6.2-astra');
  w.engine.catalog.invalidate();
  await chat.decide('without');
  assert.equal(bodies.length, 0);
  assert.ok(chat.errors().some((e) => /"gpt-6.2-astra" is not available for this ChatGPT account/.test(e)));
});

test('CR-E12 saved chats: the stored level is never changed; unavailable is named; it returns when available again', async () => {
  const bodies = scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await w.store.setConversationModel(chat.id, 'gpt-6.2-sol');
  await w.store.setConversationEffort(chat.id, 'xhigh');
  await chat.panel.send({ type: 'ready' });
  assert.deepEqual([chat.shown().choice, chat.shown().effective], ['xhigh', 'xhigh']);
  server.models = mc01Catalog().map((m) => (m.slug === 'gpt-6.2-sol' ? { ...m, supports_reasoning_effort_updates: false } : m));
  w.engine.catalog.invalidate();
  await w.engine.ensureModels();
  await chat.panel.send({ type: 'ready' });
  assert.deepEqual([chat.shown().choice, chat.shown().effective, chat.shown().note], ['xhigh', 'default', "Extra High isn't available for this model. Your next message uses Default."]);
  await chat.send('with Default, as shown', { model: 'gpt-6.2-sol', effort: 'default' });
  assert.equal(Object.hasOwn(bodies.at(-1), 'reasoning'), false);
  assert.equal((await w.store.getConversation(chat.id)).reasoningEffort, 'xhigh', 'the saved level is unchanged');
  server.models = mc01Catalog();
  w.engine.catalog.invalidate();
  await w.engine.ensureModels();
  await chat.panel.send({ type: 'ready' });
  assert.deepEqual([chat.shown().effective, chat.shown().note], ['xhigh', '']);
});

test('CR-E13 a server rejection of an advertised level: one request, no retry, no switch, no change of level', async () => {
  const bodies = scripted((body) => (body.reasoning ? { status: 400, body: { error: { message: 'Unsupported value for reasoning.effort', param: 'reasoning.effort' } } } : { text: 'ok' }));
  const w = await openWindow();
  const chat = await w.tab();
  await w.store.setConversationEffort(chat.id, 'max');
  await chat.send('q', { model: 'gpt-6.2-sol', effort: 'max' });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, 'gpt-6.2-sol');
  assert.ok(chat.errors().some((e) => /listed for your ChatGPT account but was not accepted/.test(e)));
  const stored = await w.store.getConversation(chat.id);
  assert.deepEqual([stored.reasoningEffort, stored.model], ['max', 'gpt-6.2-sol']);
});

test('CR-E14 capability metadata stays in memory: nothing of it is written to storage or settings', async () => {
  scripted();
  const w = await openWindow();
  const chat = await w.tab();
  await chat.send('q', { model: 'gpt-6.2-sol', effort: 'medium' });
  const stored = JSON.stringify([...w.context.stateValues.entries()]) + fs.readdirSync(w.context.storageDir).map((f) => { try { return fs.readFileSync(path.join(w.context.storageDir, f), 'utf8'); } catch { return ''; } }).join('');
  for (const word of ['supported_reasoning_levels', 'supports_reasoning_effort_updates', 'advertised', 'decoy', 'GPT-6.2-Astra']) assert.equal(stored.includes(word), false, word);
});
