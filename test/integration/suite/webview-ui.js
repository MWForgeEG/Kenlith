'use strict';

// Phase "webview-ui": the real ChatViewProvider page, in a real editor webview,
// driven from outside by test/integration/webview-ui.js over the editor's
// DevTools port. Sign-in and the model are synthetic fakes that only log what
// they are asked to do; fetch is blocked in this extension host, so nothing
// can reach OpenAI or any other server.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'local-open-source.plan-chat-antigravity';
const EMAIL = 'synthetic.user@example.test';

const ARABIC_REPLY = [
  'تقوم الدالة بإضافة رسالة داخل معاملة مقفلة:',
  '',
  '1. تقرأ الملف `conversations.json` من القرص.',
  '2. تضيف الرسالة.',
  '3. تكتب الملف كاملًا دفعة واحدة.',
  '',
  '```js',
  "await store.addMessage('user', text, chatId);",
  '```',
  '',
  'المسار: C:\\Users\\synthetic\\src\\store.js، والتفاصيل في https://example.test/plan-chat-ui-test.'
].join('\n');

const ENGLISH_REPLY = 'Each write takes `conversations.lock` first, so the second window waits. **Nothing is lost.**\n\n- one change per transaction\n- the file is replaced atomically\n\nSee [the design note](https://example.test/plan-chat-ui-test).';

const HOSTILE = [
  '<img src=x onerror="document.body.dataset.xss=1"> <script>document.body.dataset.xss=2</script>',
  '[click me](javascript:document.body.dataset.xss=3) [cmd](command:workbench.action.reloadWindow)',
  '![tracker](https://example.test/pixel.png)',
  '<svg onload="document.body.dataset.xss=4"></svg>'
].join('\n\n');

const LONG_REPLY = Array.from({ length: 30 }, (_, index) =>
  `${index + 1}. **Rule ${index + 1}.** The request counts instructions, history and the new message against the 80,000-character limit (step ${index + 1}).`).join('\n');

function memento() {
  const values = new Map();
  return { get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); } };
}

module.exports = async function runWebviewUi() {
  const dir = process.env.PLAN_CHAT_IT_UI_DIR;
  const log = (event) => fs.appendFileSync(path.join(dir, 'host-events.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  const report = { host: vscode.env.appName, version: vscode.version, errors: [] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    log({ type: 'blockedFetch', url: String(url) });
    throw new Error('Network is disabled in the UI test.');
  };
  // Stand-ins for the clipboard and the browser: the operating system
  // clipboard is never read or written, and no link reaches a browser.
  const synthetic = { clipboard: [], opened: [] };
  let panel;
  try {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const { ChatViewProvider } = require(path.join(extension.extensionPath, 'src', 'view.js'));
    const { ConversationStore } = require(path.join(extension.extensionPath, 'src', 'store.js'));

    const store = new ConversationStore({ globalStorageUri: vscode.Uri.file(path.join(dir, 'storage')) });
    await store.initialize();
    const chatId = (await store.getCurrent()).id;
    for (let index = 0; index < 6; index += 1) {
      await store.addMessage('user', `Earlier question ${index + 1}: how is history kept?`, chatId);
      await store.addMessage('assistant', `Earlier answer ${index + 1}. History is **local**, in \`conversations.json\`.\n\nIt is never sent anywhere except with a request you make.`, chatId);
    }
    await store.addMessage('user', 'Render these exactly:', chatId);
    await store.addMessage('assistant', HOSTILE, chatId);
    await store.addMessage('user', 'And in English: what happens if two windows write at once?', chatId);
    await store.addMessage('assistant', ENGLISH_REPLY, chatId);
    await store.addMessage('user', 'اشرح لي كيف تعمل دالة addMessage في store.js', chatId);
    await store.addMessage('assistant', ARABIC_REPLY, chatId);

    let signedIn = true;
    const auth = {
      getSession: async () => (signedIn ? { email: EMAIL, name: 'Synthetic User' } : undefined),
      signIn: async () => { log({ type: 'auth.signIn' }); },
      signOut: async () => {
        log({ type: 'auth.signOut' });
        signedIn = false;
        return { remoteRevoked: true };
      }
    };
    const openai = {
      listModels: async () => [{ id: 'model-a', name: 'Example Model A' }, { id: 'model-b', name: 'Example Model B' }],
      async streamResponse({ messages, signal, onDelta }) {
        const question = messages.at(-1).content;
        log({ type: 'openai.request', question });
        if (question.includes('fail')) {
          throw new Error('Synthetic failure: ChatGPT plan usage limit reached (429 usage_limit_reached).');
        }
        const reply = question.includes('quick') ? 'Done. **Short** answer with `code`.' : LONG_REPLY;
        // Token-sized pieces at a token-like pace.
        const pieces = reply.match(/[\s\S]{1,6}/g);
        let sent = 0;
        for (const piece of pieces) {
          if (signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, question.includes('quick') ? 5 : 16));
          if (signal.aborted) break;
          onDelta(piece);
          sent += 1;
        }
        log({ type: 'openai.deltas', count: sent });
        if (signal.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
      }
    };
    // Stage 2: the view works out a project context, which needs a storage
    // folder (for the identity key) and per-workspace state.
    const context = { globalState: memento(), workspaceState: memento(), subscriptions: [], globalStorageUri: vscode.Uri.file(path.join(dir, 'storage')) };

    panel = vscode.window.createWebviewPanel('planChat.uiTest', 'Kenlith UI test', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.onDidReceiveMessage((message) => {
      const text = typeof message?.text === 'string' ? message.text : undefined;
      log({ type: 'webview', message: message?.type, text: text && text.length > 200 ? `${text.slice(0, 200)}…` : text });
    });
    const provider = new ChatViewProvider(context, auth, openai, store, {
      writeClipboard: async (text) => { synthetic.clipboard.push(text); },
      openExternal: async (url) => { synthetic.opened.push(url); log({ type: 'platform.openExternal', url }); }
    });
    await provider.resolveWebviewView({ webview: panel.webview, onDidDispose: (callback) => panel.onDidDispose(callback) });
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ ready: true }));

    // Commands from the runner, one file per step.
    const deadline = Date.now() + 420_000;
    for (let sequence = 1; Date.now() < deadline;) {
      const file = path.join(dir, `control-${sequence}.json`);
      if (!fs.existsSync(file)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const command = JSON.parse(fs.readFileSync(file, 'utf8'));
      let result;
      if (command.cmd === 'theme') {
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', command.name, vscode.ConfigurationTarget.Global);
        result = vscode.workspace.getConfiguration('workbench').get('colorTheme');
      } else if (command.cmd === 'readClipboard') {
        result = synthetic.clipboard.at(-1);
      } else if (command.cmd === 'seedLongChat') {
        // WP-05 T05-05 (R-20): a chat whose history is larger than one
        // request's budget (80,000 characters), opened in the view.
        const previousId = (await store.getCurrent()).id;
        const longId = (await store.newConversation()).id;
        for (let index = 0; index < 3; index += 1) {
          await store.addMessage('user', `Long question ${index + 1}: ${'q'.repeat(30_000)}`, longId);
          await store.addMessage('assistant', `Long answer ${index + 1}: ${'a'.repeat(30_000)}`, longId);
        }
        await provider.openReadOnly(longId);
        result = { longId, previousId };
      } else if (command.cmd === 'openChat') {
        await provider.openReadOnly(command.id);
        result = (await store.getCurrent()).id;
      } else if (command.cmd === 'done') {
        fs.writeFileSync(path.join(dir, `ack-${sequence}.json`), JSON.stringify({ result: 'bye' }));
        break;
      }
      fs.writeFileSync(path.join(dir, `ack-${sequence}.json`), JSON.stringify({ result }));
      sequence += 1;
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  } finally {
    panel?.dispose();
    globalThis.fetch = realFetch;
    fs.writeFileSync(process.env.PLAN_CHAT_IT_RESULT, JSON.stringify(report, null, 2));
  }
};
