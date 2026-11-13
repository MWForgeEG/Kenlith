'use strict';

// Kenlith 0.6.0: opens one Kenlith chat tab (signed out, empty chat) and the
// Kenlith side bar, then waits while test/integration/editor-icon.js looks at
// the editor's own drawing. Nothing is typed or sent.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  async run() {
    const dir = process.env.KENLITH_ICON_DIR;
    const out = (name, data) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
    try {
      const extension = vscode.extensions.all.find((item) => item.packageJSON?.name === 'plan-chat-antigravity');
      await extension.activate();
      await vscode.commands.executeCommand('workbench.view.extension.planChat');
      await vscode.commands.executeCommand('planChat.open');
      await sleep(2500);
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => ({ label: tab.label, webview: tab.input instanceof vscode.TabInputWebview }));
      out('ready', { theme: vscode.window.activeColorTheme.kind, tabs, version: extension.packageJSON.version });
      const end = Date.now() + 120_000;
      while (Date.now() < end && !fs.existsSync(path.join(dir, 'done.json'))) await sleep(300);
    } catch (error) {
      out('error', { error: String(error?.stack || error) });
    }
  }
};
