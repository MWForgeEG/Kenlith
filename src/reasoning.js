'use strict';

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

// Efforts each model accepts, from the official model pages and the API
// deployment checklist (developers.openai.com, read 2026-11-12). The model
// list Kenlith receives (/v1/models: slug, display_name, visibility) says
// nothing about reasoning, so this table is the only source. A model not in
// it, or a slug that differs in any way (a dated snapshot included), offers
// Default only: no effort is sent that is not documented for that exact slug.
// `none` and `minimal` are not offered (not documented for every model, and
// not part of the 0.8.0 choices).
const MODEL_EFFORTS = Object.freeze({
  'gpt-6.1-sol': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-6-astra': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-6.1-terra': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-6-sol': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-6-luna': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
});

const FALLBACK_NOTE = 'This model uses its default thinking level.';

function isEffort(value) {
  return typeof value === 'string' && EFFORTS.includes(value);
}

// The choices for a model, Default first. Unknown models: Default only.
function supportedEfforts(model) {
  const listed = typeof model === 'string' && Object.hasOwn(MODEL_EFFORTS, model) ? MODEL_EFFORTS[model] : [];
  return Object.freeze(['default', ...listed]);
}

function isSupported(model, effort) {
  return isEffort(effort) && supportedEfforts(model).includes(effort);
}

// Precedence (DEC-PLANCHAT-040):
//   1. the chat's own choice, when it has one (Default included);
//   2. otherwise kenlith.reasoning.defaultEffort (user settings);
//   3. otherwise Default: no reasoning field, the model's own level.
// The choice is then checked against the model: one the model does not
// accept is not sent; the effective effort is Default and `note` says so.
// Values that are not one of EFFORTS (an old or damaged record, a bad
// setting) count as absent.
function resolveEffort({ chatEffort, userDefault, model } = {}) {
  let choice = 'default';
  let source = 'model';
  if (isEffort(chatEffort)) {
    choice = chatEffort;
    source = 'chat';
  } else if (isEffort(userDefault) && userDefault !== 'default') {
    choice = userDefault;
    source = 'setting';
  }
  const effective = isSupported(model, choice) ? choice : 'default';
  return Object.freeze({
    choice,
    source,
    effective,
    note: effective !== choice ? FALLBACK_NOTE : ''
  });
}

// What the view needs: the effective effort, the chat's choice, the options
// for the selected model and, for an instant update on a model change, the
// options of every listed model. Labels and descriptions come from here.
function effortView({ chatEffort, userDefault, model, models = [] } = {}) {
  const resolved = resolveEffort({ chatEffort, userDefault, model });
  const byModel = {};
  for (const entry of models) {
    if (entry && typeof entry.id === 'string') byModel[entry.id] = supportedEfforts(entry.id);
  }
  return {
    ...resolved,
    options: supportedEfforts(model),
    byModel,
    fallbackNote: FALLBACK_NOTE,
    labels: LABELS,
    shortLabels: SHORT_LABELS,
    descriptions: DESCRIPTIONS
  };
}

// The `reasoning` request field for an effort, or undefined for Default.
// Only the request builder calls this. Anything that is not a supported
// effort for this exact model throws: nothing is sent.
function reasoningField(model, effort) {
  if (effort === undefined || effort === 'default') return undefined;
  if (!isEffort(effort)) {
    throw new Error('Kenlith did not recognise the selected thinking level. Nothing was sent.');
  }
  if (!isSupported(model, effort)) {
    throw new Error(`The thinking level "${LABELS[effort]}" is not available for this model. Choose Default or another level. Nothing was sent.`);
  }
  return Object.freeze({ effort });
}

// A failed request that carried an explicit effort: did OpenAI refuse the
// effort? Returns the explanation to show, or undefined. A 400 or 422 counts
// only when it names the effort (its `param`, or "reasoning.effort" or
// "effort" in its message), not any mention of reasoning. The plan route's
// capability refusal does not say which feature it refused: with project
// tools offered too, the explanation names both. `tools`: the request
// offered project tools.
function effortRejection(error, effort, { tools = false } = {}) {
  if (!error || !API_EFFORTS.includes(effort)) return undefined;
  const status = Number(error.status);
  const param = typeof error.param === 'string' ? error.param : '';
  const message = String(error.message || '');
  const label = LABELS[effort];
  if (error.code === 'subscription_sharing_unsupported_capability') {
    return tools
      ? `This ChatGPT plan route did not accept a feature of this request: the thinking level "${label}" or the project tools. Kenlith did not retry. Choose Default to send without a level (Kenlith then answers without tools if the tools are the cause).`
      : `This ChatGPT plan route did not accept the thinking level "${label}" for this model. Kenlith did not retry. Choose Default to use the model's own level.`;
  }
  const named = /^reasoning(\.effort)?$/i.test(param)
    || ((status === 400 || status === 422) && /reasoning\.effort|\beffort\b/i.test(message));
  if (!named) return undefined;
  return `OpenAI did not accept the thinking level "${label}" for this model. Kenlith did not retry. Choose Default to use the model's own level.`;
}

module.exports = {
  API_EFFORTS,
  DESCRIPTIONS,
  EFFORTS,
  FALLBACK_NOTE,
  LABELS,
  MODEL_EFFORTS,
  SHORT_LABELS,
  effortRejection,
  effortView,
  isEffort,
  isSupported,
  reasoningField,
  resolveEffort,
  supportedEfforts
};
