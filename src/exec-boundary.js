'use strict';

// Kenlith 0.7.0 RC3 (DEC-PLANCHAT-036): the outbound boundary for command
// results. Nothing a command prints reaches ChatGPT before it has passed
// here; src/exec-output.js applies it to every result, and src/openai.js
// applies it again to every command result in every request, just before the
// request leaves (results repeated by the tool loop included).
//
// DEC-PLANCHAT-032: secrets, tokens, credentials, private keys and excluded
// content are never transmitted. The boundary has independent layers:
//
// 1. Files the read tools withhold (the same classifier, workspace-safety)
//    and files excluded by the user's files.exclude / search.exclude:
//    - git content reads (grep, diff, log, show, blame) get exclude
//      pathspecs, so git never reads those files, in any revision;
//    - a command whose arguments name such a file (`git show HEAD:.env`,
//      `git blame .env`, `node print.js .env`) runs as its class allows,
//      but its output is withheld (status only);
//    - git output is filtered again by file section (defense in depth).
// 2. Values found in the withheld files of the project (an .env value
//    printed by a test, for example), with their common encodings (base64,
//    base64url, hex, URL and JSON escaping) and any 12-character run of a
//    long value (a value cut across lines or partly printed).
// 3. Known credential formats, removed as whole lines, and private keys
//    removed as whole blocks.
// 4. Unknown secrets: long, high-entropy tokens are replaced.
// What cannot be established safely is withheld (fail closed), never asked
// about: no new card.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { classifySensitive } = require('./workspace-safety');
const { compileExcludes } = require('./glob');
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
const { GIT_HARDEN_ENV } = require('./exec-policy');
const { credentialLines } = require('./attachments');
const { isSensitiveKeyName } = require('./sensitive-text');
const { COMMAND_CREDENTIAL_PATTERNS, SECRET_WORDS, TOKEN, USERINFO, entropy, looksSecret, maskConfigSecrets, plainValue, removePrivateKeys } = require('./sensitive-text');

// ---------- withheld paths ----------

// The read tools' sensitive rules (workspace-safety classifySensitive and
// attachments classifyPath) as git globs. Every pattern here is withheld by
// classifySensitive (test/exec-boundary.test.js checks both directions);
// .env.example and the like are excluded here too (stricter than the read
// tools, which allow them).
const SENSITIVE_GLOBS = Object.freeze([
  '**/.env', '**/.env.*',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/*.ppk', '**/*.kdbx', '**/*.p8',
  '**/*.tfstate', '**/*.tfstate.*', '**/id_*',
  '**/.npmrc', '**/.pypirc', '**/.netrc', '**/_netrc', '**/.git-credentials', '**/.htpasswd', '**/kubeconfig',
  '**/credentials', '**/credentials.json',
  '**/.ssh', '**/.ssh/**', '**/.aws', '**/.aws/**', '**/.azure', '**/.azure/**', '**/.gnupg', '**/.gnupg/**',
  '**/.kube', '**/.kube/**', '**/.docker', '**/.docker/**'
]);
const MAX_PATHSPECS = 300;

// One {a,b} level, enough for the editor's exclude settings.
function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  return m[1].split(',').flatMap((alt) => expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
}

// The user's exclude settings ({ filesExclude, searchExclude }) as git globs.
// Entries with a `when` condition are not converted (they depend on sibling
// files); their files are still filtered from git output by section.
function settingsGlobs(settings = {}) {
  const out = [];
  for (const object of [settings.filesExclude, settings.searchExclude]) {
    if (!object || typeof object !== 'object') continue;
    for (const [pattern, value] of Object.entries(object).slice(0, 500)) {
      if (value !== true || !pattern || pattern.length > 1000) continue;
      for (let p of expandBraces(pattern)) {
        p = p.replace(/^\.\//, '').replace(/\\/g, '/');
        if (p.startsWith('/')) p = p.slice(1);
        else if (!p.startsWith('**/')) p = `**/${p}`;
        out.push(p, `${p.replace(/\/\*\*$/, '')}/**`);
      }
    }
  }
  return [...new Set(out)];
}

// Whether a project-relative path is withheld from ChatGPT.
function withheldMatcher(settings = {}) {
  const excluded = compileExcludes(settings.filesExclude, settings.searchExclude);
  return (relPath) => {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!rel || rel.startsWith('../')) return false;
    if (classifySensitive(rel).withheld) return true;
    const name = rel.split('/').pop().toLowerCase();
    // The env examples the read tools allow are still kept out of command output.
    if (name === '.env' || name.startsWith('.env.')) return true;
    try {
      // A folder pattern (**/private) excludes everything under that folder:
      // each parent folder is tested, as the read tools do while walking.
      const parts = rel.split('/');
      for (let i = 1; i <= parts.length; i += 1) if (excluded.excludes(parts.slice(0, i).join('/'))) return true;
      return false;
    } catch { return true; }
  };
}

// ---------- git content reads ----------

const GIT_CONTENT = new Set(['grep', 'diff', 'log', 'show', 'blame']);
const GIT_VALUED = { grep: ['-e', '-A', '-B', '-C', '--max-depth'], log: ['-n'], blame: ['-L'] };

// The revision part of `rev:path` (and `:path`, `:2:path`): the path.
function blobPath(arg) {
  if (arg.startsWith(':(') || arg.startsWith(':!') || arg.startsWith(':^') || arg.startsWith(':/')) return undefined;
  const m = /^(?:[^:]*:)(?:[0-3]:)?(.*)$/.exec(arg);
  return m && arg.includes(':') ? m[1] : undefined;
}

// Normalises a path operand of a git command to project-relative form.
function projectRelative(operand, cwd, root) {
  const abs = path.resolve(cwd, operand);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '.' : undefined;
  return rel.split(path.sep).join('/');
}

// The run form of a git content read: exclude pathspecs added after `--`,
// and whether its output must be withheld (an argument names a withheld
// file, or the form cannot be restricted safely). Returns
// { args, withhold?: reason }.
function gitPlan(args, { cwd, root, isWithheld, settings }) {
  const index = args.findIndex((a) => !a.startsWith('-'));
  const sub = index < 0 ? '' : args[index].toLowerCase();
  if (!GIT_CONTENT.has(sub)) return { args };
  const head = args.slice(0, index + 1);
  const rest = args.slice(index + 1);
  const valued = new Set(GIT_VALUED[sub] || []);
  const dash = rest.indexOf('--');
  const before = dash < 0 ? rest : rest.slice(0, dash);
  const after = dash < 0 ? [] : rest.slice(dash + 1);
  // Operands before `--` (options and their values skipped).
  const operands = [];
  let patternTaken = sub !== 'grep' || before.some((a) => a === '-e' || a.startsWith('-e'));
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i];
    if (a.startsWith('-') && a !== '-') {
      if (valued.has(a)) i += 1;
      continue;
    }
    if (!patternTaken) { patternTaken = true; continue; }
    operands.push({ arg: a, at: i });
  }
  const names = [];
  for (const { arg } of operands) {
    const blob = blobPath(arg);
    if (blob !== undefined) names.push(blob.replace(/^\.\//, ''));
  }
  // Operands that are paths in the work tree (git's own disambiguation).
  const pathOperands = operands.filter(({ arg }) => blobPath(arg) === undefined && fs.existsSync(path.resolve(cwd, arg)));
  for (const { arg } of pathOperands) names.push(projectRelative(arg, cwd, root));
  for (const arg of after) {
    if (/^:[(!^]/.test(arg)) continue; // pathspec magic: only narrows or is overridden by the excludes
    names.push(arg.startsWith(':/') ? projectRelative(arg.slice(2) || '.', root, root) : projectRelative(arg, cwd, root));
  }
  for (const name of names) {
    if (name === undefined) return { args, withhold: 'it names a path outside the project' };
    if (name !== '.' && isWithheld(name)) return { args, withhold: 'it reads a file Kenlith withholds from ChatGPT' };
  }
  if (sub === 'blame') return { args }; // one named file, checked above
  const excludes = [...SENSITIVE_GLOBS, ...settingsGlobs(settings)].map((g) => `:(top,exclude,glob,icase)${g}`);
  if (excludes.length > MAX_PATHSPECS) return { args, withhold: 'the project excludes too many paths to restrict this git read safely' };
  if (dash >= 0) return { args: [...head, ...rest, ...excludes] };
  if (pathOperands.length) {
    const first = pathOperands[0].at;
    return { args: [...head, ...before.slice(0, first), '--', ...before.slice(first), ...excludes] };
  }
  // A blob read (`rev:path`) is not limited by pathspecs; its path was checked.
  if (operands.some(({ arg }) => blobPath(arg) !== undefined)) return { args };
  return { args: [...head, ...rest, '--', ':/', ...excludes] };
}

// Defense in depth: drops the sections of git output that belong to a
// withheld file (diff, show and log patches; grep lines with a file name).
function filterGitOutput(text, sub, isWithheld) {
  if (!GIT_CONTENT.has(sub) || !text) return { text, removed: 0 };
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  let removed = 0;
  const unquote = (p) => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '');
  for (const line of lines) {
    const header = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")/.exec(line) || /^diff --(?:cc|combined) (.+)$/.exec(line);
    if (header) {
      skipping = header.slice(1).filter(Boolean).some((p) => isWithheld(unquote(p)));
      if (skipping) { removed += 1; out.push('[a file Kenlith withholds was left out]'); }
      if (!skipping) out.push(line);
      continue;
    }
    if (/^commit [0-9a-f]{7,64}\b/.test(line)) skipping = false;
    if (skipping) continue;
    if (sub === 'grep') {
      const m = /^(?:[0-9a-f]{7,64}:)?([^:\n]+):/.exec(line);
      if (m && isWithheld(m[1])) { removed += 1; continue; }
    }
    out.push(line);
  }
  return { text: out.join('\n'), removed };
}

// Whether a command names a withheld file (a program reading it would print
// it): path-like arguments, `--opt=value` values, git `rev:path` operands and
// the words of a shell command, resolved from the run folder; also a file
// that is the same file as a withheld one under another name (a hard link).
// Returns a reason, or undefined. A shell command with wildcards or
// variables cannot be resolved: it is treated as naming one (fail closed).
function namesWithheldFile(execution, root, isWithheld, index) {
  const isGit = execution.name === 'git';
  const cwd = execution.cwd || root;
  const candidates = [];
  for (const raw of execution.args || []) {
    const arg = String(raw);
    candidates.push(arg);
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0) candidates.push(arg.slice(eq + 1));
    if (isGit) { const blob = blobPath(arg); if (blob !== undefined) candidates.push(blob); }
  }
  if (typeof execution.shellText === 'string') {
    if (/[*?$%`]|![^=]/.test(execution.shellText)) return 'Kenlith cannot tell which files this shell command reads';
    // cmd.exe's ^ escapes the next character (type ^.env): removed first.
    for (const word of execution.shellText.replace(/\^/g, '').split(/[\s"'|&;<>()]+/)) {
      if (!word) continue;
      candidates.push(word);
      const eq = word.indexOf('=');
      if (eq > 0) candidates.push(word.slice(eq + 1));
    }
  }
  for (const value of candidates) {
    if (!value || value.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
    const rel = projectRelative(value, cwd, root);
    if (!rel || rel === '.') continue;
    if (isWithheld(rel)) return 'it reads a file Kenlith withholds from ChatGPT';
    if (index?.ids?.size) {
      try {
        const st = fs.statSync(path.join(root, rel));
        if (st.isFile() && index.ids.has(`${st.dev}:${st.ino}`)) return 'it reads a file Kenlith withholds from ChatGPT (under another name)';
      } catch { /* not a file */ }
    }
  }
  return undefined;
}

// ---------- values of withheld and excluded files ----------

// Bounds of the index. node_modules (third-party code) and .git are not
// walked: credential names there are kept out of git reads and arguments by
// name; withheld names in git history are read through git itself.
const INDEX_LIMITS = Object.freeze({ entries: 200000, depth: 40, files: 1000, fileBytes: 1024 * 1024, values: 20000, ordinaryFiles: 4000, ordinaryBytes: 64 * 1024 * 1024, historyBytes: 16 * 1024 * 1024, historyMs: 10000 });
const SKIP_WALK = new Set(['.git', 'node_modules']);
// The editor's default exclusions (not a user's choice of content to keep out).
const DEFAULT_EXCLUDES = new Set(['**/.git', '**/.svn', '**/.hg', '**/CVS', '**/.DS_Store', '**/Thumbs.db', '**/node_modules', '**/bower_components', '**/*.code-search', '**/.classpath', '**/.project', '**/.settings', '**/.factorypath']);
const TEXT_LIKE = /\.(js|cjs|mjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|conf|config|env|properties|xml|html?|css|scss|md|txt|py|rb|go|rs|java|kt|cs|php|sh|ps1|bat|cmd|sql|graphql|gradle|tf|dockerfile)$|(^|\/)(dockerfile|makefile|procfile)$/i;

// The values of one withheld file: every literal value of a `name = value`,
// `name: value` or JSON pair (6 characters or more, not plain), and every
// other line of 12 characters or more (key material).
// `sensitive` (a Set, optional) collects the values under a sensitive key.
function valuesOf(text, sensitive) {
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^-----(BEGIN|END) /.test(line)) continue;
    // A commented-out line (# OLD_PASSWORD=…) is content of the file too.
    const body = line.replace(/^(?:#|\/\/|;)\s*/, '');
    const m = /^(?:export\s+)?["']?([\w.\-]+)["']?\s*[:=]\s*(.*)$/.exec(body);
    if (m) {
      const value = m[2].replace(/,\s*$/, '').replace(/^["'`]|["'`]$/g, '').trim();
      if (value && sensitive && isSensitiveKeyName(m[1])) sensitive.add(value);
      if (value.length < 4) continue;
      // RC4 (DEC-PLANCHAT-038): every value is protected, plain words and the
      // key's own name included. Only values that carry no information under
      // an ordinary name are left: true/false/null-like words and numbers of
      // up to five digits (PORT=3000). Under a secret name they are protected.
      const secretKey = m[1].replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/).some((w) => SECRET_WORDS.has(w));
      if (!secretKey && (/^(true|false|null|none|yes|no|on|off)$/i.test(value) || /^\d{1,5}$/.test(value))) continue;
      out.push(value);
      continue;
    }
    if (body.length >= 4 && body === line) out.push(line);
    else if (body.length >= 12) out.push(body);
  }
  return out;
}

const variantsOf = (value) => {
  const set = new Set([value]);
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  set.add(b64);
  set.add(b64.replace(/=+$/, ''));
  set.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  set.add(Buffer.from(value, 'utf8').toString('hex'));
  try { set.add(encodeURIComponent(value)); } catch { /* lone surrogate */ }
  set.add(JSON.stringify(value).slice(1, -1));
  // The value itself whatever its length (a short password under a secret
  // name); its encodings only when long enough to be specific.
  return [...set].filter((v) => v === value || v.length >= 6);
};

// The history of withheld names, read with git itself (local; repository
// configuration cannot start programs). Returns { text, complete }.
function historyOfWithheld(root, limits) {
  if (!fs.existsSync(path.join(root, '.git'))) return { text: '', complete: true };
  const specs = SENSITIVE_GLOBS.map((g) => `:(top,glob,icase)${g}`);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
  for (const { name, value } of GIT_HARDEN_ENV) env[name] = value;
  const run = (args, extra = {}) => spawnSync('git', ['-c', 'log.showSignature=false', '--no-pager', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env, ...extra });
  // The same history needs reading once: keyed by every ref and HEAD.
  const refs = run(['for-each-ref', '--format=%(objectname) %(refname)'], { timeout: limits.historyMs, maxBuffer: limits.historyBytes });
  const head = run(['rev-parse', 'HEAD'], { timeout: limits.historyMs });
  const key = `${root}\n${refs.stdout || ''}\n${head.stdout || ''}`;
  if (HISTORY_CACHE.has(key)) return HISTORY_CACHE.get(key);
  const r = run(['log', '--all', '-p', '--format=', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...specs], { timeout: limits.historyMs, maxBuffer: limits.historyBytes });
  if (r.error || r.status !== 0) {
    // Not a repository, or git missing: there is no history to read. A timeout
    // or a full buffer means the history could not be read whole.
    const partial = r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ENOBUFS');
    return { text: '', complete: !partial && !(r.status && r.status !== 128) };
  }
  const lines = r.stdout.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => l.slice(1));
  const result = { text: lines.join('\n'), complete: true };
  if (HISTORY_CACHE.size > 20) HISTORY_CACHE.clear();
  HISTORY_CACHE.set(key, result);
  return result;
}
const HISTORY_CACHE = new Map();

// The values to protect for a project:
// { values, readValues, grams, ids, complete, files, reasons }.
// Sources: secret files in the work tree, secret names in git history, and
// the user's own exclusions (files.exclude / search.exclude beyond the
// editor's defaults). RC4 (DEC-PLANCHAT-038): no exemption for a value that
// an ordinary file also holds; command output never carries it. `readValues`
// (specific values only) is what the read tools refuse files for.
function buildIndex(root, { settings = {} } = {}, limits = INDEX_LIMITS) {
  const index = { values: [], readValues: [], sensitiveValues: [], shortSensitive: [], grams: new Set(), ids: new Set(), complete: true, files: 0, reasons: [] };
  if (!root) return index;
  const userOnly = {};
  for (const key of ['filesExclude', 'searchExclude']) {
    const object = settings[key];
    if (!object || typeof object !== 'object') continue;
    userOnly[key] = Object.fromEntries(Object.entries(object).filter(([pattern, value]) => value === true && !DEFAULT_EXCLUDES.has(pattern)));
  }
  const userExcluded = compileExcludes(userOnly.filesExclude, userOnly.searchExclude);
  const incomplete = (why) => { index.complete = false; if (!index.reasons.includes(why)) index.reasons.push(why); };
  let entries = 0;
  const raw = new Set();
  const sensitive = new Set();
  const readText = (full) => {
    const st = fs.statSync(full);
    if (st.size > limits.fileBytes) return undefined;
    return { text: fs.readFileSync(full, 'utf8'), st };
  };
  const walk = (dir, rel, depth, dirExcluded = false) => {
    if (depth > limits.depth) { incomplete('folders deeper than Kenlith checks'); return; }
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { incomplete('a folder Kenlith could not read'); return; }
    for (const entry of list) {
      if ((entries += 1) > limits.entries) { incomplete('more files than Kenlith checks'); return; }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_WALK.has(entry.name)) continue;
        let sub = dirExcluded;
        try { sub = sub || userExcluded.excludes(childRel); } catch { sub = true; }
        walk(full, childRel, depth + 1, sub);
        continue;
      }
      if (!entry.isFile()) continue;
      const withheld = classifySensitive(childRel).withheld || /(^|\/)\.env(\.|$)/i.test(childRel);
      let excluded = false;
      try { excluded = !withheld && (dirExcluded || userExcluded.excludes(childRel)); } catch { excluded = true; }
      if (withheld || excluded) {
        if ((index.files += 1) > limits.files) { incomplete('more withheld files than Kenlith checks'); continue; }
        let read;
        try { read = readText(full); } catch { incomplete('a withheld file Kenlith could not read'); continue; }
        if (!read) { incomplete('a withheld file larger than Kenlith checks'); continue; }
        index.ids.add(`${read.st.dev}:${read.st.ino}`);
        // Env templates (.env.example, .env.sample, .env.template) hold placeholders: no values.
        const template = /(^|\/)\.env\.(example|sample|template)$/i.test(childRel);
        const values = template ? [] : withheld ? valuesOf(read.text, sensitive) : read.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12);
        for (const value of values) raw.add(value);
      }
    }
  };
  walk(root, '', 0);
  const history = historyOfWithheld(root, limits);
  if (!history.complete) incomplete('git history Kenlith could not read whole');
  for (const value of valuesOf(history.text, sensitive)) raw.add(value);
  if (raw.size > limits.values) incomplete('more withheld values than Kenlith checks');
  for (const value of [...raw].slice(0, limits.values)) {
    for (const variant of variantsOf(value)) index.values.push(variant);
    // Runs of 12 characters for long values; not for addresses, whose parts
    // (a host name) are ordinary text.
    if (value.length >= 16 && !value.includes('://')) for (let i = 0; i + 12 <= value.length; i += 1) index.grams.add(value.slice(i, i + 12));
  }
  // RC5: values under a sensitive key. Four or more characters: removed
  // wherever they occur, also inside a longer token, with their encodings.
  // One to three characters: no safe replacement exists, so output that
  // contains one is withheld whole (fail closed), never globally redacted.
  for (const value of sensitive) {
    if (value.length >= 4) index.sensitiveValues.push(...variantsOf(value));
    else {
      // The value and its plain encodings (base64, hex), whatever their length.
      const b64 = Buffer.from(value, 'utf8').toString('base64');
      index.shortSensitive.push(value, b64, b64.replace(/=+$/, ''), Buffer.from(value, 'utf8').toString('hex'));
    }
  }
  index.sensitiveValues.sort((a, b) => b.length - a.length);
  // Longest first, so a value is replaced before a shorter one inside it.
  index.values.sort((a, b) => b.length - a.length);
  // The read tools refuse a file holding one of these (best effort; a plain
  // word or a short number in an ordinary file is ordinary text).
  index.readValues = [...raw].filter((v) => !/^[A-Za-z][a-z]{0,15}$/.test(v) && !/^\d{1,7}$/.test(v)).flatMap(variantsOf);
  return index;
}

// ---------- the guard ----------

// Applies layers 2 to 4 to one text. `index` from buildIndex (optional).
// Returns { text, counts: { withheldValues, credentialLines, privateKeys, highEntropy } }.
function guard(text, { index, credentialLines } = {}) {
  const counts = { withheldValues: 0, credentialLines: 0, privateKeys: 0, highEntropy: 0, unsafeShort: 0 };
  // RC5: a one-to-three-character value under a sensitive key anywhere in the
  // text: it cannot be removed without destroying ordinary text, so the
  // caller withholds the whole output (fail closed).
  if (index?.shortSensitive?.length && index.shortSensitive.some((v) => String(text).includes(v))) counts.unsafeShort = 1;
  let lines = String(text).split('\n');
  const keys = removePrivateKeys(lines);
  lines = keys.lines;
  counts.privateKeys = keys.removed;
  const flagged = new Set(typeof credentialLines === 'function' ? credentialLines(lines.join('\n')).map((n) => n - 1) : []);
  const out = lines.map((line, i) => {
    if (flagged.has(i) || COMMAND_CREDENTIAL_PATTERNS.some((re) => re.test(line))) { counts.credentialLines += 1; return '[credential-like line removed]'; }
    let next = line.replace(USERINFO, (m, scheme) => { counts.credentialLines += 1; return `${scheme}[credentials removed]@`; });
    const config = maskConfigSecrets(next);
    next = config.line;
    counts.credentialLines += config.count;
    if (index) {
      // RC5: a value under a sensitive key is removed wherever it occurs,
      // also joined to letters or digits (xxhorse99).
      for (const value of index.sensitiveValues || []) {
        if (next.includes(value)) { next = next.split(value).join('[redacted]'); counts.withheldValues += 1; }
      }
      for (const value of index.values) {
        if (!next.includes(value)) continue;
        if (value.length >= 8) { next = next.split(value).join('[redacted]'); counts.withheldValues += 1; continue; }
        // A short value only as a whole word (k9#x2, not part of a longer word or number).
        const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, 'g');
        next = next.replace(re, () => { counts.withheldValues += 1; return '[redacted]'; });
      }
      if (index.grams.size && next.length >= 12) {
        for (let k = 0; k + 12 <= next.length; k += 1) {
          if (index.grams.has(next.slice(k, k + 12))) { counts.withheldValues += 1; return '[line with part of a withheld value removed]'; }
        }
      }
    }
    return next.replace(TOKEN, (token) => {
      // Package integrity hashes (sha512-…) are public, not secrets.
      if (/^sha(?:1|256|384|512)-/.test(token)) return token;
      // Split at path separators: a long path is not one token.
      if (token.includes('/') && token.split('/').every((part) => !looksSecret(part))) return token;
      if (!looksSecret(token) && !token.split('/').some(looksSecret)) return token;
      counts.highEntropy += 1;
      return '[possible secret removed]';
    });
  });
  return { text: out.join('\n'), counts };
}

// The index for a folder, shared by the command boundary and the read tools,
// rebuilt after a few seconds or when asked.
const INDEX_CACHE = new Map();
function indexFor(root, settings = {}, { fresh = false } = {}) {
  const key = `${root}\n${JSON.stringify(settings || {})}`;
  const hit = INDEX_CACHE.get(key);
  if (hit && !fresh && Date.now() - hit.at < 5000) return hit.index;
  let index;
  try { index = buildIndex(root, { settings }); } catch { index = { values: [], grams: new Set(), ids: new Set(), complete: false, files: 0, reasons: ['the check failed'] }; }
  if (INDEX_CACHE.size > 20) INDEX_CACHE.clear();
  INDEX_CACHE.set(key, { at: Date.now(), index });
  return index;
}

module.exports = {
  indexFor,
  COMMAND_CREDENTIAL_PATTERNS,
  INDEX_LIMITS,
  SENSITIVE_GLOBS,
  buildIndex,
  filterGitOutput,
  gitPlan,
  guard,
  looksSecret,
  namesWithheldFile,
  settingsGlobs,
  valuesOf,
  withheldMatcher
};
