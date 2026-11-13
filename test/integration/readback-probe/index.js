'use strict';

// Test-only probe for E9 (old-release read-back). The window has Plan Chat
// 0.1.2 installed in its throwaway profile (copied from the 0.1.2 source
// baseline; no VSIX). The probe activates it, then uses 0.1.2's own store
// code on the same history folder: it lists the chats and writes one message,
// as a 0.1.2 user would. The runner then checks the file. No network.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function activate() {
  const resultFile = process.env.PLAN_CHAT_READBACK_RESULT;
  if (!resultFile) return;
  globalThis.fetch = async () => { throw new Error('Network is disabled in the read-back test.'); };
  const report = { host: vscode.env.appName, version: vscode.version, errors: [] };
  try {
    const target = vscode.extensions.getExtension('local-open-source.plan-chat-antigravity');
    report.planChatVersion = target?.packageJSON.version;
    await target.activate();
    report.active = target.isActive;
    const { ConversationStore } = require(path.join(target.extensionPath, 'src', 'store.js'));
    const store = new ConversationStore({ globalStorageUri: vscode.Uri.file(process.env.PLAN_CHAT_READBACK_STORAGE) });
    await store.initialize();
    const list = await store.listConversations();
    report.listed = list.items.map((item) => ({ id: item.id, title: item.title }));
    const projectChat = list.items.find((item) => item.title === process.env.PLAN_CHAT_READBACK_WRITE_TO);
    if (projectChat) {
      await store.addMessage('user', 'written by 0.1.2', projectChat.id);
      report.wroteTo = projectChat.id;
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  await vscode.commands.executeCommand('workbench.action.quit');
}

module.exports = { activate, deactivate() {} };
