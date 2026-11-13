'use strict';

// Read-only inventory of test folders left in the system temp folder.
// Test folders are removed when their process ends (test/helpers/owned-temp.js),
// but a process killed outright (Task Manager, taskkill /F, a closed console, a
// timeout in the tool that started it) cannot clean up. This lists what such
// runs left behind. It deletes nothing and writes nothing.
//
// Usage: node test/integration/orphan-inventory.js [--min-age-hours 24] [--json]
//
// Each plan-chat-*, scopearc-*, kenlith-* and finalist-label-probe-* folder
// directly under the temp folder is reported as
//   leftover  name of a known test creator, older than --min-age-hours (newest
//             entry included), readable, no link leading outside the temp test
//             folders, not named by any running process
//   review    anything else, with the reasons
// Links inside a folder are listed, never followed.
//
// Removing leftovers is a separate step that needs the owner's approval: stop
// all test runs and editors started by tests, run this again, and remove only
// the folders reported as leftover, re-checking each one just before removal
// (same creation time and contents; remove links as links first). Never remove
// by prefix alone. plan-chat-sg-m1-1-symlinks is a reusable fixture: keep it.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Folder names made by the current test code (mkdtemp adds six characters).
const CREATORS = [
  ['unit: fake-vscode makeTempDir', /^plan-chat-test-[A-Za-z0-9]{6}$/],
  ['unit: old-release', /^plan-chat-old-[0-9.]+-[A-Za-z0-9]{6}$/],
  ['unit: wp06', /^plan-chat-(vsix|auth)-[A-Za-z0-9]{6}$/],
  ['unit: owned-temp.test', /^plan-chat-ot-\d+-[A-Za-z0-9]{6}$/],
  ['integration: makeSandbox', /^plan-chat-(sidebar|kbd|ws|s2-[A-Z][0-9]+|s3-[A-Z][0-9]+|exposure-(development|installed|test-copy)|rc-[A-Za-z0-9-]+-(clean|restricted|upgrade|legacy))-[A-Za-z0-9]{6}$/],
  ['integration: runner folder', /^plan-chat-(restricted|config|ui|multi|it|stage2|stage3|candidate)-[A-Za-z0-9]{6}$/],
  ['0.4.1 acceptance: continuity.js', /^scopearc-(continuity|clean|control|settings)-[A-Za-z0-9]{6}$/],
  ['unit: scopearc-041', /^scopearc-pack-[A-Za-z0-9]{6}$/],
  // Kenlith 0.4.1: its acceptance driver and package test, and the naming
  // probes kept as evidence (scopearc-0.4.1/naming-risk, docs/naming).
  ['Kenlith 0.4.1 acceptance: continuity.js', /^kenlith-(continuity|clean)-[A-Za-z0-9]{6}$/],
  ['unit: kenlith-041', /^kenlith-pack-[A-Za-z0-9]{6}$/],
  // Kenlith 0.5.0 unit tests (project context, tools, hostile projects);
  // removed in test.after, left only by a killed process.
  ['unit: kenlith 0.5.0 project context', /^kenlith-pc-[A-Za-z0-9]{6}$/],
  ['evidence: kenlith 0.5.0 phase12/perf.js', /^kenlith-perf-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.5.0 project-awareness.js', /^kenlith-pa-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.6.0 review-apply.js', /^kenlith-ra-[A-Za-z0-9]{6}$/],
  ['unit: kenlith 0.7.0 exec-core', /^kenlith-(exec|out)-[A-Za-z0-9]{6}$/],
  ['evidence: kenlith 0.7.0 live/why-plan-excerpt.js', /^kenlith-why-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.7.0 composer-ui.js', /^kenlith-cmp-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.8.0 thinking-ui.js', /^kenlith-thk-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.7.0 exec-host.js', /^kenlith-xh-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.6.0 restart-review.js', /^kenlith-rr-[A-Za-z0-9]{6}$/],
  ['integration: kenlith 0.6.0 editor-icon.js', /^kenlith-icon-(light|dark|hc-dark|hc-light)-[A-Za-z0-9]{6}$/],
  ['evidence: kenlith 0.5.0 phase15/live/live-check.js', /^kenlith-live-[A-Za-z0-9]{6}$/],
  ['evidence: kenlith 0.5.0 phase13/interactive/d3-launch.js', /^kenlith-d3-[A-Za-z0-9]{6}$/],
  ['naming evidence: settings-labels.js, label-probe.js', /^scopearc-(settings-labels|label-probe|label-probe-ext)-[A-Za-z0-9]{6}$/],
  ['naming evidence: label-probe2.js', /^finalist-label-probe(-ext)?-[A-Za-z0-9]{6}$/],
  // Unit tests that clean up in test.after (left only by a killed process),
  // and probe scripts kept as evidence of earlier releases.
  ['unit: retrieval, workspace-safety', /^pc-(rt|rt-large|ws)-[A-Za-z0-9]{6}$/],
  ['evidence scripts: UX-040 spike and install, WP-04 probes', /^plan-chat-(spike|040|casefold|fsid|vulnerable)-[A-Za-z0-9]{6}$/]
];
const KEEP = new Set(['plan-chat-sg-m1-1-symlinks']);
// Top-level names this inventory looks at.
const TEST_FOLDER = /^(plan-chat|scopearc-|kenlith-|finalist-label-probe-|pc-(rt|ws)-)/;

if (require.main === module) main();
module.exports = { CREATORS, KEEP, TEST_FOLDER };

function main() {
const args = process.argv.slice(2);
const minAgeHours = Number(args[args.indexOf('--min-age-hours') + 1]) || 24;
const temp = path.resolve(os.tmpdir());
const now = Date.now();

// Command lines of running processes (Windows); undefined if they cannot be read.
function processCommandLines() {
  if (process.platform !== 'win32') return undefined;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).toLowerCase();
  } catch {
    return undefined;
  }
}

function inspect(dir) {
  const root = fs.lstatSync(dir);
  const result = { bytes: 0, files: 0, newest: root.mtimeMs, links: [], unreadable: 0, isLink: root.isSymbolicLink() };
  if (result.isLink) return result;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      result.unreadable += 1;
      continue;
    }
    for (const name of names) {
      const item = path.join(current, name);
      let stat;
      try {
        stat = fs.lstatSync(item);
      } catch {
        result.unreadable += 1;
        continue;
      }
      result.newest = Math.max(result.newest, stat.mtimeMs);
      if (stat.isSymbolicLink()) {
        let target;
        try {
          target = path.resolve(path.dirname(item), fs.readlinkSync(item).replace(/^\\\\\?\\/, ''));
        } catch {
          result.unreadable += 1;
        }
        const relative = target && path.relative(temp, target);
        const inside = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && TEST_FOLDER.test(relative.split(path.sep)[0]);
        result.links.push({ link: path.relative(dir, item), target, inside });
      } else if (stat.isDirectory()) {
        stack.push(item);
      } else {
        result.bytes += stat.size;
        result.files += 1;
      }
    }
  }
  return result;
}

const commandLines = processCommandLines();
const rows = fs.readdirSync(temp).filter((name) => TEST_FOLDER.test(name) && fs.lstatSync(path.join(temp, name)).isDirectory()).map((name) => {
  const dir = path.join(temp, name);
  const info = inspect(dir);
  const creator = CREATORS.find(([, pattern]) => pattern.test(name))?.[0];
  const created = fs.lstatSync(dir).birthtimeMs;
  const reasons = [];
  if (KEEP.has(name)) reasons.push('reusable fixture: keep');
  else if (!creator) reasons.push('no known creator');
  if (info.isLink) reasons.push('the folder itself is a link');
  if (now - Math.max(created, info.newest) < minAgeHours * 3600000) reasons.push(`changed within ${minAgeHours} h`);
  if (info.unreadable) reasons.push('unreadable entries');
  if (info.links.some((item) => !item.inside)) reasons.push('link leading outside the temp test folders');
  if (commandLines === undefined) reasons.push('running processes could not be checked');
  else if (commandLines.includes(name.toLowerCase())) reasons.push('named by a running process');
  return { name, status: reasons.length ? 'review' : 'leftover', creator: creator || '-', created: new Date(created).toISOString(), newest: new Date(info.newest).toISOString(), bytes: info.bytes, files: info.files, links: info.links, reasons };
});

if (args.includes('--json')) {
  console.log(JSON.stringify({ temp, minAgeHours, rows }, null, 2));
} else {
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  for (const row of rows.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name))) {
    console.log(`${row.status.padEnd(8)} ${mb(row.bytes).padStart(9)} MB  ${row.created.slice(0, 16)}Z  ${row.name}  [${row.creator}]${row.reasons.length ? `  ${row.reasons.join('; ')}` : ''}`);
  }
  const sum = (status) => rows.filter((row) => row.status === status);
  console.log(`\n${temp}: ${rows.length} test folders; leftover ${sum('leftover').length} (${mb(sum('leftover').reduce((total, row) => total + row.bytes, 0))} MB), review ${sum('review').length}. Nothing was changed.`);
}
}
