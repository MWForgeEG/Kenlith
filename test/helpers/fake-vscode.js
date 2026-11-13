'use strict';

// Minimal stand-in for the `vscode` module so the extension's own source can
// run under `node --test`. Storage goes to a real temporary directory so
// persistence is exercised through actual files.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { makeOwnedTempDir } = require('./owned-temp');

const calls = {
  info: [],
  // Options and items of each information message (a modal welcome, for example).
  infoDetails: [],
  warning: [],
  error: [],
  openExternal: [],
  clipboard: [],
  quickPicks: [],
  quickPick: undefined,
  warningChoice: 'Sign Out',
  // What an error notification with actions answers (M1-0 Manage usage).
  errorChoice: undefined,
  errorItems: [],
  onOpenExternal: undefined,
  // 0.4.0
  serializers: new Map(),
  panels: [],
  treeViews: new Map(),
  inputBoxes: [],
  inputBox: undefined
};

function uri(fsPath, scheme = 'file') {
  return { scheme, fsPath, path: fsPath, toString: () => (scheme === 'file' ? `file:///${fsPath.replace(/\\/g, '/')}` : `${scheme}://${fsPath}`) };
}

// Workspace folders and the active editor, set by tests (stage 2). Folders
// are { uri, name, index }; setWorkspaceFolders fires the change event.
const workspaceListeners = new Set();
const workspaceModel = { folders: undefined, activeEditorPath: undefined, activeEditor: undefined, visibleEditors: [] };

function setWorkspaceFolders(entries) {
  const before = workspaceModel.folders || [];
  workspaceModel.folders = entries === undefined ? undefined : entries.map((entry, index) => {
    const value = typeof entry === 'string' ? { path: entry } : entry;
    return { uri: uri(value.path, value.scheme || 'file'), name: value.name || path.basename(value.path), index };
  });
  const after = workspaceModel.folders || [];
  const event = {
    added: after.filter((folder) => !before.some((old) => old.uri.toString() === folder.uri.toString())),
    removed: before.filter((folder) => !after.some((now) => now.uri.toString() === folder.uri.toString()))
  };
  for (const listener of workspaceListeners) listener(event);
}

function setActiveEditor(filePath) {
  workspaceModel.activeEditorPath = filePath;
  workspaceModel.activeEditor = undefined;
}

// ---------- synthetic editors (stage 3) ----------
// Documents hold synthetic text in memory; nothing is read from disk. A test
// may point a document at a real temporary file (for realpath checks) and give
// it different text, as an editor with unsaved changes would.

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}

class Selection {
  constructor(anchorLine, anchorCharacter, activeLine, activeCharacter) {
    const a = new Position(anchorLine, anchorCharacter);
    const b = new Position(activeLine, activeCharacter);
    const before = a.line < b.line || (a.line === b.line && a.character <= b.character);
    this.anchor = a;
    this.active = b;
    this.start = before ? a : b;
    this.end = before ? b : a;
  }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

// Offsets count UTF-16 code units and a CRLF as two, as in the editor.
function createTextDocument({ path: filePath, scheme = 'file', text = '', languageId = 'plaintext', version = 1, isDirty = false, name } = {}) {
  const untitled = scheme === 'untitled';
  const docUri = untitled ? { scheme, fsPath: name || 'Untitled-1', path: name || 'Untitled-1', toString: () => `untitled:${name || 'Untitled-1'}` } : uri(filePath, scheme);
  const document = {
    uri: docUri,
    fileName: untitled ? (name || 'Untitled-1') : filePath,
    languageId,
    version,
    isDirty,
    isUntitled: untitled,
    text,
    getTextCalls: 0,
    lineStarts() {
      const starts = [0];
      for (let index = 0; index < this.text.length; index += 1) {
        if (this.text[index] === '\n') starts.push(index + 1);
      }
      return starts;
    },
    offsetAt(position) {
      const starts = this.lineStarts();
      const line = Math.min(position.line, starts.length - 1);
      const lineEnd = line + 1 < starts.length ? starts[line + 1] : this.text.length;
      return Math.min(starts[line] + position.character, lineEnd);
    },
    getText(range) {
      this.getTextCalls += 1;
      if (!range) return this.text;
      return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    },
    // A synthetic edit: new text, a new version, unsaved; fires the change event.
    edit(newText) {
      this.text = newText;
      this.version += 1;
      this.isDirty = true;
      for (const listener of documentListeners) listener({ document: this, contentChanges: [{ text: newText }] });
    }
  };
  return document;
}

function createEditor(document, selections) {
  const list = selections.map((value) => (value instanceof Selection ? value : new Selection(...value)));
  return { document, selection: list[0], selections: list };
}

// The active editor (and the visible ones); undefined for none.
function setActiveTextEditor(editor, visible) {
  workspaceModel.activeEditor = editor;
  workspaceModel.activeEditorPath = undefined;
  workspaceModel.visibleEditors = visible || (editor ? [editor] : []);
}

const documentListeners = new Set();
const configurationListeners = new Set();

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
class TreeItem {
  constructor(label, collapsibleState = 0) { this.label = label; this.collapsibleState = collapsibleState; }
}
class ThemeIcon {
  constructor(id) { this.id = id; }
}
class MarkdownString {
  constructor(value = '') { this.value = value; }
  appendText(text) { this.value += text; return this; }
}
class TabInputWebview {
  constructor(viewType) { this.viewType = viewType; }
}

const vscode = {
  EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  TreeItem,
  ThemeIcon,
  MarkdownString,
  TabInputWebview,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  Position,
  Selection,
  Range: Selection,
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  Uri: {
    file: (fsPath) => uri(fsPath),
    joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
    parse: (value) => ({ toString: () => value }),
    // 0.6.0: the review diff documents (scheme kenlith-review).
    from: ({ scheme, path: uriPath = '', query = '' }) => ({ scheme, path: uriPath, query, toString: () => `${scheme}:${uriPath}${query ? `?${query}` : ''}` })
  },
  workspace: {
    fs: {
      createDirectory: (target) => fs.promises.mkdir(target.fsPath, { recursive: true }),
      readFile: async (target) => {
        try {
          return await fs.promises.readFile(target.fsPath);
        } catch (error) {
          if (error.code === 'ENOENT') {
            throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
          }
          throw error;
        }
      },
      writeFile: (target, bytes) => fs.promises.writeFile(target.fsPath, bytes),
      rename: (from, to) => fs.promises.rename(from.fsPath, to.fsPath),
      delete: (target) => fs.promises.rm(target.fsPath, { force: true })
    },
    isTrusted: true,
    get workspaceFolders() { return workspaceModel.folders; },
    onDidChangeWorkspaceFolders: (listener) => {
      workspaceListeners.add(listener);
      return { dispose: () => workspaceListeners.delete(listener) };
    },
    onDidChangeTextDocument: (listener) => {
      documentListeners.add(listener);
      return { dispose: () => documentListeners.delete(listener) };
    },
    onDidChangeConfiguration: (listener) => {
      configurationListeners.add(listener);
      return { dispose: () => configurationListeners.delete(listener) };
    },
    getWorkspaceFolder: (target) => (workspaceModel.folders || [])
      .filter((folder) => target?.fsPath && (target.fsPath === folder.uri.fsPath || target.fsPath.startsWith(folder.uri.fsPath + path.sep)))
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0],
    getConfiguration: (section) => configurationFor(section)
  },
  window: {
    get activeTextEditor() {
      if (workspaceModel.activeEditor) return workspaceModel.activeEditor;
      return workspaceModel.activeEditorPath ? { document: { uri: uri(workspaceModel.activeEditorPath) } } : undefined;
    },
    get visibleTextEditors() { return workspaceModel.visibleEditors; },
    showInformationMessage: async (message, ...rest) => { calls.info.push(message); calls.infoDetails.push(rest); },
    showWarningMessage: async (message, options) => {
      calls.warning.push(message);
      return options?.modal ? calls.warningChoice : undefined;
    },
    showErrorMessage: async (message, ...items) => { calls.error.push(message); calls.errorItems.push(items); return items.length ? calls.errorChoice : undefined; },
    // calls.quickPick(items, options) chooses an item; by default nothing is chosen.
    showQuickPick: async (items, options) => {
      calls.quickPicks.push({ items, options });
      return calls.quickPick ? calls.quickPick(items, options) : undefined;
    },
    registerWebviewViewProvider: () => ({ dispose() {} }),
    // 0.4.0: editor tabs, trees and inputs.
    registerWebviewPanelSerializer: (viewType, serializer) => { calls.serializers.set(viewType, serializer); return { dispose() {} }; },
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panel = createWebviewPanel(viewType, title, showOptions, options);
      calls.panels.push(panel);
      return panel;
    },
    createTreeView: (id, options) => {
      const view = { id, options, description: undefined, message: undefined, badge: undefined, dispose() {} };
      calls.treeViews.set(id, view);
      return view;
    },
    showInputBox: async (options) => {
      calls.inputBoxes.push(options);
      return calls.inputBox ? calls.inputBox(options) : undefined;
    },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: { all: [], close: async () => true }
  },
  env: {
    openExternal: async (target) => {
      calls.openExternal.push(target.toString());
      return calls.onOpenExternal ? calls.onOpenExternal(target.toString()) : true;
    },
    clipboard: {
      writeText: async (text) => { calls.clipboard.push(text); }
    }
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose() {} })
  }
};

// Layered settings modelled on WorkspaceConfiguration: defaults come from this
// extension's package.json, and get() merges default → global → workspace →
// workspaceFolder, as documented in vscode.d.ts. Language-specific layers are
// returned by inspect() but, as in the editor, not applied without a language
// scope. Tests set layers through `config`.
//
// For settings declared with "application" scope, VS Code 1.143 and
// Antigravity 1.107 drop workspace and folder values entirely: they appear
// neither in get() nor in inspect() (verified by test/integration/trust-config.js).
// `enforceScopes = false` simulates a host that does not, to test the
// extension's own defence.
const manifest = require('../../package.json');
const WORKSPACE_LAYERS = new Set(['workspace', 'workspaceFolder', 'workspaceLanguage']);
const config = {
  layers: undefined,
  enforceScopes: true,
  // update() calls, in order, and a switch that makes them fail (Kenlith
  // 0.4.1 settings migration, src/settings.js).
  writes: [],
  failWrites: false,
  reset() {
    this.enforceScopes = true;
    this.writes = [];
    this.failWrites = false;
    this.layers = {
      global: { 'planChat.instructions': 'Test instructions.' },
      workspace: {},
      workspaceFolder: {},
      globalLanguage: {},
      workspaceLanguage: {}
    };
  }
};
config.reset();

function configurationFor(section) {
  const full = (key) => (section ? `${section}.${key}` : key);
  const defaults = manifest.contributes.configuration.properties;
  const visible = (name, layer) => !(config.enforceScopes
    && defaults[name]?.scope === 'application'
    && WORKSPACE_LAYERS.has(layer));
  return {
    get(key, fallback) {
      const name = full(key);
      for (const layer of ['workspaceFolder', 'workspace', 'global']) {
        if (visible(name, layer) && name in config.layers[layer]) return config.layers[layer][name];
      }
      return name in defaults ? defaults[name].default : fallback;
    },
    inspect(key) {
      const name = full(key);
      const value = (layer) => (visible(name, layer) && name in config.layers[layer] ? config.layers[layer][name] : undefined);
      return {
        key: name,
        defaultValue: defaults[name]?.default,
        globalValue: value('global'),
        workspaceValue: value('workspace'),
        workspaceFolderValue: value('workspaceFolder'),
        globalLanguageValue: value('globalLanguage'),
        workspaceLanguageValue: value('workspaceLanguage')
      };
    },
    // As WorkspaceConfiguration.update: Global (1 or true) writes user
    // settings; undefined removes the value.
    async update(key, value, target) {
      const name = full(key);
      config.writes.push({ name, value, target });
      if (config.failWrites) throw new Error('Unable to write into user settings.');
      const layer = target === 1 || target === true ? 'global' : target === 3 ? 'workspaceFolder' : 'workspace';
      if (value === undefined) delete config.layers[layer][name];
      else config.layers[layer][name] = value;
      config.changed([name]);
    }
  };
}

// Raises onDidChangeConfiguration for the given setting names, as the editor
// does after a write or an edit of settings.json.
config.changed = (names) => {
  const event = { affectsConfiguration: (section) => names.some((name) => name === section || name.startsWith(`${section}.`)) };
  for (const listener of [...configurationListeners]) listener(event);
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, ...rest);
};

function makeTempDir() {
  return makeOwnedTempDir('plan-chat-test-');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// SecretStorage shared by several OS processes through one JSON file, standing
// in for the editor's profile-wide secret store. Each write is appended with
// its writer's PID; other processes see it only after `delayMs`, to model the
// delayed cross-window visibility of SecretStorage updates.
function fileSecrets(file, delayMs = 0) {
  const lockDir = `${file}.lockdir`;
  const withFileLock = (operation) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt > 2000) throw error;
        sleepSync(2);
      }
    }
    try {
      return operation();
    } finally {
      fs.rmdirSync(lockDir);
    }
  };
  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const append = (key, value) => withFileLock(() => {
    const data = readAll();
    (data[key] ||= []).push({ value, at: Date.now(), pid: process.pid });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data));
    fs.renameSync(temporary, file);
  });
  return {
    get: async (key) => {
      const entries = withFileLock(() => readAll()[key] || []);
      const now = Date.now();
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.pid === process.pid || entry.at + delayMs <= now) {
          return entry.value ?? undefined;
        }
      }
      return undefined;
    },
    store: async (key, value) => append(key, value),
    delete: async (key) => append(key, null)
  };
}

// A fake ExtensionContext. Pass `shared` to simulate a second activation (or a
// second editor window) that sees the same SecretStorage, globalState and disk.
// `shared.secretsFile` switches to file-backed secrets shared across processes.
function createContext(shared) {
  const storageDir = shared?.storageDir || makeTempDir();
  const secrets = shared?.secretValues || new Map();
  const state = shared?.stateValues || new Map();
  return {
    storageDir,
    secretValues: secrets,
    stateValues: state,
    globalStorageUri: uri(storageDir),
    extensionUri: uri(path.resolve(__dirname, '..', '..')),
    subscriptions: [],
    secrets: shared?.secretsFile ? fileSecrets(shared.secretsFile, shared.secretDelayMs) : {
      get: async (key) => secrets.get(key),
      store: async (key, value) => { secrets.set(key, value); },
      delete: async (key) => { secrets.delete(key); }
    },
    globalState: {
      get: (key) => state.get(key),
      update: async (key, value) => { state.set(key, value); }
    },
    // Per-workspace storage (one per test context, or shared through `shared`).
    workspaceState: (() => {
      const values = shared?.workspaceValues || new Map();
      return { get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); } };
    })()
  };
}

// A webview panel (editor tab) that records what is posted to it, like
// createWebviewView, plus the panel's own lifecycle.
function createWebviewPanel(viewType, title, showOptions, options) {
  const disposeListeners = new Set();
  const stateListeners = new Set();
  const panel = {
    viewType,
    title,
    showOptions,
    options,
    posted: [],
    handler: undefined,
    active: true,
    visible: true,
    viewColumn: 1,
    disposed: false,
    revealed: 0,
    iconPath: undefined,
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-resource:',
      onDidReceiveMessage(callback) { panel.handler = callback; },
      postMessage(message) { panel.posted.push(structuredClone(message)); return Promise.resolve(true); }
    },
    onDidDispose(listener) { disposeListeners.add(listener); return { dispose: () => disposeListeners.delete(listener) }; },
    onDidChangeViewState(listener) { stateListeners.add(listener); return { dispose: () => stateListeners.delete(listener) }; },
    reveal() { panel.revealed += 1; panel.active = true; },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const listener of [...disposeListeners]) listener();
    },
    setActive(active) {
      panel.active = active;
      for (const listener of [...stateListeners]) listener({ webviewPanel: panel });
    },
    send(message) { return panel.handler(message); }
  };
  return panel;
}

// A webview view that records everything the extension posts to it.
function createWebviewView() {
  const view = {
    posted: [],
    handler: undefined,
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-resource:',
      onDidReceiveMessage(callback) { view.handler = callback; },
      postMessage(message) { view.posted.push(structuredClone(message)); return Promise.resolve(true); }
    },
    onDidDispose() {},
    send(message) { return view.handler(message); }
  };
  return view;
}

module.exports = { Selection, calls, config, createContext, createEditor, createTextDocument, createWebviewPanel, createWebviewView, fileSecrets, makeTempDir, setActiveEditor, setActiveTextEditor, setWorkspaceFolders, vscode };
