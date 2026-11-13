'use strict';

// Project identity and the window's context (architecture revision 3, §3.2,
// §3.3, §3.5).
//
// - A project is a local workspace FOLDER. Its key is
//   HMAC-SHA256(identity key, "file:" + normalized real path), first 32 hex.
//   The history file stores that key and the folder's base name, never a path.
// - The identity key is a per-installation random value kept beside the
//   history in two files, published with hard links so a half-written file
//   is never visible; repairs run under a lock (§3.5 table).
// - A window is in one context: a project, or General (no folder, only remote
//   folders, or no choice yet in a multi-root window). Folder identity and
//   window identity are different things: two windows on one folder share a
//   project; one window can switch folders in a multi-root workspace.
//
// This is a logical boundary for organizing chats and request context, not
// an operating-system confidentiality boundary.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');
const { withLock } = require('./lock');
const { readTextIfExists, sleep } = require('./fsutil');
const { IDENTITY_SCHEME } = require('./store');

const KEY_FILE = 'project-identity.key';
const BACKUP_FILE = 'project-identity.key.bak';
const LOCK_FILE = 'project-identity.lock';
const CHOICE_KEY = 'planChat.projectChoice.v1';
const GENERAL = 'general';
// fs.promises.realpath has no .native; the callback API does.
const realpathNative = promisify(fs.realpath.native);

// ---------- identity key (§3.5) ----------

function keyIdOf(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

// A record is valid only if it parses, the key is 64 hex characters, and the
// keyId matches the key.
function parseKeyRecord(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    const record = JSON.parse(text);
    if (record?.version === 1 && /^[0-9a-f]{64}$/.test(record.key) && record.keyId === keyIdOf(record.key)) {
      return record;
    }
  } catch {
    // Invalid.
  }
  return undefined;
}

function newKeyRecord() {
  const key = crypto.randomBytes(32).toString('hex');
  return { version: 1, key, keyId: keyIdOf(key), createdAt: new Date().toISOString() };
}

// Publishes a complete file at `target`: write and flush a temporary file,
// then hard-link it into place. link() either publishes the whole file or
// fails with EEXIST because another process published first. Where the file
// system has no hard links, falls back to exclusive create, write and flush.
async function publishRecord(target, record) {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.link(temporary, target);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (error?.code !== 'EPERM' && error?.code !== 'ENOTSUP' && error?.code !== 'EXDEV') throw error;
    const fallback = await fs.promises.open(target, 'wx').catch((openError) => {
      if (openError?.code === 'EEXIST') return undefined;
      throw openError;
    });
    if (!fallback) return false;
    try {
      await fallback.writeFile(text, 'utf8');
      await fallback.sync();
    } finally {
      await fallback.close();
    }
    return true;
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

class IdentityKeys {
  constructor(directory) {
    this.directory = directory;
    this.keyPath = path.join(directory, KEY_FILE);
    this.backupPath = path.join(directory, BACKUP_FILE);
    this.lockPath = path.join(directory, LOCK_FILE);
    this.cached = undefined;
    this.regenerated = false;
  }

  // Reads one key file. In the no-hard-link fallback a file can be seen while
  // being written: an empty or short file younger than 5 s is re-read.
  async #read(file) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const text = await readTextIfExists(file);
      if (text === undefined) return { exists: false };
      const record = parseKeyRecord(text);
      if (record) return { exists: true, record, text };
      const stat = await fs.promises.stat(file).catch(() => undefined);
      if (!stat || Date.now() - stat.mtimeMs > 5000 || text.length > 100) return { exists: true, invalid: true };
      await sleep(250);
    }
    return { exists: true, invalid: true };
  }

  async #setAside(file) {
    const kept = `${file}.corrupt-${Date.now()}`;
    await fs.promises.rename(file, kept);
    return kept;
  }

  // The current key: { key, keyId }. Creates or repairs the files when needed.
  async load() {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const primary = await this.#read(this.keyPath);
    const backup = await this.#read(this.backupPath);
    if (primary.record && backup.record && primary.record.keyId === backup.record.keyId) {
      this.cached = primary.record;
      return this.cached;
    }
    // Repair or create under the lock; the state is re-checked after taking it.
    this.cached = await withLock(this.lockPath, { timeoutMs: 10_000, staleMs: 15_000, timeoutMessage: 'Project identity is busy in another window; try again.' }, async () => {
      const p = await this.#read(this.keyPath);
      const b = await this.#read(this.backupPath);
      if (p.record) {
        if (!b.record || b.record.keyId !== p.record.keyId) {
          if (b.exists) await this.#setAside(this.backupPath);
          await publishRecord(this.backupPath, p.record);
        }
        return p.record;
      }
      if (b.record) {
        if (p.exists) await this.#setAside(this.keyPath);
        await publishRecord(this.keyPath, b.record);
        return (await this.#read(this.keyPath)).record || b.record;
      }
      // Neither is usable: keep whatever is there, make a new key. Earlier
      // project chats are not touched; they show as "earlier identity key".
      if (p.exists) await this.#setAside(this.keyPath);
      if (b.exists) await this.#setAside(this.backupPath);
      await publishRecord(this.keyPath, newKeyRecord());
      const published = (await this.#read(this.keyPath)).record;
      await publishRecord(this.backupPath, published);
      this.regenerated = Boolean(p.exists || b.exists);
      return published;
    });
    return this.cached;
  }

  // Before writing a project tag: re-read the key file (about 150 bytes) and
  // reload if another window replaced the key since this one cached it.
  async fresh() {
    const primary = await this.#read(this.keyPath);
    if (primary.record && primary.record.keyId === this.cached?.keyId) return this.cached;
    return this.load();
  }
}

// ---------- folder identity (§3.3) ----------

const trimSeparators = (value) => {
  while (value.length > 1 && /[\\/]$/.test(value) && !/^[a-z]:[\\/]$/i.test(value)) value = value.slice(0, -1);
  return value;
};

// Identity input for a local folder path, and whether the folder could be
// resolved (it may be offline, deleted or renamed).
//
// Windows: the folder's path exactly as the file system stores it. The native
// realpath returns the stored name of every component whatever spelling, case
// alias or junction it was reached by, and two distinct folders never share
// it: names that differ only in Unicode composition (R-27) or that JavaScript
// lower-casing joins, such as the Kelvin sign and "k" (R-29), stay apart. No
// text folding is applied. A folder that cannot be resolved gets an
// "unverified" input that can never equal a resolved folder's.
//
// `legacyInput` is what the earlier scheme hashed (lower-case on Windows,
// NFC). It is used only to offer this folder's earlier chats for an explicit
// Relink, never to give access.
async function folderIdentityInput(fsPath, platform = process.platform) {
  let resolved = fsPath;
  let available = true;
  try {
    // The native call follows symbolic links and Windows junctions.
    resolved = await realpathNative(fsPath);
  } catch {
    available = false;
  }
  const normalized = trimSeparators(path.normalize(resolved));
  let input;
  if (platform !== 'win32') input = normalized.normalize('NFC');
  else if (available) input = `exact:${normalized}`;
  else input = `unverified:${normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase())}`;
  const legacyInput = trimSeparators((platform === 'win32' ? path.normalize(resolved).toLowerCase() : path.normalize(resolved)).normalize('NFC'));
  // The display label keeps the folder's own casing (O5: base name only).
  return { input, legacyInput, available, resolved: available ? normalized : undefined, label: path.basename(path.normalize(resolved).replace(/[\\/]+$/, '')) };
}

function projectKey(identityKeyHex, input) {
  return crypto.createHmac('sha256', Buffer.from(identityKeyHex, 'hex')).update(`file:${input}`, 'utf8').digest('hex').slice(0, 32);
}

// ---------- the window's context (§3.2, §3.4) ----------

const isLocal = (folder) => folder?.uri?.scheme === 'file';

class ProjectContext {
  // `workspaceState`: per-workspace storage for the multi-root choice.
  constructor(context, api = vscode) {
    this.api = api;
    this.workspaceState = context.workspaceState;
    this.identity = new IdentityKeys(context.globalStorageUri.fsPath);
    this.choice = undefined; // made in this window (folder URI string or 'general')
    this.initialFolder = undefined; // the active editor's folder when the view first opened
    this.lastProjectUri = undefined; // the folder this window was last in
    this.folderRemoved = false; // that folder left the workspace (§3.4)
  }

  folders() {
    return [...(this.api.workspace.workspaceFolders || [])];
  }

  // Called when the view first opens: the active editor's folder becomes the
  // default in a multi-root window (§3.2 rule 2).
  noteActiveEditor() {
    if (this.initialFolder !== undefined) return;
    const uri = this.api.window.activeTextEditor?.document?.uri;
    const folder = uri && this.api.workspace.getWorkspaceFolder?.(uri);
    this.initialFolder = folder && isLocal(folder) ? folder.uri.toString() : null;
  }

  async choose(choice) {
    this.choice = choice;
    this.folderRemoved = false;
    this.lastProjectUri = undefined;
    await this.workspaceState?.update(CHOICE_KEY, choice);
  }

  // The window's context now:
  // { kind: 'project', key, keyId, label, folderUri, folderPath, available, multiRoot, folders }
  // { kind: 'general', keyId, reason, multiRoot, folders }
  async resolve({ freshKey = false } = {}) {
    const identity = freshKey ? await this.identity.fresh() : (this.identity.cached || await this.identity.load());
    const all = this.folders();
    const local = all.filter(isLocal);
    const multiRoot = all.length > 1;
    const choices = local.map((folder) => ({ uri: folder.uri.toString(), label: folder.name }));
    // A picker is offered in multi-root windows, and after the window's folder
    // was removed (so the remaining folder is chosen explicitly, not silently).
    const general = (reason) => ({ kind: GENERAL, keyId: identity.keyId, reason, multiRoot, canChoose: (multiRoot || reason === 'folder-removed') && choices.length > 0, folders: choices });
    if (this.lastProjectUri && !local.some((candidate) => candidate.uri.toString() === this.lastProjectUri)) {
      // The folder this window was in left the workspace: General (§3.4),
      // until the user chooses again.
      this.folderRemoved = true;
      this.lastProjectUri = undefined;
      this.choice = undefined;
    }
    if (this.folderRemoved) return general('folder-removed');
    if (!all.length) return general('no-folder');
    if (!local.length) return general('remote');

    let folder;
    if (!multiRoot) {
      folder = local[0];
    } else {
      const remembered = this.choice ?? this.workspaceState?.get(CHOICE_KEY);
      const pick = remembered ?? this.initialFolder ?? undefined;
      if (pick === GENERAL) return general('chosen');
      folder = local.find((candidate) => candidate.uri.toString() === pick);
      // No choice, or the chosen folder left the workspace: General until the
      // user picks. Never the first folder by default (§3.2 challenge).
      if (!folder) return general(pick ? 'folder-removed' : 'choose');
    }
    const { input, legacyInput, available, label } = await folderIdentityInput(folder.uri.fsPath);
    this.lastProjectUri = folder.uri.toString();
    return {
      kind: 'project',
      key: projectKey(identity.key, input),
      // The earlier scheme's key for this folder, to offer its earlier chats
      // for Relink; none while the folder cannot be resolved.
      legacyKey: available ? projectKey(identity.key, legacyInput) : undefined,
      keyId: identity.keyId,
      label: label || folder.name,
      folderUri: folder.uri.toString(),
      // For the attachment folder check (stage 3); in memory only, never stored.
      folderPath: folder.uri.fsPath,
      available,
      multiRoot,
      canChoose: multiRoot,
      folders: choices
    };
  }
}

// The tag stored on a new chat for a context.
function tagFor(context) {
  return context.kind === 'project'
    ? { kind: 'project', key: context.key, keyId: context.keyId, label: context.label, scheme: IDENTITY_SCHEME }
    : { kind: GENERAL };
}

module.exports = {
  CHOICE_KEY,
  IDENTITY_SCHEME,
  IdentityKeys,
  ProjectContext,
  folderIdentityInput,
  keyIdOf,
  parseKeyRecord,
  projectKey,
  publishRecord,
  tagFor
};
