'use strict';

// Unsent drafts (0.4.0): text typed in a chat's composer and not yet sent,
// kept across restarts in <globalStorage>/drafts.json.
//
// - Bound to one chat and to that chat's context tag (project identity or
//   General): a draft is returned only for the same chat with the same tag, so
//   a draft never appears in another chat or another project, and a chat moved
//   to another context starts without it.
// - Never sent: drafts are only shown in the composer. A request is built from
//   what the user sends (src/request-builder.js), never from this file.
// - Bounded: each draft at most MAX_CHARS, at most MAX_DRAFTS drafts and
//   MAX_TOTAL characters in all; the oldest drafts are dropped first.
// - Local and unencrypted, like the chat history in the same folder.
// - Best effort: a draft that cannot be saved (another window holds the file,
//   disk full) is kept in memory and saved with the next change.
//
// RC5 (D-1), one lifecycle for the composer's text:
// - Every draft carries `rev`, the time (ms) it was typed in the composer. A
//   save older than what is stored is ignored, so a late message never
//   replaces newer text.
// - Send carries the `rev` of the moment it was pressed. When the message waits
//   for project consent, the draft that Send took is marked `submitted` (owned
//   by that pending send) and is not offered back to the composer, so a refresh
//   cannot put the sent question back in the box.
// - When the question is stored, only drafts no newer than that Send are
//   removed; text typed after Send stays.
// - Cancel (or a card dropped for another reason) makes it an ordinary draft
//   again. A submitted draft whose owner is gone (the extension host stopped
//   while the card waited) is offered again: the question was never sent.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock, isProcessAlive } = require('./lock');
const { readTextIfExists, writeFileAtomic } = require('./fsutil');

const MAX_CHARS = 100_000;
const MAX_DRAFTS = 200;
const MAX_TOTAL = 1_000_000;
const LOCK = { timeoutMs: 1_000, staleMs: 15_000, timeoutMessage: 'Drafts are busy in another window.' };

// Owners of submitted drafts that are alive in this process (one per engine).
const LIVE_OWNERS = new Set();
// A submitted draft older than this is offered again whatever its owner: a
// consent card is withdrawn after 10 minutes (src/engine.js CONSENT_CARD_MS).
const SUBMITTED_MS = 10 * 60_000;
// A change that could not be written (lock busy, disk) is tried again.
const RETRIES = [1_500, 5_000, 15_000];

// The context a draft belongs to: the chat's tag as stored.
function tagSignature(tag) {
  if (!tag || typeof tag !== 'object') return 'untagged';
  return tag.kind === 'project' ? `project:${tag.key}:${tag.keyId}:${tag.scheme ?? ''}` : `general`;
}

function parse(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && value.drafts && typeof value.drafts === 'object' && !Array.isArray(value.drafts)) {
      return { version: 1, drafts: value.drafts };
    }
  } catch {
    // An unreadable drafts file is replaced; drafts are not history.
  }
  return { version: 1, drafts: {} };
}

function bound(state) {
  const entries = Object.entries(state.drafts)
    .filter(([id, record]) => typeof id === 'string' && record && typeof record.text === 'string' && typeof record.tag === 'string')
    .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
  const kept = {};
  let total = 0;
  for (const [id, record] of entries.slice(0, MAX_DRAFTS)) {
    if (total + record.text.length > MAX_TOTAL) break;
    total += record.text.length;
    kept[id] = record;
  }
  state.drafts = kept;
  return state;
}

const revOf = (record) => (Number.isFinite(record?.rev) ? record.rev : 0);
const toRev = (value) => (Number.isFinite(value) ? value : Date.now());

// A submitted draft is held while its owner (an engine) is alive: in this
// process by the live-owner set, in another process by its process id.
function ownerAlive(submitted) {
  if (!submitted || typeof submitted !== 'object') return false;
  if (Number.isFinite(submitted.at) && Date.now() - submitted.at > SUBMITTED_MS) return false;
  if (submitted.pid === process.pid && (!submitted.host || submitted.host === os.hostname())) return LIVE_OWNERS.has(submitted.owner);
  // Another process on this computer: alive while its process is. A process
  // id can be reused, so the age limit above still applies.
  if (submitted.host && submitted.host !== os.hostname()) return true;
  return isProcessAlive(submitted.pid);
}

class DraftStore {
  constructor(storageDir) {
    this.directory = storageDir;
    this.file = path.join(storageDir, 'drafts.json');
    this.lockPath = path.join(storageDir, 'drafts.lock');
    this.queue = Promise.resolve();
    this.owner = crypto.randomUUID();
    LIVE_OWNERS.add(this.owner);
    // Held drafts in this window: chat id → the Send revision whose text is
    // not offered back (from the moment Send arrives until the question is
    // stored, or the send is given up). Memory only, so it also covers a
    // write that failed.
    this.held = new Map();
  }

  // Send (pressed at `rev`) arrived for this chat: drafts no newer than it
  // are not offered back from now on.
  hold(chatId, rev) {
    const at = toRev(rev);
    if (!(this.held.get(chatId) >= at)) this.held.set(chatId, at);
  }

  // The send at `rev` will not happen: its text may be offered again.
  unhold(chatId, rev) {
    if (this.held.get(chatId) === toRev(rev)) this.held.delete(chatId);
  }

  // The engine using this store is gone (window closing): its submitted
  // drafts are offered again by the next window.
  dispose() {
    LIVE_OWNERS.delete(this.owner);
  }

  async #read() {
    return parse((await readTextIfExists(this.file)) ?? '{}');
  }

  // One change under the drafts lock. `change(state)` returns false to skip
  // the write.
  #update(change, attempt = 0) {
    const run = this.queue.then(async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      return withLock(this.lockPath, LOCK, async () => {
        const state = await this.#read();
        if (change(state) === false) return false;
        await writeFileAtomic(this.file, JSON.stringify(bound(state)));
        return true;
      });
    });
    this.queue = run.catch(() => undefined);
    return run.catch(() => {
      // Tried again later; until then the in-memory hold keeps a sent
      // question out of the composer in this window.
      if (attempt < RETRIES.length) {
        const timer = setTimeout(() => { this.#update(change, attempt + 1); }, RETRIES[attempt]);
        timer.unref?.();
      }
      return false;
    });
  }

  // The draft for this chat, or '' when there is none for its current tag, or
  // when it was submitted and its send is still waiting.
  async get(chatId, tag) {
    await this.queue;
    const state = await this.#read().catch(() => ({ drafts: {} }));
    const record = state.drafts[chatId];
    if (!record || record.tag !== tagSignature(tag)) return '';
    if (record.submitted && ownerAlive(record.submitted)) return '';
    if (this.held.has(chatId) && revOf(record) <= this.held.get(chatId)) return '';
    return record.text;
  }

  // Saves (or, for empty text, removes) the chat's draft typed at `rev`.
  // A save older than the stored draft is ignored.
  set(chatId, tag, text, rev) {
    const value = typeof text === 'string' ? text.slice(0, MAX_CHARS) : '';
    const at = toRev(rev);
    return this.#update((state) => {
      const record = state.drafts[chatId];
      if (record && revOf(record) > at) return false;
      if (record?.submitted && ownerAlive(record.submitted) && at <= record.submitted.rev) return false;
      if (value.trim()) {
        state.drafts[chatId] = { text: value, tag: tagSignature(tag), rev: at, updatedAt: new Date().toISOString() };
      } else {
        delete state.drafts[chatId];
      }
      return true;
    });
  }

  // Send (pressed at `sendRev`) waits for a decision: its text is held by the
  // send, not offered as a draft. Newer typing is left alone.
  markSubmitted(chatId, tag, text, sendRev) {
    const at = toRev(sendRev);
    const value = typeof text === 'string' ? text.slice(0, MAX_CHARS) : '';
    return this.#update((state) => {
      const record = state.drafts[chatId];
      if (record && revOf(record) > at) return false;
      state.drafts[chatId] = { text: value, tag: tagSignature(tag), rev: at, submitted: { rev: at, owner: this.owner, pid: process.pid, host: os.hostname(), at: Date.now() }, updatedAt: new Date().toISOString() };
      return true;
    });
  }

  // The question sent at `sendRev` is stored: drafts no newer than it are done.
  clearSent(chatId, sendRev) {
    const at = toRev(sendRev);
    return this.#update((state) => {
      const record = state.drafts[chatId];
      if (!record || revOf(record) > at) return false;
      delete state.drafts[chatId];
      return true;
    });
  }

  // The send at `sendRev` will not happen (Cancel, a dropped card): its text
  // is an ordinary draft again.
  release(chatId, sendRev) {
    this.unhold(chatId, sendRev);
    return this.#update((state) => {
      const record = state.drafts[chatId];
      if (!record?.submitted || record.submitted.rev !== toRev(sendRev)) return false;
      delete record.submitted;
      return true;
    });
  }

  clear(chatId) {
    return this.#update((state) => {
      if (!state.drafts[chatId]) return false;
      delete state.drafts[chatId];
      return true;
    });
  }
}

module.exports = { DraftStore, MAX_CHARS, MAX_DRAFTS, MAX_TOTAL, tagSignature };
