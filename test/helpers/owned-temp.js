'use strict';

// Temporary folders owned by this test process. Each one is created under the
// system temp folder and remembered with its identity; `removeOwnedTempDir`
// removes it, and whatever is left is removed when the process exits
// (`process.exit`, a failed assertion and an uncaught error included; Ctrl+C
// and Ctrl+Break are turned into a normal exit so the same cleanup runs,
// except under `node --test`, which handles them itself).
// A folder is removed only if this process created it and it is still that
// folder: same path, a real directory (not a link or junction), same file id.
// A path from anywhere else, or one that merely looks like a test folder, is
// never removed. Links inside a folder are removed as links; their targets
// are not touched.
// PLAN_CHAT_KEEP_TEMP=1 keeps every folder and prints where it is, for
// debugging. A process killed outright (Task Manager, taskkill /F, a closed
// console) cannot clean up; its folders stay behind.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const owned = new Map();
let hooked = false;
const keep = () => process.env.PLAN_CHAT_KEEP_TEMP === '1';
// Synchronous, so the line is not lost when the process is exiting.
const note = (line) => {
  try {
    fs.writeSync(2, `[temp] ${line}\n`);
  } catch {
    // Nowhere to report; nothing else to do.
  }
};

// The prefix only names the folder (ownership is checked by identity, not by
// name), so any plain name is accepted; separators, "..", and characters
// Windows does not allow in a name could place it elsewhere, and are refused.
function makeOwnedTempDir(prefix) {
  if (typeof prefix !== 'string' || !prefix || /[\\/:*?"<>|\x00-\x1f]/.test(prefix) || prefix.includes('..')) {
    throw new Error(`Invalid temporary folder prefix: ${prefix}`);
  }
  const parent = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  const stat = fs.lstatSync(dir, { bigint: true });
  owned.set(dir, { parent, name: path.basename(dir), dev: stat.dev, ino: stat.ino });
  if (!hooked) {
    hooked = true;
    process.on('exit', removeAllOwnedTempDirs);
    // Under `node --test` the test runner handles Ctrl+C itself.
    if (!process.env.NODE_TEST_CONTEXT) {
      for (const signal of ['SIGINT', 'SIGBREAK']) {
        process.once(signal, () => process.exit(130));
      }
    }
  }
  return dir;
}

// 'removed', 'kept' (PLAN_CHAT_KEEP_TEMP=1), 'gone' (already removed),
// 'not-owned' (not created by this process, or already handled), 'refused'
// (no longer the folder that was created; left alone) or 'busy' (could not be
// removed, usually a file still held open; tried again at exit).
function removeOwnedTempDir(dir) {
  const entry = owned.get(dir);
  if (!entry) return 'not-owned';
  if (keep()) {
    owned.delete(dir);
    note(`kept ${dir} (PLAN_CHAT_KEEP_TEMP=1)`);
    return 'kept';
  }
  let stat;
  try {
    stat = fs.lstatSync(dir, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') return busy(dir, error);
    owned.delete(dir);
    return 'gone';
  }
  if (path.dirname(dir) !== entry.parent || path.basename(dir) !== entry.name
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino) {
    owned.delete(dir);
    note(`refused to remove ${dir}: it is no longer the folder this test created`);
    return 'refused';
  }
  try {
    // A few short retries (under a second in all): a file an editor still
    // holds is reported rather than waited for, also at exit.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    return busy(dir, error);
  }
  owned.delete(dir);
  return 'removed';
}

function busy(dir, error) {
  note(`could not remove ${dir} (${error.code || error.message}); it stays until the next attempt or by hand`);
  return 'busy';
}

function removeAllOwnedTempDirs() {
  const results = [...owned.keys()].map((dir) => removeOwnedTempDir(dir));
  const removed = results.filter((result) => result === 'removed').length;
  // Runners print their sandbox path; say that it is gone and how to keep it.
  // Quiet under `node --test`, where every test file would repeat it.
  if (removed && !process.env.NODE_TEST_CONTEXT) {
    note(`removed ${removed} test folder(s) under ${path.resolve(os.tmpdir())}; set PLAN_CHAT_KEEP_TEMP=1 to keep them`);
  }
  return results;
}

module.exports = { makeOwnedTempDir, removeOwnedTempDir };
