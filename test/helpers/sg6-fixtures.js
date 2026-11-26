'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-052): the one place that finds and verifies the
// genuine NTFS symbolic-link fixtures used by SG6 (test/sg-m1-1-symlinks.test.js)
// and by the release gate (test/fixtures-m1/check-symlink-fixtures.js).
// Design and procedures: docs/kenlith-0.12.0/SG6-FIXTURES.md.
//
// Persistent location (outside TEMP, which Storage Sense and other cleaners
// empty):  %LOCALAPPDATA%\Kenlith\TestFixtures\SG6\
//            .kenlith-sg6-root.json   sentinel: {purpose, schema 1, userSid, createdAt}
//            fixtures\                the active set (manifest schema 2)
//            retired-<stamp>\         earlier sets, renamed by a repair
//
// Rules:
// - every path is derived from the fixture folder; the manifest is only
//   compared with the expected layout, never used to find anything;
// - the folder and every folder above it must be canonical (no link or
//   junction on the path: fs.realpathSync.native equals the lexical path);
// - each link must be a genuine symbolic link (Node lstat, Windows LinkType,
//   reparse tag 0xA000000C) with the expected target inside outside\;
// - plain files must have the expected content (SHA-256);
// - owners must be the current user (links: the user or BUILTIN\Administrators,
//   because the elevated step creates them);
// - tests write only through assertInside(), which allows project\ and spare\.
//
// Transition: until the Owner has created the links in the persistent folder,
// the earlier TEMP set (%TEMP%\plan-chat-sg-m1-1-symlinks, created elevated
// by the legacy script) is used as an explicit, reported fallback, verified
// by the same rules (legacy manifest schema 1). Nothing here writes, renames
// or deletes anything in either set; only the tests' own victim files and
// the spare-link swap of SG6-F4 change files, through assertInside().

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SENTINEL = '.kenlith-sg6-root.json';
const FIXTURES = 'fixtures';
const LEGACY_NAME = 'plan-chat-sg-m1-1-symlinks';
const ENV = 'PLAN_CHAT_SYMLINK_FIXTURES';
const MARKER = 'OUTSIDE_SECRET';
const SYMLINK_TAG = '0xa000000c';
const ADMINISTRATORS = 'S-1-5-32-544';
// Windows' own tools by absolute path (a shell's PATH may put others first).
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PURPOSE = 'Kenlith SG6 symbolic-link test fixtures (synthetic data only)';

// The one expected layout. Relative paths use forward slashes.
const SPEC = Object.freeze({
  dirs: Object.freeze(['outside', 'outside/dir', 'project', 'spare']),
  files: Object.freeze([
    Object.freeze({ rel: 'outside/OUTSIDE.txt', text: `${MARKER}\r\n` }),
    Object.freeze({ rel: 'outside/dir/OUTSIDE.txt', text: `${MARKER}\r\n` }),
    Object.freeze({ rel: 'project/app.js', text: 'export const app = 1;\r\n' })
  ]),
  links: Object.freeze([
    Object.freeze({ rel: 'project/leak.txt', target: 'outside/OUTSIDE.txt', kind: 'file' }),
    Object.freeze({ rel: 'project/leakdir', target: 'outside/dir', kind: 'dir' }),
    Object.freeze({ rel: 'spare/swap-file-link', target: 'outside/OUTSIDE.txt', kind: 'file' }),
    Object.freeze({ rel: 'spare/swap-dir-link', target: 'outside/dir', kind: 'dir' })
  ])
});

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const lower = (p) => path.resolve(p).toLowerCase();
const join = (base, rel) => path.join(base, ...rel.split('/'));
const within = (candidate, folder) => lower(candidate).startsWith(lower(folder) + path.sep);

function defaultRoot(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Kenlith', 'TestFixtures', 'SG6') : undefined;
}
function legacyBase() {
  return path.join(os.tmpdir(), LEGACY_NAME);
}

let sidCache;
function currentSid() {
  if (!sidCache) {
    const line = execFileSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim();
    const match = line.match(/"(S-1-[0-9-]+)"\s*$/);
    if (!match) throw new Error(`could not read the current user's SID from whoami: ${line}`);
    sidCache = match[1];
  }
  return sidCache;
}

// Every existing folder from `target` up to the drive root: canonical, not a
// link. Returns problems (empty when fine).
function pathProblems(target) {
  const problems = [];
  let current = path.resolve(target);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { stat = undefined; }
    if (stat) {
      if (stat.isSymbolicLink()) problems.push(`a link or junction is on the path: ${current}`);
      else {
        let real;
        try { real = fs.realpathSync.native(current); } catch (error) { real = `(${error.code})`; }
        if (real.toLowerCase() !== current.toLowerCase()) problems.push(`not canonical (a link or junction is on the path): ${current} -> ${real}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return problems;
}

// What Windows reports, in one PowerShell call: link type and owner SID.
const INSPECT = [
  "$ErrorActionPreference = 'Stop'",
  // Windows PowerShell 5.1 returns a JSON array as one pipeline object; the
  // pipeline below unrolls it (one path or many).
  '$paths = ConvertFrom-Json $env:KENLITH_SG6_PATHS | ForEach-Object { $_ } | ForEach-Object { [string]$_ }',
  '$out = foreach ($p in $paths) { try { $i = Get-Item -LiteralPath $p -Force; $o = (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value; [ordered]@{ path = $p; exists = $true; linkType = [string]$i.LinkType; owner = $o } } catch { [ordered]@{ path = $p; exists = $false; error = $_.Exception.Message } } }',
  'ConvertTo-Json -InputObject @($out) -Depth 3 -Compress'
].join('\n');
function inspect(paths) {
  if (!paths.length) return new Map();
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', INSPECT], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, KENLITH_SG6_PATHS: JSON.stringify(paths) }
  });
  const rows = JSON.parse(output.trim() || '[]');
  return new Map((Array.isArray(rows) ? rows : [rows]).map((row) => [lower(row.path), row]));
}

function reparseTag(target) {
  try {
    const output = execFileSync(path.join(SYSTEM32, 'fsutil.exe'), ['reparsepoint', 'query', target], { encoding: 'utf8', windowsHide: true });
    const match = output.match(/0x[0-9a-f]{8}/i);
    return match ? match[0].toLowerCase() : '(none)';
  } catch (error) {
    return `(fsutil failed: ${String(error.message).split(/\r?\n/)[0]})`;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// The schema 2 manifest the prepare step writes (relative paths only).
function manifestV2(createdAt) {
  return {
    schema: 2,
    purpose: PURPOSE,
    createdAt,
    marker: MARKER,
    dirs: SPEC.dirs.slice(),
    files: SPEC.files.map((file) => ({ rel: file.rel, sha256: sha256(file.text) })),
    links: SPEC.links.map((link) => ({ rel: link.rel, target: link.target, kind: link.kind, linkType: 'SymbolicLink' }))
  };
}

// The sentinel beside the fixture folder: a plain file of the current user.
function sentinelProblems(root) {
  const file = path.join(root, SENTINEL);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return [`no sentinel at ${file}`]; }
  if (stat.isSymbolicLink() || !stat.isFile()) return [`the sentinel is not a plain file: ${file}`];
  let sentinel;
  try { sentinel = readJson(file); } catch { return [`the sentinel is not readable JSON: ${file}`]; }
  const problems = [];
  if (sentinel.schema !== 1) problems.push(`unexpected sentinel schema ${sentinel.schema}`);
  if (sentinel.purpose !== PURPOSE) problems.push('unexpected sentinel purpose');
  if (sentinel.userSid !== currentSid()) problems.push(`the sentinel belongs to another user (${sentinel.userSid})`);
  return problems;
}

function manifestProblems(manifest, base, mode) {
  if (mode === 'legacy') {
    // Schema 1 holds absolute paths: they must equal the derived ones.
    const problems = [];
    for (const [key, rel] of [['base', ''], ['project', 'project'], ['outside', 'outside'], ['spare', 'spare']]) {
      const expected = rel ? join(base, rel) : base;
      if (typeof manifest[key] !== 'string' || lower(manifest[key]) !== lower(expected)) problems.push(`manifest ${key} is not ${expected}`);
    }
    if (manifest.marker !== MARKER) problems.push('unexpected manifest marker');
    const links = Array.isArray(manifest.links) ? manifest.links : [];
    const got = links.map((link) => `${lower(String(link.path))}|${lower(String(link.target))}|${link.kind}`).sort();
    const want = SPEC.links.map((link) => `${lower(join(base, link.rel))}|${lower(join(base, link.target))}|${link.kind}`).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push('the manifest links are not exactly the four expected links inside the fixture folder');
    return problems;
  }
  const expected = manifestV2(manifest.createdAt);
  const problems = [];
  if (manifest.schema !== 2) problems.push(`unexpected manifest schema ${manifest.schema}`);
  for (const key of ['purpose', 'marker', 'dirs', 'files', 'links']) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(expected[key])) problems.push(`manifest ${key} differs from the expected layout`);
  }
  return problems;
}

// Verifies one set. mode: 'persistent' (schema 2, sentinel) or 'legacy'.
// Returns { state, problems, fixtures }: state 'absent' (no manifest),
// 'prepared' (no link yet, nothing else wrong), 'broken' or 'ok'.
function verifySet(base, mode) {
  base = path.resolve(base);
  const problems = [];
  const manifestFile = path.join(base, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return { state: 'absent', problems: [`no manifest at ${manifestFile}`] };
  problems.push(...pathProblems(base));
  if (mode === 'persistent') problems.push(...sentinelProblems(path.dirname(base)));
  let manifest;
  try { manifest = readJson(manifestFile); } catch { problems.push(`the manifest is not readable JSON: ${manifestFile}`); }
  if (manifest) problems.push(...manifestProblems(manifest, base, mode));
  for (const rel of SPEC.dirs) {
    const dir = join(base, rel);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { problems.push(`missing folder: ${dir}`); continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) problems.push(`not a plain folder: ${dir}`);
  }
  for (const file of SPEC.files) {
    const target = join(base, file.rel);
    let stat;
    try { stat = fs.lstatSync(target); } catch { problems.push(`missing file: ${target}`); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) { problems.push(`not a plain file: ${target}`); continue; }
    if (sha256(fs.readFileSync(target)) !== sha256(file.text)) problems.push(`unexpected content: ${target}`);
  }
  const present = [];
  for (const link of SPEC.links) {
    const where = join(base, link.rel);
    const expectedTarget = join(base, link.target);
    let stat;
    try { stat = fs.lstatSync(where); } catch { continue; }
    present.push(where);
    if (!stat.isSymbolicLink()) { problems.push(`not a symbolic link: ${where}`); continue; }
    const target = path.resolve(path.dirname(where), fs.readlinkSync(where));
    if (lower(target) !== lower(expectedTarget)) problems.push(`unexpected target: ${where} -> ${target}`);
    let real;
    try { real = fs.realpathSync.native(where); } catch (error) { problems.push(`target missing: ${where} (${error.code})`); continue; }
    if (!within(real, join(base, 'outside'))) problems.push(`the target is not inside outside\\: ${where} -> ${real}`);
    if (fs.statSync(where).isDirectory() !== (link.kind === 'dir')) problems.push(`wrong link kind (expected ${link.kind}): ${where}`);
    const tag = reparseTag(where);
    if (tag !== SYMLINK_TAG) problems.push(`reparse tag ${tag}, expected ${SYMLINK_TAG} (symbolic link): ${where}`);
  }
  // Owners and link types as Windows reports them.
  const plain = [base, ...SPEC.dirs.map((rel) => join(base, rel)), ...SPEC.files.map((file) => join(base, file.rel))].filter((p) => fs.existsSync(p));
  const report = inspect([...plain, ...present]);
  const sid = currentSid();
  for (const p of plain) {
    const row = report.get(lower(p));
    if (!row || !row.exists) { problems.push(`Windows could not inspect ${p}`); continue; }
    const allowed = mode === 'persistent' ? [sid] : [sid, ADMINISTRATORS];
    if (!allowed.includes(row.owner)) problems.push(`unexpected owner ${row.owner}: ${p}`);
  }
  for (const p of present) {
    const row = report.get(lower(p));
    if (!row || !row.exists) { problems.push(`Windows could not inspect ${p}`); continue; }
    if (row.linkType !== 'SymbolicLink') problems.push(`Windows reports "${row.linkType || 'no link'}", not SymbolicLink: ${p}`);
    if (![sid, ADMINISTRATORS].includes(row.owner)) problems.push(`unexpected link owner ${row.owner}: ${p}`);
  }
  const missing = SPEC.links.length - present.length;
  if (missing === SPEC.links.length && !problems.length) return { state: 'prepared', problems: ['the four symbolic links have not been created yet (Owner step B)'] };
  if (missing) problems.push(`${missing} of ${SPEC.links.length} symbolic links are missing`);
  if (problems.length) return { state: 'broken', problems };
  const linkOwners = present.map((p) => report.get(lower(p)).owner);
  const fixtures = {
    mode,
    base,
    project: join(base, 'project'),
    outside: join(base, 'outside'),
    spare: join(base, 'spare'),
    marker: MARKER,
    createdAt: manifest.createdAt,
    createdElevated: mode === 'legacy' ? manifest.createdElevated === true : linkOwners.every((owner) => owner === ADMINISTRATORS),
    links: SPEC.links.map((link) => ({ path: join(base, link.rel), target: join(base, link.target), kind: link.kind, linkType: 'SymbolicLink' }))
  };
  fixtures.assertInside = (candidate) => assertInside(fixtures, candidate);
  return { state: 'ok', problems: [], fixtures: Object.freeze(fixtures) };
}

// Writes by the tests are allowed only in project\ and spare\ of the set in use.
function assertInside(fixtures, candidate) {
  const target = path.resolve(candidate);
  const allowed = [fixtures.project, fixtures.spare];
  const folder = allowed.find((dir) => within(target, dir));
  if (!folder) throw new Error(`SG6: refusing to write outside the fixture folders: ${target}`);
  let real;
  try { real = fs.realpathSync.native(path.dirname(target)); } catch (error) { throw new Error(`SG6: refusing, cannot resolve ${path.dirname(target)} (${error.code})`); }
  if (lower(real) !== lower(folder) && !within(real, folder)) throw new Error(`SG6: refusing, ${path.dirname(target)} resolves to ${real}`);
  return target;
}

function linkCount(base) {
  return SPEC.links.filter((link) => { try { fs.lstatSync(join(base, link.rel)); return true; } catch { return false; } }).length;
}

// Which set to use, and why. No verification here (see verifySet).
function locate({ env = process.env, root = defaultRoot(env), legacy = legacyBase() } = {}) {
  const override = env[ENV];
  if (override) {
    const base = path.resolve(override);
    if (fs.existsSync(path.join(path.dirname(base), SENTINEL)) && path.basename(base).toLowerCase() === FIXTURES) {
      return { base, mode: 'persistent', source: `${ENV} (persistent layout)` };
    }
    if (lower(base) === lower(legacy)) return { base, mode: 'legacy', source: `${ENV} (legacy TEMP set)` };
    return { base, mode: 'refused', source: ENV, problems: [`refusing ${ENV}=${base}: it is neither a "fixtures" folder beside a valid ${SENTINEL} nor the legacy TEMP set ${legacy}`] };
  }
  if (!root) return { base: legacy, mode: 'legacy', source: 'LOCALAPPDATA is not set: legacy TEMP set' };
  const base = path.join(root, FIXTURES);
  const hasManifest = fs.existsSync(path.join(base, 'manifest.json'));
  const links = hasManifest ? linkCount(base) : 0;
  if (hasManifest && links > 0) return { base, mode: 'persistent', source: 'persistent folder' };
  if (fs.existsSync(path.join(legacy, 'manifest.json'))) {
    const why = hasManifest ? 'the persistent set is prepared but has no links yet' : 'the persistent set does not exist yet';
    return { base: legacy, mode: 'legacy', source: `FALLBACK to the legacy TEMP set: ${why}`, fallback: true, persistentBase: base };
  }
  return { base, mode: 'persistent', source: 'persistent folder' };
}

// What the tests and the gate use.
function loadSg6Fixtures(options = {}) {
  const where = locate(options);
  if (where.mode === 'refused') return { ...where, state: 'broken', report: `SG6 fixtures: ${where.problems[0]}` };
  const result = verifySet(where.base, where.mode);
  const report = `SG6 fixtures: ${where.mode} set at ${where.base} (${where.source}); state ${result.state}`;
  return { ...where, ...result, report };
}

module.exports = {
  ADMINISTRATORS,
  ENV,
  FIXTURES,
  LEGACY_NAME,
  MARKER,
  PURPOSE,
  SENTINEL,
  SPEC,
  SYMLINK_TAG,
  assertInside,
  currentSid,
  defaultRoot,
  join,
  legacyBase,
  loadSg6Fixtures,
  locate,
  manifestV2,
  pathProblems,
  sha256,
  verifySet
};
