'use strict';

// Scenario "stage2" for test/integration/stage2.js. Runs only inside the
// throwaway test copy (lib/test-copy.js copies it to test-scenario/stage2.js)
// with the fakes of sidebar-ui.js (no network, fake sign-in). It opens the
// real view in a real editor window on real (synthetic) folders, performs the
// actions given in PLAN_CHAT_IT_STEP, and records what the window's context,
// list, startup chat and refusals were. History is the profile's own store,
// which the runner points at a shared synthetic folder.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(provider, context) {
  const dir = process.env.PLAN_CHAT_IT_UI_DIR;
  const step = JSON.parse(process.env.PLAN_CHAT_IT_STEP || '{}');
  const report = { host: vscode.env.appName, version: vscode.version, label: step.label, globalStorage: context.globalStorageUri.fsPath, snapshots: [], results: [], errors: [] };
  const write = () => fs.writeFileSync(path.join(dir, `stage2-${step.label}.json`), JSON.stringify(report, null, 2));
  try {
    if (step.openFile) {
      // Before the view opens: the multi-root default follows the active editor.
      await vscode.window.showTextDocument(vscode.Uri.file(step.openFile), { preview: false });
    }
    await vscode.commands.executeCommand('workbench.view.extension.planChat');
    // Wait for the view itself: the context is first worked out at activation,
    // and again (with the active editor) when the view opens.
    for (let index = 0; index < 200 && !(provider.view && provider.project.initialFolder !== undefined); index += 1) await sleep(100);
    if (!provider.view) throw new Error('the view did not open');
    await sleep(500);

    const snapshot = async (label) => {
      const context = provider.windowContext;
      const current = await provider.store.getCurrent();
      report.snapshots.push({
        label,
        context: { kind: context.kind, label: context.label, key: context.key, keyId: context.keyId, reason: context.reason, multiRoot: context.multiRoot, canChoose: context.canChoose, available: context.available },
        current: { id: current.id, title: current.title },
        list: (await provider.store.listConversations()).items.map((item) => ({ id: item.id, title: item.title, section: item.section })),
        all: (await provider.store.listAll()).map((item) => ({ id: item.id, title: item.title, section: item.section, allowed: item.allowed })),
        folders: (vscode.workspace.workspaceFolders || []).map((folder) => path.basename(folder.uri.fsPath))
      });
    };
    await snapshot('start');

    for (const action of step.actions || []) {
      if (action.do === 'create') {
        for (let index = 0; index < (action.count || 1); index += 1) {
          await provider.newChat();
          const id = (await provider.store.getCurrent()).id;
          await provider.store.addMessage('user', action.count ? `${action.title}-${index}` : action.title, id);
          if (action.pauseMs) await sleep(action.pauseMs);
        }
      } else if (action.do === 'forged') {
        // Ids of another context, as a forged webview message would carry them.
        const found = report.snapshots[0].all.find((item) => item.title === action.title);
        const id = found?.id;
        let select;
        let add;
        try { await provider.store.selectConversation(id); select = 'accepted'; } catch (error) { select = `refused: ${error.message}`; }
        try { await provider.store.addMessage('user', 'forged text', id); add = 'accepted'; } catch (error) { add = `refused: ${error.message}`; }
        report.results.push({ action: 'forged', title: action.title, found: Boolean(id), select, add });
      } else if (action.do === 'removeFolder') {
        const folders = vscode.workspace.workspaceFolders || [];
        const index = folders.findIndex((folder) => path.basename(folder.uri.fsPath) === action.folder);
        const changed = new Promise((resolve) => {
          const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => { subscription.dispose(); resolve(); });
        });
        report.results.push({ action: 'removeFolder', index, accepted: vscode.workspace.updateWorkspaceFolders(index, 1) });
        await Promise.race([changed, sleep(10000)]);
        await sleep(1500);
      } else if (action.do === 'choose') {
        const folder = (vscode.workspace.workspaceFolders || []).find((candidate) => path.basename(candidate.uri.fsPath) === action.folder);
        await provider.project.choose(folder ? folder.uri.toString() : 'general');
        await provider.workspaceChanged();
      } else if (action.do === 'wait') {
        await sleep(action.ms);
      }
      await snapshot(action.do + (action.folder ? `:${action.folder}` : '') + (action.title ? `:${action.title}` : ''));
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  write();
}

module.exports = { run };
