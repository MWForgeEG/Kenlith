'use strict';

// Kenlith 0.7.0 RC3 outbound boundary (DEC-PLANCHAT-036): every exposure of
// docs/release-evidence/kenlith-0.7.0/RC2-SECURITY-FINDING.md, adversarial
// variants (history, index, subfolders, case, stderr, encodings, fragments,
// indirect disclosure through a test), fail-closed paths, and negative
// controls (ordinary output still flows, Class A still asks nothing).
// Synthetic secrets in temporary projects only; real git and node processes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { ExecutionService } = require('../src/exec-service');
const { ExecutionStore } = require('../src/exec-store');
const { classifySensitive } = require('../src/workspace-safety');
const { SENSITIVE_GLOBS, buildIndex, gitPlan, guard, looksSecret, withheldMatcher } = require('../src/exec-boundary');
const { sanitize } = require('../src/exec-output');

const S = {
  env: 'SYNTH_ENV_Q7rT2vX9kL4mN8pZ',
  envOld: 'SYNTH_OLDENV_aB3cD5eF7gH9jK1',
  envCase: 'SYNTH_CASEENV_zY8xW6vU4tS2',
  ssh: 'SYNTH_SSHKEY_mQ2nR4sT6uV8',
  config: 'SYNTH_CFGPASS_pL9oK8iJ7uH6'
};
const ALL = Object.values(S);
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

function repo({ track = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  w('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  w('src/a.js', 'const API_KEY = process.env.API_KEY;\nmodule.exports = { API_KEY };\n');
  w('README.md', '# Demo\nSet API_KEY in .env\n');
  w('.env', `API_KEY=${S.envOld}\n`);
  w('config/.ENV.local', `API_KEY=${S.envCase}\n`);
  w('deploy/.ssh/id_ed25519', `${S.ssh}\n`);
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  if (track) { git('add', '-A'); git('commit', '-qm', 'one'); }
  w('.env', `API_KEY=${S.env}\n`); // the current value differs from history
  if (track) { git('add', '-A'); git('commit', '-qm', 'two'); }
  w('.env', `API_KEY=${S.env}\nOTHER=1\n`); // and the work tree differs again
  return { root, w, git };
}

function turn(root, { approve = 'decline', excludes } = {}) {
  const asked = { approval: 0, output: 0 };
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv, excludes });
  const draft = svc.beginTurn({
    chatId: 'c', root, hasGrant: () => true,
    askApproval: async () => { asked.approval += 1; return approve; },
    askOutputSharing: async () => { asked.output += 1; return 'share'; },
    onRunning: () => undefined, signal: new AbortController().signal
  });
  const cmd = async (executable, args) => JSON.parse((await draft.runCommand({ executable, args, cwd: null, timeoutSeconds: null, env: [], purpose: 't' })).raw);
  return { svc, draft, asked, cmd };
}
const leaks = (body) => ALL.filter((s) => JSON.stringify(body).includes(s));

// ---------- the four demonstrated exposures ----------

test('B1 the four RC2 exposures: git grep, git show HEAD:.env, git diff, git log -p send no secret; Class A still asks nothing', async (t) => {
  let r;
  try { r = repo(); } catch { t.skip('git not available'); return; }
  const { cmd, asked } = turn(r.root);
  const grep = await cmd('git', ['grep', '-n', 'API_KEY']);
  const show = await cmd('git', ['show', 'HEAD:.env']);
  const diff = await cmd('git', ['diff']);
  const log = await cmd('git', ['log', '-p']);
  for (const [name, body] of Object.entries({ grep, show, diff, log })) assert.deepEqual(leaks(body), [], name);
  assert.equal(asked.approval, 0, 'Class A: no card');
  assert.equal(grep.status, 'succeeded');
  assert.match(grep.stdout, /src\/a\.js:1:const API_KEY/, 'ordinary matches still flow');
  assert.match(show.output, /not sent: it reads a file Kenlith withholds/);
  assert.match(log.stdout, /src\/a\.js/, 'the rest of the history still flows');
});

// ---------- adversarial git forms ----------

test('B2 git content reads cannot reach withheld files: history, index, subfolders, case, -h, --cached, explicit paths, blobs, blame', async (t) => {
  let r;
  try { r = repo(); } catch { t.skip('git not available'); return; }
  const { cmd } = turn(r.root);
  const forms = [
    ['grep', '-h', 'API_KEY'], ['grep', '--cached', '-n', 'SYNTH'], ['grep', '-n', 'SYNTH', 'HEAD~1'], ['grep', '-l', 'SYNTH'],
    ['grep', '-n', 'SYNTH', '--', '.env'], ['grep', '-n', 'SYNTH', '--', 'config'], ['grep', '-n', 'SYNTH', '--', ':/'],
    ['log', '-p', '--all'], ['log', '-p', '-1', 'HEAD~1'], ['log', '-p', '--follow', '--', '.env'], ['log', '--stat'],
    ['show', 'HEAD~1'], ['show', 'HEAD~1:.env'], ['show', ':.env'], ['show', 'HEAD:./.env'], ['show', 'HEAD:config/.ENV.local'],
    ['show', 'HEAD:deploy/.ssh/id_ed25519'], ['diff', 'HEAD~1'], ['diff', 'HEAD~1', '--', '.'], ['diff', '--cached'],
    ['diff', 'HEAD~1', 'HEAD', '--', 'config'], ['blame', '.env'], ['blame', '--', 'config/.ENV.local']
  ];
  for (const args of forms) {
    const body = await cmd('git', args);
    assert.deepEqual(leaks(body), [], `git ${args.join(' ')}: ${JSON.stringify(body).slice(0, 300)}`);
  }
});

test('B3 git from a subfolder and with the user exclusions (files.exclude) keeps excluded content out', async (t) => {
  let r;
  try { r = repo(); } catch { t.skip('git not available'); return; }
  r.w('private/notes.txt', `token value ${S.config}\n`);
  r.git('add', '-A'); r.git('commit', '-qm', 'private');
  const { cmd } = turn(r.root, { excludes: () => ({ filesExclude: { '**/private': true }, searchExclude: {} }) });
  const grep = await cmd('git', ['grep', '-n', 'SYNTH']);
  const log = await cmd('git', ['log', '-p', '-1']);
  assert.deepEqual(leaks(grep), []);
  assert.deepEqual(leaks(log), []);
  const sub = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv });
  const d = sub.beginTurn({ chatId: 'c', root: r.root, hasGrant: () => true, askApproval: async () => 'decline', askOutputSharing: async () => 'share', onRunning: () => undefined, signal: new AbortController().signal });
  const fromSrc = JSON.parse((await d.runCommand({ executable: 'git', args: ['grep', '-n', 'SYNTH'], cwd: 'src', timeoutSeconds: null, env: [], purpose: 't' })).raw);
  assert.deepEqual(leaks(fromSrc), [], 'from a subfolder, the whole repository is still restricted');
});

test('B4 a renamed secret file in history: withheld by name in every revision; content checks catch a copy under an ordinary name', async (t) => {
  let r;
  try { r = repo(); } catch { t.skip('git not available'); return; }
  // A secret committed in an ordinary file (not withheld by name), then removed.
  r.w('src/settings.js', `module.exports = { dbPassword: "${S.config}" };\n`);
  r.git('add', '-A'); r.git('commit', '-qm', 'oops');
  r.w('src/settings.js', 'module.exports = {};\n');
  r.git('add', '-A'); r.git('commit', '-qm', 'fix');
  const { cmd } = turn(r.root);
  const log = await cmd('git', ['log', '-p']);
  assert.deepEqual(leaks(log), [], 'a configuration-style secret line is removed from history output');
  assert.match(log.stdout, /credential-like line removed|possible secret removed|\[redacted\]/);
});

// ---------- output from any command ----------

test('B5 indirect disclosure: a test printing withheld values (plain, base64, hex, URL-encoded, fragmented, to stderr) sends none of them', async (t) => {
  let r;
  try { r = repo({ track: false }); } catch { t.skip('git not available'); return; }
  r.w('src/leak.test.js', [
    "const fs = require('node:fs');",
    "const v = fs.readFileSync(require('node:path').join(__dirname, '..', '.env'), 'utf8').split('\\n')[0].split('=')[1];",
    "require('node:test')('leaks', () => {",
    '  console.log("plain " + v);',
    '  console.log("b64 " + Buffer.from(v).toString("base64"));',
    '  console.log("hex " + Buffer.from(v).toString("hex"));',
    '  console.log("url " + encodeURIComponent(v));',
    '  console.log("part1 " + v.slice(0, 13));',
    '  console.log("part2 " + v.slice(13));',
    '  console.error("stderr " + v);',
    '});'
  ].join('\n'));
  const { cmd, asked } = turn(r.root);
  const body = await cmd('node', ['--test', 'src/leak.test.js']);
  assert.equal(asked.approval, 0, 'node --test stays Class A');
  assert.equal(body.status, 'succeeded');
  const all = JSON.stringify(body);
  assert.equal(all.includes(S.env), false, 'plain');
  assert.equal(all.includes(Buffer.from(S.env).toString('base64').replace(/=+$/, '')), false, 'base64');
  assert.equal(all.includes(Buffer.from(S.env).toString('hex')), false, 'hex');
  assert.equal(all.includes(S.env.slice(0, 13)) && all.includes(S.env.slice(13)), false, 'both fragments');
});

test('B6 a command whose arguments name a withheld file runs as its class allows, but sends status only', async (t) => {
  let r;
  try { r = repo({ track: false }); } catch { t.skip('git not available'); return; }
  const { cmd, asked } = turn(r.root, { approve: 'run' });
  const body = await cmd('node', ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', '.env']);
  assert.equal(asked.approval, 1, 'Class B as before: one card');
  assert.equal(body.status, 'succeeded');
  assert.equal(body.stdout, undefined);
  assert.match(body.output, /not sent: it reads a file Kenlith withholds/);
  assert.deepEqual(leaks(body), []);
});

test('B7 credential formats, multiline private keys (also when cut), connection strings and configuration secrets are removed', () => {
  const samples = [
    'gh' + 'p_1234567890abcdefghijklmnopqrstuvwxyz12', 'gi' + 'thub_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'sk' + '_live_51Habcdefghijklmnop', 'sk' + '_test_51Habcdefghijklmnop', 'xo' + 'xb-123456789012-1234567890123-abcdefghijklmnop',
    'AI' + 'zaSyA-1234567890abcdefghijklmnopqrstu', 'aws_secret_access_key = wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'np' + 'm_abcdefghijklmnopqrstuvwxyz0123456789', 'gl' + 'pat-abcdefghij0123456789', 'API_KEY=LIVE_SECRET_abcdef123456',
    'secret: s3cr3tValue123', 'postgres://admin' + ':S3cretPass@db.internal:5432/app', 'mongodb+srv://u' + ':p4ssw0rd!@cluster0.x.net/db',
    'DefaultEndpointsProtocol=https;AccountName=x;Account' + 'Key=abcd1234abcd1234abcd1234==;', 'Server=db;User Id=sa;Password=Pa55w0rd!;',
    '"client_secret": "abcDEF123456ghiJKL"', 'export STRIPE_KEY="sk' + '_live_abcdefghijklmnop"', 'Authorization: Bearer abcdefgh12345678'
  ];
  for (const s of samples) {
    const out = sanitize(`before\n${s}\nafter`, { env: {} }).text;
    assert.equal(out.includes(s), false, s);
    assert.match(out, /^before\n/, `${s}: other lines stay`);
  }
  const key = ['-----BEGIN OPENSSH PRI' + 'VATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', 'QyNTUxOQAAACBz2mYkXbaQ8fL3HxL8kq9yZVv3dS0wq1bQf6hY0sQAAAAJiW1F0ElQAAA', '-----END OPENSSH PRI' + 'VATE KEY-----'];
  const pk = sanitize(['start', ...key, 'end'].join('\n'), { env: {} }).text;
  assert.equal(pk, 'start\n[private key removed]\nend');
  const cut = sanitize(['start', key[0], key[1], '[… 900 bytes not kept …]', key[2]].join('\n'), { env: {} }).text;
  assert.equal(cut, 'start\n[private key removed]', 'a key cut by the capture boundary is removed to the end');
  const tailOnly = sanitize(['tail of output', key[2], key[3]].join('\n'), { env: {} }).text;
  assert.equal(tailOnly.includes(key[2]), false, 'key body without its BEGIN line is caught as high entropy');
});

test('B8 unknown secrets: long random tokens are replaced; hashes, ids, paths, words and test output are kept', () => {
  for (const s of ['Zq8Lr2Vt6Xp0Nw4Ys9Ub3Ka7Mc1Ed5Fg', 'k3J9fLq2Wz8Rt5Yp1Xv7Bn4Mc6Hs0Dg2Ae']) assert.equal(looksSecret(s), true, s);
  const ordinary = [
    '✔ formatTotal (0.9927ms)', 'ℹ tests 1', 'ℹ duration_ms 322.7292',
    'commit 4f6f4f68f12f904e696246eb43550a1aa0194c64ea155fe7d52684ac2684f813', 'index 3b18e51..a1b2c3d 100644',
    'src/components/navigation/SidebarNavigationItem.test.tsx', '7d4f9a2c-1b3e-4c5d-9e8f-0a1b2c3d4e5f',
    "src/a.js(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", 'useLayoutEffectCallbackHandler',
    'Author: Example Dev <dev@example.com>', 'Date:   Tue Nov 10 22:10:45 2026 +0200',
    'src/a.js:1:const API_KEY = process.env.API_KEY;', 'keyboard: enabled', 'monkey = banana123', 'const token = getToken(user);',
    'apiKey: ${API_KEY}', 'password: <your password>'
  ];
  for (const line of ordinary) assert.equal(sanitize(line, { env: {} }).text, line, line);
});

test('B9 the withheld-file index: values with their encodings and fragments; ordinary settings values are not treated as secrets', async (t) => {
  let r;
  try { r = repo({ track: false }); } catch { t.skip('git not available'); return; }
  r.w('.env.production', 'DB_HOST=localhost\nPORT=3000\nNODE_ENV=development\nSESSION_SECRET=abcd3fgh9\nDB_PASSWORD=postgres\n');
  const index = buildIndex(r.root);
  assert.equal(index.complete, true);
  assert.ok(index.values.includes(S.env) && index.values.includes(S.envCase) && index.values.includes(S.ssh));
  assert.ok(index.values.includes(Buffer.from(S.env).toString('base64')));
  assert.ok(index.values.includes('abcd3fgh9'), 'a secret-named value');
  // RC4 (DEC-PLANCHAT-038): every value of a secret file is protected, plain words included;
  // only true/false-like words and short numbers under an ordinary name are not.
  for (const v of ['postgres', 'localhost', 'development']) assert.ok(index.values.includes(v), v);
  assert.equal(index.values.includes('3000'), false, 'PORT=3000: a short number under an ordinary name');
  const g = guard(`x ${S.env.slice(3, 17)} y`, { index });
  assert.equal(g.text, '[line with part of a withheld value removed]');
});

test('B10 the sensitive git exclusions and the read tools agree: every excluded name is withheld by the read tools', () => {
  const samples = ['.env', 'a/.env.local', 'k.pem', 'k.key', 'c.p12', 'c.pfx', 'k.jks', 'k.keystore', 'k.ppk', 'v.kdbx', 'k.p8', 's.tfstate', 's.tfstate.backup', 'id_rsa', 'x/id_ed25519', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', 'kubeconfig', 'credentials', 'credentials.json', '.ssh/config', '.aws/credentials', '.azure/x', '.gnupg/x', '.kube/config', '.docker/config.json'];
  for (const name of samples) assert.ok(classifySensitive(name).withheld, `read tools withhold ${name}`);
  const isWithheld = withheldMatcher({});
  for (const name of samples) assert.ok(isWithheld(name), `boundary withholds ${name}`);
  assert.ok(isWithheld('.env.example'), 'stricter than the read tools for env examples');
  assert.equal(isWithheld('src/a.js'), false);
  assert.ok(SENSITIVE_GLOBS.length >= 30);
});

test('B11 git rewrite: pathspecs go after --; a pattern equal to a file name is not taken for a path; blob reads are checked, not rewritten', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'README'), 'x');
  const isWithheld = withheldMatcher({});
  const plan = (args) => gitPlan(args, { cwd: root, root, isWithheld, settings: {} });
  const grep = plan(['grep', '-n', 'README']);
  assert.deepEqual(grep.args.slice(0, 5), ['grep', '-n', 'README', '--', ':/']);
  const diff = plan(['diff', 'src']);
  assert.deepEqual(diff.args.slice(0, 3), ['diff', '--', 'src']);
  assert.ok(diff.args.some((a) => a === ':(top,exclude,glob,icase)**/.env'));
  assert.match(plan(['show', 'HEAD:.env']).withhold, /withholds/);
  assert.match(plan(['show', 'HEAD~2:a/.ssh/id_rsa']).withhold, /withholds/);
  assert.equal(plan(['show', 'HEAD:README']).withhold, undefined);
  assert.deepEqual(plan(['show', 'HEAD:README']).args, ['show', 'HEAD:README']);
  assert.deepEqual(plan(['status']).args, ['status']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('B12 fail closed: output that cannot be checked is withheld; a command result the last check cannot read is replaced', async () => {
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv });
  const input = [
    { type: 'function_call', call_id: 'c1', name: 'project_run_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'not json ' + S.env },
    { type: 'function_call', call_id: 'c2', name: 'project_read_file', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c2', output: '{"ok":true}' }
  ];
  const filtered = svc.outboundFilter(input);
  assert.equal(JSON.stringify(filtered).includes(S.env), false);
  assert.match(filtered[1].output, /not sent: Kenlith could not check this command result/);
  assert.equal(filtered[3], input[3], 'other tools are not touched by this boundary');
});

test('B13 the last check before sending uses the current files: a value that became withheld after the run is removed from a repeated result', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv });
  svc.secretContext(root); // the run's view: no withheld file yet
  const late = 'SYNTH_LATE_Hq4Lm8Np2Rt6';
  const input = [
    { type: 'function_call', call_id: 'c1', name: 'project_run_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ tool: 'project_run_command', status: 'succeeded', stdout: `value ${late}`, note: 'data' }) }
  ];
  fs.writeFileSync(path.join(root, '.env'), `LATE_VALUE=${late}\n`);
  const filtered = svc.outboundFilter(input);
  assert.equal(JSON.stringify(filtered).includes(late), false);
  assert.match(JSON.parse(filtered[1].output).stdout, /value \[redacted\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- independent review of RC3 (C1–C7, F1, F2) ----------

const win = process.platform === 'win32';
function bare() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('package.json', JSON.stringify({ name: 'demo' }));
  return { root, w, git: (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString() };
}
const printer = (expr) => `require('node:test')('p', () => { const fs = require('node:fs'); const p = require('node:path'); console.log(${expr}); });\n`;

test('B14 (C1) .env values without digits and under unusual names are protected', async () => {
  const p = bare();
  p.w('.env', 'PASSPHRASE=SYNTHPASSPHRASECORRECTHORSEBATTERY\nDEPLOY_PHRASE=SYNTHDEPLOYPHRASEMAPLESYRUPCEDAR\nDB_PASS=sunshine\n');
  p.w('src/t.test.js', printer("fs.readFileSync(p.join(__dirname, '..', '.env'), 'utf8')"));
  const { cmd, asked } = turn(p.root);
  const body = await cmd('node', ['--test', 'src/t.test.js']);
  assert.equal(asked.approval, 0);
  for (const v of ['SYNTHPASSPHRASECORRECTHORSEBATTERY', 'SYNTHDEPLOYPHRASEMAPLESYRUPCEDAR']) assert.equal(JSON.stringify(body).includes(v), false, v);
  // RC4: a plain-word value (DB_PASS=sunshine) is protected too.
  assert.equal(JSON.stringify(body).includes('sunshine'), false, 'sunshine');
});

test('B15 (C2) a withheld file under another name: a hard link, and .env renamed in history', async (t) => {
  const p = bare();
  const v = 'SYNTHHARDLINKVALUEMAPLESYRUP';
  p.w('.env', `DEPLOY_PHRASE=${v}\n`);
  try { fs.linkSync(path.join(p.root, '.env'), path.join(p.root, 'copy.txt')); } catch { t.skip('no hard links here'); return; }
  try { p.git('init', '-q'); } catch { t.skip('git not available'); return; }
  p.git('add', '-A');
  p.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x');
  const { cmd } = turn(p.root, { approve: 'run' });
  for (const args of [['grep', '-n', 'DEPLOY'], ['show', 'HEAD:copy.txt'], ['log', '-p']]) {
    assert.equal(JSON.stringify(await cmd('git', args)).includes(v), false, `git ${args.join(' ')}`);
  }
  const node = await cmd('node', ['-e', 'process.stdout.write(require("fs").readFileSync("copy.txt","utf8"))']);
  assert.equal(JSON.stringify(node).includes(v), false, 'an approved program reading the linked copy');
  // .env renamed to an ordinary name in history.
  const q = bare();
  const r = 'SYNTHRENAMEDVALUECEDARPLUM';
  q.w('.env', `PASSPHRASE=${r}\n`);
  q.git('init', '-q');
  q.git('add', '-A');
  q.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'one');
  q.git('mv', '.env', 'settings.txt');
  q.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'two');
  const { cmd: cmd2 } = turn(q.root);
  for (const args of [['log', '-p'], ['show', 'HEAD'], ['grep', '-n', 'PASSPHRASE'], ['diff', 'HEAD~1', 'HEAD']]) {
    assert.equal(JSON.stringify(await cmd2('git', args)).includes(r), false, `renamed: git ${args.join(' ')}`);
  }
});

test('B16 (C3) content in files the user excluded (files.exclude) is not sent by any command', async () => {
  const p = bare();
  const sentence = 'The acquisition of Northwind closes in March under codename Bluebird.';
  p.w('private/board.txt', `${sentence}\n`);
  p.w('src/t.test.js', printer("fs.readFileSync(p.join(__dirname, '..', 'private', 'board.txt'), 'utf8')"));
  const { cmd } = turn(p.root, { excludes: () => ({ filesExclude: { 'private/**': true }, searchExclude: {} }) });
  const body = await cmd('node', ['--test', 'src/t.test.js']);
  assert.equal(JSON.stringify(body).includes(sentence), false);
  assert.equal(JSON.stringify(body).includes('codename Bluebird'), false, 'nor a 12-character run of it');
});

test('B17 (C4) a shell task that reads a withheld file sends status only; wildcards make it unresolvable (fail closed)', async () => {
  const p = bare();
  p.w('.env.local', 'DEPLOY_PHRASE=SYNTHSHELLTASKVALUEPLUM\n');
  const read = win ? 'type .env.local' : 'cat .env.local';
  const glob = win ? 'type .env.l*' : 'cat .env.l*';
  const tasks = [read, glob].map((commandLine, i) => ({ name: `t${i}`, isBackground: false, dependsOn: false, execution: { kind: 'shell', commandLine, options: {} } }));
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv, fetchTasks: async () => tasks });
  const d = svc.beginTurn({ chatId: 'c', root: p.root, hasGrant: () => true, askApproval: async () => 'run', askOutputSharing: async () => 'share', onRunning: () => undefined, signal: new AbortController().signal });
  for (const label of ['t0', 't1']) {
    const body = JSON.parse((await d.runTask(label)).raw);
    assert.equal(JSON.stringify(body).includes('SYNTHSHELLTASKVALUEPLUM'), false, label);
    assert.match(body.output || '', /not sent/, `${label}: ${JSON.stringify(body)}`);
  }
});

test('B18 (C5) credentials inside addresses are masked, whatever their shape (git remote -v)', async (t) => {
  const p = bare();
  try { p.git('init', '-q'); } catch { t.skip('git not available'); return; }
  p.git('remote', 'add', 'a', 'https://a1b2c3d4e5f6a7b8c9d0e1f2@git.example.com/x.git');
  p.git('remote', 'add', 'b', 'https://SYNTHTOKENORANGEMARBLEPLUM@git.example.com/x.git');
  p.git('remote', 'add', 'c', 'https://ci' + ':S3cretPass@git.example.com/x.git');
  const { cmd } = turn(p.root);
  const body = await cmd('git', ['remote', '-v']);
  for (const v of ['a1b2c3d4e5f6a7b8c9d0e1f2', 'SYNTHTOKENORANGEMARBLEPLUM', 'S3cretPass']) assert.equal(JSON.stringify(body).includes(v), false, v);
  assert.match(body.stdout, /https:\/\/\[credentials removed\]@git\.example\.com/);
});

test('B19 (C7) a project the index cannot cover completely: output is withheld (fail closed), the run is unchanged', async () => {
  const p = bare();
  p.w('big/.env.large', `API_KEY=${'x'.repeat(10)}\n${'#'.repeat(1100 * 1024)}\n`);
  p.w('src/t.test.js', printer("'hello'"));
  const { cmd, asked } = turn(p.root);
  const body = await cmd('node', ['--test', 'src/t.test.js']);
  assert.equal(asked.approval, 0, 'still Class A');
  assert.equal(body.status, 'succeeded');
  assert.match(body.output, /not sent: Kenlith could not check this project completely \(a withheld file larger than Kenlith checks\)/);
});

test('B20 (strict, RC4) a .env value is removed from command output even where an ordinary file also holds it', async (t) => {
  const p = bare();
  p.w('.env', 'DATABASE_URL=postgres://localhost:5432/appdb\nAPI_URL=https://api.example.com/v1\n');
  p.w('src/db.js', 'const url = "postgres://localhost:5432/appdb";\nconst api = "https://api.example.com/v1";\n');
  try { p.git('init', '-q'); } catch { t.skip('git not available'); return; }
  p.git('add', '-A');
  p.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x');
  const { cmd } = turn(p.root);
  const body = await cmd('git', ['grep', '-n', 'localhost']);
  assert.equal(body.stdout.includes('postgres://localhost:5432/appdb'), false);
  assert.match(body.stdout, /src\/db\.js:1:const url = "\[redacted\]";/);
});

test('B21 (F2) ordinary lines with secret-sounding words stay; a secret-looking value is masked, not its line', () => {
  for (const line of ['ok 12 - resolves the auth: header correctly', 'Setting signature=sha256 in the request header', 'keyboard layout: qwerty']) {
    assert.equal(sanitize(line, { env: {} }).text, line, line);
  }
  assert.equal(sanitize('cache-key: build-linux-node20', { env: {} }).text, 'cache-key: [redacted]');
});

test('B22 the last check withholds command results when it does not know their project (fail closed)', () => {
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv });
  const input = [
    { type: 'function_call', call_id: 'c1', name: 'project_run_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ status: 'succeeded', stdout: 'SYNTH_NOROOT_zz11yy22xx33ww44' }) }
  ];
  const out = svc.outboundFilter(input);
  assert.equal(JSON.stringify(out).includes('SYNTH_NOROOT'), false);
  assert.match(out[1].output, /not sent: Kenlith could not check this command result/);
});

// ---------- re-review of RC3 (round 2) ----------

test('B23 (C1) short values under secret-named keys (a 5-character password, a PIN) are protected', async () => {
  const p = bare();
  p.w('.env', 'DB_PASS=k9#x2\nDOOR_PIN=48213\n');
  p.w('src/t.test.js', printer("fs.readFileSync(p.join(__dirname, '..', '.env'), 'utf8')"));
  const { cmd } = turn(p.root);
  const body = await cmd('node', ['--test', 'src/t.test.js']);
  for (const v of ['k9#x2', '48213']) assert.equal(JSON.stringify(body).includes(v), false, v);
});

test('B24 (C3) a folder exclusion (**/private) covers its files: a test printing one, a program given one, a shell task reading one', async () => {
  const p = bare();
  const sentence = 'Quarterly board minutes: the Fabrikam merger price is confidential.';
  p.w('private/board.txt', `${sentence}\n`);
  p.w('src/t.test.js', printer("fs.readFileSync(p.join(__dirname, '..', 'private', 'board.txt'), 'utf8')"));
  const excludes = () => ({ filesExclude: { '**/private': true }, searchExclude: {} });
  const { cmd } = turn(p.root, { approve: 'run', excludes });
  const viaTest = await cmd('node', ['--test', 'src/t.test.js']);
  const viaArg = await cmd('node', ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', 'private/board.txt']);
  assert.equal(JSON.stringify(viaTest).includes('Fabrikam merger'), false, 'printed by a test');
  assert.match(viaArg.output, /not sent: it reads a file Kenlith withholds/, 'named as an argument');
  const tasks = [{ name: 't', isBackground: false, dependsOn: false, execution: { kind: 'shell', commandLine: win ? 'type private\\board.txt' : 'cat private/board.txt', options: {} } }];
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv, excludes, fetchTasks: async () => tasks });
  const d = svc.beginTurn({ chatId: 'c', root: p.root, hasGrant: () => true, askApproval: async () => 'run', askOutputSharing: async () => 'share', onRunning: () => undefined, signal: new AbortController().signal });
  const viaTask = JSON.parse((await d.runTask('t')).raw);
  assert.match(viaTask.output || '', /not sent/, 'a shell task');
  assert.equal(JSON.stringify(viaTask).includes('Fabrikam merger'), false);
});

test('B25 (C4) cmd escapes (type ^.env.local) do not hide a withheld file name', async () => {
  const p = bare();
  p.w('.env.local', 'X=1\n');
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv });
  const { namesWithheldFile } = require('../src/exec-boundary');
  const isWithheld = withheldMatcher({});
  void svc;
  for (const shellText of ['type ^.env.local', 'type .en^v.local', 'more < .env.local']) {
    assert.match(namesWithheldFile({ name: 'cmd', args: [], shellText, cwd: p.root }, p.root, isWithheld) || '', /withholds/, shellText);
  }
});

test('B26 (N1) an address exempt only if an ordinary file the read tools would send holds it; secret-looking addresses never are', () => {
  const p = bare();
  const hook = 'https://hooks.example.com/services/T0A1B2C3/B4D5E6F7/Zx9Kq2Lm8Np4Rt6Vw0Yb3';
  p.w('.env', `SLACK_WEBHOOK=${hook}\nAPI_URL=https://api.example.com/v1\n`);
  p.w('docs/ops.md', `Webhook: ${hook}\npassword=hunter2hunter2\n`); // the read tools refuse this file (credential content)
  p.w('src/api.js', 'const api = "https://api.example.com/v1";\n');
  const index = buildIndex(p.root, { settings: {} });
  assert.ok(index.values.includes(hook), 'the webhook address stays protected');
  assert.ok(index.values.includes('https://api.example.com/v1'), 'RC4: no exemption for an address an ordinary file also holds');
});

test('B27 a repository configured to show signatures cannot start a program through Kenlith (its own history read, and Class A git log or show)', async (t) => {
  const p = bare();
  try { p.git('init', '-q'); } catch { t.skip('git not available'); return; }
  p.w('.env', 'API_KEY=SYNTH_SIG_aaaaaaaa1111\n');
  p.git('add', '-A');
  p.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x');
  const marker = path.join(p.root, 'GPG_RAN.txt');
  const prog = path.join(p.root, win ? 'gpg.cmd' : 'gpg.sh');
  fs.writeFileSync(prog, win ? `@echo ran> "${marker}"\r\n@exit /b 1\r\n` : `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`, { mode: 0o755 });
  p.git('config', 'log.showSignature', 'true');
  p.git('config', 'gpg.program', prog.split(path.sep).join('/'));
  const { cmd } = turn(p.root);
  await cmd('git', ['log', '-1']);
  await cmd('git', ['show', 'HEAD', '--stat']);
  assert.equal(fs.existsSync(marker), false, 'no program ran');
});

test('B28 (strict, RC4) a line of an excluded file is removed from output even where a source file holds the same line; git never reads the excluded copy', async (t) => {
  const p = bare();
  const line = 'export function computeInvoiceTotal(items) {';
  p.w('src/invoice.js', `${line}\n  return items.length;\n}\n`);
  p.w('out/invoice.js', `${line}\n  return items.length;\n}\n`);
  try { p.git('init', '-q'); } catch { t.skip('git not available'); return; }
  p.git('add', '-A');
  p.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x');
  const { cmd } = turn(p.root, { excludes: () => ({ filesExclude: { 'out/**': true }, searchExclude: {} }) });
  const body = await cmd('git', ['grep', '-n', 'computeInvoiceTotal']);
  assert.equal(body.stdout.includes('export function computeInvoiceTotal(items) {'), false);
  assert.match(body.stdout, /src\/invoice\.js:1:\[redacted\]/);
  assert.doesNotMatch(body.stdout, /out\/invoice\.js/, 'the excluded copy itself is not read by git');
});

// ---------- review round 3 ----------

test('B29 short .env values and the pw key name are protected', async () => {
  const p = bare();
  p.w('.env', 'ADMIN_PW=q7#zr\nCODE=x9Q2\n');
  p.w('src/t.test.js', printer("fs.readFileSync(p.join(__dirname, '..', '.env'), 'utf8')"));
  const { cmd } = turn(p.root);
  const body = await cmd('node', ['--test', 'src/t.test.js']);
  for (const v of ['q7#zr', 'x9Q2']) assert.equal(JSON.stringify(body).includes(v), false, v);
});

test('B30 signature placeholders (--format=%G?) cannot start a repository signing program; Kenlith\'s history read cannot either', async (t) => {
  const p = bare();
  try { p.git('init', '-q'); } catch { t.skip('git not available'); return; }
  p.w('a.txt', 'x');
  p.w('.env', 'API_KEY=SYNTH_SIGFMT_aaaa1111\n');
  p.git('add', '-A');
  p.git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x');
  const tree = p.git('rev-parse', 'HEAD^{tree}').trim();
  const signed = `tree ${tree}\nauthor a <a@b.c> 1 +0000\ncommitter a <a@b.c> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const sha = require('node:child_process').spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: p.root, input: signed }).stdout.toString().trim();
  p.git('update-ref', 'refs/heads/signed', sha);
  const marker = path.join(p.root, 'SIGN_RAN.txt');
  const prog = path.join(p.root, win ? 'g.cmd' : 'g.sh');
  fs.writeFileSync(prog, win ? `@echo ran> "${marker}"\r\n@exit /b 1\r\n` : `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`, { mode: 0o755 });
  p.git('config', 'gpg.program', prog.split(path.sep).join('/'));
  p.git('config', 'log.showSignature', 'true');
  const { cmd, asked } = turn(p.root);
  await cmd('git', ['log', '--format=%G? %GG %H', '--all']);
  await cmd('git', ['show', '--format=%G?', 'signed']);
  assert.equal(asked.approval, 0, 'still Class A');
  assert.equal(fs.existsSync(marker), false, 'no signing program ran');
});

test('B31 ordinary configuration and routing lines are not treated as secrets (read path and output)', async () => {
  const { hasSensitiveText } = require('../src/sensitive-text');
  const lines = [
    'const tokenUrl = "https://login.example.test/oauth2/v2.0/token";', "authEndpoint: '/api/v1/login',", 'sessionTimeout: 86400000,',
    'cacheKey: "invoice-list-v2",', "privateRoute: '/admin/settings',", 'certPath: "./certs/dev-local.pem",', 'seed: "demo-data-2024",',
    'const keyName = "user_profile:" + id;', '"integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+ODA7zoYYPI8sUxvGr4lWBDl0E9YBY1gzb8mcxEw==",',
    '✔ seed: demo-data-2024 loaded'
  ];
  for (const line of lines) {
    assert.equal(hasSensitiveText(line), false, `read path: ${line}`);
    // (A quoted absolute path such as '/api/v1/login' is replaced in output by the
    // RC1 outside-path rule: a pre-existing, conservative change, not RC3.)
    if (!/['"]\//.test(line)) assert.equal(sanitize(line, { env: {} }).text, line, `output: ${line}`);
  }
  for (const line of ['password: "s3cr3t!"', 'apiKey: "Zq8Lr2Vt6Xp0Nw4Ys9Ub3"', 'clientSecret = "abcDEF123456ghiJKL"']) {
    assert.equal(hasSensitiveText(line), true, line);
  }
});

test('B32 read path: an ordinary file holding a copy of an .env value is not sent by the read tools or as an excerpt', async () => {
  const p = bare();
  const v = 'SYNTHCOPIEDVALUEPLUM';
  p.w('.env', `DEPLOY_PHRASE=${v}\n`);
  p.w('src/config.js', `module.exports = { phrase: "${v}" }; // deploy config\n`);
  p.w('src/other.js', 'module.exports = { deploy: true }; // deploy config\n');
  const { ProjectContextService } = require('../src/project-context');
  const { indexFor } = require('../src/exec-boundary');
  const svc = new ProjectContextService({
    getWindowContext: () => ({ kind: 'project', folderPath: p.root, label: 'demo', available: true }),
    workspace: { excludes: () => ({}) },
    withheldValues: (root, settings) => indexFor(root, settings).values
  });
  const r = await svc.select({ query: 'deploy config phrase' });
  assert.ok(!r.excerpts.some((e) => e.relPath === 'src/config.js'), JSON.stringify(r.excerpts.map((e) => e.relPath)));
  assert.ok(r.withheld.some((w) => w.relPath === 'src/config.js' && w.reason === 'credential-content'));
  const turnTools = await svc.createTurn();
  const outputs = await turnTools.runRound([{ callId: 'c1', name: 'project_read_file', arguments: JSON.stringify({ path: 'src/config.js', start_line: null, end_line: null }) }], {});
  assert.equal(JSON.stringify(outputs).includes(v), false);
  assert.match(JSON.stringify(outputs), /credential|withheld|sensitive/i);
});

// ---------- review round 4 ----------

test('B33 numbers and other literals under strong names are secrets (read path and output); weak names still need a random-looking value', () => {
  const { hasSensitiveText } = require('../src/sensitive-text');
  for (const line of ['pin: 482913,', 'password: 12345678,', 'secret = "/var/run/token-file"']) {
    assert.equal(hasSensitiveText(line), true, line);
    assert.notEqual(sanitize(line, { env: {} }).text, line, line);
  }
  for (const line of ['sessionTimeout: 86400000,', 'cacheKey: "invoice-list-v2",']) assert.equal(hasSensitiveText(line), false, line);
});

test('B34 development defaults and template placeholders do not hide ordinary files or output', async () => {
  const p = bare();
  p.w('.env', 'ADMIN_PASSWORD=admin\nDB_PASSWORD=postgres\nAPI_KEY=Zq8Lr2Vt6Xp0Nw4Ys9Ub3\n');
  p.w('.env.example', 'SMTP_PASSWORD=password\nAPI_KEY=your_api_key_here\n');
  p.w('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n');
  p.w('src/login.js', 'label("Enter your password"); route("/admin");\n');
  const index = buildIndex(p.root, { settings: {} });
  // RC4: values of the real .env are protected (admin, postgres); a template's placeholders are not (the read tools share templates).
  for (const v of ['admin', 'postgres']) assert.ok(index.values.includes(v), v);
  for (const v of ['password', 'your_api_key_here']) assert.equal(index.values.includes(v), false, v);
  assert.ok(index.values.includes('Zq8Lr2Vt6Xp0Nw4Ys9Ub3'), 'a real-looking key stays protected');
  const { readContained } = require('../src/workspace-safety');
  for (const rel of ['docker-compose.yml', 'src/login.js']) assert.equal((await readContained(p.root, rel, { sending: true, withheldValues: index.readValues })).ok, true, rel);
  const line = 'ok 3 - admin can reach the postgres dashboard and reset a password';
  // In command output they are removed as whole words; the files above stay readable (read path: specific values only).
  assert.equal(guard(line, { index }).text, 'ok 3 - [redacted] can reach the [redacted] dashboard and reset a password');
});

test('B35 a short withheld value under an ordinary key is matched as a whole word only (output and read path)', async () => {
  const p = bare();
  p.w('.env', 'DB_CODE=k9#x2\n');
  p.w('src/a.js', 'const v = "ak9#x2b"; // not the value\n');
  p.w('src/b.js', 'login(user, "k9#x2");\n');
  const index = buildIndex(p.root, { settings: {} });
  assert.equal(guard('x k9#x2 y', { index }).text, 'x [redacted] y');
  assert.equal(guard('ak9#x2b', { index }).text, 'ak9#x2b');
  const { readContained } = require('../src/workspace-safety');
  assert.equal((await readContained(p.root, 'src/a.js', { sending: true, withheldValues: index.readValues })).ok, true);
  assert.equal((await readContained(p.root, 'src/b.js', { sending: true, withheldValues: index.readValues })).ok, false);
});

test('B36 a name that says the value is a location (secretsDir, passwordPolicyUrl, credentialsPath) keeps paths and plain addresses readable', () => {
  const { hasSensitiveText } = require('../src/sensitive-text');
  for (const line of ['secretsDir: "./secrets",', 'const passwordPolicyUrl = "https://example.test/policy";', 'credentialsPath: "~/.config/app/creds.json",']) assert.equal(hasSensitiveText(line), false, line);
  for (const line of ['password: "/var/run/token-file"', 'secret = "https://u' + ':p@x.test/a"']) assert.equal(hasSensitiveText(line), true, line);
});
