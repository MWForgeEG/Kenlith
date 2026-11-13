'use strict';

// Scenario "stage3" for test/integration/stage3.js. Runs only inside the
// throwaway test copy (lib/test-copy.js copies it to test-scenario/stage3.js)
// with the fakes of sidebar-ui.js (no network, fake sign-in and model). It
// opens real editors on synthetic files, runs the real Attach Selection
// command, and talks to the view exactly as its webview does: the scenario
// wraps resolveWebviewView (in this copy only) to hold the view's message
// handler and to record what the extension posts. Nothing is added to src/.
//
// The report records, per action, what the window did: attachment metadata
// (never the text, except a hash and a length), notices, and the full content
// of every model request (synthetic code only).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);

async function run(provider, context) {
  const dir = process.env.PLAN_CHAT_IT_UI_DIR;
  const step = JSON.parse(process.env.PLAN_CHAT_IT_STEP || '{}');
  const report = { host: vscode.env.appName, version: vscode.version, label: step.label, globalStorage: context.globalStorageUri.fsPath, results: [], requests: [], errors: [] };
  const write = () => fs.writeFileSync(path.join(dir, `stage3-${step.label}.json`), JSON.stringify(report, null, 2));
  const posts = [];
  let handler;
  try {
    if (provider.view) throw new Error('the view opened before the scenario could attach to it');
    const resolve = provider.resolveWebviewView.bind(provider);
    provider.resolveWebviewView = (view, ...rest) => {
      const webview = view.webview;
      const post = webview.postMessage.bind(webview);
      webview.postMessage = (message) => {
        posts.push(message);
        return post(message);
      };
      const listen = webview.onDidReceiveMessage.bind(webview);
      webview.onDidReceiveMessage = (callback, ...more) => {
        handler = callback;
        return listen(callback, ...more);
      };
      return resolve(view, ...rest);
    };
    // Full request content (synthetic) for the runner's checks.
    const stream = provider.openAIService.streamResponse.bind(provider.openAIService);
    provider.openAIService.streamResponse = async (options) => {
      report.requests.push({ label: currentLabel, contents: options.messages.map((message) => message.content) });
      const question = options.messages.at(-1).content;
      if (question.includes('[Code selection attached by the user')) {
        options.onDelta('ATTACHED-REPLY about the code.');
        return undefined;
      }
      return stream(options);
    };
    const virtual = vscode.workspace.registerTextDocumentContentProvider('plan-chat-virtual', { provideTextDocumentContent: () => 'const virtualSynthetic = 1;\nconst second = 2;\n' });
    context.subscriptions.push(virtual);

    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
    await vscode.commands.executeCommand('workbench.view.extension.planChat');
    for (let index = 0; index < 200 && !(provider.view && handler); index += 1) await sleep(100);
    if (!handler) throw new Error('the view did not open');
    await sleep(800);

    let currentLabel = '';
    const send = (message) => handler(message);
    const lastAttachmentPost = () => posts.filter((message) => message.type === 'attachment').at(-1);
    const describe = () => {
      const pending = provider.attachment;
      const last = lastAttachmentPost();
      return {
        pending: pending ? {
          id: pending.snapshot.id,
          approved: pending.approved,
          changed: pending.changed,
          displayPath: pending.snapshot.source.displayPath,
          languageId: pending.snapshot.source.languageId,
          lines: [pending.snapshot.source.startLine, pending.snapshot.source.endLine],
          unsaved: pending.snapshot.source.unsaved,
          untitled: pending.snapshot.source.untitled,
          chars: pending.snapshot.chars,
          textHash: hash(pending.snapshot.text),
          credentialLines: [...pending.snapshot.flags.credentialPattern]
        } : null,
        notice: last?.notice?.text || null,
        cardShown: Boolean(last?.attachment),
        context: { kind: provider.windowContext?.kind, label: provider.windowContext?.label, reason: provider.windowContext?.reason },
        errors: posts.filter((message) => message.type === 'error').map((message) => message.message).slice(-1)
      };
    };
    let editor;
    let remembered;

    for (const action of step.actions || []) {
      currentLabel = action.label || action.do;
      const entry = { action: currentLabel };
      try {
        if (action.do === 'open') {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(action.file));
          editor = await vscode.window.showTextDocument(document, { preview: false });
          editor.selection = new vscode.Selection(...action.select);
          entry.scheme = document.uri.scheme;
          entry.selected = editor.document.getText(editor.selection).length;
        } else if (action.do === 'openUntitled') {
          const document = await vscode.workspace.openTextDocument({ content: action.content, language: 'javascript' });
          editor = await vscode.window.showTextDocument(document, { preview: false });
          editor.selection = new vscode.Selection(...action.select);
          entry.scheme = document.uri.scheme;
        } else if (action.do === 'openVirtual') {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('plan-chat-virtual:/sample.js'));
          editor = await vscode.window.showTextDocument(document, { preview: false });
          editor.selection = new vscode.Selection(0, 0, 1, 0);
          entry.scheme = document.uri.scheme;
        } else if (action.do === 'edit') {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(editor.document.uri, new vscode.Position(0, 0), action.text);
          entry.applied = await vscode.workspace.applyEdit(edit);
          await sleep(300);
          entry.dirty = editor.document.isDirty;
        } else if (action.do === 'select') {
          editor = await vscode.window.showTextDocument(editor.document, { preview: false });
          editor.selection = new vscode.Selection(...action.select);
        } else if (action.do === 'attach') {
          // The real command, as the editor menu and command palette run it.
          await vscode.commands.executeCommand('planChat.attachSelection');
          await sleep(300);
          entry.activeEditor = vscode.window.activeTextEditor?.document.uri.scheme || null;
        } else if (action.do === 'approve') {
          await send({ type: 'approveAttachment', id: provider.attachment?.snapshot.id, reviewed: action.reviewed });
        } else if (action.do === 'remember') {
          remembered = provider.attachment?.snapshot.id;
        } else if (action.do === 'send') {
          const id = action.useRemembered ? remembered : provider.attachment?.snapshot.id;
          const before = report.requests.length;
          await send({ type: 'send', text: action.text, model: 'model-a', attachmentId: action.withAttachment || action.useRemembered ? id : undefined });
          entry.requestSent = report.requests.length > before;
          entry.restoredDraft = posts.filter((message) => message.type === 'restoreDraft').at(-1)?.text || null;
        } else if (action.do === 'choose') {
          const folder = (vscode.workspace.workspaceFolders || []).find((candidate) => path.basename(candidate.uri.fsPath) === action.folder);
          await provider.project.choose(folder ? folder.uri.toString() : 'general');
          await provider.workspaceChanged();
        } else if (action.do === 'newChat') {
          await send({ type: 'newChat' });
        } else if (action.do === 'revert') {
          // Leaves no unsaved buffer behind, so closing the window cannot prompt.
          await vscode.window.showTextDocument(editor.document, { preview: false });
          await vscode.commands.executeCommand('workbench.action.files.revert');
          entry.dirty = editor.document.isDirty;
        } else if (action.do === 'discard') {
          // Closes unsaved untitled editors without saving them.
          for (const document of vscode.workspace.textDocuments.filter((candidate) => candidate.isUntitled && candidate.isDirty)) {
            await vscode.window.showTextDocument(document, { preview: false });
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
          }
          entry.leftDirty = vscode.workspace.textDocuments.filter((candidate) => candidate.isDirty).length;
        } else if (action.do === 'stored') {
          const current = await provider.store.getCurrent();
          entry.messages = current.messages.map((message) => ({ role: message.role, content: message.content, attachments: message.attachments, attachmentTurn: message.attachmentTurn, contextPolicy: message.contextPolicy }));
          const hydrate = posts.filter((message) => message.type === 'hydrate').at(-1);
          entry.hydratedAttachment = hydrate && 'attachment' in hydrate ? hydrate.attachment : 'none';
        }
      } catch (error) {
        entry.error = String(error?.message || error);
      }
      Object.assign(entry, describe());
      report.results.push(entry);
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  write();
}

module.exports = { run };
