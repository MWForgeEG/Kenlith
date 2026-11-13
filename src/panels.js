'use strict';

// Editor tabs for chats (0.4.0, UX-02). One tab per chat in a window; the tab
// is a surface of the window's one engine (src/engine.js), bound to its chat
// id here, in the extension host. The webview only remembers which chat it
// shows (for restore after a restart); that id is checked again here before
// the tab is bound, and nothing else is kept in the webview's state.
//
// After a restart the editor restores visible tabs at once and hidden tabs
// when they are first shown (UX-00 feasibility), through the serializer.

const vscode = require('vscode');

const VIEW_TYPE = 'planChat.conversation';
// Chat ids with an open tab in this workspace, for the Chats list before
// hidden tabs are restored.
const OPEN_KEY = 'planChat.openChats.v1';
const ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;

const titleOf = (conversation) => String(conversation?.title || 'New chat');

class ChatPanels {
  #panels = new Map();

  constructor(context, engine, store) {
    this.context = context;
    this.engine = engine;
    this.store = store;
  }

  register() {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => this.#restore(panel, state)
    });
  }

  // Chats with a tab in this window, restored or not yet.
  openIds() {
    const saved = this.context.workspaceState.get(OPEN_KEY, []);
    return new Set([...this.#panels.keys(), ...(Array.isArray(saved) ? saved : [])]);
  }

  isBound(chatId) {
    return this.#panels.has(chatId);
  }

  async openChat(chatId, { beside = false, preserveFocus = false } = {}) {
    if (typeof chatId !== 'string' || !ID_PATTERN.test(chatId)) throw new Error('That chat could not be opened.');
    const existing = this.#panels.get(chatId);
    if (existing) {
      existing.reveal(beside ? vscode.ViewColumn.Beside : existing.viewColumn, preserveFocus);
      return existing;
    }
    // The store refuses an id it does not have.
    const conversation = await this.store.getConversation(chatId);
    const column = await this.#closeUnrestoredTab(conversation);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, titleOf(conversation), {
      viewColumn: beside ? vscode.ViewColumn.Beside : (column || vscode.ViewColumn.Active),
      preserveFocus
    }, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: false,
      localResourceRoots: []
    });
    this.#bind(panel, conversation.id);
    return panel;
  }

  // The tab of a chat open before the restart and not shown since (so not
  // restored yet) would become a second tab for the chat: it is closed, and
  // the new one takes its place. Only a tab that can only be that one is
  // closed: the single Kenlith tab with this title, when no restored tab
  // has the title. A tab never holds anything that is not saved.
  async #closeUnrestoredTab(conversation) {
    if (!this.openIds().has(conversation.id)) return undefined;
    const title = titleOf(conversation);
    if ([...this.#panels.values()].some((panel) => panel.title === title)) return undefined;
    const tabs = (vscode.window.tabGroups?.all || []).flatMap((group) => group.tabs.map((tab) => ({ tab, group })))
      .filter(({ tab }) => tab.input instanceof vscode.TabInputWebview && String(tab.input.viewType).endsWith(VIEW_TYPE) && tab.label === title);
    if (tabs.length !== 1) return undefined;
    const { tab, group } = tabs[0];
    await vscode.window.tabGroups.close(tab).catch(() => undefined);
    return group.viewColumn;
  }

  async #restore(panel, state) {
    const chatId = state && typeof state.chatId === 'string' && ID_PATTERN.test(state.chatId) ? state.chatId : undefined;
    let conversation;
    if (chatId && !this.#panels.has(chatId)) {
      conversation = await this.store.getConversation(chatId).catch(() => undefined);
    }
    if (!conversation) {
      // Missing, damaged or duplicate state: the tab is closed; no chat is
      // changed. A duplicate brings the chat's tab forward instead.
      const existing = chatId && this.#panels.get(chatId);
      panel.dispose();
      existing?.reveal(existing.viewColumn, false);
      this.#saveOpen();
      return;
    }
    panel.title = titleOf(conversation);
    this.#bind(panel, conversation.id);
  }

  #bind(panel, chatId) {
    this.#panels.set(chatId, panel);
    // 0.7.0 (DEC-PLANCHAT-033, 034): the coloured Signal Rings (the approved
    // gallery vector: Signal Mint rings on a Deep Forest tile, colours written
    // in, never currentColor), the same in every theme. The Activity Bar and
    // views keep the single-colour chat.svg the editor tints.
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat-tab.svg');
    panel.onDidDispose(() => {
      if (this.#panels.get(chatId) === panel) this.#panels.delete(chatId);
      this.#saveOpen();
    });
    this.engine.attachSurface(panel, { chatId, kind: 'panel' });
    this.#saveOpen();
  }

  #saveOpen() {
    this.context.workspaceState.update(OPEN_KEY, [...this.#panels.keys()]).then(undefined, () => undefined);
  }

  // Tab titles follow the chats' titles (first message, or a rename).
  async refreshTitles() {
    if (!this.#panels.size) return;
    const all = await this.store.listAll().catch(() => []);
    for (const item of all) {
      const panel = this.#panels.get(item.id);
      if (panel && panel.title !== (item.title || 'New chat')) panel.title = item.title || 'New chat';
    }
  }

  // The chat of the active Kenlith tab, if one is active.
  activeChatId() {
    for (const [id, panel] of this.#panels) if (panel.active) return id;
    return undefined;
  }
}

module.exports = { ChatPanels, OPEN_KEY, VIEW_TYPE };
