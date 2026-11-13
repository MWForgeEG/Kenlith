'use strict';

// Read-only project tools for the model (0.5.0, docs/kenlith-0.5.0/CAPABILITY-SPEC.md §4).
//
// Six narrow tools the extension host runs when the model asks for them:
// project_summary, project_list_directory, project_find_files,
// project_search_text, project_read_file, project_open_documents. None writes,
// runs anything or opens a connection. Nothing here decides whether a result
// may leave the computer: the engine sends their results only under an active
// project grant or after Allow on the card that shows them (DEC-PLANCHAT-024),
// and the consent gate runs before every request (src/engine.js).
//
// The host is the security boundary:
// - Arguments are parsed and checked against the schema before any file is
//   touched: unknown tools, unknown or missing fields, wrong types and
//   over-long strings are refused.
// - A tool can only see files that the discovery listing contains
//   (src/retrieval.js listFiles: links never followed, layer A folders,
//   files.exclude, search.exclude, layer C sensitive names, binaries). A path
//   the listing skips cannot be read by naming it.
// - Every file read goes through readContained() (src/workspace-safety.js).
// - Output is bounded per call and per turn; every file whose text is
//   returned is recorded with its SHA-256 so the gate can check it again.
// Project text in a result is data for the model, never instructions to
// Kenlith; nothing here interprets it.

const path = require('node:path');
const { OVERVIEW_FILE, isSkippedDirectory, rankPath, tokenize } = require('./retrieval');
const { checkRelative, classifySensitive, readContained, statContained } = require('./workspace-safety');
const { PROPOSAL_TOOL, validateProposalArguments } = require('./proposal');

const TOOL_LIMITS = Object.freeze({
  maxRounds: 4,
  maxCalls: 10,
  maxOutputChars: 6000,
  maxTurnChars: 24000,
  maxReadLines: 200,
  maxSearchResults: 20,
  maxPreviewChars: 200,
  maxFindResults: 50,
  maxListEntries: 200,
  maxOpenDocuments: 20,
  maxTopLevel: 60,
  maxOverviewFiles: 3,
  overviewLines: 40,
  overviewChars: 2000,
  maxPathChars: 260,
  maxQueryChars: 200,
  minSearchChars: 3,
  maxArgumentChars: 2048,
  // Reading time per tool call (Phase 12: about 3,300 files on the test machine).
  readMs: 2500,
  maxReadBytes: 2 * 1024 * 1024,
  maxFileBytes: 512 * 1024
});

const nullable = (type, description, extra = {}) => ({ type: [type, 'null'], description, ...extra });

const DEFINITIONS = [
  {
    name: 'project_summary',
    description: 'Overview of the user\'s open project: its name, top-level folders and files, file counts by extension, and the first lines of its README or manifest files.',
    properties: {}
  },
  {
    name: 'project_list_directory',
    description: 'Names of the folders and files directly inside one folder of the open project. Paths are relative to the project folder, with forward slashes.',
    properties: { path: nullable('string', 'Project-relative folder path, or null for the project folder itself.') }
  },
  {
    name: 'project_find_files',
    description: 'Find files in the open project whose names or paths match words or a file name.',
    properties: { query: { type: 'string', description: 'Words or a file name, at most 200 characters.' } }
  },
  {
    name: 'project_search_text',
    description: 'Search the text of the open project\'s files for a literal string (case-insensitive). Returns matching lines with their file and line number.',
    properties: { query: { type: 'string', description: 'Literal text to find, 3 to 200 characters.' } }
  },
  {
    name: 'project_read_file',
    description: 'Read lines of one file in the open project, with line numbers. At most 200 lines per call.',
    properties: {
      path: { type: 'string', description: 'Project-relative file path, with forward slashes.' },
      start_line: nullable('integer', 'First line to read (1-based), or null for the start.'),
      end_line: nullable('integer', 'Last line to read, or null.')
    }
  },
  {
    name: 'project_open_documents',
    description: 'The files of the open project that are open in the editor, and which one is active. Names only.',
    properties: {}
  }
];

// Responses API function tool definitions: strict schemas, every field
// required (optional values are null), nothing else allowed.
const TOOL_DEFINITIONS = Object.freeze(DEFINITIONS.map((tool) => Object.freeze({
  type: 'function',
  name: tool.name,
  description: tool.description,
  strict: true,
  parameters: { type: 'object', properties: tool.properties, required: Object.keys(tool.properties), additionalProperties: false }
})));
const BY_NAME = new Map(DEFINITIONS.map((tool) => [tool.name, tool]));
const TOOL_NAMES = Object.freeze(DEFINITIONS.map((tool) => tool.name));

const refuse = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail } : {}) });

function typeOk(schema, value) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((type) => (type === 'null' ? value === null
    : type === 'string' ? typeof value === 'string'
      : type === 'integer' ? Number.isSafeInteger(value)
        : false));
}

// The model's arguments for one call: { ok: true, args } or a refusal.
function validateCall(name, rawArguments) {
  const tool = BY_NAME.get(name);
  if (!tool) return refuse('unknown-tool');
  if (typeof rawArguments !== 'string' || rawArguments.length > TOOL_LIMITS.maxArgumentChars) return refuse('invalid-arguments', 'size');
  let args;
  try {
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return refuse('invalid-arguments', 'not JSON');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return refuse('invalid-arguments', 'not an object');
  const expected = Object.keys(tool.properties);
  const given = Object.keys(args);
  if (given.some((key) => !expected.includes(key))) return refuse('invalid-arguments', 'unknown field');
  for (const key of expected) {
    if (!(key in args)) return refuse('invalid-arguments', `missing ${key}`);
    if (!typeOk(tool.properties[key], args[key])) return refuse('invalid-arguments', `type of ${key}`);
    if (typeof args[key] === 'string') {
      const max = key === 'path' ? TOOL_LIMITS.maxPathChars : TOOL_LIMITS.maxQueryChars;
      if (args[key].length > max) return refuse('invalid-arguments', `${key} too long`);
    }
  }
  return { ok: true, args };
}

// A model-supplied path checked by grammar and the security rules, without
// touching the file system: { ok, relPath } or a refusal.
function checkToolPath(raw, { directory = false } = {}) {
  const relative = checkRelative(String(raw).replace(/\\/g, '/'));
  if (!relative.ok) return refuse('invalid-path', relative.detail);
  const segments = relative.segments;
  const folders = directory ? segments : segments.slice(0, -1);
  if (folders.some((segment) => isSkippedDirectory(segment))) return refuse('excluded');
  if (classifySensitive(directory ? `${relative.relPath}/x` : relative.relPath).withheld) return refuse('sensitive');
  return { ok: true, relPath: relative.relPath };
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Files read together by project_search_text (like READ_BATCH in retrieval).
const SEARCH_BATCH = 8;

// Everything one user turn may do with tools: the counts, the characters
// returned, and the files whose text was returned (for the gate).
class ToolTurn {
  // context: { root, label, listing: async (signal) => { files, truncated },
  //            editor: { activeRelPath, openDocuments: [{ relPath, dirty }] },
  //            cache, limits, propose? (0.6.0: records a change proposal) }
  constructor(context) {
    this.context = context;
    this.limits = { ...TOOL_LIMITS, ...(context.limits || {}) };
    this.rounds = 0;
    this.calls = 0;
    this.chars = 0;
    this.sources = new Map(); // relPath -> { relPath, fileSha256, ranges: [{ startLine, endLine }] }
    this.log = [];
  }

  get exhausted() {
    return this.rounds >= this.limits.maxRounds || this.calls >= this.limits.maxCalls || this.chars >= this.limits.maxTurnChars;
  }

  // Files whose text this turn returned: [{ relPath, startLine, endLine, fileSha256 }].
  sentSources() {
    const out = [];
    for (const source of [...this.sources.values()].sort((a, b) => byPath(a.relPath, b.relPath))) {
      for (const range of source.ranges) out.push({ relPath: source.relPath, startLine: range.startLine, endLine: range.endLine, fileSha256: source.fileSha256, via: 'tool' });
    }
    return out;
  }

  #note(relPath, fileSha256, startLine, endLine) {
    const entry = this.sources.get(relPath) || { relPath, fileSha256, ranges: [] };
    entry.fileSha256 = fileSha256;
    if (!entry.ranges.some((range) => range.startLine === startLine && range.endLine === endLine)) entry.ranges.push({ startLine, endLine });
    this.sources.set(relPath, entry);
  }

  // Runs one round of calls: [{ callId, name, arguments }] ->
  // [{ callId, name, output (string), result }]. Calls past the turn's
  // bounds get a 'budget' refusal; their files are not read.
  async runRound(calls, { signal } = {}) {
    this.rounds += 1;
    const outputs = [];
    for (const call of calls) {
      let result;
      if (signal?.aborted) result = refuse('cancelled');
      else if (this.rounds > this.limits.maxRounds || this.calls >= this.limits.maxCalls || this.chars >= this.limits.maxTurnChars) result = refuse('budget');
      else {
        this.calls += 1;
        // 0.6.0: project_propose_edit only when this turn may record
        // proposals (src/proposal-review.js); it never writes.
        const proposal = call.name === PROPOSAL_TOOL && typeof this.context.propose === 'function';
        // 0.7.0: tools another module handles for this turn (the run tools,
        // src/exec-service.js). This module only routes the raw arguments;
        // it has no process capability of its own (T14).
        const handlers = this.context.handlers || {};
        const handler = Object.prototype.hasOwnProperty.call(handlers, call.name) ? handlers[call.name] : undefined;
        if (handler) {
          result = await Promise.resolve(handler(call.arguments)).catch(() => refuse(signal?.aborted ? 'cancelled' : 'unreadable'));
        } else {
          const checked = proposal ? validateProposalArguments(call.arguments) : validateCall(call.name, call.arguments);
          result = checked.ok ? await (proposal ? this.#propose(checked.args, signal) : this.#run(call.name, checked.args, signal)).catch(() => refuse(signal?.aborted ? 'cancelled' : 'unreadable')) : checked;
        }
      }
      const room = Math.min(this.limits.maxOutputChars, this.limits.maxTurnChars - this.chars);
      if (result.ok && call.name !== PROPOSAL_TOOL && result.raw === undefined) result = fitOutput(call.name, result, room);
      if (result.ok && result.sources) {
        for (const source of result.sources) this.#note(source.relPath, source.fileSha256, source.startLine, source.endLine);
      }
      const { sources, ...visible } = result;
      // A handler may return its finished, bounded text as `raw`.
      const output = typeof result.raw === 'string' ? result.raw : JSON.stringify({ tool: call.name, ...visible });
      if (typeof result.raw === 'string') result.ok = true;
      if (result.ok) this.chars += output.length;
      this.log.push({ name: call.name, ok: result.ok, reason: result.reason, chars: output.length });
      outputs.push({ callId: call.callId, name: call.name, output, result: visible });
    }
    return outputs;
  }

  // One listing per turn (Phase 12: in a large project the walk reaches its
  // time limit and is not cached between questions, so every call of a turn
  // would walk again). A failed listing is not kept.
  #listed;
  async #listing(signal) {
    if (!this.#listed) {
      this.#listed = Promise.resolve(this.context.listing(signal)).then((listing) => ({ ...listing, set: new Set(listing.files) }));
      this.#listed.catch(() => { this.#listed = undefined; });
    }
    return this.#listed;
  }

  async #read(relPath) {
    const { cache, root } = this.context;
    const key = `${root}\u0000${relPath}`;
    const cached = cache?.contents?.get(key);
    if (cached) {
      const now = await statContained(root, relPath);
      if (now.ok && now.ino === cached.ino && now.size === cached.size && now.mtimeMs === cached.mtimeMs) return { ok: true, ...cached };
      cache.contents.delete(key);
    }
    // RC3: a file that holds a value of the project's withheld files (a copy of
    // an .env value) is not sent either.
    const result = await readContained(root, relPath, { maxBytes: this.limits.maxFileBytes, sending: true, withheldValues: (await this.context.withheldValues?.()) || [] });
    if (!result.ok) return result;
    const file = { relPath, text: result.text, sha256: result.sha256, size: result.size, mtimeMs: result.mtimeMs, ino: result.ino };
    if (cache?.put) cache.put(key, file);
    return { ok: true, ...file };
  }

  // A listed file, or why not.
  async #listedFile(raw, signal) {
    const checked = checkToolPath(raw);
    if (!checked.ok) return checked;
    const listing = await this.#listing(signal);
    if (!listing.set.has(checked.relPath)) return refuse('missing', 'not in the project listing (absent, excluded, or a link)');
    return { ok: true, relPath: checked.relPath };
  }

  // A proposal for a listed file: the path is the host's, never the model's
  // alone. The result carries no project text.
  async #propose(args, signal) {
    const listed = await this.#listedFile(args.path, signal);
    if (!listed.ok) {
      // Recorded so the user learns that a change was asked for and refused.
      this.context.proposeRefused?.({ path: String(args.path).slice(0, 260), reason: listed.reason });
      return listed;
    }
    return this.context.propose({ relPath: listed.relPath, summary: args.summary, edits: args.edits });
  }

  async #run(name, args, signal) {
    switch (name) {
      case 'project_summary': return this.#summary(signal);
      case 'project_list_directory': return this.#listDirectory(args.path, signal);
      case 'project_find_files': return this.#findFiles(args.query, signal);
      case 'project_search_text': return this.#searchText(args.query, signal);
      case 'project_read_file': return this.#readFile(args.path, args.start_line, args.end_line, signal);
      case 'project_open_documents': return this.#openDocuments(signal);
      default: return refuse('unknown-tool');
    }
  }

  async #summary(signal) {
    const listing = await this.#listing(signal);
    const top = new Map();
    const extensions = new Map();
    for (const relPath of listing.files) {
      const slash = relPath.indexOf('/');
      const name = slash < 0 ? relPath : `${relPath.slice(0, slash)}/`;
      top.set(name, (top.get(name) || 0) + 1);
      const base = relPath.slice(relPath.lastIndexOf('/') + 1);
      const dot = base.lastIndexOf('.');
      const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '(none)';
      extensions.set(extension, (extensions.get(extension) || 0) + 1);
    }
    const topLevel = [...top.keys()].sort(byPath);
    const overview = [];
    const sources = [];
    const candidates = listing.files.filter((relPath) => !relPath.includes('/') && OVERVIEW_FILE.test(relPath))
      .sort((a, b) => (/^readme/i.test(b) - /^readme/i.test(a)) || byPath(a, b))
      .slice(0, this.limits.maxOverviewFiles);
    for (const relPath of candidates) {
      if (signal?.aborted) return refuse('cancelled');
      const file = await this.#read(relPath);
      if (!file.ok) {
        overview.push({ path: relPath, refused: file.reason });
        continue;
      }
      const { text, endLine } = clip(file.text.split(/\r\n|\r|\n/), 1, this.limits.overviewLines, this.limits.overviewChars);
      overview.push({ path: relPath, lines: `1-${endLine}`, text });
      sources.push({ relPath, fileSha256: file.sha256, startLine: 1, endLine });
    }
    return {
      ok: true,
      project: this.context.label,
      files: listing.files.length,
      truncated: Boolean(listing.truncated) || topLevel.length > this.limits.maxTopLevel,
      topLevel: topLevel.slice(0, this.limits.maxTopLevel),
      extensions: Object.fromEntries([...extensions].sort((a, b) => b[1] - a[1] || byPath(a[0], b[0])).slice(0, 15)),
      overview,
      sources
    };
  }

  async #listDirectory(raw, signal) {
    let prefix = '';
    if (raw !== null && raw !== '' && raw !== '.' && raw !== '/') {
      const checked = checkToolPath(raw, { directory: true });
      if (!checked.ok) return checked;
      prefix = `${checked.relPath}/`;
    }
    const listing = await this.#listing(signal);
    const entries = new Set();
    for (const relPath of listing.files) {
      if (!relPath.startsWith(prefix)) continue;
      const rest = relPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      entries.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`);
    }
    if (prefix && !entries.size) return refuse('not-directory', 'not a folder in the project listing');
    const sorted = [...entries].sort(byPath);
    return { ok: true, path: prefix ? prefix.slice(0, -1) : '.', entries: sorted.slice(0, this.limits.maxListEntries), truncated: sorted.length > this.limits.maxListEntries || Boolean(listing.truncated) };
  }

  async #findFiles(query, signal) {
    const parsed = tokenize(query);
    if (!parsed.terms.length && !parsed.files.length) return refuse('invalid-arguments', 'no searchable words');
    const listing = await this.#listing(signal);
    const ranked = listing.files.map((relPath) => ({ relPath, score: rankPath(relPath, parsed).base }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || byPath(a.relPath, b.relPath));
    return { ok: true, query, paths: ranked.slice(0, this.limits.maxFindResults).map((item) => item.relPath), truncated: ranked.length > this.limits.maxFindResults || Boolean(listing.truncated) };
  }

  async #searchText(query, signal) {
    const needle = query.trim().toLowerCase();
    if (needle.length < this.limits.minSearchChars) return refuse('invalid-arguments', 'query too short');
    const listing = await this.#listing(signal);
    const deadline = Date.now() + this.limits.readMs;
    const matches = [];
    const sources = [];
    let bytes = 0;
    let truncated = Boolean(listing.truncated);
    let scanned = 0;
    // Files most likely to hold the text are read first, within the time
    // limit: names matching the query, then the open files, then the rest in
    // listing order (Phase 12: a large tree can use the limit up before the
    // relevant folder is reached).
    const parsed = tokenize(query);
    const editor = this.context.editor || {};
    const signals = { activeRelPath: editor.activeRelPath, openRelPaths: (editor.openDocuments || []).map((document) => document.relPath) };
    const order = listing.files.map((relPath, index) => ({ relPath, index, score: rankPath(relPath, parsed, signals).score }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.relPath);
    // Read in fixed batches, as the local selection does; results are taken in
    // `order`, so the outcome does not depend on which read finishes first.
    scan: for (let start = 0; start < order.length; start += SEARCH_BATCH) {
      if (signal?.aborted) return refuse('cancelled');
      if (matches.length >= this.limits.maxSearchResults) { truncated = true; break; }
      if (Date.now() > deadline || bytes >= this.limits.maxReadBytes) { truncated = true; break; }
      const batch = order.slice(start, start + SEARCH_BATCH);
      const files = await Promise.all(batch.map((relPath) => this.#read(relPath)));
      for (let item = 0; item < batch.length; item += 1) {
        const relPath = batch[item];
        const file = files[item];
        scanned += 1;
        if (!file.ok) continue;
        if (bytes + file.size > this.limits.maxReadBytes) { truncated = true; break scan; }
        bytes += file.size;
        const lines = file.text.split(/\r\n|\r|\n/);
        let first;
        let last;
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(needle)) continue;
          if (matches.length >= this.limits.maxSearchResults) { truncated = true; break; }
          const line = index + 1;
          matches.push({ path: relPath, line, preview: lines[index].trim().slice(0, this.limits.maxPreviewChars) });
          first ??= line;
          last = line;
        }
        if (first !== undefined) sources.push({ relPath, fileSha256: file.sha256, startLine: first, endLine: last });
      }
    }
    return { ok: true, query, matches, scanned, truncated, sources };
  }

  async #readFile(raw, startLine, endLine, signal) {
    const listed = await this.#listedFile(raw, signal);
    if (!listed.ok) return listed;
    const file = await this.#read(listed.relPath);
    if (!file.ok) return refuse(file.reason);
    const lines = file.text.split(/\r\n|\r|\n/);
    const start = Math.max(1, startLine ?? 1);
    if (start > lines.length) return refuse('invalid-arguments', `the file has ${lines.length} lines`);
    const wanted = Math.min(lines.length, endLine ?? lines.length, start + this.limits.maxReadLines - 1);
    if (wanted < start) return refuse('invalid-arguments', 'end_line is before start_line');
    const { text, endLine: last } = clip(lines, start, wanted - start + 1, this.limits.maxOutputChars - 400, true);
    return {
      ok: true,
      path: listed.relPath,
      lines: `${start}-${last}`,
      totalLines: lines.length,
      truncated: last < Math.min(lines.length, endLine ?? lines.length),
      text,
      sources: [{ relPath: listed.relPath, fileSha256: file.sha256, startLine: start, endLine: last }]
    };
  }

  async #openDocuments(signal) {
    const listing = await this.#listing(signal);
    const editor = this.context.editor || {};
    const documents = (editor.openDocuments || [])
      .filter((document) => listing.set.has(document.relPath))
      .slice(0, this.limits.maxOpenDocuments)
      .map((document) => ({ path: document.relPath, active: document.relPath === editor.activeRelPath, dirty: Boolean(document.dirty) }));
    return { ok: true, documents, note: documents.some((document) => document.dirty) ? 'Files marked dirty have unsaved changes; project_read_file returns the saved text.' : undefined };
  }
}

const LIST_FIELD = { project_summary: 'overview', project_list_directory: 'entries', project_find_files: 'paths', project_search_text: 'matches', project_open_documents: 'documents' };

// Shrinks a result until its JSON fits `room` characters: items are dropped
// from the end of its list (marked truncated), and the recorded sources keep
// only what is still returned. A result that cannot fit becomes a 'budget'
// refusal; nothing partial past the turn total is returned.
function fitOutput(name, result, room) {
  const size = (value) => { const { sources, ...visible } = value; return JSON.stringify({ tool: name, ...visible }).length; };
  if (size(result) <= room) return result;
  const field = LIST_FIELD[name];
  let current = { ...result };
  if (field && Array.isArray(current[field])) {
    const items = current[field].slice();
    if (name === 'project_summary') current.topLevel = current.topLevel.slice(0, 20);
    while (items.length && size({ ...current, [field]: items, truncated: true }) > room) items.pop();
    current = { ...current, [field]: items, truncated: true };
    if (current.sources) {
      if (name === 'project_search_text') {
        const kept = new Map();
        for (const match of items) {
          const entry = kept.get(match.path) || { startLine: match.line, endLine: match.line };
          entry.startLine = Math.min(entry.startLine, match.line);
          entry.endLine = Math.max(entry.endLine, match.line);
          kept.set(match.path, entry);
        }
        current.sources = current.sources.filter((source) => kept.has(source.relPath)).map((source) => ({ ...source, ...kept.get(source.relPath) }));
      } else if (name === 'project_summary') {
        const kept = new Set(items.filter((item) => item.text !== undefined).map((item) => item.path));
        current.sources = current.sources.filter((source) => kept.has(source.relPath));
      }
    }
  }
  return size(current) <= room ? current : refuse('budget');
}

// Whole lines from `start` (1-based), at most `count` lines and `maxChars`
// characters; numbered when asked. Returns { text, endLine }.
function clip(lines, start, count, maxChars, numbered = false) {
  const out = [];
  let chars = 0;
  let endLine = start - 1;
  for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index += 1) {
    const line = numbered ? `${index + 1}: ${lines[index]}` : lines[index];
    if (chars + line.length + 1 > maxChars && out.length) break;
    out.push(line.length > maxChars ? line.slice(0, maxChars) : line);
    chars += line.length + 1;
    endLine = index + 1;
  }
  return { text: out.join('\n'), endLine };
}

// For tests and the editor adapter: project-relative form of a file path
// inside `folderPath`, or undefined when it is outside or not allowed.
function relativeInside(folderPath, filePath) {
  if (typeof folderPath !== 'string' || typeof filePath !== 'string') return undefined;
  const relative = path.relative(folderPath, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const checked = checkToolPath(relative);
  return checked.ok ? checked.relPath : undefined;
}

module.exports = { TOOL_DEFINITIONS, TOOL_LIMITS, TOOL_NAMES, ToolTurn, checkToolPath, relativeInside, validateCall };
