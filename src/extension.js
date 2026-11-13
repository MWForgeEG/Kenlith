'use strict';

const vscode = require('vscode');
const { AuthService, CREDENTIALS_KEY } = require('./auth');
const { OpenAIService } = require('./openai');
const { ConversationStore } = require('./store');
const { ProjectContext } = require('./project');
const { ChatEngine } = require('./engine');
const { ChatPanels } = require('./panels');
const { Sidebar } = require('./sidebar');
const { SCHEME: REVIEW_SCHEME } = require('./proposal-review');
const { LEGACY_SECTION, migrateLegacySettings } = require('./settings');

// Registers the workspace (0.4.0): one conversation engine for the window
// (src/engine.js), chats in editor tabs (src/panels.js), and the side bar's
// Account and Chats trees (src/sidebar.js). Real activation passes the real
// services. The real-editor UI tests use a separate entry file that exists
// only in a throwaway copy of the extension built by the test runner
// (test/integration/test-main.js); it is not part of src/ or a package.
async function activateWith(context, { authService, openAIService, store, platform, project }) {
  // Kenlith 0.4.1: Plan Chat 0.4.0 settings are copied to kenlith.* before
  // anything reads them (src/settings.js). Reading falls back if this fails.
  await migrateLegacySettings(context.globalState).catch(() => undefined);
  // The window's project context is worked out before the store opens or
  // creates a chat, so no chat is created outside it (src/project.js).
  const engine = new ChatEngine(context, authService, openAIService, store, platform, project || new ProjectContext(context));
  await engine.prepare();
  // A failure here only means the first-sign-in welcome may appear once more.
  await engine.noteExistingSession().catch(() => undefined);
  await engine.rememberSession();
  const panels = new ChatPanels(context, engine, store);
  engine.ui = panels;
  const sidebar = new Sidebar(context, engine, store, panels);

  // Opens the window's latest chat in a tab (or reveals its tab).
  const openCurrent = async () => {
    const active = panels.activeChatId();
    if (active) return active;
    const list = await store.listConversations();
    await panels.openChat(list.currentId);
    return list.currentId;
  };
  const command = (id, run) => vscode.commands.registerCommand(id, async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      vscode.window.showErrorMessage(`Kenlith: ${error?.message || error}`);
      return undefined;
    }
  });

  context.subscriptions.push(
    panels.register(),
    ...sidebar.register(),
    engine.onDidChangeState(() => {
      sidebar.refresh();
      panels.refreshTitles().catch(() => undefined);
    }),
    store.watch(() => {
      engine.historyChanged().catch(() => undefined);
      panels.refreshTitles().catch(() => undefined);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => engine.workspaceChanged().then(() => sidebar.refresh())),
    ...(vscode.workspace.onDidChangeConfiguration ? [vscode.workspace.onDidChangeConfiguration((event) => {
      // A Plan Chat value changed (for example in a profile still on Plan Chat
      // 0.4.0): copy it again; the copy raises its own event for kenlith.*.
      if (event.affectsConfiguration?.(LEGACY_SECTION)) migrateLegacySettings(context.globalState).catch(() => undefined);
      engine.configurationChanged(event);
      sidebar.refresh();
    })] : []),
    // Marks a pending attachment "changed since capture"; it never re-reads it.
    // 0.6.0: a change or a new unsaved state of a proposal's file makes the
    // proposal out of date (Apply checks again in any case).
    vscode.workspace.onDidChangeTextDocument((event) => { engine.documentChanged(event); engine.proposalDocumentChanged(event.document); }),
    // 0.6.0 Review Before Apply: the read-only diff documents, and the
    // events that can make a proposal out of date.
    ...(vscode.workspace.registerTextDocumentContentProvider ? [vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, { provideTextDocumentContent: (uri) => engine.review.provideTextDocumentContent(uri) })] : []),
    ...(vscode.workspace.onDidSaveTextDocument ? [vscode.workspace.onDidSaveTextDocument(() => engine.proposalFilesTouched())] : []),
    ...(vscode.workspace.createFileSystemWatcher ? (() => {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*', true, false, false);
      return [watcher, watcher.onDidChange(() => engine.proposalFilesTouched()), watcher.onDidDelete(() => engine.proposalFilesTouched())];
    })() : []),
    engine.review.store.watch(() => engine.proposalStoreChanged()),
    // Sign-in changed in another window (signed out, or another account).
    ...(context.secrets?.onDidChange ? [context.secrets.onDidChange((event) => {
      if (event.key === CREDENTIALS_KEY) engine.sessionChanged().then(() => sidebar.refresh(), () => undefined);
    })] : []),
    ...(vscode.window.onDidChangeWindowState ? [vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) engine.sessionChanged().then(() => sidebar.refresh(), () => undefined);
    })] : []),
    // Captures the selection for review in the chat used last (or a new tab);
    // sends nothing and returns nothing (no attachment data leaves through a
    // command result).
    command('planChat.attachSelection', async () => {
      if (!panels.activeChatId() && !engine.openChatIds().size) await openCurrent();
      await engine.attachSelection();
    }),
    command('planChat.open', async () => { await openCurrent(); }),
    command('planChat.newChat', async () => { await engine.newChat(); }),
    command('planChat.newChatBeside', async () => { await engine.newChat({ beside: true }); }),
    command('planChat.showHistory', () => engine.showHistory()),
    command('planChat.showAllChats', () => engine.showAllChats()),
    command('planChat.searchChats', () => sidebar.searchChats()),
    command('planChat.openChat', (node) => sidebar.openChat(node)),
    command('planChat.openChatBeside', (node) => sidebar.openChat(node, true)),
    command('planChat.renameChat', (node) => sidebar.renameChat(node)),
    command('planChat.moveChatToGroup', (node) => sidebar.moveChatToGroup(node)),
    command('planChat.removeFromGroup', (node) => sidebar.removeFromGroup(node)),
    command('planChat.newGroup', () => sidebar.newGroup()),
    command('planChat.renameGroup', (node) => sidebar.renameGroup(node)),
    command('planChat.removeGroup', (node) => sidebar.removeGroup(node)),
    command('planChat.chooseProject', async () => { await engine.chooseProject(); sidebar.refresh(); }),
    command('planChat.moveChatHere', (node) => sidebar.moveChatHere(node)),
    command('planChat.moveToGeneral', async (node) => { await engine.moveToGeneral(node?.item?.id); sidebar.refresh(); }),
    command('planChat.manageProjectSharing', async () => { await engine.manageProjectSharing(); sidebar.refresh(); }),
    command('planChat.signIn', async () => { await engine.signIn(); await engine.rememberSession(); sidebar.refresh(); }),
    command('planChat.signOut', async () => { await engine.signOut(); sidebar.refresh(); }),
    command('planChat.accountActions', () => sidebar.accountActions()),
    command('planChat.manageUsage', () => engine.openUsageSettings()),
    command('planChat.resumeUsage', async () => { await engine.resumeUsage(); sidebar.refresh(); }),
    command('planChat.setDefaultModel', () => sidebar.setDefaultModel()),
    command('planChat.stopReply', () => engine.stop(panels.activeChatId())),
    engine
  );
  sidebar.refresh();
  return engine;
}

// Exports nothing to other extensions, in every mode (installed, development
// and test hosts): `vscode.extensions.getExtension(...).exports` is undefined.
async function activate(context) {
  const authService = new AuthService(context);
  await activateWith(context, {
    authService,
    openAIService: new OpenAIService(authService),
    store: new ConversationStore(context)
  });
}

function deactivate() {}

module.exports = { activate, deactivate, activateWith };
