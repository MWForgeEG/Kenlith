'use strict';

// Sign in with ChatGPT (SIWC) user-experience rules, from OpenAI's SIWC
// "UI and UX guidelines" and "Errors and recovery" pages (read 2026-10-30).

// The scope that lets a session's requests use the user's ChatGPT plan.
// Sign-in refuses a session without it (src/auth.js), so a signed-in
// session normally has it; the label is still shown only when it is there.
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

// "Manage usage" opens ChatGPT's own usage settings.
const USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage';

// Set once the first-sign-in welcome has been dismissed, or when a session
// already existed before this version first ran (that user has signed in
// before, so the welcome is not shown to them).
const WELCOME_KEY = 'planChat.siwcWelcome.v1';

const WELCOME_TITLE = 'You’re using your ChatGPT plan';
const WELCOME_DETAIL = 'Messages you send from Kenlith use your ChatGPT plan and count toward its usage limits. '
  + 'Kenlith itself is free and makes no charges of its own. '
  + 'You can check your usage in ChatGPT settings with Manage usage, under the model list.';
const WELCOME_ACTION = 'Got it';

function usesPlan(session) {
  return Boolean(session && Array.isArray(session.scopes) && session.scopes.includes(PLAN_SCOPE));
}

// After the usage-limit error, new requests that use the ChatGPT plan are
// paused (SIWC "Errors and recovery"): Send gives the text back unsent until
// the user chooses Resume or signs in again. Shared by this profile's windows
// through editor global state (best effort: another window sees it when the
// state reaches it).
const USAGE_PAUSE_KEY = 'planChat.usagePause.v1';

class UsagePausedError extends Error {
  constructor() {
    super('Sending is paused because your ChatGPT plan usage limit was reached. Check Manage usage, then choose Resume to send again. Nothing was sent.');
    this.name = 'UsagePausedError';
    this.code = 'plan-usage-paused';
  }
}

// Only the structured code counts. A plain 429, or a message that merely
// mentions a limit, is a different failure and keeps its own handling.
function isUsageLimitError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'subscription_sharing_usage_limit_exceeded');
}

module.exports = {
  PLAN_SCOPE,
  USAGE_PAUSE_KEY,
  USAGE_SETTINGS_URL,
  UsagePausedError,
  WELCOME_ACTION,
  WELCOME_DETAIL,
  WELCOME_KEY,
  WELCOME_TITLE,
  isUsageLimitError,
  usesPlan
};
