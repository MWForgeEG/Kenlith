'use strict';

// Entry point of the throwaway test copy of Kenlith (lib/test-copy.js).
// It exists only inside a test sandbox: it is not in src/, not packaged, and
// not reachable from a normal development or installed run, whose entry point
// is src/extension.js. It wires the real engine and commands to synthetic
// sign-in, model, clipboard and browser, then runs the scenario.
// Like the real entry point, it exports nothing to other extensions.
//
// 0.4.0: the copy's manifest says which surface to test (lib/test-copy.js):
// 'workspace' runs the shipped wiring (activateWith: trees and editor tabs);
// 'legacy' puts the same engine behind a side bar webview, as 0.3.0 did, for
// the earlier suites.

const vscode = require('vscode');
const { activateWith } = require('./src/extension');
const { ChatEngine } = require('./src/engine');
const { ProjectContext } = require('./src/project');
const { CREDENTIALS_KEY } = require('./src/auth');
const { planChatTestSurface: SURFACE = 'legacy' } = require('./package.json');
const scenario = require('./test-scenario/sidebar-ui');

// The 0.3.0 wiring around the 0.4.0 engine: one webview in the side bar that
// shows the window's current chat.
async function activateLegacy(context, { authService, openAIService, store, platform, project }) {
  const engine = new ChatEngine(context, authService, openAIService, store, platform, project || new ProjectContext(context));
  await engine.prepare();
  await engine.noteExistingSession().catch(() => undefined);
  const showThen = (run) => async (...args) => { await engine.show(); return run(...args); };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => engine.workspaceChanged()),
    vscode.workspace.onDidChangeConfiguration((event) => engine.configurationChanged(event)),
    vscode.workspace.onDidChangeTextDocument((event) => engine.documentChanged(event)),
    vscode.commands.registerCommand('planChat.attachSelection', showThen(() => engine.attachSelection())),
    vscode.commands.registerCommand('planChat.showAllChats', showThen(() => engine.showAllChats())),
    vscode.commands.registerCommand('planChat.chooseProject', showThen(() => engine.chooseProject())),
    vscode.commands.registerCommand('planChat.moveToGeneral', showThen(() => engine.moveToGeneral())),
    engine,
    vscode.window.registerWebviewViewProvider('planChat.sidebar', engine, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('planChat.open', () => engine.show()),
    vscode.commands.registerCommand('planChat.manageProjectSharing', () => engine.manageProjectSharing()),
    vscode.commands.registerCommand('planChat.signIn', showThen(() => engine.signIn())),
    vscode.commands.registerCommand('planChat.signOut', () => engine.signOut()),
    vscode.commands.registerCommand('planChat.newChat', showThen(() => engine.newChat())),
    vscode.commands.registerCommand('planChat.showHistory', showThen(() => engine.showHistory()))
  );
  return engine;
}

async function activate(context) {
  const doubles = scenario.createDoubles(context);
  // A synthetic value under Kenlith's credential key, so the isolation test
  // can check that another extension cannot read Kenlith's secrets. The
  // fake sign-in never reads it; no real token exists in the test profile.
  await context.secrets.store(CREDENTIALS_KEY, `synthetic-not-a-token-${Date.now()}`);
  const provider = SURFACE === 'workspace' ? await activateWith(context, doubles) : await activateLegacy(context, doubles);
  // PLAN_CHAT_IT_SCENARIO=stage2, stage3, workspace or project runs
  // test/integration/suite/stage2-ui.js, stage3-ui.js, workspace-ui.js or
  // project-awareness-ui.js (Kenlith 0.5.0) instead.
  const named = { stage2: './test-scenario/stage2', stage3: './test-scenario/stage3', workspace: './test-scenario/workspace', project: './test-scenario/project', 'restart-review': './test-scenario/restart-review' }[process.env.PLAN_CHAT_IT_SCENARIO];
  const chosen = named ? require(named) : scenario;
  chosen.run(provider, context)
    .finally(() => {
      // In the isolation test the probe extension closes the window itself,
      // and the workspace suite's restart phase quits on its own.
      if (!process.env.PLAN_CHAT_IT_EXPOSURE_ONLY && !process.env.PLAN_CHAT_IT_KEEP_OPEN) vscode.commands.executeCommand('workbench.action.quit');
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
