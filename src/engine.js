'use strict';

// The conversation engine (0.4.0, UX-01): the one place in a window that
// sends messages, streams replies, and holds what is waiting for the user
// (consent cards, the pending attachment). Moved from the 0.3.0 view class
// with its logic unchanged; what changed is where its output goes.
//
// Surfaces. A surface is a webview that shows one chat: an editor tab bound to
// a chat id (src/panels.js), or a surface that follows the window's current
// chat (the 0.3.0 side bar arrangement, still used by the unit tests). The
// engine decides which chat every action targets from the surface it came
// from; a chat id inside a webview message is never used.
//
// One request at a time per window (MAX_STREAMS). Across windows, a reply
// lease per chat (src/lease.js) keeps two windows from replying in one chat.

const vscode = require('vscode');
const { AttachmentRefusal, attachmentMetadata, captureSelection, sha256 } = require('./attachments');
const { buildRequest, buildToolContinuation } = require('./request-builder');
const { ConsentStore, POLICY_VERSION, accountRefFor, keyOf } = require('./consent');
const { finalCheck, preflight } = require('./context-gate');
const { classify, contextUsedRecord, mayReplay } = require('./provenance');
const { createCache } = require('./retrieval');
const { ProjectContextService, editorWorkspace } = require('./project-context');
const { TOOL_DEFINITIONS } = require('./project-tools');
// 0.6.0 Review Before Apply (docs/kenlith-0.6.0/ARCHITECTURE.md): the write
// mechanics live in the proposal modules; the engine only orchestrates.
const { PROPOSAL_TOOL_DEFINITION } = require('./proposal');
const { ProposalStore } = require('./proposal-store');
const { editorAdapter } = require('./proposal-apply');
const { ReviewService, SCHEME: REVIEW_SCHEME } = require('./proposal-review');
// 0.7.0 controlled execution (docs/kenlith-0.7.0/ARCHITECTURE.md): the
// mechanics live in the exec-* modules; the engine only orchestrates.
const { RUN_TOOL_DEFINITION, TASK_TOOL_DEFINITION } = require('./exec-request');
const { ExecutionStore, APPROVAL_CARD_MS } = require('./exec-store');
const { ExecutionService, fetchWorkspaceTasks, sameFolder } = require('./exec-service');
const { indexFor } = require('./exec-boundary');
const { readContained, resolveRoot } = require('./workspace-safety');
const { safeUrl } = require('./markdown');
const { ProjectContext, tagFor } = require('./project');
const { affectsSetting, userCommandsEnabled, userInstructions, userMaxHistoryMessages, userMaxSelectionCharacters, userProjectContextEnabled, userProjectToolsEnabled, userProposalsEnabled, userReasoningDefaultEffort } = require('./settings');
// 0.8.0 (DEC-PLANCHAT-040): Thinking effort. Which model accepts which effort
// is decided in src/reasoning.js only.
const { LABELS: EFFORT_LABELS, effortRejection, effortView, isEffort, isSupported } = require('./reasoning');
const { USAGE_PAUSE_KEY, USAGE_SETTINGS_URL, UsagePausedError, WELCOME_ACTION, WELCOME_DETAIL, WELCOME_KEY, WELCOME_TITLE, isUsageLimitError, usesPlan } = require('./siwc');
const { safeError } = require('./util');
const { ReplyBusyError, ReplyLeases } = require('./lease');
const { DraftStore } = require('./drafts');
const { getWebviewHtml, relativeTime } = require('./view');

const SELECTED_MODEL_KEY = 'planChat.selectedModel.v1';
// Project context (M1, DEC-PLANCHAT-011): the provider this build sends to.
const PROVIDER = 'openai-siwc';
// A consent card left open longer than this is withdrawn; the text comes back.
const CONSENT_CARD_MS = 10 * 60_000;
// 0.4.0: one model request at a time per window (owner decision D3).
const MAX_STREAMS = 1;
// A reply's text is saved while it streams at most this often (plus one
// second per megabyte of history, so large files are written less often).
const CHECKPOINT_MS = 2_000;

// Raised when sharing changed between the consent check and the moment of
// sending (revoked, other account, workspace no longer trusted, files
// changed). Nothing was sent.
class ProjectGateError extends Error {
  constructor(reason) {
    super(`Project sharing changed just before sending (${reason}). Nothing was sent; send your message again.`);
    this.name = 'ProjectGateError';
    this.reason = reason;
  }
}

// The recovery action the view offers with a failure: Manage usage for the
// structured ChatGPT plan usage-limit error only; Manage usage and Resume
// while sending is paused after it.
function usageAction(error) {
  if (error instanceof UsagePausedError) return 'usagePaused';
  return isUsageLimitError(error) ? 'manageUsage' : undefined;
}

const SECTION_LABELS = {
  this: 'This project',
  general: 'General',
  earlier: 'Earlier chats',
  'other-project': 'Other projects',
  'earlier-key': 'Earlier identity key',
  unknown: 'Other'
};

// Why a pending attachment was cancelled without sending (§4.1).
const DROP_NOTICES = {
  chat: 'The attached code was removed because another chat was opened. Nothing was sent. Attach it again in this chat if you need it.',
  'new-chat': 'The attached code was removed because a new chat was started. Nothing was sent. Attach it again if you need it.',
  context: 'The attached code was removed because this window\'s project changed. Nothing was sent. Attach it again from a file in the current project.'
};

const byNewest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));

// A title or folder name is the user's own text: keep "$(name)" from turning
// into an icon in a Quick Pick.
const plainText = (text) => String(text || '').replace(/\$\(/g, '$\u200B(');

function chatItem(item, currentId) {
  return {
    label: plainText(item.title || 'New chat'),
    // Relative time first ("2 hours ago"); the full date on the second line.
    description: [relativeTime(item.updatedAt), item.id === currentId ? 'open now' : ''].filter(Boolean).join(' · ') || undefined,
    detail: item.updatedAt ? new Date(item.updatedAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }) : undefined,
    id: item.id
  };
}

// What makes two contexts the same for this window.
function contextSignature(context) {
  if (!context) return '';
  return context.kind === 'project' ? `project:${context.key}:${context.keyId}` : `general:${context.reason}`;
}

// The clipboard and the browser, as one replaceable object, so tests can
// give the view stand-ins that never touch the user's clipboard or browser.
function editorPlatform() {
  return {
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
    openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url, true))
  };
}

class ChatEngine {
  // Errors already shown in the failed message itself (see #stream).
  #shownInMessage = new WeakSet();
  // Project context (M1): consent records, a short-lived file cache.
  #consents;
  #consentWatch;
  #retrievalCache = createCache();
  // An error from the session check at activation, shown on the first hydrate.
  #activationError;
  // 0.4.0: every webview showing a chat in this window.
  #surfaces = new Set();
  // Consent cards waiting for the user, by chat id.
  #pending = new Map();
  // Replies streaming in this window, by chat id: { controller, project }.
  #streams = new Map();
  // Send ids already used for a stored question (Send pressed twice, or a
  // message delivered twice, sends once).
  #usedSendIds = new Set();
  // The newest Send per chat: only it may put its text back after a refusal.
  #sendSeq = new Map();
  // The surface the user worked in last (Attach Selection goes there).
  #lastFocused;
  #listeners = new Set();
  #lastSessionKey;
  // 0.5.0: the window project's sharing state as last read ("shared",
  // "not-shared", "off", or undefined), shown beside the project name.
  #sharing;
  #sharingCheck;
  #sharingAgain = false;

  constructor(context, authService, openAIService, store, platform = editorPlatform(), project = new ProjectContext(context), options = {}) {
    this.context = context;
    this.authService = authService;
    this.openAIService = openAIService;
    this.store = store;
    this.platform = platform;
    this.project = project;
    const storage = context.globalStorageUri.fsPath;
    this.leases = options.leases || new ReplyLeases(storage);
    this.drafts = options.drafts || new DraftStore(storage);
    // Set by the extension: { openChat(chatId, { beside }) } for editor tabs.
    // Without it (unit tests), chats open in the surface that follows the
    // window's current chat, as in 0.3.0.
    this.ui = undefined;
    // An unreadable history file was set aside and a new one started (WP-03
    // T03-06): say so, with the kept file's name, instead of only logging it.
    this.store.onRecovery = (keptName) => {
      vscode.window.showWarningMessage(`Kenlith could not read its chat history file, so it started a new one. The old file was kept unchanged as ${keptName} in Kenlith's storage folder.`);
    };
    this.windowContext = undefined;
    // 0.5.0: local project awareness, selection and the read-only tools
    // (src/project-context.js). It shares the retrieval cache.
    this.projectContext = options.projectContext || new ProjectContextService({ getWindowContext: () => this.windowContext, workspace: editorWorkspace(vscode), cache: this.#retrievalCache, withheldValues: (root, settings) => indexFor(root, settings).readValues || [] });
    this.models = [];
    // The pending code attachment (stage 3, §4.2): host memory of this window
    // only. { snapshot (frozen, holds the text), approved, credentialConfirmed,
    // changed, conversationId, signature }. The webview gets a display copy and
    // refers to it by snapshot id; it can never supply or replace the text.
    this.attachment = undefined;
    // 0.6.0: change proposals and their review (DEC-PLANCHAT-026 to 028).
    // Apply never reads the sharing grant.
    this.review = options.review || new ReviewService({
      store: options.proposalStore || new ProposalStore(storage),
      editor: options.editor || editorAdapter(vscode),
      getProject: () => this.#reviewProject(),
      isTrusted: () => vscode.workspace.isTrusted !== false,
      contextEnabled: () => userProjectContextEnabled(),
      proposalsEnabled: () => userProposalsEnabled(),
      onChanged: (chatId, extra) => this.#proposalsChanged(chatId, extra),
      makeUri: (relPath, query) => vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${relPath}`, query })
    });
    // 0.7.0: command and task runs (DEC-PLANCHAT-030 to 032).
    this.exec = options.exec || new ExecutionService({
      store: options.executionStore || new ExecutionStore(storage),
      isTrusted: () => vscode.workspace.isTrusted !== false,
      commandsEnabled: () => userCommandsEnabled() && userProjectContextEnabled(),
      // The approved folder is still one of the window's workspace folders.
      rootOpen: (root) => (vscode.workspace.workspaceFolders || []).some((folder) => folder.uri?.scheme === 'file' && sameFolder(folder.uri.fsPath, root)),
      fetchTasks: (root) => fetchWorkspaceTasks(vscode, root),
      // RC3: the user's exclusions, as the read tools apply them.
      excludes: (root) => {
        const uri = vscode.Uri.file(root);
        return {
          filesExclude: vscode.workspace.getConfiguration('files', uri).get('exclude') || {},
          searchExclude: vscode.workspace.getConfiguration('search', uri).get('exclude') || {}
        };
      }
    });
    // RC3 (DEC-PLANCHAT-036): the last check of every command result in every
    // request, just before it leaves.
    if (this.openAIService) this.openAIService.outboundFilter = (input) => this.exec.outboundFilter(input);
  }

  // 0.7.0: approval cards for consequential commands, output-sharing cards
  // for exceptional output, and runs in progress, by chat id.
  #commandPending = new Map();
  #outputPending = new Map();
  #running = new Map();

  // A Class B command waits for one decision (DEC-PLANCHAT-031). Resolves
  // 'run', 'decline' or 'void' (Stop, expiry, a change of chat or project).
  #askCommand(chatId, card, signal) {
    return this.#askCard(this.#commandPending, chatId, card, signal, 'command', 'void', (value) => ({ type: 'command', command: value }));
  }

  // Exceptional output waits for one sharing decision (DEC-PLANCHAT-032).
  #askOutput(chatId, card, signal) {
    return this.#askCard(this.#outputPending, chatId, card, signal, 'commandOutput', 'withhold', (value) => ({ type: 'commandOutput', card: value }));
  }

  #askCard(map, chatId, card, signal, kind, fallback, message) {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(fallback); return; }
      const end = (choice) => {
        if (map.get(chatId)?.card.id !== card.id) return;
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
        map.delete(chatId);
        this.#postChat(chatId, message(null));
        this.#changed();
        this.#postStreamStates();
        resolve(choice);
      };
      const onAbort = () => end(fallback);
      const entry = { card, end, message, fallback, timer: setTimeout(() => end(fallback), APPROVAL_CARD_MS) };
      entry.timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      map.set(chatId, entry);
      this.#postChat(chatId, message(card));
      this.#changed();
      this.#postStreamStates();
    });
  }

  // A change of project or of the command settings voids every waiting
  // command approval, and withholds output still waiting for a decision
  // (§10). The service checks the settings and the folder again after Run.
  #voidCommandCards() {
    for (const map of [this.#commandPending, this.#outputPending]) {
      for (const entry of [...map.values()]) entry.end(entry.fallback);
    }
  }

  #runningChanged(chatId, on, command) {
    if (on) this.#running.set(chatId, command);
    else this.#running.delete(chatId);
    this.#postChat(chatId, { type: 'contextNote', text: on ? `Running ${command}…` : '' });
    this.#changed();
  }

  // A decision from a card. The chat comes from the surface; the id (and for
  // a command the digest the card showed) must match the waiting card.
  #cardDecision(surface, map, id, choice, allowed, digest) {
    if (surface.readOnly || !allowed.includes(choice)) return;
    const entry = map.get(this.#chatOf(surface));
    if (!entry || entry.card.id !== id) return;
    if (digest !== undefined && entry.card.digest !== digest) return;
    entry.end(choice);
  }

  // The window's project for proposals: its identity and resolved root.
  async #reviewProject() {
    const context = this.windowContext;
    if (context?.kind !== 'project' || !context.key) return undefined;
    const root = await this.projectContext.root().catch(() => ({ ok: false }));
    if (!root.ok) return undefined;
    return { keyId: `${context.key}:${context.keyId}`, label: context.label, root: root.root };
  }

  // Proposal cards changed (this window or another): every surface of that
  // chat gets them again, and the Chats list its status.
  async #proposalsChanged(chatId, extra) {
    const targets = chatId ? this.#surfacesFor(chatId) : [...this.#surfaces];
    for (const surface of targets) {
      if (surface.readOnly) continue;
      const id = this.#chatOf(surface);
      surface.webview.postMessage({ type: 'proposals', chatId: id, proposals: await this.review.cardsFor(id).catch(() => []) });
    }
    if (extra?.note && chatId) this.#postChat(chatId, { type: 'contextNote', text: extra.note });
    this.#changed();
  }

  // ---------- surfaces ----------

  // Shows chats in `host` (a webview view or panel). `chatId`: the chat this
  // surface is bound to; `follow`: shows the window's current chat instead.
  attachSurface(host, { chatId, follow = false, kind = 'panel' } = {}) {
    // A tab is "unchecked" until its chat's context is known (read-only or not).
    const surface = { host, webview: host.webview, chatId, follow, kind, readOnly: undefined, disposed: false, unchecked: !follow };
    this.#surfaces.add(surface);
    // The listener comes before the page: a page that loads at once must not
    // send its "ready" before anyone listens (a tab would stay empty).
    host.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') surface.ready = true;
      return this.#handleMessage(surface, message);
    }, undefined, this.context.subscriptions);
    host.webview.options = { enableScripts: true, localResourceRoots: [] };
    host.webview.html = getWebviewHtml(host.webview, { mode: kind === 'panel' ? 'panel' : 'view' });
    if (kind === 'panel') {
      // A tab whose page has not said "ready" after a few seconds is loaded
      // again (seen in Antigravity: a tab opened beside another can stay
      // blank). At most twice; a page that loads asks for its chat itself.
      let reloads = 0;
      const check = () => {
        if (surface.ready || surface.disposed || reloads >= 2) return;
        reloads += 1;
        host.webview.html = getWebviewHtml(host.webview, { mode: 'panel' });
        const again = setTimeout(check, 3000);
        again.unref?.();
      };
      const first = setTimeout(check, 3000);
      first.unref?.();
    }
    host.onDidDispose?.(() => {
      surface.disposed = true;
      this.#surfaces.delete(surface);
      if (this.#lastFocused === surface) this.#lastFocused = undefined;
      // A question waiting in a closed tab is dropped; nothing was sent.
      if (!follow && surface.chatId && !this.#surfacesFor(surface.chatId).length) {
        // The question held by the card becomes the chat's draft again
        // (released in #discardConsentFor).
        this.#discardConsentFor(surface.chatId, '');
      }
      this.#changed();
    });
    host.onDidChangeViewState?.((event) => {
      if (event.webviewPanel?.active) {
        this.#lastFocused = surface;
        // Switching to a chat tab puts the cursor in its message box (or on a
        // waiting consent card), so typing goes there without another click.
        host.webview.postMessage({ type: 'focusControl', id: 'prompt' });
      }
    });
    if (host.active) this.#lastFocused = surface;
    if (kind === 'panel' && chatId) this.#lastFocused = surface;
    this.#changed();
    return surface;
  }

  // WebviewViewProvider (0.3.0 side bar arrangement; unit tests).
  async resolveWebviewView(webviewView) {
    this.attachSurface(webviewView, { follow: true, kind: 'view' });
    await this.#hydrate();
  }

  // The surface's chat: the read-only chat it shows, its bound chat, or the
  // window's current chat for a following surface.
  #chatOf(surface) {
    if (!surface) return undefined;
    if (surface.readOnly) return surface.readOnly.id;
    return surface.follow ? this.store.currentId : surface.chatId;
  }

  #surfacesFor(chatId) {
    return [...this.#surfaces].filter((surface) => chatId && this.#chatOf(surface) === chatId);
  }

  #postTo(surfaces, message) {
    for (const surface of surfaces) surface.webview.postMessage(message);
  }

  #postChat(chatId, message) {
    this.#postTo(this.#surfacesFor(chatId), message);
  }

  #postAll(message) {
    this.#postTo(this.#surfaces, message);
  }

  // Bound chat ids of open editor tabs in this window.
  openChatIds() {
    return new Set([...this.#surfaces].filter((surface) => !surface.follow).map((surface) => surface.chatId));
  }

  // For the Chats list: what is happening in this window, per chat.
  // 0.6.0 (DEC-PLANCHAT-028, docs/kenlith-0.6.0/ARCHITECTURE.md §3.2): one
  // status per chat. A sharing card waiting during a reply is 'consent', not
  // 'replying'; 'applying' and 'review' come from the proposal store, so
  // every window shows them; review holds no reply slot.
  // 0.7.0: command approval, output sharing and running come before
  // replying; Class A runs only show 'running'.
  chatStatus(chatId) {
    if (this.#pending.has(chatId)) return 'consent';
    if (this.#commandPending.has(chatId)) return 'command-approval';
    if (this.#outputPending.has(chatId)) return 'output-consent';
    if (this.#running.has(chatId)) return 'running';
    if (this.#streams.has(chatId)) return 'replying';
    return this.review.statusOf(chatId);
  }

  onDidChangeState(listener) {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  #changed() {
    this.#refreshSharing();
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* a list refresh never breaks a send */ }
    }
  }

  // 0.3.0 compatibility for callers and tests that knew one view.
  get view() {
    return [...this.#surfaces].find((surface) => surface.follow)?.host;
  }

  get readOnly() {
    return [...this.#surfaces].find((surface) => surface.follow)?.readOnly;
  }

  set readOnly(value) {
    for (const surface of this.#surfaces) if (surface.follow) surface.readOnly = value;
  }

  get activeAbort() {
    return this.#liveStreams()[0]?.controller;
  }

  #followSurfaces() {
    return [...this.#surfaces].filter((surface) => surface.follow);
  }

  // ---------- window context ----------

  // Works out the window's context (src/project.js) and gives it to the store,
  // which then lists, opens and sends into only that context's chats.
  // `freshKey` re-reads the identity key file first (before writing a tag).
  async #refreshContext(options = {}) {
    // The multi-root default is the active editor's folder when the view
    // opens (§3.2), so only opening the view records it.
    if (options.noteEditor) this.project.noteActiveEditor();
    const next = await this.project.resolve(options);
    const changed = contextSignature(this.windowContext) !== contextSignature(next);
    const previous = this.windowContext;
    this.windowContext = next;
    // 0.6.0: proposals of the project this window had stop being actionable
    // here when the window's project changes.
    if (changed && previous?.kind === 'project' && previous.key) {
      this.review.projectChanged(`${previous.key}:${previous.keyId}`).catch(() => undefined);
    }
    this.store.setContext(next);
    if (changed) {
      // Shows "Move Chat to General" in the Chats list only in a project window.
      Promise.resolve(vscode.commands.executeCommand('setContext', 'planChat.projectWindow', next?.kind === 'project')).catch(() => undefined);
      for (const surface of this.#followSurfaces()) surface.readOnly = undefined;
      // Code is never carried from one project or context to another.
      this.#dropAttachment('context');
      // Neither is a question waiting for project consent, or read file text.
      this.#discardConsent('');
      this.#retrievalCache.invalidate();
      this.#changed();
    }
    return changed;
  }

  #contextInfo() {
    const context = this.windowContext;
    if (!context) return undefined;
    return {
      kind: context.kind,
      label: context.kind === 'project' ? context.label : 'General',
      reason: context.reason,
      available: context.available !== false,
      multiRoot: Boolean(context.multiRoot),
      canChoose: Boolean(context.canChoose),
      regenerated: Boolean(this.project.identity.regenerated),
      // 0.5.0: local awareness vs external sharing (docs/kenlith-0.5.0/LOCAL-VS-EXTERNAL-POLICY.md §4).
      sharing: context.kind === 'project' ? this.#sharing : undefined
    };
  }

  // Reads the sharing state again and, when it changed, sends the context to
  // every surface. Never asks anything; one read at a time.
  #refreshSharing() {
    // A change seen while a read is running is read again after it, so the
    // last change is never lost.
    if (this.#sharingCheck) {
      this.#sharingAgain = true;
      return this.#sharingCheck;
    }
    this.#sharingCheck = (async () => {
      try {
        do {
          this.#sharingAgain = false;
          const next = await this.projectSharingState().catch(() => undefined);
          if (next !== this.#sharing) {
            this.#sharing = next;
            this.#postAll({ type: 'projectState', context: this.#contextInfo() });
          }
        } while (this.#sharingAgain);
      } finally {
        this.#sharingCheck = undefined;
      }
    })();
    return this.#sharingCheck;
  }

  // The read-only state of a surface bound to a chat of another context.
  #bindingReadOnly(conversation) {
    if (!conversation || this.store.isAllowed(conversation)) return undefined;
    return { id: conversation.id, section: conversation.section || this.store.sectionOf(conversation), label: conversation.context?.label };
  }

  // The conversation to show in a surface, with display-only flags: replies
  // still being written elsewhere, and replies cut off by a crash or quit
  // (marked interrupted here when no window holds their reply lease).
  async #conversationFor(surface) {
    if (surface.follow && !surface.readOnly) return this.#decorate(await this.store.getCurrent());
    const chatId = surface.readOnly ? surface.readOnly.id : surface.chatId;
    let conversation;
    try {
      conversation = await this.store.getConversation(chatId);
    } catch {
      return undefined;
    }
    if (!surface.follow) {
      surface.readOnly = this.#bindingReadOnly(conversation);
      surface.unchecked = false;
    }
    return this.#decorate(conversation);
  }

  async #decorate(conversation) {
    if (!conversation) return conversation;
    for (const message of conversation.messages) {
      if ((message.inProgress || message.interrupted) && !message.content && message.partialContent) {
        message.content = message.partialContent;
      }
    }
    // A reply streaming here: a tab that reloads (it was hidden) shows the
    // text received so far, not only the last saved part.
    const live = this.#streams.get(conversation.id);
    if (live?.messageId) {
      const message = conversation.messages.find((candidate) => candidate.id === live.messageId);
      if (message) message.content = live.content;
    }
    const open = conversation.messages.filter((message) => message.inProgress);
    if (open.length && !this.#streams.has(conversation.id)) {
      if (await this.leases.isLive(conversation.id)) {
        for (const message of open) message.replyingElsewhere = true;
      } else if (this.store.isAllowed(conversation)) {
        await this.store.markInterrupted(conversation.id, open.map((message) => message.id)).catch(() => undefined);
        const again = await this.store.getConversation(conversation.id).catch(() => conversation);
        for (const message of again.messages) {
          if (message.interrupted && !message.content && message.partialContent) message.content = message.partialContent;
        }
        return again;
      } else {
        // A chat of another context is not changed from this window; it is
        // only shown as interrupted.
        for (const message of open) message.interrupted = true;
      }
    }
    return conversation;
  }

  #readOnlyInfo(surface) {
    const readOnly = surface.readOnly;
    if (!readOnly) return undefined;
    const projectWindow = this.windowContext?.kind === 'project';
    const { section } = readOnly;
    let action;
    // A folder that cannot be resolved has no verified identity: nothing is
    // moved or relinked into it (§3.3 amendment).
    if (section !== 'unknown' && !(projectWindow && this.windowContext.available === false)) {
      if (!projectWindow) action = { id: 'move', label: 'Move to General' };
      else if (section === 'earlier-key') action = { id: 'move', label: 'Relink to this project' };
      else action = { id: 'move', label: 'Move to this project' };
    }
    return { section, sectionLabel: SECTION_LABELS[section] || 'Another context', label: readOnly.label, action, back: surface.follow };
  }

  async #draftFor(surface, conversation) {
    if (!conversation || surface.readOnly || !this.store.isAllowed(conversation)) return '';
    return this.drafts.get(conversation.id, conversation.context).catch(() => '');
  }

  async #postConversation(surface, conversation) {
    // Every conversation shown goes through #decorate (unfinished text, replies
    // being written elsewhere or interrupted), however it was read.
    if (conversation === undefined) conversation = await this.#conversationFor(surface);
    else conversation = await this.#decorate(conversation);
    // Opening another chat in a following surface, or a chat read-only,
    // cancels the attachment: it belongs to the chat it was captured for (§4.1).
    if (surface.follow && this.attachment && (surface.readOnly || conversation?.id !== this.attachment.conversationId)) {
      this.#dropAttachment('chat', [surface]);
    }
    const conversationList = await this.store.listConversations();
    if (!surface.follow && conversation) conversationList.currentId = conversation.id;
    surface.webview.postMessage({
      type: 'conversation',
      conversation,
      conversationList,
      context: this.#contextInfo(),
      readOnly: this.#readOnlyInfo(surface),
      draft: await this.#draftFor(surface, conversation),
      otherReply: this.#otherReply(conversation?.id),
      // 0.8.0: the shown chat's Thinking level (the page checks it against
      // the model its selector shows).
      reasoning: this.#reasoningInfo(conversation, this.#modelOf(conversation))
    });
    // 0.6.0: the chat's change proposals, under the replies that made them.
    // The webview clears its cards with every conversation message, so a
    // chat with none gets no extra message.
    if (conversation && !surface.readOnly) {
      const proposals = await this.review.cardsFor(conversation.id).catch(() => []);
      if (proposals.length) surface.webview.postMessage({ type: 'proposals', chatId: conversation.id, proposals });
    }
  }

  async #postSurfaces(surfaces) {
    for (const surface of surfaces) {
      if (!surface.disposed) await this.#postConversation(surface);
    }
  }

  // Another chat of this window replying (one request at a time): its title.
  #otherReply(chatId) {
    for (const [id, stream] of this.#streams) {
      // `waiting`: that chat's reply waits for a sharing decision (0.6.0).
      // 0.7.0: also a command approval or an output-sharing decision.
      if (id !== chatId && !stream.stopping) {
        const waitingFor = this.#pending.has(id) ? 'sharing' : this.#commandPending.has(id) ? 'command' : this.#outputPending.has(id) ? 'output' : undefined;
        return { title: stream.title || 'another chat', waiting: Boolean(waitingFor), waitingFor };
      }
    }
    return null;
  }

  #postStreamStates() {
    for (const surface of this.#surfaces) {
      const chatId = this.#chatOf(surface);
      surface.webview.postMessage({ type: 'streamState', streaming: this.#streams.has(chatId), otherReply: this.#otherReply(chatId) });
    }
  }

  // At activation: works out the window's context, then opens (or creates,
  // tagged with that context) the window's chat, as earlier versions did when
  // they opened the history. Nothing is created before the context is known.
  async prepare() {
    await this.#refreshContext();
    const context = this.windowContext;
    // A multi-root window without a choice waits for the view to open (and
    // its active editor) instead of creating a General chat now.
    if (context.kind === 'project' || context.reason === 'no-folder' || context.reason === 'remote') {
      await this.store.getCurrent();
    }
  }

  // Called when the editor's workspace folders change (§3.4): a removed
  // folder puts the window in General; the list follows the new context.
  async workspaceChanged() {
    this.#voidCommandCards();
    this.#discardConsent('');
    if (await this.#refreshContext()) {
      await this.#postSurfaces([...this.#surfaces]);
    }
  }

  // The history file changed (this or another window): show the latest in
  // every surface whose chat is not replying here (a live reply is shown from
  // its stream), and refresh the list.
  async historyChanged() {
    const quiet = [...this.#surfaces].filter((surface) => !this.#streams.has(this.#chatOf(surface)) && !this.#pending.has(this.#chatOf(surface)));
    await this.#postSurfaces(quiet).catch(() => undefined);
    this.#changed();
  }

  async show() {
    await vscode.commands.executeCommand('workbench.view.extension.planChat');
  }

  // ---------- account ----------

  async signIn() {
    this.#discardConsent('');
    let signedIn = false;
    await this.#runBusy('Opening secure ChatGPT sign-in…', async () => {
      await this.authService.signIn();
      signedIn = true;
      // A new sign-in ends a usage pause (documented in the README).
      await this.context.globalState.update(USAGE_PAUSE_KEY, undefined);
      this.models = [];
      await this.#hydrate();
    });
    this.#changed();
    // After the busy state ends, so the welcome is not shown under it.
    if (signedIn && !(await this.#welcomeOnFirstSignIn().catch(() => false))) {
      vscode.window.showInformationMessage('Kenlith is connected to ChatGPT.');
    }
  }

  // Called once at activation. A user who is already signed in when this
  // version first runs has signed in before, so the first-sign-in welcome is
  // never shown to them and their session is not interrupted.
  async noteExistingSession() {
    if (this.context.globalState.get(WELCOME_KEY)) {
      return;
    }
    let session;
    try {
      session = await this.authService.getSession();
    } catch (error) {
      // For example, unreadable stored credentials (cleared by the sign-in
      // code): reported when the view first loads, as before this check.
      this.#activationError = error;
      return;
    }
    if (usesPlan(session)) {
      await this.context.globalState.update(WELCOME_KEY, { existingSession: true, at: new Date().toISOString() });
    }
  }

  // SIWC guideline: a welcome only the first time a user signs in with
  // ChatGPT plan usage, never on later sign-ins. Recorded when dismissed.
  async #welcomeOnFirstSignIn() {
    if (this.context.globalState.get(WELCOME_KEY) || !usesPlan(await this.authService.getSession())) {
      return false;
    }
    // 0.7.0: a notification, not a modal dialog, so it never covers a sharing
    // or review card (0.6.0 live check). A notification shows no detail line,
    // so the explanation is part of the message. Shown once.
    Promise.resolve(vscode.window.showInformationMessage(`${WELCOME_TITLE}. ${WELCOME_DETAIL}`, WELCOME_ACTION)).catch(() => undefined);
    await this.context.globalState.update(WELCOME_KEY, { dismissed: true, at: new Date().toISOString() });
    return true;
  }

  async signOut() {
    this.#discardConsent('');
    const choice = await vscode.window.showWarningMessage(
      'Sign out of ChatGPT in Kenlith? Your local conversations will be kept.',
      { modal: true },
      'Sign Out'
    );
    if (choice !== 'Sign Out') {
      return;
    }

    this.stop();
    await this.#runBusy('Signing out…', async () => {
      const result = await this.authService.signOut();
      this.models = [];
      this.#dropAttachment();
      await this.#hydrate();
      if (!result.remoteRevoked) {
        vscode.window.showWarningMessage(
          'Local tokens were cleared, but remote revocation could not be confirmed. You can disconnect the app in ChatGPT Settings.'
        );
      }
    });
    this.#lastSessionKey = undefined;
    this.#changed();
  }

  // 0.4.0: the sign-in may have changed in another window (signed out, or
  // another account). Everything in progress here stops; nothing is sent
  // with the old account after that.
  async sessionChanged() {
    let session;
    try {
      session = await this.authService.getSession();
    } catch {
      session = undefined;
    }
    const key = session ? `${session.subject || ''}|${session.email || ''}` : '';
    if (this.#lastSessionKey === undefined) {
      this.#lastSessionKey = key;
      return false;
    }
    if (key === this.#lastSessionKey) return false;
    this.#lastSessionKey = key;
    this.stop();
    this.#discardConsent(session ? 'The ChatGPT account changed, so nothing was sent.' : 'You were signed out, so nothing was sent.');
    this.#dropAttachment();
    this.models = [];
    await this.#hydrate().catch(() => undefined);
    this.#changed();
    return true;
  }

  async rememberSession() {
    try {
      const session = await this.authService.getSession();
      this.#lastSessionKey = session ? `${session.subject || ''}|${session.email || ''}` : '';
    } catch {
      this.#lastSessionKey = '';
    }
  }

  // ---------- chats ----------

  // Opens a chat: in its editor tab (0.4.0), or in the following surface.
  async openChat(id, { beside = false } = {}) {
    if (this.ui) {
      await this.ui.openChat(id, { beside });
      return;
    }
    const conversation = await this.store.getConversation(id);
    if (this.store.isAllowed(conversation)) {
      await this.#selectConversation(this.#followSurfaces()[0], id);
    } else {
      await this.openReadOnly(id);
    }
  }

  // Chats of this window's context only (a project, or General with its
  // earlier chats), then "All Chats…" for everything else. Searchable and
  // keyboard-first. Chats, their ids and titles come from the store unchanged.
  // `fromView`: opened from the view's History button, which gets keyboard
  // focus back if the list is dismissed.
  async showHistory({ fromView = false, surface } = {}) {
    await this.#refreshContext();
    const list = await this.store.listConversations();
    const chats = [...list.items].sort(byNewest);
    const projectWindow = this.windowContext?.kind === 'project';
    const currentId = surface && !surface.follow ? this.#chatOf(surface) : list.currentId;
    const items = [
      { label: '$(add) New Chat', action: 'new' },
      { label: '$(list-unordered) All Chats…', description: 'other projects, General and earlier chats', action: 'all' },
      { label: projectWindow ? `This project: ${plainText(this.windowContext.label)}` : 'General', kind: vscode.QuickPickItemKind.Separator },
      ...chats.filter((item) => item.section !== 'earlier').map((item) => chatItem(item, currentId))
    ];
    const earlier = chats.filter((item) => item.section === 'earlier');
    if (earlier.length) {
      items.push({ label: 'Earlier chats', kind: vscode.QuickPickItemKind.Separator }, ...earlier.map((item) => chatItem(item, currentId)));
    }
    const choice = await vscode.window.showQuickPick(items, {
      title: projectWindow ? `Kenlith: Chat History (${plainText(this.windowContext.label)})` : 'Kenlith: Chat History (General)',
      placeHolder: 'Search chats',
      matchOnDescription: true
    });
    if (!choice) {
      if (fromView) this.#restoreViewFocus(surface, 'history');
      return;
    }
    if (choice.action === 'new') {
      await this.newChat();
      return;
    }
    if (choice.action === 'all') {
      // Opened after this list has fully closed, not from inside its accept:
      // opening the second list from there was unreliable in Antigravity.
      // It does not close when focus returns to the view; Escape closes it.
      setTimeout(() => this.showAllChats({ chained: true, fromView, surface }).catch((error) => this.#handleError(error, surface ? [surface] : undefined)), 0);
      return;
    }
    if (!this.ui && this.activeAbort) {
      vscode.window.showInformationMessage('Stop the current response before opening another chat.');
      return;
    }
    await this.openChat(choice.id);
  }

  // The History list for everything (§3.1): grouped by where each chat
  // belongs. Chats of this context open normally; the others open read-only
  // until moved here explicitly.
  async showAllChats({ chained = false, fromView = false, surface } = {}) {
    await this.#refreshContext();
    const all = (await this.store.listAll()).sort(byNewest);
    const projectWindow = this.windowContext?.kind === 'project';
    const order = projectWindow
      ? ['this', 'general', 'earlier', 'other-project', 'earlier-key', 'unknown']
      : ['general', 'earlier', 'other-project', 'earlier-key', 'unknown'];
    const items = [];
    for (const section of order) {
      const chats = all.filter((item) => item.section === section);
      if (!chats.length) continue;
      const heading = section === 'this' ? `This project: ${plainText(this.windowContext.label)}` : SECTION_LABELS[section];
      items.push({ label: heading, kind: vscode.QuickPickItemKind.Separator });
      items.push(...chats.map((item) => ({
        ...chatItem(item, undefined),
        description: [item.allowed ? '' : 'read-only here', item.label ? plainText(item.label) : '', relativeTime(item.updatedAt)].filter(Boolean).join(' · ') || undefined
      })));
    }
    const choice = await vscode.window.showQuickPick(items, {
      title: 'Kenlith: All Chats',
      placeHolder: 'Search all chats',
      matchOnDescription: true,
      ignoreFocusOut: chained
    });
    if (!choice) {
      if (fromView) this.#restoreViewFocus(surface, 'history');
      return;
    }
    const target = all.find((item) => item.id === choice.id);
    if (target?.allowed) {
      if (!this.ui && this.activeAbort) {
        vscode.window.showInformationMessage('Stop the current response before opening another chat.');
        return;
      }
      await this.openChat(target.id);
    } else if (target) {
      await this.openReadOnly(target.id);
    }
  }

  // After a list opened from the view is dismissed, keyboard focus returns to
  // the control that opened it (WP-02 T02-07): the editor does not move focus
  // back into a webview by itself.
  #restoreViewFocus(surface, controlId) {
    const target = surface || this.#followSurfaces()[0];
    if (!target) return;
    if (target.follow) target.host.show?.(false);
    else target.host.reveal?.(undefined, false);
    target.webview.postMessage({ type: 'focusControl', id: controlId });
  }

  // Shows a chat of another context without opening it for sending (§3.4).
  async openReadOnly(id) {
    if (this.ui) {
      await this.ui.openChat(id, {});
      return;
    }
    const conversation = await this.store.getConversation(id);
    if (this.store.isAllowed(conversation)) {
      await this.#selectConversation(this.#followSurfaces()[0], id);
      return;
    }
    for (const surface of this.#followSurfaces()) {
      surface.readOnly = { id, section: conversation.section, label: conversation.context?.label };
      await this.#postConversation(surface, conversation);
    }
  }

  // "Move to this project" / "Relink to this project" / "Move to General" for
  // the chat shown read-only. One store transaction; the tag is made after
  // re-reading the identity key (§3.5).
  async moveReadOnlyHere(surface = this.#followSurfaces()[0]) {
    if (!surface?.readOnly) return;
    const { id } = surface.readOnly;
    this.#discardConsentFor(id, '');
    await this.#refreshContext({ freshKey: true });
    if (this.windowContext?.kind === 'project' && this.windowContext.available === false) return;
    await this.store.moveConversation(id, tagFor(this.windowContext));
    surface.readOnly = undefined;
    if (surface.follow) {
      await this.#postConversation(surface, await this.store.selectConversation(id));
    } else {
      await this.#postSurfaces(this.#surfacesFor(id).concat([surface]));
    }
    this.#changed();
  }

  async leaveReadOnly(surface = this.#followSurfaces()[0]) {
    if (!surface?.follow) return;
    surface.readOnly = undefined;
    await this.#postConversation(surface, await this.store.getCurrent());
  }

  // The chat that commands without a chat (Move to General, Attach
  // Selection) act on: the editor tab used last, else the current chat.
  #targetSurface() {
    const last = this.#lastFocused;
    if (last && !last.disposed) return last;
    return [...this.#surfaces].find((surface) => !surface.follow) || this.#followSurfaces()[0];
  }

  // From the Chats list: move or relink a chat of another context to this
  // window's context, after a confirmation (the same rule as the tab's
  // "Move to this project" button, §3.4).
  async moveChatHere(chatId) {
    await this.#refreshContext({ freshKey: true });
    const conversation = await this.store.getConversation(chatId);
    if (this.store.isAllowed(conversation)) return;
    if (conversation.section === 'unknown' || (this.windowContext?.kind === 'project' && this.windowContext.available === false)) {
      vscode.window.showInformationMessage('This chat cannot be moved into this window.');
      return;
    }
    if (this.#streams.has(chatId)) return;
    const target = this.windowContext?.kind === 'project' ? this.windowContext.label : 'General';
    const action = conversation.section === 'earlier-key' ? 'Relink' : 'Move';
    const choice = await vscode.window.showWarningMessage(
      `${action} "${conversation.title}" to ${target}?`,
      { modal: true, detail: `It will be listed and continued in ${target}. Its messages are kept.` },
      `${action} to ${target}`
    );
    if (choice !== `${action} to ${target}`) return;
    await this.store.moveConversation(chatId, tagFor(this.windowContext));
    await this.#postSurfaces([...this.#surfaces]);
    this.#changed();
  }

  // In a project window: move a chat to General (reverses Move).
  async moveToGeneral(chatId) {
    await this.#refreshContext();
    if (this.windowContext?.kind !== 'project') {
      vscode.window.showInformationMessage('This window is already in General.');
      return;
    }
    const target = chatId || this.#chatOf(this.#targetSurface()) || this.store.currentId;
    if (this.#streams.has(target) || (!this.ui && this.activeAbort)) {
      vscode.window.showInformationMessage('Stop the current response before moving this chat.');
      return;
    }
    const current = await this.store.getConversation(target);
    if (!this.store.isAllowed(current)) {
      vscode.window.showInformationMessage('Only a chat of this project can be moved to General from this window.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Move "${current.title}" to General? It will no longer be listed in ${this.windowContext.label}.`,
      { modal: true },
      'Move to General'
    );
    if (choice !== 'Move to General') return;
    this.#discardConsentFor(target, '');
    await this.store.moveConversation(current.id, { kind: 'general' });
    if (this.attachment?.conversationId === current.id) this.#dropAttachment('context');
    await this.#postSurfaces([...this.#surfaces]);
    this.#changed();
  }

  // Choose the project folder, or General: in multi-root windows (§3.2), and
  // after the window's folder was removed (§3.4).
  async chooseProject() {
    this.#discardConsent('');
    await this.#refreshContext();
    const folders = this.windowContext?.folders || [];
    if (!this.windowContext?.canChoose) {
      vscode.window.showInformationMessage(folders.length
        ? 'This window has one folder; its chats are listed automatically.'
        : 'No folder is open, so this window uses General.');
      return;
    }
    if (this.activeAbort) {
      vscode.window.showInformationMessage('Stop the current response before changing project.');
      return;
    }
    const currentUri = this.windowContext.kind === 'project' ? this.windowContext.folderUri : 'general';
    const items = [
      ...folders.map((folder) => ({ label: `$(folder) ${plainText(folder.label)}`, description: folder.uri === currentUri ? 'current' : undefined, value: folder.uri })),
      { label: '$(comment-discussion) General', description: currentUri === 'general' ? 'current' : 'chats not tied to a folder', value: 'general' }
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Kenlith: Choose Project', placeHolder: 'Which folder are these chats about?' });
    if (!choice) return;
    await this.project.choose(choice.value);
    await this.#refreshContext();
    await this.#postSurfaces([...this.#surfaces]);
    this.#changed();
  }

  // New Chat. With editor tabs it opens in a tab; an empty chat of this
  // context is reused rather than adding another empty one.
  async newChat({ beside = false } = {}) {
    // Re-read the identity key before writing a project tag (§3.5).
    await this.#refreshContext({ freshKey: true });
    if (this.ui) {
      const conversation = await this.store.newConversation();
      this.#changed();
      await this.ui.openChat(conversation.id, { beside });
      return conversation;
    }
    this.#discardConsent('');
    this.stop();
    this.#dropAttachment('new-chat');
    for (const surface of this.#followSurfaces()) surface.readOnly = undefined;
    const conversation = await this.store.newConversation();
    for (const surface of this.#followSurfaces()) await this.#postConversation(surface, conversation);
    this.#changed();
    return conversation;
  }

  // Stops the reply of one chat, or every reply in this window. The reply
  // stays registered until it has been saved and its lease released, so a
  // Send pressed right after Stop waits for that instead of being refused.
  stop(chatId) {
    for (const [id, stream] of this.#streams) {
      if (chatId === undefined || id === chatId) {
        stream.stopping = true;
        stream.controller.abort();
      }
    }
    this.#changed();
  }

  // Replies that count against MAX_STREAMS (not those already stopping).
  #liveStreams() {
    return [...this.#streams.values()].filter((stream) => !stream.stopping);
  }

  // The window is closing: replies still streaming are cut off, not stopped
  // by the user. They are kept as interrupted (never re-sent), not as stopped.
  dispose() {
    for (const stream of this.#streams.values()) stream.shutdown = true;
    this.stop();
    this.attachment = undefined;
    this.drafts.dispose?.();
  }

  // ---------- selected code (stage 3; architecture §4–§6) ----------

  // Attach Selection: the editor's primary selection, read once, after the
  // scheme, folder, blocked-file and size checks, for the chat used last.
  // Nothing is sent here.
  async attachSelection(surface = this.#targetSurface()) {
    await this.#refreshContext();
    if (!surface) return;
    if (surface.readOnly) {
      this.#postAttachment({ tone: 'refused', text: 'This chat is read-only here, so code cannot be attached to it. Go back to your chat first.' }, [surface]);
      return;
    }
    const snapshot = await this.#capture(vscode.window.activeTextEditor, [surface]);
    if (!snapshot) return;
    const conversationId = surface.follow ? (await this.store.getCurrent()).id : surface.chatId;
    const previous = this.attachment;
    // A newer capture replaces the older one, which then can never be sent.
    this.attachment = {
      snapshot,
      approved: false,
      credentialConfirmed: false,
      changed: false,
      conversationId,
      signature: contextSignature(this.windowContext)
    };
    if (previous && previous.conversationId !== conversationId) {
      this.#postChat(previous.conversationId, { type: 'attachment', attachment: null, notice: { tone: 'info', text: 'The attached code moved to another chat. Nothing was sent from here.' } });
    }
    this.#postAttachment(null);
  }

  // A refusal keeps the earlier attachment, if any, and says why.
  async #capture(editor, surfaces) {
    try {
      return await captureSelection(editor, this.windowContext, {
        maxChars: userMaxSelectionCharacters(),
        folderPath: this.windowContext?.folderPath,
        trusted: vscode.workspace.isTrusted !== false
      });
    } catch (error) {
      if (!(error instanceof AttachmentRefusal)) throw error;
      this.#postAttachment({ tone: 'refused', text: error.message }, surfaces);
      return undefined;
    }
  }

  #currentAttachment(id, surface) {
    if (this.attachment && typeof id === 'string' && id === this.attachment.snapshot.id
      && (!surface || this.#chatOf(surface) === this.attachment.conversationId)) {
      return this.attachment;
    }
    this.#postAttachment({ tone: 'refused', text: 'That attachment was replaced or removed, so it cannot be used. Attach the code again.' }, surface ? [surface] : undefined);
    return undefined;
  }

  // Approval makes no network request. Possible credentials need a second,
  // explicit confirmation (§4.4).
  approveAttachment(id, reviewed, surface) {
    const attachment = this.#currentAttachment(id, surface);
    if (!attachment) return;
    const lines = attachment.snapshot.flags.credentialPattern;
    if (lines.length && reviewed !== true) {
      this.#postAttachment({ tone: 'refused', text: `Lines ${lines.join(', ')} may contain credentials. Check them, then confirm that you reviewed them before approving.` });
      return;
    }
    attachment.approved = true;
    attachment.credentialConfirmed = lines.length > 0;
    this.#postAttachment(null);
  }

  removeAttachment(id, surface) {
    if (!this.#currentAttachment(id, surface)) return;
    const surfaces = this.#attachmentSurfaces();
    this.attachment = undefined;
    this.#postAttachment({ tone: 'info', text: 'Attachment removed. Nothing was sent.' }, surfaces);
  }

  // A new snapshot of the same document with its current selection, which
  // needs a new approval. If that document is not open in an editor, the
  // current attachment stays as it is.
  async refreshAttachment(id, surface) {
    const attachment = this.#currentAttachment(id, surface);
    if (!attachment) return;
    const source = attachment.snapshot.source;
    const editors = [vscode.window.activeTextEditor, ...(vscode.window.visibleTextEditors || [])];
    const editor = editors.find((candidate) => candidate?.document?.uri?.toString() === source.uri);
    if (!editor) {
      this.#postAttachment({ tone: 'refused', text: `Open ${source.displayPath} in an editor and select the code to refresh it. The current attachment is unchanged.` });
      return;
    }
    await this.#refreshContext();
    if (this.attachment !== attachment) return;
    const snapshot = await this.#capture(editor);
    if (!snapshot || this.attachment !== attachment) return;
    this.attachment = { ...attachment, snapshot, approved: false, credentialConfirmed: false, changed: false };
    this.#postAttachment(null);
  }

  // From onDidChangeTextDocument: the snapshot never changes, but the card
  // says that the document moved on since capture (§4.2).
  documentChanged(event) {
    const attachment = this.attachment;
    if (!attachment || attachment.changed || !event?.contentChanges?.length) return;
    const source = attachment.snapshot.source;
    if (event.document?.uri?.toString() === source.uri && event.document.version !== source.documentVersion) {
      attachment.changed = true;
      this.#postAttachment();
    }
  }

  #attachmentSurfaces() {
    return this.attachment ? this.#surfacesFor(this.attachment.conversationId) : [];
  }

  // `surfaces`: where to say so (default: the attachment's chat).
  #dropAttachment(reason, surfaces = this.#attachmentSurfaces()) {
    if (!this.attachment) return;
    this.attachment = undefined;
    this.#postAttachment(DROP_NOTICES[reason] ? { tone: 'info', text: DROP_NOTICES[reason] } : null, surfaces);
  }

  // The card's display copy. The text is shown in full; it is the exact text
  // that would be sent.
  #attachmentInfo(chatId) {
    const attachment = this.attachment;
    if (!attachment || (chatId !== undefined && attachment.conversationId !== chatId)) return null;
    const { snapshot } = attachment;
    return {
      id: snapshot.id,
      text: snapshot.text,
      chars: snapshot.chars,
      utf8Bytes: snapshot.utf8Bytes,
      tokens: snapshot.tokens,
      displayPath: snapshot.source.displayPath,
      languageId: snapshot.source.languageId,
      startLine: snapshot.source.startLine,
      endLine: snapshot.source.endLine,
      unsaved: snapshot.source.unsaved,
      untitled: snapshot.source.untitled,
      credentialLines: [...snapshot.flags.credentialPattern],
      multipleSelections: snapshot.flags.multipleSelections,
      envExample: snapshot.flags.envExample,
      changed: attachment.changed,
      approved: attachment.approved
    };
  }

  // `notice`: undefined keeps the card's notice, null clears it. Goes to the
  // attachment's chat, or to `surfaces` (a refusal before anything is attached).
  #postAttachment(notice, surfaces) {
    const targets = surfaces || this.#attachmentSurfaces();
    for (const surface of targets) {
      surface.webview.postMessage({ type: 'attachment', attachment: this.#attachmentInfo(this.#chatOf(surface)), notice });
    }
  }

  // The attachment named by a send, checked again just before composing:
  // current, approved, captured for this chat and context, and unchanged.
  #attachmentForSend(id, conversationId) {
    const attachment = this.attachment;
    if (id === undefined) {
      if (attachment && attachment.conversationId === conversationId) {
        throw new Error('Approve or remove the attached code before sending. Nothing was sent.');
      }
      return undefined;
    }
    if (!attachment || id !== attachment.snapshot.id) {
      throw new Error('That attachment was replaced or removed. Nothing was sent; attach the code again.');
    }
    if (!attachment.approved) {
      throw new Error('Approve the attached code before sending. Nothing was sent.');
    }
    const context = this.windowContext;
    const source = attachment.snapshot.source;
    if (conversationId !== attachment.conversationId
      || contextSignature(context) !== attachment.signature
      || (source.scheme === 'file' && (context?.kind !== 'project' || source.folderKey !== context.key))) {
      this.#dropAttachment('context');
      throw new Error('The attached code belongs to another chat or project, so it was removed. Nothing was sent.');
    }
    if (sha256(attachment.snapshot.text) !== attachment.snapshot.sha256) {
      this.#dropAttachment();
      throw new Error('The attached code failed an integrity check and was removed. Nothing was sent.');
    }
    return attachment;
  }

  // Include in follow-ups / Stop including, for one reply to attached code
  // (§5.1a). Including asks first; it never applies to other replies.
  async setReplyContext(messageId, include, surface = this.#targetSurface()) {
    if (typeof messageId !== 'string') return;
    if (surface?.readOnly) {
      throw new Error('This chat is read-only here. Go back to your chat to change what is sent with follow-up messages.');
    }
    if (include) {
      const choice = await vscode.window.showWarningMessage(
        'Include this answer in follow-up messages?',
        { modal: true, detail: 'This answer may contain code from your attachment. It will be sent with each later message in this chat, within the history budget.' },
        'Include in Follow-ups'
      );
      if (choice !== 'Include in Follow-ups') return;
    }
    const conversationId = this.#chatOf(surface) || (await this.store.getCurrent()).id;
    const message = await this.store.setContextPolicy(conversationId, messageId, include ? 'included' : 'excluded');
    this.#postChat(conversationId, { type: 'messagePolicy', messageId, contextPolicy: message.contextPolicy });
  }

  // ---------- messages from a webview ----------

  async #handleMessage(surface, message) {
    if (!message || typeof message.type !== 'string' || surface.disposed) {
      return;
    }
    if (!surface.follow) this.#lastFocused = surface;

    try {
      if (surface.unchecked && message.type !== 'ready') await this.#conversationFor(surface);
      switch (message.type) {
        case 'ready':
          await this.#hydrate([surface]);
          // A tab's page reloads when the tab is shown again: if it is the
          // active tab, its message box takes the keyboard focus.
          if (!surface.follow && surface.host.active) surface.webview.postMessage({ type: 'focusControl', id: 'prompt' });
          break;
        case 'signIn':
          await this.signIn();
          break;
        case 'signOut':
          await this.signOut();
          break;
        case 'newChat':
          await this.newChat();
          break;
        case 'selectConversation':
          // Only a following surface changes chats in place; a tab is bound.
          if (surface.follow) await this.#selectConversation(surface, message.conversationId);
          break;
        case 'stop':
          this.stop(this.#chatOf(surface));
          this.#postStreamStates();
          break;
        case 'selectModel':
          await this.#selectModel(surface, message.model);
          break;
        case 'selectEffort':
          await this.#selectEffort(surface, message.effort);
          break;
        case 'send':
          await this.#send(surface, message.text, message.model, message.attachmentId, undefined, message.sendId, message.draftRev, message.effort);
          break;
        case 'draft':
          await this.#saveDraft(surface, message.text, message.rev);
          break;
        case 'attachSelection':
          await this.attachSelection(surface);
          break;
        case 'approveAttachment':
          this.approveAttachment(message.id, message.reviewed, surface);
          break;
        case 'refreshAttachment':
          await this.refreshAttachment(message.id, surface);
          break;
        case 'removeAttachment':
          this.removeAttachment(message.id, surface);
          break;
        case 'setReplyContext':
          await this.setReplyContext(message.messageId, message.include === true, surface);
          break;
        case 'copyText':
          await this.#copyText(surface, message.text);
          break;
        case 'openLink':
          await this.#openLink(message.url);
          break;
        case 'manageUsage':
          // The address is fixed here; the webview cannot choose it.
          await this.#openLink(USAGE_SETTINGS_URL);
          break;
        case 'consentDecision':
          await this.#consentDecision(surface, message.choice);
          break;
        case 'commandDecision':
          this.#cardDecision(surface, this.#commandPending, message.id, message.choice, ['run', 'decline'], typeof message.digest === 'string' ? message.digest : '');
          break;
        case 'outputDecision':
          this.#cardDecision(surface, this.#outputPending, message.id, message.choice, ['share', 'withhold']);
          break;
        case 'reviewDecision':
          await this.#reviewDecision(surface, message.proposalId, message.digest, message.choice);
          break;
        case 'showDiff':
          await this.#showDiff(surface, message.proposalId, message.path);
          break;
        case 'manageProjectSharing':
          await this.manageProjectSharing();
          break;
        case 'openProjectSettings':
          // 0.7.0 RC2: the + menu opens the editor's own Settings at Kenlith's
          // project context settings (user settings; nothing changes here).
          await vscode.commands.executeCommand('workbench.action.openSettings', 'kenlith.projectContext');
          break;
        case 'resumeUsage':
          await this.resumeUsage([surface]);
          break;
        case 'showHistory':
          await this.showHistory({ fromView: true, surface });
          break;
        case 'showAllChats':
          await this.showAllChats({ surface });
          break;
        case 'chooseProject':
          await this.chooseProject();
          break;
        case 'moveReadOnly':
          await this.moveReadOnlyHere(surface);
          break;
        case 'leaveReadOnly':
          await this.leaveReadOnly(surface);
          break;
        case 'showOtherReply':
          // The chat replying in this window, in its tab.
          for (const id of this.#streams.keys()) { if (id !== this.#chatOf(surface)) { await this.openChat(id); break; } }
          break;
        case 'stopOtherReply':
          for (const id of [...this.#streams.keys()]) if (id !== this.#chatOf(surface)) this.stop(id);
          this.#postStreamStates();
          break;
        case 'focusChats':
          await vscode.commands.executeCommand('planChat.sidebar.focus');
          break;
        default:
          break;
      }
    } catch (error) {
      await this.#handleError(error, [surface]);
    }
  }

  // ---------- 0.6.0 review (DEC-PLANCHAT-026) ----------

  // The proposal, if this surface may act on it: the surface shows the
  // proposal's chat, writable here. The chat comes from the surface.
  #proposalFor(surface, proposalId) {
    if (typeof proposalId !== 'string' || surface.readOnly) return undefined;
    const proposal = this.review.store.get(proposalId);
    if (!proposal || proposal.chatId !== this.#chatOf(surface)) return undefined;
    return proposal;
  }

  // Apply or Reject pressed on a card. Apply carries the digest the card
  // showed; the review service checks it, the window and every file again.
  async #reviewDecision(surface, proposalId, digest, choice) {
    const proposal = this.#proposalFor(surface, proposalId);
    if (!proposal || (choice !== 'apply' && choice !== 'reject')) return;
    if (choice === 'reject') {
      await this.review.reject(proposal.id);
    } else {
      const result = await this.review.apply(proposal.id, digest);
      if (!result.ok && result.text) this.#postTo([surface], { type: 'contextNote', text: result.text });
    }
    await this.#proposalsChanged(proposal.chatId);
  }

  async #showDiff(surface, proposalId, relPath) {
    const proposal = this.#proposalFor(surface, proposalId);
    if (!proposal || typeof relPath !== 'string') return;
    const result = await this.review.showDiff(proposal.id, relPath);
    if (!result.ok && result.text) this.#postTo([surface], { type: 'contextNote', text: result.text });
  }

  // Editor events for proposals (src/extension.js).
  proposalDocumentChanged(document) {
    if (document?.uri?.scheme === 'file') this.review.documentChanged(document.uri.fsPath);
  }

  proposalFilesTouched() {
    this.review.touched();
  }

  // proposals.json changed (another window applied, rejected or added one).
  proposalStoreChanged() {
    this.#proposalsChanged(undefined).catch(() => undefined);
  }

  // The only way out of a usage pause besides a new sign-in.
  async resumeUsage(surfaces = [...this.#surfaces]) {
    await this.context.globalState.update(USAGE_PAUSE_KEY, undefined);
    this.#postAll({ type: 'error', message: '' });
    this.#postTo(surfaces, { type: 'contextNote', text: 'Sending is resumed. Your next message uses your ChatGPT plan again.' });
    this.#changed();
  }

  async #handleError(error, surfaces) {
    // A failed reply is already shown, and announced, in its own message;
    // the banner and a notification used to repeat it. A notification is
    // still shown when the view is hidden, so the failure is not missed.
    if (this.#shownInMessage.has(error) && !error?.reauthRequired) {
      if (!(surfaces || [...this.#surfaces]).some((surface) => surface.host.visible)) {
        await this.#notifyError(error);
      }
    } else {
      this.#reportError(error, surfaces);
    }
    if (error?.reauthRequired) {
      // Credentials are gone or unusable: show the sign-in state, keep the error visible.
      this.models = [];
      await this.#hydrate().catch(() => undefined);
      this.#postTo(surfaces || [...this.#surfaces], { type: 'error', message: safeError(error) });
    }
  }

  // Everything a surface needs to draw its chat. `surfaces`: the ones to
  // update (default: all).
  async #hydrate(surfaces) {
    if (this.#activationError) {
      const error = this.#activationError;
      this.#activationError = undefined;
      throw error;
    }
    // The context comes first: the store must know it before choosing or
    // creating the window's chat.
    await this.#refreshContext({ noteEditor: true });
    let session = await this.authService.getSession();
    let modelError;
    let modelErrorAction;

    if (session && !this.models.length) {
      try {
        this.models = await this.openAIService.listModels();
      } catch (error) {
        modelError = safeError(error);
        modelErrorAction = usageAction(error);
        if (error?.reauthRequired) {
          session = await this.authService.getSession();
        }
      }
    }

    let defaultModel = this.context.globalState.get(SELECTED_MODEL_KEY);
    if (this.models.length && !this.models.some((model) => model.id === defaultModel)) {
      defaultModel = this.models[0].id;
      await this.context.globalState.update(SELECTED_MODEL_KEY, defaultModel);
    }
    if (this.#lastSessionKey === undefined) this.#lastSessionKey = session ? `${session.subject || ''}|${session.email || ''}` : '';

    // Shows the view's New Chat and History actions only while signed in.
    await vscode.commands.executeCommand('setContext', 'planChat.signedIn', Boolean(session));
    for (const surface of surfaces || [...this.#surfaces]) {
      if (surface.follow) surface.readOnly = undefined;
      const conversation = await this.#conversationFor(surface);
      const conversationList = await this.store.listConversations();
      if (!surface.follow && conversation) conversationList.currentId = conversation.id;
      const chatModel = conversation?.model;
      const selectedModel = chatModel && this.models.some((model) => model.id === chatModel) ? chatModel : defaultModel;
      surface.webview.postMessage({
        type: 'hydrate',
        session,
        planUsage: usesPlan(session),
        conversation,
        conversationList,
        models: this.models,
        selectedModel,
        reasoning: this.#reasoningInfo(conversation, selectedModel),
        modelError,
        modelErrorAction,
        context: this.#contextInfo(),
        attachment: this.#attachmentInfo(this.#chatOf(surface)),
        readOnly: this.#readOnlyInfo(surface),
        draft: await this.#draftFor(surface, conversation),
        streaming: this.#streams.has(this.#chatOf(surface)),
        otherReply: this.#otherReply(this.#chatOf(surface)),
        mode: surface.follow ? 'view' : 'panel'
      });
      const pending = this.#pending.get(this.#chatOf(surface));
      if (pending) this.#postConsentTo([surface], pending, '');
      // 0.7.0: a waiting command or output card comes back with the page.
      const commandEntry = this.#commandPending.get(this.#chatOf(surface));
      if (commandEntry) surface.webview.postMessage(commandEntry.message(commandEntry.card));
      const outputEntry = this.#outputPending.get(this.#chatOf(surface));
      if (outputEntry) surface.webview.postMessage(outputEntry.message(outputEntry.card));
      // 0.6.0: a reopened tab or a restarted window shows its proposals again.
      if (conversation && !surface.readOnly) {
        const proposals = await this.review.cardsFor(conversation.id).catch(() => []);
        if (proposals.length) surface.webview.postMessage({ type: 'proposals', chatId: conversation.id, proposals });
      }
    }
    // The side bar shows the account and the model for new chats.
    this.#changed();
  }

  // The model for this chat, and the default for new chats (the model chosen last).
  async #selectModel(surface, model) {
    if (typeof model !== 'string' || !this.models.some((candidate) => candidate.id === model)) {
      return;
    }
    await this.context.globalState.update(SELECTED_MODEL_KEY, model);
    const chatId = this.#chatOf(surface);
    if (chatId && !surface.readOnly) await this.store.setConversationModel(chatId, model).catch(() => undefined);
    // 0.8.0: the chat's effort is checked against the new model. Kept if the
    // model accepts it; otherwise the next Send uses Default and the view says
    // so. The chat's saved choice is not changed.
    await this.#postReasoning(chatId ? this.#surfacesFor(chatId) : [surface], model);
    this.#changed();
  }

  // 0.8.0 (DEC-PLANCHAT-040): what the Thinking selector shows for a chat and
  // model: the chat's choice, else kenlith.reasoning.defaultEffort, checked
  // against the model (src/reasoning.js).
  #reasoningInfo(conversation, model) {
    return effortView({ chatEffort: conversation?.reasoningEffort, userDefault: userReasoningDefaultEffort(), model, models: this.models });
  }

  // The model a surface's next Send uses, as hydrate shows it.
  #modelOf(conversation) {
    const chatModel = conversation?.model;
    if (chatModel && this.models.some((candidate) => candidate.id === chatModel)) return chatModel;
    return this.context.globalState.get(SELECTED_MODEL_KEY);
  }

  // Sends each surface the Thinking state of its chat. `model`: the model just
  // chosen (otherwise the chat's own).
  async #postReasoning(surfaces, model) {
    for (const surface of surfaces) {
      const chatId = this.#chatOf(surface);
      const conversation = chatId ? await this.store.getConversation(chatId).catch(() => undefined) : undefined;
      surface.webview.postMessage({ type: 'reasoning', chatId, reasoning: this.#reasoningInfo(conversation, model || this.#modelOf(conversation)) });
    }
  }

  // The Thinking selector of a chat. Only one of the six choices is stored;
  // anything else changes nothing and the view is shown the stored state
  // again. The choice applies from the next Send: a reply in progress keeps
  // the request it was sent with.
  async #selectEffort(surface, effort) {
    const chatId = this.#chatOf(surface);
    if (isEffort(effort) && chatId && !surface.readOnly) {
      await this.store.setConversationEffort(chatId, effort).catch(() => undefined);
    }
    await this.#postReasoning(chatId ? [...new Set([surface, ...this.#surfacesFor(chatId)])] : [surface]);
  }

  async setDefaultModel(model) {
    if (typeof model !== 'string' || !this.models.some((candidate) => candidate.id === model)) return;
    await this.context.globalState.update(SELECTED_MODEL_KEY, model);
    this.#changed();
  }

  defaultModel() {
    return this.context.globalState.get(SELECTED_MODEL_KEY);
  }

  async ensureModels() {
    if (this.models.length) return this.models;
    const session = await this.authService.getSession().catch(() => undefined);
    if (!session) return [];
    this.models = await this.openAIService.listModels();
    return this.models;
  }

  // Unsent text of a chat's composer, saved for restarts (src/drafts.js).
  async #saveDraft(surface, text, rev) {
    if (typeof text !== 'string' || surface.readOnly) return;
    const chatId = this.#chatOf(surface);
    if (!chatId) return;
    let conversation;
    try {
      conversation = await this.store.getConversation(chatId);
    } catch {
      return;
    }
    if (!this.store.isAllowed(conversation)) return;
    await this.drafts.set(chatId, conversation.context, text, rev);
  }

  // ---------- project context (M1) ----------

  #consentStore() {
    if (!this.#consents) {
      this.#consents = new ConsentStore(this.context.globalStorageUri.fsPath);
      // Another window's revoke stops a reply streaming with that grant, and
      // a grant or revoke there updates a waiting consent card here.
      this.#consentWatch = this.#consents.watch((event) => this.#consentChanged(event));
      // A revocation that could not be saved is tried again until it is.
      const retry = setInterval(() => { this.#consents.retryPendingRevocations().catch(() => undefined); }, 5000);
      retry.unref?.();
      this.context.subscriptions?.push({ dispose: () => { clearInterval(retry); this.#consents.dispose(); } });
    }
    return this.#consents;
  }

  // Sharing ended for a grant: every reply in this window that uses it stops.
  #stopProjectStreams(keyId) {
    for (const stream of this.#streams.values()) {
      if (stream.project && (keyId === undefined || stream.project.keyId === keyId)) {
        stream.project.revoked = true;
        stream.controller.abort();
      }
    }
  }

  #consentChanged(event) {
    for (const stream of this.#streams.values()) {
      const project = stream.project;
      if (project && event.key === project.keyId && (event.state !== 'active' || event.consentId !== project.consentId)) {
        project.revoked = true;
        stream.controller.abort();
      }
    }
    for (const pending of this.#pending.values()) {
      if (event.key === pending.keyId) {
        this.#postConsent(pending, event.state === 'active' ? 'Sharing was allowed for this project in another window. Choose Allow and send to use it here.' : '');
      }
    }
    this.#changed();
  }

  // What this send may read and share. Returns:
  //   {} or { activeGrant }                     no project context this time
  //   { activeGrant, excerpts, grant, ... }     excerpts under an active grant
  //   { consentNeeded }                         excerpts exist, no grant yet
  //   { tools, askFirst, ... }                  nothing matched, no grant yet:
  //                                             tools offered, results ask first
  //   { noProjectFiles, activeGrant }           the user chose to answer without files
  async #projectPlan({ text, conversation, session, attachment, projectChoice, signal }) {
    const windowContext = this.windowContext;
    const tag = conversation.context;
    const gate = preflight({
      chatKind: tag?.kind || 'untagged',
      chatProjectKey: tag?.key,
      windowProjectKey: windowContext?.kind === 'project' ? windowContext.key : undefined,
      trusted: vscode.workspace.isTrusted,
      localRoot: windowContext?.kind === 'project' && windowContext.available ? windowContext.folderPath : undefined,
      kill: !userProjectContextEnabled()
    });
    const identityKey = this.project.identity?.cached?.key;
    if (!gate.ok || !identityKey || typeof session.subject !== 'string' || !session.subject) {
      return {};
    }
    const grantKey = { projectKey: windowContext.key, provider: PROVIDER, accountRef: accountRefFor(identityKey, session.subject) };
    const keyId = keyOf(grantKey);
    const consents = this.#consentStore();
    // A revocation that could not be saved earlier is saved first.
    await consents.retryPendingRevocations();
    const record = await consents.read(grantKey);
    const activeGrant = record.active ? { grantKeyId: keyId, consentId: record.consentId, policyVersion: record.policyVersion } : undefined;
    const base = { activeGrant, grantKey, keyId, record, label: windowContext.label, subject: session.subject };
    if (attachment) {
      // A message carries attached code or project excerpts, never both.
      return base;
    }
    const choice = typeof projectChoice === 'string' ? projectChoice : projectChoice?.choice;
    if (choice === 'without') {
      return { ...base, noProjectFiles: true };
    }
    const root = await resolveRoot(windowContext.folderPath);
    if (!root.ok) {
      return base;
    }
    if (choice === 'allow' && record.active && Array.isArray(projectChoice?.excerpts)) {
      // Exactly the excerpts the card showed; the gate re-reads their files
      // and sends nothing if any changed.
      return { ...base, excerpts: projectChoice.excerpts, root: root.root, retrievedAt: Date.now() };
    }
    this.#postChat(conversation.id, { type: 'contextNote', text: `Looking through ${windowContext.label}…` });
    // Local selection (0.5.0: with the editor's active and open files as
    // signals). Workspace exclude settings may only add exclusions.
    const found = await this.projectContext.select({ query: text, signal });
    this.#postChat(conversation.id, { type: 'contextNote', text: '' });
    const withheld = (found.withheld || []).length;
    // 0.5.0: under an active grant the model may also ask for bounded project
    // evidence with the read-only tools (docs/kenlith-0.5.0/ARCHITECTURE.md §4).
    const toolsAllowed = userProjectToolsEnabled() && !this.openAIService.toolsUnsupported;
    const tools = Boolean(record.active && toolsAllowed);
    if (found.status !== 'ok' || !found.excerpts?.length) {
      if (tools) return { ...base, withheld, tools, root: root.root, retrievedAt: Date.now() };
      // Nothing matched locally and no grant (DEC-PLANCHAT-024): the tools
      // are still offered. Their definitions carry nothing from the project;
      // the first results the model asks for wait for the sharing card
      // (askFirst), and nothing project-derived is sent before Allow.
      if (toolsAllowed && record.state !== 'unavailable') {
        return { ...base, withheld, tools: true, askFirst: { account: session.email || session.name || 'your ChatGPT account' }, root: root.root, retrievedAt: Date.now() };
      }
      return { ...base, withheld };
    }
    if (record.active) {
      return { ...base, excerpts: found.excerpts, withheld, tools, root: root.root, retrievedAt: Date.now() };
    }
    if (record.state === 'unavailable') {
      // Consent cannot be read safely now: answer without project context.
      return { ...base, withheld, unavailable: true };
    }
    return {
      consentNeeded: {
        grantKey,
        keyId,
        expectedRevision: record.revision,
        token: consents.mintToken(grantKey, record.revision),
        label: windowContext.label,
        account: session.email || session.name || 'your ChatGPT account',
        // Kept whole here (with file hashes); only display fields reach the view.
        excerpts: found.excerpts,
        withheld,
        conversationId: conversation.id,
        subject: session.subject,
        retrievedAt: Date.now()
      }
    };
  }

  // The stored record and the gate data for one prepared request.
  #projectRecord(plan, request, conversation, replays) {
    const notes = [];
    if (plan.withheld) notes.push(`${plan.withheld} ${plan.withheld === 1 ? 'file was' : 'files were'} withheld (they look sensitive or are blocked).`);
    if (plan.unavailable) notes.push('Project sharing could not be checked just now, so no project files were sent.');
    // Earlier answers made with project context under another grant are not re-sent.
    const notResent = (conversation.messages || []).filter((message) => classify(message) === 'project-derived' && !mayReplay(message, plan.activeGrant)).length;
    if (notResent) notes.push(`${notResent} earlier ${notResent === 1 ? 'answer that used' : 'answers that used'} project files ${notResent === 1 ? 'was' : 'were'} not re-sent.`);
    const excerpts = request.excerpts || [];
    const project = { note: notes.join(' '), userDetails: {}, replyDetails: {} };
    if (plan.noProjectFiles) {
      project.replyDetails = { withoutProjectFiles: true };
    }
    if (plan.activeGrant && (excerpts.length || replays || plan.tools)) {
      const grant = { grantKeyId: plan.keyId, consentId: plan.record.consentId, policyVersion: plan.record.policyVersion };
      const contextUsed = contextUsedRecord(excerpts);
      project.grant = { ...grant, keyId: plan.keyId, grantKey: plan.grantKey, revision: plan.record.revision, subject: plan.subject, root: plan.root, excerpts: plan.excerpts ? plan.excerpts.filter((excerpt) => excerpts.some((sent) => sent.relPath === excerpt.relPath && sent.startLine === excerpt.startLine)) : [] };
      project.userDetails = excerpts.length ? { project: { ...grant, consentRevision: plan.record.revision, contextUsed } } : {};
      // A reply that may use the project tools is project-derived from the
      // start (fail closed, DEC-PLANCHAT-012); files the tools return are
      // added to its contextUsed when it ends.
      project.replyDetails = { project: { ...grant, contextUsed } };
      if (plan.tools) project.tools = { pending: [], sent: [], reads: 0, label: plan.label };
    } else if (plan.tools && plan.askFirst && !plan.activeGrant) {
      // No grant yet: the reply is not project-derived unless the card is
      // allowed during the turn (then it is marked before anything is sent).
      project.tools = { pending: [], sent: [], reads: 0, label: plan.label };
      project.askFirst = { grantKey: plan.grantKey, keyId: plan.keyId, label: plan.label, subject: plan.subject, root: plan.root, account: plan.askFirst.account };
    }
    return project;
  }

  // The consent gate (src/context-gate.js) for one request: same grant, same
  // account, trusted workspace, and the excerpts' files unchanged.
  async #finalProjectCheck(project) {
    const grant = project.grant;
    if (!userProjectContextEnabled()) {
      throw new ProjectGateError('disabled');
    }
    const session = await this.authService.getSession().catch(() => undefined);
    const result = await finalCheck({
      consents: this.#consentStore(),
      grantKey: grant.grantKey,
      expected: { consentId: grant.consentId, revision: grant.revision, policyVersion: POLICY_VERSION, provider: PROVIDER },
      session,
      expectedSubject: grant.subject,
      trusted: vscode.workspace.isTrusted,
      sourcesUnchanged: async () => {
        for (const excerpt of grant.excerpts) {
          const again = await readContained(grant.root, excerpt.relPath, { sending: true });
          if (!again.ok || again.sha256 !== excerpt.fileSha256) return false;
        }
        return true;
      }
    });
    if (!result.ok) {
      throw new ProjectGateError(result.reason);
    }
  }

  #showConsent(pending) {
    const chatId = pending.conversationId;
    const shown = { ...pending, shownAt: Date.now() };
    clearTimeout(this.#pending.get(chatId)?.timer);
    this.#pending.set(chatId, shown);
    shown.timer = setTimeout(() => {
      if (this.#pending.get(chatId)?.token === pending.token) this.#discardConsentFor(chatId, 'This confirmation expired. Send your message again when you are ready.');
    }, CONSENT_CARD_MS);
    shown.timer.unref?.();
    this.#postConsent(shown, '');
    this.#changed();
  }

  #postConsentTo(surfaces, pending, notice) {
    this.#postTo(surfaces, {
      type: 'consent',
      consent: {
        label: pending.label,
        account: pending.account,
        provider: 'OpenAI',
        text: pending.text,
        excerpts: pending.excerpts.map(({ relPath, startLine, endLine, text }) => ({ relPath, startLine, endLine, text })),
        withheld: pending.withheld,
        // A card during a reply (DEC-PLANCHAT-024): the tool results exactly
        // as they would be sent.
        ...(pending.tools ? { tools: pending.tools.map(({ name, text }) => ({ name, text })) } : {})
      },
      notice
    });
  }

  #postConsent(pending, notice) {
    this.#postConsentTo(this.#surfacesFor(pending.conversationId), pending, notice);
  }

  // A waiting question is dropped (chat, project, account or window change,
  // or Cancel): nothing was sent, and the text comes back.
  #discardConsentFor(chatId, notice) {
    const pending = this.#pending.get(chatId);
    if (!pending) return;
    if (pending.midTurn) {
      // The question was already sent; only the tool results are dropped.
      this.#endMidTurn(chatId, pending, { choice: 'cancel' }, notice);
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(chatId);
    this.drafts.release(chatId, pending.sendRev).catch(() => undefined);
    this.#postChat(chatId, { type: 'consent', consent: null, notice: notice || '' });
    this.#restoreDraft(chatId, pending.rawText);
    this.#changed();
  }

  // Every waiting question in this window.
  #discardConsent(notice) {
    for (const chatId of [...this.#pending.keys()]) this.#discardConsentFor(chatId, notice);
  }

  async #consentDecision(surface, choice) {
    const chatId = this.#chatOf(surface);
    const pending = this.#pending.get(chatId);
    if (!pending) {
      // A stale card (already answered or dropped): make sure the view clears it.
      this.#postTo([surface], { type: 'consent', consent: null, notice: '' });
      return;
    }
    if (pending.midTurn) {
      await this.#midTurnDecision(surface, chatId, pending, choice);
      return;
    }
    if (choice === 'cancel') {
      this.#discardConsentFor(chatId, '');
      return;
    }
    // One decision at a time; a second click while one runs is ignored.
    if (pending.deciding) return;
    // One request at a time in this window: the card waits, and says why.
    if (this.#liveStreams().length >= MAX_STREAMS) {
      const other = this.#otherReply(chatId);
      this.#postConsent(pending, other
        ? `Kenlith is replying in "${other.title}". Choose again when that reply ends, or stop it. Nothing was sent.`
        : 'Wait for the current reply to finish. Nothing was sent.');
      return;
    }
    pending.deciding = true;
    // The question belongs to the chat, project and account it was asked in.
    const session = await this.authService.getSession().catch(() => undefined);
    if (this.#pending.get(chatId) !== pending) return;
    if (pending.conversationId !== chatId || surface.readOnly || this.windowContext?.kind !== 'project' || this.windowContext.key !== pending.grantKey.projectKey || session?.subject !== pending.subject) {
      this.#discardConsentFor(chatId, 'The chat, project or ChatGPT account changed, so nothing was sent. Your message is back in the box.');
      return;
    }
    if (choice === 'without') {
      clearTimeout(pending.timer);
      this.#pending.delete(chatId);
      this.#postChat(chatId, { type: 'consent', consent: null, notice: '' });
      this.#changed();
      await this.#send(surface, pending.text, pending.model, undefined, 'without', pending.sendId, pending.sendRev, pending.effort);
      return;
    }
    if (choice !== 'allow') {
      pending.deciding = false;
      return;
    }
    if (!userProjectContextEnabled() || vscode.workspace.isTrusted === false) {
      this.#discardConsentFor(chatId, 'Project context is turned off, so nothing was shared or sent. Your message is back in the box.');
      return;
    }
    const granted = await this.#grantPending(chatId, pending);
    if (granted === 'unavailable') {
      this.#discardConsentFor(chatId, 'Project sharing could not be saved just now. Nothing was sent; try again.');
      return;
    }
    if (granted !== 'granted') return;
    clearTimeout(pending.timer);
    this.#pending.delete(chatId);
    this.#postChat(chatId, { type: 'consent', consent: null, notice: '' });
    this.#changed();
    // The original question goes on with exactly the excerpts shown.
    await this.#send(surface, pending.text, pending.model, undefined, { choice: 'allow', excerpts: pending.excerpts }, pending.sendId, pending.sendRev, pending.effort);
  }

  // Allow on a card: writes the grant. Returns 'granted', 'again' (the card
  // stays, with a notice; nothing was sent), 'unavailable' (consent cannot
  // be saved now) or 'gone' (the card was dropped meanwhile).
  async #grantPending(chatId, pending) {
    const consents = this.#consentStore();
    let result = await consents.grant(pending.grantKey, { expectedRevision: pending.expectedRevision, token: pending.token, projectLabel: pending.label });
    if (!result.ok && result.reason === 'token') {
      // The click is a fresh action on the card as shown: if nothing changed
      // since it was shown, a new one-time token stands for it.
      const again = await consents.read(pending.grantKey);
      if (again.revision === pending.expectedRevision && again.state !== 'active' && again.state !== 'unavailable') {
        result = await consents.grant(pending.grantKey, { expectedRevision: pending.expectedRevision, token: consents.mintToken(pending.grantKey, again.revision), projectLabel: pending.label });
      }
    }
    if (this.#pending.get(chatId) !== pending) return 'gone';
    if (!result.ok && result.reason === 'revoke-pending') {
      pending.deciding = false;
      this.#postConsent(pending, 'Stopping sharing for this project is still being saved. Try again in a moment.');
      return 'again';
    }
    if (!result.ok && result.reason !== 'already-active') {
      pending.deciding = false;
      // The state changed (another window revoked or granted), the
      // confirmation expired, or consent cannot be written now: ask again
      // from the current state; nothing was sent.
      const record = await consents.read(pending.grantKey);
      if (this.#pending.get(chatId) !== pending) return 'gone';
      if (record.state === 'unavailable') return 'unavailable';
      Object.assign(pending, { expectedRevision: record.revision, token: consents.mintToken(pending.grantKey, record.revision) });
      this.#postConsent(pending, 'Project sharing changed while this was open. Review it and choose again.');
      return 'again';
    }
    return 'granted';
  }

  // ---------- sharing card during a reply (DEC-PLANCHAT-024) ----------
  // No grant and nothing matched locally: the model asked for project
  // evidence. The tools have run locally; their results are shown on the card
  // and sent only after Allow. The reply waits meanwhile (Stop ends it).
  // Resolves { choice: 'allow', record } | { choice: 'without' } | { choice: 'cancel' }.
  async #askToolConsent(project, chatId, outputs, signal) {
    const ask = project.askFirst;
    const consents = this.#consentStore();
    const record = await consents.read(ask.grantKey);
    if (signal.aborted) return { choice: 'cancel' };
    // Allowed in another window meanwhile: the results go under that grant
    // (DEC-PLANCHAT-023), as for any reply that starts with one.
    if (record.active) return { choice: 'allow', record };
    if (record.state === 'unavailable') return { choice: 'cancel', notice: 'Project sharing could not be checked just now, so nothing from the project was sent.' };
    return new Promise((resolve) => {
      const pending = {
        midTurn: true,
        conversationId: chatId,
        grantKey: ask.grantKey,
        keyId: ask.keyId,
        expectedRevision: record.revision,
        token: consents.mintToken(ask.grantKey, record.revision),
        label: ask.label,
        account: ask.account,
        subject: ask.subject,
        excerpts: [],
        withheld: 0,
        tools: outputs.map((output) => ({ name: output.name, text: output.output })),
        resolve
      };
      const onAbort = () => this.#endMidTurn(chatId, this.#pending.get(chatId), { choice: 'cancel' }, '');
      signal.addEventListener('abort', onAbort, { once: true });
      pending.resolve = (value) => { signal.removeEventListener('abort', onAbort); resolve(value); };
      this.#showConsent(pending);
      // Other chats say this one waits for a decision, not that it replies.
      this.#postStreamStates();
    });
  }

  // Ends a card shown during a reply with the given decision.
  #endMidTurn(chatId, pending, decision, notice) {
    if (!pending?.midTurn || this.#pending.get(chatId) !== pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(chatId);
    this.#postChat(chatId, { type: 'consent', consent: null, notice: notice || '' });
    this.#changed();
    this.#postStreamStates();
    pending.resolve(decision);
  }

  async #midTurnDecision(surface, chatId, pending, choice) {
    if (choice === 'cancel') {
      this.#endMidTurn(chatId, pending, { choice: 'cancel' }, '');
      return;
    }
    if ((choice !== 'allow' && choice !== 'without') || pending.deciding) return;
    pending.deciding = true;
    const session = await this.authService.getSession().catch(() => undefined);
    if (this.#pending.get(chatId) !== pending) return;
    if (surface.readOnly || this.windowContext?.kind !== 'project' || this.windowContext.key !== pending.grantKey.projectKey || session?.subject !== pending.subject) {
      this.#endMidTurn(chatId, pending, { choice: 'cancel' }, 'The chat, project or ChatGPT account changed, so nothing from the project was sent.');
      return;
    }
    if (choice === 'without') {
      this.#endMidTurn(chatId, pending, { choice: 'without' }, '');
      return;
    }
    if (!userProjectContextEnabled() || vscode.workspace.isTrusted === false) {
      this.#endMidTurn(chatId, pending, { choice: 'cancel' }, 'Project context is turned off, so nothing from the project was sent.');
      return;
    }
    const granted = await this.#grantPending(chatId, pending);
    if (granted === 'unavailable') {
      this.#endMidTurn(chatId, pending, { choice: 'cancel' }, 'Project sharing could not be saved just now, so nothing from the project was sent.');
      return;
    }
    if (granted !== 'granted') return;
    const record = await this.#consentStore().read(pending.grantKey);
    if (!record.active) {
      this.#endMidTurn(chatId, pending, { choice: 'cancel' }, 'Project sharing changed, so nothing from the project was sent.');
      return;
    }
    this.#endMidTurn(chatId, pending, { choice: 'allow', record }, '');
  }

  // kenlith.projectContext.enabled (or the Plan Chat 0.4.0 key it falls back
  // to) turned off: nothing more is read or sent.
  configurationChanged(event) {
    // 0.6.0: a proposal stops being actionable when its settings turn off.
    if (['projectContext.enabled', 'projectContext.tools', 'projectContext.proposals'].some((key) => affectsSetting(event, key))) this.review.touched();
    if (affectsSetting(event, 'projectContext.enabled')) this.#refreshSharing();
    if (['projectContext.enabled', 'projectContext.commands'].some((key) => affectsSetting(event, key))) this.#voidCommandCards();
    // 0.8.0: chats without their own Thinking level show the new default.
    if (affectsSetting(event, 'reasoning.defaultEffort')) this.#postReasoning([...this.#surfaces]).catch(() => undefined);
    if (!affectsSetting(event, 'projectContext.enabled') || userProjectContextEnabled()) return;
    this.#discardConsent('Project context was turned off in settings, so nothing was sent.');
    this.#retrievalCache.invalidate();
    this.#stopProjectStreams();
  }

  // Command: Kenlith: Manage Project Sharing.
  async manageProjectSharing() {
    const consents = this.#consentStore();
    const records = await consents.list();
    const session = await this.authService.getSession();
    const identityKey = this.project.identity?.cached?.key;
    const mine = identityKey && session?.subject ? accountRefFor(identityKey, session.subject) : undefined;
    const active = records.filter((record) => record.state === 'active');
    if (!active.length) {
      vscode.window.showInformationMessage('No project is shared with OpenAI from Kenlith in this editor profile.');
      return;
    }
    const picked = await vscode.window.showQuickPick(active.map((record) => ({
      label: record.projectLabel || 'Project',
      description: `OpenAI · ${record.accountRef === mine ? 'this ChatGPT account' : 'another ChatGPT account'}`,
      detail: `Shared since ${String(record.grantedAt || '').slice(0, 10)}. Choose to stop sharing.`,
      record
    })), { title: 'Kenlith: Project Sharing', placeHolder: 'Projects whose excerpts Kenlith may send to OpenAI' });
    if (!picked) return;
    const choice = await vscode.window.showWarningMessage(
      `Stop sharing ${picked.label} with OpenAI?`,
      { modal: true, detail: 'Kenlith will not send excerpts from this project, or earlier answers based on them, until you allow it again. Anything already sent cannot be recalled.' },
      'Stop Sharing'
    );
    if (choice !== 'Stop Sharing') return;
    const grantKey = { projectKey: picked.record.projectKey, provider: picked.record.provider, accountRef: picked.record.accountRef };
    const result = await consents.revoke(grantKey, 'user');
    this.#stopProjectStreams(keyOf(grantKey));
    this.#changed();
    if (result.ok) {
      vscode.window.showInformationMessage(`Kenlith stopped sharing ${picked.label}.`);
    } else {
      vscode.window.showWarningMessage('Kenlith stopped sharing in this window but could not save it yet. It tries again every few seconds; until it is saved, other windows may still share.');
    }
  }

  // Whether this window's project is shared with this account, for the
  // Chats list: 'shared', 'not-shared', or undefined when it does not apply.
  async projectSharingState() {
    const context = this.windowContext;
    if (context?.kind !== 'project') return undefined;
    if (!userProjectContextEnabled()) return 'off';
    const session = await this.authService.getSession().catch(() => undefined);
    const identityKey = this.project.identity?.cached?.key;
    if (!session?.subject || !identityKey) return undefined;
    const record = await this.#consentStore().read({ projectKey: context.key, provider: PROVIDER, accountRef: accountRefFor(identityKey, session.subject) }).catch(() => undefined);
    return record?.active ? 'shared' : 'not-shared';
  }

  async #selectConversation(surface, conversationId) {
    if (typeof conversationId !== 'string' || this.activeAbort || !surface) {
      return;
    }
    this.#discardConsent('');
    // The store refuses a chat of another context (a forged or stale id).
    const conversation = await this.store.selectConversation(conversationId);
    surface.readOnly = undefined;
    await this.#postConversation(surface, conversation);
    this.#changed();
  }

  // ---------- sending ----------

  // `sendRev`: when Send was pressed (the composer's clock), for the draft
  // lifecycle (src/drafts.js).
  async #send(surface, rawText, requestedModel, attachmentId, projectChoice, sendId, sendRev, requestedEffort) {
    sendRev = Number.isFinite(sendRev) ? sendRev : Date.now();
    // From this moment the draft this Send took is not offered back to any
    // composer (a reload or tab switch while it is prepared included). Given
    // back only if the send is refused or given up (D-1).
    const heldChat = this.#chatOf(surface);
    if (heldChat && typeof rawText === 'string' && rawText.trim()) this.drafts.hold(heldChat, sendRev);
    let accepted = false;
    try {
      accepted = await this.#sendHeld(surface, rawText, requestedModel, attachmentId, projectChoice, sendId, sendRev, requestedEffort);
    } finally {
      // Not accepted (refused, stopped before sending, a duplicate): the text
      // was given back, so it may be offered again.
      if (!accepted && heldChat && !this.#pending.has(heldChat)) this.drafts.unhold(heldChat, sendRev);
    }
  }

  // Returns true when the question was stored or now waits for consent.
  async #sendHeld(surface, rawText, requestedModel, attachmentId, projectChoice, sendId, sendRev, requestedEffort) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) {
      return false;
    }
    const chatId = this.#chatOf(surface);
    // A send id seen before, stored or still preparing, means the same Send
    // arrived twice: nothing more, and no text is put back. The first one
    // keeps the hold.
    if (typeof sendId === 'string' && (this.#usedSendIds.has(sendId) || [...this.#streams.values()].some((entry) => entry.sendId === sendId))) {
      return true;
    }
    // A reply of this chat that was just stopped is finishing: wait for it.
    const closing = this.#streams.get(chatId);
    if (closing?.stopping) await closing.done;
    if (this.#streams.has(chatId)) {
      // This chat is starting or streaming: give the text back, unsent.
      this.#restoreDraftTo([surface], rawText);
      return false;
    }
    if (this.#liveStreams().length >= MAX_STREAMS) {
      this.#restoreDraftTo([surface], rawText);
      const other = this.#otherReply(chatId);
      this.#postTo([surface], { type: 'contextNote', text: `Kenlith is replying in "${other?.title || 'another chat'}". Send this when that reply ends, or stop it. Nothing was sent.` });
      return false;
    }
    if (text.length > 100_000) {
      this.#restoreDraftTo([surface], rawText);
      throw new Error('This message is too large. Keep it under 100,000 characters.');
    }
    if (surface.readOnly) {
      // A chat of another context is shown read-only: nothing is sent into it.
      this.#restoreDraftTo([surface], rawText);
      throw new Error('This chat belongs to another context and is read-only here. Move it here first, or go back to your chat.');
    }

    // Claim the stream slot before any await so a second send cannot slip in.
    let accepted = false;
    const controller = new AbortController();
    let finish;
    const stream = { controller, project: undefined, title: undefined, sendId, seq: (this.#sendSeq.get(chatId) || 0) + 1, done: new Promise((resolve) => { finish = resolve; }) };
    this.#sendSeq.set(chatId, stream.seq);
    const claimedId = chatId || `pending:${Math.random()}`;
    this.#streams.set(claimedId, stream);
    this.#postStreamStates();
    this.#changed();
    try {
      await this.#stream(surface, claimedId, stream, text, rawText, requestedModel, controller, attachmentId, projectChoice, sendId, sendRev, requestedEffort);
    } finally {
      accepted = Boolean(stream.accepted);
      for (const [id, entry] of this.#streams) {
        if (entry === stream) this.#streams.delete(id);
      }
      finish();
      // Re-read from disk so messages another window added to this chat show up.
      await this.#postCurrentConversation(stream.chatId || chatId).catch(() => undefined);
      this.#postStreamStates();
      this.#changed();
      // 0.6.0 (DEC-PLANCHAT-028): the reply has ended, its lease is released
      // and it no longer holds the reply slot; only now do its proposals go
      // to Awaiting Review (or are dropped).
      if (stream.draft) await this.review.finalize(stream.draft, { completed: stream.draftCompleted }).catch(() => undefined);
    }
    return accepted;
  }

  // Session, model, attachment and request budget checks, and the composed
  // request. Stores nothing. Returns undefined if the user stopped before
  // sending. A refusal keeps the attachment (§5.1).
  async #prepare(surface, text, requestedModel, controller, attachmentId, projectChoice, requestedEffort) {
    // 0.8.0: a value that is not one of the six choices is refused before
    // anything else; nothing is stored or sent.
    if (requestedEffort !== undefined && !isEffort(requestedEffort)) {
      await this.#postReasoning([surface]).catch(() => undefined);
      throw new Error('Kenlith did not recognise the selected thinking level. Nothing was sent.');
    }
    const session = await this.authService.getSession();
    if (!session) {
      throw new Error('Continue with ChatGPT before sending a message.');
    }
    if (this.context.globalState.get(USAGE_PAUSE_KEY)) {
      throw new UsagePausedError();
    }

    if (!this.models.length) {
      this.models = await this.openAIService.listModels();
    }
    // The model shown in the dropdown when Send was pressed is the model we request.
    const selectedModel = typeof requestedModel === 'string' && requestedModel
      ? requestedModel
      : this.context.globalState.get(SELECTED_MODEL_KEY) || this.models[0]?.id;
    if (!selectedModel || !this.models.some((model) => model.id === selectedModel)) {
      throw new Error(`The model "${selectedModel || 'none'}" is not available for this ChatGPT account. Choose another model.`);
    }
    await this.context.globalState.update(SELECTED_MODEL_KEY, selectedModel);
    if (controller.signal.aborted) {
      return undefined;
    }

    // The chat comes from the surface (a tab's bound chat, or the current
    // chat of a following surface); never from the message.
    const conversation = surface.follow ? await this.store.getCurrent() : await this.store.getConversation(surface.chatId);
    if (!this.store.isAllowed(conversation)) {
      throw new Error('This chat belongs to another context and is read-only here. Move it here first. Nothing was sent.');
    }
    const conversationId = conversation.id;
    // 0.8.0: the Thinking level shown when Send was pressed is the level
    // requested, as for the model; without one (a message from an older
    // page), the chat's level. One the model does not accept is refused here,
    // before any project work or consent card; nothing is sent.
    const effort = requestedEffort === undefined ? this.#reasoningInfo(conversation, selectedModel).effective : requestedEffort;
    if (!isSupported(selectedModel, effort)) {
      await this.#postReasoning([surface], selectedModel).catch(() => undefined);
      throw new Error(`The thinking level "${EFFORT_LABELS[effort]}" is not available for this model. Choose Default or another level. Nothing was sent.`);
    }
    const attachment = this.#attachmentForSend(attachmentId, conversationId);
    const instructions = userInstructions();
    // Project context (M1): what this window may read and share for this chat.
    const plan = await this.#projectPlan({ text, conversation, session, attachment, projectChoice, signal: controller.signal });
    if (controller.signal.aborted) {
      return undefined;
    }
    if (plan.consentNeeded) {
      return { consentNeeded: plan.consentNeeded, conversation };
    }
    // History before the new message is stored; the limit counts the new one.
    // Replies to attached code are left out unless included (§5.1a); replies
    // made with project context only under the grant they were made with
    // (DEC-PLANCHAT-012); replies in progress or interrupted never (0.4.0).
    const history = await this.store.contextMessages(conversationId, userMaxHistoryMessages() - 1, Infinity, { activeGrant: plan.activeGrant });
    const replays = history.some((message) => message.projectDerived);
    // The code goes into this one request only, after the typed text (§5.2).
    // Every request is built in one place (src/request-builder.js).
    const request = buildRequest({
      instructions,
      history,
      text,
      attachment: attachment ? { text: attachment.snapshot.text, chars: attachment.snapshot.chars } : undefined,
      excerpts: plan.excerpts || [],
      noProjectFiles: Boolean(plan.noProjectFiles),
      // 0.6.0: with the read tools, project_propose_edit (records only).
      // 0.7.0: with them, project_run_command and project_run_task (classified by the host).
      tools: plan.tools ? [...TOOL_DEFINITIONS, ...(userProposalsEnabled() ? [PROPOSAL_TOOL_DEFINITION] : []), ...(userCommandsEnabled() ? [RUN_TOOL_DEFINITION, TASK_TOOL_DEFINITION] : [])] : undefined,
      // 0.8.0: checked again there against the model (src/reasoning.js).
      model: selectedModel,
      effort
    });
    const project = this.#projectRecord(plan, request, conversation, replays);
    if (project.tools) {
      project.tools.turn = await this.projectContext.createTurn();
      const identity = await this.#reviewProject();
      const turn = project.tools.turn;
      if (turn && identity && request.tools?.includes(PROPOSAL_TOOL_DEFINITION)) {
        // The draft records proposals for this reply against the turn's own
        // root; it is finalized only after the reply ends (DEC-PLANCHAT-028).
        project.draft = this.review.beginTurn(conversationId, { keyId: identity.keyId, label: identity.label, root: turn.context.root });
        if (project.draft) {
          turn.context.propose = (args) => project.draft.propose(args);
          turn.context.proposeRefused = (refusal) => project.draft.refused(refusal);
        }
      }
      if (turn && identity && request.tools?.includes(RUN_TOOL_DEFINITION)) {
        // 0.7.0: runs of this reply. The reply's controller stops them (Stop,
        // window close); a sharing grant decides what output may be sent.
        const exec = this.exec.beginTurn({
          chatId: conversationId,
          root: turn.context.root,
          hasGrant: () => Boolean(project.grant),
          askApproval: (card, signal) => this.#askCommand(conversationId, card, signal),
          askOutputSharing: (card, signal) => this.#askOutput(conversationId, card, signal),
          onRunning: (on, command) => this.#runningChanged(conversationId, on, command),
          signal: controller.signal
        });
        project.exec = exec;
        turn.context.handlers = exec.handlers();
      }
    }
    if (project.grant) {
      // Checked before anything is stored, and again just before sending.
      await this.#finalProjectCheck(project);
    }
    if (controller.signal.aborted) {
      return undefined;
    }
    return { selectedModel, conversationId, conversation, instructions, request, attachment, project };
  }

  // A code block's Copy button: the text arrives exactly as rendered from the
  // message, and goes to the clipboard unchanged.
  async #copyText(surface, text) {
    if (typeof text !== 'string' || text.length > 2_000_000) {
      return;
    }
    await this.platform.writeClipboard(text);
    this.#postTo([surface], { type: 'copied' });
  }

  // A link from a message. Only absolute http(s) addresses are accepted (the
  // webview renders no others), and the browser opens only after the user has
  // seen the full address and chosen to open it.
  async #openLink(url) {
    const target = safeUrl(url);
    if (!target) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Open this link in your browser?',
      { modal: true, detail: target },
      'Open Link'
    );
    if (choice === 'Open Link') {
      await this.platform.openExternal(target);
    }
  }

  async openUsageSettings() {
    await this.#openLink(USAGE_SETTINGS_URL);
  }

  #restoreDraft(chatId, rawText) {
    this.#restoreDraftTo(this.#surfacesFor(chatId), rawText);
  }

  #restoreDraftTo(surfaces, rawText) {
    if (typeof rawText === 'string' && rawText) {
      this.#postTo(surfaces, { type: 'restoreDraft', text: rawText });
    }
  }

  async #postCurrentConversation(chatId) {
    const surfaces = chatId ? this.#surfacesFor(chatId) : [];
    // A following surface shows its current chat (or the read-only one).
    for (const surface of new Set([...surfaces, ...this.#followSurfaces()])) {
      await this.#postConversation(surface);
    }
  }

  async #stream(surface, claimedId, stream, text, rawText, requestedModel, controller, attachmentId, projectChoice, sendId, sendRev, requestedEffort) {
    // Everything that can refuse the message runs before anything is stored.
    // A refusal, or Stop before sending, gives the typed text back unsent.
    const latest = () => this.#sendSeq.get(this.#chatOf(surface)) === stream.seq;
    let prepared;
    try {
      prepared = await this.#prepare(surface, text, requestedModel, controller, attachmentId, projectChoice, requestedEffort);
    } catch (error) {
      if (latest()) this.#restoreDraftTo([surface], rawText);
      throw error;
    }
    if (!prepared) {
      if (latest()) this.#restoreDraftTo([surface], rawText);
      return;
    }
    const conversationId = prepared.conversation.id;
    stream.chatId = conversationId;
    stream.title = prepared.conversation.title;
    if (claimedId !== conversationId) {
      this.#streams.delete(claimedId);
      this.#streams.set(conversationId, stream);
    }
    if (prepared.consentNeeded) {
      if (!userProjectContextEnabled() || vscode.workspace.isTrusted === false) {
        // Turned off (or the workspace no longer trusted) while Kenlith
        // looked through the project: no card, nothing sent.
        this.#restoreDraftTo([surface], rawText);
        this.#postTo([surface], { type: 'contextNote', text: 'Project context was turned off while Kenlith looked through the project, so nothing was sent. Send again to answer without project files.' });
        return;
      }
      // Nothing was stored or sent: the question waits for the user's
      // decision, held by the card. Its draft is marked submitted first, so
      // no refresh offers it back to the composer (D-1).
      await this.drafts.markSubmitted(conversationId, prepared.conversation.context, rawText, sendRev).catch(() => undefined);
      this.#showConsent({ ...prepared.consentNeeded, text, rawText, model: requestedModel, effort: requestedEffort, sendId, sendRev });
      stream.accepted = true;
      return;
    }
    const { selectedModel, instructions, request, attachment, project } = prepared;

    // Reply ownership across windows: taken after every refusal, before the
    // question is stored, held while the reply streams.
    let lease;
    try {
      lease = await this.leases.acquire(conversationId);
    } catch (error) {
      this.#restoreDraftTo([surface], rawText);
      throw error;
    }
    try {
      await this.#sendPrepared({ surface, stream, text, rawText, controller, selectedModel, conversationId, instructions, request, attachment, project, sendId, sendRev, lease });
    } finally {
      await lease.release().catch(() => undefined);
      // 0.6.0: handed to #sendHeld, which finalizes it once this reply has
      // left the window's reply slot (DEC-PLANCHAT-028).
      if (project.draft) {
        stream.draft = project.draft;
        stream.draftCompleted = Boolean(project.draftCompleted) && !controller.signal.aborted;
      }
    }
  }

  async #sendPrepared({ surface, stream, text, rawText, controller, selectedModel, conversationId, request, attachment, project, sendId, sendRev, lease }) {
    // The stored message holds the typed text; the attachment only as
    // metadata (§6). Its reply is marked and left out of later requests.
    const metadata = attachment && attachmentMetadata(attachment.snapshot, { credentialPatternConfirmed: attachment.credentialConfirmed });
    let userMessage;
    try {
      userMessage = await this.store.addMessage('user', text, conversationId, metadata ? { attachments: [metadata] } : project.userDetails);
    } catch (error) {
      // The question could not be saved (for example, the disk is full), so
      // nothing is sent: give the typed text back rather than lose it (WP-05
      // T05-05). An approved attachment stays pending.
      this.#restoreDraftTo([surface], rawText);
      throw error;
    }
    // The question is stored: this Send is used, and the draft is done.
    if (typeof sendId === 'string') this.#usedSendIds.add(sendId);
    // Other chats say which chat is replying, by its title (a new chat's
    // title comes from this first message).
    stream.title = (await this.store.getConversation(conversationId).catch(() => undefined))?.title || stream.title;
    this.#postStreamStates();
    // Drafts up to this Send are done; text typed after it stays. Awaited, so
    // no refresh after this point can offer the sent question back (D-1).
    stream.accepted = true;
    await this.drafts.clearSent(conversationId, sendRev).catch(() => undefined);
    this.store.setConversationModel(conversationId, selectedModel).catch(() => undefined);
    // Only for a request that is going out: after the question is saved.
    this.#postChat(conversationId, {
      type: 'contextNote',
      text: [
        request.omitted ? `${request.omitted} earlier ${request.omitted === 1 ? 'message was' : 'messages were'} not included, to stay within the request limit.` : '',
        project.note
      ].filter(Boolean).join(' ')
    });
    const conversationList = await this.store.listConversations();
    // A reply to attached code that also replays project answers follows the
    // project permission; it is marked attachmentReply, not attachmentTurn,
    // so that 0.2.0 (which offers Include for every attachmentTurn reply)
    // cannot include it after a downgrade. Every reply is stored as in
    // progress until it ends (0.4.0).
    const replyDetails = attachment
      ? (project.grant ? { ...project.replyDetails, attachmentReply: true } : { attachmentTurn: true, contextPolicy: 'excluded' })
      : project.replyDetails;
    const assistantMessage = await this.store.addMessage('assistant', '', conversationId, { ...replyDetails, inProgress: true });
    if (attachment && this.attachment === attachment) {
      // The approval is used up now, as the request is sent, even if it is
      // then stopped or fails: the code may already have reached the server.
      const surfaces = this.#attachmentSurfaces();
      this.attachment = undefined;
      this.#postAttachment(null, surfaces);
    }
    const outcome = (value) => (metadata
      ? this.store.updateAttachmentOutcome(conversationId, userMessage.id, metadata.id, value).catch(() => undefined)
      : undefined);
    this.#postChat(conversationId, { type: 'messageAdded', message: userMessage });
    this.#postChat(conversationId, { type: 'messageAdded', message: assistantMessage });
    for (const target of this.#surfacesFor(conversationId)) {
      target.webview.postMessage({ type: 'conversationList', conversationList: target.follow ? conversationList : { ...conversationList, currentId: conversationId } });
    }
    this.#changed();

    let content = '';
    let saved = '';
    stream.messageId = assistantMessage.id;
    stream.content = '';
    // The reply so far is saved now and then, so a crash or quit keeps it
    // (marked interrupted, never re-sent).
    const interval = CHECKPOINT_MS + Math.floor(this.store.fileSize / 1_000_000) * 1_000;
    const checkpoint = setInterval(() => {
      if (content !== saved) {
        const text = content;
        this.store.checkpointReply(conversationId, assistantMessage.id, text).then((ok) => { if (ok) saved = text; }).catch(() => undefined);
      }
    }, interval);
    checkpoint.unref?.();
    try {
      if (project.grant) {
        stream.project = { keyId: project.grant.keyId, consentId: project.grant.consentId, revoked: false };
      }
      await this.openAIService.streamResponse({
        model: selectedModel,
        request,
        // The last checks, after the access token is obtained and just before
        // the request leaves: this window still owns the chat's reply, and
        // (M1-2) the consent gate.
        preflight: async () => {
          if (!(await lease.isHeld())) throw new ReplyBusyError();
          if (project.grant) {
            await this.#finalProjectCheck(project);
            project.released = true;
            // Tool results checked by the gate are now on their way.
            if (project.tools?.pending.length) project.tools.sent.push(...project.tools.pending.splice(0));
            // How many tool results went, for the reply's label (RC5).
            if (project.tools?.pendingOutputs) { project.tools.outputsSent = (project.tools.outputsSent || 0) + project.tools.pendingOutputs; project.tools.pendingOutputs = 0; }
          }
        },
        // 0.5.0: the model asked for project evidence. The host runs the
        // read-only tools within the turn's bounds; the gate checks the files
        // again before the continuation is sent (preflight above).
        onToolCalls: project.tools ? async (calls, current) => {
          const turn = project.tools.turn;
          if (!turn || controller.signal.aborted || project.withoutFiles) return undefined;
          if (project.askFirst && !project.grant) {
            // No grant yet (DEC-PLANCHAT-024): local reads only while project
            // context is on and the workspace trusted; the results are sent
            // only after Allow on the card.
            if (!userProjectContextEnabled() || vscode.workspace.isTrusted === false) {
              project.toolsCancelled = 'Project context is turned off, so nothing from the project was sent.';
              if (!controller.signal.aborted) controller.abort();
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
          }
          const outputs = await turn.runRound(calls, { signal: controller.signal });
          if (project.askFirst && !project.grant) {
            const decision = await this.#askToolConsent(project, conversationId, outputs, controller.signal);
            if (decision.choice === 'without') {
              // The model answers without the project: each call gets the
              // same fixed refusal, nothing read is sent.
              project.withoutFiles = true;
              // Proposals made from results the user chose not to share are dropped.
              if (project.draft) project.draft.discarded = true;
              const refusals = calls.map((call) => ({ callId: call.callId, output: JSON.stringify({ tool: String(call.name), ok: false, reason: 'not-shared', detail: 'The user chose not to share project files for this answer. Answer without them.' }) }));
              return buildToolContinuation(current, { calls, outputs: refusals, final: true });
            }
            if (decision.choice !== 'allow') {
              // Cancel, Stop, expiry or a change: nothing more is sent.
              project.toolsCancelled = decision.notice || true;
              if (!controller.signal.aborted) controller.abort();
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            const record = decision.record;
            const ask = project.askFirst;
            const grant = { grantKeyId: ask.keyId, consentId: record.consentId, policyVersion: record.policyVersion };
            project.grant = { ...grant, keyId: ask.keyId, grantKey: ask.grantKey, revision: record.revision, subject: ask.subject, root: ask.root, excerpts: [] };
            // From here the reply is project-derived (fail closed,
            // DEC-PLANCHAT-012), and Stop Sharing stops it.
            stream.project = { keyId: ask.keyId, consentId: record.consentId, revoked: false };
            await this.store.updateMessage(conversationId, assistantMessage.id, '', { provenance: 'project-derived', ...grant, contextPolicy: 'excluded' });
          }
          const id = (excerpt) => [excerpt.relPath, excerpt.startLine, excerpt.endLine].join('\u0000');
          const known = new Set(project.grant.excerpts.map(id));
          for (const source of turn.sentSources()) {
            if (known.has(id(source))) continue;
            known.add(id(source));
            project.grant.excerpts.push(source);
            project.tools.pending.push(source);
          }
          project.tools.reads += outputs.length;
          project.tools.pendingOutputs = outputs.length;
          const things = project.tools.reads === 1 ? 'thing' : 'things';
          this.#postChat(conversationId, { type: 'contextNote', text: `Kenlith looked up ${project.tools.reads} ${things} in ${project.tools.label || 'the project'} for this answer…` });
          return buildToolContinuation(current, { calls, outputs, final: turn.exhausted });
        } : undefined,
        onToolsUnsupported: () => {
          this.#postChat(conversationId, { type: 'contextNote', text: request.excerpts.length
            ? 'Project tools are not available with this ChatGPT plan route, so Kenlith answered with the excerpts it chose itself.'
            : 'Project tools are not available with this ChatGPT plan route, so this answer used no project files.' });
        },
        // The same content as plain fields, for test doubles of the service.
        messages: request.messages,
        instructions: request.instructions,
        signal: controller.signal,
        onDelta: (delta) => {
          content += delta;
          stream.content = content;
          this.#postChat(conversationId, {
            type: 'assistantDelta',
            messageId: assistantMessage.id,
            delta
          });
        }
      });
      clearInterval(checkpoint);
      if (project.tools) this.#postChat(conversationId, { type: 'contextNote', text: '' });
      await this.store.finishReply(conversationId, assistantMessage.id, content, this.#toolDetails(request, project));
      this.#postChat(conversationId, {
        type: 'messageUpdated',
        messageId: assistantMessage.id,
        content
      });
      // The reply completed: its proposals may go to review once the slot is released.
      if (project.draft) { project.draft.messageId = assistantMessage.id; project.draftCompleted = true; }
    } catch (error) {
      clearInterval(checkpoint);
      // A gate refusal means nothing was sent, even if a revoke seen by this
      // window's watcher also stopped the request at the same moment.
      if (controller.signal.aborted && stream.shutdown && !(error instanceof ProjectGateError)) {
        // Cut off by the window closing: what arrived is kept, marked
        // interrupted and excluded from follow-up context. Quickly, as the
        // editor is shutting down; the last checkpoint stays if this fails.
        if (content) {
          await this.store.checkpointReply(conversationId, assistantMessage.id, content).catch(() => undefined);
          await this.store.markInterrupted(conversationId, [assistantMessage.id]).catch(() => undefined);
        } else {
          await this.store.removeMessage(conversationId, assistantMessage.id).catch(() => undefined);
        }
        await outcome('stopped');
        return;
      }
      if (controller.signal.aborted && !(error instanceof ProjectGateError)) {
        if (stream.project?.revoked) {
          this.#postChat(conversationId, { type: 'contextNote', text: 'Project sharing was stopped during this reply. What was already sent cannot be recalled.' });
        } else if (project.toolsCancelled) {
          // A sharing card during the reply was not allowed (DEC-PLANCHAT-024).
          this.#postChat(conversationId, { type: 'contextNote', text: typeof project.toolsCancelled === 'string' ? project.toolsCancelled : `Nothing from ${project.tools?.label || 'the project'} was sent. Send your message again to share it or to answer without it.` });
        }
        if (project.grant && !project.released && userMessage.contextUsed) {
          // Stopped before the last check let it go: the question was not sent.
          await this.store.updateMessage(conversationId, userMessage.id, text, { contextUsed: [], projectNotSent: true }).catch(() => undefined);
        }
        await outcome('stopped');
        if (content) {
          await this.store.finishReply(conversationId, assistantMessage.id, content, { stopped: true, ...this.#toolDetails(request, project) });
        } else {
          await this.store.removeMessage(conversationId, assistantMessage.id);
          this.#postChat(conversationId, { type: 'messageRemoved', messageId: assistantMessage.id });
        }
      } else {
        await outcome('failed');
        // 0.8.0: OpenAI refused the explicit Thinking level (or a feature this
        // plan route lacks, which may be it). Its status, code and request ID
        // stay in the text; nothing is retried, and Default is offered. The
        // chat's saved choice changes only if the user picks Default.
        const rejected = !usageAction(error) && request.reasoning ? effortRejection(error, request.reasoning.effort, { tools: Boolean(request.tools) }) : undefined;
        const message = rejected ? `${rejected} ${safeError(error)}` : safeError(error);
        const display = content || `Request failed: ${message}`;
        // Project context that never passed the last check was not sent.
        const notSent = Boolean(project.grant && !project.released);
        await this.store.finishReply(conversationId, assistantMessage.id, display, { error: true, ...(notSent ? { contextUsed: [], projectNotSent: true } : this.#toolDetails(request, project)) });
        this.#postChat(conversationId, {
          type: 'messageUpdated',
          messageId: assistantMessage.id,
          content: display,
          error: true,
          projectNotSent: notSent,
          // A partial reply keeps its text; the reason is shown under it (not stored).
          errorText: content ? message : undefined,
          action: rejected ? 'effortDefault' : usageAction(error)
        });
        if (error && typeof error === 'object') {
          this.#shownInMessage.add(error);
        }
        if (notSent && userMessage.contextUsed) {
          // Nothing left this computer: the saved question records that.
          await this.store.updateMessage(conversationId, userMessage.id, text, { contextUsed: [], projectNotSent: true }).catch(() => undefined);
        }
        if (isUsageLimitError(error)) {
          await this.context.globalState.update(USAGE_PAUSE_KEY, { at: new Date().toISOString() });
          this.#changed();
        }
        throw error;
      }
    }
  }

  // The reply's contextUsed when project tools sent files (0.5.0): the
  // excerpts chosen locally plus every tool result the gate let go. Empty
  // when the tools sent nothing (the record stored with the reply stays).
  #toolDetails(request, project) {
    // 0.7.0: the runs of this reply (command text, class, status), shown under it.
    const runs = project.exec?.runs?.length ? { commands: project.exec.runs.map((r) => ({ ...r })) } : {};
    return { ...this.#toolDetailsBase(request, project), ...runs };
  }

  #toolDetailsBase(request, project) {
    const sent = project.tools?.sent || [];
    // The user chose Answer without project files on a card during the reply.
    if (project.withoutFiles && !sent.length) return { withoutProjectFiles: true };
    // What was shared for this reply, for its label (RC5): tool results the
    // gate let go, and whether earlier answers based on the project went with
    // it. Excerpts are in contextUsed.
    const shared = project.grant ? { projectShared: { toolResults: project.tools?.outputsSent || 0, earlierAnswers: Boolean(request.historyGate) } } : {};
    if (!sent.length) return shared;
    return { ...shared, contextUsed: contextUsedRecord([...(request.excerpts || []), ...sent]) };
  }

  async #runBusy(label, operation) {
    this.#postAll({ type: 'busy', busy: true, label });
    try {
      await operation();
    } catch (error) {
      this.#reportError(error);
    } finally {
      this.#postAll({ type: 'busy', busy: false });
    }
  }

  // One place per error: the surface's banner, or a notification when no
  // surface is visible (it used to be both).
  #reportError(error, surfaces) {
    const message = safeError(error);
    const targets = surfaces || [...this.#surfaces];
    this.#postTo(targets, { type: 'error', message, action: usageAction(error) });
    if (!targets.some((surface) => surface.host.visible)) {
      this.#notifyError(error).catch(() => undefined);
    }
  }

  // A notification for when no surface is visible. The usage-limit error
  // keeps Manage usage as its action there as well.
  async #notifyError(error) {
    const message = `Kenlith: ${safeError(error)}`;
    if (!usageAction(error)) {
      vscode.window.showErrorMessage(message);
      return;
    }
    const resume = usageAction(error) === 'usagePaused' ? ['Resume'] : [];
    const choice = await vscode.window.showErrorMessage(message, 'Manage usage', ...resume);
    if (choice === 'Manage usage') {
      await this.#openLink(USAGE_SETTINGS_URL);
    } else if (choice === 'Resume') {
      await this.context.globalState.update(USAGE_PAUSE_KEY, undefined);
      this.#changed();
    }
  }
}

module.exports = { ChatEngine, MAX_STREAMS, ProjectGateError, SECTION_LABELS, SELECTED_MODEL_KEY, contextSignature, plainText, usageAction };
