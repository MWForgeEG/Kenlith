'use strict';

// Kenlith 0.6.0: the review service (docs/kenlith-0.6.0/ARCHITECTURE.md §3, §5–§8).
//
// Lifecycle of a proposal: a draft collects the model's project_propose_edit
// calls during one reply (nothing is written, nothing is actionable); when
// the reply has ended and its slot is released, the draft is finalized into
// a stored proposal in `review` (Awaiting Review, DEC-PLANCHAT-028) or
// dropped. Apply is accepted only for a stored proposal in `review` whose
// digest matches the one the card showed, in a window of the same project,
// trusted, with project context on; the project sharing grant is never read
// (DEC-PLANCHAT-026). The executor (src/proposal-apply.js) then checks every
// target again and makes the one editor edit.

const crypto = require('node:crypto');
const path = require('node:path');
const { PROPOSAL_LIMITS, computeEdits, proposalDigest, textSha256, applyEdits } = require('./proposal');
const { applyProposal, captureBase, checkDisk, checkOpenDocument } = require('./proposal-apply');

const SCHEME = 'kenlith-review';
const NOTE = 'Nothing has been changed. After your answer the user sees the exact diff and may apply or reject it. Do not say the change was made.';

const REASONS = {
  'unsaved-changes': (file) => `${file} has unsaved edits. Save or discard them in the editor, then ask again.`,
  'unsaved-kenlith-apply': (file) => `${file} has unsaved changes from Kenlith's previous Apply. Save them, or Undo them, then ask again.`,
  changed: (file) => `Out of date: ${file} changed after this proposal. Ask again for a new proposal.`,
  replaced: (file) => `Out of date: ${file} was replaced after this proposal. Ask again for a new proposal.`,
  missing: (file) => `Out of date: ${file} is no longer in the project. Ask again for a new proposal.`,
  'editor-out-of-date': (file) => `The editor shows different text for ${file} than the saved file. Save or reload it, then ask again.`,
  'other-project': () => 'This window has a different project open. Open the proposal\'s project to apply it, or ask again here.',
  untrusted: () => 'This workspace is not trusted, so Kenlith cannot change files in it.',
  'context-off': () => 'Project context is turned off, so Kenlith cannot change project files.',
  'proposals-off': () => 'Change proposals are turned off in the settings.',
  'editor-refused': () => 'Apply failed: the editor refused the change. Nothing was changed.',
  partial: (files) => `Apply failed part way: ${files} changed in the editor and the rest did not. Use Undo to go back, and check the files before saving.`,
  'result-differs': (file) => `Apply failed: after the change, ${file} does not hold the reviewed text. Use Undo to go back, and check the files before saving.`,
  interrupted: () => 'Apply did not finish: Kenlith closed while applying. Check the files before you save them.',
  corrupt: () => 'This stored proposal is damaged, so it cannot be applied.',
  digest: () => 'This proposal changed or is no longer current. Nothing was changed.'
};

function reasonText(reason) {
  if (!reason) return '';
  const make = REASONS[reason.code];
  return make ? make(reason.relPath || 'a file') : `Not available: ${reason.detail || reason.code}${reason.relPath ? ` (${reason.relPath})` : ''}.`;
}

class ProposalDraft {
  // `isOwnApply(relPath, textSha256)`: whether that text is the unsaved result
  // of an earlier Kenlith Apply (0.7.0, for a specific refusal message).
  constructor({ chatId, project, editor, isOwnApply = () => false }) {
    this.chatId = chatId;
    this.project = project; // { keyId, label, root }
    this.editor = editor;
    this.isOwnApply = isOwnApply;
    this.messageId = undefined;
    this.files = new Map(); // relPath -> { relPath, base, baseText, edits, removedLines, addedLines }
    this.summaries = [];
    this.refusals = [];
    this.calls = 0;
    this.replaceChars = 0;
    this.discarded = false;
  }

  // A call refused by the tool turn before it reached the draft (its path is
  // not in the project listing, or not allowed): kept for the card only.
  refused({ path: rawPath, reason }) {
    if (this.discarded || this.refusals.length >= 20) return;
    this.refusals.push({ relPath: String(rawPath).replace(/[\u0000-\u001F\u007F]/g, ' '), code: String(reason) });
  }

  // One project_propose_edit call whose path the tool turn has already
  // found in the project listing. Returns the tool result (no project text).
  async propose({ relPath, summary, edits }) {
    const refuse = (reason, detail) => {
      this.refusals.push({ relPath, code: reason, detail });
      return { ok: false, reason, ...(detail ? { detail } : {}) };
    };
    if (this.discarded) return refuse('cancelled');
    if (this.calls >= PROPOSAL_LIMITS.maxCalls) return refuse('budget', 'too many proposal calls in one answer');
    this.calls += 1;
    const replaceChars = edits.reduce((sum, edit) => sum + edit.replace.length, 0);
    if (this.replaceChars + replaceChars > PROPOSAL_LIMITS.maxReplyReplaceChars) return refuse('budget', 'the replacement text is too long for one answer');
    const existing = this.files.get(relPath);
    if (!existing && this.files.size >= PROPOSAL_LIMITS.maxFiles) return refuse('budget', `at most ${PROPOSAL_LIMITS.maxFiles} files per answer`);
    const captured = await captureBase(this.project.root, relPath, this.editor);
    if (!captured.ok && captured.code === 'unsaved-changes') {
      // 0.7.0: the unsaved changes may be Kenlith's own earlier Apply.
      const document = this.editor.findDocument(path.join(this.project.root, ...relPath.split('/')));
      if (document && this.isOwnApply(relPath, textSha256(document.getText()))) {
        return refuse('unsaved-kenlith-apply', "The file has unsaved changes from Kenlith's previous Apply. Save them, or Undo them, then ask again.");
      }
    }
    if (!captured.ok) return refuse(captured.code, captured.detail);
    if (existing && captured.base.sha256 !== existing.base.sha256) return refuse('changed', 'the file changed since the earlier proposal in this answer');
    if (existing && (existing.edits.length + edits.length) > PROPOSAL_LIMITS.maxEditsPerFile) return refuse('budget', `at most ${PROPOSAL_LIMITS.maxEditsPerFile} edits per file`);
    const computed = computeEdits(captured.text, edits, existing?.edits || []);
    if (!computed.ok) return refuse(computed.reason, computed.detail);
    this.replaceChars += replaceChars;
    this.files.set(relPath, { relPath, base: captured.base, baseText: captured.text, edits: computed.edits, removedLines: computed.removedLines, addedLines: computed.addedLines });
    const line = String(summary).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (line && !this.summaries.includes(line)) this.summaries.push(line);
    return { ok: true, recorded: true, path: relPath, edits: computed.edits.length, note: NOTE };
  }
}

class ReviewService {
  // options: { store (ProposalStore), editor (adapter), vscode-like { workspace },
  //   getProject: () => { keyId, label, root } | undefined,
  //   isTrusted: () => boolean, contextEnabled: () => boolean, proposalsEnabled: () => boolean,
  //   onChanged: (chatId) => void, makeUri: (relPath, query) => uri }
  constructor(options) {
    this.store = options.store;
    this.editor = options.editor;
    this.getProject = options.getProject;
    this.isTrusted = options.isTrusted || (() => true);
    this.contextEnabled = options.contextEnabled || (() => true);
    this.proposalsEnabled = options.proposalsEnabled || (() => true);
    this.onChanged = options.onChanged || (() => undefined);
    this.makeUri = options.makeUri;
    this.applying = new Set();
    // Diff documents served by provideTextDocumentContent: key -> text.
    this.contents = new Map();
    this.recheckTimer = undefined;
    this.loaded = this.store.load().then(() => this.recover()).catch(() => undefined);
  }

  // ---------- during a reply ----------

  // `project`: { keyId, label, root } of the tool turn (its resolved root).
  beginTurn(chatId, project) {
    if (!project?.root || !project.keyId || !this.proposalsEnabled()) return undefined;
    const isOwnApply = (relPath, hash) => this.store.cache.proposals.some((proposal) => proposal.state === 'applied'
      && proposal.project.keyId === project.keyId
      && proposal.files.some((file) => file.relPath === relPath && file.proposedTextSha256 === hash));
    return new ProposalDraft({ chatId, project, editor: this.editor, isOwnApply });
  }

  // After the reply ended and its slot was released. `completed`: the reply
  // finished normally. Returns the stored proposal, if any.
  async finalize(draft, { completed, messageId } = {}) {
    if (!draft) return undefined;
    const keep = completed && !draft.discarded && (draft.files.size || draft.refusals.length);
    draft.discarded = true;
    if (!keep) {
      if (draft.files.size) this.onChanged(draft.chatId, { note: 'The proposed changes were dropped because the answer did not finish. Nothing was changed.' });
      return undefined;
    }
    const files = [...draft.files.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1)).map((file) => ({
      relPath: file.relPath,
      base: file.base,
      edits: file.edits,
      proposedTextSha256: textSha256(applyEdits(file.baseText, file.edits)),
      removedLines: file.removedLines,
      addedLines: file.addedLines
    }));
    const now = new Date().toISOString();
    const proposal = {
      id: crypto.randomUUID(),
      version: 1,
      chatId: draft.chatId,
      messageId: messageId || draft.messageId,
      createdAt: now,
      state: files.length ? 'review' : 'refused',
      stateAt: now,
      // The project's identity only (never its folder path); Apply uses the
      // window's own root after the identity matches.
      project: { keyId: draft.project.keyId, label: draft.project.label },
      summary: draft.summaries.join(' ').slice(0, PROPOSAL_LIMITS.maxSummaryChars),
      digest: proposalDigest(files),
      files,
      refusals: draft.refusals.slice(0, 20).map((item) => ({ relPath: String(item.relPath || ''), code: String(item.code), ...(item.detail ? { detail: String(item.detail) } : {}) })),
      ...(files.length ? {} : { reason: { code: draft.refusals[0]?.code || 'refused', relPath: draft.refusals[0]?.relPath, detail: draft.refusals[0]?.detail } })
    };
    const stored = await this.store.add(proposal);
    // The reply took time: a target may already have changed.
    if (stored.state === 'review') await this.#recheck(stored);
    this.onChanged(stored.chatId);
    return this.store.get(stored.id) || stored;
  }

  // An Apply left `applying` (a window that quit, or an end state that could
  // not be written) becomes `failed` (interrupted); never resumed.
  async recover() {
    const changed = await this.store.recoverInterrupted(this.applying).catch(() => []);
    for (const id of changed) this.onChanged(this.store.get(id)?.chatId);
    return changed;
  }

  // ---------- status and cards ----------

  // 'applying' | 'review' | undefined, for the chat status (§3.2).
  statusOf(chatId) {
    const mine = this.store.forChat(chatId);
    if (mine.some((proposal) => proposal.state === 'applying')) return 'applying';
    if (mine.some((proposal) => proposal.state === 'review')) return 'review';
    return undefined;
  }

  // Cards for a chat's webview, rechecked so none offers a stale Apply.
  async cardsFor(chatId) {
    await this.loaded;
    if (this.store.forChat(chatId).some((proposal) => proposal.state === 'applying')) await this.recover();
    const out = [];
    for (const proposal of this.store.forChat(chatId)) {
      const current = proposal.state === 'review' ? (await this.#recheck(proposal)) : proposal;
      out.push(card(current));
    }
    return out;
  }

  // ---------- decisions ----------

  async reject(proposalId) {
    await this.loaded;
    const done = await this.store.transition(proposalId, 'review', 'rejected');
    if (done) this.onChanged(done.chatId);
    return done;
  }

  // Apply from a Kenlith webview (the engine has checked that the surface
  // shows this chat and is not read-only). Never retried.
  async apply(proposalId, digest) {
    await this.loaded;
    const proposal = this.store.get(proposalId);
    if (!proposal || proposal.state !== 'review') return { ok: false, code: 'not-current' };
    if (typeof digest !== 'string' || digest !== proposal.digest) return { ok: false, code: 'digest', text: REASONS.digest() };
    const blocked = await this.#windowBlock(proposal);
    if (blocked) {
      // Another project: refused here, left for the window of its project.
      // Trust, project context or proposals off: no longer actionable.
      if (blocked.code === 'other-project') return { ok: false, code: blocked.code, text: reasonText(blocked) };
      const done = await this.store.transition(proposal.id, 'review', 'invalidated', { reason: blocked });
      if (done) this.onChanged(done.chatId);
      return { ok: false, code: blocked.code };
    }
    if (this.applying.has(proposal.id)) return { ok: false, code: 'busy' };
    this.applying.add(proposal.id);
    try {
      const claimed = await this.store.transition(proposal.id, 'review', 'applying', { apply: { windowId: this.store.windowId, at: new Date().toISOString() } });
      if (!claimed) return { ok: false, code: 'not-current' };
      this.onChanged(claimed.chatId);
      const root = (await this.getProject())?.root;
      const result = root ? await applyProposal(claimed, { root, editor: this.editor, hooks: this.hooks || {} }) : { ok: false, stage: 'validate', code: 'other-project' };
      if (result.ok) {
        const done = await this.#record(claimed, 'applied', { apply: { ...claimed.apply, result: 'applied' } }, 'The change was applied in the editor, but Kenlith could not record it. Check the files before you save them.');
        await this.editor.show?.(result.documents);
        this.onChanged(claimed.chatId);
        return { ok: true, proposal: done };
      }
      // The editor refused, but some documents no longer hold their base:
      // never "nothing was changed"; the files are named.
      const partial = result.stage === 'apply' && result.unchanged === false;
      const reason = partial
        ? { code: 'partial', relPath: result.differs.join(', '), differs: result.differs }
        : { code: result.code, ...(result.relPath ? { relPath: result.relPath } : {}), ...(result.detail ? { detail: result.detail } : {}), ...(result.differs?.length ? { differs: result.differs } : {}) };
      const to = result.stage === 'validate' ? 'invalidated' : 'failed';
      const done = await this.#record(claimed, to, { reason, apply: { ...claimed.apply, result: result.stage } }, `${reasonText(reason)} Kenlith could not record this result.`);
      this.onChanged(claimed.chatId);
      return { ok: false, code: reason.code, stage: result.stage, proposal: done };
    } finally {
      this.applying.delete(proposal.id);
    }
  }

  // The end state of an Apply. If the store cannot be written (lock busy,
  // disk), the outcome is told to the user, and the record left in
  // `applying` becomes `failed` (interrupted) at the next recovery, which
  // also asks to check the files. Nothing is retried on the files.
  async #record(claimed, to, extra, note) {
    try {
      const done = await this.store.transition(claimed.id, 'applying', to, extra);
      if (!done) this.onChanged(claimed.chatId, { note });
      return done;
    } catch {
      this.onChanged(claimed.chatId, { note });
      return undefined;
    }
  }

  // ---------- diff ----------

  // Opens the editor diff for one file of a proposal: base (as verified on
  // disk now) against the proposed text. Both sides are read-only documents.
  async showDiff(proposalId, relPath) {
    await this.loaded;
    const proposal = this.store.get(proposalId);
    const file = proposal?.files.find((candidate) => candidate.relPath === relPath);
    if (!file) return { ok: false, code: 'missing' };
    const project = await this.getProject();
    if (!project || project.keyId !== proposal.project.keyId) return { ok: false, code: 'other-project', text: reasonText({ code: 'other-project' }) };
    const disk = await checkDisk(project.root, file);
    let baseText;
    if (disk.ok) baseText = disk.text;
    else {
      if (proposal.state === 'review') {
        const done = await this.store.transition(proposal.id, 'review', 'invalidated', { reason: { code: disk.code, relPath: file.relPath, detail: disk.detail } });
        if (done) this.onChanged(done.chatId);
      }
      return { ok: false, code: disk.code, text: reasonText({ code: disk.code, relPath: file.relPath }) };
    }
    const key = `${proposal.id}/${file.relPath}`;
    this.contents.set(`base:${key}`, baseText);
    this.contents.set(`proposed:${key}`, applyEdits(baseText, file.edits));
    const name = path.posix.basename(file.relPath);
    const state = proposal.state === 'applied' ? 'applied' : proposal.state === 'review' ? 'not applied' : proposal.state;
    await this.editor.showDiff(this.makeUri(file.relPath, `side=base&key=${encodeURIComponent(key)}`), this.makeUri(file.relPath, `side=proposed&key=${encodeURIComponent(key)}`), `${name}: current ↔ proposed by ChatGPT (${state})`);
    return { ok: true };
  }

  provideTextDocumentContent(uri) {
    const query = new URLSearchParams(String(uri.query || ''));
    return this.contents.get(`${query.get('side')}:${query.get('key')}`) ?? '';
  }

  // ---------- invalidation ----------

  // A document change, save, file change or project change: recheck soon.
  touched() {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => this.recheckAll().catch(() => undefined), 250);
    this.recheckTimer.unref?.();
  }

  // Rechecks every proposal of this window's project still in review, now.
  async recheckAll() {
    await this.loaded;
    await this.recover();
    for (const proposal of this.store.cache.proposals) {
      if (proposal.state === 'review' && !this.applying.has(proposal.id)) await this.#recheck(proposal);
    }
  }

  // This window's project changed: its proposals in review stop being
  // actionable here (the workspace identity changed).
  // The proposals stay in the shared store (another window of that project
  // may still apply them); here, Apply checks the window's project and
  // refuses them, and their chat is read-only in this window anyway.
  async projectChanged() {
    await this.loaded;
    this.onChanged(undefined);
  }

  // A document of a target changed: an open dirty target invalidates at once.
  documentChanged(fsPath) {
    const name = path.normalize(String(fsPath || ''));
    const ends = (relPath) => {
      const tail = path.normalize(path.join(path.sep, ...relPath.split('/')));
      return process.platform === 'win32' ? name.toLowerCase().endsWith(tail.toLowerCase()) : name.endsWith(tail);
    };
    let outcomes = false;
    for (const proposal of this.store.cache.proposals) {
      if (this.applying.has(proposal.id) || !proposal.files.some((file) => ends(file.relPath))) continue;
      if (proposal.state === 'review') this.touched();
      // 0.7.0: an applied proposal follows Undo and Redo of its documents.
      if (proposal.state === 'applied' || proposal.state === 'reverted') outcomes = true;
    }
    if (outcomes) {
      clearTimeout(this.outcomeTimer);
      this.outcomeTimer = setTimeout(() => this.recheckOutcomes().catch(() => undefined), 250);
      this.outcomeTimer.unref?.();
    }
  }

  // Applied proposals whose documents now hold their base text again are
  // `reverted`; reverted ones holding the reviewed result again are `applied`.
  // Only open documents are read; neither state can be applied again.
  async recheckOutcomes() {
    await this.loaded;
    const project = await this.getProject();
    if (!project) return;
    for (const proposal of this.store.cache.proposals) {
      if ((proposal.state !== 'applied' && proposal.state !== 'reverted') || proposal.project.keyId !== project.keyId) continue;
      const texts = proposal.files.map((file) => this.editor.findDocument(path.join(project.root, ...file.relPath.split('/'))));
      if (texts.some((document) => !document)) continue;
      const hashes = texts.map((document) => textSha256(document.getText()));
      const allBase = proposal.files.every((file, index) => hashes[index] === file.base.textSha256);
      const allProposed = proposal.files.every((file, index) => hashes[index] === file.proposedTextSha256);
      let done;
      if (proposal.state === 'applied' && allBase) done = await this.store.markOutcome(proposal.id, 'applied', 'reverted');
      else if (proposal.state === 'reverted' && allProposed) done = await this.store.markOutcome(proposal.id, 'reverted', 'applied');
      if (done) this.onChanged(done.chatId);
    }
  }

  async #windowBlock(proposal) {
    const project = await this.getProject();
    if (!project || project.keyId !== proposal.project.keyId) return { code: 'other-project' };
    if (!this.isTrusted()) return { code: 'untrusted' };
    if (!this.contextEnabled()) return { code: 'context-off' };
    if (!this.proposalsEnabled()) return { code: 'proposals-off' };
    return undefined;
  }

  async #recheck(proposal) {
    if (proposal.state !== 'review') return proposal;
    // Another window's project: shown, never applied here; not invalidated
    // from here either (that window may still apply it).
    const project = await this.getProject();
    if (!project || project.keyId !== proposal.project.keyId) return proposal;
    let reason = await this.#windowBlock(proposal);
    for (const file of reason ? [] : proposal.files) {
      const disk = await checkDisk(project.root, file);
      if (!disk.ok) { reason = { code: disk.code, relPath: file.relPath, detail: disk.detail }; break; }
      const open = checkOpenDocument(project.root, file, this.editor);
      if (!open.ok) { reason = { code: open.code, relPath: file.relPath, detail: open.detail }; break; }
    }
    if (!reason) return proposal;
    const done = await this.store.transition(proposal.id, 'review', 'invalidated', { reason });
    if (done) this.onChanged(done.chatId);
    return done || this.store.get(proposal.id) || proposal;
  }
}

// What the webview shows for a proposal (host-made text; the summary is
// model text, shown as text).
function card(proposal) {
  const files = proposal.files.map((file) => ({ relPath: file.relPath, removedLines: file.removedLines, addedLines: file.addedLines }));
  const status = {
    review: 'Ready to review. Nothing has been changed yet.',
    applying: 'Applying…',
    applied: `Applied to ${files.length} ${files.length === 1 ? 'file' : 'files'} in the editor. Not saved yet: Save to keep the change, or Undo to revert it.`,
    reverted: 'Undone in the editor: nothing from this proposal remains. To change the file again, ask for a new proposal.',
    rejected: 'Rejected. Nothing was changed.',
    discarded: 'Dropped. Nothing was changed.'
  }[proposal.state] || reasonText(proposal.reason);
  return {
    id: proposal.id,
    messageId: proposal.messageId,
    state: proposal.state,
    digest: proposal.state === 'review' ? proposal.digest : undefined,
    summary: proposal.summary || '',
    files,
    refusals: proposal.state === 'refused' ? (proposal.refusals || []).map((item) => ({ relPath: item.relPath, text: reasonText(item) })) : [],
    status,
    actionable: proposal.state === 'review'
  };
}

module.exports = { NOTE, ProposalDraft, ReviewService, SCHEME, card, reasonText };
