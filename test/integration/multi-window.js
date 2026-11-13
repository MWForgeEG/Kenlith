'use strict';

// Real-editor multi-process test for the shared history (P0-1).
// Starts two editor processes at once, each with its own throwaway profile.
// Both profiles' globalStorage folders for this extension are directory
// junctions to one shared synthetic folder, so the two extension hosts write
// the same conversations.json concurrently. Nothing touches real profiles.
//
// Usage: node test/integration/multi-window.js <editor A exe> <editor B exe>

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');

const [executableA, executableB] = process.argv.slice(2);
for (const executable of [executableA, executableB]) {
  if (!executable || !fs.existsSync(executable)) {
    console.error('Pass two editor executables (Code.exe and/or Antigravity IDE.exe).');
    process.exit(2);
  }
}

const EXTENSION_ID = 'local-open-source.plan-chat-antigravity';
const root = path.resolve(__dirname, '..', '..');
// Kenlith's code: the project, or the release candidate (WP-06, lib/candidate.js).
const { codeRoot } = require('./lib/test-copy');
const sandbox = makeOwnedTempDir('plan-chat-multi-');
const shared = path.join(sandbox, 'shared-storage');
fs.mkdirSync(shared);
fs.writeFileSync(path.join(shared, 'conversations.json'), JSON.stringify({
  version: 1,
  currentId: 'shared-chat',
  conversations: [{
    id: 'shared-chat',
    title: 'Shared',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    messages: [{ id: 'seed', role: 'user', content: 'seed', createdAt: '2026-10-23T00:00:00.000Z' }]
  }]
}));

const startAt = Date.now() + 25_000;
function launch(executable, label) {
  const userData = path.join(sandbox, `user-data-${label}`);
  const storageParent = path.join(userData, 'User', 'globalStorage');
  fs.mkdirSync(storageParent, { recursive: true });
  fs.symlinkSync(shared, path.join(storageParent, EXTENSION_ID), 'junction');
  const resultFile = path.join(sandbox, `result-${label}.json`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    PLAN_CHAT_IT_PHASE: 'concurrent',
    PLAN_CHAT_IT_LABEL: label,
    PLAN_CHAT_IT_SHARED: shared,
    PLAN_CHAT_IT_START_AT: String(startAt),
    PLAN_CHAT_IT_RESULT: resultFile,
    PLAN_CHAT_IT_USER_DATA: userData
  });
  const child = spawn(executable, [
    `--extensionDevelopmentPath=${codeRoot}`,
    `--extensionTestsPath=${path.join(__dirname, 'suite', 'index.js')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(sandbox, `extensions-${label}`)}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window'
  ], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), 240_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ label, code, report: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : undefined });
    });
  });
}

(async () => {
  const results = await Promise.all([launch(executableA, 'A'), launch(executableB, 'B')]);
  let failed = false;
  for (const { label, code, report } of results) {
    if (!report) {
      console.log(`[${label}] NOT VERIFIED: no report (exit ${code})`);
      failed = true;
      continue;
    }
    console.log(`[${label}] ${report.host} ${report.version} pid ${report.pid}: ${report.saved.length} saved, ${report.errors.length} errors`);
    report.errors.forEach((error) => console.log(`    error: ${error}`));
    failed ||= report.errors.length > 0;
  }

  const history = JSON.parse(fs.readFileSync(path.join(shared, 'conversations.json'), 'utf8'));
  const sharedChat = history.conversations.find((conversation) => conversation.id === 'shared-chat');
  const onDisk = sharedChat.messages.map((message) => message.content);
  const pids = new Set(results.map((result) => result.report?.pid));
  for (const { label, report } of results) {
    if (!report) continue;
    const expected = report.saved.filter((item) => !item.endsWith(':newChat'));
    const own = onDisk.filter((content) => content.startsWith(`${label}-`));
    const ok = JSON.stringify(own) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${own.length}/${expected.length} saved messages on disk, in order, Arabic/emoji intact`);
    failed ||= !ok;
  }
  const interleaved = onDisk.slice(1).some((content, index, all) => index > 0 && content[0] !== all[index - 1][0]);
  console.log(`  ${interleaved ? 'PASS' : 'WARN'}  writes from both processes interleaved (true concurrency): ${interleaved}`);
  console.log(`  ${pids.size === 2 ? 'PASS' : 'FAIL'}  two distinct extension-host processes`);
  failed ||= pids.size !== 2;
  const leftovers = fs.readdirSync(shared).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'));
  console.log(`  ${leftovers.length ? 'FAIL' : 'PASS'}  no temporary or lock files left: ${leftovers.join(', ') || 'none'}`);
  failed ||= leftovers.length > 0;
  console.log(`  INFO  chats in shared history: ${history.conversations.length}`);
  console.log(`Sandbox: ${sandbox}`);
  process.exit(failed ? 1 : 0);
})();
