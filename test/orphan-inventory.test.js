'use strict';

// test/integration/orphan-inventory.js knows every temporary folder that the
// test and evidence code creates, and stays read-only.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CREATORS, KEEP, TEST_FOLDER } = require('./integration/orphan-inventory');

const root = path.join(__dirname, '..');
const inventory = path.join(__dirname, 'integration', 'orphan-inventory.js');
// The prefixes passed to makeOwnedTempDir, makeSandbox and fs.mkdtempSync in
// tracked JavaScript (literal prefixes only).
function createdPrefixes() {
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const prefixes = new Set();
  for (const file of files) {
    if (/^backups\//.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/(?:makeOwnedTempDir|makeSandbox)\(\s*['`]([a-z][a-z0-9.-]*-)['`]|mkdtempSync\(path\.join\(os\.tmpdir\(\),\s*['`]([a-z][a-z0-9.-]*-)['`]/g)) {
      prefixes.add(match[1] || match[2]);
    }
  }
  return [...prefixes].sort();
}

test('the Kenlith 0.4.1 test and acceptance folders are recognised', () => {
  for (const name of ['kenlith-continuity-Ab12Cd', 'kenlith-clean-Ab12Cd', 'kenlith-pack-Ab12Cd']) {
    assert.ok(TEST_FOLDER.test(name), name);
    assert.ok(CREATORS.some(([, pattern]) => pattern.test(name)), name);
  }
});

test('every literal temporary-folder prefix in the test and evidence code has a known creator', () => {
  const prefixes = createdPrefixes();
  assert.ok(prefixes.length >= 10, `prefixes found: ${prefixes.join(', ')}`);
  const unknown = prefixes.filter((prefix) => !(TEST_FOLDER.test(`${prefix}Ab12Cd`) && CREATORS.some(([, pattern]) => pattern.test(`${prefix}Ab12Cd`))));
  assert.deepEqual(unknown, []);
});

test('names that are not test folders are left out, and the reusable fixture is kept', () => {
  for (const name of ['kenlith', 'Kenlith-pack-Ab12Cd', 'plan', 'scopearc', 'my-kenlith-pack-Ab12Cd']) {
    assert.ok(!TEST_FOLDER.test(name) || !CREATORS.some(([, pattern]) => pattern.test(name)), name);
  }
  assert.ok(KEEP.has('plan-chat-sg-m1-1-symlinks'));
});

test('the inventory deletes and writes nothing', () => {
  const source = fs.readFileSync(inventory, 'utf8');
  assert.doesNotMatch(source, /\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink|writeFileSync|writeFile|renameSync|rename|cpSync|copyFileSync|mkdirSync)\s*\(/);
});
