'use strict';

// The two checks around a project-context request (M1-2; Phase 0.1 Contracts
// 1 and 2). Both fail closed: anything not positively allowed is refused.
//
// preflight: before any local retrieval. Only a project chat, in the
//   window's own project, in a trusted local workspace, with the feature on.
// finalCheck: immediately before a request carrying project segments is
//   sent. The grant must still be the one the request was built under (same
//   consentId and revision, current policy version), the signed-in account
//   and provider unchanged, the workspace still trusted, and the source files
//   unchanged since retrieval.

const { POLICY_VERSION } = require('./consent');

function preflight({ chatKind, chatProjectKey, windowProjectKey, trusted, localRoot, kill } = {}) {
  if (kill) return { ok: false, reason: 'disabled' };
  if (chatKind !== 'project') return { ok: false, reason: 'general' };
  if (trusted !== true) return { ok: false, reason: 'untrusted' };
  if (typeof localRoot !== 'string' || !localRoot) return { ok: false, reason: 'not-local' };
  if (typeof chatProjectKey !== 'string' || !chatProjectKey || chatProjectKey !== windowProjectKey) {
    return { ok: false, reason: 'project-mismatch' };
  }
  return { ok: true };
}

// expected: { consentId, revision, policyVersion, provider? }
async function finalCheck({ consents, grantKey, expected, session, expectedSubject, trusted, sourcesUnchanged } = {}) {
  try {
    if (trusted !== true) return { ok: false, reason: 'untrusted' };
    if (!session || typeof session.subject !== 'string' || !session.subject || session.subject !== expectedSubject) {
      return { ok: false, reason: 'account-changed' };
    }
    if (!expected || (expected.provider !== undefined && expected.provider !== grantKey?.provider)) {
      return { ok: false, reason: 'provider-changed' };
    }
    if (expected.policyVersion !== POLICY_VERSION) return { ok: false, reason: 'policy-changed' };
    const current = await consents.read(grantKey);
    if (!current || current.active !== true) return { ok: false, reason: 'not-active' };
    if (current.policyVersion !== POLICY_VERSION) return { ok: false, reason: 'policy-changed' };
    if (current.consentId !== expected.consentId) return { ok: false, reason: 'consent-changed' };
    if (current.revision !== expected.revision) return { ok: false, reason: 'revision-changed' };
    if (typeof sourcesUnchanged !== 'function' || (await sourcesUnchanged()) !== true) {
      return { ok: false, reason: 'sources-changed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'uncertain' };
  }
}

module.exports = { finalCheck, preflight };
