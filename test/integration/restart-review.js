'use strict';

// Kenlith 0.6.0: proposals pending across a normal editor restart, in a real
// editor (throwaway profile, scripted sign-in, no model request, network
// blocked). Scenario: test/integration/suite/restart-review-ui.js.
//
// Phase 1 makes five proposals and quits normally (no Apply, no Reject).
// While the editor is closed, this runner changes the P2 target on disk and
// stores a copy of P5 under another project's identity. Phase 2 restarts the
// editor on the same profile and project and checks every proposal.
//
// Usage: node test/integration/restart-review.js <editor exe> <label>
//        (PLAN_CHAT_CANDIDATE_VSIX=<vsix> runs a packaged candidate)

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy } = require('./lib/test-copy');

const [executable, label = 'editor'] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Usage: restart-review.js <editor exe> <label>');
  process.exit(2);
}
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
};

async function main() {
  const box = await makeSandbox('kenlith-rr-', { 'files.autoSave': 'off', 'window.restoreWindows': 'one', 'files.hotExit': 'onExit' });
  const project = path.join(box.sandbox, 'projects', 'restart-demo');
  const files = ['apply', 'stale', 'dirty', 'reject', 'control'];
  for (const name of files) {
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', `${name}.js`), `// ${name}\nlet value = 1;\nmodule.exports = { value };\n`);
  }
  const copy = testCopy(box.sandbox, { surface: 'workspace' });
  const read = (name) => { const file = path.join(box.sandbox, `rr-${name}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const start = (phase) => launch(executable, { developmentPaths: [copy], userData: box.userData, sandbox: box.sandbox, openPaths: [project], env: { PLAN_CHAT_IT_SCENARIO: 'restart-review', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_PHASE: phase, PLAN_CHAT_IT_KEEP_OPEN: '1', PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) } });
  console.log(`[${label}] sandbox ${box.sandbox}`);

  // ---------- phase 1 ----------
  let run = start('1');
  await waitFor(() => read('ready-1') || read('error-1'), 120000, 300);
  if (read('error-1')) throw new Error(read('error-1').error);
  const ready = read('ready-1');
  check('phase 1: five proposals wait for review (Awaiting Review), none applied', Object.values(ready.made).every((p) => p.state === 'review'), ready.made);
  const code1 = await Promise.race([run.exited, sleep(45000).then(() => 'timeout')]);
  check('phase 1: the editor quit normally with the proposals pending', code1 !== 'timeout', code1);
  if (code1 === 'timeout') run.child.kill();

  // ---------- while the editor is closed ----------
  const hashOf = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(project, ...rel.split('/')))).digest('hex');
  const unchangedDuringRestart = Object.entries(ready.hashes).every(([rel, sha]) => hashOf(rel) === sha);
  check('no project file changed while the editor quit', unchangedDuringRestart);
  fs.appendFileSync(path.join(project, 'src', 'stale.js'), '// changed by another program while Kenlith was closed\n');
  const storage = path.join(box.userData, 'User', 'globalStorage', 'local-open-source.plan-chat-antigravity', 'proposals.json');
  const stored = JSON.parse(fs.readFileSync(storage, 'utf8'));
  const p5 = stored.proposals.find((p) => p.id === ready.made.p5.id);
  const copyId = 'restart-check-other-project';
  stored.proposals.push({ ...p5, id: copyId, project: { keyId: 'another-project-key:another-installation', label: 'another project' } });
  fs.writeFileSync(storage, JSON.stringify(stored, null, 2));
  fs.writeFileSync(path.join(box.sandbox, 'rr-between.json'), JSON.stringify({ p2Sha256: hashOf('src/stale.js'), copyId }));
  await sleep(1500);

  // ---------- phase 2 ----------
  run = start('2');
  await waitFor(() => read('state-2') || read('error-2'), 150000, 300);
  if (read('error-2')) throw new Error(read('error-2').error);
  const r = read('state-2');
  const unchanged = (rel) => r.hashesAtStart[rel] === ready.hashes[rel];
  check('after the restart: nothing was applied by itself; every proposal is still waiting or out of date, none applied', Object.values(r.restoredStates).every((s) => s === 'review' || s === 'invalidated') && Object.values(r.restoredStates).filter((s) => s === 'review').length >= 4, r.restoredStates);
  check('after the restart: every file except the one changed while closed is unchanged; no document is unsaved', ['src/apply.js', 'src/dirty.js', 'src/reject.js', 'src/control.js'].every(unchanged) && r.dirtyAtStart.length === 0, { hashes: r.hashesAtStart, dirty: r.dirtyAtStart });
  check('after the restart: the chat tab of P1 is back', r.tabs.some((t) => /Restart check p1/.test(t)), r.tabs);
  check('restored cards are rechecked: P1, P3, P4, P5 offer Apply; P2 (changed while closed) does not', r.cards.p1[0]?.actionable && r.cards.p3[0]?.actionable && r.cards.p4[0]?.actionable && r.cards.p5[0]?.actionable && r.cards.p2[0] && !r.cards.p2[0].actionable && /changed after this proposal/.test(r.cards.p2[0].status), r.cards);
  check('P2 stale target: Apply refused, out of date, the file keeps the other program\'s change', !r.p2.applyResult.ok && r.p2.state === 'invalidated' && r.p2.reason === 'changed' && r.p2.fileIsRunnersVersion, r.p2);
  check('P3 dirty target after the restart: out of date at once, Apply refused, the user\'s unsaved edit kept, disk unchanged', r.p3.stateAfterEdit === 'invalidated' && !r.p3.applyResult.ok && r.p3.state === 'invalidated' && r.p3.userEditKept && r.p3.diskUnchanged, r.p3);
  check('P5 copy under another project identity: Apply refused here (other project), nothing written, left for its own project', !r.p5copy.applyResult.ok && r.p5copy.applyResult.code === 'other-project' && r.p5copy.state === 'review' && r.p5copy.fileUnchanged, r.p5copy);
  check('P4 Reject after the restart: rejected, nothing written, Apply afterwards refused', r.p4.state === 'rejected' && !r.p4.applyAfterReject.ok && r.p4.fileUnchanged && !r.p4.document, r.p4);
  check('P1 wrong digest refused; the exact reviewed proposal applies into the editor, unsaved, disk unchanged', !r.p1.wrongDigest.ok && r.p1.stateAfterWrong === 'review' && r.p1.applyResult.ok && r.p1.state === 'applied' && r.p1.editorText === r.p1.expected && r.p1.dirty && r.p1.diskUnchanged, { ...r.p1, editorText: undefined, expected: undefined, same: r.p1.editorText === r.p1.expected });
  check('P5 (control) still waits for review and offers Apply', r.p5.state === 'review' && r.p5.card?.actionable, r.p5);
  const code2 = await Promise.race([run.exited, sleep(45000).then(() => 'timeout')]);
  if (code2 === 'timeout') run.child.kill();
  check('test cleanup: the applied P1 edit was reverted, not saved', hashOf('src/apply.js') === ready.hashes['src/apply.js']);
}

main().catch((error) => { check('run completed', false, String(error?.stack || error)); }).finally(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`[${label}] restart review: ${results.length - failed} passed, ${failed} failed`);
  const evidence = process.env.PLAN_CHAT_EVIDENCE_DIR;
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, `restart-review-${label}.json`), JSON.stringify(results, null, 2)); }
  process.exit(failed ? 1 : 0);
});
