'use strict';

// Kenlith 0.6.0: runs test/integration/suite/review-apply-host.js in a real
// editor (throwaway profile and extensions folder, a synthetic folder, no
// network use). The user's profile and installed Kenlith are not touched.
//
// Usage: node test/integration/review-apply.js <Code.exe | Antigravity IDE.exe>

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');

const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}
const repo = path.resolve(__dirname, '..', '..');
const sandbox = makeOwnedTempDir('kenlith-ra-');
const folder = path.join(sandbox, 'project');
fs.mkdirSync(folder, { recursive: true });
const resultFile = path.join(sandbox, 'result.json');
const env = { ...process.env, KENLITH_SRC: path.join(repo, 'src'), KENLITH_FOLDER: folder, KENLITH_RESULT: resultFile };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(path.join(sandbox, 'user-data', 'User'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'files.autoSave': 'off', 'window.dialogStyle': 'custom', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none' }));

const run = spawnSync(executable, [
  folder,
  `--extensionDevelopmentPath=${repo}`,
  `--extensionTestsPath=${path.join(__dirname, 'suite', 'review-apply-host.js')}`,
  `--user-data-dir=${path.join(sandbox, 'user-data')}`,
  `--extensions-dir=${path.join(sandbox, 'extensions')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--new-window'
], { env, encoding: 'utf8', timeout: 180_000 });

if (!fs.existsSync(resultFile)) {
  console.log(`NOT VERIFIED: the suite did not report (exit ${run.status}, ${run.error?.message || 'no error'}).`);
  console.log((run.stdout || '').slice(-2000), (run.stderr || '').slice(-2000));
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
console.log(`${report.host} ${report.version} (exit ${run.status})`);
let failed = run.status !== 0;
for (const result of report.results) {
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n${result.error}`}`);
  failed ||= !result.ok;
}
console.log(`Sandbox: ${sandbox}`);
process.exit(failed ? 1 : 0);
