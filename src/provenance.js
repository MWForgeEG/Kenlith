'use strict';

// Message provenance (M1-3; Phase 0.1 Contract 3, DEC-PLANCHAT-012).
//
// New fields are additive and optional; the history file stays version 1 and
// old messages are never rewritten. Classification happens when history is
// read for a request:
//
// - user message (with or without `provenance: 'user'`): typed text. Earlier
//   versions stored only typed text (attachment bodies were never stored,
//   DEC-PLANCHAT-003), so legacy user messages are user text too.
// - `provenance: 'project-derived'` reply: produced with project excerpts. It
//   also carries `contextPolicy: 'excluded'`, so 0.2.0 (which honours that
//   field) never re-sends it after a downgrade. It is re-sent automatically
//   only while the grant it was made under is still the active one: same
//   consent ID and same policy version (DEC-PLANCHAT-012). After a revoke and
//   a new grant (a new consent ID) it stays visible but is not re-sent.
// - reply to attached code: the existing per-reply policy (excluded unless
//   the user chose Include in follow-ups).
// - legacy reply without provenance: as before. No release before M1 put
//   project content into a request automatically.
// - any other provenance value: unknown, so excluded (fail closed); the
//   message is still shown.

const KNOWN = new Set(['user', 'project-derived']);

function classify(message) {
  if (!message || typeof message !== 'object') return 'unknown';
  if (message.provenance !== undefined && !KNOWN.has(message.provenance)) return 'unknown';
  if (message.role === 'user') return message.provenance === 'project-derived' ? 'unknown' : 'user';
  if (message.role !== 'assistant') return 'unknown';
  if (message.provenance === 'project-derived') return 'project-derived';
  if (message.provenance === 'user') return 'unknown';
  if (message.attachmentTurn) return 'attachment-reply';
  return 'legacy-reply';
}

// Whether a stored message may go into a new request. `activeGrant` is the
// grant active for this request ({ grantKeyId, consentId, policyVersion }),
// or undefined when there is none.
function mayReplay(message, activeGrant) {
  // 0.4.0: a reply still being written, or cut off by a crash or quit, is
  // incomplete and never re-sent, whatever its class.
  if (message?.role === 'assistant' && (message.inProgress || message.interrupted)) return false;
  switch (classify(message)) {
    case 'user':
      return true;
    case 'legacy-reply':
      return message.contextPolicy !== 'excluded';
    case 'attachment-reply':
      // As in 0.2.0: excluded unless the user chose Include in follow-ups.
      return message.contextPolicy !== 'excluded';
    case 'project-derived':
      return Boolean(activeGrant
        && message.grantKeyId === activeGrant.grantKeyId
        && message.consentId === activeGrant.consentId
        && message.policyVersion === activeGrant.policyVersion);
    default:
      return false;
  }
}

// The metadata stored for a turn that sent project excerpts: the relative
// path, the line range and the file's hash, so the user can see later what an
// answer used. Never the excerpt text, so stored history cannot re-send it.
function contextUsedRecord(excerpts) {
  return excerpts.map((excerpt) => ({
    relPath: String(excerpt.relPath),
    range: [excerpt.startLine, excerpt.endLine],
    sha256: excerpt.fileSha256
  }));
}

module.exports = { classify, contextUsedRecord, mayReplay };
