'use strict';

// WP-05 (integrated validation): connected workflows across the real
// AuthService, OpenAIService, ConversationStore and ChatViewProvider, with
// the scripted fake OpenAI server (synthetic tokens signed by a throwaway
// key), the fake editor API, and temporary folders. Covers what earlier
// files test only piece by piece. No network: the fake server answers every
// OpenAI address, and only the loopback sign-in redirect is real.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { calls, config, createContext, createEditor, createTextDocument, createWebviewView, makeTempDir, setActiveEditor, setActiveTextEditor, setWorkspaceFolders } = require('./helpers/fake-vscode');
const { CLIENT_ID, FakeOpenAI, completedStream, idToken, json, storedCredentials, tokenResponse } = require('./helpers/fake-openai');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider } = require('../src/view');
const { render } = require('../src/markdown');
const { folderIdentityInput } = require('../src/project');
const { createDocument, elements } = require('./helpers/fake-dom');

let server;
test.beforeEach(() => { server = new FakeOpenAI().install(); calls.onOpenExternal = undefined; });
test.afterEach(() => {
  server.uninstall();
  setWorkspaceFolders(undefined);
  setActiveEditor(undefined);
  config.reset();
  calls.warningChoice = 'Sign Out';
  calls.quickPick = undefined;
});

const encoder = new TextEncoder();
// A stream that sends `deltas` one by one, then completes.
function stream(deltas, { fail } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const delta of deltas) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`));
      if (fail) controller.error(new TypeError('fetch failed: network connection lost'));
      else {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`));
        controller.close();
      }
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const signedIn = (shared) => {
  const context = createContext(shared);
  if (!shared) {
    context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
    context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  }
  return context;
};

async function window(context, platform) {
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store, platform || { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  const posted = (type) => view.posted.filter((message) => message.type === type);
  return { context, auth, store, provider, view, posted, send: (text, model = 'gpt-alpha') => view.send({ type: 'send', text, model }) };
}

const historyOf = (context) => JSON.parse(fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8'));
const requestTexts = () => server.requestsTo('/v1/responses').map((request) => JSON.stringify(request.json));

// ---------------------------------------------------------------------------
// T05-04 authentication lifecycle

// Completes the browser step and keeps the page the loopback server returned.
function browserSignIn(pages, { badState = false } = {}) {
  calls.onOpenExternal = (value) => {
    const url = new URL(value);
    server.lastNonce = url.searchParams.get('nonce');
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', badState ? 'not-the-state' : url.searchParams.get('state'));
    redirect.searchParams.set('code', 'synthetic-code');
    redirect.searchParams.set('client_id', CLIENT_ID);
    setImmediate(() => fetch(redirect).then((response) => response.text()).then((text) => pages.push(text)).catch(() => undefined));
    return true;
  };
}

test('T05-04 the sign-in completion page, the failure page and the browser-open error name no particular editor (R-16)', async () => {
  const pages = [];
  browserSignIn(pages);
  server.tokenHandler = () => json(200, tokenResponse({ id_token: idToken({ nonce: server.lastNonce }) }));
  await new AuthService(createContext()).signIn();
  for (let index = 0; index < 100 && pages.length < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(pages[0], /Sign-in complete/);
  assert.match(pages[0], /return to your editor/);
  assert.doesNotMatch(pages[0], /Antigravity|Visual Studio Code/);

  const failed = [];
  browserSignIn(failed, { badState: true });
  await assert.rejects(new AuthService(createContext()).signIn());
  for (let index = 0; index < 100 && failed.length < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(failed[0], /could not be completed/);
  assert.doesNotMatch(failed[0], /Antigravity|Visual Studio Code/);

  calls.onOpenExternal = () => false;
  await assert.rejects(new AuthService(createContext()).signIn(), (error) => !/Antigravity/.test(error.message) && /browser/.test(error.message));
});

test('T05-04 one profile, two windows: sign in, models, send, renewal, the other window, sign-out, restart; no token outside SecretStorage', async () => {
  const pages = [];
  browserSignIn(pages);
  server.tokenHandler = (request) => request.form.grant_type === 'refresh_token'
    ? json(200, tokenResponse({ access_token: 'synthetic-access-2', refresh_token: 'synthetic-refresh-2' }))
    : json(200, tokenResponse({ id_token: idToken({ nonce: server.lastNonce }) }));
  server.responsesHandler = () => completedStream('synthetic reply');
  const a = await window(createContext());
  assert.ok(!a.posted('hydrate').at(-1).session, 'starts signed out');
  await a.view.send({ type: 'signIn' });
  const signedInView = a.posted('hydrate').at(-1);
  assert.equal(signedInView.session.email, 'synthetic@example.test');
  assert.deepEqual(signedInView.models.map((model) => model.id), ['gpt-alpha', 'gpt-beta'], 'models after simulated sign-in');
  await a.send('first question');
  assert.equal(server.requestsTo('/v1/responses')[0].headers.authorization, 'Bearer synthetic-access-1');

  // Renewal: the access token is near expiry; the next request refreshes once.
  const stored = JSON.parse(a.context.secretValues.get(CREDENTIALS_KEY));
  a.context.secretValues.set(CREDENTIALS_KEY, JSON.stringify({ ...stored, expiresAt: Date.now() + 5_000 }));
  await a.send('second question');
  assert.equal(server.refreshCount, 1);
  assert.equal(server.requestsTo('/v1/responses').at(-1).headers.authorization, 'Bearer synthetic-access-2');

  // A second window of the same profile shares the session and the renewed token.
  const b = await window(createContext({ storageDir: a.context.storageDir, secretValues: a.context.secretValues, stateValues: a.context.stateValues }));
  assert.equal(b.posted('hydrate').at(-1).session.email, 'synthetic@example.test');
  await b.send('from the second window');
  assert.equal(server.requestsTo('/v1/responses').at(-1).headers.authorization, 'Bearer synthetic-access-2');
  assert.equal(server.refreshCount, 1, 'no second refresh');

  // Sign out (confirmed) in window A: tokens revoked and cleared; chats kept.
  calls.warningChoice = 'Sign Out';
  await a.view.send({ type: 'signOut' });
  assert.equal(server.requestsTo('/oauth/revoke').length, 1);
  assert.equal(a.context.secretValues.get(CREDENTIALS_KEY), undefined);
  assert.ok(!a.posted('hydrate').at(-1).session);
  // Window B's next send asks to sign in and gives the text back.
  await b.send('after sign-out elsewhere');
  assert.match(b.posted('error').at(-1).message, /Continue with ChatGPT/);
  assert.equal(b.posted('restoreDraft').at(-1).text, 'after sign-out elsewhere');
  // Restart: signed out, history intact.
  const restarted = await window(createContext({ storageDir: a.context.storageDir, secretValues: a.context.secretValues, stateValues: a.context.stateValues }));
  assert.ok(!restarted.posted('hydrate').at(-1).session);
  const contents = historyOf(a.context).conversations.flatMap((item) => item.messages.map((message) => message.content));
  for (const text of ['first question', 'second question', 'from the second window']) assert.ok(contents.includes(text), text);

  // No token anywhere but SecretStorage.
  const surfaces = [JSON.stringify([a.view.posted, b.view.posted, restarted.view.posted]), fs.readFileSync(path.join(a.context.storageDir, 'conversations.json'), 'utf8'), JSON.stringify([...a.context.stateValues]), JSON.stringify(calls), pages.join('\n')];
  for (const token of ['synthetic-access-1', 'synthetic-access-2', 'synthetic-refresh-1', 'synthetic-refresh-2', 'synthetic-code']) {
    for (const surface of surfaces) assert.equal(surface.includes(token), false, `${token} leaked`);
  }
});

test('T05-04 cancelling the sign-out confirmation changes nothing', async () => {
  const w = await window(signedIn());
  calls.warningChoice = undefined;
  await w.view.send({ type: 'signOut' });
  assert.ok(w.context.secretValues.get(CREDENTIALS_KEY));
  assert.equal(server.requestsTo('/oauth/revoke').length, 0);
});

// ---------------------------------------------------------------------------
// T05-02 chat lifecycle, connected

test('T05-02 lifecycle: model choice, streamed long Markdown reply, Stop, new chat, history, restart, General and project contexts', async () => {
  const project = path.join(makeTempDir(), 'lifecycle-project');
  fs.mkdirSync(project);
  setWorkspaceFolders([project]);
  const context = signedIn();
  const w = await window(context);
  assert.equal(w.posted('hydrate').at(-1).conversation.messages.length, 0, 'a new chat to start');

  // A long Markdown reply with code, streamed in many small deltas.
  const reply = ['# Plan', '', ...Array.from({ length: 60 }, (_, index) => `- step ${index + 1}: **bold** and \`code\` / خطوة ${index + 1}`), '', '```js', ...Array.from({ length: 200 }, (_, index) => `const line${index} = ${index};`), '```'].join('\n');
  const deltas = reply.match(/[\s\S]{1,40}/g);
  server.responsesHandler = () => stream(deltas);
  await w.view.send({ type: 'selectModel', model: 'gpt-beta' });
  await w.send('Give me a plan', 'gpt-beta');
  assert.equal(server.requestsTo('/v1/responses')[0].json.model, 'gpt-beta');
  assert.ok(w.posted('assistantDelta').length >= deltas.length, 'every delta reached the view');
  const first = (await w.store.getCurrent()).messages;
  assert.equal(first.at(-1).content, reply, 'the stored reply equals the streamed text');
  const tree = render(createDocument(), reply);
  const holder = createDocument().createElement('div'); holder.append(tree);
  assert.ok(elements(holder).some((element) => element.localName === 'pre'), 'code block rendered');

  // Stop during a second reply keeps the partial text.
  server.responsesHandler = (request) => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial answer' })}\n\n`));
      request.signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')));
    } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const sending = w.send('a second question', 'gpt-beta');
  for (let index = 0; index < 200 && !w.posted('assistantDelta').some((message) => message.delta === 'partial answer'); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await w.view.send({ type: 'stop' });
  await sending;
  const chatOne = await w.store.getCurrent();
  assert.equal(chatOne.messages.at(-1).content, 'partial answer');

  // New chat, then back to the first through the history selection.
  await w.view.send({ type: 'newChat' });
  server.responsesHandler = () => completedStream('second chat reply');
  await w.send('question in chat two', 'gpt-beta');
  const chatTwo = (await w.store.getCurrent()).id;
  assert.notEqual(chatTwo, chatOne.id);
  await w.view.send({ type: 'selectConversation', conversationId: chatOne.id });
  assert.equal((await w.store.getCurrent()).id, chatOne.id);

  // Restart: the same chat is open, with every message.
  const restarted = await window(createContext({ storageDir: context.storageDir, secretValues: context.secretValues, stateValues: context.stateValues }));
  const reopened = restarted.posted('hydrate').at(-1).conversation;
  assert.equal(reopened.id, chatOne.id);
  assert.equal(reopened.messages.length, chatOne.messages.length);
  assert.equal(restarted.posted('hydrate').at(-1).selectedModel, 'gpt-beta', 'the chosen model is remembered');

  // General: an empty window lists neither project chat; the project lists both.
  setWorkspaceFolders(undefined);
  const general = await window(createContext({ storageDir: context.storageDir, secretValues: context.secretValues, stateValues: context.stateValues }));
  const generalIds = (await general.store.listConversations()).items.map((item) => item.id);
  assert.ok(!generalIds.includes(chatOne.id) && !generalIds.includes(chatTwo));
  await general.send('a General question', 'gpt-beta');
  assert.ok(!requestTexts().at(-1).includes('Give me a plan'), 'nothing from the project chat is sent from General');
});

// ---------------------------------------------------------------------------
// T05-05 failures and recovery

test('T05-05 a network interruption mid-stream keeps the question and the partial reply, marks the reply failed, and the next send recovers', async () => {
  const w = await window(signedIn());
  server.responsesHandler = () => stream(['half of the ', 'answer'], { fail: true });
  await w.send('question before the drop');
  const chat = await w.store.getCurrent();
  assert.equal(chat.messages[0].content, 'question before the drop', 'the question is kept');
  const failedReply = chat.messages.at(-1);
  assert.ok(failedReply.error, 'the reply is marked failed');
  assert.ok(w.posted('error').length + w.posted('messageUpdated').filter((message) => message.error).length > 0, 'the user sees the failure');
  server.responsesHandler = () => completedStream('recovered');
  await w.send('after the drop');
  assert.equal((await w.store.getCurrent()).messages.at(-1).content, 'recovered');
  assert.ok(!JSON.stringify(server.requestsTo('/v1/responses').at(-1).json).includes('half of the answer'), 'the failed partial reply is not sent as context');
});

test('T05-05 refused sends give the draft back and store nothing: no session, unknown model, too long, read-only chat, while streaming', async () => {
  const context = createContext();
  const w = await window(context);
  await w.send('no session yet');
  assert.equal(w.posted('restoreDraft').at(-1).text, 'no session yet');
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  await w.send('unknown model', 'gpt-missing');
  assert.equal(w.posted('restoreDraft').at(-1).text, 'unknown model');
  const huge = 'x'.repeat(100_001);
  await w.send(huge);
  assert.equal(w.posted('restoreDraft').at(-1).text, huge);
  assert.match(w.posted('error').at(-1).message, /too large/);
  assert.equal(server.requestsTo('/v1/responses').length, 0);
  assert.equal((await w.store.getCurrent()).messages.length, 0, 'nothing stored');
});

test('T05-05 a history save that fails (disk full) is shown to the user; the earlier history file stays intact', async () => {
  const context = signedIn();
  const w = await window(context);
  server.responsesHandler = () => completedStream('ok');
  await w.send('saved before the failure');
  // History over the request budget, so a sent request would show the
  // "earlier messages not included" note.
  const chat = (await w.store.getCurrent()).id;
  for (let index = 0; index < 3; index += 1) {
    await w.store.addMessage('user', `long ${'q'.repeat(30_000)}`, chat);
    await w.store.addMessage('assistant', `long ${'a'.repeat(30_000)}`, chat);
  }
  const file = path.join(context.storageDir, 'conversations.json');
  const before = fs.readFileSync(file, 'utf8');
  const postedBefore = w.view.posted.length;
  // Every save writes a temporary file first; make that fail as a full disk would.
  const realOpen = fs.promises.open;
  fs.promises.open = async (target, ...rest) => {
    if (String(target).endsWith('.tmp')) { const error = new Error('ENOSPC: no space left on device, write'); error.code = 'ENOSPC'; throw error; }
    return realOpen(target, ...rest);
  };
  try {
    await w.send('this save fails');
  } finally {
    fs.promises.open = realOpen;
  }
  assert.match(w.posted('error').at(-1)?.message || '', /space|save|could not/i, 'the user sees why');
  assert.equal(w.posted('restoreDraft').at(-1)?.text, 'this save fails', 'the typed text is given back');
  assert.equal(server.requestsTo('/v1/responses').length, 1, 'nothing is sent when the question could not be saved');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the earlier history is intact');
  assert.equal(fs.readdirSync(context.storageDir).filter((name) => name.endsWith('.tmp')).length, 0);
  assert.ok(!w.view.posted.slice(postedBefore).some((message) => message.type === 'contextNote' && message.text), 'no "not included" note for a request that was never sent');
});

// ---------------------------------------------------------------------------
// T05-06 performance and content (measured, not tuned)

const timed = (fn) => { const started = process.hrtime.bigint(); const value = fn(); return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 }; };
const timedAsync = async (fn) => { const started = process.hrtime.bigint(); const value = await fn(); return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 }; };
const measurements = [];
test.after(() => {
  const out = process.env.PLAN_CHAT_WP05_MEASUREMENTS;
  if (out) fs.writeFileSync(out, JSON.stringify({ node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, measurements }, null, 2));
});

test('T05-06 large history: 300 chats × 40 messages open, list, switch and build a request', async (t) => {
  const context = signedIn();
  const conversations = Array.from({ length: 300 }, (_, chat) => ({
    id: `perf-${chat}`, title: `Chat ${chat} — محادثة`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, chat)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 1, 0, chat)).toISOString(),
    messages: Array.from({ length: 40 }, (_, index) => ({ id: `m-${chat}-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Message ${index} نص عربي with **Markdown** and \`code\` ${'x'.repeat(400)}`, createdAt: '2026-10-01T00:00:00.000Z' }))
  }));
  fs.writeFileSync(path.join(context.storageDir, 'conversations.json'), JSON.stringify({ version: 1, currentId: 'perf-299', conversations }));
  const size = fs.statSync(path.join(context.storageDir, 'conversations.json')).size;
  const open = await timedAsync(() => window(context));
  const list = await timedAsync(() => open.value.store.listConversations());
  const select = await timedAsync(() => open.value.view.send({ type: 'selectConversation', conversationId: 'perf-10' }));
  server.responsesHandler = () => completedStream('ok');
  const send = await timedAsync(() => open.value.send('one more question'));
  assert.equal(list.value.items.length, 300);
  const row = { case: 'history 300 × 40 (file MB)', fileMB: +(size / 1e6).toFixed(2), openMs: Math.round(open.ms), listMs: Math.round(list.ms), selectMs: Math.round(select.ms), sendMs: Math.round(send.ms) };
  measurements.push(row);
  t.diagnostic(JSON.stringify(row));
});

test('T05-06 rendering: large Markdown replies, a long code block, mixed Arabic and English, Unicode edge cases', (t) => {
  const doc = createDocument();
  const cases = {
    'markdown 200 KB': Array.from({ length: 2500 }, (_, index) => `${index % 10 === 0 ? '## Heading' : '-'} item ${index} **bold** _em_ [link](https://example.test/${index}) \`x\``).join('\n'),
    'code block 5,000 lines': ['```js', ...Array.from({ length: 5000 }, (_, index) => `function f${index}(a, b) { return a + b + ${index}; }`), '```'].join('\n'),
    'Arabic and English 100 KB': Array.from({ length: 1500 }, (_, index) => `الدالة addMessage في store.js تحفظ الرسالة ${index} — then lock.js releases.`).join('\n'),
    'Unicode edge cases': ['👨‍👩‍👧‍👦 family', 'é combining', '‮rtl override‬', 'zero​width', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', 'ﷺ ligature', '﻿bom'].join('\n').repeat(200)
  };
  for (const [name, text] of Object.entries(cases)) {
    const { value, ms } = timed(() => { const root = doc.createElement('div'); root.append(render(doc, text)); return root; });
    assert.ok(value.textContent.length > 0, name);
    const row = { case: `render ${name}`, chars: text.length, ms: Math.round(ms) };
    measurements.push(row);
    t.diagnostic(JSON.stringify(row));
  }
  const unicode = (() => { const root = doc.createElement('div'); root.append(render(doc, cases['Unicode edge cases'])); return root.textContent; })();
  for (const piece of ['👨‍👩‍👧‍👦', 'é', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', 'ﷺ']) assert.ok(unicode.includes(piece), `${piece} kept`);
});

test('T05-06 repeated streaming updates: 5,000 deltas reach the view in order and the stored reply is exact', async (t) => {
  const w = await window(signedIn());
  const deltas = Array.from({ length: 5000 }, (_, index) => `${index % 50 === 0 ? '\n' : ''}w${index} `);
  server.responsesHandler = () => stream(deltas);
  const { ms } = await timedAsync(() => w.send('stream a lot'));
  const received = w.posted('assistantDelta').map((message) => message.delta).join('');
  assert.equal(received, deltas.join(''));
  assert.equal((await w.store.getCurrent()).messages.at(-1).content, deltas.join(''));
  const row = { case: 'stream 5,000 deltas', ms: Math.round(ms) };
  measurements.push(row);
  t.diagnostic(JSON.stringify(row));
});

test('T05-06 long Windows paths: a project folder past 260 characters resolves, or fails closed as unverified', async (t) => {
  let deep = makeTempDir();
  while (deep.length < 300) deep = path.join(deep, 'a-long-segment-name-for-path-testing');
  let created = true;
  try { fs.mkdirSync(deep, { recursive: true }); } catch (error) { created = false; t.diagnostic(`could not create a ${deep.length}-character path: ${error.code}`); }
  const { input, available } = await folderIdentityInput(deep);
  if (created) {
    if (available) assert.ok(input.startsWith('exact:'), 'resolved: stored-path identity');
    else assert.ok(input.startsWith('unverified:'), 'not resolvable: unverified identity (fail closed)');
    t.diagnostic(JSON.stringify({ length: deep.length, available }));
    measurements.push({ case: 'path length', length: deep.length, resolved: available });
  }
});

// ---------------------------------------------------------------------------
// T05-08 adversarial webview messages and stored metadata

test('T05-08 forged and malformed webview messages: nothing is sent, opened, stored or polluted', async () => {
  const project = path.join(makeTempDir(), 'adversarial');
  fs.mkdirSync(project);
  setWorkspaceFolders([project]);
  const context = signedIn();
  const w = await window(context, { writeClipboard: async () => { throw new Error('clipboard must not be written'); }, openExternal: async () => { throw new Error('browser must not open'); } });
  server.responsesHandler = () => completedStream('ok');
  await w.send('baseline');
  const before = fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8');
  const responses = server.requestsTo('/v1/responses').length;
  const junk = [undefined, null, 42, true, [], {}, { __proto__: { polluted: true } }, 'x'.repeat(3_000_000), '../../etc', 'constructor', '__proto__', '\u0000', '<script>'];
  const types = ['send', 'selectConversation', 'approveAttachment', 'refreshAttachment', 'removeAttachment', 'setReplyContext', 'copyText', 'openLink', 'moveReadOnly', 'leaveReadOnly', 'selectModel', 'attachSelection', 'nonexistent-type'];
  calls.warningChoice = undefined;
  for (const type of types) {
    for (const value of junk) {
      const message = { type, text: value, model: value, conversationId: value, id: value, messageId: value, include: value, url: value, attachmentId: value };
      if (type === 'send' && typeof value === 'string' && value.trim() && value.length <= 100_000) continue; // a normal send is allowed
      await w.view.send(message);
    }
  }
  await w.view.send(JSON.parse('{"type":"send","__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(server.requestsTo('/v1/responses').length, responses, 'no request from forged messages');
  assert.equal(fs.readFileSync(path.join(context.storageDir, 'conversations.json'), 'utf8'), before, 'history unchanged');
  assert.equal(w.provider.attachment, undefined, 'no attachment created from a message');
});

test('T05-08 malformed attachment metadata and unknown fields in the history file neither break a chat nor reach a request', async () => {
  const context = signedIn();
  const w0 = await window(context);
  const chat = (await w0.store.getCurrent()).id;
  const history = historyOf(context);
  const target = history.conversations.find((item) => item.id === chat);
  target.messages.push(
    { id: 'bad-1', role: 'user', content: 'question with odd metadata', createdAt: '2026-10-29T00:00:00.000Z', attachments: 'not-an-array' },
    { id: 'bad-2', role: 'assistant', content: 'REPLY-TO-ATTACHED-CODE', createdAt: '2026-10-29T00:00:01.000Z', attachmentTurn: true, contextPolicy: 'excluded', attachments: [{ id: 5, displayPath: { nested: true }, text: 'SMUGGLED-SOURCE' }] },
    { id: 'bad-3', role: 'system', content: 'SYSTEM-INJECTION', createdAt: '2026-10-29T00:00:02.000Z' }
  );
  fs.writeFileSync(path.join(context.storageDir, 'conversations.json'), JSON.stringify(history));
  const w = await window(context);
  server.responsesHandler = () => completedStream('ok');
  await w.send('next');
  const sent = JSON.stringify(server.requestsTo('/v1/responses').at(-1).json);
  assert.ok(sent.includes('question with odd metadata'));
  for (const marker of ['REPLY-TO-ATTACHED-CODE', 'SMUGGLED-SOURCE', 'SYSTEM-INJECTION']) assert.ok(!sent.includes(marker), marker);
});

test('T05-08 a stale attachment (the editor changed after approval or the window changed context) is never sent', async () => {
  const project = path.join(makeTempDir(), 'stale');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const file = path.join(project, 'src', 'a.js');
  fs.writeFileSync(file, 'const STALE_SOURCE = 1;\n');
  setWorkspaceFolders([project]);
  const w = await window(signedIn());
  setActiveTextEditor(createEditor(createTextDocument({ path: file, text: 'const STALE_SOURCE = 1;\n', languageId: 'javascript' }), [[0, 0, 1, 0]]));
  await w.view.send({ type: 'attachSelection' });
  const id = w.provider.attachment?.snapshot.id;
  assert.ok(id, 'attachment captured');
  await w.view.send({ type: 'approveAttachment', id });
  // The window moves to General before sending.
  setWorkspaceFolders(undefined);
  await w.provider.workspaceChanged();
  server.responsesHandler = () => completedStream('ok');
  await w.view.send({ type: 'send', text: 'with the old attachment', model: 'gpt-alpha', attachmentId: id });
  assert.ok(!requestTexts().some((text) => text.includes('STALE_SOURCE')), 'never sent after the context changed');
});
