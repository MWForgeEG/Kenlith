'use strict';

// Kenlith 0.4.1: the four settings move from planChat.* (Plan Chat 0.4.0) to
// kenlith.* (src/settings.js, docs/kenlith-rebrand.md). Reading is user layer
// only: kenlith.<key> → planChat.<key> → default. The copy never writes or
// removes a Plan Chat value, so a rollback to Plan Chat 0.4.0 keeps working.

const assert = require('node:assert/strict');
const test = require('node:test');
const { config, createContext, vscode } = require('./helpers/fake-vscode');
const manifest = require('../package.json');
const {
  MIGRATION_KEY, affectsSetting, migrateLegacySettings,
  userInstructions, userMaxHistoryMessages, userMaxSelectionCharacters, userProjectContextEnabled
} = require('../src/settings');

const KEYS = ['instructions', 'maxHistoryMessages', 'context.maxSelectionCharacters', 'projectContext.enabled'];
const USER = { instructions: 'USER instructions', maxHistoryMessages: 12, 'context.maxSelectionCharacters': 5000, 'projectContext.enabled': false };
const DEFAULTS = Object.fromEntries(KEYS.map((key) => [key, manifest.contributes.configuration.properties[`kenlith.${key}`].default]));
const global = () => config.layers.global;
const state = () => createContext().globalState;
const read = () => ({
  instructions: userInstructions(),
  maxHistoryMessages: userMaxHistoryMessages(),
  'context.maxSelectionCharacters': userMaxSelectionCharacters(),
  'projectContext.enabled': userProjectContextEnabled()
});

test.beforeEach(() => {
  config.reset();
  delete global()['planChat.instructions']; // the fake's usual test value
});

test('manifest: each kenlith.* setting has the planChat.* schema and user-only scope; each planChat.* setting is deprecated and points to it', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(manifest.contributes.configuration.title, 'Kenlith');
  // Kenlith 0.5.0 adds kenlith.projectContext.tools, which has no Plan Chat
  // counterpart (nothing to migrate); it is user-only like the others.
  // Kenlith 0.6.0 adds kenlith.projectContext.proposals, the same way.
  // Kenlith 0.8.0 adds kenlith.reasoning.defaultEffort, the same way.
  const NEW = ['projectContext.tools', 'projectContext.proposals', 'projectContext.commands', 'reasoning.defaultEffort'];
  assert.deepEqual(Object.keys(properties).sort(), [...KEYS.map((key) => `kenlith.${key}`), ...KEYS.map((key) => `planChat.${key}`), ...NEW.map((key) => `kenlith.${key}`)].sort());
  for (const key of NEW) {
    assert.equal(properties[`kenlith.${key}`].scope, 'application', key);
    assert.equal(properties[`planChat.${key}`], undefined, key);
    assert.doesNotMatch(properties[`kenlith.${key}`].description, /Plan Chat/, key);
  }
  for (const key of KEYS) {
    const current = properties[`kenlith.${key}`];
    const legacy = properties[`planChat.${key}`];
    for (const field of ['type', 'default', 'minimum', 'maximum', 'scope']) assert.deepEqual(current[field], legacy[field], `${key} ${field}`);
    assert.equal(current.scope, 'application', key);
    assert.equal(current.deprecationMessage, undefined, key);
    assert.doesNotMatch(current.description, /Plan Chat/, key);
    assert.equal(legacy.deprecationMessage, `Replaced by kenlith.${key}. Kept only for a return to Plan Chat 0.4.0.`, key);
    assert.equal(legacy.markdownDeprecationMessage, `Replaced by \`#kenlith.${key}#\`. Kept only for a return to Plan Chat 0.4.0.`, key);
  }
});

test('no value set: nothing is written, the defaults apply, and the run is recorded', async () => {
  const globalState = state();
  await migrateLegacySettings(globalState);
  assert.deepEqual(config.writes, []);
  assert.deepEqual(read(), { ...DEFAULTS, 'projectContext.enabled': true });
  assert.deepEqual(globalState.get(MIGRATION_KEY), Object.fromEntries(KEYS.map((key) => [key, null])));
});

test('old value only (all four settings): copied to kenlith.* in user settings; the planChat.* values stay', async () => {
  for (const key of KEYS) global()[`planChat.${key}`] = USER[key];
  await migrateLegacySettings(state());
  assert.deepEqual(config.writes.map(({ name, value, target }) => [name, value, target]),
    KEYS.map((key) => [`kenlith.${key}`, USER[key], vscode.ConfigurationTarget.Global]));
  for (const key of KEYS) {
    assert.deepEqual(global()[`kenlith.${key}`], USER[key], key);
    assert.deepEqual(global()[`planChat.${key}`], USER[key], `${key}: the Plan Chat value is kept for a rollback`);
  }
  assert.deepEqual(read(), USER);
});

test('old value only, before any copy: reading already falls back to it', () => {
  for (const key of KEYS) global()[`planChat.${key}`] = USER[key];
  assert.deepEqual(read(), USER);
});

test('new value only: nothing is written and the Kenlith value is used', async () => {
  for (const key of KEYS) global()[`kenlith.${key}`] = USER[key];
  await migrateLegacySettings(state());
  assert.deepEqual(config.writes, []);
  assert.deepEqual(read(), USER);
});

test('both values on the first run: the Kenlith value wins and is not overwritten', async () => {
  const kenlith = { instructions: 'KENLITH', maxHistoryMessages: 50, 'context.maxSelectionCharacters': 900, 'projectContext.enabled': true };
  for (const key of KEYS) {
    global()[`planChat.${key}`] = USER[key];
    global()[`kenlith.${key}`] = kenlith[key];
  }
  await migrateLegacySettings(state());
  assert.deepEqual(config.writes, []);
  assert.deepEqual(read(), kenlith);
});

test('restart: a second run with nothing changed writes nothing', async () => {
  for (const key of KEYS) global()[`planChat.${key}`] = USER[key];
  const globalState = state();
  await migrateLegacySettings(globalState);
  const first = config.writes.length;
  await migrateLegacySettings(globalState);
  await migrateLegacySettings(globalState);
  assert.equal(config.writes.length, first);
});

test('a Kenlith value the user changed after the copy is kept on every later run', async () => {
  global()['planChat.instructions'] = 'OLD';
  const globalState = state();
  await migrateLegacySettings(globalState);
  global()['kenlith.instructions'] = 'CHANGED IN KENLITH';
  await migrateLegacySettings(globalState);
  assert.equal(userInstructions(), 'CHANGED IN KENLITH');
  delete global()['kenlith.instructions']; // reset to default in Kenlith: not refilled from the unchanged old value
  await migrateLegacySettings(globalState);
  assert.equal(global()['kenlith.instructions'], undefined);
});

test('rollback and upgrade again: a value changed under Plan Chat 0.4.0 is copied as the latest choice', async () => {
  global()['planChat.maxHistoryMessages'] = 12;
  const globalState = state();
  await migrateLegacySettings(globalState); // upgrade: 12 copied
  global()['kenlith.maxHistoryMessages'] = 40; // changed in Kenlith
  // Rollback: Plan Chat 0.4.0 reads planChat.* only, which still holds 12.
  assert.equal(global()['planChat.maxHistoryMessages'], 12);
  global()['planChat.maxHistoryMessages'] = 20; // changed under Plan Chat 0.4.0
  await migrateLegacySettings(globalState); // upgrade again
  assert.equal(global()['kenlith.maxHistoryMessages'], 20);
  assert.equal(userMaxHistoryMessages(), 20);
});

test('an old value removed later is not followed by removing the Kenlith value', async () => {
  global()['planChat.instructions'] = 'OLD';
  const globalState = state();
  await migrateLegacySettings(globalState);
  delete global()['planChat.instructions'];
  const before = config.writes.length;
  await migrateLegacySettings(globalState);
  assert.equal(config.writes.length, before);
  assert.equal(userInstructions(), 'OLD');
});

test('malformed old values are not copied; reading falls back to them exactly as Plan Chat 0.4.0 did (project context fails closed)', async () => {
  global()['planChat.instructions'] = 42;
  global()['planChat.maxHistoryMessages'] = 'many';
  global()['planChat.context.maxSelectionCharacters'] = -5;
  global()['planChat.projectContext.enabled'] = 'true';
  await migrateLegacySettings(state());
  // Only the number of the right type (−5) is copied; reading treats it as Plan Chat 0.4.0 did.
  assert.deepEqual(config.writes.map((write) => write.name), ['kenlith.context.maxSelectionCharacters']);
  assert.deepEqual(read(), { instructions: DEFAULTS.instructions, maxHistoryMessages: 30, 'context.maxSelectionCharacters': 12000, 'projectContext.enabled': false });
});

test('out-of-range values are copied as set and clamped when read, as before', async () => {
  global()['planChat.maxHistoryMessages'] = 1000;
  global()['planChat.context.maxSelectionCharacters'] = 50000;
  await migrateLegacySettings(state());
  assert.equal(userMaxHistoryMessages(), 100);
  assert.equal(userMaxSelectionCharacters(), 20000);
});

test('a malformed Kenlith value wins over a valid old one, and project context fails closed', () => {
  global()['planChat.projectContext.enabled'] = true;
  global()['kenlith.projectContext.enabled'] = 'yes';
  assert.equal(userProjectContextEnabled(), false);
});

test('workspace, folder and language values of either name are never copied or read, even on a host that exposes them', async () => {
  config.enforceScopes = false;
  for (const layer of ['workspace', 'workspaceFolder', 'workspaceLanguage', 'globalLanguage']) {
    for (const key of KEYS) {
      config.layers[layer][`planChat.${key}`] = key === 'projectContext.enabled' ? true : `${layer.toUpperCase()}`;
      config.layers[layer][`kenlith.${key}`] = key === 'projectContext.enabled' ? true : `${layer.toUpperCase()}`;
    }
  }
  global()['planChat.projectContext.enabled'] = false;
  await migrateLegacySettings(state());
  assert.deepEqual(config.writes.map((write) => [write.name, write.value]), [['kenlith.projectContext.enabled', false]]);
  assert.equal(userInstructions(), DEFAULTS.instructions);
  assert.equal(userMaxHistoryMessages(), 30);
  assert.equal(userProjectContextEnabled(), false);
});

test('a failed write is not recorded: reading falls back meanwhile, and the next run copies', async () => {
  global()['planChat.instructions'] = 'OLD';
  const globalState = state();
  config.failWrites = true;
  await migrateLegacySettings(globalState);
  assert.equal(global()['kenlith.instructions'], undefined);
  assert.equal(userInstructions(), 'OLD');
  assert.equal(Object.hasOwn(globalState.get(MIGRATION_KEY), 'instructions'), false);
  config.failWrites = false;
  await migrateLegacySettings(globalState);
  assert.equal(global()['kenlith.instructions'], 'OLD');
});

test('a missing globalState (no record) still copies only into unset Kenlith keys', async () => {
  global()['planChat.instructions'] = 'OLD';
  await migrateLegacySettings(undefined);
  assert.equal(global()['kenlith.instructions'], 'OLD');
  global()['kenlith.instructions'] = 'NEW';
  await migrateLegacySettings(undefined);
  assert.equal(global()['kenlith.instructions'], 'NEW');
});

test('change events: the project-context switch reacts to either name, and to nothing else', () => {
  const event = (name) => ({ affectsConfiguration: (section) => section === name });
  assert.equal(affectsSetting(event('kenlith.projectContext.enabled'), 'projectContext.enabled'), true);
  assert.equal(affectsSetting(event('planChat.projectContext.enabled'), 'projectContext.enabled'), true);
  assert.equal(affectsSetting(event('kenlith.instructions'), 'projectContext.enabled'), false);
  assert.equal(affectsSetting(undefined, 'projectContext.enabled'), false);
});

test('upgrade (real activation): Plan Chat 0.4.0 values are in kenlith.* once the extension is active; a later Plan Chat edit is followed', async () => {
  for (const key of KEYS) global()[`planChat.${key}`] = USER[key];
  const extension = require('../src/extension');
  const context = createContext();
  const registerCommand = vscode.commands.registerCommand;
  vscode.commands.registerCommand = () => ({ dispose() {} });
  try {
    await extension.activate(context);
  } finally {
    vscode.commands.registerCommand = registerCommand;
  }
  for (const key of KEYS) assert.deepEqual(global()[`kenlith.${key}`], USER[key], key);
  assert.deepEqual(read(), USER);
  // Edited under the old name while Kenlith runs (another profile on Plan Chat 0.4.0).
  global()['planChat.projectContext.enabled'] = true;
  config.changed(['planChat.projectContext.enabled']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(global()['kenlith.projectContext.enabled'], true);
  assert.equal(userProjectContextEnabled(), true);
  for (const subscription of context.subscriptions) subscription.dispose?.();
});
