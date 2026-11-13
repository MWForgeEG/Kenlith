'use strict';

// Kenlith 0.7.0 controlled execution: the request (docs/kenlith-0.7.0/ARCHITECTURE.md §1, §3).
//
// The model's tools ask for a run; the host resolves what would actually run:
// the real working directory inside the project, the executable found by the
// host (a bare name on the host PATH, never in the project folder; or a
// project-relative regular file), path arguments checked against the project,
// a validated environment delta and a bounded timeout. The result is a frozen
// canonical execution with a digest that an approval is bound to. Nothing the
// model says is used as a host path without these checks.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { checkRelative } = require('./workspace-safety');
const { isInside } = require('./attachments');

const RUN_TOOL = 'project_run_command';
const TASK_TOOL = 'project_run_task';

const EXEC_LIMITS = Object.freeze({
  maxArgumentChars: 16_000,
  maxArgs: 64,
  maxArgChars: 1_000,
  maxArgvChars: 8_000,
  maxEnv: 10,
  maxEnvValueChars: 1_000,
  maxPurposeChars: 300,
  maxLabelChars: 200,
  defaultTimeoutSeconds: 120,
  maxTimeoutSeconds: 600,
  maxRunsPerReply: 5
});

const RUN_TOOL_DEFINITION = Object.freeze({
  type: 'function',
  name: RUN_TOOL,
  description: 'Run one program in the open project and get its exit code and bounded output. The program and arguments are given separately (no shell string). Kenlith decides how risky the run is: safe local checks such as tests, linters, type checks and read-only git commands run directly; anything with side effects (network, installs, file or git changes, shells) waits for the user to approve it; dangerous or out-of-project runs are refused. Use it to verify, not to change files: propose file edits with project_propose_edit.',
  strict: true,
  parameters: Object.freeze({
    type: 'object',
    properties: {
      executable: { type: 'string', description: 'Program name found on PATH (for example git, npm, node), or a project-relative path. No absolute paths.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one per item, at most 64.' },
      cwd: { type: ['string', 'null'], description: 'Project-relative working folder, or null for the project folder.' },
      timeout_seconds: { type: ['integer', 'null'], description: 'At most 600; null for 120.' },
      env: {
        type: 'array',
        description: 'Environment variables to set for this run (at most 10). Usually empty.',
        items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'], additionalProperties: false }
      },
      purpose: { type: 'string', description: 'One sentence: why this run is needed. Shown to the user.' }
    },
    required: ['executable', 'args', 'cwd', 'timeout_seconds', 'env', 'purpose'],
    additionalProperties: false
  })
});

const TASK_TOOL_DEFINITION = Object.freeze({
  type: 'function',
  name: TASK_TOOL,
  description: 'Run one task of the open project\'s workspace (tasks.json or a task provider) by its label. Kenlith resolves what the task actually runs and treats it like project_run_command.',
  strict: true,
  parameters: Object.freeze({
    type: 'object',
    properties: { label: { type: 'string', description: 'The task label.' } },
    required: ['label'],
    additionalProperties: false
  })
});

const refuse = (code, detail, extra = {}) => ({ ok: false, code, ...(detail ? { detail } : {}), ...extra });

function parseJson(raw) {
  if (typeof raw !== 'string' || raw.length > EXEC_LIMITS.maxArgumentChars) return refuse('invalid-arguments', 'size');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('invalid-arguments', 'not an object');
    return { ok: true, value };
  } catch {
    return refuse('invalid-arguments', 'not JSON');
  }
}

const sameKeys = (value, keys) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hasNul = (s) => s.includes('\u0000');
// Controls other than tab and newline, and bidirectional or invisible format
// characters: a command holding them is refused (the card must show exactly
// what runs).
const HIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

// The model's arguments for project_run_command.
function validateRunArguments(raw) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  const a = parsed.value;
  if (!sameKeys(a, ['executable', 'args', 'cwd', 'timeout_seconds', 'env', 'purpose'])) return refuse('invalid-arguments', 'fields must be executable, args, cwd, timeout_seconds, env, purpose');
  if (typeof a.executable !== 'string' || !a.executable || a.executable.length > 260 || hasNul(a.executable)) return refuse('invalid-arguments', 'executable');
  if (!Array.isArray(a.args) || a.args.length > EXEC_LIMITS.maxArgs || a.args.some((x) => typeof x !== 'string' || x.length > EXEC_LIMITS.maxArgChars || hasNul(x))) return refuse('invalid-arguments', 'args');
  if (a.args.reduce((n, x) => n + x.length, 0) > EXEC_LIMITS.maxArgvChars) return refuse('invalid-arguments', 'args too long');
  if (a.cwd !== null && (typeof a.cwd !== 'string' || a.cwd.length > 260 || hasNul(a.cwd))) return refuse('invalid-arguments', 'cwd');
  if (a.timeout_seconds !== null && (!Number.isSafeInteger(a.timeout_seconds) || a.timeout_seconds < 1)) return refuse('invalid-arguments', 'timeout_seconds');
  if (!Array.isArray(a.env) || a.env.length > EXEC_LIMITS.maxEnv) return refuse('invalid-arguments', `env: at most ${EXEC_LIMITS.maxEnv}`);
  for (const e of a.env) {
    if (!e || typeof e !== 'object' || !sameKeys(e, ['name', 'value'])) return refuse('invalid-arguments', 'env entry');
    if (typeof e.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.name)) return refuse('invalid-arguments', 'env name');
    if (typeof e.value !== 'string' || e.value.length > EXEC_LIMITS.maxEnvValueChars || hasNul(e.value)) return refuse('invalid-arguments', 'env value');
  }
  if (typeof a.purpose !== 'string' || a.purpose.length > EXEC_LIMITS.maxPurposeChars) return refuse('invalid-arguments', 'purpose');
  return { ok: true, args: { executable: a.executable, args: a.args.slice(), cwd: a.cwd, timeoutSeconds: a.timeout_seconds, env: a.env.map(({ name, value }) => ({ name, value })), purpose: a.purpose } };
}

function validateTaskArguments(raw) {
  const parsed = parseJson(raw);
  if (!parsed.ok) return parsed;
  const a = parsed.value;
  if (!sameKeys(a, ['label']) || typeof a.label !== 'string' || !a.label || a.label.length > EXEC_LIMITS.maxLabelChars || hasNul(a.label)) return refuse('invalid-arguments', 'label');
  return { ok: true, args: { label: a.label } };
}

const isAbsoluteLike = (value) => /^[A-Za-z]:/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || path.isAbsolute(value);
const inside = (child, root) => isInside(child, root) || (process.platform === 'win32' && child.toLowerCase().startsWith(root.toLowerCase() + path.sep)) || child.toLowerCase() === root.toLowerCase();

function realOrUndefined(p) {
  try { return path.normalize(fs.realpathSync.native(p)); } catch { return undefined; }
}

// The working folder: project-relative, a real folder (not a link), inside the root.
function resolveCwd(root, rel) {
  if (rel === null || rel === '' || rel === '.') return { ok: true, cwd: root, cwdRel: '.' };
  if (isAbsoluteLike(rel)) return refuse('outside-project', 'the working folder must be inside the project', { cls: 'C' });
  const checked = checkRelative(String(rel).replace(/\\/g, '/'));
  if (!checked.ok) return refuse('outside-project', `working folder: ${checked.detail || checked.reason}`, { cls: 'C' });
  const candidate = path.join(root, ...checked.segments);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return refuse('missing', 'the working folder does not exist', { cls: 'C' }); }
  if (stat.isSymbolicLink()) return refuse('link', 'the working folder is a link', { cls: 'C' });
  if (!stat.isDirectory()) return refuse('not-folder', 'the working folder is not a folder', { cls: 'C' });
  const real = realOrUndefined(candidate);
  if (!real || real !== path.normalize(candidate) || !inside(real, root)) return refuse('outside-project', 'the working folder resolves outside the project', { cls: 'C' });
  return { ok: true, cwd: real, cwdRel: checked.relPath };
}

// The executable: a bare name on the host PATH (never searched in the
// project), or a project-relative regular file inside the root.
function resolveExecutable(root, name, hostEnv, platform = process.platform) {
  if (isAbsoluteLike(name)) return refuse('outside-project', 'absolute program paths are not accepted; give a program name or a project-relative path', { cls: 'C' });
  if (/[\\/]/.test(name)) {
    const checked = checkRelative(name.replace(/\\/g, '/'));
    if (!checked.ok) return refuse('outside-project', `program path: ${checked.detail || checked.reason}`, { cls: 'C' });
    const candidate = path.join(root, ...checked.segments);
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { return refuse('not-found', `program not found: ${checked.relPath}`); }
    if (stat.isSymbolicLink() || !stat.isFile()) return refuse('link', 'the program is a link or not a file', { cls: 'C' });
    const real = realOrUndefined(candidate);
    if (!real || !inside(real, root)) return refuse('outside-project', 'the program resolves outside the project', { cls: 'C' });
    return { ok: true, path: real, size: stat.size, mtimeMs: stat.mtimeMs, projectLocal: true };
  }
  if (!/^[A-Za-z0-9._+-]{1,100}$/.test(name)) return refuse('invalid-arguments', 'program name');
  const env = hostEnv || process.env;
  const pathValue = env.PATH || env.Path || '';
  const dirs = pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32'
    ? (path.extname(name) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()))
    : [''];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue; // a relative PATH entry would search the project
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      let stat;
      try { stat = fs.statSync(candidate); } catch { continue; }
      if (!stat.isFile()) continue;
      if (platform !== 'win32' && !(stat.mode & 0o111)) continue;
      if (inside(path.normalize(candidate), root)) continue; // never a program inside the project by bare name
      return { ok: true, path: path.normalize(candidate), size: stat.size, mtimeMs: stat.mtimeMs, projectLocal: false };
    }
  }
  return refuse('not-found', `program not found on PATH: ${name}`);
}

// Programs that take Windows "/x" switches (one-segment values are switches,
// not paths, only for them; for every other program "/Users" is C:\Users).
const SLASH_SWITCH_PROGRAMS = new Set(['cmd', 'robocopy', 'xcopy', 'taskkill', 'where', 'findstr', 'icacls', 'sc', 'reg', 'net', 'tasklist', 'ipconfig', 'systeminfo', 'whoami', 'attrib', 'dir', 'del', 'erase', 'copy', 'move', 'timeout', 'choice', 'schtasks', 'wmic', 'shutdown', 'fc', 'sort', 'more', 'tree', 'msiexec', 'runas', 'takeown', 'cipher', 'bcdedit']);

// The real path of `candidate`, or of its longest existing ancestor joined
// with the rest (a link anywhere on the way is resolved).
function realPathOf(candidate) {
  let current = path.normalize(candidate);
  const rest = [];
  for (;;) {
    const real = realOrUndefined(current);
    if (real) return path.join(real, ...rest.reverse());
    const parent = path.dirname(current);
    if (parent === current) return path.normalize(candidate);
    rest.push(path.basename(current));
    current = parent;
  }
}

// An argument that names a path outside the project: absolute, drive, UNC,
// a relative path that climbs out of the working folder, a path through a
// link that resolves outside, in --x=value, or stuck to a short option (-o..\x).
function outsidePathArgument(arg, cwd, root, programName = '') {
  const values = [arg];
  const eq = arg.indexOf('=');
  if (arg.startsWith('-') && eq > 0) values.push(arg.slice(eq + 1));
  if (/^-[A-Za-z][^=]/.test(arg)) values.push(arg.slice(2));
  for (const value of values) {
    if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue; // URLs are judged by the policy
    if (process.platform === 'win32' && /^\/[^\\/]*$/.test(value) && SLASH_SWITCH_PROGRAMS.has(programName)) continue;
    const pathLike = isAbsoluteLike(value) || /[\\/]/.test(value) || value === '..' || fs.existsSync(path.resolve(cwd, value));
    if (!pathLike) continue;
    const resolved = path.resolve(cwd, value);
    if (!inside(path.normalize(resolved), root)) return value;
    if (!inside(realPathOf(resolved), root)) return value;
  }
  return undefined;
}

// The canonical execution for a validated request: { ok, execution } or a refusal.
function resolveExecution({ root, request, hostEnv = process.env, platform = process.platform, source = 'command', task }) {
  const fields = [request.executable, request.cwd, request.shellText, ...(request.args || []), ...(request.env || []).map((e) => e.value)];
  if (fields.some((value) => typeof value === 'string' && HIDDEN_CHARS.test(value))) {
    return refuse('hidden-characters', 'the command holds invisible or text-direction characters, so what is shown could differ from what runs', { cls: 'C' });
  }
  const cwd = resolveCwd(root, request.cwd);
  if (!cwd.ok) return cwd;
  const exe = resolveExecutable(root, request.executable, hostEnv, platform);
  if (!exe.ok) return exe;
  const programName = path.basename(exe.path, path.extname(exe.path)).toLowerCase();
  for (const arg of request.args) {
    const outside = outsidePathArgument(arg, cwd.cwd, root, programName);
    if (outside) return refuse('outside-project', `an argument names a path outside the project: ${outside}`, { cls: 'C' });
  }
  const timeout = request.timeoutSeconds === null || request.timeoutSeconds === undefined ? EXEC_LIMITS.defaultTimeoutSeconds : request.timeoutSeconds;
  if (timeout > EXEC_LIMITS.maxTimeoutSeconds) return refuse('timeout', `timeout above ${EXEC_LIMITS.maxTimeoutSeconds} s`, { cls: 'C' });
  const ext = path.extname(exe.path).toLowerCase();
  const execution = {
    version: 1,
    source,
    ...(task ? { task } : {}),
    executable: exe.path,
    name: path.basename(exe.path, path.extname(exe.path)).toLowerCase(),
    launch: platform === 'win32' && (ext === '.cmd' || ext === '.bat') ? 'cmd' : (request.shellText !== undefined ? 'shell' : 'direct'),
    ...(request.shellText !== undefined ? { shellText: request.shellText } : {}),
    projectLocal: exe.projectLocal,
    exeSize: exe.size,
    exeMtimeMs: exe.mtimeMs,
    args: request.args.slice(),
    cwd: cwd.cwd,
    cwdRel: cwd.cwdRel,
    env: (request.env || []).map(({ name, value }) => ({ name, value })),
    timeoutMs: timeout * 1000,
    purpose: String(request.purpose || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  };
  execution.digest = executionDigest(execution);
  return { ok: true, execution: Object.freeze(execution) };
}

// Over everything that decides what runs (§4 approval identity).
function executionDigest(e) {
  const canonical = [e.executable, e.exeSize, e.exeMtimeMs, e.launch, e.shellText ?? null, e.args, e.cwd, e.env.map((x) => [x.name, x.value]), e.timeoutMs];
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = {
  EXEC_LIMITS,
  RUN_TOOL,
  RUN_TOOL_DEFINITION,
  TASK_TOOL,
  TASK_TOOL_DEFINITION,
  executionDigest,
  isAbsoluteLike,
  outsidePathArgument,
  resolveCwd,
  resolveExecutable,
  resolveExecution,
  validateRunArguments,
  validateTaskArguments
};
