'use strict';

// The side bar (0.4.0, UX-03): manages the account and the chats; the
// conversations themselves open in editor tabs (src/panels.js). Two native
// trees, so keyboard use, screen readers, themes and narrow widths behave as
// in the rest of the editor:
//
// - Account: who is signed in, "Using ChatGPT plan" with Manage usage, the
//   model for new chats, a usage pause with Resume. No usage figures: Plan
//   Chat has no source for them.
// - Chats: the chats grouped by context (this project, General, earlier
//   chats, other projects...) exactly as the store classifies them, and inside
//   that by the user's own groups. A group never changes where a chat may be
//   opened or sent from; that is its context.
//
// Lists show titles, times and states only, never message text.

const vscode = require('vscode');
const { relativeTime } = require('./view');
const { SECTION_LABELS, plainText } = require('./engine');
const { USAGE_PAUSE_KEY, usesPlan } = require('./siwc');

// A user's own name (group, chat title, folder) shown in a tree row is
// isolated (Unicode FSI … PDI), so a right-to-left name does not pull the text
// after it, such as a count, into its run ("مجموعة القبول 2 chats", not
// "2مجموعة القبول chats"). Display only: names are stored as they are, and
// screen readers get the plain text. Direction controls inside the name (an
// automatic title from a first message can hold them) are removed first, so
// none can close the isolation early.
const isolate = (text) => `\u2068${String(text).replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')}\u2069`;

const byNewest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
const byName = (a, b) => a.name.localeCompare(b.name);

// The order of context sections, by window kind (as All Chats, §3.1).
function sectionOrder(context) {
  return context?.kind === 'project'
    ? ['this', 'general', 'earlier', 'other-project', 'earlier-key', 'unknown']
    : ['general', 'earlier', 'other-project', 'earlier-key', 'unknown'];
}

// What the Chats list says about a chat: open, replying, waiting for a
// decision, failed or interrupted. Only states that exist.
// Short words, so a narrow side bar keeps them; "open" is the icon only.
function statusOf(item, { engineStatus, open, replyingElsewhere }) {
  if (engineStatus === 'replying') return { text: 'replying', icon: 'loading~spin', spoken: 'replying' };
  if (engineStatus === 'consent') return { text: 'needs your decision', icon: 'question', spoken: 'waiting for your decision to share project files' };
  // 0.6.0 (DEC-PLANCHAT-028): proposed changes wait for review after the
  // reply; no reply slot is held.
  // 0.7.0 (DEC-PLANCHAT-030, 032): a consequential command waits for approval,
  // exceptional output waits for a sharing decision, a command runs.
  if (engineStatus === 'command-approval') return { text: 'approve a command', icon: 'terminal', spoken: 'waiting for you to approve a command' };
  if (engineStatus === 'output-consent') return { text: 'share command output?', icon: 'question', spoken: 'waiting for your decision to share command output' };
  if (engineStatus === 'running') return { text: 'running a command', icon: 'loading~spin', spoken: 'running a command' };
  if (engineStatus === 'applying') return { text: 'applying changes', icon: 'loading~spin', spoken: 'applying the changes you approved' };
  if (engineStatus === 'review') return { text: 'review changes', icon: 'diff', spoken: 'proposed changes waiting for your review' };
  if (replyingElsewhere) return { text: 'replying elsewhere', icon: 'loading~spin', spoken: 'replying in another window' };
  if (item.lastFailed) return { text: 'reply did not finish', icon: 'warning', spoken: 'last reply did not finish' };
  if (open) return { text: '', icon: 'comment-discussion', spoken: 'open in a tab' };
  return { text: '', icon: 'comment', spoken: '' };
}

class Sidebar {
  #chats = new vscode.EventEmitter();
  #account = new vscode.EventEmitter();
  #timer;
  #data = { items: [], groups: [], context: undefined, sharing: undefined, live: new Set() };
  #accountData = { session: undefined, paused: false, models: [], defaultModel: undefined };

  constructor(context, engine, store, panels) {
    this.context = context;
    this.engine = engine;
    this.store = store;
    this.panels = panels;
  }

  register() {
    const chatsProvider = {
      onDidChangeTreeData: this.#chats.event,
      getChildren: (node) => this.#children(node),
      getTreeItem: (node) => this.#treeItem(node)
    };
    const accountProvider = {
      onDidChangeTreeData: this.#account.event,
      getChildren: () => this.#accountItems(),
      getTreeItem: (item) => item
    };
    this.chatsView = vscode.window.createTreeView('planChat.sidebar', { treeDataProvider: chatsProvider, showCollapseAll: true });
    this.accountView = vscode.window.createTreeView('planChat.account', { treeDataProvider: accountProvider });
    return [this.chatsView, this.accountView, this.#chats, this.#account];
  }

  // Coalesces bursts of changes (a streaming reply, several windows).
  refresh() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#load().catch(() => undefined); }, 120);
    this.#timer.unref?.();
  }

  async #load() {
    const [items, groups] = await Promise.all([this.store.listAll(), this.store.listGroups()]);
    const live = new Set();
    for (const item of items) {
      if (item.inProgress && !this.engine.chatStatus(item.id) && await this.engine.leases.isLive(item.id)) live.add(item.id);
    }
    this.#data = { items, groups, context: this.engine.windowContext, sharing: await this.engine.projectSharingState().catch(() => undefined), live };
    const session = await this.engine.authService.getSession().catch(() => undefined);
    this.#accountData = {
      session,
      paused: Boolean(this.context.globalState.get(USAGE_PAUSE_KEY)),
      models: this.engine.models,
      defaultModel: this.engine.defaultModel()
    };
    if (this.chatsView) {
      this.chatsView.description = this.#data.context?.kind === 'project' ? plainText(this.#data.context.label) : 'General';
      this.chatsView.message = session ? undefined : 'Sign in under Account to start chatting. Your saved chats are listed below.';
    }
    this.#chats.fire();
    this.#account.fire();
  }

  // ---------- Account ----------

  #accountItems() {
    const { session, paused, models, defaultModel } = this.#accountData;
    const items = [];
    if (!session) {
      const signIn = new vscode.TreeItem('Continue with ChatGPT');
      signIn.iconPath = new vscode.ThemeIcon('sign-in');
      signIn.command = { command: 'planChat.signIn', title: 'Continue with ChatGPT' };
      signIn.tooltip = 'Sign in through OpenAI. No API key is needed. Chats stay on this computer.';
      signIn.accessibilityInformation = { label: 'Continue with ChatGPT' };
      items.push(signIn);
      return items;
    }
    const name = session.email || session.name || 'ChatGPT account';
    const account = new vscode.TreeItem(name);
    account.description = 'signed in';
    account.iconPath = new vscode.ThemeIcon('account');
    account.tooltip = `Signed in to ChatGPT as ${name}. Kenlith is an unofficial client; chats are saved on this computer only.`;
    account.command = { command: 'planChat.accountActions', title: 'Account' };
    account.contextValue = 'account';
    account.accessibilityInformation = { label: `Signed in as ${name}. Account actions` };
    items.push(account);
    if (usesPlan(session)) {
      const plan = new vscode.TreeItem('Using ChatGPT plan');
      plan.description = 'Manage usage';
      plan.iconPath = new vscode.ThemeIcon('credit-card');
      plan.tooltip = 'Messages you send count toward your ChatGPT plan’s usage limits. Kenlith is free. Opens ChatGPT’s usage settings after you confirm.';
      plan.command = { command: 'planChat.manageUsage', title: 'Manage usage' };
      plan.accessibilityInformation = { label: 'Using ChatGPT plan. Manage usage' };
      items.push(plan);
    }
    if (paused) {
      const pause = new vscode.TreeItem('Sending is paused');
      pause.description = 'usage limit reached · Resume';
      pause.iconPath = new vscode.ThemeIcon('warning');
      pause.tooltip = 'Your ChatGPT plan usage limit was reached. Check Manage usage, then choose this to send again.';
      pause.command = { command: 'planChat.resumeUsage', title: 'Resume' };
      pause.accessibilityInformation = { label: 'Sending is paused: usage limit reached. Resume' };
      items.push(pause);
    }
    const model = models.find((candidate) => candidate.id === defaultModel);
    const modelItem = new vscode.TreeItem(`Model for new chats: ${model ? model.name : (defaultModel || 'choose…')}`);
    modelItem.iconPath = new vscode.ThemeIcon('symbol-misc');
    modelItem.tooltip = 'New chats start with this model (the one you chose last). Each chat keeps its own model.';
    modelItem.command = { command: 'planChat.setDefaultModel', title: 'Choose model' };
    modelItem.accessibilityInformation = { label: `${modelItem.label}. Choose model` };
    items.push(modelItem);
    return items;
  }

  // ---------- Chats ----------

  #primary() {
    return this.#data.context?.kind === 'project' ? 'this' : 'general';
  }

  #children(node) {
    const { items, groups } = this.#data;
    if (!node) {
      const sections = sectionOrder(this.#data.context).filter((section) => section === this.#primary() || items.some((item) => item.section === section));
      return sections.map((section) => ({ type: 'section', section }));
    }
    if (node.type === 'section') {
      // An empty chat is listed only while it is open in a tab (New Chat
      // reuses it, so empty chats do not pile up in the list).
      const open = this.panels ? this.panels.openIds() : new Set();
      const inSection = items.filter((item) => item.section === node.section && (item.messageCount > 0 || open.has(item.id)));
      const groupIds = new Set(inSection.map((item) => item.groupId).filter(Boolean));
      const known = new Set(groups.map((group) => group.id));
      // Empty groups are shown in this window's own section, so they can be used.
      const shown = groups.filter((group) => groupIds.has(group.id) || node.section === this.#primary()).sort(byName);
      const loose = inSection.filter((item) => !item.groupId || !known.has(item.groupId)).sort(byNewest);
      const children = [...shown.map((group) => ({ type: 'group', group, section: node.section })), ...loose.map((item) => ({ type: 'chat', item }))];
      if (!children.length) return [{ type: 'empty', section: node.section }];
      return children;
    }
    if (node.type === 'group') {
      const chats = items.filter((item) => item.section === node.section && item.groupId === node.group.id).sort(byNewest);
      return chats.length ? chats.map((item) => ({ type: 'chat', item })) : [{ type: 'empty', group: true }];
    }
    return [];
  }

  #treeItem(node) {
    if (node.type === 'section') return this.#sectionItem(node.section);
    if (node.type === 'group') {
      const count = this.#data.items.filter((item) => item.section === node.section && item.groupId === node.group.id).length;
      const item = new vscode.TreeItem(isolate(plainText(node.group.name)), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.section}:${node.group.id}`;
      item.description = count === 1 ? '1 chat' : `${count} chats`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'group';
      item.tooltip = `Your group "${node.group.name}". Groups only organise the list; a chat stays in its project or General.`;
      item.accessibilityInformation = { label: `Group ${node.group.name}, ${item.description}` };
      return item;
    }
    if (node.type === 'empty') {
      const text = node.group ? 'No chats in this group here' : node.section === 'this' ? 'No chats in this project yet. Start one with New Chat.' : 'No chats yet. Start one with New Chat.';
      const item = new vscode.TreeItem(text);
      item.contextValue = 'empty';
      return item;
    }
    return this.#chatItem(node.item);
  }

  #sectionItem(section) {
    const context = this.#data.context;
    const primary = section === this.#primary();
    const label = section === 'this' ? `This project: ${plainText(context?.label || '')}` : SECTION_LABELS[section] || 'Other';
    const shown = section === 'this' ? `This project: ${isolate(plainText(context?.label || ''))}` : label;
    const item = new vscode.TreeItem(shown, primary ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `section:${section}`;
    const count = this.#data.items.filter((entry) => entry.section === section).length;
    if (section === 'this') {
      const sharing = this.#data.sharing === 'shared' ? 'shared with OpenAI' : this.#data.sharing === 'off' ? 'project files off' : 'not shared';
      item.description = sharing;
      item.contextValue = 'section.this';
      item.iconPath = new vscode.ThemeIcon('root-folder');
      item.tooltip = sharing === 'shared with OpenAI'
        ? 'Kenlith may send short excerpts of this project with your questions. Manage Project Sharing stops it.'
        : 'Project files are sent only after you allow it in a chat. Manage Project Sharing lists what is shared.';
    } else {
      item.description = primary ? '' : `${count} · opens read-only`;
      item.iconPath = new vscode.ThemeIcon(section === 'general' ? 'comment-discussion' : 'history');
      item.contextValue = primary ? 'section.primary' : 'section.other';
      if (!primary) item.tooltip = 'Chats of another context open read-only in this window. Right-click a chat and choose Move Chat Here to continue it here.';
    }
    if (primary && context?.kind !== 'project') {
      const reasons = { remote: ' (remote folder)', choose: ' (choose a project)', 'folder-removed': ' (folder removed)' };
      item.description = reasons[context?.reason] ? reasons[context.reason].trim().replace(/[()]/g, '') : '';
    }
    item.accessibilityInformation = { label: `${label}${item.description ? ', ' + item.description : ''}, ${count} ${count === 1 ? 'chat' : 'chats'}` };
    return item;
  }

  #chatItem(entry) {
    const open = this.panels ? this.panels.openIds().has(entry.id) : false;
    const status = statusOf(entry, { engineStatus: this.engine.chatStatus(entry.id), open, replyingElsewhere: this.#data.live.has(entry.id) });
    const title = plainText(entry.title || 'New chat');
    const item = new vscode.TreeItem(isolate(title));
    item.id = `chat:${entry.id}`;
    item.description = [status.text, relativeTime(entry.updatedAt)].filter(Boolean).join(' · ');
    const grouped = entry.groupId && this.#data.groups.some((group) => group.id === entry.groupId);
    item.iconPath = new vscode.ThemeIcon(status.icon);
    item.contextValue = `${entry.allowed ? 'chat' : 'chat.readonly'}${grouped ? '.grouped' : ''}`;
    const where = entry.section === 'this' ? 'this project' : SECTION_LABELS[entry.section] || 'another context';
    item.tooltip = new vscode.MarkdownString(undefined, true);
    item.tooltip.appendText(`${entry.title || 'New chat'}\n${where}${entry.label && entry.section !== 'this' ? ` (${entry.label})` : ''} · ${entry.messageCount} messages${entry.allowed ? '' : '\nRead-only in this window'}`);
    item.command = { command: 'planChat.openChat', title: 'Open Chat', arguments: [{ type: 'chat', item: entry }] };
    item.accessibilityInformation = { label: [title, status.spoken, relativeTime(entry.updatedAt), entry.allowed ? '' : 'opens read-only here'].filter(Boolean).join(', ') };
    return item;
  }

  // ---------- commands ----------

  // A chat id from a tree node, the active tab, or a choice.
  async #chatFrom(node, prompt) {
    if (node?.type === 'chat') return node.item;
    const activeId = this.panels?.activeChatId();
    const all = await this.store.listAll();
    if (activeId) return all.find((item) => item.id === activeId);
    return this.#pickChat(all.filter((item) => item.allowed), prompt);
  }

  async #pickChat(items, placeHolder) {
    const groups = await this.store.listGroups();
    const names = new Map(groups.map((group) => [group.id, group.name]));
    const choice = await vscode.window.showQuickPick([...items].sort(byNewest).map((item) => ({
      label: plainText(item.title || 'New chat'),
      description: [item.section === 'this' ? 'this project' : SECTION_LABELS[item.section], names.get(item.groupId) ? `group: ${plainText(names.get(item.groupId))}` : '', item.allowed ? '' : 'read-only here', relativeTime(item.updatedAt)].filter(Boolean).join(' · '),
      item
    })), { title: 'Kenlith: Search Chats', placeHolder, matchOnDescription: true });
    return choice?.item;
  }

  // Search by title, group, context and time. Message text is not searched,
  // so another project's conversations are never exposed through search.
  async searchChats() {
    const all = await this.store.listAll();
    const item = await this.#pickChat(all, 'Search chat titles, groups and projects');
    if (item) await this.engine.openChat(item.id);
  }

  async openChat(node, beside = false) {
    const id = node?.item?.id || (typeof node === 'string' ? node : undefined);
    if (!id) return;
    await this.engine.openChat(id, { beside });
  }

  async renameChat(node) {
    const item = await this.#chatFrom(node, 'Choose a chat to rename');
    if (!item) return;
    const title = await vscode.window.showInputBox({ title: 'Rename Chat', value: item.title || '', prompt: 'A new title for this chat. Its messages and project do not change.', validateInput: (value) => (value.trim() ? undefined : 'Enter a title.') });
    if (title === undefined) return;
    await this.store.renameConversation(item.id, title);
    await this.#afterChange();
  }

  async moveChatHere(node) {
    const id = node?.item?.id;
    if (id) await this.engine.moveChatHere(id);
    this.refresh();
  }

  async newGroup() {
    const name = await vscode.window.showInputBox({ title: 'New Group', prompt: 'A name for a group of chats. Groups only organise the list; chats keep their project.', validateInput: (value) => (value.trim() ? undefined : 'Enter a name.') });
    if (name === undefined) return undefined;
    const group = await this.store.createGroup(name);
    await this.#afterChange();
    return group;
  }

  async moveChatToGroup(node) {
    const item = await this.#chatFrom(node, 'Choose a chat to put in a group');
    if (!item) return;
    const groups = (await this.store.listGroups()).sort(byName);
    const choice = await vscode.window.showQuickPick([
      ...groups.map((group) => ({ label: `$(folder) ${plainText(group.name)}`, description: group.id === item.groupId ? 'current' : undefined, group })),
      { label: '$(new-folder) New Group…', action: 'new' },
      ...(item.groupId ? [{ label: '$(close) No group', action: 'none' }] : [])
    ], { title: `Group for "${plainText(item.title || 'New chat')}"`, placeHolder: 'Groups only organise the list; the chat keeps its project or General' });
    if (!choice) return;
    let groupId = choice.group?.id;
    if (choice.action === 'new') {
      const group = await this.newGroup();
      if (!group) return;
      groupId = group.id;
    }
    await this.store.setConversationGroup(item.id, choice.action === 'none' ? undefined : groupId);
    await this.#afterChange();
  }

  async removeFromGroup(node) {
    const item = await this.#chatFrom(node, 'Choose a chat');
    if (!item?.groupId) return;
    await this.store.setConversationGroup(item.id, undefined);
    await this.#afterChange();
  }

  async renameGroup(node) {
    const group = node?.group || await this.#pickGroup('Choose a group to rename');
    if (!group) return;
    const name = await vscode.window.showInputBox({ title: 'Rename Group', value: group.name, validateInput: (value) => (value.trim() ? undefined : 'Enter a name.') });
    if (name === undefined) return;
    await this.store.renameGroup(group.id, name);
    await this.#afterChange();
  }

  async removeGroup(node) {
    const group = node?.group || await this.#pickGroup('Choose a group to remove');
    if (!group) return;
    const count = (await this.store.listAll()).filter((item) => item.groupId === group.id).length;
    const choice = await vscode.window.showWarningMessage(
      `Remove the group "${group.name}"?`,
      { modal: true, detail: count ? `Its ${count === 1 ? 'chat stays' : `${count} chats stay`} in Kenlith, without a group. No chat is deleted.` : 'It has no chats. No chat is deleted.' },
      'Remove Group'
    );
    if (choice !== 'Remove Group') return;
    await this.store.removeGroup(group.id);
    await this.#afterChange();
  }

  async #pickGroup(placeHolder) {
    const groups = (await this.store.listGroups()).sort(byName);
    if (!groups.length) {
      vscode.window.showInformationMessage('There are no groups yet. Create one with New Group.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(groups.map((group) => ({ label: plainText(group.name), group })), { title: 'Kenlith: Groups', placeHolder });
    return choice?.group;
  }

  async setDefaultModel() {
    let models;
    try {
      models = await this.engine.ensureModels();
    } catch (error) {
      vscode.window.showErrorMessage(`Kenlith: ${error.message}`);
      return;
    }
    if (!models.length) {
      vscode.window.showInformationMessage('Sign in to choose a model.');
      return;
    }
    const current = this.engine.defaultModel();
    const choice = await vscode.window.showQuickPick(models.map((model) => ({ label: model.name, description: model.id === current ? 'current' : undefined, id: model.id })), { title: 'Model for new chats', placeHolder: 'Each chat keeps its own model; change it in the chat.' });
    if (!choice) return;
    await this.engine.setDefaultModel(choice.id);
    this.refresh();
  }

  async accountActions() {
    const choice = await vscode.window.showQuickPick([
      { label: '$(shield) Manage Project Sharing…', action: 'sharing' },
      { label: '$(link-external) Manage usage', action: 'usage' },
      { label: '$(sign-out) Sign Out…', action: 'signOut' }
    ], { title: 'Kenlith: Account', placeHolder: 'Sign Out asks you to confirm first. Your local chats are kept.' });
    if (choice?.action === 'sharing') await this.engine.manageProjectSharing();
    if (choice?.action === 'usage') await this.engine.openUsageSettings();
    if (choice?.action === 'signOut') await this.engine.signOut();
    this.refresh();
  }

  async #afterChange() {
    await this.panels?.refreshTitles();
    this.refresh();
  }
}

module.exports = { Sidebar, isolate, sectionOrder, statusOf };
