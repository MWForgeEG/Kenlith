'use strict';

// Reply ownership across editor windows (0.4.0, UX-04): at most one reply per
// chat at a time, whichever window sends it. One lock file per chat in
// <globalStorage>/replies/, using src/lock.js (owner process, heartbeat, stale
// owners broken), taken in a single attempt: a second window is refused at
// once instead of waiting.
//
// The lease is taken after every check that can refuse a message and before
// the question is stored, held while the reply streams, and released when it
// ends. It is never held while a consent card waits.

const fs = require('node:fs');
const path = require('node:path');
const { LockTimeoutError, acquireLock, isLockLive } = require('./lock');

const OPTIONS = { timeoutMs: 0, staleMs: 15_000 };

class ReplyBusyError extends Error {
  constructor() {
    super('This chat is replying in another window. Wait for that reply to finish, then send again. Nothing was sent.');
    this.name = 'ReplyBusyError';
    this.code = 'reply-busy';
  }
}

// Chat ids are random UUIDs from the store; anything else is refused so a
// stored id can never name a path outside the folder.
function leaseName(chatId) {
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(chatId)) {
    throw new Error('Unexpected chat id.');
  }
  return `${chatId}.lease`;
}

class ReplyLeases {
  constructor(storageDir) {
    this.directory = path.join(storageDir, 'replies');
  }

  #path(chatId) {
    return path.join(this.directory, leaseName(chatId));
  }

  // A handle with isHeld() and release(), or ReplyBusyError.
  async acquire(chatId) {
    await fs.promises.mkdir(this.directory, { recursive: true });
    try {
      return await acquireLock(this.#path(chatId), OPTIONS);
    } catch (error) {
      if (error instanceof LockTimeoutError) throw new ReplyBusyError();
      throw error;
    }
  }

  async isLive(chatId) {
    try {
      return await isLockLive(this.#path(chatId), OPTIONS);
    } catch {
      return false;
    }
  }
}

module.exports = { ReplyBusyError, ReplyLeases, leaseName };
