'use strict';

// Test folders under the system temp folder are removed when their test is
// done (test/helpers/owned-temp.js, makeSandbox in
// test/integration/lib/editor-driver.js), and nothing else is: not a folder
// this process did not create, not one swapped for another, not another
// sandbox reached through a junction.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { makeOwnedTempDir, removeOwnedTempDir } = require('./helpers/owned-temp');
const { makeSandbox } = require('./integration/lib/editor-driver');

const TAG = `plan-chat-ot-${process.pid}-`;
const ours = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(TAG));
const fill = (dir) => {
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'file.txt'), 'synthetic\n');
};

// Only this file's folders (by its own prefixes): other test files' folders
// are left to their own cleanup, also when tests share one process.
test.after(() => {
  for (const name of fs.readdirSync(os.tmpdir()).filter((item) => item.startsWith(TAG) || item.startsWith(`scopearc-ot-${process.pid}-`))) {
    const dir = path.join(path.resolve(os.tmpdir()), name);
    // Folders a test made by hand, or swapped on purpose, are removed directly.
    if (['not-owned', 'refused'].includes(removeOwnedTempDir(dir))) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OT-01 an owned folder is removed with its contents; a second removal is a no-op', () => {
  const dir = makeOwnedTempDir(TAG);
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  fill(dir);
  assert.equal(removeOwnedTempDir(dir), 'removed');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(removeOwnedTempDir(dir), 'not-owned');
});

test('OT-02 a folder this process did not create is never removed, whatever its name', () => {
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), TAG));
  fill(foreign);
  assert.equal(removeOwnedTempDir(foreign), 'not-owned');
  assert.equal(removeOwnedTempDir(path.join(os.tmpdir())), 'not-owned');
  assert.ok(fs.existsSync(path.join(foreign, 'a', 'b', 'file.txt')));
});

test('OT-03 a folder replaced after creation (same path, new folder or a junction) is refused and left alone', () => {
  const dir = makeOwnedTempDir(TAG);
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir);
  fill(dir);
  assert.equal(removeOwnedTempDir(dir), 'refused');
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'file.txt')));

  const target = fs.mkdtempSync(path.join(os.tmpdir(), TAG));
  fill(target);
  const swapped = makeOwnedTempDir(TAG);
  fs.rmSync(swapped, { recursive: true });
  fs.symlinkSync(target, swapped, 'junction');
  assert.equal(removeOwnedTempDir(swapped), 'refused');
  assert.ok(fs.existsSync(path.join(target, 'a', 'b', 'file.txt')), 'the junction target is untouched');
  fs.unlinkSync(swapped);
});

test('OT-04 independent sandboxes: removing one leaves the other, even when the first holds a junction into the second', () => {
  const first = makeOwnedTempDir(TAG);
  const second = makeOwnedTempDir(TAG);
  fill(first);
  fill(second);
  // Like stage2.js: the profile's storage is a junction to a shared folder.
  fs.symlinkSync(second, path.join(first, 'shared-link'), 'junction');
  fs.symlinkSync(path.join(second, 'a'), path.join(first, 'a', 'deep-link'), 'junction');
  assert.equal(removeOwnedTempDir(first), 'removed');
  assert.equal(fs.existsSync(first), false);
  assert.ok(fs.existsSync(path.join(second, 'a', 'b', 'file.txt')), 'the other sandbox keeps its files');
  assert.equal(removeOwnedTempDir(second), 'removed');
});

test('OT-05 PLAN_CHAT_KEEP_TEMP=1 keeps the folder, deliberately', () => {
  const dir = makeOwnedTempDir(TAG);
  process.env.PLAN_CHAT_KEEP_TEMP = '1';
  try {
    assert.equal(removeOwnedTempDir(dir), 'kept');
  } finally {
    delete process.env.PLAN_CHAT_KEEP_TEMP;
  }
  assert.ok(fs.existsSync(dir));
  fs.rmSync(dir, { recursive: true });
});

test('OT-06 a prefix that could place the folder elsewhere is refused before anything is created; plain names are accepted', () => {
  for (const prefix of ['plan-chat-../x-', '..', 'plan-chat-a\\b-', 'plan-chat-a/b-', 'C:x-', 'a*b-', '', undefined]) {
    assert.throws(() => makeOwnedTempDir(prefix), /Invalid temporary folder prefix/);
  }
  // As used by docs/release-evidence/scopearc-0.4.1/acceptance/continuity.js,
  // and a runner label with a space.
  for (const prefix of [`scopearc-ot-${process.pid}-`, `${TAG}Antigravity IDE-`]) {
    const dir = makeOwnedTempDir(prefix);
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.equal(removeOwnedTempDir(dir), 'removed');
  }
});

// A runner ends in one of these ways; its folders must be gone afterwards.
const ENDINGS = {
  'normal end': '',
  'process.exit(1)': 'process.exit(1);',
  'failed assertion': "require('node:assert').equal(1, 2);",
  'uncaught error': "throw new Error('synthetic failure');",
  'rejected promise': "Promise.reject(new Error('synthetic rejection'));",
  'process.exitCode = 1': 'process.exitCode = 1;'
};

for (const [ending, code] of Object.entries(ENDINGS)) {
  test(`OT-07 a runner's folders are removed at exit: ${ending}`, () => {
    const script = `const { makeOwnedTempDir } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'owned-temp'))});
const dir = makeOwnedTempDir(${JSON.stringify(TAG)});
require('node:fs').writeFileSync(require('node:path').join(dir, 'x.txt'), 'x');
console.log(dir);
${code}`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
    const dir = run.stdout.trim().split(/\r?\n/)[0];
    assert.ok(dir.startsWith(path.join(path.resolve(os.tmpdir()), TAG)), run.stderr);
    assert.equal(fs.existsSync(dir), false, `${dir} left behind after: ${ending}`);
    assert.match(run.stderr, /\[temp\] removed 1 test folder/);
  });
}

test('OT-08 at exit, PLAN_CHAT_KEEP_TEMP=1 keeps the folders and says where', () => {
  const script = `const dir = require(${JSON.stringify(path.join(__dirname, 'helpers', 'owned-temp'))}).makeOwnedTempDir(${JSON.stringify(TAG)}); console.log(dir);`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, PLAN_CHAT_KEEP_TEMP: '1' } });
  const dir = run.stdout.trim();
  assert.ok(fs.existsSync(dir));
  assert.ok(run.stderr.includes(`kept ${dir}`));
  fs.rmSync(dir, { recursive: true });
});

test('OT-09 makeSandbox: close() keeps the folder readable (stage2 reads it after close), remove() deletes it, repeated calls are safe', async () => {
  const box = await makeSandbox(TAG, {});
  assert.ok(fs.existsSync(path.join(box.userData, 'User', 'settings.json')));
  box.close();
  assert.ok(fs.existsSync(path.join(box.sandbox, 'browser-stub.cmd')), 'close() leaves the files for the caller to read');
  assert.equal(box.remove(), 'removed');
  assert.equal(fs.existsSync(box.sandbox), false);
  assert.equal(box.remove(), 'not-owned');
  box.close();
});

test('OT-10 makeSandbox: a failure during set-up removes the half-made folder and closes its server', async () => {
  const servers = () => process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
  const before = ours().length;
  const listening = servers();
  await assert.rejects(makeSandbox(TAG, { bad: 1n }), /BigInt/);
  assert.equal(ours().length, before, 'no folder left by the failed set-up');
  // A closed server releases its handle shortly after; one left open never does.
  for (let wait = 0; wait < 50 && servers() > listening; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(servers() <= listening, 'the sandbox server is closed');
});

test('OT-11 makeSandbox: concurrent sandboxes are separate folders; removing one leaves the others', async () => {
  const boxes = await Promise.all([1, 2, 3].map(() => makeSandbox(TAG, {})));
  assert.equal(new Set(boxes.map((box) => box.sandbox)).size, 3);
  boxes[0].close();
  assert.equal(boxes[0].remove(), 'removed');
  for (const box of boxes.slice(1)) assert.ok(fs.existsSync(path.join(box.userData, 'User', 'settings.json')));
  for (const box of boxes.slice(1)) {
    box.close();
    assert.equal(box.remove(), 'removed');
  }
});
