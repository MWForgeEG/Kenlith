'use strict';

// Kenlith 0.7.0 RC5 (Owner, 2026-11-11; DEC-PLANCHAT-038): two edges of the
// secret-value boundary closed for values under a sensitive key.
// - 1 to 3 characters (PASSWORD=abc, PIN=123, TOKEN=x7): output containing
//   one is withheld whole (fail closed), never globally redacted; the run
//   itself and its class are unchanged.
// - 4 to 7 characters (PASSWORD=horse): removed inside longer tokens too
//   (xxhorse99). Under an ordinary key, RC4's whole-word rule stays.
// Synthetic secrets only. Each run is a safe Class A process (node --test).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ExecutionService } = require('../src/exec-service');
const { ExecutionStore } = require('../src/exec-store');
const { buildIndex, guard } = require('../src/exec-boundary');
const { isSensitiveKeyName } = require('../src/sensitive-text');

const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const UNSAFE = 'could not be safely sanitized';

// Runs `node --test` on a test that prints `lines` (stdout) and `errLines` (stderr).
async function run(envText, lines, { errLines = [], grant = true, share = 'withhold', executable = 'node', args = ['--test', 'src/p.test.js'] } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  fs.writeFileSync(path.join(root, '.env'), envText);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"p","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'p.test.js'), [
    "require('node:test')('p', () => {",
    ...lines.map((l) => `  console.log(${JSON.stringify(l)});`),
    ...errLines.map((l) => `  console.error(${JSON.stringify(l)});`),
    '});'
  ].join('\n'));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'));
  const svc = new ExecutionService({ store: new ExecutionStore(storeDir), hostEnv });
  const asked = { approval: 0, sharing: 0 };
  const logged = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(keep)) console[k] = (...a) => { logged.push(a.join(' ')); };
  let raw;
  try {
    const draft = svc.beginTurn({ chatId: 'c', root, hasGrant: () => grant, askApproval: async () => { asked.approval += 1; return 'decline'; }, askOutputSharing: async () => { asked.sharing += 1; return share; }, onRunning: () => undefined, signal: new AbortController().signal });
    raw = (await draft.runCommand({ executable, args, cwd: null, timeoutSeconds: null, env: [], purpose: 't' })).raw;
  } finally {
    Object.assign(console, keep);
  }
  const last = svc.outboundFilter([{ type: 'function_call', call_id: 'c1', name: 'project_run_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: raw }])[1].output;
  const storePath = path.join(storeDir, 'executions.json');
  const stored = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : '';
  return { root, svc, asked, logged: logged.join('\n'), raw, last, stored, body: JSON.parse(raw) };
}
const withheldShort = (r) => typeof r.body.output === 'string' && r.body.output.includes(UNSAFE) && r.body.stdout === undefined;

test('R0 the sensitive-key list comes from the existing vocabulary and covers the Owner list', () => {
  for (const k of ['PASSWORD', 'PASS', 'PASSWD', 'PWD', 'PIN', 'TOKEN', 'SECRET', 'API_KEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'ACCOUNT_KEY', 'CREDENTIAL', 'DB_PASSWORD', 'dbPassword', 'GITHUB_TOKEN', 'CLIENT_SECRET', 'apiKey']) assert.equal(isSensitiveKeyName(k), true, k);
  for (const k of ['TEAM_WORD', 'PORT', 'DEBUG', 'CACHE_KEY', 'SORT_KEY', 'SESSION_TIMEOUT', 'AUTHOR', 'NODE_ENV', 'HOST']) assert.equal(isSensitiveKeyName(k), false, k);
});

for (const [n, env, value] of [['R1', 'PASSWORD=abc\n', 'abc'], ['R2', 'PIN=123\n', '123'], ['R3', 'TOKEN=x7\n', 'x7']]) {
  test(`${n} ${env.trim()}: output containing the value is not sent, not stored, and not in the result after the last check; no approval`, async () => {
    const r = await run(env, [`the value is ${value} today`, `joined: zz${value}99`], { errLines: [`stderr ${value}`] });
    assert.equal(r.asked.approval, 0, 'node --test stays Class A: no card');
    assert.equal(r.body.status, 'succeeded', 'the command itself ran');
    assert.ok(withheldShort(r), r.raw.slice(0, 400));
    assert.equal(r.raw.includes(value), false, 'not in the result sent');
    assert.equal(r.last.includes(value), false, 'not after the last check');
    const rec = JSON.parse(r.stored);
    const runs = Array.isArray(rec) ? rec : (rec.executions || Object.values(rec));
    assert.equal(JSON.stringify(runs).includes(`${value} today`), false, 'not in the stored run record');
    assert.equal(r.logged.includes(value), false, 'not logged');
  });
}

test('R4 a very short sensitive value is never globally redacted: output without it flows untouched; output with it is withheld whole', async () => {
  const p = await run('PASSWORD=abc\n', ['all tests passed in the alphabet module']);
  assert.equal(p.body.stdout.includes('all tests passed in the alphabet module'), true, p.raw.slice(0, 300));
  assert.equal(p.body.stdout.includes('[redacted]'), false);
  const index = buildIndex(p.root, { settings: {} });
  const g = guard('abcdef abc', { index });
  assert.equal(g.text, 'abcdef abc', 'the guard does not replace a 1-3 character value');
  assert.equal(g.counts.unsafeShort, 1, 'it marks the text as unsafe to send instead');
  // Its base64 and hex are treated the same way.
  assert.equal(guard(Buffer.from('abc').toString('base64'), { index }).counts.unsafeShort, 1);
  assert.equal(guard(Buffer.from('abc').toString('hex'), { index }).counts.unsafeShort, 1);
});

test('R5 PASSWORD=horse is removed inside xxhorse99 (stdout and stderr), and from the stored record', async () => {
  const r = await run('PASSWORD=horse\n', ['token xxhorse99 end', 'horse'], { errLines: ['err:horseshoe'] });
  assert.equal(r.asked.approval, 0);
  assert.equal(r.raw.includes('horse'), false, r.raw.slice(0, 400));
  assert.equal(r.last.includes('horse'), false);
  assert.equal(r.stored.includes('horse'), false);
  assert.equal(r.body.stdout.includes('xx[redacted]99'), true);
});

test('R6 TOKEN=abcd is removed when joined to other characters, and in its base64 form', async () => {
  const b64 = Buffer.from('abcd').toString('base64');
  const r = await run('TOKEN=abcd\n', ['id=zzabcd42', `b64 ${b64}`]);
  assert.equal(r.raw.includes('abcd'), false, r.raw.slice(0, 400));
  assert.equal(r.raw.includes(b64), false);
  assert.equal(r.stored.includes('abcd'), false);
});

test('R7 TEAM_WORD=horse keeps the whole-word rule: horse is removed, horseshoe and seahorses stay', async () => {
  const r = await run('TEAM_WORD=horse\n', ['a horse', 'horseshoe and seahorses']);
  assert.equal(r.body.stdout.includes('a [redacted]'), true, r.raw.slice(0, 400));
  assert.equal(r.body.stdout.includes('horseshoe and seahorses'), true);
});

test('R8 true, false and short numbers under ordinary keys stay ordinary text', async () => {
  const r = await run('DEBUG=true\nVERBOSE=false\nPORT=3000\nRETRIES=5\n', ['debug true verbose false', 'listening on 3000 with 5 retries']);
  assert.equal(r.body.stdout.includes('debug true verbose false'), true, r.raw.slice(0, 400));
  assert.equal(r.body.stdout.includes('listening on 3000 with 5 retries'), true);
  assert.equal(r.body.output, undefined);
});

test('R9 the same values under sensitive keys are protected (4+ characters removed; 1-3 characters withhold the output)', async () => {
  const a = await run('PASSWORD=true\nPIN=3000\n', ['flag true', 'port 3000 and x3000y']);
  assert.equal(a.raw.includes('true'), false, a.raw.slice(0, 400));
  assert.equal(a.raw.includes('3000'), false);
  const b = await run('PIN=5\n', ['5 retries']);
  assert.ok(withheldShort(b), b.raw.slice(0, 300));
  assert.equal(b.raw.includes('5 retries'), false);
});

test('R10 ordinary test output flows (a secret file present, no short sensitive value in the output)', async () => {
  const r = await run('PASSWORD=horse\nAPI_KEY=Zq8Lr2Vt6Xp0Nw4Ys9Ub3\n', ['parser handles empty input', 'parser handles unicode']);
  assert.equal(r.body.status, 'succeeded');
  assert.equal(r.body.output, undefined);
  assert.equal(r.body.stdout.includes('parser handles empty input'), true, r.raw.slice(0, 400));
  assert.equal(r.body.stdout.includes('parser handles unicode'), true);
  assert.equal(r.stored.includes('parser handles unicode'), true, 'ordinary output is stored as before');
});

test('R11 Class A stays no-prompt with a short sensitive value present (withheld output adds no card)', async () => {
  const r = await run('PIN=123\n', ['value 123']);
  assert.equal(r.asked.approval, 0);
  assert.equal(r.asked.sharing, 0, 'no sharing card either: the output is withheld, not offered');
  assert.ok(withheldShort(r));
});

test('R12 Class B still needs its card and Class C is still refused (unchanged by RC5)', async () => {
  const b = await run('PIN=123\n', [], { executable: 'npm', args: ['install'] });
  assert.equal(b.asked.approval, 1, b.raw.slice(0, 300));
  const c = await run('PIN=123\n', [], { executable: 'npm', args: ['publish'] });
  assert.equal(c.asked.approval, 0, c.raw.slice(0, 300));
  assert.notEqual(c.body.status, 'succeeded');
});

test('R13 project sharing allowed (and a Share answer) does not override the protection', async () => {
  const r = await run('PIN=123\nPASSWORD=horse\n', ['value 123 and xxhorse99'], { grant: true, share: 'share' });
  assert.ok(withheldShort(r), r.raw.slice(0, 300));
  assert.equal(r.raw.includes('123'), false);
  assert.equal(r.raw.includes('horse'), false);
});

test('R14 withheld output is not persisted: the stored run keeps the status and reason, not the text', async () => {
  const r = await run('PIN=123\n', ['value 123', 'other ordinary line']);
  assert.equal(r.stored.includes('123'), false);
  assert.equal(r.stored.includes('other ordinary line'), false);
  assert.equal(r.stored.includes(UNSAFE), true);
});

test('R15 nothing is logged by the execution path (no protected value in any log)', async () => {
  const r = await run('PASSWORD=horse\nPIN=123\n', ['xxhorse99 123']);
  assert.equal(r.logged, '', `logged: ${r.logged.slice(0, 200)}`);
});

test('R16 the last check before a request leaves repeats the protection for a result produced before the value existed', async () => {
  const r = await run('DEBUG=true\n', ['nothing secret yet']);
  fs.writeFileSync(path.join(r.root, '.env'), 'PASSWORD=horse\nPIN=123\n');
  const mk = (stdout) => [{ type: 'function_call', call_id: 'c1', name: 'project_run_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ tool: 'project_run_command', status: 'succeeded', stdout, stderr: '' }) }];
  const longer = r.svc.outboundFilter(mk('id xxhorse99'))[1].output;
  assert.equal(longer.includes('horse'), false, longer);
  const short = r.svc.outboundFilter(mk('pin 123 here'))[1].output;
  assert.equal(short.includes('123'), false, short);
  assert.equal(short.includes(UNSAFE), true);
});
