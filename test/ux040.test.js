'use strict';

const { HISTORICAL_SKIP } = require('./helpers/historical');

// 0.4.0 workspace (UX-01 to UX-04): editor tabs bound to chats, one engine per
// window, reply ownership across windows, partial replies, drafts, groups and
// the Chats list. Real AuthService, OpenAIService and store against the fake
// OpenAI server; fake editor API (test/helpers/fake-vscode.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, createContext } = require('./helpers/fake-vscode');
const { CLIENT_ID, FakeOpenAI, completedStream, hangingStream, storedCredentials, waitFor } = require('./helpers/fake-openai');
const { loadOldStore } = require('./helpers/old-release');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatEngine } = require('../src/engine');
const { ChatPanels } = require('../src/panels');
const { Sidebar, statusOf } = require('../src/sidebar');
const { DraftStore, MAX_CHARS, MAX_DRAFTS, tagSignature } = require('../src/drafts');
const { ReplyLeases, leaseName } = require('../src/lease');
const { mayReplay } = require('../src/provenance');

let server;
test.beforeEach(() => {
  server = new FakeOpenAI().install();
  server.responsesHandler = (request) => completedStream(`reply from ${request.json.model}`);
  calls.panels.length = 0;
  calls.serializers.clear();
  calls.quickPicks.length = 0;
  calls.quickPick = undefined;
  calls.inputBox = undefined;
  calls.warningChoice = 'Sign Out';
});
test.afterEach(() => server.uninstall());

// One window: real services, the engine, editor tabs. `shared` makes a
// second window on the same profile (storage, secrets, state).
async function openWindow(shared) {
  const context = createContext(shared);
  if (!shared) {
    context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
    context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  }
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  const engine = new ChatEngine(context, auth, new OpenAIService(auth), store);
  await engine.prepare();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  panels.register();
  const tab = async (chatId) => {
    const before = calls.panels.length;
    await panels.openChat(chatId);
    const panel = calls.panels.length > before ? calls.panels.at(-1) : calls.panels.find((candidate) => !candidate.disposed && candidate.title !== undefined && candidate.handler && candidate.boundId === chatId);
    panel.boundId = chatId;
    await panel.send({ type: 'ready' });
    return panel;
  };
  const share = { storageDir: context.storageDir, secretValues: context.secretValues, stateValues: context.stateValues };
  return { context, auth, store, engine, panels, tab, share };
}

// A new chat every time (the store reuses an empty current chat, as 0.3.0 did).
async function fresh(w) {
  w.store.currentId = undefined;
  return w.store.newConversation();
}

const requests = () => server.requestsTo('/v1/responses').map((request) => request.json);
const lastOf = (panel, type) => panel.posted.filter((message) => message.type === type).at(-1);
const conversation = (store, id) => store.getConversation(id);

test('UX-01 two tabs, two chats: each send is stored in its own chat and only its tab sees the reply', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  const b = await fresh(w);
  const tabA = await w.tab(a.id);
  const tabB = await w.tab(b.id);
  await tabA.send({ type: 'send', text: 'question for A', model: 'gpt-alpha', sendId: 's1' });
  await tabB.send({ type: 'send', text: 'question for B', model: 'gpt-beta', sendId: 's2' });
  assert.deepEqual((await conversation(w.store, a.id)).messages.map((m) => m.content), ['question for A', 'reply from gpt-alpha']);
  assert.deepEqual((await conversation(w.store, b.id)).messages.map((m) => m.content), ['question for B', 'reply from gpt-beta']);
  assert.equal(tabA.posted.some((m) => m.type === 'messageAdded' && m.message.content === 'question for B'), false, 'A never receives B\'s messages');
  assert.equal(tabB.posted.some((m) => m.type === 'messageAdded' && m.message.content === 'question for A'), false);
  // The request bodies are those of 0.3.0 for the same history (no extra fields).
  assert.deepEqual(Object.keys(requests()[0]).sort(), ['input', 'instructions', 'model', 'store', 'stream']);
  // Each chat keeps its model.
  assert.equal((await conversation(w.store, a.id)).model, 'gpt-alpha');
  assert.equal((await conversation(w.store, b.id)).model, 'gpt-beta');
});

test('UX-06 #1 spoofing: a chat id inside a webview message is never used', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  const b = await fresh(w);
  const tabA = await w.tab(a.id);
  await w.tab(b.id);
  await tabA.send({ type: 'send', text: 'meant for A', model: 'gpt-alpha', conversationId: b.id, chatId: b.id });
  await tabA.send({ type: 'selectConversation', conversationId: b.id });
  await tabA.send({ type: 'send', text: 'still A', model: 'gpt-alpha' });
  assert.deepEqual((await conversation(w.store, a.id)).messages.filter((m) => m.role === 'user').map((m) => m.content), ['meant for A', 'still A']);
  assert.equal((await conversation(w.store, b.id)).messages.length, 0);
});

test('UX-06 #13 restored tab state: malformed, missing and duplicate chat ids never bind; a valid one does', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  const serializer = calls.serializers.get('planChat.conversation');
  const { createWebviewPanel } = require('./helpers/fake-vscode');
  const make = () => createWebviewPanel('planChat.conversation', 'x', {}, {});
  for (const state of [undefined, {}, { chatId: 42 }, { chatId: '../../etc' }, { chatId: '00000000-0000-0000-0000-000000000000' }]) {
    const panel = make();
    await serializer.deserializeWebviewPanel(panel, state);
    assert.equal(panel.disposed, true, `state ${JSON.stringify(state)} closes the tab`);
    assert.equal(panel.webview.html, '', 'nothing was shown in it');
  }
  const good = make();
  await serializer.deserializeWebviewPanel(good, { chatId: a.id });
  assert.equal(good.disposed, false);
  assert.match(good.webview.html, /data-mode="panel"/);
  const duplicate = make();
  await serializer.deserializeWebviewPanel(duplicate, { chatId: a.id });
  assert.equal(duplicate.disposed, true, 'a second tab for the same chat is closed');
});

test('UX-02 one tab per chat; closing a tab keeps the chat; a reply continues after its tab closes', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  const tab = await w.tab(a.id);
  await w.panels.openChat(a.id);
  assert.equal(calls.panels.filter((panel) => !panel.disposed).length, 1, 'opening again reveals the same tab');
  server.responsesHandler = (request) => hangingStream(['part one ', 'part two'], request.signal);
  const sending = tab.send({ type: 'send', text: 'long question', model: 'gpt-alpha' });
  await waitFor(() => tab.posted.filter((m) => m.type === 'assistantDelta').length === 2);
  tab.dispose();
  assert.equal(w.engine.chatStatus(a.id), 'replying', 'the reply goes on without its tab');
  w.engine.stop(a.id);
  await sending;
  const stored = await conversation(w.store, a.id);
  assert.deepEqual(stored.messages.map((m) => m.content), ['long question', 'part one part two']);
  assert.equal(stored.messages[1].inProgress, undefined);
});

test('UX-04 one request per window: another chat waits, its text comes back, nothing is sent', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  const b = await fresh(w);
  const tabA = await w.tab(a.id);
  const tabB = await w.tab(b.id);
  server.responsesHandler = (request) => hangingStream(['A is replying'], request.signal);
  const sending = tabA.send({ type: 'send', text: 'first', model: 'gpt-alpha' });
  await waitFor(() => tabA.posted.some((m) => m.type === 'assistantDelta'));
  assert.equal(lastOf(tabB, 'streamState').otherReply.title, 'first', 'B is told which chat is replying');
  await tabB.send({ type: 'send', text: 'second', model: 'gpt-alpha' });
  assert.equal(requests().length, 1);
  assert.equal(lastOf(tabB, 'restoreDraft').text, 'second');
  assert.match(lastOf(tabB, 'contextNote').text, /replying in "first"\. Send this when that reply ends/);
  assert.equal((await conversation(w.store, b.id)).messages.length, 0);
  w.engine.stop();
  await sending;
  server.responsesHandler = (request) => completedStream(`reply from ${request.json.model}`);
  await tabB.send({ type: 'send', text: 'second', model: 'gpt-alpha' });
  assert.equal(requests().length, 2);
});

test('UX-06 #4 rapid Send and Cancel: the same Send twice is sent once; Stop before sending sends nothing', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  const tab = await w.tab(a.id);
  await Promise.all([
    tab.send({ type: 'send', text: 'once', model: 'gpt-alpha', sendId: 'same' }),
    tab.send({ type: 'send', text: 'once', model: 'gpt-alpha', sendId: 'same' })
  ]);
  await tab.send({ type: 'send', text: 'once', model: 'gpt-alpha', sendId: 'same' });
  assert.equal(requests().length, 1);
  assert.equal((await conversation(w.store, a.id)).messages.filter((m) => m.role === 'user').length, 1);
  // Stop pressed before the request leaves: no request, the text comes back.
  const before = requests().length;
  const sending = tab.send({ type: 'send', text: 'cancel me', model: 'gpt-alpha', sendId: 'other' });
  await tab.send({ type: 'stop' });
  await sending;
  assert.ok(requests().length <= before + 1);
  for (let index = 0; index < 5; index += 1) {
    const run = tab.send({ type: 'send', text: `rapid ${index}`, model: 'gpt-alpha', sendId: `r${index}` });
    await tab.send({ type: 'stop' });
    await run;
  }
  const stored = await conversation(w.store, a.id);
  assert.equal(stored.messages.some((m) => m.inProgress), false, 'no reply is left in progress');
  assert.equal(w.engine.chatStatus(a.id), undefined);
});

test('UX-04 #3 two windows, one chat: only one reply at a time; the other window gets its text back and sends nothing', async () => {
  const one = await openWindow();
  const chat = await fresh(one);
  const two = await openWindow(one.share);
  const tabOne = await one.tab(chat.id);
  const tabTwo = await two.tab(chat.id);
  server.responsesHandler = (request) => hangingStream(['window one replying'], request.signal);
  const sending = tabOne.send({ type: 'send', text: 'from window one', model: 'gpt-alpha' });
  await waitFor(() => tabOne.posted.some((m) => m.type === 'assistantDelta'));
  assert.equal(await one.engine.leases.isLive(chat.id), true);
  await tabTwo.send({ type: 'send', text: 'from window two', model: 'gpt-alpha' });
  assert.equal(requests().length, 1, 'window two sent nothing');
  assert.match(lastOf(tabTwo, 'error').message, /replying in another window/);
  assert.equal(lastOf(tabTwo, 'restoreDraft').text, 'from window two');
  assert.equal((await conversation(two.store, chat.id)).messages.filter((m) => m.role === 'user').length, 1);
  // Window two shows the reply as being written elsewhere, not as interrupted.
  await tabTwo.send({ type: 'ready' });
  const shown = lastOf(tabTwo, 'hydrate').conversation.messages.at(-1);
  assert.equal(shown.replyingElsewhere, true);
  assert.equal(shown.interrupted, undefined);
  one.engine.stop();
  await sending;
  assert.equal(await one.engine.leases.isLive(chat.id), false, 'the lease is released when the reply ends');
  server.responsesHandler = (request) => completedStream(`reply from ${request.json.model}`);
  await tabTwo.send({ type: 'send', text: 'from window two', model: 'gpt-alpha' });
  assert.equal(requests().length, 2);
});

test('UX-04 stale ownership: a lease left by a dead process is broken; the next send works', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const dir = path.join(w.context.storageDir, 'replies');
  fs.mkdirSync(dir, { recursive: true });
  // An owner record of a process that does not exist, on this computer.
  fs.writeFileSync(path.join(dir, leaseName(chat.id)), JSON.stringify({ id: 'dead', pid: 999999, host: require('node:os').hostname(), createdAt: Date.now() }));
  assert.equal(await w.engine.leases.isLive(chat.id), false);
  const tab = await w.tab(chat.id);
  await tab.send({ type: 'send', text: 'after a crash', model: 'gpt-alpha' });
  assert.equal(requests().length, 1);
  assert.throws(() => leaseName('../x'), /Unexpected chat id/);
});

test('UX-02 #6 #7 restart during a reply: the partial reply is kept, marked interrupted, and never re-sent (0.4.0, 0.3.0, 0.2.0)', { skip: HISTORICAL_SKIP }, async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.store.addMessage('user', 'question before the crash', chat.id);
  const reply = await w.store.addMessage('assistant', '', chat.id, { inProgress: true });
  assert.equal(await w.store.checkpointReply(chat.id, reply.id, 'partial text saved'), true);
  let stored = await conversation(w.store, chat.id);
  assert.deepEqual([stored.messages[1].inProgress, stored.messages[1].contextPolicy], [true, 'excluded']);
  // Older versions read the same file: neither re-sends the partial reply.
  for (const version of ['0.3.0', '0.2.0']) {
    const { ConversationStore: Old } = loadOldStore(version);
    const old = new Old(createContext({ storageDir: w.context.storageDir }));
    const history = await old.contextMessages(chat.id, 30);
    assert.deepEqual(history.map((m) => m.content), ['question before the crash'], `${version} leaves the partial reply out`);
  }
  // "Restart": no window owns the reply. Opening the chat marks it interrupted.
  const after = await openWindow(w.share);
  const tab = await after.tab(chat.id);
  const shown = lastOf(tab, 'hydrate').conversation.messages[1];
  assert.deepEqual([shown.content, shown.interrupted, shown.inProgress], ['partial text saved', true, undefined]);
  stored = await conversation(after.store, chat.id);
  assert.equal(mayReplay(stored.messages[1], undefined), false);
  await tab.send({ type: 'send', text: 'next question', model: 'gpt-alpha' });
  const sent = requests().at(-1).input.map((m) => m.content);
  assert.deepEqual(sent, ['question before the crash', 'next question'], 'the interrupted reply is not sent');
  assert.equal(requests().length, 1, 'nothing was resent automatically');
});

test('UX-04 checkpoints: saved while streaming; a busy history lock never fails the reply', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  let release;
  server.responsesHandler = (request) => hangingStream(['first part ', 'second part'], request.signal);
  const sending = tab.send({ type: 'send', text: 'stream please', model: 'gpt-alpha' });
  await waitFor(() => tab.posted.filter((m) => m.type === 'assistantDelta').length === 2);
  // A checkpoint is written within the interval.
  await waitFor(async () => (await conversation(w.store, chat.id)).messages[1]?.partialContent === 'first part second part', 6000, 100);
  assert.equal((await conversation(w.store, chat.id)).messages[1].content, '', 'unfinished text is kept out of content');
  // With the history lock held elsewhere, a checkpoint gives up quickly.
  const { acquireLock } = require('../src/lock');
  const handle = await acquireLock(path.join(w.context.storageDir, 'conversations.lock'));
  const started = Date.now();
  const reply = (await conversation(w.store, chat.id)).messages[1];
  assert.equal(await w.store.checkpointReply(chat.id, reply.id, 'x'), false);
  assert.ok(Date.now() - started < 3000, 'gave up within about a second');
  release = () => handle.release();
  await release();
  w.engine.stop();
  await sending;
  const stored = (await conversation(w.store, chat.id)).messages[1];
  assert.deepEqual([stored.content, stored.stopped, stored.inProgress], ['first part second part', true, undefined]);
});

test('UX-04 finishing a reply removes the in-progress exclusion only from plain replies', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const plain = await w.store.addMessage('assistant', '', chat.id, { inProgress: true });
  const attached = await w.store.addMessage('assistant', '', chat.id, { attachmentTurn: true, contextPolicy: 'excluded', inProgress: true });
  const project = await w.store.addMessage('assistant', '', chat.id, { project: { grantKeyId: 'k', consentId: 'c', policyVersion: 1, contextUsed: [] }, inProgress: true });
  for (const message of [plain, attached, project]) await w.store.finishReply(chat.id, message.id, 'done');
  const stored = (await conversation(w.store, chat.id)).messages;
  assert.deepEqual(stored.map((m) => [m.inProgress, m.contextPolicy]), [[undefined, undefined], [undefined, 'excluded'], [undefined, 'excluded']]);
});

test('UX-04 #14 drafts: kept per chat and project tag, bounded, cleared when sent, never sent', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  await tab.send({ type: 'draft', text: 'half-written thought' });
  const reopened = await openWindow(w.share);
  const tab2 = await reopened.tab(chat.id);
  assert.equal(lastOf(tab2, 'hydrate').draft, 'half-written thought', 'the draft survives a restart');
  // Same chat id under another context tag: no draft.
  const drafts = new DraftStore(w.context.storageDir);
  assert.equal(await drafts.get(chat.id, { kind: 'project', key: 'other', keyId: 'k', scheme: 2 }), '');
  assert.equal(await drafts.get('another-chat', chat.context), '');
  // Sending stores the typed text only and clears the draft.
  await tab2.send({ type: 'send', text: 'the real question', model: 'gpt-alpha' });
  assert.deepEqual(requests().at(-1).input.map((m) => m.content), ['the real question']);
  await waitFor(async () => (await drafts.get(chat.id, chat.context)) === '', 3000, 50);
  // Bounds.
  await drafts.set('long', undefined, 'x'.repeat(MAX_CHARS + 50));
  assert.equal((await drafts.get('long', undefined)).length, MAX_CHARS);
  for (let index = 0; index < MAX_DRAFTS + 5; index += 1) await drafts.set(`d${index}`, undefined, `draft ${index}`);
  const file = JSON.parse(fs.readFileSync(path.join(w.context.storageDir, 'drafts.json'), 'utf8'));
  assert.ok(Object.keys(file.drafts).length <= MAX_DRAFTS);
  assert.equal(tagSignature(undefined), 'untagged');
});

test('UX-04 #14 drafts never cross projects: a read-only chat of another project keeps no draft', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.store.moveConversation(chat.id, { kind: 'project', key: 'elsewhere', keyId: 'kid', label: 'Elsewhere', scheme: 2 });
  const tab = await w.tab(chat.id);
  assert.ok(lastOf(tab, 'hydrate').readOnly, 'shown read-only');
  await tab.send({ type: 'draft', text: 'should not be kept' });
  const drafts = new DraftStore(w.context.storageDir);
  assert.equal(await drafts.get(chat.id, (await conversation(w.store, chat.id)).context), '');
  await tab.send({ type: 'send', text: 'not allowed', model: 'gpt-alpha' });
  assert.equal(requests().length, 0);
  assert.equal(lastOf(tab, 'readOnly'), undefined);
  assert.equal(lastOf(tab, 'hydrate').readOnly.back, false, 'a tab has no "Back to my chat"');
});

test('UX-03 #16 groups: create, rename, assign, remove; chats keep their context; persisted across windows', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  await w.store.addMessage('user', 'hello', a.id);
  const group = await w.store.createGroup('  Release‮ work  ');
  assert.equal(group.name, 'Release work', 'one line, no direction controls');
  await w.store.setConversationGroup(a.id, group.id);
  const before = await conversation(w.store, a.id);
  assert.equal(before.groupId, group.id);
  assert.deepEqual(before.context, a.context, 'the context is unchanged');
  const other = await openWindow(w.share);
  assert.deepEqual((await other.store.listGroups()).map((g) => g.name), ['Release work']);
  await other.store.renameGroup(group.id, 'Shipped');
  assert.equal((await w.store.listGroups())[0].name, 'Shipped');
  await assert.rejects(w.store.setConversationGroup(a.id, 'no-such-group'), /no longer exists/);
  assert.equal(await w.store.removeGroup(group.id), 1);
  const after = await conversation(w.store, a.id);
  assert.equal(after.groupId, undefined);
  assert.deepEqual(after.messages.map((m) => m.content), ['hello'], 'removing a group deletes no chat');
  await assert.rejects(w.store.createGroup('   '), /Enter a group name/);
});

test('UX-03 the Chats list: contexts, groups and states, with titles and metadata only', async () => {
  const w = await openWindow();
  const a = await fresh(w);
  // The title comes from the first message; later messages never appear in the list.
  await w.store.addMessage('user', 'Release plan', a.id);
  await w.store.addMessage('assistant', 'secret question text', a.id);
  const b = await fresh(w);
  // Another project made with this profile's identity key: "Other projects".
  await w.store.moveConversation(b.id, { kind: 'project', key: 'elsewhere', keyId: w.engine.windowContext.keyId, label: 'Elsewhere', scheme: 2 });
  const group = await w.store.createGroup('Mine');
  await w.store.setConversationGroup(a.id, group.id);
  const sidebar = new Sidebar(w.context, w.engine, w.store, w.panels);
  sidebar.register();
  sidebar.refresh();
  const tree = calls.treeViews.get('planChat.sidebar');
  await waitFor(() => tree.options.treeDataProvider.getChildren().length > 0, 3000, 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const provider = tree.options.treeDataProvider;
  const roots = provider.getChildren();
  assert.deepEqual(roots.map((node) => node.section), ['general', 'other-project']);
  const general = provider.getChildren(roots[0]);
  assert.equal(general[0].type, 'group');
  assert.equal(provider.getChildren(general[0])[0].item.id, a.id);
  const other = provider.getTreeItem(roots[1]);
  assert.match(other.description, /opens read-only/);
  const chatItem = provider.getTreeItem(provider.getChildren(general[0])[0]);
  assert.equal(chatItem.command.command, 'planChat.openChat');
  assert.doesNotMatch(JSON.stringify(chatItem), /secret question text/, 'no message text in the list');
  // Search lists metadata only, never message text.
  calls.quickPick = () => undefined;
  await sidebar.searchChats();
  assert.doesNotMatch(JSON.stringify(calls.quickPicks.at(-1).items), /secret question text/);
  assert.deepEqual(statusOf({ lastFailed: true }, {}), { text: 'reply did not finish', icon: 'warning', spoken: 'last reply did not finish' });
  assert.equal(statusOf({}, { engineStatus: 'consent' }).text, 'needs your decision');
  assert.equal(statusOf({}, { open: true }).text, '', '"open" is shown by the icon, not in words');
});

test('UX-06 #10 sign-out in another window: replies here stop and nothing more is sent', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  await w.engine.rememberSession();
  server.responsesHandler = (request) => hangingStream(['streaming'], request.signal);
  const sending = tab.send({ type: 'send', text: 'q', model: 'gpt-alpha' });
  await waitFor(() => tab.posted.some((m) => m.type === 'assistantDelta'));
  // The other window removed the credentials.
  w.context.secretValues.delete(CREDENTIALS_KEY);
  assert.equal(await w.engine.sessionChanged(), true);
  await sending;
  assert.equal(w.engine.chatStatus(chat.id), undefined);
  await tab.send({ type: 'send', text: 'after sign-out', model: 'gpt-alpha' });
  assert.equal(requests().length, 1);
});

test('UX-01 static: the engine chooses a send target only from the surface, never from a message', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
  const prepare = source.slice(source.indexOf('async #prepare('), source.indexOf('// A code block\'s Copy button'));
  assert.match(prepare, /surface\.follow \? await this\.store\.getCurrent\(\) : await this\.store\.getConversation\(surface\.chatId\)/);
  assert.doesNotMatch(source, /message\.(conversationId|chatId)\b[^;]*#send/);
  // Every store write of a message names its chat.
  for (const call of source.matchAll(/this\.store\.addMessage\(([^)]*)\)/g)) {
    assert.equal(call[1].split(',').length >= 3, true, call[0]);
  }
  for (const call of source.matchAll(/this\.store\.contextMessages\(([^,)]*)/g)) assert.notEqual(call[1].trim(), '', call[0]);
});

test('UX-04 #17 older history opens unchanged: 0.3.0 files load, gain no fields, and keep every chat', async () => {
  const w = await openWindow();
  const legacy = {
    version: 1,
    currentId: 'c1',
    conversations: [{ id: 'c1', title: 'old chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'm2', role: 'assistant', content: 'hello', createdAt: '2026-01-01T00:00:01.000Z' }] }]
  };
  fs.writeFileSync(path.join(w.context.storageDir, 'conversations.json'), JSON.stringify(legacy));
  const other = await openWindow(w.share);
  const all = await other.store.listAll();
  assert.ok(all.some((item) => item.id === 'c1'));
  const history = await other.store.contextMessages('c1', 30);
  assert.deepEqual(history.map((m) => m.content), ['hi', 'hello']);
  assert.deepEqual(await other.store.listGroups(), []);
});

test('UX-04 A-19 checkpoints under load: with a 10 MB history, another process checkpointing never makes a send time out', { timeout: 180_000 }, async () => {
  const { runWorker } = require('./helpers/processes');
  const w = await openWindow();
  // A large history: 40 chats of about 260 KB each.
  const big = 'x'.repeat(2_600);
  const conversations = [];
  for (let chat = 0; chat < 40; chat += 1) {
    conversations.push({ id: `big-${chat}`, title: `big ${chat}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', context: { kind: 'general' }, messages: Array.from({ length: 100 }, (_, index) => ({ id: `m${chat}-${index}`, role: index % 2 ? 'assistant' : 'user', content: big, createdAt: '2026-01-01T00:00:00.000Z' })) });
  }
  const streaming = { id: 'streaming', title: 'streaming', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', context: { kind: 'general' }, messages: [{ id: 'q', role: 'user', content: 'q', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'r', role: 'assistant', content: '', inProgress: true, contextPolicy: 'excluded', createdAt: '2026-01-01T00:00:00.000Z' }] };
  fs.writeFileSync(path.join(w.context.storageDir, 'conversations.json'), JSON.stringify({ version: 1, currentId: 'streaming', conversations: [streaming, ...conversations] }));
  const size = fs.statSync(path.join(w.context.storageDir, 'conversations.json')).size;
  assert.ok(size >= 10_000_000, `history is ${size} bytes`);
  const target = await fresh(w);
  const worker = runWorker('store-worker.js', { storageDir: w.context.storageDir, ops: [{ op: 'checkpoints', conversationId: 'streaming', messageId: 'r', count: 40, intervalMs: 100, content: 'partial' }] }, { timeoutMs: 170_000 });
  const timings = [];
  for (let index = 0; index < 12; index += 1) {
    const started = Date.now();
    await w.store.addMessage('user', `question ${index}`, target.id);
    timings.push(Date.now() - started);
  }
  const run = await worker;
  const stored = await conversation(w.store, target.id);
  assert.equal(stored.messages.length, 12, 'every question was saved');
  assert.ok(Math.max(...timings) < w.store.lockOptions.timeoutMs, `slowest save ${Math.max(...timings)} ms`);
  assert.equal(run.code, 0, run.stderr);
  const result = run.result.results.find((entry) => entry.op === 'checkpoints');
  assert.ok(result.written > 0, 'the other process saved checkpoints too');
  // The 0.4.0 record (docs/release-evidence/UX-040/UX-04/) is history and is not
  // rewritten by later runs; set A19_LOAD_OUT to record a run somewhere else.
  fs.writeFileSync(process.env.A19_LOAD_OUT || path.join(require('node:os').tmpdir(), 'a19-checkpoint-load.json'), JSON.stringify({ historyBytes: size, sendTimingsMs: timings, checkpoints: result }, null, 2));
});

test('UX-06 #22 the window closing during a reply keeps it as interrupted, never as stopped', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  server.responsesHandler = (request) => hangingStream(['arrived before closing'], request.signal);
  const sending = tab.send({ type: 'send', text: 'q', model: 'gpt-alpha' });
  await waitFor(() => tab.posted.some((m) => m.type === 'assistantDelta'));
  w.engine.dispose();
  await sending;
  const reply = (await conversation(w.store, chat.id)).messages[1];
  assert.deepEqual([reply.partialContent, reply.content, reply.interrupted, reply.stopped, reply.inProgress, reply.contextPolicy], ['arrived before closing', '', true, undefined, undefined, 'excluded']);
  assert.equal(mayReplay(reply, undefined), false);
});

test('UX-07 downgrade: 0.3.0 writing into a 0.4.0 history keeps groups, per-chat models and interrupted marks; 0.4.0 reads them back', { skip: HISTORICAL_SKIP }, async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.store.addMessage('user', 'before downgrade', chat.id);
  const cut = await w.store.addMessage('assistant', '', chat.id, { inProgress: true });
  await w.store.checkpointReply(chat.id, cut.id, 'cut off');
  await w.store.markInterrupted(chat.id, [cut.id]);
  const group = await w.store.createGroup('Kept');
  await w.store.setConversationGroup(chat.id, group.id);
  await w.store.setConversationModel(chat.id, 'gpt-beta');
  const { ConversationStore: Old } = loadOldStore('0.3.0');
  const old = new Old(createContext({ storageDir: w.context.storageDir }));
  await old.addMessage('user', 'written by 0.3.0', chat.id);
  assert.deepEqual((await old.contextMessages(chat.id, 30)).map((m) => m.content), ['before downgrade', 'written by 0.3.0'], '0.3.0 leaves the interrupted reply out');
  const again = await openWindow(w.share);
  const back = await conversation(again.store, chat.id);
  assert.deepEqual([back.groupId, back.model], [group.id, 'gpt-beta']);
  assert.deepEqual((await again.store.listGroups()).map((g) => g.name), ['Kept']);
  assert.equal(back.messages[1].interrupted, true);
  assert.deepEqual(back.messages.map((m) => m.content), ['before downgrade', '', 'written by 0.3.0']);
  assert.equal(back.messages[1].partialContent, 'cut off', 'the cut-off text is kept, outside content');
});

test('UX-06 review #1 an interrupted reply that used project files is not re-sent by 0.3.0, even under the same grant', { skip: HISTORICAL_SKIP }, async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.store.addMessage('user', 'project question', chat.id);
  const grant = { grantKeyId: 'g1', consentId: 'c1', policyVersion: 1 };
  const reply = await w.store.addMessage('assistant', '', chat.id, { project: { ...grant, contextUsed: [] }, inProgress: true });
  await w.store.checkpointReply(chat.id, reply.id, 'partial answer from project files');
  await w.store.markInterrupted(chat.id, [reply.id]);
  const { ConversationStore: Old } = loadOldStore('0.3.0');
  const old = new Old(createContext({ storageDir: w.context.storageDir }));
  const history = await old.contextMessages(chat.id, 30, 80_000, { activeGrant: grant });
  assert.deepEqual(history.map((m) => m.content), ['project question']);
  const current = await w.store.contextMessages(chat.id, 30, 80_000, { activeGrant: grant });
  assert.deepEqual(current.map((m) => m.content), ['project question']);
});

test('UX-06 review #2 Include in follow-ups is refused for an unfinished or interrupted reply', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const reply = await w.store.addMessage('assistant', '', chat.id, { attachmentTurn: true, contextPolicy: 'excluded', inProgress: true });
  await assert.rejects(w.store.setContextPolicy(chat.id, reply.id, 'included'), /did not finish/);
  await w.store.markInterrupted(chat.id, [reply.id]);
  await assert.rejects(w.store.setContextPolicy(chat.id, reply.id, 'included'), /did not finish/);
  const { getWebviewHtml } = require('../src/view');
  assert.match(getWebviewHtml({ cspSource: 'x' }), /!item\.interrupted && !item\.replyingElsewhere && !item\.live && !item\.inProgress/);
});

test('UX-06 review #3 Send right after Stop in the same chat waits for the stopped reply, then sends', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  server.responsesHandler = (request) => hangingStream(['first '], request.signal);
  const first = tab.send({ type: 'send', text: 'first', model: 'gpt-alpha', sendId: 'a' });
  await waitFor(() => tab.posted.some((m) => m.type === 'assistantDelta'));
  server.responsesHandler = (request) => completedStream('second reply');
  await tab.send({ type: 'stop' });
  await tab.send({ type: 'send', text: 'second', model: 'gpt-alpha', sendId: 'b' });
  await first;
  assert.equal(requests().length, 2);
  assert.equal(tab.posted.some((m) => m.type === 'error' && /another window/.test(m.message)), false);
  assert.deepEqual((await conversation(w.store, chat.id)).messages.map((m) => m.content), ['first', 'first ', 'second', 'second reply']);
});

test('UX-06 review #5 a duplicate Send while the first is preparing puts no text back', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  await Promise.all([
    tab.send({ type: 'send', text: 'only once', model: 'gpt-alpha', sendId: 'dup' }),
    tab.send({ type: 'send', text: 'only once', model: 'gpt-alpha', sendId: 'dup' })
  ]);
  assert.equal(requests().length, 1);
  assert.equal(tab.posted.filter((m) => m.type === 'restoreDraft').length, 0);
});

test('UX-06 review #7 a restored tab of another context cannot change the chat before it is checked', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.store.moveConversation(chat.id, { kind: 'project', key: 'elsewhere', keyId: w.engine.windowContext.keyId, label: 'Elsewhere', scheme: 2 });
  const { createWebviewPanel } = require('./helpers/fake-vscode');
  const panel = createWebviewPanel('planChat.conversation', 'x', {}, {});
  await calls.serializers.get('planChat.conversation').deserializeWebviewPanel(panel, { chatId: chat.id });
  w.engine.models = [{ id: 'gpt-beta', name: 'Beta' }];
  await panel.send({ type: 'selectModel', model: 'gpt-beta' });
  await panel.send({ type: 'draft', text: 'should not be kept' });
  const stored = await conversation(w.store, chat.id);
  assert.equal(stored.model, undefined, 'no model was set on a read-only chat');
  assert.equal(await new DraftStore(w.context.storageDir).get(chat.id, stored.context), '');
});

test('UX-06 review #1 follow-up: every way of showing a chat shows unfinished text and the interrupted mark', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.store.addMessage('user', 'q', chat.id);
  const reply = await w.store.addMessage('assistant', '', chat.id, { inProgress: true });
  await w.store.checkpointReply(chat.id, reply.id, 'partial shown');
  await w.store.moveConversation(chat.id, { kind: 'project', key: 'elsewhere', keyId: w.engine.windowContext.keyId, label: 'Elsewhere', scheme: 2 });
  // The side bar arrangement (a following surface), opening it read-only.
  const { createWebviewView } = require('./helpers/fake-vscode');
  const view = createWebviewView();
  w.engine.ui = undefined;
  await w.engine.resolveWebviewView(view);
  await w.engine.openReadOnly(chat.id);
  const shown = view.posted.filter((m) => m.type === 'conversation').at(-1).conversation.messages[1];
  assert.deepEqual([shown.content, shown.interrupted], ['partial shown', true]);
});

test('UX-02 a tab whose page never says "ready" is loaded again (at most twice)', async () => {
  const w = await openWindow();
  const chat = await fresh(w);
  await w.panels.openChat(chat.id);
  const panel = calls.panels.at(-1);
  let loads = 0;
  let html = panel.webview.html;
  Object.defineProperty(panel.webview, 'html', { get: () => html, set: (value) => { loads += 1; html = value; } });
  await new Promise((resolve) => setTimeout(resolve, 6800));
  assert.equal(loads, 2, 'reloaded twice, then left alone');
  await panel.send({ type: 'ready' });
  assert.equal(panel.posted.filter((m) => m.type === 'hydrate').length, 1);
});

test('DEC-PLANCHAT-017 a reply stopped by the user: kept, marked Stopped, only received text, no retry, replayed with its stopped status', async () => {
  const { STOPPED_NOTE } = require('../src/store');
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  server.responsesHandler = (request) => hangingStream(['only this ', 'was received'], request.signal);
  const sending = tab.send({ type: 'send', text: 'tell me a story', model: 'gpt-alpha' });
  await waitFor(() => tab.posted.filter((m) => m.type === 'assistantDelta').length === 2);
  await tab.send({ type: 'stop' });
  await sending;
  const stored = (await conversation(w.store, chat.id)).messages[1];
  assert.deepEqual([stored.content, stored.stopped, stored.inProgress, stored.interrupted, stored.error], ['only this was received', true, undefined, undefined, undefined]);
  // Shown as Stopped, never as complete.
  const shown = tab.posted.filter((m) => m.type === 'conversation').at(-1).conversation.messages[1];
  assert.equal(shown.stopped, true);
  const { getWebviewHtml } = require('../src/view');
  assert.match(getWebviewHtml({ cspSource: 'x' }), /Stopped: you stopped this reply before it finished\. Only the text received is shown\./);
  // No retry: exactly one request so far.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(requests().length, 1);
  // In the next request it is sent with its stopped status.
  server.responsesHandler = (request) => completedStream('next');
  await tab.send({ type: 'send', text: 'continue', model: 'gpt-alpha' });
  const input = requests().at(-1).input.map((m) => m.content);
  assert.deepEqual(input, ['tell me a story', `only this was received${STOPPED_NOTE}`, 'continue']);
  assert.equal(requests().length, 2);
});

test('D-1 ordinary send: the sent question is not offered back after the reply; a draft typed during the reply survives', async () => {
  const { DraftStore } = require('../src/drafts');
  const w = await openWindow();
  const chat = await fresh(w);
  const tab = await w.tab(chat.id);
  await tab.send({ type: 'draft', text: 'first question', rev: Date.now() });
  const index = tab.posted.length;
  server.responsesHandler = (request) => hangingStream(['part '], request.signal);
  const sending = tab.send({ type: 'send', text: 'first question', model: 'gpt-alpha', sendId: 'o1', draftRev: Date.now() });
  await waitFor(() => tab.posted.some((m) => m.type === 'assistantDelta'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await tab.send({ type: 'draft', text: 'typed while it replies', rev: Date.now() });
  w.engine.stop(chat.id);
  await sending;
  const offered = tab.posted.slice(index).filter((m) => (m.type === 'conversation' || m.type === 'hydrate') && m.draft).map((m) => m.draft);
  assert.ok(!offered.includes('first question'), 'the sent question is never offered back');
  assert.equal(await new DraftStore(w.context.storageDir).get(chat.id, chat.context), 'typed while it replies');
  // An older save arriving late never replaces newer text.
  await w.engine.drafts.set(chat.id, chat.context, 'stale text', 1);
  assert.equal(await w.engine.drafts.get(chat.id, chat.context), 'typed while it replies');
});

test('D-2 Arabic and English names in the Chats list: names isolated, counts outside the name, stored names unchanged', async () => {
  const { isolate } = require('../src/sidebar');
  const w = await openWindow();
  const a = await fresh(w);
  await w.store.addMessage('user', 'مرحبا بالعالم', a.id);
  const b = await fresh(w);
  await w.store.addMessage('user', 'English title', b.id);
  const arabic = await w.store.createGroup('مجموعة القبول');
  const english = await w.store.createGroup('Release');
  await w.store.setConversationGroup(a.id, arabic.id);
  await w.store.setConversationGroup(b.id, arabic.id);
  const sidebar = new Sidebar(w.context, w.engine, w.store, w.panels);
  sidebar.register();
  sidebar.refresh();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const provider = calls.treeViews.get('planChat.sidebar').options.treeDataProvider;
  const section = provider.getChildren()[0];
  const nodes = provider.getChildren(section);
  const arabicItem = provider.getTreeItem(nodes.find((node) => node.type === 'group' && node.group.id === arabic.id));
  const englishItem = provider.getTreeItem(nodes.find((node) => node.type === 'group' && node.group.id === english.id));
  assert.equal(arabicItem.label, '⁨مجموعة القبول⁩', 'the name is isolated');
  assert.equal(arabicItem.description, '2 chats', 'the count is outside the name');
  assert.equal(englishItem.label, isolate('Release'));
  assert.equal(englishItem.description, '0 chats');
  assert.match(arabicItem.accessibilityInformation.label, /^Group مجموعة القبول, 2 chats$/, 'screen readers get the plain name');
  const chatItem = provider.getTreeItem(provider.getChildren(nodes.find((node) => node.type === 'group' && node.group.id === arabic.id)).find((node) => node.item.id === a.id));
  assert.equal(chatItem.label, isolate('مرحبا بالعالم'));
  assert.doesNotMatch(chatItem.accessibilityInformation.label, /[⁨⁩]/);
  assert.equal((await w.store.listGroups()).find((group) => group.id === arabic.id).name, 'مجموعة القبول', 'stored without marks');
  const oneChat = await w.store.createGroup('واحد');
  await w.store.setConversationGroup(b.id, oneChat.id);
  sidebar.refresh();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = provider.getChildren(provider.getChildren()[0]);
  assert.equal(provider.getTreeItem(after.find((node) => node.type === 'group' && node.group.id === oneChat.id)).description, '1 chat', 'singular kept');
});

test('D-2 review #3: direction controls inside an automatic title cannot break the isolation', () => {
  const { isolate } = require('../src/sidebar');
  const shown = isolate('x\u2069مرحبا\u202E');
  assert.equal(shown, '\u2068xمرحبا\u2069');
  assert.equal([...shown].filter((c) => c === '\u2069').length, 1, 'exactly one closing mark, at the end');
});
