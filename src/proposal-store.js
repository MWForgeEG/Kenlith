'use strict';

// Kenlith 0.6.0: stored change proposals (docs/kenlith-0.6.0/ARCHITECTURE.md §3, §7).
//
// One file, proposals.json, in Kenlith's storage folder, shared by every
// window. Each write takes the same kind of lock as the chat history and
// writes atomically. State changes out of `review` are compare-and-set under
// that lock, so two clicks or two windows cannot both claim one Apply.
// Earlier Kenlith versions never read this file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withLock } = require('./lock');
const { readTextIfExists, writeFileAtomic } = require('./fsutil');
const { TERMINAL, normalizeProposal } = require('./proposal');

const FILE = 'proposals.json';
// Proposals kept per chat and in total (oldest terminal ones go first).
const MAX_PER_CHAT = 50;
const MAX_TOTAL = 500;
// An Apply claimed by a window that is gone is reported, never resumed.
// An Apply takes well under a second; 30 seconds leaves room for a slow disk.
const APPLYING_STALE_MS = 30_000;

class ProposalStore {
  constructor(directory, { windowId = crypto.randomUUID(), now = () => Date.now() } = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, FILE);
    this.lockPath = path.join(directory, 'proposals.lock');
    this.lockOptions = { timeoutMs: 10_000, staleMs: 15_000, timeoutMessage: 'Kenlith\'s change proposals are busy in another window. Nothing was changed; try again.' };
    this.windowId = windowId;
    this.now = now;
    this.queue = Promise.resolve();
    // The last state read or written: { proposals: [...] }.
    this.cache = { proposals: [] };
  }

  async load() {
    this.cache = await this.#read();
    return this.cache.proposals;
  }

  get(id) {
    return this.cache.proposals.find((proposal) => proposal.id === id);
  }

  forChat(chatId) {
    return this.cache.proposals.filter((proposal) => proposal.chatId === chatId);
  }

  async add(proposal) {
    return this.#transaction((state) => {
      state.proposals.push(structuredClone(proposal));
      prune(state);
      return structuredClone(proposal);
    });
  }

  // Moves a proposal from one of `from` to `to` only if it is still in one of
  // them. Returns the updated proposal, or undefined if it was not there.
  async transition(id, from, to, extra = {}) {
    const allowed = Array.isArray(from) ? from : [from];
    return this.#transaction((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal || !allowed.includes(proposal.state)) return undefined;
      if (TERMINAL.has(proposal.state)) return undefined;
      proposal.state = to;
      proposal.stateAt = new Date(this.now()).toISOString();
      Object.assign(proposal, structuredClone(extra));
      return structuredClone(proposal);
    });
  }

  // 0.7.0: an applied proposal's documents went back to their base (Undo) or
  // forward to the reviewed result again (Redo). Only applied <-> reverted;
  // neither state is ever actionable.
  async markOutcome(id, from, to) {
    if (!((from === 'applied' && to === 'reverted') || (from === 'reverted' && to === 'applied'))) return undefined;
    return this.#transaction((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (!proposal || proposal.state !== from) return undefined;
      proposal.state = to;
      proposal.stateAt = new Date(this.now()).toISOString();
      return structuredClone(proposal);
    });
  }

  // Applies left `applying` by a window that is gone become `failed`.
  // `active`: ids this window is applying right now (never touched). Any
  // other `applying` of this window is stale at once (its end state could not
  // be written); another window's after APPLYING_STALE_MS.
  async recoverInterrupted(active = new Set()) {
    const cutoff = this.now() - APPLYING_STALE_MS;
    // Writes only when something is to be recovered (no write, no refresh loop).
    this.cache = await this.#read();
    if (!this.cache.proposals.some((proposal) => proposal.state === 'applying' && !active.has(proposal.id))) return [];
    return this.#transaction((state) => {
      const changed = [];
      for (const proposal of state.proposals) {
        if (proposal.state !== 'applying') continue;
        const at = Date.parse(proposal.apply?.at || proposal.stateAt || 0);
        if (active.has(proposal.id)) continue;
        if (proposal.apply?.windowId !== this.windowId && !(at < cutoff)) continue;
        proposal.state = 'failed';
        proposal.stateAt = new Date(this.now()).toISOString();
        proposal.reason = { code: 'interrupted', detail: 'Kenlith closed while applying this change. Check the files before you save them.' };
        changed.push(proposal.id);
      }
      return changed;
    });
  }

  // Calls `listener` after proposals.json changed on disk (any window).
  watch(listener) {
    let timer;
    let watcher;
    let last;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const stat = await fs.promises.stat(this.filePath).catch(() => undefined);
          const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'none';
          if (stamp === last) return;
          const first = last === undefined;
          last = stamp;
          this.cache = await this.#read();
          if (!first) listener();
        } catch { /* a refresh never breaks the window */ }
      }, 150);
      timer.unref?.();
    };
    soon();
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      watcher = fs.watch(this.directory, (event, name) => { if (!name || name === FILE) soon(); });
      watcher.on?.('error', () => undefined);
      watcher.unref?.();
    } catch {
      watcher = undefined;
    }
    const poll = setInterval(soon, 5_000);
    poll.unref?.();
    return { dispose: () => { clearTimeout(timer); clearInterval(poll); watcher?.close(); } };
  }

  // `strict` (inside a transaction): a read error other than a missing file
  // stops the change, so an unreadable moment never writes an empty list.
  async #read({ strict = false } = {}) {
    let text;
    try {
      text = await readTextIfExists(this.filePath);
    } catch (error) {
      if (strict) throw new Error(`Kenlith could not read its change proposals (${error?.code || 'error'}). Nothing was changed; try again.`);
      return this.cache;
    }
    if (!text) return { proposals: [] };
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      // Unreadable: nothing in it is actionable. Kept aside, never overwritten.
      await fs.promises.rename(this.filePath, `${this.filePath}.unreadable-${Date.now()}`).catch(() => undefined);
      return { proposals: [] };
    }
    const all = Array.isArray(value?.proposals) ? value.proposals : [];
    const proposals = [];
    // Entries this version cannot use are carried along unchanged, never dropped.
    const unrecognized = Array.isArray(value?.unrecognized) ? value.unrecognized.slice() : [];
    for (const entry of all) {
      const normal = normalizeProposal(entry);
      if (normal) proposals.push(normal);
      else unrecognized.push(entry);
    }
    return { version: 1, proposals, ...(unrecognized.length ? { unrecognized } : {}) };
  }

  #transaction(mutate) {
    const run = this.queue.then(async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      return withLock(this.lockPath, this.lockOptions, async (lock) => {
        const state = await this.#read({ strict: true });
        const result = mutate(state);
        if (!(await lock.isHeld())) throw new Error('Kenlith\'s change proposals were taken over by another window. Nothing was changed; try again.');
        await writeFileAtomic(this.filePath, JSON.stringify({ version: 1, proposals: state.proposals, ...(state.unrecognized ? { unrecognized: state.unrecognized } : {}) }, null, 2));
        this.cache = state;
        return result;
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function prune(state) {
  const byChat = new Map();
  for (const proposal of state.proposals) byChat.set(proposal.chatId, (byChat.get(proposal.chatId) || 0) + 1);
  const drop = new Set();
  for (const proposal of state.proposals) {
    if (state.proposals.length - drop.size <= MAX_TOTAL && byChat.get(proposal.chatId) <= MAX_PER_CHAT) continue;
    if (!TERMINAL.has(proposal.state)) continue;
    drop.add(proposal);
    byChat.set(proposal.chatId, byChat.get(proposal.chatId) - 1);
  }
  if (drop.size) state.proposals = state.proposals.filter((proposal) => !drop.has(proposal));
}

module.exports = { APPLYING_STALE_MS, ProposalStore };
