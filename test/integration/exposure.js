'use strict';

// Isolation test: can another extension in the same extension host reach
// Kenlith's internals? Each variant is a separate editor process with a
// throwaway profile, Kenlith, and the probe extension (exposure-probe/):
//
//   development  Kenlith from this source tree, as in a normal F5 run
//   installed    Kenlith as an installed copy (Production mode)
//   test-copy    the throwaway test copy with the test entry point (the only
//                setup in which the view gets synthetic parts)
//
// No network, no real account, no VSIX.
// Usage: node test/integration/exposure.js <editor executable> <label>

const fs = require('node:fs');
const path = require('node:path');
const { launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { installedCopy, testCopy, root, codeRoot } = require('./lib/test-copy');

const [executable, label = 'editor'] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}
const probe = path.join(__dirname, 'exposure-probe');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
};

async function runVariant(variant) {
  const box = await makeSandbox(`plan-chat-exposure-${variant}-`, {});
  const resultFile = path.join(box.sandbox, 'probe.json');
  const env = { PLAN_CHAT_EXPOSURE_RESULT: resultFile };
  let developmentPaths;
  let installed = false;
  if (variant === 'development') {
    developmentPaths = [codeRoot, probe];
  } else if (variant === 'installed') {
    installedCopy(path.join(box.sandbox, 'extensions'));
    developmentPaths = [probe];
    installed = true;
  } else {
    developmentPaths = [testCopy(box.sandbox), probe];
    Object.assign(env, { PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_EXPOSURE_ONLY: '1', PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) });
  }
  const { child, exited } = launch(executable, { developmentPaths, userData: box.userData, sandbox: box.sandbox, env, installed });
  const done = await waitFor(() => fs.existsSync(resultFile), 120000, 250);
  const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  box.close();
  if (!done) {
    check(`${variant}: probe reported`, false, 'no report');
    return;
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  console.log(`[${label}/${variant}] ${report.host} ${report.version}`);
  check(`${variant}: probe ran without errors`, report.errors.length === 0, report.errors);
  check(`${variant}: Kenlith found and active`, report.found && report.active, { found: report.found, active: report.active, main: report.mainEntry });
  check(`${variant}: Kenlith exports nothing to other extensions`, report.exportsType === 'undefined' && report.exportsViaProperty === 'undefined', { exportsType: report.exportsType, keys: report.exportKeys });
  // The editor adds <view id>.focus, .open, .removeView, ... for every view the
  // manifest contributes (0.4.0: planChat.account and planChat.sidebar).
  const viewIds = Object.values(require('./lib/test-copy').manifest.contributes.views).flat().map((view) => view.id);
  const ownCommands = report.planChatCommands.filter((command) => !viewIds.some((id) => command.startsWith(`${id}.`)));
  check(`${variant}: only the manifest's commands exist (no test commands)`, JSON.stringify(ownCommands) === JSON.stringify(report.manifestCommands), ownCommands);
  if (variant === 'test-copy') {
    // Only here does a (synthetic) value exist under Kenlith's credential key.
    check("test-copy: a value stored in Kenlith's SecretStorage is not readable by another extension", report.secretReadable === false);
    check('test-copy: the test entry point ran (synthetic parts wired)', report.testCopyReady && report.mainEntry === './test-main.js', report.mainEntry);
  } else {
    check(`${variant}: normal entry point; no test entry file present`, report.mainEntry === './src/extension.js' && report.testEntryShipped === false, { main: report.mainEntry, testEntry: report.testEntryShipped });
  }
  results.push({ name: `${variant}: shared-host fact: another extension can load Kenlith's source files by path`, ok: true, note: true, detail: report.canLoadPlanChatSource });
  console.log(`  NOTE  ${variant}: another extension can load Kenlith's source files by path: ${report.canLoadPlanChatSource}`);
}

async function main() {
  for (const variant of ['development', 'installed', 'test-copy']) {
    await runVariant(variant);
  }
  const failed = results.filter((r) => !r.ok).length;
  // PLAN_CHAT_EVIDENCE_DIR, when set, receives the result instead of the historical default path (M1 WP-08), so later runs never write into earlier releases' evidence.
  const out = path.join(process.env.PLAN_CHAT_EVIDENCE_DIR || path.join(root, 'design', 'uiux-review', 'preflight'), `exposure-${label}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ label, passed: results.filter((r) => r.ok && !r.note).length, failed, results }, null, 2));
  console.log(`[${label}] exposure: ${results.filter((r) => r.ok && !r.note).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
