'use strict';

// User-level settings that shape model requests. A workspace (for example a
// cloned repository's .vscode/settings.json) must not be able to replace the
// instructions the user chose, so these are read from the user layer only:
// inspect().globalValue, falling back to the declared default. Workspace,
// folder and language-specific layers are never used. package.json also
// declares these settings with "application" scope; VS Code 1.143 and
// Antigravity 1.107 then hide workspace values from the API altogether, so the
// rule below is a second line of defence for hosts that do not.
//
// Kenlith 0.4.1 (docs/kenlith-rebrand.md): the settings are `kenlith.*`.
// Plan Chat 0.4.0 used `planChat.*`; those keys are still declared (marked
// deprecated) and still read, so nothing a user set is lost and a return to
// Plan Chat 0.4.0 finds its values. Per key, the user layer only:
//   kenlith.<key> → planChat.<key> → the declared default.

const vscode = require('vscode');
const { isEffort } = require('./reasoning');

const SECTION = 'kenlith';
const LEGACY_SECTION = 'planChat';
// The four settings and the type a value must have to be copied.
const KEYS = {
  instructions: 'string',
  maxHistoryMessages: 'number',
  'context.maxSelectionCharacters': 'number',
  'projectContext.enabled': 'boolean'
};
// globalState: per key, the Plan Chat value last seen (JSON, or null when
// unset). Lets the copy run once, and again only when that value changes.
const MIGRATION_KEY = 'kenlith.settingsMigration.v1';
const HISTORY_MIN = 4;
const HISTORY_MAX = 100;
const HISTORY_DEFAULT = 30;
// Selected code (stage 3, §4.5): the schema maximum is enforced here too.
const SELECTION_DEFAULT = 12_000;
const SELECTION_MAX = 20_000;

function inspect(key, section = SECTION) {
  return vscode.workspace.getConfiguration(section).inspect(key) || {};
}

function userLayer(key) {
  const current = inspect(key);
  if (current.globalValue !== undefined) return current.globalValue;
  const legacy = inspect(key, LEGACY_SECTION);
  if (legacy.globalValue !== undefined) return legacy.globalValue;
  return current.defaultValue !== undefined ? current.defaultValue : legacy.defaultValue;
}

// Copies each Plan Chat value the user set to its Kenlith key: on the first
// run, unless the Kenlith key is already set (the Kenlith value wins); later,
// whenever the Plan Chat value has changed since it was last seen (edited
// under Plan Chat 0.4.0 after a rollback, or in another profile), as the most
// recent choice. Never writes or removes a Plan Chat value. A value of the
// wrong type is not copied; reading then falls back to it exactly as Plan Chat
// 0.4.0 would (fail closed for project context). A failed write is not
// recorded, so it is tried again; until then reading falls back.
async function migrateLegacySettings(globalState) {
  const seen = { ...(globalState?.get?.(MIGRATION_KEY) || {}) };
  let changed = false;
  for (const [key, type] of Object.entries(KEYS)) {
    const legacy = inspect(key, LEGACY_SECTION).globalValue;
    const mark = legacy === undefined ? null : JSON.stringify(legacy);
    if (Object.hasOwn(seen, key) && seen[key] === mark) continue;
    const keepCurrent = !Object.hasOwn(seen, key) && inspect(key).globalValue !== undefined;
    if (legacy !== undefined && typeof legacy === type && !keepCurrent) {
      try {
        await vscode.workspace.getConfiguration(SECTION).update(key, legacy, vscode.ConfigurationTarget.Global);
      } catch {
        continue;
      }
    }
    seen[key] = mark;
    changed = true;
  }
  if (changed) await globalState?.update?.(MIGRATION_KEY, seen);
}

// A configuration event that touches a setting, under either name.
function affectsSetting(event, key) {
  return Boolean(event?.affectsConfiguration?.(`${SECTION}.${key}`) || event?.affectsConfiguration?.(`${LEGACY_SECTION}.${key}`));
}

function userInstructions() {
  const value = userLayer('instructions');
  if (typeof value === 'string') {
    return value;
  }
  const fallback = inspect('instructions').defaultValue;
  return typeof fallback === 'string' ? fallback : '';
}

function userMaxHistoryMessages() {
  const value = Number(userLayer('maxHistoryMessages'));
  if (!Number.isFinite(value)) {
    return HISTORY_DEFAULT;
  }
  return Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, Math.floor(value)));
}

function userMaxSelectionCharacters() {
  const value = Number(userLayer('context.maxSelectionCharacters'));
  if (!Number.isFinite(value) || value < 1) {
    return SELECTION_DEFAULT;
  }
  return Math.min(SELECTION_MAX, Math.floor(value));
}

// Project context (M1). A workspace can never turn it on or off: user
// layer only, like the instructions.
// A value that is not a boolean counts as off (fail closed).
function userProjectContextEnabled() {
  return userLayer('projectContext.enabled') === true;
}

// 0.5.0: whether the model may ask for project evidence with the read-only
// tools (DEC-PLANCHAT-023, DEC-PLANCHAT-024). User layer only; a new key with no Plan Chat
// value, so nothing is migrated. A value that is not a boolean counts as off.
function userProjectToolsEnabled() {
  return userProjectContextEnabled() && userLayer('projectContext.tools') === true;
}

// 0.6.0: whether ChatGPT may propose file edits for review (DEC-PLANCHAT-026).
// Only with the tools on; user layer only; not a boolean counts as off.
function userProposalsEnabled() {
  return userProjectToolsEnabled() && userLayer('projectContext.proposals') === true;
}

// 0.7.0: whether ChatGPT may ask Kenlith to run commands and tasks
// (DEC-PLANCHAT-030). Only with the tools on; user layer only; not a boolean
// counts as off. Safe local checks still run without a prompt only when the
// host classifies them as Class A.
function userCommandsEnabled() {
  return userProjectToolsEnabled() && userLayer('projectContext.commands') === true;
}

// 0.8.0: the thinking effort for chats that have not chosen one
// (DEC-PLANCHAT-040). User layer only, like the instructions; a new key with
// no Plan Chat value, so nothing is migrated. A value that is not one of the
// choices counts as Default (src/reasoning.js).
function userReasoningDefaultEffort() {
  const value = userLayer('reasoning.defaultEffort');
  return isEffort(value) ? value : 'default';
}

module.exports = {
  HISTORY_MAX,
  HISTORY_MIN,
  LEGACY_SECTION,
  MIGRATION_KEY,
  SECTION,
  SELECTION_MAX,
  affectsSetting,
  migrateLegacySettings,
  userInstructions,
  userMaxHistoryMessages,
  userMaxSelectionCharacters,
  userProjectContextEnabled,
  userCommandsEnabled,
  userReasoningDefaultEffort,
  userProjectToolsEnabled,
  userProposalsEnabled
};
