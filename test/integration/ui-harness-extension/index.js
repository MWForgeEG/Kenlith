'use strict';

// Test-only extension for the slice 1 panel test (test/integration/
// webview-ui.js). It runs the scenario in a normal development window, not
// under --extensionTestsPath, because the editor refuses to show dialogs (the
// sign-out confirmation, the link prompt) while an extension test runner is
// attached. The scenario builds its own ChatViewProvider with fakes from
// Kenlith's source files; it does not use anything Kenlith exports
// (Kenlith exports nothing). It does nothing unless PLAN_CHAT_IT_UI_DIR is set.
//
// The sidebar test does not use this extension: it runs a throwaway test
// copy of Kenlith (test/integration/lib/test-copy.js).

const vscode = require('vscode');

function activate() {
  if (!process.env.PLAN_CHAT_IT_UI_DIR) {
    return;
  }
  require('../suite/webview-ui')()
    .finally(() => vscode.commands.executeCommand('workbench.action.quit'));
}

module.exports = { activate };
