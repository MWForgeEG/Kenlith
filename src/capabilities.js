'use strict';

// Kenlith 0.11.0 (DEC-PLANCHAT-048): the one model capability resolver.
// Design and decision table: docs/kenlith-0.11.0/CAPABILITY-RESOLVER.md.
//
// Scope: Thinking levels only. Search web, automatic search and Deep Research
// are decided by src/research.js (RESEARCH_MODELS, DEC-PLANCHAT-044) and are
// not touched here.
//
// Precedence, the same order everywhere:
//   1. model availability in the current session's catalog;
//   2. explicit restrictions (Default only);
//   3. approved compatibility rules, constrained by valid advertised metadata;
//   4. eligible advertised capabilities (no rule);
//   5. safe fallback: Default only.
//
// "Advertised" means listed by the signed-in account's /v1/models response.
// Those fields are not in OpenAI's Sign in with ChatGPT documentation, so they
// are validated here, bounded by the recognized levels, and never described as
// verified. Only the validated subset is kept, in memory, per session.

// The recognized levels, in display order. Nothing else is ever offered or
// sent (`ultra`, `none`, `minimal`, other case forms and unknown strings are
// dropped). `default` is Kenlith's own value: no `reasoning` field.
const LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT = 'default';
const MAX_LEVEL_ENTRIES = 16;

// Approved compatibility rules (DEC-PLANCHAT-040): the levels the official
// model pages document for these exact slugs. An approved rule is not a claim
// that every level was tested live (docs/kenlith-0.11.0/CAPABILITY-RESOLVER.md §7).
const APPROVED_EFFORTS = Object.freeze({
  'gpt-6.1-sol': LEVELS,
  'gpt-6-astra': LEVELS,
  'gpt-6.1-terra': LEVELS,
  'gpt-6-sol': LEVELS,
  'gpt-6-luna': LEVELS
});

// Explicit restrictions: Default only, whatever the metadata says. The GPT-5.6
// models offered Default only since 0.8.0 (DEC-PLANCHAT-040, accepted).
const RESTRICTED = Object.freeze({
  'gpt-5.6-sol': 'DEC-PLANCHAT-040',
  'gpt-5.6-terra': 'DEC-PLANCHAT-040',
  'gpt-5.6-luna': 'DEC-PLANCHAT-040'
});

const TIERS = Object.freeze(['unavailable', 'restricted', 'approved', 'advertised', 'fallback']);

class StaleCatalogError extends Error {
  constructor() {
    super('The ChatGPT session changed while the model list was loading. Nothing was used from it.');
    this.name = 'StaleCatalogError';
    this.stale = true;
  }
}

class CapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapabilityError';
  }
}

// Records issued by a catalog: record -> { catalog, revision }. A record is
// valid only while its catalog has not changed since it was issued.
const ISSUED = new WeakMap();

// The validated subset of one /v1/models entry, or undefined when it has no
// usable id or name (0.10.0 skipped those too).
function parseModelEntry(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = String(raw.slug || raw.id || '');
  const name = String(raw.display_name || raw.name || raw.slug || raw.id || '');
  if (!id || !name) return undefined;
  return Object.freeze({
    id,
    name,
    // 0.10.0 rule: no visibility, or "list".
    listed: !raw.visibility || raw.visibility === 'list',
    levels: parseLevels(raw),
    flag: parseFlag(raw)
  });
}

function parseLevels(raw) {
  const value = raw.supported_reasoning_levels;
  if (value === undefined || value === null) return Object.freeze({ state: 'absent', set: Object.freeze([]) });
  if (!Array.isArray(value) || value.length > MAX_LEVEL_ENTRIES) return Object.freeze({ state: 'malformed', set: Object.freeze([]) });
  const found = new Set();
  for (const item of value) {
    let level;
    if (typeof item === 'string') level = item;
    else if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.effort === 'string') level = item.effort;
    else return Object.freeze({ state: 'malformed', set: Object.freeze([]) });
    if (LEVELS.includes(level)) found.add(level);
  }
  return Object.freeze({ state: 'valid', set: Object.freeze(LEVELS.filter((level) => found.has(level))) });
}

function parseFlag(raw) {
  if (!Object.prototype.hasOwnProperty.call(raw, 'supports_reasoning_effort_updates')) return 'absent';
  const value = raw.supports_reasoning_effort_updates;
  if (value === undefined || value === null) return 'absent';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'invalid';
}

// Only what the resolver reads, so nothing else of the server's model list
// (instructions, plans, descriptions) is kept anywhere.
function pickCapabilityFields(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const levels = raw.supported_reasoning_levels;
  return {
    slug: raw.slug,
    id: raw.id,
    display_name: raw.display_name,
    name: raw.name,
    visibility: raw.visibility,
    supported_reasoning_levels: Array.isArray(levels)
      ? levels.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? { effort: item.effort } : item))
      : levels,
    supports_reasoning_effort_updates: raw.supports_reasoning_effort_updates
  };
}

const sameMetadata = (a, b) => a.levels.state === b.levels.state
  && a.levels.set.join(',') === b.levels.set.join(',')
  && a.flag === b.flag;

// One model's entry from all catalog entries with its slug (table A1 to A6).
function combineEntries(list) {
  const first = list[0];
  if (list.some((entry) => entry.listed !== first.listed)) {
    return Object.freeze({ id: first.id, available: false, reason: 'ambiguous-identity' });
  }
  if (!first.listed) return Object.freeze({ id: first.id, available: false, reason: 'hidden' });
  const agree = list.every((entry) => sameMetadata(entry, first));
  return Object.freeze({
    id: first.id,
    name: first.name,
    available: true,
    levels: agree ? first.levels : Object.freeze({ state: 'ambiguous', set: Object.freeze([]) }),
    flag: agree ? first.flag : 'ambiguous'
  });
}

// Thinking for an available entry (table T1 to T11).
function thinkingFor(entry) {
  const slug = entry.id;
  if (Object.prototype.hasOwnProperty.call(RESTRICTED, slug)) {
    return { tier: 'restricted', levels: [], diagnostic: 'restricted' };
  }
  const { levels, flag } = entry;
  const flagNote = flag === 'true' ? undefined : `effort-updates-${flag}`;
  const approved = Object.prototype.hasOwnProperty.call(APPROVED_EFFORTS, slug) ? APPROVED_EFFORTS[slug] : undefined;
  if (approved) {
    if (flag === 'false') return { tier: 'approved', levels: [], diagnostic: 'effort-updates-false' };
    if (levels.state !== 'valid') return { tier: 'approved', levels: approved, diagnostic: `metadata-${levels.state}` };
    if (!levels.set.length) return { tier: 'approved', levels: [], diagnostic: 'no-recognized-levels' };
    const both = approved.filter((level) => levels.set.includes(level));
    if (!both.length) return { tier: 'approved', levels: [], diagnostic: 'empty-intersection' };
    return { tier: 'approved', levels: both, diagnostic: flagNote };
  }
  if (flag !== 'true') return { tier: 'fallback', levels: [], diagnostic: flagNote };
  if (levels.state !== 'valid') return { tier: 'fallback', levels: [], diagnostic: `metadata-${levels.state}` };
  if (!levels.set.length) return { tier: 'fallback', levels: [], diagnostic: 'no-recognized-levels' };
  return { tier: 'advertised', levels: levels.set, diagnostic: undefined };
}

// The session-scoped catalog of one window: the validated entries of one
// account, in memory only. `generation` changes with the session (sign-in,
// sign-out, account change, sign-in needed again); a load that started in an
// older generation never installs its result. `revision` changes whenever the
// entries change; a capability record is valid only for the revision that
// issued it.
class ModelCatalog {
  #generation = 0;
  #revision = 0;
  #accountKey = undefined;
  #entries = new Map();
  #models = Object.freeze([]);
  #inflight = undefined;

  get generation() { return this.#generation; }
  get accountKey() { return this.#accountKey; }
  // The models a user may choose: [{ id, name }], server order, each once.
  get models() { return this.#models; }
  get loading() { return Boolean(this.#inflight && this.#inflight.generation === this.#generation); }

  invalidate() {
    this.#generation += 1;
    this.#revision += 1;
    this.#accountKey = undefined;
    this.#entries = new Map();
    this.#models = Object.freeze([]);
    this.#inflight = undefined;
  }

  // The 0.4.0 session check: drops the catalog only when the account differs
  // from the one cached or being loaded now (same account: kept, so a second
  // hydration joins the first load instead of starting another request).
  noteAccount(accountKey) {
    const key = String(accountKey || '');
    if (key && (key === this.#accountKey || (this.#inflight && this.#inflight.generation === this.#generation && this.#inflight.accountKey === key))) return false;
    if (!key && this.#accountKey === undefined && !this.#inflight) return false;
    this.invalidate();
    return true;
  }

  // The models of this account: the cached list, the load already running for
  // this account and generation, or one new load. `fetchList` returns the raw
  // /v1/models entries (or [{ id, name }] from older callers).
  load(accountKey, fetchList) {
    const key = String(accountKey || '');
    if (!key) return Promise.reject(new CapabilityError('Continue with ChatGPT to load the models.'));
    if (key === this.#accountKey && this.#models.length) return Promise.resolve(this.#models);
    if (this.#inflight && this.#inflight.generation === this.#generation && this.#inflight.accountKey === key) {
      return this.#inflight.promise;
    }
    // Another account cached or being loaded: its late answer must never
    // install, so the generation moves on first.
    if ((this.#accountKey !== undefined && this.#accountKey !== key) || (this.#inflight && this.#inflight.accountKey !== key)) this.invalidate();
    const generation = this.#generation;
    const promise = Promise.resolve().then(fetchList).then((entries) => {
      if (generation !== this.#generation) throw new StaleCatalogError();
      this.#install(key, entries);
      if (!this.#models.length) throw new CapabilityError('No eligible models were returned for this ChatGPT account.');
      return this.#models;
    });
    const inflight = { accountKey: key, generation, promise };
    this.#inflight = inflight;
    const clear = () => { if (this.#inflight === inflight) this.#inflight = undefined; };
    promise.then(clear, clear);
    return promise;
  }

  #install(accountKey, rawEntries) {
    const grouped = new Map();
    for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
      const entry = parseModelEntry(raw);
      if (!entry) continue;
      if (!grouped.has(entry.id)) grouped.set(entry.id, []);
      grouped.get(entry.id).push(entry);
    }
    const entries = new Map();
    const models = [];
    for (const [id, list] of grouped) {
      const combined = combineEntries(list);
      entries.set(id, combined);
      if (combined.available) models.push(Object.freeze({ id, name: combined.name }));
    }
    this.#accountKey = accountKey;
    this.#entries = entries;
    this.#models = Object.freeze(models);
    this.#revision += 1;
  }

  // The capability record of one model in this catalog now.
  resolve(slug) {
    const id = typeof slug === 'string' ? slug : '';
    const entry = id ? this.#entries.get(id) : undefined;
    let record;
    if (!entry || !entry.available) {
      record = { slug: id, available: false, tier: 'unavailable', efforts: Object.freeze([]), diagnostic: entry ? entry.reason : 'not-listed' };
    } else {
      const thinking = thinkingFor(entry);
      record = { slug: id, available: true, tier: thinking.tier, efforts: Object.freeze([DEFAULT, ...thinking.levels]), diagnostic: thinking.diagnostic };
    }
    const frozen = Object.freeze(record);
    ISSUED.set(frozen, { catalog: this, revision: this.#revision });
    return frozen;
  }

  // True while nothing in this catalog changed since the record was issued.
  isCurrent(record) {
    const issued = record && typeof record === 'object' ? ISSUED.get(record) : undefined;
    return Boolean(issued && issued.catalog === this && issued.revision === this.#revision);
  }
}

// The one check before a request is built and again before it is sent: a
// record issued by a catalog, for this exact model, still current, available,
// and allowing this level ('default' for no reasoning field). Throws a
// CapabilityError ("Nothing was sent.") otherwise.
function checkRecord(record, model, effort = DEFAULT) {
  const issued = record && typeof record === 'object' ? ISSUED.get(record) : undefined;
  if (!issued) throw new CapabilityError('Kenlith could not confirm the capabilities of this model. Nothing was sent.');
  if (typeof model !== 'string' || record.slug !== model) throw new CapabilityError('The model capabilities were checked for another model. Nothing was sent.');
  if (!issued.catalog.isCurrent(record)) throw new CapabilityError('The ChatGPT session or model list changed after this message was prepared. Nothing was sent.');
  if (!record.available) throw new CapabilityError(`The model "${model}" is not available for this ChatGPT account. Choose another model. Nothing was sent.`);
  if (!record.efforts.includes(effort)) throw new CapabilityError('This thinking level is not available for this model. Choose Default or another level. Nothing was sent.');
  return true;
}

function isIssuedRecord(record) {
  return Boolean(record && typeof record === 'object' && ISSUED.has(record));
}

module.exports = {
  APPROVED_EFFORTS,
  CapabilityError,
  DEFAULT,
  LEVELS,
  MAX_LEVEL_ENTRIES,
  ModelCatalog,
  RESTRICTED,
  StaleCatalogError,
  TIERS,
  checkRecord,
  isIssuedRecord,
  parseModelEntry,
  pickCapabilityFields
};
