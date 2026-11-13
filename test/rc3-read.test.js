'use strict';

// Kenlith 0.7.0 RC3 read path (owner decision of 2026-11-11, DEC-PLANCHAT-036):
// content that the read tools or excerpts would send is refused whole when it
// holds sensitive text the earlier credential patterns missed. Local-only
// reads (Review Before Apply) are unchanged. Synthetic secrets only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readContained } = require('../src/workspace-safety');
const { retrieve } = require('../src/retrieval');
const { hasSensitiveText } = require('../src/sensitive-text');

function project(files) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  return root;
}

test('RR1 a file with a secret the earlier patterns missed is not sent by the read tools; the same file stays readable locally', async () => {
  const root = project({
    'settings.txt': 'PASSPHRASE=SYNTHPASSPHRASECORRECTHORSEBATTERY\n',
    'src/a.js': 'const API_KEY = process.env.API_KEY;\nmodule.exports = { API_KEY };\n'
  });
  assert.deepEqual(await readContained(root, 'settings.txt', { sending: true }), { ok: false, reason: 'credential-content' });
  assert.equal((await readContained(root, 'settings.txt')).ok, true, 'local reads (Review Before Apply) are unchanged');
  assert.equal((await readContained(root, 'src/a.js', { sending: true })).ok, true, 'ordinary code is still sent');
});

test('RR2 excerpts: a matching file with sensitive text is withheld (credential-content); ordinary files are still chosen', async () => {
  const root = project({
    'notes/deploy.md': 'Deploy notes.\nwebhook https://hooks.example.com/services/T0A1B2C3/B4D5E6F7/Zx9Kq2Lm8Np4Rt6Vw0Yb3\n',
    'notes/plan.md': 'Deploy plan: tag the release, then run the deploy script.\n'
  });
  const r = await retrieve({ root, query: 'deploy notes webhook plan' });
  const files = r.excerpts.map((e) => e.relPath);
  assert.ok(!files.includes('notes/deploy.md'), JSON.stringify(files));
  assert.ok(files.includes('notes/plan.md'));
  assert.ok(r.withheld.some((w) => w.relPath === 'notes/deploy.md' && w.reason === 'credential-content'), JSON.stringify(r.withheld));
});

test('RR3 what the read path now recognises, and what it leaves alone', () => {
  for (const s of ['DB_PASS=sunshine123x', 'gh' + 'p_1234567890abcdefghijklmnopqrstuvwxyz12', 'url = "https://ci' + ':S3cretPass@git.example.com/x"', 'mongodb+srv://u' + ':p4ssw0rd!@cluster0.x.net/db', 'key: Zq8Lr2Vt6Xp0Nw4Ys9Ub3Ka7Mc1Ed5Fg', '-----BEGIN OPENSSH PRI' + 'VATE KEY-----']) {
    assert.equal(hasSensitiveText(s), true, s);
  }
  for (const s of ['const API_KEY = process.env.API_KEY;', 'Author: Example Dev <dev@example.com>', 'commit 4f6f4f68f12f904e696246eb43550a1aa0194c64', 'export function computeInvoiceTotal(items) {', 'keyboard layout: qwerty', 'apiKey: ${API_KEY}']) {
    assert.equal(hasSensitiveText(s), false, s);
  }
});
