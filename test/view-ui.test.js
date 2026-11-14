'use strict';

// Host side of the UI hardening slice: sign-out confirmation, Copy, the
// webview page itself, and one request at a time while a reply streams.
// Synthetic credentials and a fake OpenAI only; nothing leaves the process.

const assert = require('node:assert/strict');
const test = require('node:test');
const { calls, createContext, createWebviewView } = require('./helpers/fake-vscode');
const { CLIENT_ID, FakeOpenAI, completedStream, hangingStream, sse, storedCredentials, waitFor } = require('./helpers/fake-openai');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider, getWebviewHtml, relativeTime } = require('../src/view');

let server;
test.beforeEach(() => {
  server = new FakeOpenAI().install();
  server.responsesHandler = () => completedStream('ok');
});
test.afterEach(() => {
  server.uninstall();
  calls.warningChoice = 'Sign Out';
});

async function activate() {
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  const auth = new AuthService(context);
  const signOuts = [];
  const realSignOut = auth.signOut.bind(auth);
  auth.signOut = (...args) => {
    signOuts.push(args);
    return realSignOut(...args);
  };
  const store = new ConversationStore(context);
  // Not opened here: as in activateWith(), the view sets the window's context first.
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  return { context, auth, store, provider, view, signOuts };
}

test('sign-out: confirming runs the existing sign-out exactly once', async () => {
  const { view, context, signOuts } = await activate();
  const warningsBefore = calls.warning.length;
  calls.warningChoice = 'Sign Out';

  await view.send({ type: 'signOut' });

  assert.equal(calls.warning.length - warningsBefore, 1, 'one confirmation was asked');
  assert.match(calls.warning.at(-1), /Sign out of ChatGPT in Kenlith\?/);
  assert.equal(signOuts.length, 1);
  assert.equal(context.secretValues.has(CREDENTIALS_KEY), false);
});

test('sign-out: cancelling the confirmation does nothing to the session', async () => {
  const { view, context, signOuts } = await activate();
  const stored = context.secretValues.get(CREDENTIALS_KEY);
  const requestsBefore = server.requests.length;
  calls.warningChoice = undefined;

  await view.send({ type: 'signOut' });

  assert.equal(signOuts.length, 0);
  assert.equal(context.secretValues.get(CREDENTIALS_KEY), stored);
  assert.equal(server.requests.length, requestsBefore, 'no revocation or other request');
  assert.equal(view.posted.some((message) => message.type === 'busy' && message.label === 'Signing out…'), false);
});

test('copy: the code text reaches the clipboard byte for byte', async () => {
  const { view } = await activate();
  const text = "const s = 'مرحبا';\t// ‮comment‬\r\n  👋🏽 trailing   ";
  await view.send({ type: 'copyText', text });
  assert.equal(calls.clipboard.at(-1), text);
  assert.equal(view.posted.at(-1).type, 'copied');

  const count = calls.clipboard.length;
  await view.send({ type: 'copyText', text: { not: 'a string' } });
  await view.send({ type: 'copyText', text: 'x'.repeat(2_000_001) });
  assert.equal(calls.clipboard.length, count, 'invalid copies are ignored');
});

test('links: the browser opens only after the user confirms the full address', async () => {
  const { view } = await activate();
  const url = 'https://example.test/docs?a=1#part';

  calls.warningChoice = undefined;
  const opened = calls.openExternal.length;
  await view.send({ type: 'openLink', url });
  assert.equal(calls.warning.at(-1), 'Open this link in your browser?');
  assert.equal(calls.openExternal.length, opened, 'cancelled: nothing opened');

  calls.warningChoice = 'Open Link';
  await view.send({ type: 'openLink', url });
  assert.deepEqual(calls.openExternal.slice(opened), [url]);
});

test('links: unsafe addresses are refused before any prompt', async () => {
  const { view } = await activate();
  calls.warningChoice = 'Open Link';
  const warnings = calls.warning.length;
  const opened = calls.openExternal.length;
  for (const url of ['javascript:alert(1)', 'command:workbench.action.reloadWindow', 'file:///C:/Windows/win.ini',
    'vscode://x/y', 'data:text/html,x', 'https://user' + ':pw@example.test/', '/relative', { href: 'https://example.test/' }]) {
    await view.send({ type: 'openLink', url });
  }
  assert.equal(calls.warning.length, warnings);
  assert.equal(calls.openExternal.length, opened);
});

test('streaming: a second send while a reply streams is not sent, and its text comes back', async () => {
  const { view, provider, store } = await activate();
  server.responsesHandler = (request) => hangingStream(['partial '], request.signal);

  const first = view.send({ type: 'send', text: 'first question', model: 'gpt-alpha' });
  await waitFor(() => view.posted.some((message) => message.type === 'assistantDelta'));
  await view.send({ type: 'send', text: 'second question typed meanwhile', model: 'gpt-alpha' });

  assert.equal(server.requestsTo('/v1/responses').length, 1);
  assert.equal(view.posted.filter((message) => message.type === 'restoreDraft').at(-1).text, 'second question typed meanwhile');

  provider.stop();
  await first;
  const messages = (await store.getCurrent()).messages;
  assert.deepEqual(messages.map((message) => [message.role, message.content]), [['user', 'first question'], ['assistant', 'partial ']]);
  assert.equal(view.posted.at(-1).type, 'streamState');
  assert.equal(view.posted.at(-1).streaming, false);
});

test('webview page: CSP unchanged, both scripts carry the nonce, Markdown is inlined', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  const nonce = /script-src 'nonce-([^']+)'/.exec(page)[1];
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)[1];
  assert.equal(csp, `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src vscode-resource: data:; font-src 'none'`);
  const scripts = page.match(/<script\b[^>]*>/g);
  assert.deepEqual(scripts, [`<script nonce="${nonce}">`, `<script nonce="${nonce}">`]);
  assert.match(page, /root\.PlanChatMarkdown = api/);
  assert.doesNotMatch(page, /unsafe-inline|unsafe-eval|https?:\/\/(?!example)/i);
});

test('webview page: Account opens account details; only "Sign Out…" asks to sign out', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(page, /<button id="account" class="secondary" aria-expanded="false" aria-controls="accountPanel">Account<\/button>/);
  assert.match(page, /<div id="accountPanel" class="account-panel hidden" role="group" aria-labelledby="accountHeading">/);
  assert.match(page, /<button id="signOut" class="secondary">Sign Out…<\/button>/);
  // The Account button's handler only toggles the panel.
  assert.match(page, /elements\.account\.addEventListener\('click', \(\) => setAccountOpen\(/);
  const signOutPosts = page.match(/post\('signOut'\)/g) || [];
  assert.equal(signOutPosts.length, 1);
  assert.match(page, /elements\.signOut\.addEventListener\('click', \(\) => \{\s*setAccountOpen\(false, true\);\s*post\('signOut'\);/);
});

test('webview page: accessibility hooks and streaming behaviour are in place', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(page, /<div id="errorBanner" class="error-banner hidden" role="alert">/);
  assert.match(page, /<main id="messages" tabindex="0" aria-label="Conversation" aria-busy="false">/);
  assert.match(page, /<div id="announcer" class="visually-hidden" role="status" aria-live="polite">/);
  assert.match(page, /<button id="stop" class="secondary hidden" aria-label="Stop response">/);
  assert.match(page, /<div id="alerts" class="visually-hidden" role="alert">/);
  assert.match(page, /:focus-visible,\s*textarea:focus \{\s*outline: 1px solid var\(--vscode-focusBorder\)/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(page, /prompt\.disabled/, 'the input is never disabled while streaming');
  assert.match(page, /event\.isComposing/);
  // Link clicks (left and middle) are stopped in the page and sent to the extension.
  assert.match(page, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*post\('openLink'/);
  assert.match(page, /addEventListener\('auxclick'/);
});

test('navigation: no brand line, no second New Chat, no email in the header', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.doesNotMatch(page, /class="brand"/);
  assert.doesNotMatch(page, /id="newChat"/, 'New Chat is the view title action only');
  assert.doesNotMatch(page, /<select id="conversations"/);
  assert.match(page, /<button id="history" class="history" type="button" aria-haspopup="listbox" aria-label="Chat history">/);
  // The email is written only into the account panel.
  assert.match(page, /elements\.accountName\.textContent = state\.signedIn/);
  assert.doesNotMatch(page, /elements\.status\.textContent = state\.signedIn/);

  const manifest = require('../package.json');
  const titleActions = manifest.contributes.menus['view/title'];
  assert.equal(titleActions.filter((item) => item.command === 'planChat.newChat').length, 1);
  // 0.4.0 (UX-03): the Chats list keeps the 0.3.0 view id, so stored layouts
  // and keybindings carry over; Account is new. 0.4.1: the container is titled
  // Kenlith; its id and the view ids are unchanged.
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, 'Kenlith');
  assert.deepEqual(manifest.contributes.views.planChat.map((view) => [view.id, view.name]), [['planChat.account', 'Account'], ['planChat.sidebar', 'Chats']]);
  assert.equal(manifest.contributes.views.planChat.some((view) => view.type === 'webview'), false, 'the side bar has no chat webview');
  assert.equal(manifest.version, '0.9.0'); // Kenlith 0.9.0
});

test('history: the Quick Pick lists every chat by id and switches to the chosen one', async () => {
  const { view, provider, store } = await activate();
  await view.send({ type: 'send', text: 'first chat', model: 'gpt-alpha' });
  const firstId = (await store.getCurrent()).id;
  await view.send({ type: 'newChat' });
  await view.send({ type: 'send', text: 'second $(alert) chat', model: 'gpt-alpha' });
  const secondId = (await store.getCurrent()).id;
  const before = JSON.stringify((await store.listConversations()).items.map((item) => item.id).sort());

  calls.quickPick = (items) => items.find((item) => item.id === firstId);
  await view.send({ type: 'showHistory' });
  const shown = calls.quickPicks.at(-1);
  assert.equal(shown.items[0].action, 'new');
  assert.deepEqual(shown.items.filter((item) => item.id).map((item) => item.id).sort(), [firstId, secondId].sort());
  assert.match(shown.items.find((item) => item.id === secondId).description, /· open now$/);
  assert.ok(!shown.items.find((item) => item.id === secondId).label.includes('$(alert)'), 'titles cannot turn into icons');
  assert.equal((await store.getCurrent()).id, firstId);
  assert.equal(view.posted.at(-1).type, 'conversation');
  assert.equal(view.posted.at(-1).conversation.id, firstId);

  calls.quickPick = () => undefined; // Escape
  await view.send({ type: 'showHistory' });
  assert.equal((await store.getCurrent()).id, firstId);

  calls.quickPick = (items) => items[0]; // New Chat
  await provider.showHistory();
  assert.notEqual((await store.getCurrent()).id, firstId);
  const after = (await store.listConversations()).items.map((item) => item.id);
  assert.ok(JSON.parse(before).every((id) => after.includes(id)), 'existing chats and ids are kept');
  calls.quickPick = undefined;
});

test('errors: a failed reply is shown once, in the message; a hidden view gets one notification', async () => {
  const { view } = await activate();
  view.visible = true;
  server.responsesHandler = () => sse([{ type: 'response.output_text.delta', delta: 'partial' }]);
  const notices = calls.error.length;

  await view.send({ type: 'send', text: 'q', model: 'gpt-alpha' });
  const failed = view.posted.filter((message) => message.type === 'messageUpdated' && message.error).at(-1);
  assert.equal(failed.content, 'partial');
  assert.match(failed.errorText, /\S/, 'the reason travels with the partial reply');
  assert.equal(view.posted.filter((message) => message.type === 'error').length, 0, 'no banner');
  assert.equal(calls.error.length, notices, 'no notification while the view is visible');

  view.visible = false;
  await view.send({ type: 'send', text: 'q2', model: 'gpt-alpha' });
  assert.equal(calls.error.length, notices + 1, 'one notification when the view is hidden');
});

test('isolation: an injected platform keeps Copy and Open Link away from the real clipboard and browser', async () => {
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials()));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  const auth = new AuthService(context);
  const store = new ConversationStore(context);
  // Not opened here: as in activateWith(), the view sets the window's context first.
  const synthetic = { clipboard: [], opened: [] };
  const platform = {
    writeClipboard: async (text) => { synthetic.clipboard.push(text); },
    openExternal: async (url) => { synthetic.opened.push(url); }
  };
  const provider = new ChatViewProvider(context, auth, new OpenAIService(auth), store, platform);
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  const realClipboard = calls.clipboard.length;
  const realOpened = calls.openExternal.length;

  await view.send({ type: 'copyText', text: 'synthetic code' });
  calls.warningChoice = 'Open Link';
  await view.send({ type: 'openLink', url: 'https://example.test/x' });

  assert.deepEqual(synthetic, { clipboard: ['synthetic code'], opened: ['https://example.test/x'] });
  assert.equal(calls.clipboard.length, realClipboard);
  assert.equal(calls.openExternal.length, realOpened);
});

test('exposure: activation exports nothing to other extensions, in every mode', async () => {
  const { activate } = require('../src/extension');
  for (const mode of [1, 2, 3]) { // Production, Development, Test
    const context = createContext();
    context.extensionMode = mode;
    context.subscriptions = [];
    assert.equal(await activate(context), undefined, `mode ${mode}`);
    assert.ok(context.subscriptions.length > 0, 'the view and commands are registered');
  }
  // The test entry point is not part of the extension's source.
  const fs = require('node:fs');
  const path = require('node:path');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'test-main.js')), false);
  assert.equal(require('../package.json').main, './src/extension.js');
});

test('navigation: Sign Out lives in the Account panel only; one New Chat', () => {
  const manifest = require('../package.json');
  // 0.4.0: the Chats list's title bar holds New Chat, Search and New Group,
  // with the rest in its overflow menu; still one New Chat, and Sign Out only
  // behind a confirmation (Account), never in the Command Palette.
  const titleActions = manifest.contributes.menus['view/title'];
  assert.deepEqual(titleActions.filter((item) => item.group.startsWith('navigation')).map((item) => item.command), ['planChat.newChat', 'planChat.searchChats', 'planChat.newGroup']);
  assert.equal(titleActions.filter((item) => item.command === 'planChat.newChat').length, 1);
  assert.ok(manifest.contributes.menus.commandPalette.some((item) => item.command === 'planChat.signOut' && item.when === 'false'));
  assert.equal(titleActions.some((item) => item.command === 'planChat.signOut'), false);
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(page, /<button id="signOut" class="secondary">Sign Out…<\/button>/);
});

test('messages: speaker names are hidden visually but kept for screen readers', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(page, /\.role \{\s*position: absolute;\s*width: 1px;\s*height: 1px;\s*overflow: hidden;\s*clip: rect\(0 0 0 0\);/);
  assert.match(page, /role\.textContent = message\.role === 'user' \? 'You' : 'Assistant';/);
  assert.match(page, /\.message\.user \{ margin-inline-start: 15%; \}/);
});

test('fields: input, model selector and history button use the theme-aware boundary', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(page, /--field-border: var\(--vscode-contrastBorder, color-mix\(in srgb, var\(--vscode-foreground\) 60%, var\(--vscode-sideBar-background\)\)\);/);
  // The message input, model selector and history button each use it (the
  // stage 2 context chip and read-only bar do too).
  for (const rule of [/    select \{[^}]*border: 1px solid var\(--field-border\);/, /    textarea \{[^}]*border: 1px solid var\(--field-border\);/, /    \.history \{[^}]*border: 1px solid var\(--field-border\);/]) {
    assert.match(page, rule);
  }
});

test('history: relative times, with the full date on the second line', async () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(relativeTime('2026-10-28T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-10-28T11:55:00Z', now), '5 minutes ago');
  assert.equal(relativeTime('2026-10-28T09:00:00Z', now), '3 hours ago');
  assert.equal(relativeTime('2026-10-27T12:00:00Z', now), 'yesterday');
  assert.equal(relativeTime('2026-10-10T12:00:00Z', now), '3 weeks ago');
  assert.equal(relativeTime('not a date', now), '');
  assert.equal(relativeTime(undefined, now), '');

  const { view } = await activate();
  await view.send({ type: 'send', text: 'a chat', model: 'gpt-alpha' });
  calls.quickPick = () => undefined;
  await view.send({ type: 'showHistory' });
  const item = calls.quickPicks.at(-1).items.find((entry) => entry.id && /open now/.test(entry.description || ''));
  assert.match(item.description, /^just now · open now$/);
  assert.ok(item.detail && item.detail.length > 10, 'full date and time');
  calls.quickPick = undefined;
});

test('account: Escape anywhere in the page closes an open Account panel', () => {
  const page = getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(page, /document\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key === 'Escape' && !elements\.accountPanel\.classList\.contains\('hidden'\)\) \{\s*event\.preventDefault\(\);\s*setAccountOpen\(false, true\);/);
});
