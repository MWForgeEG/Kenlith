'use strict';

// Scenario "restart-review" for test/integration/restart-review.js (0.6.0):
// proposals left in Awaiting Review across a normal editor restart, in a real
// editor, without a model request. Phase 1 makes five proposals through the
// review service's own draft path (real base snapshots of real files, real
// editor documents) and quits normally without Apply or Reject. Between the
// phases the runner changes one target on disk and stores a copy of another
// proposal under a different project identity. Phase 2 checks what the
// restarted editor does with each of them. The two sides hand over through
// files in PLAN_CHAT_IT_UI_DIR.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { applyEdits } = require('../src/proposal');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FILES = { p1: 'src/apply.js', p2: 'src/stale.js', p3: 'src/dirty.js', p4: 'src/reject.js', p5: 'src/control.js' };

async function run(engine) {
  const dir = process.env.PLAN_CHAT_IT_UI_DIR;
  const phase = process.env.PLAN_CHAT_IT_PHASE || '1';
  const out = (name, data) => fs.writeFileSync(path.join(dir, `rr-${name}.json`), JSON.stringify(data, null, 2));
  const read = (name) => { const file = path.join(dir, `rr-${name}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const full = (rel) => path.join(root, ...rel.split('/'));
  const hash = (rel) => crypto.createHash('sha256').update(fs.readFileSync(full(rel))).digest('hex');
  const hashes = () => Object.fromEntries(Object.values(FILES).map((rel) => [rel, hash(rel)]));
  const review = engine.review;
  const store = engine.store;
  try {
    await review.loaded;
    if (phase === '1') {
      // The window's project, as the review service sees it.
      let project;
      for (let i = 0; i < 40 && !(project = await engine.review.getProject()); i += 1) await sleep(250);
      if (!project) throw new Error('no project identity in this window');
      const made = {};
      for (const [key, rel] of Object.entries(FILES)) {
        store.currentId = undefined;
        const chat = await store.newConversation();
        await store.addMessage('user', `Restart check ${key}: please change ${rel}`, chat.id);
        const reply = await store.addMessage('assistant', `Proposed a change to ${rel}; review the diff.`, chat.id);
        const draft = review.beginTurn(chat.id, project);
        if (!draft) throw new Error('proposals are off');
        const result = await draft.propose({ relPath: rel, summary: `Restart check ${key}`, edits: [{ find: 'value = 1;', replace: 'value = 2;' }] });
        if (!result.ok) throw new Error(`propose ${key}: ${JSON.stringify(result)}`);
        const proposal = await review.finalize(draft, { completed: true, messageId: reply.id });
        made[key] = { id: proposal.id, chatId: chat.id, digest: proposal.digest, state: proposal.state, relPath: rel, baseSha256: proposal.files[0].base.sha256 };
      }
      // P1's chat stays open in a tab across the restart.
      await vscode.commands.executeCommand('planChat.openChat', { type: 'chat', item: { id: made.p1.chatId } });
      await sleep(1500);
      out('ready-1', { made, hashes: hashes(), states: review.store.cache.proposals.map((p) => [p.id, p.state]) });
      await sleep(500);
      // A normal quit: nothing applied, nothing rejected.
      await vscode.commands.executeCommand('workbench.action.quit');
      return;
    }

    // ---------- phase 2: after the restart ----------
    const before = read('ready-1');
    const between = read('between');
    await sleep(4000);
    await review.store.load();
    const stateOf = (id) => review.store.get(id)?.state;
    const reasonOf = (id) => review.store.get(id)?.reason?.code;
    const report = { restoredStates: Object.fromEntries(Object.entries(before.made).map(([key, made]) => [key, stateOf(made.id)])), otherProjectCopy: stateOf(between.copyId) };
    report.hashesAtStart = hashes();
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview).map((tab) => tab.label);
    report.tabs = tabs;
    report.dirtyAtStart = vscode.workspace.textDocuments.filter((doc) => doc.uri.scheme === 'file' && doc.isDirty).map((doc) => doc.uri.fsPath);

    // Cards as the restored chats show them (each is rechecked first).
    const cards = {};
    for (const [key, made] of Object.entries(before.made)) cards[key] = (await review.cardsFor(made.chatId)).map((card) => ({ state: card.state, actionable: card.actionable, status: card.status }));
    report.cards = cards;

    // P2: its file was changed on disk while the editor was closed.
    report.p2 = { applyResult: await review.apply(before.made.p2.id, before.made.p2.digest), state: stateOf(before.made.p2.id), reason: reasonOf(before.made.p2.id), fileIsRunnersVersion: hash(FILES.p2) === between.p2Sha256 };

    // P3: the user edits the file after the restart, without saving.
    const dirtyDoc = await vscode.workspace.openTextDocument(full(FILES.p3));
    const typed = new vscode.WorkspaceEdit();
    typed.insert(dirtyDoc.uri, new vscode.Position(0, 0), '// my unsaved edit\n');
    await vscode.workspace.applyEdit(typed);
    await sleep(800);
    report.p3 = { stateAfterEdit: stateOf(before.made.p3.id), applyResult: await review.apply(before.made.p3.id, before.made.p3.digest), state: stateOf(before.made.p3.id), reason: reasonOf(before.made.p3.id), userEditKept: dirtyDoc.getText().startsWith('// my unsaved edit\n'), diskUnchanged: hash(FILES.p3) === before.hashes[FILES.p3] };
    await vscode.window.showTextDocument(dirtyDoc);
    await vscode.commands.executeCommand('workbench.action.files.revert');

    // P5 copy stored under another project's identity: refused here, kept.
    report.p5copy = { applyResult: await review.apply(between.copyId, before.made.p5.digest), state: stateOf(between.copyId), fileUnchanged: hash(FILES.p5) === before.hashes[FILES.p5] };

    // P4: Reject writes nothing and the proposal can never be applied.
    await review.reject(before.made.p4.id);
    report.p4 = { state: stateOf(before.made.p4.id), applyAfterReject: await review.apply(before.made.p4.id, before.made.p4.digest), fileUnchanged: hash(FILES.p4) === before.hashes[FILES.p4], document: vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath.toLowerCase() === full(FILES.p4).toLowerCase() && doc.isDirty) };

    // P1: a wrong digest is refused; the exact proposal applies, unsaved.
    const wrong = await review.apply(before.made.p1.id, before.made.p5.digest === before.made.p1.digest ? 'x' : before.made.p5.digest);
    const stateAfterWrong = stateOf(before.made.p1.id);
    const base1 = fs.readFileSync(full(FILES.p1), 'utf8');
    const applied = await review.apply(before.made.p1.id, before.made.p1.digest);
    const doc1 = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath.toLowerCase() === full(FILES.p1).toLowerCase());
    const proposal1 = review.store.get(before.made.p1.id);
    report.p1 = {
      wrongDigest: wrong, stateAfterWrong,
      applyResult: { ok: applied.ok, code: applied.code }, state: stateOf(before.made.p1.id),
      editorText: doc1?.getText(), expected: applyEdits(base1, proposal1.files[0].edits), dirty: Boolean(doc1?.isDirty),
      diskUnchanged: hash(FILES.p1) === before.hashes[FILES.p1]
    };
    if (doc1) { await vscode.window.showTextDocument(doc1); await vscode.commands.executeCommand('workbench.action.files.revert'); }

    // P5 itself: still waiting for review and still actionable (control).
    report.p5 = { state: stateOf(before.made.p5.id), card: (await review.cardsFor(before.made.p5.chatId))[0] };
    report.hashesAtEnd = hashes();
    out('state-2', report);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);
    await vscode.commands.executeCommand('workbench.action.quit');
  } catch (error) {
    out(`error-${phase}`, { error: String(error?.stack || error) });
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

module.exports = { run };
