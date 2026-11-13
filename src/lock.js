'use strict';

// Cross-process lock based on exclusive file creation. Every editor window runs
// its own extension host process, so in-memory locks cannot coordinate them.
//
// - Acquire: create <lock> with the 'wx' flag and write the owner record.
// - Heartbeat: the holder touches the file while it holds the lock, so a slow
//   but healthy holder is never mistaken for a dead one.
// - Stale: the owner process on this machine no longer exists, the heartbeat
//   stopped for longer than staleMs, or an owner record never appeared.
// - Breaking a stale lock renames it away first, so only one process can break
//   it, and restores it if a fresh lock was taken in the meantime.
// - Timeout: acquisition gives up with LockTimeoutError. Callers must then
//   abandon their change; they never write without the lock.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { TRANSIENT_CODES, sleep } = require('./fsutil');

const DEFAULTS = {
  timeoutMs: 10_000,
  staleMs: 15_000,
  retryMs: 20,
  unreadableGraceMs: 5_000
};

class LockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockTimeoutError';
    this.code = 'LOCK_TIMEOUT';
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function parseOwner(text) {
  try {
    const owner = JSON.parse(text);
    return typeof owner?.id === 'string' ? owner : undefined;
  } catch {
    return undefined;
  }
}

async function readOwner(lockPath) {
  try {
    const [stat, text] = await Promise.all([
      fs.promises.stat(lockPath),
      fs.promises.readFile(lockPath, 'utf8')
    ]);
    return { exists: true, mtimeMs: stat.mtimeMs, owner: parseOwner(text) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false };
    }
    if (TRANSIENT_CODES.has(error?.code)) {
      return { exists: true, transient: true };
    }
    throw error;
  }
}

class LockHandle {
  constructor(lockPath, owner, settings) {
    this.lockPath = lockPath;
    this.owner = owner;
    this.released = false;
    this.timer = setInterval(() => {
      this.#heartbeat().catch(() => undefined);
    }, Math.max(50, Math.floor(settings.staleMs / 3)));
    this.timer.unref?.();
  }

  async isHeld() {
    if (this.released) {
      return false;
    }
    const current = await readOwner(this.lockPath);
    return current.transient ? true : current.owner?.id === this.owner.id;
  }

  async release() {
    if (this.released) {
      return;
    }
    clearInterval(this.timer);
    const held = await this.isHeld().catch(() => false);
    this.released = true;
    if (held) {
      await fs.promises.rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }

  async #heartbeat() {
    if (await this.isHeld()) {
      const now = new Date();
      await fs.promises.utimes(this.lockPath, now, now);
    }
  }
}

async function tryCreate(lockPath, owner) {
  let handle;
  try {
    handle = await fs.promises.open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST' || TRANSIENT_CODES.has(error?.code)) {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8');
    await handle.sync();
    await handle.close();
    return true;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function breakIfStale(lockPath, settings) {
  const current = await readOwner(lockPath);
  if (!current.exists) {
    return true;
  }
  if (current.transient) {
    return false;
  }

  const age = Date.now() - current.mtimeMs;
  const { owner } = current;
  const stale = owner
    ? age > settings.staleMs || (owner.host === os.hostname() && !isProcessAlive(owner.pid))
    : age > settings.unreadableGraceMs;
  if (!stale) {
    return false;
  }

  const moved = `${lockPath}.stale-${crypto.randomUUID()}`;
  try {
    await fs.promises.rename(lockPath, moved);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  const movedOwner = parseOwner(await fs.promises.readFile(moved, 'utf8').catch(() => ''));
  if (movedOwner?.id !== owner?.id) {
    // A fresh lock replaced the stale one between our check and the rename:
    // put it back. link() fails if yet another lock exists, which is also safe.
    await fs.promises.link(moved, lockPath).catch(() => undefined);
  }
  await fs.promises.rm(moved, { force: true }).catch(() => undefined);
  return true;
}

async function acquireLock(lockPath, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const owner = {
    id: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    createdAt: Date.now()
  };
  const deadline = Date.now() + settings.timeoutMs;

  for (;;) {
    if (await tryCreate(lockPath, owner)) {
      return new LockHandle(lockPath, owner, settings);
    }
    if (await breakIfStale(lockPath, settings)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(settings.timeoutMessage || 'Timed out waiting for another window.');
    }
    await sleep(settings.retryMs + Math.random() * settings.retryMs);
  }
}

// Whether a lock is held by a live owner right now (by the same rules that
// would break it as stale). Reads only; used to show that another window holds
// a lock (src/lease.js).
async function isLockLive(lockPath, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const current = await readOwner(lockPath);
  if (!current.exists) return false;
  if (current.transient) return true;
  const age = Date.now() - current.mtimeMs;
  const { owner } = current;
  if (!owner) return age <= settings.unreadableGraceMs;
  return age <= settings.staleMs && !(owner.host === os.hostname() && !isProcessAlive(owner.pid));
}

async function withLock(lockPath, options, operation) {
  const handle = await acquireLock(lockPath, options);
  try {
    return await operation(handle);
  } finally {
    await handle.release();
  }
}

module.exports = { LockTimeoutError, acquireLock, isLockLive, isProcessAlive, withLock };
