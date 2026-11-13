'use strict';

// Scenario for test/integration/sidebar-ui.js. This file runs only inside
// the throwaway test copy of Kenlith (lib/test-copy.js copies it to
// test-scenario/), whose entry point test-main.js passes createDoubles() to
// activateWith(). The real view and commands in the real sidebar then use:
//
// - sign-in: a fake that only logs; no token exists anywhere;
// - model: a fake that streams token-sized pieces; logs the model asked for;
// - clipboard and browser: stand-ins that record what they were given; the
//   operating system clipboard is never read or written;
// - network: fetch is blocked for the whole extension host;
// - history: Kenlith's own store, in the throwaway profile.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { ConversationStore } = require('../src/store');
const { RequestError } = require('../src/util');
const { isBuiltRequest } = require('../src/request-builder');
const { PLAN_SCOPE, WELCOME_KEY } = require('../src/siwc');
const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';
// The synthetic session carries the scope set a real ChatGPT plan sign-in has.
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
const EMAIL = 'synthetic.user@example.test';
const dir = process.env.PLAN_CHAT_IT_UI_DIR;
const log = (event) => {
  if (dir) fs.appendFileSync(path.join(dir, 'host-events.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
};
// requests: the full content of each model request (synthetic text only).
const synthetic = { clipboard: [], opened: [], requests: [], instructions: [] };
// M1-4: project context needs an account id; the runner turns it on for one block.
let projectSubject = false;
let signedIn = true;

// The parts test-main.js hands to activateWith().
function createDoubles(context) {
  globalThis.fetch = async (url) => {
    log({ type: 'blockedFetch', url: String(url) });
    throw new Error('Network is disabled in the UI test.');
  };
  return {
    authService: {
      getSession: async () => (signedIn ? { email: EMAIL, name: 'Synthetic User', scopes: SCOPES, ...(projectSubject ? { subject: 'synthetic-subject-1' } : {}) } : undefined),
      signIn: async () => { log({ type: 'auth.signIn' }); signedIn = true; },
      signOut: async () => {
        log({ type: 'auth.signOut' });
        signedIn = false;
        return { remoteRevoked: true };
      }
    },
    openAIService: {
      // 0.8.0: PLAN_CHAT_IT_MODELS (JSON [{ id, name }]) lets a runner use
      // documented slugs (test/integration/thinking-ui.js); unset, as before.
      listModels: async () => (process.env.PLAN_CHAT_IT_MODELS ? JSON.parse(process.env.PLAN_CHAT_IT_MODELS) : [{ id: 'model-a', name: 'Example Model A' }, { id: 'model-b', name: 'Example Model B' }]),
      async streamResponse({ model, request, messages, instructions, signal, onDelta, preflight, onToolCalls }) {
        // As the real transport: only requests made by the request builder, and
        // the consent gate's last check first.
        if (!isBuiltRequest(request)) throw new Error('The test transport received a request not made by the request builder.');
        if (request.requiresGate && !preflight) throw new Error('A project request arrived without its last check.');
        if (preflight) await preflight();
        const question = messages.at(-1).content;
        log({ type: 'openai.request', model, question: question.slice(0, 200), effort: request.reasoning ? request.reasoning.effort : null });
        synthetic.requests.push(messages.map((message) => message.content));
        synthetic.instructions.push(instructions);
        // 0.5.0 RC3 (DEC-PLANCHAT-024): a model that asks for the project
        // summary, through the engine's real tool callback; the continuation
        // goes through the gate again, as with the real transport.
        // 0.6.0 (DEC-PLANCHAT-026): a model that proposes one edit through the
        // engine's real tool callback, then ends its reply. The proposal only
        // records; the user reviews it after the reply.
        // 0.7.0 (DEC-PLANCHAT-030): one safe local check (Class A, no card)
        // and one consequential run (Class B, one card), through the engine's
        // real tool callback.
        if (question.includes('RUNCMD') && request.tools && typeof onToolCalls === 'function') {
          const call = (id, executable, args) => ({ callId: id, name: 'project_run_command', arguments: JSON.stringify({ executable, args, cwd: null, timeout_seconds: null, env: [], purpose: 'checking the project' }) });
          const next = await onToolCalls([call('call_it_r1', 'node', ['--version']), call('call_it_r2', 'node', ['-e', "require('fs').appendFileSync('d4-ran.txt','x')"])], request);
          if (!next) return;
          if (next.requiresGate && preflight) await preflight();
          log({ type: 'openai.toolContinuation', outputs: next.continuation.filter((item) => item.type === 'function_call_output').map((item) => item.output.slice(0, 300)) });
          onDelta('RUNCMD-REPLY: both runs reported.');
          return;
        }
        if (question.includes('PROPOSE') && request.tools && typeof onToolCalls === 'function') {
          const next = await onToolCalls([{ callId: 'call_it_p', name: 'project_propose_edit', arguments: JSON.stringify({ path: 'src/notes.js', summary: 'Set the release to 0.6.0.', edits: [{ find: 'const release = "0.4.0";', replace: 'const release = "0.6.0";' }] }) }], request);
          if (!next) return;
          if (next.requiresGate && preflight) await preflight();
          log({ type: 'openai.toolContinuation', outputs: next.continuation.filter((item) => item.type === 'function_call_output').map((item) => item.output.slice(0, 200)) });
          onDelta('PROPOSE-REPLY: review the proposed change below.');
          return;
        }
        if (question.includes('TOOLCARD') && request.tools && typeof onToolCalls === 'function') {
          const next = await onToolCalls([{ callId: 'call_it_1', name: 'project_summary', arguments: '{}' }], request);
          if (!next) return;
          if (next.requiresGate && preflight) await preflight();
          const outputs = next.continuation.filter((item) => item.type === 'function_call_output');
          log({ type: 'openai.toolContinuation', outputs: outputs.map((item) => item.output.slice(0, 200)) });
          onDelta('الكود في المجلد src/ في هذا المشروع. TOOL-REPLY');
          return;
        }
        if (question.includes('[Code selection attached by the user')) {
          // Stage 3: a short reply to a turn with attached code.
          onDelta('ATTACHED-REPLY: the function builds a greeting.');
          return;
        }
        // M1-0: the structured ChatGPT plan usage-limit error, before the
        // stream or after part of it, and an unrelated 429 (synthetic).
        if (question.includes('usage limit before')) {
          throw new RequestError('Synthetic: ChatGPT plan usage limit reached. (429 ' + USAGE_LIMIT + ')', { status: 429, code: USAGE_LIMIT });
        }
        if (question.includes('usage limit during')) {
          onDelta('Partial reply before the limit. ');
          throw new RequestError('Synthetic: ChatGPT plan usage limit reached. (' + USAGE_LIMIT + ')', { code: USAGE_LIMIT });
        }
        if (question.includes('rate limited')) {
          throw new RequestError('Synthetic: rate limit reached for requests. (429 rate_limit_exceeded)', { status: 429, code: 'rate_limit_exceeded' });
        }
        if (question.includes('fail')) {
          throw new Error('Synthetic failure: ChatGPT plan usage limit reached (429 usage_limit_reached).');
        }
        const reply = question.includes('quick')
          ? 'Done. **Short** answer with `code`.'
          : Array.from({ length: 120 }, (_, index) => `${index + 1}. **Rule ${index + 1}.** Instructions, history and the new message count against the 80,000-character limit.`).join('\n');
        let sent = 0;
        const pieces = reply.match(/[\s\S]{1,6}/g);
        log({ type: 'openai.pieces', total: pieces.length });
        for (const piece of pieces) {
          if (signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, question.includes('quick') ? 5 : 16));
          if (signal.aborted) break;
          onDelta(piece);
          sent += 1;
        }
        log({ type: 'openai.deltas', count: sent });
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    },
    store: new ConversationStore(context),
    platform: {
      writeClipboard: async (text) => { synthetic.clipboard.push(text); log({ type: 'platform.clipboard', length: text.length }); },
      openExternal: async (url) => { synthetic.opened.push(url); log({ type: 'platform.openExternal', url }); }
    }
  };
}

async function run(provider, context) {
  const sink = `http://127.0.0.1:${process.env.PLAN_CHAT_IT_SINK_PORT}`;
  const report = { host: vscode.env.appName, version: vscode.version, errors: [] };
  if (process.env.PLAN_CHAT_IT_EXPOSURE_ONLY) {
    // Isolation test: the view is wired with the fakes; the probe extension
    // does the checking and closes the window.
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ ready: true }));
    return;
  }
  try {
    // A fresh Antigravity profile shows a first-run notice in the secondary
    // side bar that takes keyboard focus away from Quick Picks. It is closed,
    // never answered (its button agrees to data collection). In VS Code this
    // closes its chat side bar.
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
    const realShowHistory = provider.showHistory.bind(provider);
    provider.showHistory = async (...args) => {
      log({ type: 'history.open' });
      await realShowHistory(...args);
      log({ type: 'history.closed', current: (await provider.store.getCurrent()).id });
    };
    const realShowAll = provider.showAllChats.bind(provider);
    provider.showAllChats = async (options) => {
      log({ type: 'allChats.open', options });
      await realShowAll(options);
      log({ type: 'allChats.closed', current: (await provider.store.getCurrent()).id, readOnly: provider.readOnly || null });
    };
    const realStop = provider.stop.bind(provider);
    provider.stop = () => {
      log({ type: 'provider.stop', active: Boolean(provider.activeAbort) });
      realStop();
    };

    // Synthetic history in this profile: an English chat, a mixed one, and an
    // Arabic chat (opened last, so it is current).
    const store = provider.store;
    // Stage 2: the window's context first, so seeded chats get its tag.
    await provider.workspaceChanged();
    await store.initialize();
    const english = (await store.newConversation()).id;
    await store.addMessage('user', 'Refactor the budget check', english);
    await store.addMessage('assistant', [
      'Each write takes `conversations.lock` first, so the second window waits. **Nothing is lost.**',
      '',
      '- one change per transaction',
      '- the file is replaced atomically',
      '',
      `See [the design note](${sink}/plan-chat-ui-link).`,
      '',
      '<img src=x onerror="document.body.dataset.xss=1"> <script>document.body.dataset.xss=2</script> [cmd](command:workbench.action.reloadWindow)'
    ].join('\n'), english);
    const mixed = (await store.newConversation()).id;
    await store.addMessage('user', 'Mixed: ما الفرق بين store.js و lock.js؟', mixed);
    await store.addMessage('assistant', '`store.js` يحفظ المحادثات، و`lock.js` يمنع نافذتين من الكتابة معًا. Both live in `src/`.', mixed);
    // A chat of another project, to check the read-only view (stage 2).
    const identity = await provider.project.identity.load();
    const elsewhere = (await store.newConversation()).id;
    await store.addMessage('user', 'Elsewhere: سؤال من مشروع آخر', elsewhere);
    await store.moveConversation(elsewhere, { kind: 'project', key: '0'.repeat(32), keyId: identity.keyId, label: 'مشروع-بيتا' });
    // WP-05 (DEC-PLANCHAT-009): in a folder window, a chat tagged by the
    // earlier identity scheme for this folder. Its key is computed here from
    // the earlier rule (lower-case, NFC, "file:" + path), not taken from the
    // product's own legacyKey, so the Relink check is not circular.
    let legacy;
    if (provider.windowContext?.kind === 'project') {
      const crypto = require('node:crypto');
      const resolved = path.normalize(fs.realpathSync.native(provider.windowContext.folderPath)).replace(/[\\/]+$/, '');
      const oldInput = (process.platform === 'win32' ? resolved.toLowerCase() : resolved).normalize('NFC');
      const oldKey = crypto.createHmac('sha256', Buffer.from(identity.key, 'hex')).update(`file:${oldInput}`, 'utf8').digest('hex').slice(0, 32);
      legacy = (await store.newConversation()).id;
      await store.addMessage('user', 'Legacy relink: سؤال قديم', legacy);
      await store.moveConversation(legacy, { kind: 'project', key: oldKey, keyId: identity.keyId, label: provider.windowContext.label });
    }
    // WP-02 T02-06: a long mixed-language title, a long path inside Arabic
    // text and a long code line, for the layout matrix.
    const long = (await store.newConversation()).id;
    await store.addMessage('user', 'Long title: كيف أنظّم المحادثات حسب المشروع عندما يكون اسم المجلد طويلًا جدًا والشريط الجانبي ضيقًا؟', long);
    await store.addMessage('assistant', [
      'المسار الكامل هو C:\\Users\\synthetic\\projects\\a-very-long-folder-name-for-layout-testing\\src\\components\\ConversationHistoryPanel.js ويجب أن يبقى مقروءًا.',
      '',
      '```js',
      "const veryLongLine = computeSomethingWithAVeryLongFunctionName(argumentNumberOne, argumentNumberTwo, argumentNumberThree, argumentNumberFour);",
      '```'
    ].join('\n'), long);
    const arabic = (await store.newConversation()).id;
    await store.addMessage('user', 'اشرح لي كيف تعمل دالة addMessage في store.js', arabic);
    for (let index = 0; index < 5; index += 1) {
      await store.addMessage('assistant', `Earlier answer ${index + 1}. History is **local**, in \`conversations.json\`.`, arabic);
      await store.addMessage('user', `Earlier question ${index + 2}: how is history kept?`, arabic);
    }
    await store.addMessage('assistant', [
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
      'المسار: C:\\Users\\synthetic\\src\\store.js، And in English: one lock per write.'
    ].join('\n'), arabic);
    await store.selectConversation(arabic);
    log({ type: 'seeded', chats: { english, mixed, arabic, legacy } });

    await vscode.commands.executeCommand('workbench.view.extension.planChat');
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ ready: true, chats: { english, mixed, arabic } }));

    const deadline = Date.now() + 900_000;
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
      } else if (command.cmd === 'projectSubject') {
        projectSubject = Boolean(command.on);
        result = projectSubject;
      } else if (command.cmd === 'setProjectContext') {
        // The documented user-level switch, written to user settings.
        await vscode.workspace.getConfiguration('kenlith').update('projectContext.enabled', command.value, vscode.ConfigurationTarget.Global);
        result = vscode.workspace.getConfiguration('kenlith').inspect('projectContext.enabled').globalValue;
      } else if (command.cmd === 'newChatCommand') {
        await vscode.commands.executeCommand('planChat.newChat');
        result = true;
      } else if (command.cmd === 'welcomeState') {
        result = context.globalState.get(WELCOME_KEY) ?? null;
      } else if (command.cmd === 'clearWelcome') {
        // Stands for a fresh profile: no sign-in has happened in it yet.
        await context.globalState.update(WELCOME_KEY, undefined);
        result = true;
      } else if (command.cmd === 'synthetic') {
        result = synthetic;
      } else if (command.cmd === 'canary') {
        // Editor-level navigation, to prove the browser stub catches it.
        result = await vscode.env.openExternal(vscode.Uri.parse(`${sink}/canary`));
      } else if (command.cmd === 'currentChat') {
        result = (await store.getCurrent()).id;
      } else if (command.cmd === 'openFile' || command.cmd === 'openUntitled') {
        // Stage 3: a real editor on a synthetic document, with a selection.
        const document = command.cmd === 'openFile'
          ? await vscode.workspace.openTextDocument(vscode.Uri.file(command.path))
          : await vscode.workspace.openTextDocument({ content: command.content, language: 'javascript' });
        const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
        editor.selection = new vscode.Selection(...command.select);
        result = { scheme: document.uri.scheme, selected: document.getText(editor.selection).length };
      } else if (command.cmd === 'editActive') {
        const editor = vscode.window.activeTextEditor;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(editor.document.uri, new vscode.Position(0, 0), command.text);
        result = await vscode.workspace.applyEdit(edit);
      } else if (command.cmd === 'discardEditors') {
        // Leaves no unsaved editor behind, so closing the window cannot prompt.
        for (const document of vscode.workspace.textDocuments.filter((candidate) => candidate.isDirty)) {
          await vscode.window.showTextDocument(document, { preview: false });
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
        result = vscode.workspace.textDocuments.filter((candidate) => candidate.isDirty).length;
      } else if (command.cmd === 'acceptQuickPick') {
        // Investigation only: the editor's own accept command, instead of Enter.
        result = await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem').then(() => 'ran', (error) => `failed: ${error?.message}`);
      } else if (command.cmd === 'wrapQuickPick') {
        // Diagnostic (WP-02 T02-01): record what showQuickPick returns to Plan
        // Chat. Only in this throwaway test copy.
        if (!vscode.window.__planChatWrapped) {
          const real = vscode.window.showQuickPick;
          try {
            vscode.window.showQuickPick = async (items, options, token) => {
              const started = Date.now();
              log({ type: 'qp.show', title: options && options.title });
              const picked = await real.call(vscode.window, items, options, token);
              log({ type: 'qp.result', title: options && options.title, picked: picked ? String(picked.label) : null, ms: Date.now() - started });
              return picked;
            };
            vscode.window.__planChatWrapped = true;
          } catch (error) {
            log({ type: 'qp.wrapFailed', error: String(error) });
          }
        }
        result = Boolean(vscode.window.__planChatWrapped) && vscode.window.showQuickPick !== undefined;
      } else if (command.cmd === 'probeQuickPick') {
        // Diagnostic: the same kind of items in a list Kenlith does not own,
        // through showQuickPick or createQuickPick, with every event logged.
        const items = [
          { label: '$(add) New Chat' },
          { label: '$(list-unordered) All Chats…', description: 'other projects, General and earlier chats' },
          { label: 'Probe section', kind: vscode.QuickPickItemKind.Separator },
          { label: 'Refactor the budget check', description: 'just now', detail: 'Thursday, synthetic' },
          { label: 'Elsewhere: synthetic', description: 'read-only here', detail: 'Thursday, synthetic' }
        ];
        const tag = command.api;
        if (command.api === 'createQuickPick') {
          const pick = vscode.window.createQuickPick();
          pick.title = 'Probe: createQuickPick';
          pick.items = items;
          pick.matchOnDescription = true;
          pick.onDidChangeValue((value) => log({ type: 'cqp.value', value }));
          pick.onDidChangeActive((active) => log({ type: 'cqp.active', label: active[0] && active[0].label }));
          pick.onDidAccept(() => { log({ type: 'cqp.accept', active: pick.activeItems[0] && pick.activeItems[0].label }); pick.hide(); });
          pick.onDidHide(() => { log({ type: 'cqp.hide' }); pick.dispose(); });
          pick.show();
        } else {
          vscode.window.showQuickPick(items, { title: 'Probe: showQuickPick', matchOnDescription: true })
            .then((picked) => log({ type: 'sqp.result', picked: picked ? picked.label : null }));
        }
        result = tag;
      } else if (command.cmd === 'enterKeybindings') {
        // Diagnostic: every registered keybinding for plain Enter, from the
        // editor's read-only Default Keybindings document (metadata only).
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('vscode://defaultsettings/keybindings.json'));
        const text = document.getText();
        const entries = [];
        for (const block of text.split('{ "key": ').slice(1)) {
          const entry = block.slice(0, block.indexOf('}') + 1).replace(/s+/g, ' ');
          if (entry.toLowerCase().startsWith('"enter"')) entries.push(entry);
        }
        const sample = text.indexOf('"enter"');
        result = { total: entries.length, entries, length: text.length, mentions: (text.match(/"enter"/gi) || []).length, sample: sample >= 0 ? text.slice(Math.max(0, sample - 120), sample + 200) : text.slice(0, 300) };
      } else if (command.cmd === 'chooseContext') {
        // Diagnostic (T02-04): change the window's project as the picker does.
        const folder = (vscode.workspace.workspaceFolders || []).find((candidate) => path.basename(candidate.uri.fsPath) === command.folder);
        await provider.project.choose(folder ? folder.uri.toString() : 'general');
        await provider.workspaceChanged();
        result = provider.windowContext && (provider.windowContext.label || provider.windowContext.kind);
      } else if (command.cmd === 'cycleFolder') {
        // Diagnostic (T02-04): remove the last workspace folder, then add it back.
        const folders = vscode.workspace.workspaceFolders || [];
        const last = folders[folders.length - 1];
        const changed = () => new Promise((resolve) => { const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => { sub.dispose(); resolve(); }); setTimeout(resolve, 5000); });
        let waiting = changed();
        vscode.workspace.updateWorkspaceFolders(folders.length - 1, 1);
        await waiting;
        waiting = changed();
        vscode.workspace.updateWorkspaceFolders(folders.length - 1, 0, { uri: last.uri });
        await waiting;
        await new Promise((resolve) => setTimeout(resolve, 800));
        result = (vscode.workspace.workspaceFolders || []).map((folder) => path.basename(folder.uri.fsPath));
      } else if (command.cmd === 'identityProbe') {
        // Diagnostic (WP-03 T03-01): the project key for one folder reached
        // through several spellings of its URI, with the editor's own Uri.
        const { folderIdentityInput, projectKey } = require('../src/project');
        const key = 'a'.repeat(64);
        const standard = vscode.Uri.file(command.folder);
        const text = standard.toString();
        const spellings = {
          'Uri.file': standard,
          'parsed toString()': vscode.Uri.parse(text),
          'upper-case drive': vscode.Uri.parse(text.replace(/^file:\/\/\/([a-z])(%3A|:)/i, (whole, drive, colon) => 'file:///' + drive.toUpperCase() + colon)),
          'plain colon': vscode.Uri.parse(text.replace(/^file:\/\/\/([a-z])%3A/i, (whole, drive) => 'file:///' + drive + ':')),
          'Arabic not percent-encoded': vscode.Uri.parse('file:///' + command.folder.split(String.fromCharCode(92)).join('/')),
          'trailing slash': vscode.Uri.parse(text + '/')
        };
        result = {};
        for (const [name, uri] of Object.entries(spellings)) {
          result[name] = { fsPath: uri.fsPath, key: projectKey(key, (await folderIdentityInput(uri.fsPath)).input) };
        }
      } else if (command.cmd === 'leaveReadOnly') {
        if (provider.readOnly) await provider.leaveReadOnly();
        result = (await store.getCurrent()).id;
      } else if (command.cmd === 'chatIds') {
        result = (await store.listConversations()).items.map((item) => item.id);
      } else if (command.cmd === 'openChat') {
        // Back to a chat of this context (opens it normally when allowed).
        await provider.openReadOnly(command.id);
        result = (await store.getCurrent()).id;
      } else if (command.cmd === 'contextKey') {
        result = provider.windowContext?.key || null;
      } else if (command.cmd === 'tagOf') {
        // The stored tag of one chat, as the history file holds it.
        const all = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
        result = all.conversations.find((item) => item.id === command.id)?.context || null;
      }
      fs.writeFileSync(path.join(dir, `ack-${sequence}.json`), JSON.stringify({ result }));
      sequence += 1;
      if (command.cmd === 'done') break;
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  } finally {
    fs.writeFileSync(process.env.PLAN_CHAT_IT_RESULT, JSON.stringify(report, null, 2));
  }
}

module.exports = { createDoubles, run };
