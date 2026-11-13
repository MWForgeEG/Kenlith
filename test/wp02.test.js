'use strict';

// WP-02 (UI stabilization): keyboard focus returns to the History button when
// a list opened from the view is dismissed (T02-07); the Attach Selection
// label (T02-05) is covered in test/stage3.test.js. Fake sign-in and model;
// synthetic history in a temporary folder.

const assert = require('node:assert/strict');
const test = require('node:test');
const { calls, createContext, createWebviewView } = require('./helpers/fake-vscode');
const { ConversationStore } = require('../src/store');
const { ChatViewProvider, getWebviewHtml } = require('../src/view');

test.afterEach(() => { calls.quickPick = undefined; });

async function openView() {
  const context = createContext();
  const auth = { getSession: async () => ({ email: 'synthetic.user@example.test' }), signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const openai = { listModels: async () => [{ id: 'model-a', name: 'Model A' }], streamResponse: async () => {} };
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, openai, store, { writeClipboard: async () => {}, openExternal: async () => {} });
  const view = createWebviewView();
  view.shown = [];
  view.show = (preserveFocus) => { view.shown.push(preserveFocus); };
  await provider.resolveWebviewView(view);
  await store.addMessage('user', 'A synthetic chat', (await store.getCurrent()).id);
  const focusPosts = () => view.posted.filter((message) => message.type === 'focusControl');
  return { provider, store, view, focusPosts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('T02-07 History opened from the view and dismissed: the view is focused and focus goes back to the History button', async () => {
  const { view, focusPosts } = await openView();
  calls.quickPick = () => undefined;
  await view.send({ type: 'showHistory' });
  assert.deepEqual(view.shown, [false], 'the view is shown with focus');
  assert.deepEqual(focusPosts(), [{ type: 'focusControl', id: 'history' }]);
});

test('T02-07 History opened by command (palette or title bar) and dismissed: focus is left to the editor', async () => {
  const { provider, view, focusPosts } = await openView();
  calls.quickPick = () => undefined;
  await provider.showHistory();
  assert.deepEqual(view.shown, []);
  assert.deepEqual(focusPosts(), []);
});

test('T02-07 choosing a chat does not send focus back to the History button', async () => {
  const { store, view, focusPosts } = await openView();
  const target = (await store.getCurrent()).id;
  calls.quickPick = (items) => items.find((item) => item.id === target);
  await view.send({ type: 'showHistory' });
  assert.deepEqual(focusPosts(), []);
});

test('T02-07 All Chats reached from the view\'s History and dismissed: focus goes back to the History button', async () => {
  const { view, focusPosts } = await openView();
  let lists = 0;
  calls.quickPick = (items) => {
    lists += 1;
    return lists === 1 ? items.find((item) => item.action === 'all') : undefined;
  };
  await view.send({ type: 'showHistory' });
  // All Chats opens on the next turn and reads the history from disk first;
  // under load that takes longer than a fixed 20 ms (seen once, M1 WP-09).
  for (let waited = 0; lists < 2 && waited < 2000; waited += 20) await settle();
  await settle();
  assert.equal(lists, 2, 'All Chats opened after History');
  assert.deepEqual(focusPosts(), [{ type: 'focusControl', id: 'history' }]);
});

test('T02-07 the page moves focus only to fixed controls, whatever id a message names', () => {
  const html = getWebviewHtml({ cspSource: 'vscode-resource:' });
  // 0.4.0: the History button (side bar layout) or, when a tab becomes active,
  // the message box (or a waiting consent card). Never an element looked up
  // by the id the message names.
  const block = html.slice(html.indexOf("case 'focusControl':"), html.indexOf("case 'copied':"));
  assert.match(block, /if \(message\.id === 'history'\) elements\.history\.focus\(\);/);
  assert.match(block, /if \(message\.id === 'prompt'\) \{\s*if \(state\.consent\) elements\.consentTitle\.focus\(\);\s*else if \(!elements\.signedIn\.classList\.contains\('hidden'\)\) elements\.prompt\.focus\(\);/);
  assert.doesNotMatch(block, /getElementById\(message\.id\)|querySelector\(.*message\.id/);
  assert.deepEqual([...block.matchAll(/elements\.(\w+)\.focus\(\)/g)].map((match) => match[1]).sort(), ['consentTitle', 'history', 'prompt']);
});
