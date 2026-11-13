'use strict';

// Token refresh shared by several independent OS processes. Each worker is a
// separate Node process running AuthService, as one editor window would. They
// share globalStorage (lock and journal files) and a file-backed stand-in for
// SecretStorage, and talk to one local OAuth server that rotates refresh
// tokens and rejects reuse. All credentials are synthetic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/fake-vscode');
const { storedCredentials } = require('./helpers/fake-openai');
const { startOAuthServer } = require('./helpers/oauth-server');
const { runWorker } = require('./helpers/processes');
const { acquireLock } = require('../src/lock');

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

// An expired 0.1.1-style record (no generation), visible to every process.
function setup(overrides = {}) {
  const storageDir = makeTempDir();
  const secretsFile = path.join(makeTempDir(), 'secrets.json');
  const record = storedCredentials({ expiresAt: Date.now() - 1000, ...overrides });
  delete record.generation;
  fs.writeFileSync(secretsFile, JSON.stringify({ [KEY]: [{ value: JSON.stringify(record), at: 0, pid: 0 }] }));
  return { storageDir, secretsFile };
}

// The newest SecretStorage entry, ignoring visibility delay.
function latestSecret(env) {
  const entries = JSON.parse(fs.readFileSync(env.secretsFile, 'utf8'))[KEY];
  const value = entries.at(-1).value;
  return value === null ? undefined : JSON.parse(value);
}

function journal(env) {
  const file = path.join(env.storageDir, 'session-state.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

function worker(env, spec) {
  return runWorker('auth-worker.js', { ...env, port: server.port, ...spec });
}

function outcome(run, index = 0) {
  assert.ok(run.result && !run.result.fatal, `worker failed: ${run.stdout}${run.stderr}`);
  return run.result.outcomes[index];
}

function startAt() {
  return Date.now() + 1500;
}

test('four processes find the token expired at once: one refresh, all get the new token', async () => {
  const env = setup();
  server.state.delayMs = 300;
  const at = startAt();
  const runs = await Promise.all([0, 1, 2, 3].map((index) => worker(env, {
    label: `w${index}`, startAt: at, actions: [{ do: 'token' }]
  })));

  for (const run of runs) {
    assert.deepEqual(outcome(run), { ...outcome(run), ok: true, token: 'access#1' });
  }
  assert.equal(server.state.refreshes.length, 1, 'exactly one refresh request for the shared token');
  assert.equal(server.state.refreshes[0].result, 'rotated');

  const record = latestSecret(env);
  assert.equal(record.refreshToken, 'synthetic-refresh-1');
  assert.equal(record.accessToken, 'synthetic-access-1');
  // A 0.1.1 record (no generation) counts as generation 1; the refresh writes 2.
  assert.equal(record.generation, 2);
  assert.deepEqual(journal(env), { ...journal(env), generation: 2, signedOut: false });
  // Identity, client registration, host and scopes carried over unchanged.
  const original = storedCredentials();
  for (const field of ['subject', 'email', 'clientId', 'hostId']) {
    assert.equal(record[field], original[field], field);
  }
  assert.deepEqual(record.scopes, original.scopes);
});

test('two rounds of expiry across processes rotate the token twice, never reusing one', async () => {
  const env = setup();
  const first = await Promise.all([0, 1].map((index) => worker(env, { label: `a${index}`, startAt: startAt(), actions: [{ do: 'token' }] })));
  first.forEach((run) => assert.equal(outcome(run).token, 'access#1', JSON.stringify(outcome(run))));

  // Expire the rotated record again, keeping its generation, as time passing would.
  const record = latestSecret(env);
  const entries = JSON.parse(fs.readFileSync(env.secretsFile, 'utf8'));
  entries[KEY].push({ value: JSON.stringify({ ...record, expiresAt: Date.now() - 1000 }), at: 0, pid: 0 });
  fs.writeFileSync(env.secretsFile, JSON.stringify(entries));

  const second = await Promise.all([0, 1].map((index) => worker(env, { label: `b${index}`, startAt: startAt(), actions: [{ do: 'token' }] })));
  second.forEach((run) => assert.equal(outcome(run).token, 'access#2', JSON.stringify(outcome(run))));
  assert.deepEqual(server.state.refreshes.map((entry) => entry.result), ['rotated', 'rotated']);
  assert.deepEqual(server.state.refreshes.map((entry) => entry.token), ['synthetic-refresh-0', 'synthetic-refresh-1']);
});

test('delayed SecretStorage visibility: a stale copy waits instead of reusing the rotated token', async () => {
  const env = setup();
  // Process A refreshes. Its write stays invisible to B for 1.5 s.
  const a = await worker(env, { label: 'A', secretDelayMs: 1500, actions: [{ do: 'token' }] });
  assert.equal(outcome(a).token, 'access#1');

  const b = await worker(env, { label: 'B', secretDelayMs: 1500, actions: [{ do: 'token' }] });
  assert.equal(outcome(b).ok, true, outcome(b).message);
  assert.equal(outcome(b).token, 'access#1');
  assert.ok(outcome(b).ms >= 500, 'B waited for the newer record to become visible');
  assert.equal(server.state.refreshes.length, 1, 'B never presented the rotated token');
});

test('a stale copy that stays invisible too long fails recoverably and changes nothing', async () => {
  const env = setup();
  await worker(env, { label: 'A', secretDelayMs: 30_000, actions: [{ do: 'token' }] });
  const before = fs.readFileSync(env.secretsFile, 'utf8');

  const b = await worker(env, {
    label: 'B',
    secretDelayMs: 30_000,
    authOptions: { visibilityTimeoutMs: 400 },
    actions: [{ do: 'token' }]
  });
  assert.equal(outcome(b).ok, false);
  assert.equal(outcome(b).reauthRequired, false, 'not treated as revoked');
  assert.match(outcome(b).message, /another window\. Try again/);
  assert.equal(fs.readFileSync(env.secretsFile, 'utf8'), before, 'credentials untouched');
  assert.equal(server.state.refreshes.length, 1);
  assert.equal(server.state.valid.has('synthetic-refresh-1'), true, 'the live session is still valid on the server');
});

test('sign-out in one process during another\'s refresh: no tokens come back afterwards', async () => {
  const env = setup();
  server.state.delayMs = 800;
  const at = startAt();
  const [refresher, signer] = await Promise.all([
    worker(env, { label: 'R', startAt: at, actions: [{ do: 'token' }, { do: 'sleep', ms: 1500 }, { do: 'token' }, { do: 'session' }] }),
    worker(env, { label: 'S', startAt: at + 200, actions: [{ do: 'signOut' }] })
  ]);

  assert.equal(outcome(refresher, 0).token, 'access#1', 'the refresh in progress completed');
  assert.equal(outcome(signer).ok, true);
  assert.equal(outcome(signer).remoteRevoked, true);
  assert.deepEqual(server.state.revoked, ['synthetic-refresh-1'], 'the newest refresh token was the one revoked');
  // Outcomes: [token, token, session]; sleep records none.
  assert.equal(outcome(refresher, 1).ok, false);
  assert.equal(outcome(refresher, 1).reauthRequired, true);
  assert.equal(outcome(refresher, 2).signedIn, false);
  assert.equal(latestSecret(env), undefined, 'credentials stay deleted');
  assert.equal(journal(env).signedOut, true);
  assert.equal(server.state.refreshes.length, 1);
});

test('sign-out is honoured even while the deletion is not yet visible to another process', async () => {
  const env = setup({ expiresAt: Date.now() + 3_600_000 });
  const signer = await worker(env, { label: 'S', actions: [{ do: 'signOut' }] });
  assert.equal(outcome(signer).ok, true);

  const other = await worker(env, { label: 'O', secretDelayMs: 30_000, actions: [{ do: 'token' }, { do: 'session' }] });
  assert.equal(outcome(other, 0).reauthRequired, true);
  assert.match(outcome(other, 0).message, /signed out of ChatGPT in another Kenlith window/);
  assert.equal(outcome(other, 1).signedIn, false);
});

test('a revoked refresh token: one attempt, every process asked to sign in, nothing retried', async () => {
  const env = setup();
  server.state.mode = 'revoked';
  const at = startAt();
  const runs = await Promise.all([0, 1, 2].map((index) => worker(env, { label: `w${index}`, startAt: at, actions: [{ do: 'token' }] })));

  for (const run of runs) {
    assert.equal(outcome(run).ok, false);
    assert.equal(outcome(run).reauthRequired, true);
  }
  assert.equal(server.state.refreshes.length, 1, 'later processes saw the ended session and did not retry');
  assert.equal(latestSecret(env), undefined);
  assert.equal(journal(env).signedOut, true);
});

test('a network failure keeps the session in every process; it recovers afterwards', async () => {
  const env = setup();
  server.state.mode = 'network';
  const before = fs.readFileSync(env.secretsFile, 'utf8');
  const at = startAt();
  const runs = await Promise.all([0, 1].map((index) => worker(env, { label: `w${index}`, startAt: at, actions: [{ do: 'token' }] })));
  for (const run of runs) {
    assert.equal(outcome(run).ok, false);
    assert.equal(outcome(run).reauthRequired, false);
    assert.match(outcome(run).message, /sign-in was kept/);
  }
  assert.equal(fs.readFileSync(env.secretsFile, 'utf8'), before);
  assert.equal(journal(env), undefined);

  server.state.mode = 'normal';
  const after = await worker(env, { label: 'later', actions: [{ do: 'token' }] });
  assert.equal(outcome(after).token, 'access#1');
});

test('a process that dies mid-refresh does not block the others', async () => {
  const env = setup();
  const crashed = await worker(env, { label: 'crash', actions: [{ do: 'crashInRefresh' }] });
  assert.equal(crashed.code, 7);
  assert.ok(fs.existsSync(path.join(env.storageDir, 'session.lock')), 'the dead process left its lock');

  const next = await worker(env, { label: 'next', actions: [{ do: 'token' }] });
  assert.equal(outcome(next).token, 'access#1');
  assert.ok(outcome(next).ms < 5000, 'dead owner detected without waiting for the stale timeout');
});

test('an abandoned lock from a hung process is taken over after the stale period', async () => {
  const env = setup();
  const lockPath = path.join(env.storageDir, 'session.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ id: 'hung', pid: process.pid, host: os.hostname(), createdAt: 0 }));
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, old, old);

  const next = await worker(env, { label: 'next', actions: [{ do: 'token' }] });
  assert.equal(outcome(next).token, 'access#1');
});

test('when the lock stays busy, refresh stops with a recoverable error and touches nothing', async () => {
  const env = setup();
  const before = fs.readFileSync(env.secretsFile, 'utf8');
  const lock = await acquireLock(path.join(env.storageDir, 'session.lock'));
  try {
    const run = await worker(env, {
      label: 'blocked',
      authOptions: { sessionLockOptions: { timeoutMs: 500, staleMs: 20_000 } },
      actions: [{ do: 'token' }]
    });
    assert.equal(outcome(run).ok, false);
    assert.equal(outcome(run).reauthRequired, false);
    assert.match(outcome(run).message, /Another Kenlith window is renewing/);
  } finally {
    await lock.release();
  }
  assert.equal(fs.readFileSync(env.secretsFile, 'utf8'), before);
  assert.equal(server.state.refreshes.length, 0);
});

function writeJournal(env, journalState) {
  fs.writeFileSync(path.join(env.storageDir, 'session-state.json'), JSON.stringify({ version: 1, ...journalState }));
}

test('upgrade after rollback: a newer 0.1.1 sign-in is accepted over an older 0.1.2 sign-out', async () => {
  const env = setup({ expiresAt: Date.now() + 3_600_000 });
  writeJournal(env, { generation: 3, signedOut: true, updatedAt: new Date(Date.now() - 86_400_000).toISOString() });
  const run = await worker(env, { label: 'up', actions: [{ do: 'session' }, { do: 'token' }] });
  assert.equal(outcome(run, 0).signedIn, true);
  assert.equal(outcome(run, 1).token, 'access#0', 'the stored, still-valid access token is used');
  assert.equal(server.state.refreshes.length, 0);
});

test('upgrade after rollback: a newer 0.1.1 record refreshes without waiting and continues the generations', async () => {
  const env = setup();
  writeJournal(env, { generation: 3, signedOut: false, updatedAt: new Date(Date.now() - 86_400_000).toISOString() });
  const run = await worker(env, { label: 'up', actions: [{ do: 'token' }] });
  assert.equal(outcome(run).token, 'access#1');
  assert.ok(outcome(run).ms < 3000);
  assert.equal(latestSecret(env).generation, 5);
  assert.equal(journal(env).generation, 5);
});

test('a 0.1.1 record older than a recorded sign-out stays signed out', async () => {
  const env = setup({ savedAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: Date.now() + 3_600_000 });
  writeJournal(env, { generation: 2, signedOut: true, updatedAt: new Date().toISOString() });
  const run = await worker(env, { label: 'old', actions: [{ do: 'session' }] });
  assert.equal(outcome(run).signedIn, false);
});

test('nothing outside SecretStorage holds a token, and worker output carries none', async () => {
  const env = setup();
  server.state.delayMs = 100;
  const at = startAt();
  const runs = await Promise.all([0, 1, 2].map((index) => worker(env, {
    label: `w${index}`, startAt: at, actions: [{ do: 'token' }, { do: 'signOut' }]
  })));

  const secretShapes = /synthetic-(access|refresh)-\d|eyJ[\w-]{10,}\./;
  for (const run of runs) {
    assert.doesNotMatch(run.stdout + run.stderr, secretShapes);
  }
  for (const name of fs.readdirSync(env.storageDir)) {
    const text = fs.readFileSync(path.join(env.storageDir, name), 'utf8');
    assert.doesNotMatch(text, secretShapes, `${name} must not contain credentials`);
  }
});
