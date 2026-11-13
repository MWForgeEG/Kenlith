'use strict';

// Kenlith 0.7.0 RC4 question (Owner, 2026-11-11): is every value of a secret
// file removed from command output deterministically? Synthetic secret files,
// a safe synthetic Class A process (node --test) printing the value directly
// and inside ordinary text, to stdout and stderr. Each case reads the result
// exactly as it would be sent, the run's stored record, and the result after
// the last check before a request leaves (outboundFilter).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ExecutionService } = require('../src/exec-service');
const { ExecutionStore } = require('../src/exec-store');

const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

// [case, .env text, the value, its key]
const CASES = [
  ['PASSWORD=horse', 'PASSWORD=horse\n', 'horse'],
  ['PASSWORD="horse"', 'PASSWORD="horse"\n', 'horse'],
  ['password: horse', 'password: horse\n', 'horse'],
  ['a short secret (4 characters)', 'PIN=7x2q\n', '7x2q'],
  ['a plain value under an ordinary name', 'TEAM_WORD=marigold\n', 'marigold'],
  ['a value equal to its key name', 'PASSWORD=password\n', 'password'],
  ['a commented-out old value', '# PASSWORD=oldhorse\nPASSWORD=newstallion\n', 'oldhorse'],
  ['a long random value', 'API_KEY=Zq8Lr2Vt6Xp0Nw4Ys9Ub3\n', 'Zq8Lr2Vt6Xp0Nw4Ys9Ub3']
];

async function run(envText, value) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  fs.writeFileSync(path.join(root, '.env'), envText);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'p.test.js'), [
    "const v = process.argv.length && " + JSON.stringify(value) + ";",
    "require('node:test')('p', () => {",
    '  console.log(v);',
    "  console.log('the value is ' + v + ' today');",
    "  console.error('stderr: ' + v);",
    '});'
  ].join('\n'));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'));
  const svc = new ExecutionService({ store: new ExecutionStore(storeDir), hostEnv });
  const asked = { n: 0 };
  const draft = svc.beginTurn({ chatId: 'c', root, hasGrant: () => true, askApproval: async () => { asked.n += 1; return 'decline'; }, askOutputSharing: async () => 'withhold', onRunning: () => undefined, signal: new AbortController().signal });
  const raw = (await draft.runCommand({ executable: 'node', args: ['--test', 'src/p.test.js'], cwd: null, timeoutSeconds: null, env: [], purpose: 't' })).raw;
  const last = svc.outboundFilter([{ type: 'function_call', call_id: 'c1', name: 'project_run_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: raw }])[1].output;
  const stored = fs.readFileSync(path.join(storeDir, 'executions.json'), 'utf8');
  const body = JSON.parse(raw);
  const word = new RegExp(`(?<![A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}(?![A-Za-z0-9])`);
  return { root, asked: asked.n, status: body.status, withheld: Boolean(body.output), sent: word.test(raw), afterLastCheck: word.test(last), stored: word.test(stored), raw };
}

for (const [name, envText, value] of CASES) {
  test(`V ${name}: the value never leaves in command output (stdout, inside text, stderr); not in the run record`, async () => {
    const r = await run(envText, value);
    assert.equal(r.asked, 0, 'node --test stays Class A');
    assert.equal(r.sent, false, `sent: ${r.raw.slice(0, 300)}`);
    assert.equal(r.afterLastCheck, false, 'after the last check');
    assert.equal(r.stored, false, 'in the stored run record');
  });
}

test('V a line from a user-excluded file, printed directly and inside ordinary text, never leaves', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  const line = 'Board code word: copper lantern';
  fs.mkdirSync(path.join(root, 'private'));
  fs.writeFileSync(path.join(root, 'private', 'notes.txt'), `${line}\n`);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'p.test.js'), `require('node:test')('p', () => { const v = ${JSON.stringify(line)}; console.log(v); console.log('we said ' + v + ' twice'); });\n`);
  const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-'))), hostEnv, excludes: () => ({ filesExclude: { '**/private': true }, searchExclude: {} }) });
  const d = svc.beginTurn({ chatId: 'c', root, hasGrant: () => true, askApproval: async () => 'decline', askOutputSharing: async () => 'withhold', onRunning: () => undefined, signal: new AbortController().signal });
  const raw = (await d.runCommand({ executable: 'node', args: ['--test', 'src/p.test.js'], cwd: null, timeoutSeconds: null, env: [], purpose: 't' })).raw;
  assert.equal(raw.includes('copper lantern'), false, raw.slice(0, 300));
});

test('V RC5: a 4-to-7-character value under a sensitive key is removed inside longer words too; under an ordinary key only as a whole word', async () => {
  const r = await run('PASSWORD=horse\n', 'horse');
  assert.equal(r.sent, false);
  const { buildIndex, guard } = require('../src/exec-boundary');
  const index = buildIndex(r.root, { settings: {} });
  assert.equal(guard('a horse, the horse.', { index }).text, 'a [redacted], the [redacted].');
  assert.equal(guard('horseshoe', { index }).text, '[redacted]shoe');
  const r2 = await run('TEAM_WORD=horse\n', 'horse');
  assert.equal(r2.sent, false);
  const index2 = buildIndex(r2.root, { settings: {} });
  assert.equal(guard('horseshoe', { index: index2 }).text, 'horseshoe', 'documented: an ordinary-key value joined to letters or digits is not matched');
});
