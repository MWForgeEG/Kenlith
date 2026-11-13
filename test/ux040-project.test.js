'use strict';

// 0.4.0 workspace with project context (UX-06 #2, #9, #11, #12, #21): several
// editor tabs of one window share one engine; consent cards belong to their
// chat; revocation and the kill switch reach every tab; a pending attachment
// stays with its chat. Synthetic projects and a stub transport that runs the
// preflight gate where the real one does (as test/m1-4.test.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, createEditor, createTextDocument, makeTempDir, setActiveTextEditor, setWorkspaceFolders, vscode } = require('./helpers/fake-vscode');
const { ConsentStore } = require('../src/consent');
const { isBuiltRequest } = require('../src/request-builder');
const { ConversationStore } = require('../src/store');
const { ChatEngine } = require('../src/engine');
const { ChatPanels } = require('../src/panels');

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('Network is blocked in this test file.'); }; });
test.after(() => { globalThis.fetch = realFetch; });
test.beforeEach(() => { calls.panels.length = 0; });
test.afterEach(() => {
  setWorkspaceFolders(undefined);
  config.reset();
  vscode.workspace.isTrusted = true;
  calls.warningChoice = 'Sign Out';
  calls.quickPick = undefined;
});

const SECRET = 'AK' + 'IAABCDEFGHIJKLMNOP';
function projectFolder(name = 'calc') {
  const directory = path.join(makeTempDir(), name);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true }); fs.writeFileSync(path.join(directory, rel), text); };
  write('src/calculator.js', 'function addAll(list) {\n  // sums every number in the list\n  return list.reduce((sum, value) => sum + value);\n}\nmodule.exports = { addAll };\n');
  write('.env', `API_KEY=${SECRET}\n`);
  write('src/keys.js', `const key = '${SECRET}'; // addAll credentials\n`);
  return directory;
}

async function openWindow({ storageDir = makeTempDir(), subject = 'user-1' } = {}) {
  const context = createContext({ storageDir });
  const session = { email: 'synthetic.user@example.test', subject, scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const sent = [];
  const behaviour = { hangFor: undefined, started: undefined };
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ request, onDelta, signal, preflight }) {
      assert.ok(isBuiltRequest(request), 'only built requests reach the transport');
      if (preflight) await preflight();
      sent.push({ messages: request.messages.map((m) => ({ ...m })), excerpts: request.excerpts?.length || 0 });
      const question = request.messages.at(-1).content;
      if (behaviour.hangFor && question.includes(behaviour.hangFor)) {
        onDelta('partial ');
        behaviour.started?.();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      onDelta(`reply ${sent.length}`);
    }
  };
  const store = new ConversationStore(context);
  const engine = new ChatEngine(context, auth, openai, store, { writeClipboard: async () => {}, openExternal: async () => {} });
  await engine.prepare();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const tab = async () => {
    store.currentId = undefined;
    const chat = await store.newConversation();
    await panels.openChat(chat.id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    const posted = (type) => panel.posted.filter((message) => message.type === type);
    return {
      id: chat.id,
      panel,
      send: (text) => panel.send({ type: 'send', text, model: 'model-a' }),
      decide: (choice) => panel.send({ type: 'consentDecision', choice }),
      card: () => posted('consent').at(-1)?.consent,
      notice: () => posted('consent').at(-1)?.notice,
      notes: () => posted('contextNote').map((m) => m.text).filter(Boolean)
    };
  };
  return { context, store, engine, panels, sent, behaviour, tab };
}

const waitFor = async (predicate, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met');
};

test('UX-06 #2 a consent card belongs to its chat: shown only in that tab, and decided only there', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const b = await w.tab();
  await b.send('Why does addAll fail on an empty list?');
  assert.ok(b.card(), 'B shows the card');
  assert.equal(a.card(), undefined, 'A never shows B\'s card');
  // A decision sent from A changes nothing for B's card.
  await a.decide('allow');
  assert.equal(w.sent.length, 0);
  assert.equal((await new ConsentStore(w.context.storageDir).list()).length, 0, 'nothing was granted from another tab');
  assert.equal(w.engine.chatStatus(b.id), 'consent');
  await b.decide('allow');
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0].excerpts >= 1);
  assert.ok(!JSON.stringify(w.sent[0]).includes(SECRET), 'sensitive files are never sent');
});

test('UX-06 #21 a consent decision while another chat replies waits and says why; nothing is sent', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const b = await w.tab();
  await b.send('Why does addAll fail on an empty list?');
  assert.ok(b.card());
  w.behaviour.hangFor = 'unrelated';
  let started;
  const streaming = new Promise((resolve) => { w.behaviour.started = resolve; });
  const replying = a.send('An unrelated question');
  await streaming;
  started = w.sent.length;
  await b.decide('allow');
  assert.equal(w.sent.length, started, 'B sent nothing while A replies');
  assert.match(b.notice(), /Kenlith is replying in "An unrelated question"\. Choose again when that reply ends/);
  assert.ok(b.card(), 'the card stays');
  assert.equal((await new ConsentStore(w.context.storageDir).list()).length, 0, 'nothing was granted');
  w.engine.stop(a.id);
  await replying;
  await b.decide('allow');
  assert.equal(w.sent.length, started + 1, 'after A ends, B\'s decision sends');
});

test('UX-06 #9 revocation reaches every tab: a project reply stops, the next question asks again', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const b = await w.tab();
  await a.send('Why does addAll fail on an empty list?');
  await a.decide('allow');
  assert.equal(w.sent.length, 1);
  w.behaviour.hangFor = 'addAll';
  const streaming = new Promise((resolve) => { w.behaviour.started = resolve; });
  const replying = b.send('How would you fix addAll?');
  await streaming;
  assert.ok(w.sent[1].excerpts >= 1, 'B used the grant');
  calls.quickPick = (items) => items[0];
  calls.warningChoice = 'Stop Sharing';
  await w.engine.manageProjectSharing();
  await replying;
  assert.ok(b.notes().some((text) => /Project sharing was stopped during this reply/.test(text)));
  w.behaviour.hangFor = undefined;
  await a.send('And what about addAll with strings?');
  assert.ok(a.card(), 'A asks again after the revoke');
  assert.equal(w.sent.length, 2);
});

test('UX-06 kill switch: turning project context off stops a project reply in another tab; later questions send no project files', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const b = await w.tab();
  const c = await w.tab();
  await a.send('Why does addAll fail on an empty list?');
  await a.decide('allow');
  await c.send('Explain addAll please');
  // C's card waits only if the grant was not used: grant is active, so C replied.
  w.behaviour.hangFor = 'fix addAll';
  const streaming = new Promise((resolve) => { w.behaviour.started = resolve; });
  const replying = b.send('How would you fix addAll?');
  await streaming;
  config.layers.global['planChat.projectContext.enabled'] = false;
  w.engine.configurationChanged({ affectsConfiguration: (key) => key === 'planChat.projectContext.enabled' });
  await replying;
  assert.equal(w.engine.chatStatus(b.id), undefined, 'the project reply stopped');
  const before = w.sent.length;
  await a.send('More about addAll');
  assert.equal(w.sent.length, before + 1);
  assert.equal(w.sent.at(-1).excerpts, 0, 'nothing from the project is sent with the switch off');
});

test('UX-06 #11 a pending attachment stays with its chat: other tabs cannot send it, and it is sent once', async () => {
  const directory = projectFolder();
  setWorkspaceFolders([directory]);
  const w = await openWindow();
  const a = await w.tab();
  const b = await w.tab();
  const file = path.join(directory, 'src', 'calculator.js');
  setActiveTextEditor(createEditor(createTextDocument({ path: file, text: fs.readFileSync(file, 'utf8'), languageId: 'javascript' }), [[0, 0, 2, 0]]));
  // Attach Selection goes to the tab used last: B.
  await b.panel.send({ type: 'attachSelection' });
  const card = b.panel.posted.filter((m) => m.type === 'attachment').at(-1).attachment;
  assert.ok(card, 'B shows the attachment');
  assert.equal(a.panel.posted.filter((m) => m.type === 'attachment' && m.attachment).length, 0, 'A never sees it');
  // A cannot approve or send B's attachment, even with its id.
  await a.panel.send({ type: 'approveAttachment', id: card.id, reviewed: true });
  assert.equal(w.engine.attachment.approved, false);
  await a.panel.send({ type: 'send', text: 'use the code', model: 'model-a', attachmentId: card.id });
  assert.equal(w.sent.length, 0, 'nothing sent from A');
  await b.panel.send({ type: 'approveAttachment', id: card.id, reviewed: true });
  await b.panel.send({ type: 'send', text: 'what does it do?', model: 'model-a', attachmentId: card.id });
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].messages.at(-1).content, /Code selection attached by the user/);
  await b.send('and again?');
  assert.doesNotMatch(w.sent.at(-1).messages.at(-1).content, /Code selection attached by the user/, 'sent once only');
});

test('UX-06 #21 project identity change: tabs of the old project become read-only, cards drop, nothing is sent', async () => {
  const first = projectFolder('alpha');
  const second = projectFolder('beta');
  setWorkspaceFolders([first]);
  const w = await openWindow();
  const a = await w.tab();
  await a.send('Why does addAll fail on an empty list?');
  assert.ok(a.card());
  setWorkspaceFolders([second]);
  await w.engine.workspaceChanged();
  assert.equal(a.card(), null, 'the card was dropped');
  assert.equal(w.engine.chatStatus(a.id), undefined);
  const shown = a.panel.posted.filter((m) => m.type === 'conversation').at(-1);
  assert.ok(shown.readOnly, 'the tab of the old project is read-only now');
  await a.send('Try to send into the old project');
  assert.equal(w.sent.length, 0);
});

test('UX-06 review #6 Allow after project context was turned off grants nothing and sends nothing', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  await a.send('Why does addAll fail on an empty list?');
  assert.ok(a.card());
  // Turned off without the change event reaching this window.
  config.layers.global['planChat.projectContext.enabled'] = false;
  await a.decide('allow');
  assert.equal(w.sent.length, 0);
  assert.equal((await new ConsentStore(w.context.storageDir).list()).length, 0, 'no grant was written');
  assert.match(a.notice(), /Project context is turned off/);
});

test('UX-06 review #8 closing a tab while its consent card waits keeps the question as the chat\'s draft', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  await a.send('Why does addAll fail on an empty list?');
  assert.ok(a.card());
  a.panel.dispose();
  const { DraftStore } = require('../src/drafts');
  const chat = await w.store.getConversation(a.id);
  const drafts = new DraftStore(w.context.storageDir);
  await waitFor(async () => (await drafts.get(a.id, chat.context)) === 'Why does addAll fail on an empty list?');
  assert.equal(w.engine.chatStatus(a.id), undefined);
  assert.equal(w.sent.length, 0);
});

// ---------- D-1: the composer after a Send that waits for project consent ----------
// RC4 live finding: the question came back into the message box while the
// card waited and stayed after the reply. These tests model the webview: it
// saves the typed text as a draft, then clears the box when Send is pressed.

const Q = 'Why does addAll fail on an empty list?';
const postsAfter = (panel, index, type) => panel.posted.slice(index).filter((m) => !type || m.type === type);
const shownDrafts = (panel, index) => postsAfter(panel, index).filter((m) => (m.type === 'conversation' || m.type === 'hydrate') && m.draft).map((m) => m.draft);
async function typeAndSend(tab, text, sendId) {
  await tab.panel.send({ type: 'draft', text, rev: Date.now() });
  const index = tab.panel.posted.length;
  await tab.panel.send({ type: 'send', text, model: 'model-a', sendId, draftRev: Date.now() });
  return index;
}
const storedDraft = async (w, id) => {
  const { DraftStore } = require('../src/drafts');
  return new DraftStore(w.context.storageDir).get(id, (await w.store.getConversation(id)).context);
};

test('D-1 RC4 sequence: the sent question does not come back while the card waits, nor after Allow and the reply', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const index = await typeAndSend(a, Q, 'd1');
  assert.ok(a.card(), 'the card is shown');
  assert.deepEqual(shownDrafts(a.panel, index), [], 'no refresh gives the question back while the card waits');
  assert.equal(await storedDraft(w, a.id), '', 'no unsent draft is shown for this chat while it waits');
  await a.decide('allow');
  assert.equal(w.sent.length, 1);
  assert.deepEqual(shownDrafts(a.panel, index), [], 'nor after Allow and the reply');
  assert.equal(postsAfter(a.panel, index, 'restoreDraft').length, 0);
  assert.equal(await storedDraft(w, a.id), '');
  const stored = await w.store.getConversation(a.id);
  assert.deepEqual(stored.messages.filter((m) => m.role === 'user').map((m) => m.content), [Q], 'the question is stored once');
  assert.deepEqual(stored.messages[0].contextUsed.map((u) => u.relPath).sort(), ['src/calculator.js']);
});

test('D-1 a draft typed while the card waits survives Allow, and is shown afterwards', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const index = await typeAndSend(a, Q, 'd2');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await a.panel.send({ type: 'draft', text: 'a newer, unrelated thought', rev: Date.now() });
  await a.decide('allow');
  assert.equal(await storedDraft(w, a.id), 'a newer, unrelated thought', 'resolving the card does not erase the newer draft');
  assert.ok(shownDrafts(a.panel, index).every((text) => text === 'a newer, unrelated thought'));
  assert.equal(w.sent.length, 1);
});

test('D-1 Cancel gives the question back once, as an unsent draft; nothing is sent', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const index = await typeAndSend(a, Q, 'd3');
  await a.decide('cancel');
  assert.deepEqual(postsAfter(a.panel, index, 'restoreDraft').map((m) => m.text), [Q], 'given back exactly once');
  // The release is written right after the card closes.
  await waitFor(async () => (await storedDraft(w, a.id)) === Q);
  assert.equal(await storedDraft(w, a.id), Q, 'kept as an unsent draft');
  assert.equal(w.sent.length, 0);
  assert.equal((await w.store.getConversation(a.id)).messages.length, 0, 'not in the history');
});

test('D-1 Send without project files: the question is sent once and not given back', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const index = await typeAndSend(a, Q, 'd4');
  await a.decide('without');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].excerpts, 0);
  assert.deepEqual(shownDrafts(a.panel, index), []);
  assert.equal(postsAfter(a.panel, index, 'restoreDraft').length, 0);
  assert.equal(await storedDraft(w, a.id), '');
});

test('D-1 a reload or tab switch while the card waits shows the card, not the question in the box', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  const b = await w.tab();
  const index = await typeAndSend(a, Q, 'd5');
  // The tab is hidden and shown again: its page reloads and says "ready".
  await b.panel.send({ type: 'ready' });
  await a.panel.send({ type: 'ready' });
  const hydrate = postsAfter(a.panel, index, 'hydrate').at(-1);
  assert.equal(hydrate.draft, '');
  assert.ok(postsAfter(a.panel, index, 'consent').at(-1).consent, 'the card is shown again');
  assert.deepEqual(shownDrafts(a.panel, index), []);
});

test('D-1 extension host restart while the card waits: the unsent question comes back once as a draft, never sent', async () => {
  setWorkspaceFolders([projectFolder()]);
  const storageDir = makeTempDir();
  const w = await openWindow({ storageDir });
  const a = await w.tab();
  await typeAndSend(a, Q, 'd6');
  assert.ok(a.card());
  w.engine.dispose();
  const again = await openWindow({ storageDir });
  const { DraftStore } = require('../src/drafts');
  const draft = await new DraftStore(storageDir).get(a.id, (await again.store.getConversation(a.id)).context);
  assert.equal(draft, Q, 'the question was never sent, so it is the chat\'s draft again');
  assert.equal(w.sent.length + again.sent.length, 0);
});

test('D-1 the same Send delivered twice while the card waits makes one card and, after Allow, one request', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  await a.panel.send({ type: 'draft', text: Q, rev: Date.now() });
  await Promise.all([
    a.panel.send({ type: 'send', text: Q, model: 'model-a', sendId: 'same', draftRev: Date.now() }),
    a.panel.send({ type: 'send', text: Q, model: 'model-a', sendId: 'same', draftRev: Date.now() })
  ]);
  await a.panel.send({ type: 'send', text: Q, model: 'model-a', sendId: 'same', draftRev: Date.now() });
  await a.decide('allow');
  await a.decide('allow');
  assert.equal(w.sent.length, 1);
  assert.equal((await w.store.getConversation(a.id)).messages.filter((m) => m.role === 'user').length, 1);
});

test('D-1 review #1: a reload while Send is still being prepared does not put the question back', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  await a.panel.send({ type: 'draft', text: Q, rev: Date.now() });
  // Hold the send inside its preparation (the account check is its first wait).
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const getSession = w.engine.authService.getSession;
  let first = true;
  w.engine.authService.getSession = async () => { if (first) { first = false; await gate; } return getSession(); };
  const index = a.panel.posted.length;
  const sending = a.panel.send({ type: 'send', text: Q, model: 'model-a', sendId: 'r1', draftRev: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await a.panel.send({ type: 'ready' });
  assert.equal(a.panel.posted.filter((m) => m.type === 'hydrate').at(-1).draft, '', 'not offered while Send is prepared');
  release();
  await sending;
  assert.ok(a.card());
  await a.decide('allow');
  assert.deepEqual(shownDrafts(a.panel, index), []);
  assert.equal(w.sent.length, 1);
});

test('D-1 review #1: a refused Send gives its text back, and the draft is offered again', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  await a.panel.send({ type: 'draft', text: 'x'.repeat(100_001), rev: Date.now() });
  await a.panel.send({ type: 'send', text: 'x'.repeat(100_001), model: 'model-a', sendId: 'big', draftRev: Date.now() });
  assert.equal(w.sent.length, 0);
  await a.panel.send({ type: 'ready' });
  assert.equal(a.panel.posted.filter((m) => m.type === 'hydrate').at(-1).draft.length, 100_000, 'the draft is offered again (stored up to its bound)');
});

test('D-1 review #2: with the drafts file locked by another window, the sent question is still not offered back', async () => {
  setWorkspaceFolders([projectFolder()]);
  const w = await openWindow();
  const a = await w.tab();
  await a.panel.send({ type: 'draft', text: Q, rev: Date.now() });
  const { acquireLock } = require('../src/lock');
  const lock = await acquireLock(path.join(w.context.storageDir, 'drafts.lock'));
  try {
    const index = a.panel.posted.length;
    await a.panel.send({ type: 'send', text: Q, model: 'model-a', sendId: 'l1', draftRev: Date.now() });
    await a.panel.send({ type: 'ready' });
    assert.deepEqual(shownDrafts(a.panel, index), [], 'held in memory although the write failed');
  } finally {
    await lock.release();
  }
});
