'use strict';

// Integrity check of the genuine symbolic-link fixtures used by
// test/sg-m1-1-symlinks.test.js (SG6-F0 to F4), for the start of a security
// gate. Not elevated; reads only. Kenlith 0.7.0; 0.12.0 (DEC-PLANCHAT-052):
// the persistent folder %LOCALAPPDATA%\Kenlith\TestFixtures\SG6 and the full
// verification of test/helpers/sg6-fixtures.js (canonical path, sentinel,
// derived paths, link type, target, reparse tag, content, owners).
//
//   node test/fixtures-m1/check-symlink-fixtures.js [--require-persistent]
// Prints which set is used and why (the persistent folder, the
// PLAN_CHAT_SYMLINK_FIXTURES override, or the reported fallback to the earlier
// TEMP set while the persistent links do not exist yet).
// Exit 0: the set in use is complete and genuine.
// Exit 1: what is wrong, and how to repair it.
// Exit 2 (--require-persistent, used by the 0.12.0 release gate): the set is
// fine but it is not the persistent one.

const { loadSg6Fixtures } = require('../helpers/sg6-fixtures');

const requirePersistent = process.argv.includes('--require-persistent');
const result = loadSg6Fixtures();
console.log(result.report);
if (result.fallback) console.log(`  persistent folder ${result.persistentBase}: not usable yet; using the earlier TEMP set`);
if (result.state !== 'ok') {
  console.log('SYMLINK FIXTURES NOT USABLE');
  for (const problem of result.problems || []) console.log(`  ${problem}`);
  console.log('Repair (docs/kenlith-0.12.0/SG6-FIXTURES.md): step A `node test/fixtures-m1/prepare-sg6-fixtures.js` (add --retire if fixtures\\ exists), then step B `create-sg6-links.ps1` in an elevated PowerShell, then this check again.');
  process.exit(1);
}
if (requirePersistent && result.mode !== 'persistent') {
  console.log(`NOT THE PERSISTENT SET: ${result.mode} set in use (${result.source})`);
  process.exit(2);
}
console.log(`symlink fixtures OK: ${result.fixtures.links.length} genuine symbolic links in ${result.base} (${result.mode}; created elevated: ${result.fixtures.createdElevated})`);
