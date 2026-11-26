'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-052), step A of three: prepares the persistent
// SG6 fixture folder WITHOUT elevation. It creates the root, the sentinel, the
// fixtures\ folder, the synthetic plain files and the schema 2 manifest, all
// from the fixed layout in test/helpers/sg6-fixtures.js. It creates no link:
// the four symbolic links are made by step B, create-sg6-links.ps1 (elevated,
// once). Step C is check-symlink-fixtures.js. See docs/kenlith-0.12.0/SG6-FIXTURES.md.
//
//   node test/fixtures-m1/prepare-sg6-fixtures.js            prepare
//   node test/fixtures-m1/prepare-sg6-fixtures.js --dry-run  say what it would do
//   node test/fixtures-m1/prepare-sg6-fixtures.js --retire   repair: rename fixtures\ to
//                                                            retired-<stamp>\ first (nothing is deleted)
//
// Location: %LOCALAPPDATA%\Kenlith\TestFixtures\SG6 (only the signed-in user's
// own LOCALAPPDATA). It refuses if a link or junction is anywhere on that path,
// if fixtures\ already exists (without --retire), or if a sentinel of another
// user is there. Every write uses exclusive creation (never overwrites).

const fs = require('node:fs');
const path = require('node:path');
const sg6 = require('../helpers/sg6-fixtures');

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// Prepares `root` (tests pass their own temporary root). Returns the log lines.
function prepare(root, { retire = false, dryRun = false, now = new Date() } = {}) {
  const log = [];
  root = path.resolve(root);
  const base = path.join(root, sg6.FIXTURES);
  const refuse = (why) => { throw new Error(`refusing: ${why}`); };
  const pathProblems = sg6.pathProblems(root);
  if (pathProblems.length) refuse(pathProblems.join('; '));
  const sentinel = path.join(root, sg6.SENTINEL);
  const sentinelExists = fs.existsSync(sentinel);
  if (sentinelExists) {
    const stat = fs.lstatSync(sentinel);
    if (stat.isSymbolicLink() || !stat.isFile()) refuse(`the sentinel is not a plain file: ${sentinel}`);
    const record = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    if (record.userSid !== sg6.currentSid()) refuse(`the sentinel belongs to another user: ${sentinel}`);
    if (record.purpose !== sg6.PURPOSE || record.schema !== 1) refuse(`unexpected sentinel: ${sentinel}`);
  } else if (fs.existsSync(root) && fs.readdirSync(root).length) {
    refuse(`${root} exists, is not empty and has no sentinel: it is not a Kenlith fixture folder`);
  }
  let exists = false;
  try { fs.lstatSync(base); exists = true; } catch { exists = false; }
  if (exists) {
    if (!retire) refuse(`${base} already exists (use --retire to rename it before preparing a new set)`);
    const retired = path.join(root, `retired-${stamp(now)}`);
    if (fs.existsSync(retired)) refuse(`${retired} already exists`);
    log.push(`retire: rename ${base} -> ${retired}`);
    if (!dryRun) fs.renameSync(base, retired);
  }
  const createdAt = now.toISOString();
  log.push(`root: ${root}`);
  if (!sentinelExists) log.push(`create sentinel ${sentinel}`);
  log.push(`create ${base}`);
  for (const rel of sg6.SPEC.dirs) log.push(`create folder ${sg6.join(base, rel)}`);
  for (const file of sg6.SPEC.files) log.push(`create file ${sg6.join(base, file.rel)} (synthetic)`);
  log.push(`create ${path.join(base, 'manifest.json')} (schema 2, relative paths)`);
  log.push('no link is created here: run step B (create-sg6-links.ps1, elevated) next');
  if (dryRun) return log;
  fs.mkdirSync(root, { recursive: true });
  const again = sg6.pathProblems(root);
  if (again.length) refuse(again.join('; '));
  if (!sentinelExists) {
    fs.writeFileSync(sentinel, `${JSON.stringify({ purpose: sg6.PURPOSE, schema: 1, userSid: sg6.currentSid(), createdAt }, null, 2)}\n`, { flag: 'wx' });
  }
  fs.mkdirSync(base);
  for (const rel of sg6.SPEC.dirs) fs.mkdirSync(sg6.join(base, rel));
  const last = sg6.pathProblems(base);
  if (last.length) refuse(last.join('; '));
  for (const file of sg6.SPEC.files) fs.writeFileSync(sg6.join(base, file.rel), file.text, { flag: 'wx' });
  fs.writeFileSync(path.join(base, 'manifest.json'), `${JSON.stringify(sg6.manifestV2(createdAt), null, 2)}\n`, { flag: 'wx' });
  return log;
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !['--dry-run', '--retire'].includes(arg));
  if (unknown.length) { console.error(`unknown argument: ${unknown.join(' ')}`); process.exit(2); }
  const root = sg6.defaultRoot();
  if (!root) { console.error('refusing: LOCALAPPDATA is not set'); process.exit(1); }
  const expected = path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  if (path.resolve(process.env.LOCALAPPDATA).toLowerCase() !== path.resolve(expected).toLowerCase()) {
    console.error(`refusing: LOCALAPPDATA is ${process.env.LOCALAPPDATA}, expected ${expected}`);
    process.exit(1);
  }
  try {
    for (const line of prepare(root, { retire: args.includes('--retire'), dryRun: args.includes('--dry-run') })) console.log(line);
    console.log(args.includes('--dry-run') ? 'DRY RUN: nothing was written' : 'prepared (step A done)');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { prepare, stamp };
