'use strict';

const { APPROVED_EFFORTS, CapabilityError, checkRecord, isIssuedRecord } = require('./capabilities');

// Kenlith 0.8.0: Thinking effort (DEC-PLANCHAT-040). The one place that knows
// which reasoning efforts exist, which model accepts which, and how a chat's
// choice, the user's default setting and the model's own default combine.
// The view, the engine and the request builder ask this module; none of them
// checks a model name itself.
//
// Request shape (OpenAI Responses API, "Reasoning models" guide, read
// 2026-11-12): `reasoning: { effort }`. Supported values are model-dependent;
// when `reasoning` is omitted the model uses its own default. Kenlith omits it
// for Default, so a Default request is the 0.7.0 request.

// The choices offered, in order. `default` is Kenlith's own value: it means
// "send no reasoning field". The others are sent as they are.
const EFFORTS = Object.freeze(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
const API_EFFORTS = Object.freeze(EFFORTS.filter((effort) => effort !== 'default'));

const LABELS = Object.freeze({ default: 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' });
// For a narrow composer.
const SHORT_LABELS = Object.freeze({ ...LABELS, xhigh: 'XHigh' });
const DESCRIPTIONS = Object.freeze({
  default: 'Let the model choose its normal level',
  low: 'Faster for routine work',
  medium: 'Balanced',
  high: 'More reasoning for complex work',
  xhigh: 'Deeper analysis',
  max: 'Maximum supported reasoning'
});

// Approved compatibility rules (DEC-PLANCHAT-040): efforts the official model
// pages document for these exact slugs (developers.openai.com, read
// 2026-11-12). 0.11.0 (DEC-PLANCHAT-048): the table lives in
// src/capabilities.js, which also reads the levels the account's /v1/models
// response lists (validated; 0.8.0 found that list does carry reasoning
// fields, which OpenAI does not document). Which levels a model accepts is
// decided there only; this module gives the choices, labels and precedence.
// `none`, `minimal` and `ultra` are never offered.
const MODEL_EFFORTS = APPROVED_EFFORTS;

// Generic note (no level named); the composer names the level (noteFor).
const FALLBACK_NOTE = 'This model uses its default thinking level.';
const noteFor = (choice) => (Object.hasOwn(LABELS, choice) && choice !== 'default'
  ? `${LABELS[choice]} isn't available for this model. Your next message uses Default.`
  : FALLBACK_NOTE);
const UNAVAILABLE_NOTES = Object.freeze(Object.fromEntries(EFFORTS.filter((effort) => effort !== 'default').map((effort) => [effort, noteFor(effort)])));

function isEffort(value) {
  return typeof value === 'string' && EFFORTS.includes(value);
}

// The choices for a model, Default first. With a capability record (0.11.0):
// the record's levels when it was issued for this model and the model is
// available; otherwise Default only (a Send is then refused elsewhere).
// Without a record: the approved table only, as in 0.10.0 (display and older
// callers; a request is never built from this form, see reasoningField).
function supportedEfforts(model, record) {
  if (record !== undefined) {
    return isIssuedRecord(record) && record.slug === model && record.available ? record.efforts : Object.freeze(['default']);
  }
  const listed = typeof model === 'string' && Object.hasOwn(MODEL_EFFORTS, model) ? MODEL_EFFORTS[model] : [];
  return Object.freeze(['default', ...listed]);
}

function isSupported(model, effort, record) {
  return isEffort(effort) && supportedEfforts(model, record).includes(effort);
}

// Precedence (DEC-PLANCHAT-040):
//   1. the chat's own choice, when it has one (Default included);
//   2. otherwise kenlith.reasoning.defaultEffort (user settings);
//   3. otherwise Default: no reasoning field, the model's own level.
// The choice is then checked against the model: one the model does not
// accept is not sent; the effective effort is Default and `note` says so.
// Values that are not one of EFFORTS (an old or damaged record, a bad
// setting) count as absent.
function resolveEffort({ chatEffort, userDefault, model, record } = {}) {
  let choice = 'default';
  let source = 'model';
  if (isEffort(chatEffort)) {
    choice = chatEffort;
    source = 'chat';
  } else if (isEffort(userDefault) && userDefault !== 'default') {
    choice = userDefault;
    source = 'setting';
  }
  // The chat's saved choice is reported as it is and never changed here; an
  // unavailable one is named in the note before anything is sent.
  const effective = isSupported(model, choice, record) ? choice : 'default';
  return Object.freeze({
    choice,
    source,
    effective,
    note: effective !== choice ? noteFor(choice) : ''
  });
}

// What the view needs: the effective effort, the chat's choice, the options
// for the selected model and, for an instant update on a model change, the
// options of every listed model. Labels and descriptions come from here.
// 0.11.0: `catalog` (src/capabilities.js ModelCatalog) gives each model's
// capability record; without it, the approved table (0.10.0).
function effortView({ chatEffort, userDefault, model, models = [], catalog } = {}) {
  const record = catalog ? catalog.resolve(model) : undefined;
  const resolved = resolveEffort({ chatEffort, userDefault, model, record });
  const byModel = {};
  for (const entry of models) {
    if (entry && typeof entry.id === 'string') byModel[entry.id] = supportedEfforts(entry.id, catalog ? catalog.resolve(entry.id) : undefined);
  }
  return {
    ...resolved,
    options: supportedEfforts(model, record),
    byModel,
    fallbackNote: FALLBACK_NOTE,
    unavailableNotes: UNAVAILABLE_NOTES,
    labels: LABELS,
    shortLabels: SHORT_LABELS,
    descriptions: DESCRIPTIONS
  };
}

// The `reasoning` request field for an effort, or undefined for Default.
// Only the request builder calls this. 0.11.0: an effort is accepted only
// with a capability record issued for this exact model, still current, that
// lists it (src/capabilities.js checkRecord); there is no form without a
// record. Anything else throws: nothing is sent.
function reasoningField(model, effort, record) {
  if (effort === undefined || effort === 'default') return undefined;
  if (!isEffort(effort)) {
    throw new Error('Kenlith did not recognise the selected thinking level. Nothing was sent.');
  }
  if (!isIssuedRecord(record)) {
    throw new CapabilityError('Kenlith could not confirm the capabilities of this model. Nothing was sent.');
  }
  if (record.slug === model && record.available && !record.efforts.includes(effort)) {
    throw new Error(`The thinking level "${LABELS[effort]}" is not available for this model. Choose Default or another level. Nothing was sent.`);
  }
  checkRecord(record, model, effort);
  return Object.freeze({ effort });
}

// A failed request that carried an explicit effort: did OpenAI refuse the
// effort? Returns the explanation to show, or undefined. A 400 or 422 counts
// only when it names the effort (its `param`, or "reasoning.effort" or
// "effort" in its message), not any mention of reasoning. The plan route's
// capability refusal does not say which feature it refused: with project
// tools offered too, the explanation names both. `tools`: the request
// offered project tools.
// 0.11.0: `tier` 'advertised' (the level came from the account's model list,
// not an approved rule) adds one sentence saying so. Never retried, the model
// and level are not changed.
function effortRejection(error, effort, { tools = false, tier } = {}) {
  if (!error || !API_EFFORTS.includes(effort)) return undefined;
  const status = Number(error.status);
  const param = typeof error.param === 'string' ? error.param : '';
  const message = String(error.message || '');
  const label = LABELS[effort];
  const listed = tier === 'advertised' ? ` This level was listed for your ChatGPT account but was not accepted.` : '';
  if (error.code === 'subscription_sharing_unsupported_capability') {
    return tools
      ? `This ChatGPT plan route did not accept a feature of this request: the thinking level "${label}" or the project tools. Kenlith did not retry. Choose Default to send without a level (Kenlith then answers without tools if the tools are the cause).${listed}`
      : `This ChatGPT plan route did not accept the thinking level "${label}" for this model. Kenlith did not retry. Choose Default to use the model's own level.${listed}`;
  }
  const named = /^reasoning(\.effort)?$/i.test(param)
    || ((status === 400 || status === 422) && /reasoning\.effort|\beffort\b/i.test(message));
  if (!named) return undefined;
  return `OpenAI did not accept the thinking level "${label}" for this model. Kenlith did not retry. Choose Default to use the model's own level.${listed}`;
}

module.exports = {
  API_EFFORTS,
  DESCRIPTIONS,
  EFFORTS,
  FALLBACK_NOTE,
  LABELS,
  MODEL_EFFORTS,
  SHORT_LABELS,
  UNAVAILABLE_NOTES,
  effortRejection,
  effortView,
  isEffort,
  isSupported,
  noteFor,
  reasoningField,
  resolveEffort,
  supportedEfforts
};
