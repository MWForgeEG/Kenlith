'use strict';

// Launches an isolated editor instance (throwaway profile and extensions folder)
// with this source tree as the development extension. The installed copy of the
// extension and the user's real profile are never touched.
//
// Usage: node test/integration/run.js <path-to-Code.exe-or-Antigravity IDE.exe>

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');

const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path (Code.exe or Antigravity IDE.exe).');
  process.exit(2);
}

const root = path.resolve(__dirname, '..', '..');
// Kenlith's code: the project, or the release candidate (WP-06, lib/candidate.js).
const { codeRoot } = require('./lib/test-copy');
const sandbox = makeOwnedTempDir('plan-chat-it-');
const userData = path.join(sandbox, 'user-data');
const extensions = path.join(sandbox, 'extensions');
const stateFile = path.join(sandbox, 'state.txt');

let failed = false;
for (const phase of ['first', 'second']) {
  const resultFile = path.join(sandbox, `result-${phase}.json`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    PLAN_CHAT_IT_PHASE: phase,
    PLAN_CHAT_IT_RESULT: resultFile,
    PLAN_CHAT_IT_STATE: stateFile,
    PLAN_CHAT_IT_USER_DATA: userData
  });

  const run = spawnSync(executable, [
    `--extensionDevelopmentPath=${codeRoot}`,
    `--extensionTestsPath=${path.join(__dirname, 'suite', 'index.js')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window'
  ], { env, encoding: 'utf8', timeout: 180_000 });

  if (!fs.existsSync(resultFile)) {
    failed = true;
    console.log(`[${phase}] NOT VERIFIED: the suite did not report (exit ${run.status}, ${run.error?.message || 'no error'}).`);
    console.log((run.stdout || '').slice(-2000), (run.stderr || '').slice(-2000));
    break;
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  console.log(`[${phase}] ${report.host} ${report.version} (exit ${run.status})`);
  for (const result of report.results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n${result.error}`}`);
    failed ||= !result.ok;
  }
  failed ||= run.status !== 0;
}

console.log(`Sandbox profile: ${sandbox}`);
process.exit(failed ? 1 : 0);
