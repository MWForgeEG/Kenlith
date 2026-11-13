'use strict';

// M1-2 gate (src/context-gate.js): preflight before retrieval, and the final
// check before a request with project segments is sent. Every refusal is
// checked by its reason; anything uncertain must refuse.

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeTempDir } = require('./helpers/fake-vscode');
const { ConsentStore, POLICY_VERSION, accountRefFor } = require('../src/consent');
const { finalCheck, preflight } = require('../src/context-gate');

const IDENTITY = 'ab'.repeat(32);
const PROJECT = 'p'.repeat(32);
const grantKey = { projectKey: PROJECT, provider: 'openai-siwc', accountRef: accountRefFor(IDENTITY, 'subject-1') };
const session = { subject: 'subject-1', email: 'synthetic@example.test' };

test('preflight: only a trusted, local project chat in its own window, with the feature on', () => {
  const ok = { chatKind: 'project', chatProjectKey: PROJECT, windowProjectKey: PROJECT, trusted: true, localRoot: 'C:\\work\\a', kill: false };
  assert.deepEqual(preflight(ok), { ok: true });
  assert.deepEqual(preflight({ ...ok, kill: true }), { ok: false, reason: 'disabled' });
  assert.deepEqual(preflight({ ...ok, chatKind: 'general' }), { ok: false, reason: 'general' });
  assert.deepEqual(preflight({ ...ok, chatKind: undefined }), { ok: false, reason: 'general' });
  assert.deepEqual(preflight({ ...ok, trusted: false }), { ok: false, reason: 'untrusted' });
  assert.deepEqual(preflight({ ...ok, trusted: undefined }), { ok: false, reason: 'untrusted' }, 'unknown trust refuses');
  assert.deepEqual(preflight({ ...ok, localRoot: undefined }), { ok: false, reason: 'not-local' });
  assert.deepEqual(preflight({ ...ok, windowProjectKey: 'q'.repeat(32) }), { ok: false, reason: 'project-mismatch' });
  assert.deepEqual(preflight({ ...ok, chatProjectKey: undefined, windowProjectKey: undefined }), { ok: false, reason: 'project-mismatch' });
  assert.deepEqual(preflight(), { ok: false, reason: 'general' });
});

async function granted() {
  const consents = new ConsentStore(makeTempDir());
  const seen = await consents.read(grantKey);
  const result = await consents.grant(grantKey, { expectedRevision: seen.revision, token: consents.mintToken(grantKey, seen.revision) });
  const expected = { consentId: result.consentId, revision: result.revision, policyVersion: POLICY_VERSION, provider: 'openai-siwc' };
  const base = { consents, grantKey, expected, session, expectedSubject: 'subject-1', trusted: true, sourcesUnchanged: async () => true };
  return { consents, expected, base };
}

test('finalCheck passes only with the same grant, account, provider, policy, trust and sources', async () => {
  const { base } = await granted();
  assert.deepEqual(await finalCheck(base), { ok: true });
  assert.deepEqual(await finalCheck({ ...base, session: { subject: 'subject-2' } }), { ok: false, reason: 'account-changed' });
  assert.deepEqual(await finalCheck({ ...base, session: undefined }), { ok: false, reason: 'account-changed' }, 'signed out');
  assert.deepEqual(await finalCheck({ ...base, trusted: false }), { ok: false, reason: 'untrusted' });
  assert.deepEqual(await finalCheck({ ...base, expected: { ...base.expected, provider: 'openai-api' } }), { ok: false, reason: 'provider-changed' });
  assert.deepEqual(await finalCheck({ ...base, expected: { ...base.expected, policyVersion: POLICY_VERSION + 1 } }), { ok: false, reason: 'policy-changed' });
  assert.deepEqual(await finalCheck({ ...base, sourcesUnchanged: async () => false }), { ok: false, reason: 'sources-changed' });
  assert.deepEqual(await finalCheck({ ...base, sourcesUnchanged: async () => { throw new Error('read failed'); } }), { ok: false, reason: 'uncertain' });
  assert.deepEqual(await finalCheck({ ...base, sourcesUnchanged: undefined }), { ok: false, reason: 'sources-changed' });
  assert.deepEqual(await finalCheck({ ...base, consents: { read: async () => { throw new Error('boom'); } } }), { ok: false, reason: 'uncertain' });
  assert.deepEqual(await finalCheck({ ...base, expected: undefined }), { ok: false, reason: 'provider-changed' });
});

test('finalCheck refuses after a revoke, after revoke and re-grant (new consentId), and when the revision moved', async () => {
  const { consents, base } = await granted();
  await consents.revoke(grantKey);
  assert.deepEqual(await finalCheck(base), { ok: false, reason: 'not-active' });
  const seen = await consents.read(grantKey);
  await consents.grant(grantKey, { expectedRevision: seen.revision, token: consents.mintToken(grantKey, seen.revision) });
  assert.deepEqual(await finalCheck(base), { ok: false, reason: 'consent-changed' }, 'a re-grant is a different authorization');
  const now = await consents.read(grantKey);
  assert.deepEqual(await finalCheck({ ...base, expected: { ...base.expected, consentId: now.consentId } }), { ok: false, reason: 'revision-changed' });
  assert.deepEqual(await finalCheck({ ...base, expected: { ...base.expected, consentId: now.consentId, revision: now.revision } }), { ok: true });
});

test('finalCheck refuses when the consent store cannot be read (lock held) and for another account\'s key', async () => {
  const { base } = await granted();
  const unavailable = { read: async () => ({ active: false, state: 'unavailable', reason: 'lock-timeout' }) };
  assert.deepEqual(await finalCheck({ ...base, consents: unavailable }), { ok: false, reason: 'not-active' });
  const otherAccount = { ...grantKey, accountRef: accountRefFor(IDENTITY, 'subject-2') };
  assert.deepEqual(await finalCheck({ ...base, grantKey: otherAccount, session: { subject: 'subject-2' }, expectedSubject: 'subject-2' }), { ok: false, reason: 'not-active' });
});
