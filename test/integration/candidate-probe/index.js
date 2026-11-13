'use strict';

// Test-only probe for WP-06 (test/integration/candidate-install.js). The window
// has Kenlith installed for real in its throwaway profile (by the editor's
// own command line, from a VSIX). The probe reports what the editor loaded
// and, using that installed version's own code, what it does with the
// profile's history. Network is blocked for the whole extension host. The
// action comes from PLAN_CHAT_PROBE_STEP (JSON); the report goes to
// PLAN_CHAT_PROBE_RESULT. Synthetic data only.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const ID = 'local-open-source.plan-chat-antigravity';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function activate() {
  const resultFile = process.env.PLAN_CHAT_PROBE_RESULT;
  if (!resultFile) return;
  const blocked = [];
  globalThis.fetch = async (target) => { blocked.push(String(target)); throw new Error('Network is disabled in the candidate test.'); };
  const step = JSON.parse(process.env.PLAN_CHAT_PROBE_STEP || '{}');
  const storage = process.env.PLAN_CHAT_PROBE_STORAGE;
  const report = { host: vscode.env.appName, editorVersion: vscode.version, step: step.name, trusted: vscode.workspace.isTrusted, errors: [] };
  try {
    const target = vscode.extensions.getExtension(ID);
    report.found = Boolean(target);
    if (target) {
      report.version = target.packageJSON.version;
      report.extensionPath = target.extensionPath;
      report.isBuiltinOrDev = target.extensionKind === undefined ? null : target.extensionKind;
      report.activeBefore = target.isActive;
      try { await vscode.commands.executeCommand('workbench.view.extension.planChat'); report.opened = 'executed'; } catch (error) { report.opened = `rejected: ${error.message}`; }
      for (let index = 0; index < 50 && !target.isActive; index += 1) await sleep(100);
      report.activeAfter = target.isActive;
      report.exports = target.exports === undefined ? 'undefined' : Object.keys(target.exports || {});
      report.commands = (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('planChat.')).sort();
      report.contributedCommands = target.packageJSON.contributes.commands.map((command) => command.command).sort();
      report.editorMenu = (target.packageJSON.contributes.menus?.['editor/context'] || []).map((item) => `${item.command} when ${item.when}`);
      report.userInstructions = vscode.workspace.getConfiguration('planChat').inspect('instructions')?.globalValue;
      report.userHistoryLimit = vscode.workspace.getConfiguration('planChat').inspect('maxHistoryMessages')?.globalValue;
      // Kenlith 0.4.1 copies the planChat.* user values to kenlith.* when it activates.
      for (let index = 0; index < 30 && report.activeAfter && vscode.workspace.getConfiguration('kenlith').inspect('instructions')?.globalValue === undefined && target.packageJSON.contributes.configuration.properties['kenlith.instructions']; index += 1) await sleep(100);
      report.kenlithInstructions = vscode.workspace.getConfiguration('kenlith').inspect('instructions')?.globalValue;
      report.kenlithHistoryLimit = vscode.workspace.getConfiguration('kenlith').inspect('maxHistoryMessages')?.globalValue;
      report.declaresKenlith = Boolean(target.packageJSON.contributes.configuration.properties['kenlith.instructions']);
    }
    if (target && storage && report.activeAfter) {
      const src = (name) => path.join(target.extensionPath, 'src', name);
      const { ConversationStore } = require(src('store.js'));
      const store = new ConversationStore({ globalStorageUri: vscode.Uri.file(storage) });
      await store.initialize();
      const file = () => JSON.parse(fs.readFileSync(path.join(storage, 'conversations.json'), 'utf8'));
      report.fileChats = file().conversations.length;
      report.listedAll = (await store.listConversations()).items.length;
      if (step.writeTo) {
        const chat = (await store.listConversations()).items.find((item) => item.title === step.writeTo);
        if (chat) { await store.addMessage('user', step.text, chat.id); report.wroteTo = chat.id; }
      }
      if (step.contextOf) {
        // What this version would send as history for that chat.
        const chat = file().conversations.find((item) => item.title === step.contextOf);
        report.contextOf = chat ? (await store.contextMessages(chat.id)).map((message) => message.content) : null;
      }
      if (step.projectCheck && fs.existsSync(src('project.js'))) {
        // The installed version's own project logic, on this window's folder.
        const { ProjectContext, tagFor } = require(src('project.js'));
        const state = new Map();
        const project = new ProjectContext({ globalStorageUri: vscode.Uri.file(storage), workspaceState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); } } });
        const context = await project.resolve();
        report.context = { kind: context.kind, label: context.label, scheme: tagFor(context).scheme, available: context.available };
        store.setContext(context);
        report.projectListed = (await store.listConversations()).items.map((item) => item.title);
        report.sections = Object.entries((await store.listAll()).reduce((count, item) => ({ ...count, [item.section]: (count[item.section] || 0) + 1 }), {}));
        if (step.createProjectChat) {
          // A project chat with a reply about attached code, as 0.2.0 stores it.
          const chat = await store.newConversation();
          await store.addMessage('user', step.createProjectChat, chat.id, { attachments: [{ id: 'att-synthetic', kind: 'selection', displayPath: 'src/app.js', languageId: 'javascript', startLine: 1, endLine: 3, chars: 40, utf8Bytes: 40, flags: { unsaved: false, untitled: false, credentialPatternConfirmed: false }, outcome: 'sent', sentAt: '2026-10-29T00:00:00.000Z' }] });
          await store.addMessage('assistant', 'EXCLUDED-REPLY quoting the attached code', chat.id, { attachmentTurn: true, contextPolicy: 'excluded' });
          if (step.createProjectDerived) {
            // M1: a turn that used project excerpts, as 0.3.0 stores it (metadata only).
            const grant = { grantKeyId: 'synthetic-key', consentId: 'synthetic-consent', policyVersion: 1 };
            await store.addMessage('user', 'project-context question', chat.id, { project: { ...grant, consentRevision: 1, contextUsed: [{ relPath: 'src/app.js', range: [1, 3], sha256: 'a'.repeat(64) }] } });
            await store.addMessage('assistant', 'PROJECT-DERIVED-REPLY based on excerpts', chat.id, { project: grant });
          }
          report.createdProjectChat = chat.id;
          report.createdTag = file().conversations.find((item) => item.id === chat.id)?.context;
        }
        store.setContext({ kind: 'general', keyId: context.keyId, reason: 'no-folder' });
        report.generalListed = (await store.listConversations()).items.length;
      }
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  report.networkAttempts = blocked;
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  await vscode.commands.executeCommand('workbench.action.quit');
}

module.exports = { activate, deactivate() {} };
