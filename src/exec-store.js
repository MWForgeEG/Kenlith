'use strict';

// Kenlith 0.7.0: the record of every run (docs/kenlith-0.7.0/ARCHITECTURE.md §10).
//
// executions.json in Kenlith's storage folder, shared by every window, with the
// same lock and atomic write as proposals.json. Records hold the resolved
// execution, its class and effects, times, exit code, termination reason and
// the sanitized, bounded output (never the environment). A state change out of
// `awaiting-approval` is compare-and-set, so one approval runs once. A run
// recorded as `running` or waiting longer than it possibly could (its timeout,
// or the approval card's limit, plus a minute) belongs to a window that is
// gone: it becomes `interrupted` or `void`, never resumed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withLock } = require('./lock');
const { readTextIfExists, writeFileAtomic } = require('./fsutil');

const FILE = 'executions.json';
const MAX_RECORDS = 500;
const APPROVAL_CARD_MS = 10 * 60_000;
const GRACE_MS = 60_000;
const TERMINAL = new Set(['succeeded', 'nonzero', 'timed-out', 'cancelled', 'launch-failed', 'blocked', 'declined', 'void', 'interrupted']);
const STATES = new Set(['awaiting-approval', 'running', 'awaiting-output-sharing', ...TERMINAL]);

class ExecutionStore {
  constructor(directory, { windowId = crypto.randomUUID(), now = () => Date.now() } = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, FILE);
    this.lockPath = path.join(directory, 'executions.lock');
    this.lockOptions = { timeoutMs: 10_000, staleMs: 15_000, timeoutMessage: 'Kenlith\'s command records are busy in another window. Nothing was run; try again.' };
    this.windowId = windowId;
    this.now = now;
    this.queue = Promise.resolve();
    this.cache = { executions: [] };
  }

  async load() { this.cache = await this.#read(); return this.cache.executions; }
  get(id) { return this.cache.executions.find((e) => e.id === id); }
  forChat(chatId) { return this.cache.executions.filter((e) => e.chatId === chatId); }

  async add(record) {
    return this.#transaction((state) => {
      const full = { ...structuredClone(record), id: record.id || crypto.randomUUID(), windowId: this.windowId, createdAt: new Date(this.now()).toISOString() };
      state.executions.push(full);
      if (state.executions.length > MAX_RECORDS) state.executions = state.executions.filter((e, i) => i >= state.executions.length - MAX_RECORDS || !TERMINAL.has(e.state));
      return structuredClone(full);
    });
  }

  // Compare-and-set: moves a record from one of `from` to `to`; undefined if it is no longer there.
  async transition(id, from, to, extra = {}) {
    const allowed = Array.isArray(from) ? from : [from];
    return this.#transaction((state) => {
      const record = state.executions.find((e) => e.id === id);
      if (!record || !allowed.includes(record.state) || TERMINAL.has(record.state)) return undefined;
      record.state = to;
      record.stateAt = new Date(this.now()).toISOString();
      Object.assign(record, structuredClone(extra));
      return structuredClone(record);
    });
  }

  // Adds facts to a record without changing its state (the output-sharing
  // decision on a finished run). `state` and `id` cannot be set this way.
  async note(id, fields) {
    return this.#transaction((state) => {
      const record = state.executions.find((e) => e.id === id);
      if (!record) return undefined;
      const { state: _s, id: _i, ...rest } = fields;
      Object.assign(record, structuredClone(rest));
      return structuredClone(record);
    });
  }

  // Runs and approvals left by a window that is gone (§10): never resumed.
  async recoverInterrupted() {
    this.cache = await this.#read();
    const now = this.now();
    const stale = (e) => (e.state === 'running' && Date.parse(e.startedAt || e.stateAt || 0) + (e.execution?.timeoutMs || 0) + GRACE_MS < now)
      || ((e.state === 'awaiting-approval' || e.state === 'awaiting-output-sharing') && Date.parse(e.stateAt || e.createdAt || 0) + APPROVAL_CARD_MS + GRACE_MS < now);
    if (!this.cache.executions.some(stale)) return [];
    return this.#transaction((state) => {
      const changed = [];
      for (const e of state.executions) {
        if (!stale(e)) continue;
        e.state = e.state === 'running' ? 'interrupted' : 'void';
        e.stateAt = new Date(now).toISOString();
        e.reason = 'Kenlith or the editor closed before this finished; it was not run again.';
        changed.push(e.id);
      }
      return changed;
    });
  }

  async #read({ strict = false } = {}) {
    let text;
    try { text = await readTextIfExists(this.filePath); } catch (error) {
      if (strict) throw new Error(`Kenlith could not read its command records (${error?.code || 'error'}). Nothing was run; try again.`);
      return this.cache;
    }
    if (!text) return { executions: [] };
    let value;
    try { value = JSON.parse(text); } catch {
      await fs.promises.rename(this.filePath, `${this.filePath}.unreadable-${Date.now()}`).catch(() => undefined);
      return { executions: [] };
    }
    const all = Array.isArray(value?.executions) ? value.executions : [];
    const executions = all.filter((e) => e && typeof e.id === 'string' && typeof e.chatId === 'string' && STATES.has(e.state));
    const unrecognized = [...(Array.isArray(value?.unrecognized) ? value.unrecognized : []), ...all.filter((e) => !executions.includes(e))];
    return { version: 1, executions, ...(unrecognized.length ? { unrecognized } : {}) };
  }

  #transaction(mutate) {
    const run = this.queue.then(async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      return withLock(this.lockPath, this.lockOptions, async (lock) => {
        const state = await this.#read({ strict: true });
        const result = mutate(state);
        if (!(await lock.isHeld())) throw new Error('Kenlith\'s command records were taken over by another window. Nothing was run; try again.');
        await writeFileAtomic(this.filePath, JSON.stringify({ version: 1, executions: state.executions, ...(state.unrecognized ? { unrecognized: state.unrecognized } : {}) }, null, 2));
        this.cache = state;
        return result;
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

module.exports = { APPROVAL_CARD_MS, ExecutionStore, TERMINAL };
