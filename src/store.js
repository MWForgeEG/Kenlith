'use strict';

// Local conversation history, shared by every editor window of a profile.
//
// Each window runs in its own process, so every change is a transaction:
// take the cross-process lock, re-read conversations.json from disk, apply the
// one change to that latest state, replace the file atomically, release.
// A window never writes its cached copy back, so changes made by other windows
// are kept and removed messages are not brought back.
//
// The selected conversation is per window (in memory); the file's currentId
// only records the last chat opened, for the next start.
//
// Contexts (Phase 3.1 stage 2, architecture §3): once a window's context is
// set (setContext), the store lists, opens, starts on and sends into only the
// chats of that context; others can be read through getConversation and
// changed only by an explicit moveConversation. Without a context the store
// behaves as before (all chats), which older tools and tests rely on.

const { classify, mayReplay } = require('./provenance');
const { isEffort } = require('./reasoning');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withLock } = require('./lock');
const { readTextIfExists, writeFileAtomic } = require('./fsutil');

class CorruptHistoryError extends Error {}
class ContextError extends Error {}

// The project identity scheme written into new project tags (architecture
// §3.3 amendment, R-27 and R-29). A project tag without it was written by the
// earlier scheme, whose key two different folders could share; such a chat is
// never this project's on its key alone and is recovered only by an explicit
// Relink.
const IDENTITY_SCHEME = 2;

class ConversationStore {
  constructor(context) {
    this.context = context;
    this.directory = context.globalStorageUri.fsPath;
    this.filePath = path.join(this.directory, 'conversations.json');
    this.lockPath = path.join(this.directory, 'conversations.lock');
    this.lockOptions = {
      timeoutMs: 10_000,
      staleMs: 15_000,
      timeoutMessage: 'Chat history is busy in another window. Your change was not saved; try again.'
    };
    this.state = undefined;
    this.stamp = undefined;
    this.currentId = undefined;
    this.queue = Promise.resolve();
    this.windowContext = undefined;
    // Called with the kept file's name when an unreadable history is set
    // aside (the view tells the user; WP-03 T03-06).
    this.onRecovery = undefined;
  }

  // The window's context from src/project.js; new chats get its tag.
  setContext(context) {
    this.windowContext = context;
  }

  sectionOf(conversation) {
    return sectionOf(conversation, this.windowContext);
  }

  isAllowed(conversation) {
    return isAllowed(this.sectionOf(conversation), this.windowContext);
  }

  async initialize() {
    if (this.state) {
      return;
    }
    await fs.promises.mkdir(this.directory, { recursive: true });
    if (!(await this.#syncFromDisk())) {
      // Missing (or quarantined) file: create it under the lock.
      await this.#transaction(() => undefined);
    }
    this.currentId = this.state.currentId;
    if (!this.windowContext) {
      // Like earlier versions, the file always holds at least one chat. With a
      // context, the first chat is made (and tagged) when the window needs one.
      await this.#currentConversation();
    }
  }

  async getCurrent() {
    await this.initialize();
    await this.#syncFromDisk();
    return structuredClone(await this.#currentConversation());
  }

  async listConversations() {
    await this.initialize();
    await this.#syncFromDisk();
    const current = await this.#currentConversation();
    return {
      currentId: current.id,
      items: this.state.conversations
        .filter((conversation) => this.isAllowed(conversation))
        .map((conversation) => itemOf(conversation, this.sectionOf(conversation)))
    };
  }

  // Every chat with its section, for the History list. Opening one of
  // another context is read-only (getConversation) until it is moved.
  async listAll() {
    await this.initialize();
    await this.#syncFromDisk();
    return this.state.conversations.map((conversation) => ({
      ...itemOf(conversation, this.sectionOf(conversation)),
      allowed: this.isAllowed(conversation)
    }));
  }

  async getConversation(id) {
    await this.initialize();
    await this.#syncFromDisk();
    const conversation = findConversation(this.state, id);
    return { ...structuredClone(conversation), section: this.sectionOf(conversation) };
  }

  async selectConversation(id) {
    await this.initialize();
    const conversation = await this.#transaction((state) => {
      const found = state.conversations.find((candidate) => candidate.id === id);
      if (!found) {
        throw new Error('That local conversation no longer exists.');
      }
      if (!this.isAllowed(found)) {
        throw new ContextError('That chat belongs to another project or context. Open it from All Chats to read it, or move it here first.');
      }
      state.currentId = id;
      return found;
    });
    this.currentId = id;
    return structuredClone(conversation);
  }

  async newConversation() {
    await this.initialize();
    const leavingId = this.currentId;
    const conversation = await this.#transaction((state) => {
      // Already on an empty chat: reuse it. Nothing is deleted, so a chat that
      // another window has open can never disappear underneath it.
      const leaving = state.conversations.find((candidate) => candidate.id === leavingId);
      if (leaving && !leaving.messages.length && this.isAllowed(leaving) && sameTag(leaving.context, this.#tag())) {
        state.currentId = leaving.id;
        return leaving;
      }
      const created = createConversation(this.#tag());
      state.conversations.unshift(created);
      state.currentId = created.id;
      return created;
    });
    this.currentId = conversation.id;
    return structuredClone(conversation);
  }

  // `details` (stage 3, §6, §5.1a): `attachments` (metadata only) on a user
  // message; `attachmentTurn` and `contextPolicy` on the reply to it.
  // M1-3 (src/provenance.js): `project` on a turn that sent project
  // excerpts: { grantKeyId, consentId, consentRevision, policyVersion,
  // contextUsed } on the user message (metadata only, never excerpt text),
  // and { grantKeyId, consentId, policyVersion } on the reply, which is also
  // marked excluded so that 0.2.0 never re-sends it after a downgrade.
  async addMessage(role, content, conversationId, details = {}) {
    await this.initialize();
    const targetId = conversationId || (await this.#currentConversation()).id;
    return this.#transaction((state) => {
      const conversation = findConversation(state, targetId);
      // A window never writes the user's text into another context's chat.
      if (role === 'user' && !this.isAllowed(conversation)) {
        throw new ContextError('That chat belongs to another project or context; the message was not sent.');
      }
      const message = {
        id: crypto.randomUUID(),
        role,
        content: String(content),
        createdAt: new Date().toISOString()
      };
      if (role === 'user' && Array.isArray(details.attachments) && details.attachments.length) {
        message.attachments = structuredClone(details.attachments);
      }
      if (role === 'assistant' && details.attachmentTurn) {
        message.attachmentTurn = true;
        message.contextPolicy = details.contextPolicy === 'included' ? 'included' : 'excluded';
      }
      const project = details.project;
      if (project && typeof project === 'object') {
        const grant = { grantKeyId: String(project.grantKeyId), consentId: String(project.consentId), policyVersion: Number(project.policyVersion) };
        if (role === 'user') {
          Object.assign(message, { provenance: 'user', ...grant, consentRevision: Number(project.consentRevision) });
          message.contextUsed = (Array.isArray(project.contextUsed) ? project.contextUsed : []).map((item) => ({
            relPath: String(item.relPath),
            range: [Number(item.range?.[0]), Number(item.range?.[1])],
            sha256: String(item.sha256)
          }));
        } else if (role === 'assistant') {
          Object.assign(message, { provenance: 'project-derived', ...grant, contextPolicy: 'excluded' });
          if (Array.isArray(project.contextUsed)) {
            message.contextUsed = project.contextUsed.map((item) => ({ relPath: String(item.relPath), range: [Number(item.range?.[0]), Number(item.range?.[1])], sha256: String(item.sha256) }));
          }
        }
      }
      // The user chose Send without project files (M1-4): shown on the reply.
      if (role === 'assistant' && details.withoutProjectFiles) {
        message.withoutProjectFiles = true;
      }
      // A reply to attached code that is project-derived (see src/engine.js).
      if (role === 'assistant' && details.attachmentReply && message.provenance === 'project-derived') {
        message.attachmentReply = true;
      }
      // 0.4.0: a reply being written. It is marked excluded from follow-up
      // context until it completes (finishReply), so a reply cut off by a
      // crash or quit is never re-sent, by this version or by 0.3.0 and 0.2.0,
      // which honour contextPolicy.
      if (role === 'assistant' && details.inProgress) {
        message.inProgress = true;
        if (!message.contextPolicy) message.contextPolicy = 'excluded';
      }
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      if (role === 'user' && conversation.title === 'New chat') {
        conversation.title = titleFrom(content);
      }
      return structuredClone(message);
    });
  }

  async updateMessage(conversationId, messageId, content, details = {}) {
    await this.initialize();
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      const message = conversation?.messages.find((candidate) => candidate.id === messageId);
      if (!message) {
        // Removed in the meantime: do not recreate it.
        return;
      }
      message.content = String(content);
      Object.assign(message, details);
      conversation.updatedAt = new Date().toISOString();
    });
  }

  // 0.4.0: a reply ended (completed, stopped or failed). Its final text and
  // flags are written and the in-progress (or interrupted) mark is removed.
  // The exclusion set for that state is removed only from a plain reply;
  // replies to attached code and replies that used project files keep their
  // own policy.
  //
  // While a reply is unfinished its text is kept in `partialContent`, and
  // `content` stays empty: every earlier version leaves an empty reply out
  // of the history it sends, whatever kind of reply it is (0.3.0 checks only
  // the grant for replies that used project files, not contextPolicy).
  async finishReply(conversationId, messageId, content, details = {}) {
    await this.initialize();
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      const message = conversation?.messages.find((candidate) => candidate.id === messageId);
      if (!message) return;
      const wasInProgress = Boolean(message.inProgress || message.interrupted);
      message.content = String(content);
      Object.assign(message, details);
      delete message.inProgress;
      delete message.interrupted;
      delete message.partialContent;
      if (wasInProgress && message.contextPolicy === 'excluded' && !message.attachmentTurn && message.provenance !== 'project-derived') {
        delete message.contextPolicy;
      }
      conversation.updatedAt = new Date().toISOString();
    });
  }

  // 0.4.0: the reply text so far, saved while it streams. Waits briefly for
  // the lock and gives up instead of delaying other changes; returns whether
  // it was written. Only a reply still in progress is changed.
  async checkpointReply(conversationId, messageId, content) {
    await this.initialize();
    try {
      return await this.#transaction((state) => {
        const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
        const message = conversation?.messages.find((candidate) => candidate.id === messageId);
        if (!message?.inProgress) return false;
        message.partialContent = String(content);
        return true;
      }, { timeoutMs: 1_000 });
    } catch {
      return false;
    }
  }

  // 0.4.0: replies left in progress by a window that is gone (no live reply
  // lease): marked interrupted. They stay excluded from follow-up context;
  // their text stays in `partialContent` (shown, never sent).
  async markInterrupted(conversationId, messageIds) {
    await this.initialize();
    const ids = new Set(messageIds);
    if (!ids.size) return;
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      for (const message of conversation?.messages || []) {
        if (ids.has(message.id) && message.inProgress) {
          delete message.inProgress;
          message.interrupted = true;
          message.contextPolicy = 'excluded';
        }
      }
    });
  }

  // 0.4.0: per-chat model (the model the chat last used or was set to).
  async setConversationModel(conversationId, model) {
    if (typeof model !== 'string' || !model || model.length > 200) return;
    await this.initialize();
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      if (conversation && conversation.model !== model) conversation.model = model;
    });
  }

  // 0.8.0: the chat's thinking effort, set by the user in the composer
  // (DEC-PLANCHAT-040). An additive field: a chat without it follows
  // kenlith.reasoning.defaultEffort. Written only when the user chooses.
  async setConversationEffort(conversationId, effort) {
    if (!isEffort(effort)) return;
    await this.initialize();
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      if (conversation && conversation.reasoningEffort !== effort) conversation.reasoningEffort = effort;
    });
  }

  // 0.4.0: a chat's title, set by the user. Context is never changed here.
  async renameConversation(conversationId, title) {
    const value = cleanName(title, 120);
    if (!value) throw new Error('Enter a title.');
    await this.initialize();
    return this.#transaction((state) => {
      const conversation = findConversation(state, conversationId);
      conversation.title = value;
      conversation.titleSetByUser = true;
      return structuredClone(conversation);
    });
  }

  // ---------- user groups (0.4.0) ----------
  // Groups are the user's own folders for chats. They are separate from a
  // chat's context (project, General): a chat keeps its context, and with it
  // where it can be opened and sent from, whatever group it is in.

  async listGroups() {
    await this.initialize();
    await this.#syncFromDisk();
    return structuredClone(validGroups(this.state.groups));
  }

  async createGroup(name) {
    const value = cleanName(name, 60);
    if (!value) throw new Error('Enter a group name.');
    await this.initialize();
    return this.#transaction((state) => {
      const groups = validGroups(state.groups);
      if (groups.length >= MAX_GROUPS) throw new Error(`You can have up to ${MAX_GROUPS} groups.`);
      const group = { id: crypto.randomUUID(), name: value, createdAt: new Date().toISOString() };
      state.groups = [...groups, group];
      return structuredClone(group);
    });
  }

  async renameGroup(groupId, name) {
    const value = cleanName(name, 60);
    if (!value) throw new Error('Enter a group name.');
    await this.initialize();
    return this.#transaction((state) => {
      const groups = validGroups(state.groups);
      const group = groups.find((candidate) => candidate.id === groupId);
      if (!group) throw new Error('That group no longer exists.');
      group.name = value;
      state.groups = groups;
      return structuredClone(group);
    });
  }

  // Removes the group only: its chats stay, without a group.
  async removeGroup(groupId) {
    await this.initialize();
    return this.#transaction((state) => {
      state.groups = validGroups(state.groups).filter((candidate) => candidate.id !== groupId);
      let released = 0;
      for (const conversation of state.conversations) {
        if (conversation.groupId === groupId) {
          delete conversation.groupId;
          released += 1;
        }
      }
      return released;
    });
  }

  // `groupId` undefined or null takes the chat out of its group.
  async setConversationGroup(conversationId, groupId) {
    await this.initialize();
    return this.#transaction((state) => {
      const conversation = findConversation(state, conversationId);
      if (groupId) {
        if (!validGroups(state.groups).some((candidate) => candidate.id === groupId)) {
          throw new Error('That group no longer exists.');
        }
        conversation.groupId = groupId;
      } else {
        delete conversation.groupId;
      }
      return structuredClone(conversation);
    });
  }

  // 0.4.0: calls `listener()` when another window (or this one) changes the
  // history file. Uses the folder watch that src/consent.js uses, with a
  // poll as a fallback. Returns a disposable.
  watch(listener) {
    let timer;
    let watcher;
    let last = this.stamp;
    const check = async () => {
      try {
        const stat = await fs.promises.stat(this.filePath);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        if (stamp === last) return;
        last = stamp;
        listener();
      } catch {
        // Missing file: nothing to report.
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 150);
      timer.unref?.();
    };
    try {
      watcher = fs.watch(this.directory, (event, name) => {
        if (!name || name === 'conversations.json') soon();
      });
      watcher.on?.('error', () => undefined);
      // The watch never keeps the extension host (or a test) alive by itself.
      watcher.unref?.();
    } catch {
      watcher = undefined;
    }
    const poll = setInterval(check, 2_000);
    poll.unref?.();
    return { dispose: () => { clearTimeout(timer); clearInterval(poll); watcher?.close(); } };
  }

  // Size of the history file at the last read or write, for the checkpoint interval.
  get fileSize() {
    return Number(String(this.stamp || '').split(':')[1]) || 0;
  }

  async removeMessage(conversationId, messageId) {
    await this.initialize();
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      if (!conversation) {
        return;
      }
      conversation.messages = conversation.messages.filter((message) => message.id !== messageId);
      conversation.updatedAt = new Date().toISOString();
    });
  }

  // Include in follow-ups / Stop including, for one reply to attached code
  // (§5.1a). Only in a chat of this window's context; one transaction.
  async setContextPolicy(conversationId, messageId, policy) {
    if (policy !== 'included' && policy !== 'excluded') {
      throw new Error('Unknown context setting.');
    }
    await this.initialize();
    return this.#transaction((state) => {
      const conversation = findConversation(state, conversationId);
      if (!this.isAllowed(conversation)) {
        throw new ContextError('That chat belongs to another project or context; nothing was changed.');
      }
      const message = conversation.messages.find((candidate) => candidate.id === messageId);
      if (!message || message.role !== 'assistant' || !message.attachmentTurn) {
        throw new Error('That reply is no longer in this chat, or it is not a reply to attached code.');
      }
      // 0.4.0: an unfinished or interrupted reply is never included.
      if (policy === 'included' && (message.inProgress || message.interrupted)) {
        throw new Error('This reply did not finish, so it cannot be sent with follow-up messages.');
      }
      // An answer that may use project files follows the project permission
      // (src/provenance.js), never Include in follow-ups.
      if (message.provenance === 'project-derived') {
        throw new Error('This answer may use project files, so it follows the project\'s sharing permission and cannot be included separately.');
      }
      message.contextPolicy = policy;
      return structuredClone(message);
    });
  }

  // Records how the request carrying an attachment ended: sent, stopped or failed.
  async updateAttachmentOutcome(conversationId, messageId, attachmentId, outcome) {
    await this.initialize();
    await this.#transaction((state) => {
      const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
      const message = conversation?.messages.find((candidate) => candidate.id === messageId);
      const attachment = message?.attachments?.find?.((candidate) => candidate.id === attachmentId);
      if (attachment) {
        attachment.outcome = outcome;
      }
    });
  }

  // Changes a chat's context: `tag` from src/project.js tagFor(), or undefined
  // to make it untagged (earlier) again. The only way a chat changes context.
  async moveConversation(id, tag) {
    await this.initialize();
    const moved = await this.#transaction((state) => {
      const conversation = findConversation(state, id);
      if (tag) {
        conversation.context = structuredClone(tag);
      } else {
        delete conversation.context;
      }
      return conversation;
    });
    return structuredClone(moved);
  }

  // `activeGrant` ({ grantKeyId, consentId, policyVersion }): the grant
  // active for this request, if any. Which messages may be re-sent is decided
  // by src/provenance.js mayReplay().
  async contextMessages(conversationId, limit = 30, maxCharacters = 80_000, { activeGrant } = {}) {
    await this.initialize();
    await this.#syncFromDisk();
    const conversation = conversationId
      ? findConversation(this.state, conversationId)
      : await this.#currentConversation();
    // Checked again here, so a chat moved by another window after the message
    // was added cannot reach this window's request.
    if (!this.isAllowed(conversation)) {
      throw new ContextError('That chat belongs to another project or context; nothing was sent.');
    }
    // Replies to attached code are left out unless the user included them (§5.1a).
    const messages = conversation.messages
      .filter((message) => ['user', 'assistant'].includes(message.role) && !message.error && message.content && mayReplay(message, activeGrant))
      .slice(-Math.max(1, limit));

    const selected = [];
    let characters = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      // DEC-PLANCHAT-017: a reply the user stopped keeps its stopped status
      // when it goes into a later request.
      const content = message.role === 'assistant' && message.stopped ? `${message.content}${STOPPED_NOTE}` : message.content;
      const length = content.length;
      if (characters + length > maxCharacters) {
        break;
      }
      // projectDerived tells the caller the project gate must run; the
      // request builder sends only role and content.
      selected.unshift(classify(message) === 'project-derived' ? { role: message.role, content, projectDerived: true } : { role: message.role, content });
      characters += length;
    }
    return selected;
  }

  #tag() {
    const context = this.windowContext;
    if (!context) return undefined;
    return context.kind === 'project'
      ? { kind: 'project', key: context.key, keyId: context.keyId, label: context.label, scheme: IDENTITY_SCHEME }
      : { kind: 'general' };
  }

  // This window's conversation: this window's choice, else the file's last
  // chat if it belongs here, else the most recently updated chat of this
  // context; one is created (and tagged) only when the context has none.
  async #currentConversation() {
    const conversations = this.state.conversations;
    const allowed = conversations.filter((candidate) => this.isAllowed(candidate));
    const newest = [...allowed].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    const found = allowed.find((candidate) => candidate.id === this.currentId)
      || allowed.find((candidate) => candidate.id === this.state.currentId)
      || (this.windowContext ? newest : conversations[0]);
    if (found) {
      this.currentId = found.id;
      return found;
    }
    const created = await this.#transaction((state) => {
      const existing = state.conversations.find((candidate) => this.isAllowed(candidate));
      if (existing) {
        return existing;
      }
      const conversation = createConversation(this.#tag());
      state.conversations.push(conversation);
      state.currentId = conversation.id;
      return conversation;
    });
    this.currentId = created.id;
    return created;
  }

  // Reloads the file if another window changed it. Returns false when there
  // is no usable file. Atomic replacement means an unlocked read is complete.
  async #syncFromDisk() {
    let stat;
    try {
      stat = await fs.promises.stat(this.filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return Boolean(this.state);
      }
      throw error;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (this.state && stamp === this.stamp) {
      return true;
    }
    try {
      const latest = await this.#readFromDisk();
      if (latest) {
        this.state = latest;
        this.stamp = stamp;
        return true;
      }
      return Boolean(this.state);
    } catch (error) {
      if (error instanceof CorruptHistoryError) {
        // Re-check under the lock; a still-unreadable file is moved aside there.
        await this.#transaction(() => undefined);
        return true;
      }
      throw error;
    }
  }

  async #readFromDisk() {
    const text = await readTextIfExists(this.filePath);
    if (text === undefined) {
      return undefined;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new CorruptHistoryError('conversations.json could not be parsed.');
    }
    // Valid JSON of another shape (WP-03 T03-06) is kept aside like
    // unparseable text: treating it as empty would overwrite it on the next save.
    if (!value || typeof value !== 'object' || Array.isArray(value) || ('conversations' in value && !Array.isArray(value.conversations))) {
      throw new CorruptHistoryError('conversations.json does not have the expected structure.');
    }
    return normalizeState(value);
  }

  // Serializes changes within this window, then across windows with the lock.
  // `lockOptions` replaces the default wait (checkpoints wait briefly).
  #transaction(mutate, lockOptions) {
    const run = this.queue.then(() => this.#lockedTransaction(mutate, lockOptions));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async #lockedTransaction(mutate, lockOptions) {
    await fs.promises.mkdir(this.directory, { recursive: true });
    return withLock(this.lockPath, { ...this.lockOptions, ...lockOptions }, async (lock) => {
      let state;
      try {
        state = (await this.#readFromDisk()) || normalizeState({});
      } catch (error) {
        if (!(error instanceof CorruptHistoryError)) {
          throw error;
        }
        state = await this.#quarantineCorruptFile();
      }

      const result = mutate(state);
      if (!(await lock.isHeld())) {
        throw new Error('Chat history lock was lost to another window. Your change was not saved; try again.');
      }
      await writeFileAtomic(this.filePath, JSON.stringify(state, null, 2));
      const stat = await fs.promises.stat(this.filePath);
      this.state = state;
      this.stamp = `${stat.mtimeMs}:${stat.size}`;
      return result;
    });
  }

  // An unreadable history file is kept under a new name, never overwritten.
  async #quarantineCorruptFile() {
    const kept = path.join(this.directory, `conversations.corrupt-${Date.now()}.json`);
    await fs.promises.rename(this.filePath, kept);
    console.warn(`Kenlith could not read its history file. It was kept as ${path.basename(kept)} and a new history was started.`);
    try {
      this.onRecovery?.(path.basename(kept));
    } catch {
      // The notice is best effort; the kept file is what matters.
    }
    return normalizeState({});
  }
}

function findConversation(state, id) {
  const conversation = state.conversations.find((candidate) => candidate.id === id);
  if (!conversation) {
    throw new Error('That local conversation no longer exists.');
  }
  return conversation;
}

// Where a chat sits relative to a window's context:
//   'this'          tagged with the window's project (same key and keyId)
//   'general'       tagged General
//   'earlier'       no tag: made before 3.1 (legacy)
//   'other-project' another project, made with the current identity key
//   'earlier-key'   a project tag made with an earlier identity key, or by the
//                   earlier identity scheme for this folder (Relink to use)
//   'unknown'       a tag this version does not understand (kept, read-only)
function sectionOf(conversation, windowContext) {
  const tag = conversation?.context;
  if (!tag || typeof tag !== 'object') return 'earlier';
  if (tag.kind === 'general') return 'general';
  if (tag.kind !== 'project' || typeof tag.key !== 'string') return 'unknown';
  // A scheme this version does not know (a later version's, or damaged).
  if (tag.scheme !== undefined && tag.scheme !== IDENTITY_SCHEME) return 'unknown';
  if (windowContext?.keyId && tag.keyId !== windowContext.keyId) return 'earlier-key';
  if (tag.scheme === undefined) {
    // Earlier scheme: different folders could produce this key (R-27, R-29),
    // so it never proves the chat is this folder's. The folder's own earlier
    // key offers the chat for an explicit Relink; it is never opened or sent
    // automatically.
    return windowContext?.kind === 'project' && windowContext.legacyKey && tag.key === windowContext.legacyKey ? 'earlier-key' : 'other-project';
  }
  if (windowContext?.kind === 'project' && tag.key === windowContext.key) return 'this';
  return 'other-project';
}

// Which sections a window may list, open and send into (D1: earlier chats are
// continuable in General, read-only from project windows).
function isAllowed(section, windowContext) {
  if (!windowContext) return true;
  if (windowContext.kind === 'project') return section === 'this';
  return section === 'general' || section === 'earlier';
}

function sameTag(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function itemOf(conversation, section) {
  const replies = conversation.messages.filter((message) => message.role === 'assistant');
  const last = replies.at(-1);
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    section,
    label: conversation.context?.kind === 'project' ? conversation.context.label : undefined,
    // 0.4.0 metadata for the Chats list (never message text).
    groupId: typeof conversation.groupId === 'string' ? conversation.groupId : undefined,
    model: typeof conversation.model === 'string' ? conversation.model : undefined,
    messageCount: conversation.messages.length,
    inProgress: replies.some((message) => message.inProgress),
    lastFailed: Boolean(last && (last.error || last.interrupted))
  };
}

const MAX_GROUPS = 100;

// Added after a stopped reply's text when it is sent as history (DEC-PLANCHAT-017).
const STOPPED_NOTE = '\n\n[Note from Kenlith: the user stopped this reply before it finished; only the text above was received.]';

// A user's name for a group or chat: one line, trimmed, bounded, without
// direction-control characters that could make one name look like another.
function cleanName(value, max) {
  const text = Array.from(String(value ?? '').replace(/[\u0000-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim());
  return text.slice(0, max).join('');
}

function validGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter((group) => group && typeof group.id === 'string' && typeof group.name === 'string' && group.name.trim())
    .slice(0, MAX_GROUPS);
}

function normalizeState(value) {
  const all = Array.isArray(value?.conversations) ? value.conversations : [];
  const conversations = all.filter(isConversation);
  const state = {
    ...value,
    version: 1,
    conversations,
    currentId: conversations.some((item) => item.id === value?.currentId)
      ? value.currentId
      : conversations[0]?.id
  };
  // Entries this version cannot use are carried along unchanged, not dropped.
  const unrecognized = [...(Array.isArray(value?.unrecognized) ? value.unrecognized : []), ...all.filter((item) => !isConversation(item))];
  if (unrecognized.length) {
    state.unrecognized = unrecognized;
  } else {
    delete state.unrecognized;
  }
  return state;
}

function isConversation(value) {
  return Boolean(value
    && typeof value.id === 'string'
    && Array.isArray(value.messages));
}

function createConversation(tag) {
  const now = new Date().toISOString();
  const conversation = {
    id: crypto.randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  if (tag) {
    conversation.context = structuredClone(tag);
  }
  return conversation;
}

function titleFrom(content) {
  // Count code points so an emoji or other astral character is never cut in half.
  const characters = Array.from(String(content).replace(/\s+/g, ' ').trim());
  return characters.length > 48
    ? `${characters.slice(0, 47).join('')}…`
    : characters.join('') || 'New chat';
}

module.exports = { ContextError, ConversationStore, IDENTITY_SCHEME, MAX_GROUPS, STOPPED_NOTE, cleanName, createConversation, isAllowed, normalizeState, sectionOf, titleFrom };
