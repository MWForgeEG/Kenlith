'use strict';

// F-4 (WP-02): token renewal across processes with the order of steps fixed
// by barriers instead of timing. Each worker is a separate Node process
// running AuthService (test/helpers/auth-worker.js); a worker can pause its
// refresh request before it is sent or after its reply arrives until the test
// releases it. Synthetic credentials and a local OAuth server only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/fake-vscode');
const { storedCredentials } = require('./helpers/fake-openai');
const { startOAuthServer } = require('./helpers/oauth-server');
const { runWorker } = require('./helpers/processes');

const KEY = 'planChat.credentials.v1';

let server;
test.before(async () => { server = await startOAuthServer(); });
test.after(() => server.close());
test.beforeEach(() => {
  Object.assign(server.state, {
    valid: new Set(['synthetic-refresh-0']),
    retired: new Set(),
    revoked: [],
    refreshes: [],
    issued: 0,
    delayMs: 0,
    mode: 'normal'
  });
});

// An expired record with a generation, as 0.2.0 writes it, and a journal.
function setup() {
  const storageDir = makeTempDir();
  const secretsFile = path.join(makeTempDir(), 'secrets.json');
  const barrierDir = makeTempDir();
  const record = storedCredentials({ expiresAt: Date.now() - 1000, generation: 1 });
  fs.writeFileSync(secretsFile, JSON.stringify({ [KEY]: [{ value: JSON.stringify(record), at: 0, pid: 0 }] }));
  fs.writeFileSync(path.join(storageDir, 'session-state.json'), JSON.stringify({ version: 1, generation: 1, signedOut: false, updatedAt: new Date().toISOString() }));
  return { storageDir, secretsFile, barrierDir };
}

const worker = (env, spec) => runWorker('auth-worker.js', { storageDir: env.storageDir, secretsFile: env.secretsFile, port: server.port, ...spec });
const outcome = (run) => {
  assert.ok(run.result && !run.result.fatal, `worker failed: ${run.stdout}${run.stderr}`);
  return run.result.outcomes[0];
};
const latestSecret = (env) => {
  const value = JSON.parse(fs.readFileSync(env.secretsFile, 'utf8'))[KEY].at(-1).value;
  return value === null ? undefined : JSON.parse(value);
};
const journal = (env) => JSON.parse(fs.readFileSync(path.join(env.storageDir, 'session-state.json'), 'utf8'));

async function arrived(env, label, timeoutMs = 20_000) {
  const file = path.join(env.barrierDir, `${label}.arrived`);
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${label} never reached its barrier`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const release = (env, label) => fs.writeFileSync(path.join(env.barrierDir, `${label}.release`), '1');

test('F4-1 the WP-08 symptom: a transient EPERM from the secrets stand-in, unretried, leaves token undefined; retried, the token is correct', async () => {
  const env = setup();
  const bare = outcome(await worker(env, { label: 'bare', injectSecretErrors: 1, noSecretRetry: true, actions: [{ do: 'token' }] }));
  assert.equal(bare.ok, false);
  assert.equal(bare.token, undefined, 'exactly what concurrency-auth.test.js:103 saw');
  assert.match(bare.message, /EPERM/);
  assert.equal(server.state.refreshes.length, 0, 'it failed before any refresh: nothing about the session changed');

  const retried = outcome(await worker(env, { label: 'retried', injectSecretErrors: 3, actions: [{ do: 'token' }] }));
  assert.equal(retried.ok, true, retried.message);
  assert.equal(retried.token, 'access#1');
  assert.equal(server.state.refreshes.length, 1);
});

test('F4-2 a refresh in progress in one process: another process waits for it and uses its token; one refresh', async () => {
  const env = setup();
  const a = worker(env, { label: 'A', barrierDir: env.barrierDir, barrier: 'after', actions: [{ do: 'token' }] });
  await arrived(env, 'A');
  // A holds the session lock with its reply in hand; B must not refresh too.
  const b = worker(env, { label: 'B', actions: [{ do: 'token' }] });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(server.state.refreshes.length, 1, 'B has not presented the token A is renewing');
  release(env, 'A');
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(outcome(ra).token, 'access#1');
  assert.equal(outcome(rb).token, 'access#1');
  assert.equal(outcome(rb).ms >= 700, true, 'B waited for A');
  assert.deepEqual(server.state.refreshes.map((entry) => [entry.token, entry.result]), [['synthetic-refresh-0', 'rotated']]);
  assert.equal(latestSecret(env).generation, 2);
});

test('F4-3 sign-out elsewhere while a refresh reply is in flight: the late reply is refused and no token comes back', async () => {
  const env = setup();
  const a = worker(env, { label: 'A', barrierDir: env.barrierDir, barrier: 'after', actions: [{ do: 'token' }] });
  await arrived(env, 'A');
  // C cannot take the lock (A holds it), so after its short wait it signs out without it.
  const c = outcome(await worker(env, { label: 'C', authOptions: { sessionLockOptions: { timeoutMs: 300, staleMs: 20_000 }, revocationRetryDelaysMs: [] }, actions: [{ do: 'signOut' }] }));
  assert.equal(c.ok, true, c.message);
  const signedOutAt = journal(env);
  assert.equal(signedOutAt.signedOut, true);
  release(env, 'A');
  const ra = outcome(await a);
  assert.equal(ra.ok, false, 'the refresh started before the sign-out must not succeed');
  assert.match(ra.message, /changed in another Kenlith window/, 'refused by the journal check (src/auth.js:389-391)');
  assert.equal(ra.token, undefined);
  assert.equal(latestSecret(env), undefined, 'the rotated tokens were not written back');
  assert.equal(journal(env).signedOut, true);
  const d = outcome(await worker(env, { label: 'D', actions: [{ do: 'token' }] }));
  assert.equal(d.ok, false);
  assert.equal(d.reauthRequired, true);
});

test('F4-4 account switch while the old account\'s refresh reply is in flight: the new account\'s record is never overwritten, nor its token reused', async () => {
  const env = setup();
  const a = worker(env, { label: 'A', barrierDir: env.barrierDir, barrier: 'after', actions: [{ do: 'token' }] });
  await arrived(env, 'A');
  outcome(await worker(env, { label: 'C', authOptions: { sessionLockOptions: { timeoutMs: 300, staleMs: 20_000 }, revocationRetryDelaysMs: [] }, actions: [{ do: 'signOut' }] }));
  // Another account signs in, written as sign-in writes it (src/auth.js:218-223):
  // a newer generation, then the journal.
  const generation = journal(env).generation + 1;
  const other = storedCredentials({ subject: 'user-synthetic-2', email: 'other@example.test', accessToken: 'synthetic-access-77', refreshToken: 'synthetic-refresh-77', generation });
  const entries = JSON.parse(fs.readFileSync(env.secretsFile, 'utf8'));
  entries[KEY].push({ value: JSON.stringify(other), at: 0, pid: 0 });
  fs.writeFileSync(env.secretsFile, JSON.stringify(entries));
  fs.writeFileSync(path.join(env.storageDir, 'session-state.json'), JSON.stringify({ version: 1, generation, signedOut: false, updatedAt: new Date().toISOString() }));

  release(env, 'A');
  const ra = outcome(await a);
  assert.equal(ra.ok, false, 'the old account\'s renewal is refused');
  assert.match(ra.message, /changed in another Kenlith window/, 'refused by the journal check (src/auth.js:389-391)');
  const kept = latestSecret(env);
  assert.equal(kept.subject, 'user-synthetic-2');
  assert.equal(kept.refreshToken, 'synthetic-refresh-77');
  const d = outcome(await worker(env, { label: 'D', actions: [{ do: 'token' }, { do: 'session' }] }));
  assert.equal(d.token, 'access#77', 'the new account\'s own token');
  const session = (await worker(env, { label: 'E', actions: [{ do: 'session' }] })).result.outcomes[0];
  assert.equal(session.subject, 'user-synthetic-2');
  assert.deepEqual(server.state.refreshes.map((entry) => entry.token), ['synthetic-refresh-0'], 'no further refresh, no reuse of the old account\'s token');
});

test('F4-5 the old process never presents a refresh token another process already rotated', async () => {
  const env = setup();
  const a = worker(env, { label: 'A', barrierDir: env.barrierDir, barrier: 'before', actions: [{ do: 'token' }] });
  await arrived(env, 'A');
  release(env, 'A');
  assert.equal(outcome(await a).token, 'access#1');
  // Expire the rotated record again; two processes renew it at the same moment.
  const record = latestSecret(env);
  const entries = JSON.parse(fs.readFileSync(env.secretsFile, 'utf8'));
  entries[KEY].push({ value: JSON.stringify({ ...record, expiresAt: Date.now() - 1000 }), at: 0, pid: 0 });
  fs.writeFileSync(env.secretsFile, JSON.stringify(entries));
  const runs = await Promise.all(['B', 'C'].map((label) => worker(env, { label, startAt: Date.now() + 800, actions: [{ do: 'token' }] })));
  runs.forEach((run) => assert.equal(outcome(run).token, 'access#2', JSON.stringify(outcome(run))));
  assert.deepEqual(server.state.refreshes.map((entry) => [entry.token, entry.result]), [['synthetic-refresh-0', 'rotated'], ['synthetic-refresh-1', 'rotated']]);
});
