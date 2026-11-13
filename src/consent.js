'use strict';

// Transmission consent (M1-2; Phase 0.1 Contract 2, DEC-PLANCHAT-011/012).
//
// One record per (project, provider, account), in `consents.json` in the
// extension's global storage, never in a workspace. Every change runs under
// its own cross-process lock and is written atomically:
//
// - grant: compare-and-update. Applies only if the revision is the one the
//   user saw, the record is not active, and the one-time action token minted
//   by this window's button is fresh. Every grant gets a new consentId.
// - revoke / invalidate: always win over an active record. A stale grant
//   can never undo them, because it carries an older revision.
// - Records are never deleted; revisions only grow.
//
// Anything uncertain (lock timeout, unreadable or newer file) counts as no
// active grant. A revoke that cannot be written is kept as a local mark, so
// this window treats the key as revoked until the write succeeds.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LockTimeoutError, withLock } = require('./lock');
const { readTextIfExists, writeFileAtomic } = require('./fsutil');

const POLICY_VERSION = 1;
const SCOPE = 'project-excerpts';
const FILE = 'consents.json';
const LOCK = 'consents.lock';
const FILE_VERSION = 1;
const TOKEN_TTL_MS = 2 * 60 * 1000;
const STATES = new Set(['active', 'revoked', 'invalidated']);

// The account part of a grant key: never the raw subject or email.
function accountRefFor(identityKeyHex, subject) {
  if (typeof identityKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(identityKeyHex) || typeof subject !== 'string' || !subject) {
    throw new TypeError('accountRefFor needs the identity key and an account subject.');
  }
  return crypto.createHmac('sha256', Buffer.from(identityKeyHex, 'hex')).update(`account:${subject}`, 'utf8').digest('hex').slice(0, 32);
}

function keyOf(grantKey) {
  const { projectKey, provider, accountRef } = grantKey || {};
  for (const part of [projectKey, provider, accountRef]) {
    if (typeof part !== 'string' || !part || part.includes('|')) {
      throw new TypeError('A grant key needs projectKey, provider and accountRef.');
    }
  }
  return `${projectKey}|${provider}|${accountRef}`;
}

function validRecord(record) {
  return Boolean(record && typeof record === 'object'
    && STATES.has(record.state)
    && Number.isSafeInteger(record.revision) && record.revision >= 0
    && typeof record.consentId === 'string');
}

// The file's own problems: unreadable (quarantined) or written by a newer
// version (left alone). Both mean "no active grant".
class ConsentFileError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'ConsentFileError';
    this.kind = kind;
  }
}

function parseFile(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConsentFileError('The consent file is not valid JSON.', 'corrupt');
  }
  if (!value || typeof value !== 'object' || typeof value.version !== 'number') {
    throw new ConsentFileError('The consent file is not in Kenlith\'s format.', 'corrupt');
  }
  if (value.version > FILE_VERSION) {
    throw new ConsentFileError('The consent file was written by a newer version of Kenlith.', 'newer');
  }
  if (value.version !== FILE_VERSION || typeof value.generation !== 'string' || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) {
    throw new ConsentFileError('The consent file is not in Kenlith\'s format.', 'corrupt');
  }
  return value;
}

class ConsentStore {
  #file;
  #lockPath;
  #lockOptions;
  #now;
  #hooks;
  #pollMs;
  #watchFs;
  #tokens = new Map();
  #locallyRevoked = new Map();
  #generation;
  #watchers = new Set();

  // options: { lockOptions, now, hooks: { [step]: async () => {} }, pollMs, watchFs }
  constructor(storageDir, options = {}) {
    this.storageDir = storageDir;
    this.#file = path.join(storageDir, FILE);
    this.#lockPath = path.join(storageDir, LOCK);
    this.#lockOptions = { timeoutMs: 3_000, ...options.lockOptions, timeoutMessage: 'Timed out waiting for another window to update sharing permissions.' };
    this.#now = options.now || Date.now;
    this.#hooks = options.hooks || {};
    this.#pollMs = options.pollMs ?? 2_000;
    this.#watchFs = options.watchFs !== false;
  }

  async #step(name) {
    const hook = this.#hooks[name];
    if (hook) await hook();
  }

  // Under the lock only: a corrupt file is renamed aside and replaced by an
  // empty one with a new generation, so tokens minted before are void.
  async #loadLocked() {
    await fs.promises.mkdir(this.storageDir, { recursive: true });
    const text = await readTextIfExists(this.#file);
    if (text === undefined) {
      // Written at once, so the generation that tokens are bound to is stable.
      const created = { version: FILE_VERSION, generation: crypto.randomUUID(), records: {} };
      await this.#write(created);
      return created;
    }
    try {
      return parseFile(text);
    } catch (error) {
      if (error.kind === 'corrupt') {
        const aside = `${this.#file}.corrupt-${new Date(this.#now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
        await fs.promises.rename(this.#file, aside).catch(() => undefined);
        this.corruptFile = aside;
      }
      throw error;
    }
  }

  async #write(state) {
    const { fresh, ...value } = state;
    await writeFileAtomic(this.#file, `${JSON.stringify(value, null, 2)}\n`);
  }

  #locked(operation) {
    return withLock(this.#lockPath, this.#lockOptions, async () => {
      await this.#step('after-lock');
      return operation();
    });
  }

  #view(key, record, generation) {
    if (this.#locallyRevoked.has(key)) {
      return { active: false, state: 'revoked', revision: record?.revision ?? 0, consentId: record?.consentId, policyVersion: record?.policyVersion, generation, pendingRevoke: true };
    }
    if (!record) {
      return { active: false, state: 'none', revision: 0, generation };
    }
    if (!validRecord(record)) {
      return { active: false, state: 'invalid', revision: Number.isSafeInteger(record.revision) ? record.revision : 0, generation };
    }
    return {
      active: record.state === 'active' && record.policyVersion === POLICY_VERSION,
      state: record.state,
      revision: record.revision,
      consentId: record.consentId,
      policyVersion: record.policyVersion,
      scope: record.scope,
      projectLabel: record.projectLabel,
      grantedAt: record.grantedAt,
      changedAt: record.changedAt,
      reason: record.reason,
      generation
    };
  }

  // { active, state: 'active'|'revoked'|'invalidated'|'none'|'invalid'|'unavailable', revision, consentId, policyVersion, generation, ... }
  async read(grantKey) {
    const key = keyOf(grantKey);
    try {
      return await this.#locked(async () => {
        const state = await this.#loadLocked();
        await this.#step('after-read');
        this.#generation = state.generation;
        return this.#view(key, state.records[key], state.generation);
      });
    } catch (error) {
      return { active: false, state: 'unavailable', revision: 0, reason: unavailableReason(error) };
    }
  }

  // A one-time token for this window's Allow button, bound to the key, the
  // revision the user saw and the file generation, valid for two minutes.
  mintToken(grantKey, expectedRevision) {
    const key = keyOf(grantKey);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('mintToken needs the revision the user saw.');
    }
    const token = crypto.randomUUID();
    this.#tokens.set(token, { key, revision: expectedRevision, generation: this.#generation, expires: this.#now() + TOKEN_TTL_MS });
    return token;
  }

  // { ok: true, consentId, revision } | { ok: false, reason: 'token'|'stale'|'already-active'|'revoke-pending'|'unavailable' }
  async grant(grantKey, { expectedRevision, token, projectLabel } = {}) {
    const key = keyOf(grantKey);
    // A token is spent by its first use, whatever the outcome.
    const minted = this.#tokens.get(token);
    this.#tokens.delete(token);
    if (this.#locallyRevoked.has(key)) {
      return { ok: false, reason: 'revoke-pending' };
    }
    try {
      return await this.#locked(async () => {
        const state = await this.#loadLocked();
        await this.#step('after-read');
        if (!minted || minted.key !== key || minted.revision !== expectedRevision || minted.expires < this.#now()
          || (minted.generation !== undefined && minted.generation !== state.generation)) {
          return { ok: false, reason: 'token' };
        }
        const current = state.records[key];
        const revision = current?.revision ?? 0;
        if (current && !validRecord(current)) {
          return { ok: false, reason: 'unavailable' };
        }
        if (revision !== expectedRevision) {
          return { ok: false, reason: 'stale' };
        }
        if (current?.state === 'active') {
          return { ok: false, reason: 'already-active' };
        }
        const at = new Date(this.#now()).toISOString();
        const record = {
          consentId: crypto.randomUUID(),
          state: 'active',
          revision: revision + 1,
          scope: SCOPE,
          policyVersion: POLICY_VERSION,
          projectLabel: typeof projectLabel === 'string' ? projectLabel.slice(0, 200) : current?.projectLabel,
          grantedAt: at,
          changedAt: at,
          reason: 'granted'
        };
        state.records[key] = record;
        await this.#step('before-write');
        await this.#write(state);
        this.#generation = state.generation;
        return { ok: true, consentId: record.consentId, revision: record.revision };
      });
    } catch (error) {
      return { ok: false, reason: 'unavailable', detail: unavailableReason(error) };
    }
  }

  // { ok: true, changed, revision } | { ok: false, reason: 'unavailable', pending: true }
  revoke(grantKey, reason = 'revoked') {
    return this.#end(grantKey, 'revoked', reason);
  }

  invalidate(grantKey, reason = 'invalidated') {
    return this.#end(grantKey, 'invalidated', reason);
  }

  async #end(grantKey, to, reason) {
    const key = keyOf(grantKey);
    try {
      const result = await this.#locked(async () => {
        const state = await this.#loadLocked();
        await this.#step('after-read');
        const current = state.records[key];
        if (!current || current.state !== 'active') {
          return { ok: true, changed: false, revision: current?.revision ?? 0 };
        }
        state.records[key] = {
          ...current,
          state: to,
          revision: (Number.isSafeInteger(current.revision) ? current.revision : 0) + 1,
          changedAt: new Date(this.#now()).toISOString(),
          reason: String(reason).slice(0, 100)
        };
        await this.#step('before-write');
        await this.#write(state);
        return { ok: true, changed: true, revision: state.records[key].revision };
      });
      this.#locallyRevoked.delete(key);
      return result;
    } catch (error) {
      // Never lost silently: this window treats the key as revoked until a
      // later write succeeds (retryPendingRevocations).
      this.markRevokedLocally(grantKey, to, reason);
      return { ok: false, reason: 'unavailable', pending: true, detail: unavailableReason(error) };
    }
  }

  markRevokedLocally(grantKey, to = 'revoked', reason = 'revoked') {
    this.#locallyRevoked.set(keyOf(grantKey), { grantKey, to, reason });
  }

  pendingRevocations() {
    return [...this.#locallyRevoked.values()].map((entry) => entry.grantKey);
  }

  // Retries every revoke this window could not write. Returns the number
  // still pending.
  async retryPendingRevocations() {
    for (const { grantKey, to, reason } of [...this.#locallyRevoked.values()]) {
      await this.#end(grantKey, to, reason);
    }
    return this.#locallyRevoked.size;
  }

  // For the permissions view: [{ projectKey, provider, accountRef, ...record view }]
  async list() {
    try {
      return await this.#locked(async () => {
        const state = await this.#loadLocked();
        return Object.entries(state.records).map(([key, record]) => {
          const [projectKey, provider, accountRef] = key.split('|');
          return { projectKey, provider, accountRef, ...this.#view(key, record, state.generation) };
        });
      });
    } catch {
      return [];
    }
  }

  // Calls listener({ key, grantKey, revision, state, consentId }) when a
  // record's revision changes, from any window or process. fs.watch on the
  // storage folder, plus a poll as fallback. Returns { dispose }.
  watch(listener) {
    let snapshot;
    let closed = false;
    let checking = false;
    const check = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        const text = await readTextIfExists(this.#file).catch(() => undefined);
        let records = {};
        if (text !== undefined) {
          try {
            records = parseFile(text).records;
          } catch {
            records = undefined;
          }
        }
        if (records === undefined) return;
        const next = new Map(Object.entries(records).map(([key, record]) => [key, record]));
        if (snapshot) {
          for (const [key, record] of next) {
            const before = snapshot.get(key);
            if (!before || before.revision !== record.revision) {
              const [projectKey, provider, accountRef] = key.split('|');
              listener({ key, grantKey: { projectKey, provider, accountRef }, revision: record.revision, state: record.state, consentId: record.consentId });
            }
          }
        }
        snapshot = next;
      } finally {
        checking = false;
      }
    };
    const ready = check();
    let watcher;
    if (this.#watchFs) {
      try {
        watcher = fs.watch(this.storageDir, (event, name) => {
          if (!name || name === FILE) check();
        });
        watcher.on('error', () => undefined);
        // Like the poll timer: watching never keeps a process alive by itself.
        watcher.unref?.();
      } catch {
        watcher = undefined;
      }
    }
    const timer = setInterval(check, this.#pollMs);
    timer.unref?.();
    const handle = {
      ready,
      check,
      dispose: () => {
        closed = true;
        clearInterval(timer);
        watcher?.close();
        this.#watchers.delete(handle);
      }
    };
    this.#watchers.add(handle);
    return handle;
  }

  dispose() {
    for (const handle of [...this.#watchers]) handle.dispose();
  }
}

function unavailableReason(error) {
  if (error instanceof LockTimeoutError || error?.code === 'LOCK_TIMEOUT') return 'lock-timeout';
  if (error instanceof ConsentFileError) return error.kind === 'newer' ? 'newer-file' : 'corrupt-file';
  return 'io-error';
}

module.exports = { ConsentStore, POLICY_VERSION, SCOPE, accountRefFor, keyOf };
