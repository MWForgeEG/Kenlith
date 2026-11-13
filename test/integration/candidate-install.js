'use strict';

// WP-06 (T06-05, T06-06): the release candidate installed for real, by the
// editor's own command line, into throwaway profiles only. Clean install,
// activation, restart, Restricted Mode; then authentic 0.1.2 with a synthetic
// history (more than 30 chats) upgraded in place to the candidate, a backup
// and restore, and rollback to 0.1.2 and 0.1.0 with their documented limits.
//
// Every profile, extensions folder and storage folder is under the system
// temporary folder and checked before anything is installed or started. The
// owner's editors, profiles and installed 0.1.2 are not used. A test probe
// blocks the network in the extension host; Kenlith is never signed in.
//
// Usage: node test/integration/candidate-install.js <editor executable> <label> <candidate.vsix>

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertIsolatedProfile, launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { readZip } = require('./lib/candidate');

const [executable, label = 'editor', candidateArg] = process.argv.slice(2);
const root = path.resolve(__dirname, '..', '..');
const candidate = candidateArg && path.resolve(candidateArg);
if (!executable || !fs.existsSync(executable) || !candidate || !fs.existsSync(candidate)) {
  console.error('Usage: candidate-install.js <editor executable> <label> <candidate.vsix>');
  process.exit(2);
}
const ID = 'local-open-source.plan-chat-antigravity';
const NEW = JSON.parse(readZip(candidate).find((entry) => entry.name === 'extension/package.json').bytes.toString('utf8')).version;
const OLD = process.env.PLAN_CHAT_UPGRADE_FROM || '0.1.2';
// Released packages are named plan-chat-antigravity-<version>.vsix up to 0.4.0
// and kenlith-antigravity-<version>.vsix from 0.4.1 (DEC-PLANCHAT-020).
const RELEASE = (version) => ['kenlith-antigravity', 'plan-chat-antigravity']
  .map((base) => path.join(root, 'releases', `${base}-${version}.vsix`))
  .find((file) => fs.existsSync(file)) || path.join(root, 'releases', `plan-chat-antigravity-${version}.vsix`);
if (!/^\d+\.\d+\.\d+$/.test(OLD) || !fs.existsSync(RELEASE(OLD))) throw new Error(`no released package for ${OLD}`);
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 300)}`}`);
};
console.log(`[${label}] candidate ${path.basename(candidate)} sha256 ${sha(fs.readFileSync(candidate))}`);

// The editor's own command line (bin\*.cmd → <editor>.exe + cli.js), run
// without a shell.
function cli() {
  const bin = path.join(path.dirname(executable), 'bin');
  const cmd = fs.readdirSync(bin).find((name) => name.endsWith('.cmd') && !/tunnel/i.test(name));
  const text = fs.readFileSync(path.join(bin, cmd), 'utf8');
  const relative = /"%~dp0\.\.\\([^"]*cli\.js)"/.exec(text)[1];
  return path.join(path.dirname(executable), relative);
}
const CLI = cli();
function install(box, vsix) {
  assertIsolatedProfile(box.userData);
  const extensions = path.join(box.sandbox, 'extensions');
  if (!path.resolve(extensions).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())) throw new Error('extensions folder is not under the temporary folder');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' };
  const run = spawnSync(executable, [CLI, '--user-data-dir', box.userData, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { env, encoding: 'utf8', timeout: 180_000 });
  return { code: run.status, out: `${run.stdout || ''}${run.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ') };
}
const installedFolders = (box) => fs.readdirSync(path.join(box.sandbox, 'extensions')).filter((name) => name.toLowerCase().startsWith(ID));
const registry = (box) => {
  const file = path.join(box.sandbox, 'extensions', 'extensions.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).filter((item) => item.identifier?.id?.toLowerCase() === ID).map((item) => item.version) : [];
};
const storageOf = (box) => path.join(box.userData, 'User', 'globalStorage', ID);

// One editor start with the probe; returns its report.
async function probe(box, step, { openPaths = [], workspaceTrust = false } = {}) {
  const resultFile = path.join(box.sandbox, `probe-${step.name}.json`);
  const { child, exited } = launch(executable, {
    developmentPaths: [path.join(__dirname, 'candidate-probe')],
    userData: box.userData,
    sandbox: box.sandbox,
    installed: true,
    openPaths,
    workspaceTrust,
    env: { PLAN_CHAT_PROBE_RESULT: resultFile, PLAN_CHAT_PROBE_STEP: JSON.stringify(step), PLAN_CHAT_PROBE_STORAGE: storageOf(box) }
  });
  await waitFor(() => fs.existsSync(resultFile), 150000, 250);
  const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { errors: ['no report'] };
  if (report.errors?.length) check(`${step.name}: no errors in the editor`, false, report.errors);
  check(`${step.name}: no network request from the extension host`, (report.networkAttempts || []).length === 0, report.networkAttempts);
  return report;
}

// Synthetic history in the 0.1.2 format: 35 untagged chats, Arabic and English.
function seedHistory(box) {
  const conversations = Array.from({ length: 35 }, (_, index) => ({
    id: `seed-${String(index).padStart(2, '0')}`,
    title: index === 0 ? 'Seed chat zero' : `Seed chat ${index} — محادثة ${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    messages: [
      { id: `seed-${index}-u`, role: 'user', content: `Synthetic question ${index}: كيف أحفظ المحادثة؟`, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: `seed-${index}-a`, role: 'assistant', content: `Synthetic **answer** ${index} with \`code\`.`, createdAt: '2026-10-01T00:00:01.000Z' }
    ]
  }));
  fs.mkdirSync(storageOf(box), { recursive: true });
  fs.writeFileSync(path.join(storageOf(box), 'conversations.json'), JSON.stringify({ version: 1, currentId: 'seed-34', conversations }, null, 2));
}
const historyOf = (box) => JSON.parse(fs.readFileSync(path.join(storageOf(box), 'conversations.json'), 'utf8'));
const folderHashes = (dir) => Object.fromEntries(fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile()).sort().map((name) => [name, sha(fs.readFileSync(path.join(dir, name)))]));

async function main() {
  const settings = {
    'planChat.instructions': 'SYNTHETIC user instructions kept across upgrade.',
    'planChat.maxHistoryMessages': 12,
    // Defence in depth: any extension-host request goes to a closed local port.
    'http.proxy': 'http://127.0.0.1:9',
    'http.proxySupport': 'override'
  };

  // ---------- A. clean install, activation, restart ----------
  const clean = await makeSandbox(`plan-chat-rc-${label}-clean-`, settings);
  check('A. isolated profile and extensions folder under the temporary folder (checked before install)', assertIsolatedProfile(clean.userData) === true, clean.sandbox);
  const a1 = install(clean, candidate);
  check('A. the editor\'s command line installs the candidate VSIX', a1.code === 0, a1.out);
  const folder = installedFolders(clean);
  check(`A. one installed folder, version ${NEW}, in the throwaway extensions folder`, folder.length === 1 && folder[0].endsWith(`-${NEW}`) && registry(clean).includes(`${NEW}`), { folder, registry: registry(clean) });
  const files = readZip(candidate).filter((entry) => entry.name.startsWith('extension/'));
  const mismatched = files.filter((entry) => {
    const installedFile = path.join(clean.sandbox, 'extensions', folder[0], ...entry.name.slice('extension/'.length).split('/'));
    if (!fs.existsSync(installedFile)) return true;
    if (entry.name === 'extension/package.json') {
      // The editor adds only its own __metadata field (install time, size) on install.
      const { __metadata, ...installedPkg } = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
      return !__metadata || JSON.stringify(installedPkg) !== JSON.stringify(JSON.parse(entry.bytes));
    }
    return sha(fs.readFileSync(installedFile)) !== sha(entry.bytes);
  }).map((entry) => entry.name);
  check('A. installed files are byte-identical to the VSIX contents (package.json: identical except the editor-added __metadata field)', mismatched.length === 0, mismatched);
  const start = await probe(clean, { name: 'A-start' });
  check(`A. the installed candidate (not a development copy) is found, version ${NEW}, from the throwaway extensions folder`, start.found && start.version === `${NEW}` && start.extensionPath.toLowerCase().startsWith(clean.sandbox.toLowerCase()), { version: start.version, path: start.extensionPath });
  check('A. it activates when its view opens', !start.activeBefore && start.activeAfter, { before: start.activeBefore, after: start.activeAfter, opened: start.opened });
  check('A. it exports nothing to other extensions', start.exports === 'undefined', start.exports);
  // The editor itself adds <viewId>.focus, .open, .toggle and similar for every view.
  // The editor adds <view id>.focus, .open, ... for every contributed view
  // (0.4.0: planChat.account and planChat.sidebar).
  const isViewCommand = (command) => /^planChat\.(sidebar|account)\./.test(command);
  const editorViewCommands = start.commands.filter(isViewCommand);
  const others = start.commands.filter((command) => !isViewCommand(command));
  check('A. every contributed command is registered; the only others are view commands the editor adds itself', JSON.stringify(others) === JSON.stringify(start.contributedCommands), { contributed: start.contributedCommands.length, editorViewCommands });
  check('A. the editor right-click menu offers Attach Selection only with a selection', start.editorMenu.some((item) => /planChat\.attachSelection when editorHasSelection/.test(item)), start.editorMenu);
  check('A. user settings are read', start.userInstructions === settings['planChat.instructions'] && start.userHistoryLimit === 12);
  const restart = await probe(clean, { name: 'A-restart' });
  check('A. restart: still installed, activates again', restart.found && restart.version === `${NEW}` && restart.activeAfter);
  clean.close();

  // ---------- B. Restricted Mode ----------
  const restricted = await makeSandbox(`plan-chat-rc-${label}-restricted-`, { ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.untrustedFiles': 'open' });
  const b1 = install(restricted, candidate);
  const untrusted = path.join(restricted.sandbox, 'untrusted-project');
  fs.mkdirSync(untrusted);
  fs.writeFileSync(path.join(untrusted, 'notes.txt'), 'synthetic\n');
  const blocked = await probe(restricted, { name: 'B-restricted' }, { openPaths: [untrusted], workspaceTrust: true });
  // The precondition is that the candidate is installed (the editor's own
  // registry says so); the command's exit code and output are recorded too.
  check('B. precondition: the candidate is installed in this profile', registry(restricted).includes(`${NEW}`), { registry: registry(restricted), exit: b1.code, out: b1.out });
  check('B. Restricted Mode: the window is untrusted and the installed candidate does not load', blocked.trusted === false && (!blocked.found || !blocked.activeAfter), { trusted: blocked.trusted, found: blocked.found, active: blocked.activeAfter, opened: blocked.opened });
  restricted.close();

  // ---------- C. upgrade from authentic 0.1.2, with history ----------
  const box = await makeSandbox(`plan-chat-rc-${label}-upgrade-`, settings);
  const project = path.join(box.sandbox, 'synthetic-project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'app.js'), 'const synthetic = 1;\n');
  const c1 = install(box, RELEASE(`${OLD}`));
  // Install success is judged by the editor's own registry; the command's exit
  // code and output are recorded (Antigravity's command line exited non-zero or
  // crashed after installing in two WP-06 runs).
  check(`C. authentic ${OLD} installed in the throwaway profile`, registry(box).includes(`${OLD}`), { exit: c1.code, out: c1.out, registry: registry(box) });
  seedHistory(box);
  const old = await probe(box, { name: `C-${OLD}`, writeTo: 'Seed chat zero', text: `written by ${OLD} before the upgrade` });
  check(`C. ${OLD} runs on the synthetic history (35 chats) and writes to it`, old.version === `${OLD}` && old.fileChats === 35 && old.wroteTo === 'seed-00', { version: old.version, chats: old.fileChats });
  const beforeUpgrade = historyOf(box);
  const c2 = install(box, candidate);
  check(`C. upgrade in place: the editor's command line installs ${NEW} over ${OLD}`, registry(box).includes(`${NEW}`) && !registry(box).includes(`${OLD}`), { exit: c2.code, out: c2.out, registry: registry(box), folders: installedFolders(box) });
  const upgraded = await probe(box, { name: `C-${NEW}`, projectCheck: true, createProjectChat: 'project question with attached code', createProjectDerived: OLD !== '0.1.2' }, { openPaths: [project] });
  check(`C. after the upgrade the candidate runs: version ${NEW}, active`, upgraded.version === `${NEW}` && upgraded.activeAfter, { version: upgraded.version });
  const afterUpgrade = historyOf(box);
  const kept = beforeUpgrade.conversations.every((chat) => JSON.stringify(afterUpgrade.conversations.find((item) => item.id === chat.id)) === JSON.stringify(chat));
  check(`C. every ${OLD} chat is kept unchanged (35, including the message ${OLD} wrote)`, kept && afterUpgrade.conversations.length === 36, { before: beforeUpgrade.conversations.length, after: afterUpgrade.conversations.length });
  check('C. user settings kept across the upgrade', upgraded.userInstructions === settings['planChat.instructions'] && upgraded.userHistoryLimit === 12);
  if (upgraded.declaresKenlith) {
    check('C. Kenlith: the user settings were copied to kenlith.*; the planChat.* values are kept', upgraded.kenlithInstructions === settings['planChat.instructions'] && upgraded.kenlithHistoryLimit === 12 && upgraded.userInstructions === settings['planChat.instructions'], { kenlith: [upgraded.kenlithInstructions, upgraded.kenlithHistoryLimit], planChat: [upgraded.userInstructions, upgraded.userHistoryLimit] });
  }
  check(`C. project behaviour: the folder window is a project; no ${OLD} chat is listed there (they are earlier, read-only)`, upgraded.context?.kind === 'project' && !upgraded.projectListed.some((title) => /^Seed chat/.test(title)) && upgraded.sections.some(([section, count]) => section === 'earlier' && count === 35), { context: upgraded.context, listed: upgraded.projectListed, sections: upgraded.sections });
  check(`C. in General the ${OLD} chats are listed (35) plus none of the project's`, upgraded.generalListed === 35, upgraded.generalListed);
  check('C. a new project chat gets the new identity scheme (scheme 2) and its reply is excluded', upgraded.createdTag?.scheme === 2 && afterUpgrade.conversations.find((item) => item.id === upgraded.createdProjectChat)?.messages.at(-1).contextPolicy === 'excluded', upgraded.createdTag);

  // ---------- D. backup, rollback to 0.1.2, restore ----------
  const backup = path.join(box.sandbox, 'backup-before-rollback');
  fs.cpSync(storageOf(box), backup, { recursive: true });
  const backupHashes = folderHashes(backup);
  check('D. backup of the whole storage folder (history and identity key files)', ['conversations.json', 'project-identity.key', 'project-identity.key.bak'].every((name) => name in backupHashes), Object.keys(backupHashes));
  const d1 = install(box, RELEASE(`${OLD}`));
  check(`D. rollback: authentic ${OLD} installed over ${NEW} by the command line`, registry(box).includes(`${OLD}`) && !registry(box).includes(`${NEW}`), { exit: d1.code, out: d1.out, registry: registry(box) });
  const rolled = await probe(box, { name: `D-${OLD}`, contextOf: 'project question with attached code' }, { openPaths: [project] });
  check(`D. after the rollback ${OLD} still finds its own settings (planChat.*)`, rolled.userInstructions === settings['planChat.instructions'] && rolled.userHistoryLimit === 12, { planChat: [rolled.userInstructions, rolled.userHistoryLimit] });
  check(`D. ${OLD} opens the history: every chat kept (the 35 from ${OLD} and the project chat)`, rolled.version === `${OLD}` && rolled.fileChats === afterUpgrade.conversations.length, { version: rolled.version, chats: rolled.fileChats });
  if (OLD === '0.1.2') {
    check('D. documented limit: 0.1.2 lists every chat, project chats included (no separation)', rolled.listedAll === afterUpgrade.conversations.length, rolled.listedAll);
    check(`D. documented limit: 0.1.2 would send the reply that ${NEW} excluded`, Array.isArray(rolled.contextOf) && rolled.contextOf.some((content) => content.startsWith('EXCLUDED-REPLY')), rolled.contextOf);
  } else {
    check(`D. ${OLD} does not send the reply to attached code, or the reply ${NEW} made with project excerpts (the downgrade guard)`, Array.isArray(rolled.contextOf) && !rolled.contextOf.some((content) => content.startsWith('EXCLUDED-REPLY') || content.startsWith('PROJECT-DERIVED-REPLY')) && rolled.contextOf.includes('project-context question'), rolled.contextOf);
    const rolledFile = historyOf(box).conversations.find((item) => item.title === 'project question with attached code');
    check(`D. ${OLD} keeps the ${NEW} provenance fields in the file`, Boolean(rolledFile?.messages.some((message) => message.provenance === 'project-derived' && message.contextPolicy === 'excluded') && rolledFile?.messages.some((message) => message.provenance === 'user' && Array.isArray(message.contextUsed) && message.contextUsed.length === 1)), rolledFile?.messages.map((message) => message.provenance || '-'));
  }
  // Restore: back to the candidate, then the backup copied back.
  const d2 = install(box, candidate);
  fs.rmSync(storageOf(box), { recursive: true, force: true });
  fs.cpSync(backup, storageOf(box), { recursive: true });
  check('D. restore: the whole folder copied back is byte-identical to the backup', JSON.stringify(folderHashes(storageOf(box))) === JSON.stringify(backupHashes) && registry(box).includes(`${NEW}`), { exit: d2.code });
  const restored = await probe(box, { name: 'D-restored', projectCheck: true }, { openPaths: [project] });
  check('D. after restore the candidate shows the project chat in its project again (tag and key files restored)', restored.version === `${NEW}` && restored.projectListed.includes('project question with attached code'), { listed: restored.projectListed });
  box.close();

  // ---------- E. 0.1.0 with more than 30 chats ----------
  const legacy = await makeSandbox(`plan-chat-rc-${label}-legacy-`, settings);
  const e1 = install(legacy, RELEASE('0.1.0'));
  seedHistory(legacy);
  const e2 = await probe(legacy, { name: 'E-0.1.0', writeTo: 'Seed chat zero', text: 'written by 0.1.0' });
  const afterLegacy = historyOf(legacy).conversations.length;
  check('E. documented limit: 0.1.0 keeps only 30 of 35 chats when it saves (backup needed before such a downgrade)', registry(legacy).includes('0.1.0') && e2.version === '0.1.0' && afterLegacy === 30, { exit: e1.code, version: e2.version, after: afterLegacy });
  legacy.close();

  const failed = results.filter((item) => !item.ok).length;
  // PLAN_CHAT_EVIDENCE_DIR, when set, receives the result instead of the historical default path (M1 WP-08), so later runs never write into earlier releases' evidence.
  const out = path.join(process.env.PLAN_CHAT_EVIDENCE_DIR || path.join(root, 'docs', 'release-evidence', 'WP-06', 'installed'), `candidate-install-${label}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ label, candidate: path.basename(candidate), passed: results.length - failed, failed, results }, null, 2));
  console.log(`[${label}] candidate install, upgrade and rollback: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
