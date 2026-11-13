'use strict';

// M1-2 consent store (src/consent.js): compare-and-update grants, revocation
// that always wins, fail-closed reads, and change notification across
// windows. In-process tests use two store instances on one folder (two
// windows); the multi-process tests use real Node processes with file
// barriers, so every interleaving is fixed rather than timed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/fake-vscode');
const { runWorker } = require('./helpers/processes');
const { ConsentStore, POLICY_VERSION, accountRefFor, keyOf } = require('../src/consent');
const { acquireLock } = require('../src/lock');

const IDENTITY = 'ab'.repeat(32);
const key = (overrides = {}) => ({ projectKey: 'p'.repeat(32), provider: 'openai-siwc', accountRef: accountRefFor(IDENTITY, 'user-subject-1'), ...overrides });
const fileOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'consents.json'), 'utf8'));

// read → mint → grant, as one window's Allow click.
async function allow(store, grantKey = key()) {
  const seen = await store.read(grantKey);
  const token = store.mintToken(grantKey, seen.revision);
  return store.grant(grantKey, { expectedRevision: seen.revision, token, projectLabel: 'project-a' });
}

// ---------- identity of a grant ----------

test('accountRef is a keyed hash of the subject, never the subject itself', () => {
  const ref = accountRefFor(IDENTITY, 'user-subject-1');
  assert.match(ref, /^[0-9a-f]{32}$/);
  assert.equal(ref, accountRefFor(IDENTITY, 'user-subject-1'));
  assert.notEqual(ref, accountRefFor(IDENTITY, 'user-subject-2'));
  assert.notEqual(ref, accountRefFor('cd'.repeat(32), 'user-subject-1'), 'another identity key gives another reference');
  assert.throws(() => accountRefFor(IDENTITY, ''), TypeError);
  assert.throws(() => accountRefFor('short', 'x'), TypeError);
  assert.throws(() => keyOf({ projectKey: 'a|b', provider: 'p', accountRef: 'r' }), TypeError);
});

test('a grant is stored outside the workspace with no raw account data, and read back active', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir);
  assert.deepEqual((await store.read(key())).state, 'none');
  const granted = await allow(store);
  assert.equal(granted.ok, true);
  assert.equal(granted.revision, 1);
  const read = await store.read(key());
  assert.equal(read.active, true);
  assert.equal(read.consentId, granted.consentId);
  assert.equal(read.policyVersion, POLICY_VERSION);
  assert.equal(read.scope, 'project-excerpts');
  const text = fs.readFileSync(path.join(dir, 'consents.json'), 'utf8');
  assert.equal(text.includes('user-subject-1'), false, 'no raw subject stored');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), [], 'no temporary or lock files left');
});

// ---------- revision, revoke, invalidate ----------

test('revoke and invalidate win over an active grant; revisions only grow; records are never deleted', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir);
  const first = await allow(store);
  const revoked = await store.revoke(key(), 'user');
  assert.deepEqual(revoked, { ok: true, changed: true, revision: 2 });
  assert.deepEqual(await store.revoke(key()), { ok: true, changed: false, revision: 2 }, 'idempotent');
  const second = await allow(store);
  assert.equal(second.ok, true);
  assert.equal(second.revision, 3);
  assert.notEqual(second.consentId, first.consentId, 'every grant gets a new consentId');
  const invalidated = await store.invalidate(key(), 'account-changed');
  assert.equal(invalidated.revision, 4);
  const read = await store.read(key());
  assert.equal(read.state, 'invalidated');
  assert.equal(read.active, false);
  assert.equal(read.reason, 'account-changed');
  assert.equal(Object.keys(fileOf(dir).records).length, 1, 'the record stays');
  assert.deepEqual(await store.invalidate(key()), { ok: true, changed: false, revision: 4 });
});

test('a key never granted: revoke is a no-op; list shows every record without raw account data', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir);
  assert.deepEqual(await store.revoke(key()), { ok: true, changed: false, revision: 0 });
  await allow(store);
  await allow(store, key({ projectKey: 'q'.repeat(32) }));
  await store.revoke(key({ projectKey: 'q'.repeat(32) }));
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => [item.projectKey[0], item.state]).sort(), [['p', 'active'], ['q', 'revoked']]);
  assert.ok(list.every((item) => item.provider === 'openai-siwc' && item.projectLabel === 'project-a'));
});

// ---------- the action token ----------

test('a grant needs this window\'s fresh, unused token for the same key and revision', async () => {
  let now = Date.parse('2026-10-30T12:00:00Z');
  const dir = makeTempDir();
  const store = new ConsentStore(dir, { now: () => now });
  const seen = await store.read(key());

  assert.deepEqual(await store.grant(key(), { expectedRevision: 0, token: 'forged' }), { ok: false, reason: 'token' });
  const other = store.mintToken(key({ projectKey: 'q'.repeat(32) }), 0);
  assert.deepEqual(await store.grant(key(), { expectedRevision: 0, token: other }), { ok: false, reason: 'token' }, 'bound to the key');
  const wrongRevision = store.mintToken(key(), seen.revision);
  assert.deepEqual(await store.grant(key(), { expectedRevision: 5, token: wrongRevision }), { ok: false, reason: 'token' }, 'bound to the revision');
  const expired = store.mintToken(key(), seen.revision);
  now += 2 * 60 * 1000 + 1;
  assert.deepEqual(await store.grant(key(), { expectedRevision: 0, token: expired }), { ok: false, reason: 'token' }, 'valid two minutes');

  const good = store.mintToken(key(), 0);
  assert.equal((await store.grant(key(), { expectedRevision: 0, token: good })).ok, true);
  await store.revoke(key());
  // C2-3: the same token again (replay), even with the new revision.
  assert.deepEqual(await store.grant(key(), { expectedRevision: 2, token: good }), { ok: false, reason: 'token' });
  // A token minted in another window (store instance) is unknown here.
  const elsewhere = new ConsentStore(dir, { now: () => now });
  await elsewhere.read(key());
  const foreign = elsewhere.mintToken(key(), 2);
  assert.deepEqual(await store.grant(key(), { expectedRevision: 2, token: foreign }), { ok: false, reason: 'token' });
  assert.equal(fileOf(dir).records[keyOf(key())].revision, 2, 'no rejected grant changed the file');
});

test('grant on an active record is refused; a stale revision is refused', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir);
  await allow(store);
  const again = await allow(store);
  assert.deepEqual(again, { ok: false, reason: 'already-active' });
  const token = store.mintToken(key(), 0);
  assert.deepEqual(await store.grant(key(), { expectedRevision: 0, token }), { ok: false, reason: 'stale' });
});

// ---------- two windows in one process, interleaved with hooks ----------

test('C2-1 in-process: window A revokes while B holds a stale view; B\'s Allow is rejected and the result stays revoked', async () => {
  const dir = makeTempDir();
  const a = new ConsentStore(dir);
  const b = new ConsentStore(dir);
  await allow(a);
  await a.revoke(key());                       // r=2, revoked
  const bView = await b.read(key());           // B renders Allow at r=2
  const bToken = b.mintToken(key(), bView.revision);
  await allow(a);                              // A grants (r=3) ...
  await a.revoke(key());                       // ... and revokes (r=4)
  const late = await b.grant(key(), { expectedRevision: bView.revision, token: bToken });
  assert.deepEqual(late, { ok: false, reason: 'stale' });
  const final = await a.read(key());
  assert.equal(final.state, 'revoked');
  assert.equal(final.revision, 4);
});

test('a grant paused inside the lock serializes with a concurrent revoke: grant then revoke, ending revoked', async () => {
  const dir = makeTempDir();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let paused;
  const inLock = new Promise((resolve) => { paused = resolve; });
  const a = new ConsentStore(dir, { hooks: { 'before-write': async () => { paused(); await gate; } } });
  const b = new ConsentStore(dir, { lockOptions: { timeoutMs: 10_000 } });
  const seen = await a.read(key());
  const token = a.mintToken(key(), seen.revision);
  const granting = a.grant(key(), { expectedRevision: seen.revision, token });
  await inLock;
  const revoking = b.revoke(key());            // waits for A's lock
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  assert.equal((await granting).ok, true);
  assert.deepEqual(await revoking, { ok: true, changed: true, revision: 2 });
  assert.equal((await b.read(key())).state, 'revoked');
});

// ---------- fail closed ----------

test('a lock held past the timeout: read is not active, grant is unavailable, revoke is kept as a local mark', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir, { lockOptions: { timeoutMs: 150 } });
  await allow(store);
  const handle = await acquireLock(path.join(dir, 'consents.lock'));
  try {
    const read = await store.read(key());
    assert.deepEqual([read.active, read.state, read.reason], [false, 'unavailable', 'lock-timeout']);
    const seenToken = store.mintToken(key(), 1);
    assert.deepEqual((await store.grant(key(), { expectedRevision: 1, token: seenToken })).reason, 'unavailable');
    const revoke = await store.revoke(key(), 'user');
    assert.deepEqual([revoke.ok, revoke.reason, revoke.pending], [false, 'unavailable', true]);
    assert.equal(store.pendingRevocations().length, 1);
  } finally {
    await handle.release();
  }
  // The disk still says active, but this window reports it revoked.
  assert.equal(fileOf(dir).records[keyOf(key())].state, 'active');
  const read = await store.read(key());
  assert.deepEqual([read.active, read.pendingRevoke], [false, true]);
  const token = store.mintToken(key(), read.revision);
  assert.deepEqual(await store.grant(key(), { expectedRevision: read.revision, token }), { ok: false, reason: 'revoke-pending' });
  assert.equal(await store.retryPendingRevocations(), 0);
  assert.equal(fileOf(dir).records[keyOf(key())].state, 'revoked', 'the revoke reached the disk');
  assert.equal(store.pendingRevocations().length, 0);
});

test('a corrupt file is kept aside and treated as no grant; a newer file is left alone and treated as no grant', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'consents.json'), '{ not json');
  const store = new ConsentStore(dir);
  const read = await store.read(key());
  assert.deepEqual([read.active, read.state, read.reason], [false, 'unavailable', 'corrupt-file']);
  const aside = fs.readdirSync(dir).filter((name) => name.startsWith('consents.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ not json', 'kept as it was');
  assert.equal((await store.read(key())).state, 'none', 'then starts empty: no grant');

  const newer = makeTempDir();
  const future = JSON.stringify({ version: 2, generation: 'g', records: {} });
  fs.writeFileSync(path.join(newer, 'consents.json'), future);
  const other = new ConsentStore(newer);
  assert.equal((await other.read(key())).reason, 'newer-file');
  assert.equal((await allow(other)).reason, 'unavailable');
  assert.equal(fs.readFileSync(path.join(newer, 'consents.json'), 'utf8'), future, 'a newer file is never rewritten');
});

test('a quarantined file voids tokens minted before it (new generation)', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir);
  const seen = await store.read(key());
  const token = store.mintToken(key(), seen.revision);
  fs.writeFileSync(path.join(dir, 'consents.json'), 'garbage');
  await store.read(key());                     // quarantines
  await store.read(key());                     // new, empty file
  assert.deepEqual(await store.grant(key(), { expectedRevision: 0, token }), { ok: false, reason: 'token' });
});

test('records with an unknown state or policy version are never active', async () => {
  const dir = makeTempDir();
  const store = new ConsentStore(dir);
  await store.read(key());
  const file = fileOf(dir);
  file.records[keyOf(key())] = { consentId: 'c', state: 'active', revision: 1, policyVersion: 99 };
  file.records[keyOf(key({ projectKey: 'q'.repeat(32) }))] = { consentId: 'c', state: 'weird', revision: 1 };
  fs.writeFileSync(path.join(dir, 'consents.json'), JSON.stringify(file));
  assert.equal((await store.read(key())).active, false);
  const odd = await store.read(key({ projectKey: 'q'.repeat(32) }));
  assert.deepEqual([odd.active, odd.state], [false, 'invalid']);
});

// ---------- change notification ----------

test('the watcher reports another window\'s revoke; with fs.watch off, the poll still does', async () => {
  for (const watchFs of [true, false]) {
    const dir = makeTempDir();
    const a = new ConsentStore(dir);
    const b = new ConsentStore(dir, { watchFs, pollMs: 100 });
    await allow(a);
    const events = [];
    const handle = b.watch((event) => events.push(event));
    await handle.ready;
    await a.revoke(key(), 'user');
    const deadline = Date.now() + 3000;
    while (!events.some((event) => event.state === 'revoked') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    handle.dispose();
    const seen = events.find((event) => event.state === 'revoked');
    assert.ok(seen, `revoke seen (watchFs ${watchFs})`);
    assert.equal(seen.revision, 2);
    assert.deepEqual(seen.grantKey, key());
  }
});

// ---------- separate OS processes ----------

function processSetup() {
  return { storageDir: makeTempDir(), barrierDir: makeTempDir(), grantKey: key() };
}
const run = (setup, label, actions, extra = {}) => runWorker('consent-worker.js', { ...setup, label, actions, ...extra });

test('processes C2-1: B renders Allow, A grants and revokes, B clicks: rejected as stale, final revoked', async () => {
  const setup = processSetup();
  const [a, b] = await Promise.all([
    run(setup, 'A', [{ do: 'wait', name: 'b-rendered' }, { do: 'read' }, { do: 'mint' }, { do: 'grant' }, { do: 'revoke' }, { do: 'signal', name: 'a-done' }]),
    run(setup, 'B', [{ do: 'read' }, { do: 'mint' }, { do: 'signal', name: 'b-rendered' }, { do: 'wait', name: 'a-done' }, { do: 'grant' }, { do: 'read' }])
  ]);
  assert.equal(a.result.results.find((r) => r.do === 'grant').ok, true);
  const bGrant = b.result.results.find((r) => r.do === 'grant');
  assert.deepEqual([bGrant.ok, bGrant.reason], [false, 'stale']);
  const final = b.result.results.at(-1);
  assert.deepEqual([final.state, final.revision, final.active], ['revoked', 2, false]);
});

test('processes C2-2: A grants while B waits to revoke inside the lock order; final revoked', async () => {
  const setup = processSetup();
  const [a, b] = await Promise.all([
    // A pauses inside the lock just before writing; B then tries to revoke.
    run(setup, 'A', [{ do: 'pauseAt', step: 'before-write', signal: 'a-in-lock', wait: 'b-trying' }, { do: 'read' }, { do: 'mint' }, { do: 'grant' }]),
    run(setup, 'B', [{ do: 'wait', name: 'a-in-lock' }, { do: 'signal', name: 'b-trying' }, { do: 'revoke' }, { do: 'read' }], { lockOptions: { timeoutMs: 15_000 } })
  ]);
  assert.equal(a.result.results.find((r) => r.do === 'grant').ok, true);
  const revoke = b.result.results.find((r) => r.do === 'revoke');
  assert.deepEqual([revoke.ok, revoke.changed, revoke.revision], [true, true, 2], 'the revoke came after the grant and applied');
  assert.equal(b.result.results.at(-1).state, 'revoked');
});

test('processes: a revoke committed first defeats a grant prepared before it (revoke-then-stale-grant)', async () => {
  const setup = processSetup();
  await run(setup, 'seed', [{ do: 'read' }, { do: 'mint' }, { do: 'grant' }]);
  const [a, b] = await Promise.all([
    run(setup, 'A', [{ do: 'wait', name: 'b-rendered' }, { do: 'revoke' }, { do: 'signal', name: 'a-revoked' }]),
    // B saw the record active at r=1 and only now asks to grant at r=1.
    run(setup, 'B', [{ do: 'read' }, { do: 'mint' }, { do: 'signal', name: 'b-rendered' }, { do: 'wait', name: 'a-revoked' }, { do: 'grant' }, { do: 'read' }])
  ]);
  assert.equal(a.result.results[0].changed, true);
  const grant = b.result.results.find((r) => r.do === 'grant');
  assert.equal(grant.ok, false);
  assert.equal(grant.reason, 'stale');
  assert.equal(b.result.results.at(-1).state, 'revoked');
});

test('processes C2-6: a lock held by another process past the timeout makes B fail closed and keep its revoke locally', async () => {
  const setup = processSetup();
  await run(setup, 'seed', [{ do: 'read' }, { do: 'mint' }, { do: 'grant' }]);
  const [, b] = await Promise.all([
    run(setup, 'A', [{ do: 'holdLock', ms: 3_000, signal: 'a-holds' }]),
    run(setup, 'B', [{ do: 'wait', name: 'a-holds' }, { do: 'read' }, { do: 'mint' }, { do: 'grant', expectedRevision: 1 }, { do: 'revoke' }, { do: 'read' }], { lockOptions: { timeoutMs: 300 } })
  ]);
  const [read, , grant, revoke, after] = b.result.results; // read, mint, grant, revoke, read
  assert.deepEqual([read.active, read.state], [false, 'unavailable']);
  assert.deepEqual([grant.ok, grant.reason], [false, 'unavailable']);
  assert.deepEqual([revoke.ok, revoke.pending], [false, true]);
  assert.equal(after.active, false, 'reported revoked by the local mark even though the lock never came');
});

test('processes: five concurrent revokes of one grant change it exactly once', async () => {
  const setup = processSetup();
  await run(setup, 'seed', [{ do: 'read' }, { do: 'mint' }, { do: 'grant' }]);
  const workers = Array.from({ length: 5 }, (_, index) => run(setup, `R${index}`, [{ do: 'wait', name: 'go' }, { do: 'revoke' }], { lockOptions: { timeoutMs: 15_000 } }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(setup.barrierDir, 'go'), '');
  const results = (await Promise.all(workers)).map((worker) => worker.result.results[0]);
  assert.ok(results.every((r) => r.ok === true), JSON.stringify(results));
  assert.equal(results.filter((r) => r.changed).length, 1);
  const final = fileOf(setup.storageDir).records[keyOf(key())];
  assert.deepEqual([final.state, final.revision], ['revoked', 2]);
});

test('processes: B\'s watcher (poll only) sees A\'s revoke within the poll interval', async () => {
  const setup = processSetup();
  await run(setup, 'seed', [{ do: 'read' }, { do: 'mint' }, { do: 'grant' }]);
  const [, b] = await Promise.all([
    run(setup, 'A', [{ do: 'wait', name: 'b-watching' }, { do: 'revoke' }]),
    run(setup, 'B', [{ do: 'watchFor', state: 'revoked', signal: 'b-watching', timeoutMs: 8_000 }], { watchFs: false, pollMs: 200 })
  ]);
  const seen = b.result.results[0].seen;
  assert.ok(seen, JSON.stringify(b.result));
  assert.equal(seen.state, 'revoked');
  assert.equal(seen.revision, 2);
  assert.ok(seen.elapsedMs < 2_000, `seen after ${seen.elapsedMs} ms`);
});
