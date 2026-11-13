'use strict';

// Kenlith 0.7.0 RC2 editor-tab UX (DEC-PLANCHAT-034, 035). The page in the
// editor tab: a + menu with only real Kenlith actions, the model selector in
// the composer, no thinking-effort control (Kenlith has none), the command
// card's facts; the new message type; the coloured tab icon. The real-editor
// layout, themes, widths and Arabic text: test/integration/composer-ui.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calls, createContext, makeTempDir, vscode } = require('./helpers/fake-vscode');
const { getWebviewHtml } = require('../src/view');

const root = path.join(__dirname, '..');
const page = getWebviewHtml({ cspSource: 'vscode-resource:' }, { mode: 'panel' });

test('RC2-1 the + menu holds only real Kenlith actions, each wired to an existing message', () => {
  const menu = /<div id="plusMenu"[^>]*role="menu"[^>]*>([\s\S]*?)<\/div>\s*<button id="attach"/.exec(page);
  assert.ok(menu, 'the menu is in the page');
  const labels = [...menu[1].matchAll(/<span class="menu-label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Attach selection', 'Project sharing…', 'Project context settings…']);
  assert.equal((menu[1].match(/role="menuitem"/g) || []).length, 3);
  // Each item posts a message the extension handles.
  assert.match(page, /menuAttach\.addEventListener\('click', fromMenu\(\(\) => \{ state\.attachFromView = true; post\('attachSelection'\); \}\)\)/);
  assert.match(page, /menuSharing\.addEventListener\('click', fromMenu\(\(\) => post\('manageProjectSharing'\)\)\)/);
  assert.match(page, /menuSettings\.addEventListener\('click', fromMenu\(\(\) => post\('openProjectSettings'\)\)\)/);
  const engine = fs.readFileSync(path.join(root, 'src', 'engine.js'), 'utf8');
  for (const type of ['attachSelection', 'manageProjectSharing', 'openProjectSettings']) assert.match(engine, new RegExp(`case '${type}':`), type);
  // Nothing Kenlith cannot do: no file upload, web search, image or voice item.
  assert.doesNotMatch(menu[1], /upload|attach files?|search the web|image|voice|camera/i);
});

// 0.8.0 (DEC-PLANCHAT-040) replaces RC2-2's "no thinking-effort control": the
// control now exists beside the model, and the reasoning field is written only
// from a request the builder made. Behaviour: test/thinking-effort.test.js.
test('RC2-2 (0.8.0) the Thinking control sits beside the model; openai.js writes reasoning only from the built request', () => {
  assert.match(page, /<select id="effort" class="effort-select" aria-label="Thinking" aria-describedby="effortNote"><\/select>/);
  assert.match(page, /elements\.modelSlot\.append\(elements\.effortLabel, elements\.effort\);/);
  const openai = fs.readFileSync(path.join(root, 'src', 'openai.js'), 'utf8');
  const writes = openai.match(/payload\.reasoning\s*=.*$/gm) || [];
  assert.deepEqual(writes, ['payload.reasoning = { effort: request.reasoning.effort };']);
  // No reasoning summary, Pro mode or verbosity (out of scope for 0.8.0).
  assert.doesNotMatch(openai + page, /summary\s*:|mode:\s*['"]pro|verbosity/i);
});

test('RC2-3 the editor tab moves the same native model select into the composer; the side bar view keeps its layout', () => {
  assert.match(page, /<select id="models" aria-label="Model"><\/select>/);
  assert.match(page, /if \(MODE === 'panel'\) \{\s*elements\.modelSlot\.append\(elements\.models\);/);
  assert.match(page, /elements\.models\.title = name \? 'Model: ' \+ name : 'Model';/);
  // The selection still posts selectModel, as before.
  assert.match(page, /post\('selectModel', \{ model: elements\.models\.value \}\)/);
});

test('RC2-4 the command card always shows folder, time limit, environment and effect, technical values left to right', () => {
  assert.match(page, /\['Folder', card\.cwd === '\.' \? 'the project folder' : card\.cwd, card\.cwd !== '\.'\]/);
  assert.match(page, /\['Environment', 'no changes', false\]/);
  assert.match(page, /if \(effects\) facts\.push\(\['Effect', effects, false\]\);/);
  assert.match(page, /v\.dir = technical \? 'ltr' : 'auto';/);
  assert.match(page, /<pre id="commandLine" class="wrap command-line" dir="ltr"/);
});

test('RC2-5 + Project context settings opens the editor Settings at kenlith.projectContext (nothing else)', async () => {
  const { ChatEngine } = require('../src/engine');
  const { ConversationStore } = require('../src/store');
  const { OpenAIService } = require('../src/openai');
  const { ChatPanels } = require('../src/panels');
  const context = createContext({ storageDir: makeTempDir() });
  const session = { email: 'synthetic.user@example.test', subject: 'user-1', scopes: ['chatgpt.tokens.use.direct'] };
  const auth = { getSession: async () => session, getAccessToken: async () => 'x', signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const store = new ConversationStore(context);
  const engine = new ChatEngine(context, auth, new OpenAIService(auth), store, { writeClipboard: async () => {}, openExternal: async () => {} });
  const executed = [];
  const original = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (...args) => { executed.push(args); };
  try {
    await engine.prepare();
    const panels = new ChatPanels(context, engine, store);
    engine.ui = panels;
    const chat = await store.newConversation();
    calls.panels.length = 0;
    await panels.openChat(chat.id);
    const panel = calls.panels.at(-1);
    await panel.send({ type: 'ready' });
    executed.length = 0;
    await panel.send({ type: 'openProjectSettings' });
    assert.deepEqual(executed, [['workbench.action.openSettings', 'kenlith.projectContext']]);
  } finally {
    vscode.commands.executeCommand = original;
  }
});

test('RC2-6 the editor tab icon is coloured (Signal Mint rings on Deep Forest), the Activity Bar icon stays single-colour', () => {
  const svg = fs.readFileSync(path.join(root, 'media', 'chat-tab.svg'), 'utf8');
  assert.match(svg, /fill="#103D32"/);
  assert.match(svg, /stroke="#7FD8A4"/);
  const chat = fs.readFileSync(path.join(root, 'media', 'chat.svg'), 'utf8');
  assert.match(chat, /currentColor/);
  assert.doesNotMatch(chat, /#7FD8A4|#103D32/i);
});
