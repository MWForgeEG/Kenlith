'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-052): the SG6 fixture helper refuses what it
// must refuse. Runs WITHOUT elevation: every link-like object here is a
// directory junction (no privilege needed) inside a temporary folder owned by
// this process (test/helpers/owned-temp.js), removed afterwards. Genuine
// symbolic links are exercised by test/sg-m1-1-symlinks.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sg6 = require('./helpers/sg6-fixtures');
const { prepare } = require('./fixtures-m1/prepare-sg6-fixtures');
const { makeOwnedTempDir, removeOwnedTempDir } = require('./helpers/owned-temp');

const made = [];
const tempRoot = () => { const dir = makeOwnedTempDir('kenlith-sg6h-'); made.push(dir); return dir; };
test.after(() => { for (const dir of made) removeOwnedTempDir(dir); });
const fixturesOf = (root) => path.join(root, sg6.FIXTURES);
const noEnv = { LOCALAPPDATA: undefined };

test('SG6-H1 prepare writes the layout with relative paths only, and the set reads as prepared (no link yet)', () => {
  const root = path.join(tempRoot(), 'SG6');
  prepare(root);
  const sentinel = JSON.parse(fs.readFileSync(path.join(root, sg6.SENTINEL), 'utf8'));
  assert.equal(sentinel.userSid, sg6.currentSid());
  const manifestText = fs.readFileSync(path.join(fixturesOf(root), 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifestText, /[A-Za-z]:\\|\\\\/, 'no absolute or Windows path in the manifest');
  const result = sg6.verifySet(fixturesOf(root), 'persistent');
  assert.equal(result.state, 'prepared', result.problems.join('; '));
  assert.throws(() => prepare(root), /already exists/, 'never prepares over an existing set');
});

test('SG6-H2 a junction on the path is refused by prepare and by verification', () => {
  const temp = tempRoot();
  const real = path.join(temp, 'real');
  fs.mkdirSync(real);
  const alias = path.join(temp, 'alias');
  fs.symlinkSync(real, alias, 'junction');
  assert.throws(() => prepare(path.join(alias, 'SG6')), /link or junction|not canonical/);
  assert.deepEqual(fs.readdirSync(real), [], 'nothing was written through the junction');
  prepare(path.join(real, 'SG6'));
  const through = sg6.verifySet(path.join(alias, 'SG6', sg6.FIXTURES), 'persistent');
  assert.equal(through.state, 'broken');
  assert.ok(through.problems.some((p) => /link or junction|not canonical/.test(p)), through.problems.join('; '));
});

test('SG6-H3 a sentinel of another user is refused by verification and by a repair', () => {
  const root = path.join(tempRoot(), 'SG6');
  prepare(root);
  const file = path.join(root, sg6.SENTINEL);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, userSid: 'S-1-5-21-1-2-3-1001' }));
  const result = sg6.verifySet(fixturesOf(root), 'persistent');
  assert.ok(result.problems.some((p) => /another user/.test(p)), result.problems.join('; '));
  assert.throws(() => prepare(root, { retire: true }), /another user/);
  assert.ok(fs.existsSync(fixturesOf(root)), 'the refused repair renamed nothing');
});

test('SG6-H4 a manifest that differs from the fixed layout, or changed content, is refused; manifest paths are never used', () => {
  const root = path.join(tempRoot(), 'SG6');
  prepare(root);
  const manifestFile = path.join(fixturesOf(root), 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.links[0].rel = '../../elsewhere/leak.txt';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(fixturesOf(root), 'project', 'app.js'), 'changed\n');
  const result = sg6.verifySet(fixturesOf(root), 'persistent');
  assert.equal(result.state, 'broken');
  assert.ok(result.problems.some((p) => /manifest links differs/.test(p)), result.problems.join('; '));
  assert.ok(result.problems.some((p) => /unexpected content/.test(p)), result.problems.join('; '));
});

test('SG6-H5 a junction or a plain file where a symbolic link belongs is refused (Windows link type and reparse tag)', () => {
  const root = path.join(tempRoot(), 'SG6');
  prepare(root);
  const base = fixturesOf(root);
  fs.symlinkSync(path.join(base, 'outside', 'dir'), path.join(base, 'project', 'leakdir'), 'junction');
  fs.writeFileSync(path.join(base, 'project', 'leak.txt'), 'plain\n');
  const result = sg6.verifySet(base, 'persistent');
  assert.equal(result.state, 'broken');
  const text = result.problems.join('; ');
  assert.match(text, /not a symbolic link: .*leak\.txt/);
  assert.match(text, /reparse tag 0xa0000003.*leakdir/);
  assert.match(text, /"Junction", not SymbolicLink: .*leakdir/);
  assert.match(text, /2 of 4 symbolic links are missing/);
});

test('SG6-H6 assertInside allows project\\ and spare\\ only, also through a junction', () => {
  const root = path.join(tempRoot(), 'SG6');
  prepare(root);
  const base = fixturesOf(root);
  const fixtures = { project: sg6.join(base, 'project'), spare: sg6.join(base, 'spare') };
  assert.equal(sg6.assertInside(fixtures, path.join(fixtures.project, 'victim-file.txt')), path.join(fixtures.project, 'victim-file.txt'));
  assert.ok(sg6.assertInside(fixtures, path.join(fixtures.spare, 'swap-file-link')));
  assert.throws(() => sg6.assertInside(fixtures, path.join(base, 'outside', 'OUTSIDE.txt')), /outside the fixture folders/);
  assert.throws(() => sg6.assertInside(fixtures, path.join(fixtures.project, '..', 'manifest.json')), /outside the fixture folders/);
  fs.symlinkSync(path.join(base, 'outside'), path.join(fixtures.project, 'j'), 'junction');
  assert.throws(() => sg6.assertInside(fixtures, path.join(fixtures.project, 'j', 'x.txt')), /resolves to/);
});

test('SG6-H7 the override must name a fixtures folder beside a sentinel, or the legacy TEMP set', () => {
  const temp = tempRoot();
  const result = sg6.loadSg6Fixtures({ env: { [sg6.ENV]: temp }, root: undefined, legacy: path.join(temp, 'legacy') });
  assert.equal(result.mode, 'refused');
  assert.equal(result.state, 'broken');
  const root = path.join(temp, 'SG6');
  prepare(root);
  assert.equal(sg6.locate({ env: { [sg6.ENV]: fixturesOf(root) }, legacy: path.join(temp, 'legacy') }).mode, 'persistent');
});

test('SG6-H8 the TEMP fallback is used only while the persistent set has no link, and is reported', () => {
  const temp = tempRoot();
  const legacy = path.join(temp, 'legacy');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'manifest.json'), '{}');
  const root = path.join(temp, 'SG6');
  const absent = sg6.locate({ env: noEnv, root, legacy });
  assert.deepEqual([absent.mode, absent.fallback], ['legacy', true]);
  assert.match(absent.source, /FALLBACK.*does not exist yet/);
  prepare(root);
  const prepared = sg6.locate({ env: noEnv, root, legacy });
  assert.deepEqual([prepared.mode, prepared.fallback], ['legacy', true]);
  assert.match(prepared.source, /FALLBACK.*no links yet/);
  // One link-like entry present: the persistent set is in use (and fails), never masked by the fallback.
  fs.symlinkSync(path.join(fixturesOf(root), 'outside', 'dir'), path.join(fixturesOf(root), 'project', 'leakdir'), 'junction');
  const partial = sg6.locate({ env: noEnv, root, legacy });
  assert.deepEqual([partial.mode, partial.fallback, partial.base], ['persistent', undefined, fixturesOf(root)]);
  const none = sg6.locate({ env: noEnv, root: path.join(temp, 'nothing'), legacy: path.join(temp, 'no-legacy') });
  assert.equal(none.mode, 'persistent');
  assert.equal(sg6.verifySet(none.base, none.mode).state, 'absent');
});

test('SG6-H9 a repair renames the earlier set and deletes nothing', () => {
  const root = path.join(tempRoot(), 'SG6');
  prepare(root, { now: new Date('2026-11-26T10:00:00Z') });
  const before = fs.readFileSync(path.join(fixturesOf(root), 'manifest.json'), 'utf8');
  prepare(root, { retire: true, now: new Date('2026-11-26T11:00:00Z') });
  const retired = path.join(root, 'retired-20261126-110000');
  assert.equal(fs.readFileSync(path.join(retired, 'manifest.json'), 'utf8'), before, 'the earlier set is kept as it was');
  assert.equal(sg6.verifySet(fixturesOf(root), 'persistent').state, 'prepared');
});
