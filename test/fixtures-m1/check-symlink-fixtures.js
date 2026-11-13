'use strict';

// Kenlith 0.7.0: integrity check of the genuine symbolic-link fixtures used by
// test/sg-m1-1-symlinks.test.js (SG6-F0 to F4), for the start of a security
// gate. Not elevated; reads only. Their links disappeared once (2026-11-08,
// cause unknown) and the gate then failed late; this finds it first.
//
//   node test/fixtures-m1/check-symlink-fixtures.js
// Exit 0: every expected link is a genuine symbolic link to its manifest
// target, every target is inside the fixture folder and exists.
// Exit 1: what is wrong, and how to recreate the fixtures (elevated, once).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = process.env.PLAN_CHAT_SYMLINK_FIXTURES || path.join(os.tmpdir(), 'plan-chat-sg-m1-1-symlinks');
const problems = [];
const manifestFile = path.join(base, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^﻿/, ''));
} catch {
  problems.push(`no readable manifest at ${manifestFile}`);
}
const inside = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep);
for (const link of manifest?.links || []) {
  let stat;
  try { stat = fs.lstatSync(link.path); } catch { problems.push(`missing: ${link.path}`); continue; }
  if (!stat.isSymbolicLink()) { problems.push(`not a symbolic link: ${link.path}`); continue; }
  const target = path.resolve(path.dirname(link.path), fs.readlinkSync(link.path));
  if (target.toLowerCase() !== path.resolve(link.target).toLowerCase()) problems.push(`unexpected target: ${link.path} -> ${target}`);
  if (!inside(target)) problems.push(`target outside the fixture folder: ${target}`);
  if (!fs.existsSync(target)) problems.push(`target missing: ${target}`);
}
if (manifest && (manifest.links || []).length !== 4) problems.push(`expected 4 links in the manifest, found ${(manifest.links || []).length}`);
if (problems.length) {
  console.log('SYMLINK FIXTURES NOT USABLE');
  for (const p of problems) console.log(`  ${p}`);
  console.log('Recreate them once, elevated: remove the folder, then run test/fixtures-m1/create-symlink-fixtures.ps1 (see its header).');
  process.exit(1);
}
console.log(`symlink fixtures OK: ${manifest.links.length} genuine symbolic links in ${base}`);
