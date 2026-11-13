'use strict';

// The Project Context service (0.5.0, docs/kenlith-0.5.0/ARCHITECTURE.md §3).
//
// One host-side owner of local project awareness: what project the window is
// in, which of its files are open in the editor, the bounded listing, local
// selection of excerpts, and the read-only tools. It sends nothing and asks
// nothing: whether anything may leave the computer is the consent gate's
// decision (src/context-gate.js, src/engine.js).
//
// It does not require 'vscode'. The editor is reached through a small adapter:
//   workspace = {
//     isTrusted(): boolean,
//     activeDocument(): { fsPath, dirty } | undefined,
//     openDocuments(): [{ fsPath, dirty }],
//     excludes(folderUri): { filesExclude, searchExclude }
//   }
// and the window's context comes from src/project.js (ProjectContext.resolve).
//
// API
//   state({ sharing }) -> ProjectAwareness (no file reads)
//   editorSignals() -> { activeRelPath, openRelPaths, openDocuments }
//   root() -> Promise<{ ok, root } | { ok: false, reason }>
//   listing({ signal }) -> Promise<{ files, skipped, truncated, timedOut }>
//   select({ query, signal, symbols }) -> retrieve() result with signals
//   createTurn({ signal }) -> Promise<ToolTurn | undefined>

const { createCache, listFiles, retrieve, DEFAULT_LIMITS } = require('./retrieval');
const { ToolTurn, relativeInside } = require('./project-tools');
const { resolveRoot } = require('./workspace-safety');

const MAX_SIGNAL_DOCUMENTS = 20;
const LISTING_TTL_MS = 5000;

class ProjectContextService {
  // getWindowContext(): the latest ProjectContext.resolve() value.
  // withheldValues(root, settings): RC3, the values of the project's withheld
  // files (the engine's command boundary); files holding one are not sent.
  constructor({ getWindowContext, workspace, cache = createCache({ listingTtlMs: LISTING_TTL_MS }), limits = {}, withheldValues } = {}) {
    this.getWindowContext = getWindowContext;
    this.withheldValues = withheldValues;
    this.workspace = workspace;
    this.cache = cache;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  #project() {
    const context = this.getWindowContext?.();
    return context?.kind === 'project' ? context : undefined;
  }

  // What Kenlith knows locally about the window's project. Names only; no
  // file text. `sharing`: 'none' | 'active' | 'off' | 'unknown' (from the
  // engine, which owns the consent store).
  state({ sharing = 'unknown' } = {}) {
    const context = this.getWindowContext?.();
    const trusted = this.workspace?.isTrusted?.() !== false;
    if (!context) return { kind: 'general', reason: 'starting', trusted, sharing: 'unknown', multiRoot: false, openFiles: [] };
    if (!trusted) return { kind: 'restricted', label: context.label, reason: 'untrusted', trusted, sharing: 'off', multiRoot: Boolean(context.multiRoot), openFiles: [] };
    if (context.kind !== 'project') {
      return { kind: 'general', reason: context.reason, trusted, sharing: 'unknown', multiRoot: Boolean(context.multiRoot), openFiles: [] };
    }
    if (context.available === false) {
      return { kind: 'unavailable', label: context.label, reason: 'root-unavailable', trusted, sharing, multiRoot: Boolean(context.multiRoot), openFiles: [] };
    }
    const signals = this.editorSignals();
    return {
      kind: 'project',
      label: context.label,
      trusted,
      sharing,
      multiRoot: Boolean(context.multiRoot),
      activeFile: signals.activeRelPath,
      openFiles: signals.openRelPaths
    };
  }

  // Project-relative names of the active and open documents inside the
  // window's project folder. Sensitive names, names in skipped folders and
  // anything outside the folder are left out.
  editorSignals() {
    const project = this.#project();
    const empty = { activeRelPath: undefined, openRelPaths: [], openDocuments: [] };
    if (!project || project.available === false || !project.folderPath) return empty;
    const inside = (document) => (document?.fsPath ? relativeInside(project.folderPath, document.fsPath) : undefined);
    let active;
    let open = [];
    try {
      active = this.workspace?.activeDocument?.();
      open = this.workspace?.openDocuments?.() || [];
    } catch {
      return empty;
    }
    const activeRelPath = inside(active);
    const documents = [];
    const seen = new Set();
    for (const document of [active, ...open]) {
      const relPath = inside(document);
      if (!relPath || seen.has(relPath)) continue;
      seen.add(relPath);
      documents.push({ relPath, dirty: Boolean(document.dirty) });
      if (documents.length >= MAX_SIGNAL_DOCUMENTS) break;
    }
    return { activeRelPath, openRelPaths: documents.map((document) => document.relPath), openDocuments: documents };
  }

  async root() {
    const project = this.#project();
    if (!project || project.available === false || !project.folderPath) return { ok: false, reason: 'no-project' };
    return resolveRoot(project.folderPath);
  }

  #settings() {
    const project = this.#project();
    try {
      return this.workspace?.excludes?.(project?.folderUri) || {};
    } catch {
      return {};
    }
  }

  // The bounded listing of the project folder, cached for a few seconds.
  async listing({ signal } = {}) {
    const resolved = await this.root();
    if (!resolved.ok) return { files: [], skipped: [], truncated: false, timedOut: false, unavailable: resolved.reason };
    const cached = this.cache.listings.get(resolved.root);
    if (cached && Date.now() - cached.at < this.cache.listingTtlMs) {
      this.cache.hit();
      return cached.value;
    }
    const check = () => {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    };
    const value = await listFiles(resolved.root, this.#settings(), this.limits, check, Date.now() + this.limits.discoveryMs);
    if (!value.timedOut) this.cache.listings.set(resolved.root, { at: Date.now(), value });
    return value;
  }

  // Local selection for a question: retrieval with the editor's signals.
  async select({ query, signal, symbols } = {}) {
    const project = this.#project();
    if (!project) return { status: 'unavailable', reason: 'no-project', excerpts: [], withheld: [], stats: {} };
    const signals = this.editorSignals();
    return retrieve({ root: project.folderPath, query, settings: this.#settings(), signal, symbols, cache: this.cache, signals, limits: this.limits, withheldValues: this.withheldValues });
  }

  // A tool turn for one user message, or undefined when there is no
  // readable project.
  async createTurn({ limits } = {}) {
    const project = this.#project();
    const resolved = await this.root();
    if (!project || !resolved.ok) return undefined;
    const signals = this.editorSignals();
    return new ToolTurn({
      root: resolved.root,
      label: project.label,
      cache: this.cache,
      limits,
      withheldValues: () => this.withheldValues?.(resolved.root, this.#settings()),
      editor: { activeRelPath: signals.activeRelPath, openDocuments: signals.openDocuments },
      listing: (signal) => this.listing({ signal })
    });
  }

  invalidate(relPath) {
    this.cache.invalidate(relPath);
  }
}

// The adapter over the editor API used by the extension.
function editorWorkspace(vscode) {
  const documentOf = (document) => (document?.uri?.scheme === 'file' ? { fsPath: document.uri.fsPath, dirty: Boolean(document.isDirty) } : undefined);
  return {
    isTrusted: () => vscode.workspace.isTrusted !== false,
    activeDocument: () => documentOf(vscode.window.activeTextEditor?.document),
    openDocuments: () => {
      const out = [];
      // Tabs show what the user has open, including editors not visible now.
      for (const group of vscode.window.tabGroups?.all || []) {
        for (const tab of group.tabs || []) {
          const uri = tab.input?.uri;
          if (uri?.scheme === 'file') out.push({ fsPath: uri.fsPath, dirty: Boolean(tab.isDirty) });
        }
      }
      if (!out.length) for (const editor of vscode.window.visibleTextEditors || []) { const doc = documentOf(editor.document); if (doc) out.push(doc); }
      return out;
    },
    excludes: (folderUri) => {
      const uri = folderUri ? vscode.Uri.parse(folderUri) : undefined;
      // Workspace values may only add exclusions (layer C cannot be weakened).
      return {
        filesExclude: vscode.workspace.getConfiguration('files', uri).get('exclude') || {},
        searchExclude: vscode.workspace.getConfiguration('search', uri).get('exclude') || {}
      };
    }
  };
}

module.exports = { ProjectContextService, editorWorkspace };
