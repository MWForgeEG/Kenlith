'use strict';

// Real-editor tests for Phase 3.1 stage 2 (architecture revision 3, E2–E5,
// E8, E9, plus the authorization's scenarios 1–11).
//
// Every step is a separate editor process with its own throwaway profile
// (checked by assertIsolatedProfile). All profiles' Kenlith storage folders
// are directory junctions to ONE shared synthetic history folder, so the steps
// read and write the same history, as windows of one user would. Folders are
// synthetic (alpha, beta, a junction to alpha, a two-folder workspace file).
// Kenlith runs from the throwaway test copy (fake sign-in and model, network
// blocked); step E9 runs the 0.1.2 source as an installed copy instead.
//
// Usage: node test/integration/stage2.js <editor executable> <label>

const fs = require('node:fs');
const path = require('node:path');
const { launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy, root, manifest } = require('./lib/test-copy');
const crypto = require('node:crypto');
const { makeOwnedTempDir } = require('../helpers/owned-temp');

// The validity rule of src/project.js (§3.5), restated so the runner does not load extension code.
function parseKeyRecord(text) {
  try {
    const record = JSON.parse(text);
    const keyId = crypto.createHash('sha256').update(record.key, 'utf8').digest('hex').slice(0, 12);
    return record.version === 1 && /^[0-9a-f]{64}$/.test(record.key) && record.keyId === keyId ? record : undefined;
  } catch {
    return undefined;
  }
}

const [executable, label = 'editor'] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 260)}`}`);
};

const top = makeOwnedTempDir('plan-chat-stage2-');
const shared = path.join(top, 'shared-storage');
const projects = path.join(top, 'projects');
const alpha = path.join(projects, 'alpha');
const beta = path.join(projects, 'beta');
const alphaLink = path.join(projects, 'alpha-link');
const workspaceFile = path.join(projects, 'both.code-workspace');
// M1 removes a folder at runtime, which the editor saves into its workspace file.
const workspaceFileM1 = path.join(projects, 'both-m1.code-workspace');
for (const dir of [shared, alpha, beta]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(alpha, 'notes.txt'), 'synthetic alpha file\n');
fs.writeFileSync(path.join(beta, 'notes.txt'), 'synthetic beta file\n');
fs.symlinkSync(alpha, alphaLink, 'junction');
for (const file of [workspaceFile, workspaceFileM1]) fs.writeFileSync(file, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }] }, null, 2));

// A pre-3.1 chat, kept to compare byte for byte at the end.
const LEGACY = { id: 'legacy-seed', title: 'Legacy question', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', messages: [{ id: 'legacy-m', role: 'user', content: 'Legacy question', createdAt: '2026-10-20T00:00:00.000Z' }] };
fs.writeFileSync(path.join(shared, 'conversations.json'), JSON.stringify({ version: 1, currentId: LEGACY.id, conversations: [LEGACY] }, null, 2));
const history = () => JSON.parse(fs.readFileSync(path.join(shared, 'conversations.json'), 'utf8'));

async function profile(stepLabel) {
  const box = await makeSandbox(`plan-chat-s2-${stepLabel}-`, { 'workbench.colorTheme': 'Default Dark Modern' });
  const storageParent = path.join(box.userData, 'User', 'globalStorage');
  fs.mkdirSync(storageParent, { recursive: true });
  fs.symlinkSync(shared, path.join(storageParent, EXTENSION_ID), 'junction');
  return box;
}

async function runStep(step, openPaths = []) {
  const box = await profile(step.label);
  const copy = testCopy(box.sandbox);
  const { child, exited } = launch(executable, {
    developmentPaths: [copy],
    userData: box.userData,
    sandbox: box.sandbox,
    openPaths,
    env: { PLAN_CHAT_IT_SCENARIO: 'stage2', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_STEP: JSON.stringify(step), PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) }
  });
  const reportFile = path.join(box.sandbox, `stage2-${step.label}.json`);
  await waitFor(() => fs.existsSync(reportFile), 150000, 250);
  const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  box.close();
  if (!fs.existsSync(reportFile)) {
    check(`${step.label}: the step reported`, false, 'no report');
    return undefined;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  // The profile's storage is the junction to the shared synthetic folder.
  const storage = fs.realpathSync.native(report.globalStorage);
  check(`${step.label}: isolated profile; storage is the shared synthetic folder`, storage.toLowerCase() === fs.realpathSync.native(shared).toLowerCase() && report.globalStorage.toLowerCase().startsWith(box.sandbox.toLowerCase()), { storage: report.globalStorage });
  if (report.errors.length) check(`${step.label}: no errors in the editor`, false, report.errors);
  return report;
}

const first = (report) => report?.snapshots[0];
const lastSnap = (report) => report?.snapshots.at(-1);
const titles = (snapshot) => (snapshot?.list || []).map((item) => item.title);

async function main() {
  console.log(`[${label}] sandbox ${top}`);

  // 1–3: A, then B, then A again (separate processes, shared history).
  const a1 = await runStep({ label: 'A1', actions: [{ do: 'create', title: 'A-chat' }] }, [alpha]);
  const keyA = first(a1)?.context.key;
  check('A1: folder window is in project alpha', first(a1)?.context.kind === 'project' && first(a1)?.context.label === 'alpha', first(a1)?.context);
  check('A1: legacy chat is not listed in a project window', !titles(lastSnap(a1)).includes('Legacy question'), titles(lastSnap(a1)));

  const b1 = await runStep({ label: 'B1', actions: [{ do: 'create', title: 'B-chat' }, { do: 'forged', title: 'A-chat' }] }, [beta]);
  check('1. B does not list A\'s chats', !titles(lastSnap(b1)).includes('A-chat') && titles(lastSnap(b1)).includes('B-chat'), titles(lastSnap(b1)));
  check('B1: B does not start on A\'s chat', first(b1)?.current.title !== 'A-chat', first(b1)?.current);
  const forged = b1?.results.find((item) => item.action === 'forged');
  check('B1: forged select and send of A\'s chat are refused', forged?.found && forged.select.startsWith('refused') && forged.add.startsWith('refused'), forged);
  check('B1: A\'s chat is "other-project" from B', lastSnap(b1)?.all.find((item) => item.title === 'A-chat')?.section === 'other-project');

  const a2 = await runStep({ label: 'A2', actions: [] }, [alpha]);
  check('2. A does not list B\'s chats', !titles(first(a2)).includes('B-chat'), titles(first(a2)));
  check('3. A → B → A: A starts on its own chat again, same key', first(a2)?.current.title === 'A-chat' && first(a2)?.context.key === keyA, first(a2)?.current);

  // 4: two windows on the same folder at once.
  const [a3, a4] = await Promise.all([
    runStep({ label: 'A3', actions: [{ do: 'create', title: 'A3', count: 4, pauseMs: 300 }, { do: 'wait', ms: 5000 }] }, [alpha]),
    runStep({ label: 'A4', actions: [{ do: 'create', title: 'A4', count: 4, pauseMs: 300 }, { do: 'wait', ms: 5000 }] }, [alpha])
  ]);
  const sameFolderFile = history().conversations.filter((item) => /^A[34]-\d$/.test(item.title));
  check('4. two windows on one folder: all 8 chats saved, all tagged alpha', sameFolderFile.length === 8 && sameFolderFile.every((item) => item.context?.key === keyA), sameFolderFile.length);
  check('4. each window lists the other\'s chats (same project)', ['A3-0', 'A4-0'].every((title) => titles(lastSnap(a3)).includes(title) && titles(lastSnap(a4)).includes(title)));

  // 5 / E8: two windows on different folders at once.
  const [a5, b5] = await Promise.all([
    runStep({ label: 'A5', actions: [{ do: 'create', title: 'A5', count: 4, pauseMs: 300 }, { do: 'wait', ms: 5000 }] }, [alpha]),
    runStep({ label: 'B5', actions: [{ do: 'create', title: 'B5', count: 4, pauseMs: 300 }, { do: 'wait', ms: 5000 }] }, [beta])
  ]);
  const keyB = first(b5)?.context.key;
  check('5 / E8. different folders at once: no cross-listing', !titles(lastSnap(a5)).some((title) => title.startsWith('B')) && !titles(lastSnap(b5)).some((title) => title.startsWith('A')));
  const pairFile = history().conversations.filter((item) => /^(A5|B5)-\d$/.test(item.title));
  check('5 / E8. each tag kept, nothing lost', pairFile.length === 8 && pairFile.every((item) => item.context?.key === (item.title.startsWith('A') ? keyA : keyB)), pairFile.length);

  // 6 / E2 / E4: multi-root workspace.
  const m1 = await runStep({ label: 'M1', openFile: path.join(beta, 'notes.txt'), actions: [{ do: 'removeFolder', folder: 'beta' }] }, [workspaceFileM1]);
  check('E2. multi-root: default follows the active editor (beta)', first(m1)?.context.label === 'beta' && first(m1)?.context.multiRoot === true, first(m1)?.context);
  check('E4. the chosen folder removed at runtime → General; can choose again', lastSnap(m1)?.context.kind === 'general' && lastSnap(m1)?.context.reason === 'folder-removed' && lastSnap(m1)?.context.canChoose === true, lastSnap(m1)?.context);
  check('E4. after removal, beta\'s chats are not listed', !titles(lastSnap(m1)).some((title) => title.startsWith('B')), titles(lastSnap(m1)));

  const m2 = await runStep({ label: 'M2', actions: [{ do: 'choose', folder: 'alpha' }] }, [workspaceFile]);
  check('6. multi-root without an editor: General until chosen (never the first folder)', first(m2)?.context.kind === 'general' && first(m2)?.context.reason === 'choose', first(m2)?.context);
  check('6. choosing alpha lists alpha\'s chats', lastSnap(m2)?.context.label === 'alpha' && titles(lastSnap(m2)).includes('A-chat') && !titles(lastSnap(m2)).includes('B-chat'));

  // 7 / E3 / 8: empty window.
  const e1 = await runStep({ label: 'E1', actions: [] }, []);
  check('7 / E3. no folder: General, explicit', first(e1)?.context.kind === 'general' && first(e1)?.context.reason === 'no-folder', first(e1)?.context);
  check('8. legacy chat listed under Earlier in General; project chats are not', first(e1)?.list.some((item) => item.title === 'Legacy question' && item.section === 'earlier') && !titles(first(e1)).includes('A-chat'), titles(first(e1)));

  // E5: the same folder through a junction.
  const j1 = await runStep({ label: 'J1', actions: [] }, [alphaLink]);
  check('E5. junction to alpha: same key as alpha; alpha\'s chats listed', first(j1)?.context.key === keyA && titles(first(j1)).includes('A-chat'), first(j1)?.context);

  // E9: 0.1.2 (source baseline, installed copy) reads and writes the 3.1 file.
  const box = await profile('R1');
  const installed = path.join(box.sandbox, 'extensions', `${EXTENSION_ID}-0.1.2`);
  const baseline = path.join(root, 'backups', 'baseline-0.1.2-pre-3.1');
  fs.cpSync(path.join(baseline, 'package.json'), path.join(installed, 'package.json'));
  fs.cpSync(path.join(baseline, 'src'), path.join(installed, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'media'), path.join(installed, 'media'), { recursive: true });
  const before = history();
  const readbackFile = path.join(box.sandbox, 'readback.json');
  const run = launch(executable, {
    developmentPaths: [path.join(__dirname, 'readback-probe')],
    userData: box.userData,
    sandbox: box.sandbox,
    installed: true,
    env: { PLAN_CHAT_READBACK_RESULT: readbackFile, PLAN_CHAT_READBACK_STORAGE: shared, PLAN_CHAT_READBACK_WRITE_TO: 'A-chat' }
  });
  await waitFor(() => fs.existsSync(readbackFile), 150000, 250);
  await Promise.race([run.exited, sleep(30000)]);
  box.close();
  const readback = fs.existsSync(readbackFile) ? JSON.parse(fs.readFileSync(readbackFile, 'utf8')) : undefined;
  check('E9. 0.1.2 activates and lists every chat (it does not filter by project)', readback?.planChatVersion === '0.1.2' && readback.active && before.conversations.every((item) => readback.listed.some((listed) => listed.id === item.id)), readback && { version: readback.planChatVersion, listed: readback.listed.length, expected: before.conversations.length, errors: readback.errors });
  const afterReadback = history();
  const aChat = afterReadback.conversations.find((item) => item.title === 'A-chat');
  check('E9. after 0.1.2 writes, tags and chats are kept', aChat?.context?.key === keyA && aChat.messages.at(-1).content === 'written by 0.1.2' && afterReadback.conversations.length === before.conversations.length, aChat?.context);

  // Whole-file checks.
  const final = history();
  check('8. the legacy chat is byte-for-byte unchanged', JSON.stringify(final.conversations.find((item) => item.id === LEGACY.id)) === JSON.stringify(LEGACY));
  check('history file holds no folder paths', !/projects[\\/]|alpha-link|[A-Za-z]:\\\\/.test(fs.readFileSync(path.join(shared, 'conversations.json'), 'utf8')));
  const primary = parseKeyRecord(fs.readFileSync(path.join(shared, 'project-identity.key'), 'utf8'));
  const backup = parseKeyRecord(fs.readFileSync(path.join(shared, 'project-identity.key.bak'), 'utf8'));
  check('one identity key across all processes; primary and backup agree', primary && backup && primary.keyId === backup.keyId && final.conversations.filter((item) => item.context?.kind === 'project').every((item) => item.context.keyId === primary.keyId), primary?.keyId);
  check('no temporary or lock files left', fs.readdirSync(shared).filter((name) => /\.tmp$|\.lock$/.test(name)).length === 0, fs.readdirSync(shared));

  const failed = results.filter((item) => !item.ok).length;
  // PLAN_CHAT_EVIDENCE_DIR, when set, receives the result instead of the historical default path (M1 WP-08), so later runs never write into earlier releases' evidence.
  const out = path.join(process.env.PLAN_CHAT_EVIDENCE_DIR || path.join(root, 'design', 'uiux-review', 'stage2'), `stage2-${label}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ label, passed: results.length - failed, failed, results }, null, 2));
  console.log(`[${label}] stage 2: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
