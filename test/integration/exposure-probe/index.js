'use strict';

// Test-only "other extension" for test/integration/exposure.js. It runs in the
// same extension host as Kenlith and tries to reach Kenlith's internals
// the ways the extension API allows: its exports, its commands, its secrets.
// It also records what the shared host allows regardless (loading Plan
// Chat's source files by path), so the report can tell the two apart.
// It does nothing unless PLAN_CHAT_EXPOSURE_RESULT is set, and it never
// reads a real token or real history: the profiles are throwaway.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const PLAN_CHAT = 'local-open-source.plan-chat-antigravity';

async function activate(context) {
  const resultFile = process.env.PLAN_CHAT_EXPOSURE_RESULT;
  if (!resultFile) return;
  // No network for anything in this host.
  globalThis.fetch = async () => { throw new Error('Network is disabled in the exposure test.'); };
  const report = { host: vscode.env.appName, version: vscode.version, errors: [] };
  try {
    if (process.env.PLAN_CHAT_IT_UI_DIR) {
      // Test copy: wait until its entry point has wired the view.
      const ready = path.join(process.env.PLAN_CHAT_IT_UI_DIR, 'ready.json');
      for (let index = 0; index < 300 && !fs.existsSync(ready); index += 1) await new Promise((r) => setTimeout(r, 100));
      report.testCopyReady = fs.existsSync(ready);
    }
    const target = vscode.extensions.getExtension(PLAN_CHAT);
    report.found = Boolean(target);
    if (target) {
      const exported = await target.activate();
      report.active = target.isActive;
      report.exportsType = exported === undefined ? 'undefined' : typeof exported;
      report.exportKeys = exported && typeof exported === 'object' ? Object.keys(exported) : [];
      report.exportsViaProperty = target.exports === undefined ? 'undefined' : typeof target.exports;
      report.mainEntry = target.packageJSON.main;
      const commands = await vscode.commands.getCommands(true);
      report.planChatCommands = commands.filter((command) => command.startsWith('planChat.')).sort();
      report.manifestCommands = target.packageJSON.contributes.commands.map((item) => item.command).sort();

      // Kenlith's credential key, read through this extension's own
      // SecretStorage: the editor scopes secrets per extension.
      const { CREDENTIALS_KEY } = require(path.join(target.extensionPath, 'src', 'auth.js'));
      report.secretReadable = (await context.secrets.get(CREDENTIALS_KEY)) !== undefined;

      // Shared-host facts (not protections Kenlith can provide): any
      // extension can load another's files by path and read the profile on disk.
      report.canLoadPlanChatSource = typeof require(path.join(target.extensionPath, 'src', 'view.js')).ChatViewProvider === 'function';
      report.testEntryShipped = fs.existsSync(path.join(target.extensionPath, 'test-main.js'));
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  await vscode.commands.executeCommand('workbench.action.quit');
}

module.exports = { activate, deactivate() {} };
