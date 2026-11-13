'use strict';

// SG-M1-1 with GENUINE Windows symbolic links (file and directory).
//
// Creating a symbolic link needs the "Create symbolic links" privilege or
// Developer Mode, which normal test runs do not have (test/workspace-safety
// SG6 records NOT RUN then). The links are therefore created once by
// test/fixtures-m1/create-symlink-fixtures.ps1 (elevated), and this file
// uses them WITHOUT elevation. Every case first checks that the fixtures are
// real symbolic links; without them every case is skipped as NOT RUN, and
// nothing is ever reported as passed without the real links.
//
// What is measured, per case: the refusal and its reason; that no outside
// text is returned; every file the code under test opens, by its RESOLVED
// target (links followed); and every content read on an open file handle.
// The claim is "never read": in the swap case the code does open the outside
// file (the link is swapped in after the checks) and then refuses before any
// read; the test asserts exactly that.
//
// Note: src/workspace-safety.js takes its realpath function at load time, so
// realpath calls are not traced (they read no content).
//
// The fixtures are used in place and left as found (the swap test renames a
// spare link into the project and back).

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readContained, resolveRoot, statContained } = require('../src/workspace-safety');
const { createCache, retrieve } = require('../src/retrieval');

const BASE = process.env.PLAN_CHAT_SYMLINK_FIXTURES || path.join(os.tmpdir(), 'plan-chat-sg-m1-1-symlinks');
const manifestFile = path.join(BASE, 'manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^﻿/, '')) : undefined;
const NOT_RUN = 'NOT RUN: symbolic-link fixtures are absent (create them once, elevated, with test/fixtures-m1/create-symlink-fixtures.ps1)';
const EXPECTED_LINKS = manifest ? [
  path.join(manifest.project, 'leak.txt'), path.join(manifest.project, 'leakdir'),
  path.join(manifest.spare, 'swap-file-link'), path.join(manifest.spare, 'swap-dir-link')
] : [];

// What Windows itself reports for a path: "SymbolicLink", "Junction" or "".
function linkTypeOf(target) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${target.replace(/'/g, "''")}' -Force).LinkType`], { encoding: 'utf8', windowsHide: true }).trim();
}
const isLink = (target) => { try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; } };
const resolved = (target) => { try { return fs.realpathSync.native(String(target)); } catch { return String(target); } };
const under = (candidate, folder) => path.resolve(candidate).toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep);

// Records what the code under test opens and reads during `operation`:
// calls by path (with the resolved target), and content reads per handle.
let handlePrototype;
async function traced(operation) {
  if (!handlePrototype) {
    const probe = await fs.promises.open(__filename, 'r');
    handlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
  }
  const calls = [];
  const reads = [];
  const handlePaths = new WeakMap();
  const methods = ['open', 'opendir', 'lstat', 'stat', 'readFile'];
  const originals = Object.fromEntries(methods.map((name) => [name, fs.promises[name]]));
  for (const name of methods) {
    fs.promises[name] = async function patched(target, ...rest) {
      calls.push({ call: name, path: String(target), target: resolved(target) });
      const result = await originals[name].call(this, target, ...rest);
      if (name === 'open') handlePaths.set(result, { path: String(target), target: resolved(target) });
      return result;
    };
  }
  const readMethods = ['read', 'readFile', 'readv'];
  const readOriginals = Object.fromEntries(readMethods.map((name) => [name, handlePrototype[name]]));
  for (const name of readMethods) {
    handlePrototype[name] = function patchedRead(...args) {
      reads.push({ call: `handle.${name}`, ...(handlePaths.get(this) || { path: '(not opened through fs.promises.open)', target: '' }) });
      return readOriginals[name].apply(this, args);
    };
  }
  try {
    return { result: await operation(), calls, reads };
  } finally {
    for (const name of methods) fs.promises[name] = originals[name];
    for (const name of readMethods) handlePrototype[name] = readOriginals[name];
  }
}
const outsideReads = (reads) => reads.filter((entry) => under(entry.target, manifest.outside) || entry.target === '');
const opensOf = (calls) => calls.filter((entry) => entry.call === 'open' || entry.call === 'readFile');

// Every case: the fixtures exist and are still genuine symbolic links.
function fixtureCheck(t) {
  if (!manifest) {
    t.skip(NOT_RUN);
    return false;
  }
  for (const link of EXPECTED_LINKS) {
    assert.equal(isLink(link), true, `${link} is a symbolic link (Node lstat)`);
    assert.equal(linkTypeOf(link), 'SymbolicLink', `${link} is a symbolic link according to Windows`);
  }
  return true;
}

test('SG6-F0 the fixtures are genuine NTFS symbolic links that work, created by the helper', (t) => {
  if (!fixtureCheck(t)) return;
  assert.deepEqual(manifest.links.map((link) => path.resolve(link.path).toLowerCase()).sort(), EXPECTED_LINKS.map((link) => path.resolve(link).toLowerCase()).sort(), 'exactly the four expected links');
  for (const link of manifest.links) {
    assert.equal(path.resolve(fs.readlinkSync(link.path)).toLowerCase(), path.resolve(link.target).toLowerCase(), 'points where the manifest says');
    assert.ok(under(link.target, manifest.outside), 'the target is outside the project');
    assert.equal(fs.statSync(link.path).isDirectory(), link.kind === 'dir', `${link.kind} link`);
  }
  // They work: the operating system follows them to the outside text.
  assert.match(fs.readFileSync(path.join(manifest.project, 'leak.txt'), 'utf8'), /OUTSIDE_SECRET/);
  assert.match(fs.readFileSync(path.join(manifest.project, 'leakdir', 'OUTSIDE.txt'), 'utf8'), /OUTSIDE_SECRET/);
  t.diagnostic(`fixtures created ${manifest.createdAt}, elevated ${manifest.createdElevated}; this test process: elevated not required`);
});

test('SG6-F1 file symbolic link to a file outside: refused at the link before any open; nothing read', async (t) => {
  if (!fixtureCheck(t)) return;
  const root = (await resolveRoot(manifest.project)).root;
  const { result, calls, reads } = await traced(() => readContained(root, 'leak.txt'));
  assert.deepEqual([result.ok, result.reason], [false, 'link']);
  assert.ok(!(result.text || '').includes(manifest.marker));
  assert.deepEqual(opensOf(calls), [], 'no file was opened');
  assert.deepEqual(reads, [], 'no content was read');
  const stat = await statContained(root, 'leak.txt');
  assert.deepEqual([stat.ok, stat.reason], [false, 'link']);
  t.diagnostic(`file symlink: reason ${result.reason}; statContained ${stat.reason}; calls ${calls.map((c) => c.call).join(',')}`);
});

test('SG6-F2 directory symbolic link to a folder outside: refused at the link and through it, before any open; nothing read', async (t) => {
  if (!fixtureCheck(t)) return;
  const root = (await resolveRoot(manifest.project)).root;
  const through = await traced(() => readContained(root, 'leakdir/OUTSIDE.txt'));
  assert.equal(through.result.ok, false);
  assert.equal(through.result.reason, 'outside-root');
  assert.ok(!(through.result.text || '').includes(manifest.marker));
  assert.deepEqual(opensOf(through.calls), [], 'no file was opened');
  assert.deepEqual(through.reads, [], 'no content was read');
  const atLink = await traced(() => readContained(root, 'leakdir'));
  assert.deepEqual([atLink.result.ok, atLink.result.reason], [false, 'link']);
  assert.deepEqual(opensOf(atLink.calls), []);
  t.diagnostic(`directory symlink: through-read ${through.result.reason}; at the link ${atLink.result.reason}`);
});

test('SG6-F3 retrieval over a project with both symbolic links withholds them as links and never reads their targets', async (t) => {
  if (!fixtureCheck(t)) return;
  const root = (await resolveRoot(manifest.project)).root;
  const { result, calls, reads } = await traced(() => retrieve({ root, query: 'OUTSIDE_SECRET leak leakdir OUTSIDE.txt app', settings: {}, cache: createCache() }));
  assert.ok(calls.some((entry) => entry.call === 'opendir' && path.resolve(entry.path).toLowerCase() === path.resolve(root).toLowerCase()), 'the project was walked');
  assert.ok(result.withheld.some((item) => item.relPath === 'leak.txt' && item.reason === 'link'), 'file link withheld as a link');
  assert.ok(result.withheld.some((item) => item.relPath === 'leakdir' && item.reason === 'link'), 'directory link withheld as a link');
  assert.ok(!JSON.stringify(result.excerpts).includes(manifest.marker), 'no excerpt holds outside text');
  assert.ok(result.excerpts.every((excerpt) => !excerpt.relPath.startsWith('leak')));
  assert.ok(!calls.some((entry) => entry.call === 'opendir' && /leakdir/i.test(entry.path)), 'the directory link was not walked into');
  assert.deepEqual(opensOf(calls).filter((entry) => under(entry.target, manifest.outside)), [], 'no outside file was opened');
  assert.deepEqual(outsideReads(reads), [], 'no outside content was read');
  t.diagnostic(`retrieval status ${result.status}; withheld ${JSON.stringify(result.withheld)}; files read ${reads.length}`);
});

test('SG6-F4 check-then-read swaps: a project file replaced by a genuine file or directory symbolic link is opened, then refused before any read', async (t) => {
  if (!fixtureCheck(t)) return;
  const root = (await resolveRoot(manifest.project)).root;
  // Reasons observed with genuine links on NTFS (run 1, 2026-10-30): the file
  // link opens the outside file, whose identity differs from the checked one
  // ("changed"); the directory link opens a directory, which is not a regular
  // file ("not-file"). Either way nothing is read.
  for (const [spareName, kind, expected] of [['swap-file-link', 'file', 'changed'], ['swap-dir-link', 'dir', 'not-file']]) {
    const spare = path.join(manifest.spare, spareName);
    const victim = path.join(manifest.project, `victim-${kind}.txt`);
    fs.writeFileSync(victim, 'harmless\n');
    let swapped = false;
    try {
      const { result, calls, reads } = await traced(() => readContained(root, `victim-${kind}.txt`, {
        // Renaming an existing link needs no privilege.
        hooks: { beforeOpen: (candidate) => { fs.unlinkSync(candidate); fs.renameSync(spare, candidate); swapped = true; } }
      }));
      assert.equal(swapped, true);
      assert.equal(linkTypeOf(victim), 'SymbolicLink', 'the swap put a genuine symbolic link in place');
      assert.deepEqual([result.ok, result.reason], [false, expected], `${kind} swap refused for the expected reason`);
      assert.ok(!(result.text || '').includes(manifest.marker));
      assert.deepEqual(reads, [], 'no content was read from any handle');
      t.diagnostic(`${kind} symbolic-link swap: reason ${result.reason}; opened outside: ${opensOf(calls).some((entry) => under(entry.target, manifest.outside))}; reads ${reads.length}`);
    } finally {
      // Leave the fixtures as found (lstat: never follow the link here).
      if (swapped && isLink(victim)) fs.renameSync(victim, spare);
      if (!isLink(victim)) fs.rmSync(victim, { force: true });
    }
  }
  for (const spareName of ['swap-file-link', 'swap-dir-link']) assert.equal(linkTypeOf(path.join(manifest.spare, spareName)), 'SymbolicLink', 'spare link restored');
});
