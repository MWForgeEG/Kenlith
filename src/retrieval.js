'use strict';

// Local project retrieval (M1-1B): finds the parts of the active project
// folder that are relevant to a question, within fixed bounds, and returns
// them as excerpts held in memory. It never sends anything: whether excerpts
// may leave the computer is decided elsewhere (the consent gate). It does not
// require 'vscode'; the caller passes the folder and the exclude settings.
//
// API
//   retrieve({ root, query, settings: { filesExclude, searchExclude }, limits, signal, symbols, cache })
//     -> Promise<{
//          status: 'ok' | 'no-match' | 'cancelled' | 'unavailable',
//          reason?,                       // for 'unavailable': a resolveRoot reason
//          excerpts: [{ relPath, startLine, endLine, text, fileSha256, chars }],
//          withheld: [{ relPath, reason, category? }],
//          stats: { listed, scanned, read, bytesRead, ms, truncated, timedOut, cacheHits }
//        }>
//     `root`: the folder path (resolved again here with resolveRoot).
//     `limits`: overrides of DEFAULT_LIMITS.
//     `signal`: an AbortSignal; cancellation returns 'cancelled' promptly.
//     `symbols(relPath)`: optional, returns ranges [{ startLine, endLine }]
//       (1-based) of symbols in a file, used to snap an excerpt to the
//       enclosing function or class. Missing, failing or slow providers are
//       ignored (path and text ranking still work).
//     `cache`: optional, from createCache(); keeps the file list for a short
//       time and file text keyed by (path, size, modification time, file id).
//   createCache({ listingTtlMs }) -> { invalidate(relPath?), stats() }
//   tokenize(query) -> { terms, files }
//
// Walking: our own breadth-first walk with lstat-typed directory entries.
// Symbolic links, junctions and other links are never followed (reported as
// withheld 'link' when their name matches the question). Directories and
// files are skipped by the built-in exclusions, by files.exclude and
// search.exclude (src/glob.js), and by the security rules
// (src/workspace-safety.js), which no setting can change. Every file read
// goes through readContained().
//
// Ranking is deterministic: path and name matches weigh more than content
// matches, a file named in the question weighs most, and ties are broken by
// the relative path.

const fs = require('node:fs');
const path = require('node:path');
const { compileExcludes } = require('./glob');
const { classifySensitive, hasBinaryExtension, readContained, resolveRoot, statContained } = require('./workspace-safety');

const DEFAULT_LIMITS = Object.freeze({
  discoveryMs: 2000,      // listing the folder
  readMs: 1500,           // reading and scoring candidates
  maxFiles: 20000,        // files listed
  maxFileBytes: 512 * 1024,
  maxReadBytes: 2 * 1024 * 1024,
  maxExcerpts: 6,
  maxChars: 12000,        // all excerpts together
  maxExcerptsPerFile: 2,
  windowLines: 10,        // lines kept around a match
  maxSymbolLines: 80,     // a symbol longer than this is not used as the excerpt
  symbolTimeoutMs: 300
});

// Layer A: folders never walked (compared without case distinction).
const SKIPPED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.venv', 'venv', 'vendor', 'target', 'bin', 'obj', '.next', 'coverage', '__pycache__', '.svn', '.hg',
  // 0.5.0: caches, editor and tool folders, temporary folders (docs/kenlith-0.5.0/CAPABILITY-SPEC.md §3).
  '.cache', '.parcel-cache', '.turbo', '.gradle', '.idea', '.vs', '.pytest_cache', '.mypy_cache', '.tox', 'tmp', 'temp', '.terraform',
  '.serverless', '.angular', '.nuxt', '.svelte-kit', '.yarn', 'bower_components', 'jspm_packages'
]);
const isSkippedDirectory = (name) => SKIPPED_DIRECTORIES.has(String(name).toLowerCase());
// 0.5.0: operating-system noise files, never listed (compared without case).
const SKIPPED_FILES = new Set(['.ds_store', 'desktop.ini', 'thumbs.db', 'ehthumbs.db', '.localized']);

// Files that describe a project, read first for an overview question (0.5.0).
const OVERVIEW_FILE = /^(readme(\.[a-z0-9]+)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|composer\.json|[^/]+\.csproj|setup\.py|gemfile)$/i;
// A question about the file the user is looking at ("explain this", "this
// file"): only then may the active editor's file be chosen without any other
// match. Otherwise it only breaks ties, so a vague message does not pick it.
const ACTIVE_INTENT = /\b(this|current|open|active)\s+(file|code|module|function|class|component|script|page|test|method|snippet|selection)\b|\b(explain|review|summari[sz]e|describe|document)\s+(this|it)\b|\bwhat\s+(does|is)\s+this\b|هذا الملف|هذا الكود|هذه الوحدة|الملف الحالي|اشرح هذا|ما هذا/i;
const OVERVIEW_WORDS = new Set(['project', 'repo', 'repository', 'codebase', 'app', 'application', 'extension', 'overview', 'purpose', 'architecture', 'structure', 'about', 'summary', 'summarize', 'summarise', 'describe', 'give', 'high', 'level', 'quick', 'brief', 'short', 'general', 'main', 'مشروع', 'المشروع', 'التطبيق', 'الكود', 'ماذا', 'يفعل', 'هذا', 'عن']);
const OVERVIEW_INTENT = /\b(project|repo|repository|codebase|app|application|extension|overview|purpose|architecture|structure)\b|مشروع|المشروع|التطبيق|الكود/i;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'how',
  'why', 'what', 'when', 'where', 'which', 'who', 'does', 'did', 'this', 'that', 'these', 'those', 'with', 'from', 'into', 'about',
  'there', 'their', 'then', 'than', 'them', 'they', 'will', 'would', 'should', 'could', 'please', 'explain', 'tell', 'show', 'code',
  'file', 'files', 'function', 'project', 'work', 'works', 'working', 'make', 'use', 'used', 'using', 'get', 'set', 'its', 'also'
]);

// Files read together in one step (see the read phase in retrieve()).
const READ_BATCH = 8;

class Cancelled extends Error {}

// Ranking work is bounded however long the message is (a pasted log can
// hold thousands of words): only the start of the text is tokenized, and only
// the longest terms and the first file names are kept.
const QUERY_CHARS = 4000;
const MAX_TERMS = 32;
const MAX_FILE_NAMES = 16;
// One directory with more entries than this is not read further, and the
// list of withheld names is capped.
const MAX_DIR_ENTRIES = 50_000;
const MAX_SKIPPED = 2000;
// File text kept in memory between questions, at most.
const CACHE_BYTES = 8 * 1024 * 1024;

function tokenize(query) {
  const text = String(query || '').slice(0, QUERY_CHARS);
  const files = new Set();
  for (const match of text.matchAll(/[\p{L}\p{N}_\-./\\]+\.[A-Za-z0-9]{1,8}\b/gu)) {
    const name = match[0].split(/[\\/]/).pop().toLowerCase();
    if (name && !name.startsWith('.') && /[a-z0-9]/i.test(name)) files.add(name);
  }
  const terms = new Set();
  for (const word of text.match(/[\p{L}\p{N}_$]+/gu) || []) {
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
      .map((part) => part.toLowerCase());
    const whole = word.toLowerCase();
    for (const candidate of [whole, ...parts]) {
      if (candidate.length >= 3 && !STOP_WORDS.has(candidate) && !/^\d+$/.test(candidate)) terms.add(candidate);
    }
  }
  const kept = [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, MAX_TERMS);
  const parsed = { terms: kept.sort(), files: [...files].sort().slice(0, MAX_FILE_NAMES) };
  // A question about the project as a whole ("what does this project do?"):
  // its README and manifest are candidates even without a matching term.
  // Only when the question names nothing else ("where is auth in this app?"
  // is about auth, not an overview).
  if (OVERVIEW_INTENT.test(text) && parsed.terms.every((term) => OVERVIEW_WORDS.has(term)) && !parsed.files.length) parsed.overview = true;
  if (ACTIVE_INTENT.test(text)) parsed.active = true;
  return parsed;
}

function createCache({ listingTtlMs = 5000, maxBytes = CACHE_BYTES } = {}) {
  const listings = new Map();
  const contents = new Map();
  let hits = 0;
  let bytes = 0;
  return {
    listingTtlMs,
    listings,
    contents,
    hit() { hits += 1; },
    // Oldest entries leave first once the text kept passes maxBytes.
    put(key, file) {
      const old = contents.get(key);
      if (old) { bytes -= old.size || 0; contents.delete(key); }
      contents.set(key, file);
      bytes += file.size || 0;
      for (const [oldest, entry] of contents) {
        if (bytes <= maxBytes) break;
        contents.delete(oldest);
        bytes -= entry.size || 0;
      }
    },
    invalidate(relPath) {
      if (relPath === undefined) {
        listings.clear();
        contents.clear();
        bytes = 0;
        return;
      }
      for (const [key, entry] of contents) if (key.endsWith(`\u0000${relPath}`)) { contents.delete(key); bytes -= entry.size || 0; }
      listings.clear();
    },
    stats() { return { hits, listings: listings.size, contents: contents.size }; }
  };
}

const lowerName = (relPath) => relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();

function pathScore(relPath, query) {
  const lower = relPath.toLowerCase();
  const name = lowerName(relPath);
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  let score = 0;
  if (query.files.includes(name)) score += 20;
  for (const term of query.terms) {
    if (stem === term) score += 10;
    else if (name.includes(term)) score += 6;
    else if (lower.includes(term)) score += 3;
  }
  return score;
}

// 0.5.0 selection signals. `signals`: { activeRelPath, openRelPaths } from the
// editor (project-relative, forward slashes). Returns the rank of a path and
// why: `strong` means the path alone justifies reading it (a name or path
// match, the active editor's file, an overview file for an overview
// question); an open file is only a tie-breaker and needs a content match.
function rankPath(relPath, query, signals = {}) {
  const base = pathScore(relPath, query);
  const reasons = [];
  let boost = 0;
  if (query.files.includes(lowerName(relPath))) reasons.push('named in the question');
  else if (base > 0) reasons.push('name or path matches the question');
  let strong = base > 0;
  if (signals.activeRelPath === relPath) {
    boost += 6;
    if (query.active) strong = true;
    reasons.push('active editor file');
  } else if (Array.isArray(signals.openRelPaths) && signals.openRelPaths.includes(relPath)) {
    boost += 3;
    reasons.push('open in the editor');
  }
  if (query.overview && !relPath.includes('/') && OVERVIEW_FILE.test(relPath)) {
    boost += 40;
    strong = true;
    reasons.push('describes the project');
  }
  // `score` orders reading; the final rank weighs a path match four times
  // and adds the signal boost once, so a signal alone never outranks a file
  // that matches the question.
  return { score: base + boost, base, boost, strong, reasons };
}

// Walks the folder within the limits. Returns relative paths (forward
// slashes) in a deterministic order, and the links and sensitive names it
// skipped (filtered per question later, so the walk can be cached).
async function listFiles(root, settings, limits, check, deadline) {
  const matcher = compileExcludes(settings.filesExclude, settings.searchExclude);
  const files = [];
  const skipped = [];
  let truncated = false;
  let timedOut = false;
  const queue = [''];
  while (queue.length) {
    check();
    if (Date.now() > deadline) {
      timedOut = true;
      truncated = true;
      break;
    }
    const dirRel = queue.shift();
    let entries;
    try {
      const dir = await fs.promises.opendir(dirRel ? path.join(root, ...dirRel.split('/')) : root);
      entries = [];
      for await (const entry of dir) {
        entries.push(entry);
        if (entries.length >= MAX_DIR_ENTRIES || Date.now() > deadline) {
          truncated = true;
          break;
        }
      }
      // Closing an unfinished directory handle; ignore if already closed.
      await dir.close().catch(() => undefined);
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    const sibling = (name) => names.has(String(name).toLowerCase());
    for (const entry of entries) {
      const relPath = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (skipped.length < MAX_SKIPPED) skipped.push({ relPath, reason: 'link' });
        continue;
      }
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name)) continue;
        const sensitive = classifySensitive(`${relPath}/x`);
        if (sensitive.withheld) continue;
        if (matcher.excludes(relPath, sibling)) continue;
        queue.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIPPED_FILES.has(entry.name.toLowerCase())) continue;
      const sensitive = classifySensitive(relPath);
      if (sensitive.withheld) {
        if (skipped.length < MAX_SKIPPED) skipped.push({ relPath, reason: 'sensitive', category: sensitive.category });
        continue;
      }
      if (hasBinaryExtension(entry.name)) continue;
      if (matcher.excludes(relPath, sibling)) continue;
      if (files.length >= limits.maxFiles) {
        truncated = true;
        break;
      }
      files.push(relPath);
    }
    if (files.length >= limits.maxFiles) {
      truncated = true;
      break;
    }
  }
  return { files, skipped, truncated, timedOut };
}

// Counts of term hits per line.
function lineHits(lines, terms) {
  const hits = new Array(lines.length).fill(0);
  if (!terms.length) return hits;
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const term of terms) if (lower.includes(term)) hits[index] += 1;
  });
  return hits;
}

async function symbolRanges(symbols, relPath, limits) {
  if (typeof symbols !== 'function') return [];
  try {
    const ranges = await Promise.race([
      Promise.resolve().then(() => symbols(relPath)),
      new Promise((resolve) => setTimeout(() => resolve([]), limits.symbolTimeoutMs))
    ]);
    return Array.isArray(ranges)
      ? ranges.filter((range) => Number.isInteger(range?.startLine) && Number.isInteger(range?.endLine) && range.endLine >= range.startLine)
      : [];
  } catch {
    return [];
  }
}

async function excerptsFor(file, query, limits, symbols) {
  const lines = file.text.split(/\r\n|\r|\n/);
  const hits = lineHits(lines, query.terms);
  const order = hits
    .map((count, index) => ({ count, index }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);
  // A file chosen by name only: its beginning.
  if (!order.length) order.push({ count: 0, index: 0 });
  const ranges = await symbolRanges(symbols, file.relPath, limits);
  const windows = [];
  for (const { index } of order) {
    const line = index + 1;
    if (windows.some((window) => line >= window.startLine && line <= window.endLine)) continue;
    const enclosing = ranges
      .filter((range) => range.startLine <= line && range.endLine >= line && range.endLine - range.startLine + 1 <= limits.maxSymbolLines)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    const startLine = enclosing ? enclosing.startLine : Math.max(1, line - limits.windowLines);
    const endLine = Math.min(lines.length, enclosing ? enclosing.endLine : line + limits.windowLines);
    windows.push({ startLine, endLine });
    if (windows.length >= limits.maxExcerptsPerFile) break;
  }
  windows.sort((a, b) => a.startLine - b.startLine);
  // Merge overlapping or touching windows.
  const merged = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, window.endLine);
    else merged.push({ ...window });
  }
  return merged.map(({ startLine, endLine }) => ({ startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') }));
}

// RC3: `withheldValues(root, settings)` gives the values of the project's
// withheld files (from the engine; this module has no process access).
async function retrieve({ root, query, settings = {}, limits: overrides = {}, signal, symbols, cache, signals = {}, withheldValues: valuesOf } = {}) {
  const started = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const stats = { listed: 0, scanned: 0, read: 0, bytesRead: 0, ms: 0, truncated: false, timedOut: false, cacheHits: 0 };
  const done = (status, extra = {}) => ({ status, excerpts: [], withheld: [], ...extra, stats: { ...stats, ms: Date.now() - started } });
  const check = () => {
    if (signal?.aborted) throw new Cancelled();
  };

  try {
    check();
    const resolved = await resolveRoot(root);
    if (!resolved.ok) return done('unavailable', { reason: resolved.reason });
    const rootPath = resolved.root;
    // RC3: values of the project's withheld files; a file holding one is not sent.
    const withheldValues = typeof valuesOf === 'function' ? (await valuesOf(rootPath, settings)) || [] : [];
    const parsed = tokenize(query);
    if (!parsed.terms.length && !parsed.files.length && !parsed.overview && !(parsed.active && signals.activeRelPath)) return done('no-match');

    // ---- list ----
    let listing;
    const cachedListing = cache?.listings.get(rootPath);
    if (cachedListing && Date.now() - cachedListing.at < cache.listingTtlMs) {
      listing = cachedListing.value;
      cache.hit();
      stats.cacheHits += 1;
    } else {
      listing = await listFiles(rootPath, settings, limits, check, started + limits.discoveryMs);
      if (cache && !listing.timedOut) cache.listings.set(rootPath, { at: Date.now(), value: listing });
    }
    stats.listed = listing.files.length;
    stats.truncated = listing.truncated;
    stats.timedOut = listing.timedOut;
    // Links and sensitive names that match this question.
    const withheld = listing.skipped.filter((item) => pathScore(item.relPath, parsed) > 0).map((item) => ({ ...item }));

    // ---- order candidates: path matches first, then the rest ----
    const scored = listing.files.map((relPath) => ({ relPath, ...rankPath(relPath, parsed, signals) }));
    scored.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    // ---- read and score within the budgets ----
    // Candidates are read in fixed batches, in candidate order; reads inside
    // a batch run together and their results are taken in that same order,
    // so the outcome does not depend on which read finishes first.
    const readDeadline = Date.now() + limits.readMs;
    const files = [];
    const reportable = ['sensitive', 'credential-content', 'link', 'hard-link', 'outside-root', 'alias', 'changed'];
    const load = async (candidate, maxBytes) => {
      const key = `${rootPath}\u0000${candidate.relPath}`;
      const cached = cache?.contents.get(key);
      if (cached) {
        const now = await statContained(rootPath, candidate.relPath);
        if (now.ok && now.ino === cached.ino && now.size === cached.size && now.mtimeMs === cached.mtimeMs) return { cached: true, file: cached };
        cache.contents.delete(key);
      }
      const result = await readContained(rootPath, candidate.relPath, { maxBytes, sending: true, withheldValues });
      if (!result.ok) return { refused: result };
      const file = { relPath: candidate.relPath, text: result.text, sha256: result.sha256, size: result.size, mtimeMs: result.mtimeMs, ino: result.ino };
      return { file, key };
    };
    for (let start = 0; start < scored.length; start += READ_BATCH) {
      check();
      if (Date.now() > readDeadline) {
        stats.timedOut = true;
        stats.truncated = true;
        break;
      }
      const remaining = limits.maxReadBytes - stats.bytesRead;
      if (remaining <= 0) {
        stats.truncated = true;
        break;
      }
      const batch = scored.slice(start, start + READ_BATCH);
      const maxBytes = Math.min(limits.maxFileBytes, remaining);
      const loaded = await Promise.all(batch.map((candidate) => load(candidate, maxBytes)));
      check();
      for (let index = 0; index < batch.length; index += 1) {
        const candidate = batch[index];
        const outcome = loaded[index];
        stats.scanned += 1;
        if (outcome.refused) {
          const result = outcome.refused;
          if (reportable.includes(result.reason) && (candidate.base > 0 || result.reason === 'credential-content')) {
            withheld.push({ relPath: candidate.relPath, reason: result.reason, ...(result.category ? { category: result.category } : {}) });
          }
          continue;
        }
        let { file } = outcome;
        // The total budget, counted in candidate order, for cached text too.
        if (stats.bytesRead + file.size > limits.maxReadBytes) {
          stats.truncated = true;
          continue;
        }
        stats.bytesRead += file.size;
        if (outcome.cached) {
          cache.hit();
          stats.cacheHits += 1;
        } else {
          stats.read += 1;
          if (cache) (cache.put ? cache.put(outcome.key, file) : cache.contents.set(outcome.key, file));
        }
        const lines = file.text.split(/\r\n|\r|\n/);
        const hits = lineHits(lines, parsed.terms);
        const matched = new Set();
        for (const line of lines) {
          const lower = line.toLowerCase();
          for (const term of parsed.terms) if (lower.includes(term)) matched.add(term);
        }
        let content = 0;
        for (const count of hits) content += Math.min(count, 3);
        const score = candidate.base * 4 + candidate.boost + matched.size * 3 + Math.min(content, 30);
        if (candidate.strong || matched.size > 0) {
          const reasons = [...candidate.reasons];
          if (matched.size) reasons.push(`content matches ${matched.size} ${matched.size === 1 ? 'term' : 'terms'}`);
          files.push({ ...file, score, reasons });
        }
      }
    }

    files.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    // ---- excerpts within the character budget ----
    const excerpts = [];
    let chars = 0;
    for (const file of files) {
      check();
      if (excerpts.length >= limits.maxExcerpts || chars >= limits.maxChars) break;
      for (const part of await excerptsFor(file, parsed, limits, symbols)) {
        if (excerpts.length >= limits.maxExcerpts) break;
        const room = limits.maxChars - chars;
        if (room <= 0) break;
        let { text, endLine } = part;
        if (text.length > room) {
          // Whole lines only.
          const kept = text.slice(0, room).split('\n');
          if (kept.length > 1) kept.pop();
          text = kept.join('\n');
          endLine = part.startLine + kept.length - 1;
          stats.truncated = true;
        }
        if (!text) break;
        excerpts.push({ relPath: file.relPath, startLine: part.startLine, endLine, text, fileSha256: file.sha256, chars: text.length, reasons: file.reasons });
        chars += text.length;
      }
    }

    withheld.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    const unique = withheld.filter((item, index) => index === 0 || item.relPath !== withheld[index - 1].relPath);
    return { status: excerpts.length ? 'ok' : 'no-match', excerpts, withheld: unique, stats: { ...stats, ms: Date.now() - started } };
  } catch (error) {
    if (error instanceof Cancelled) return done('cancelled');
    throw error;
  }
}

module.exports = { DEFAULT_LIMITS, OVERVIEW_FILE, SKIPPED_DIRECTORIES, createCache, isSkippedDirectory, listFiles, pathScore, rankPath, retrieve, tokenize };
