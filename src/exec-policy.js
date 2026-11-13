'use strict';

// Kenlith 0.7.0: deterministic risk classification of a resolved execution
// (DEC-PLANCHAT-030; docs/kenlith-0.7.0/ARCHITECTURE.md §3). Pure: no I/O.
//
// Class A must be proved, not presumed: a program is Class A only in a known
// read or validation form, and every option must be on that program's allow
// list (an unlisted option makes the run Class B, never A). Project scripts
// (npm/pnpm/yarn) are Class A only when the script, its pre/post scripts and
// every command in them are themselves Class A forms. Hard conditions
// (elevation, destructive or remote programs, credential access, unsafe
// .cmd arguments, denied environment names) make it Class C.
//
// Result: { cls, effects, reasons, harden } where `harden` is what Kenlith
// adds to a git run to stop repository configuration from starting programs
// (core.fsmonitor; external diff and textconv).

const ALLOWED_ENV = new Set(['CI', 'NO_COLOR', 'FORCE_COLOR', 'NODE_ENV', 'TZ']);
const DENIED_ENV = /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PSMODULEPATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|RUBYOPT|PERL5OPT|BASH_ENV|ENV|PROMPT_COMMAND|NPM_CONFIG_.*|YARN_.*|PNPM_.*|GIT_.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|DOTNET_.*|MSBUILD.*)$/i;
// Also names whose values usually embed a credential (connection strings,
// database URLs, webhooks, personal access tokens).
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|(^|_)PAT$|CONNECTION_?STRING|CONN_?STR|DATABASE_URL|DB_URL|_DSN$|^DSN$|WEBHOOK/i;
// cmd.exe quoting cannot be made safe for arbitrary text.
const CMD_SAFE_ARG = /^[A-Za-z0-9_\-.,:/=@+]*$/;

const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wsl', 'busybox']);
const ELEVATION = new Set(['runas', 'sudo', 'gsudo', 'psexec', 'psexec64', 'doas', 'su', 'pkexec']);
const DESTRUCTIVE = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'format', 'diskpart', 'reg', 'regedit', 'sc', 'net', 'shutdown', 'taskkill', 'icacls', 'takeown', 'cipher', 'bcdedit', 'mklink', 'attrib', 'schtasks', 'setx', 'wmic', 'vssadmin', 'fsutil', 'chmod', 'chown', 'mkfs', 'dd', 'kill', 'killall', 'pkill']);
const REMOTE_CLOUD = new Set(['ssh', 'scp', 'sftp', 'rsync', 'winrm', 'winrs', 'telnet', 'kubectl', 'helm', 'az', 'aws', 'gcloud', 'gsutil', 'terraform', 'pulumi', 'heroku', 'vercel', 'netlify', 'firebase', 'flyctl', 'doctl', 'oc', 'ansible', 'ansible-playbook']);
const NETWORK = new Set(['curl', 'wget', 'gh', 'docker', 'podman', 'ftp', 'nc', 'ncat', 'netcat', 'invoke-webrequest', 'invoke-restmethod', 'bitsadmin', 'certutil']);
const MACHINE_INFO = new Set(['whoami', 'hostname', 'systeminfo', 'ipconfig', 'ifconfig', 'uname', 'ver', 'tasklist', 'ps', 'netstat', 'arp', 'route', 'getmac', 'query']);
const ENV_DUMP = new Set(['set', 'env', 'printenv', 'export']);
const MUTATING_FILE_TOOLS = new Set(['copy', 'move', 'xcopy', 'cp', 'mv', 'mkdir', 'md', 'touch', 'ren', 'rename', 'robocopy', 'tar', 'unzip', 'zip', '7z']);
const INSTALLERS = new Set(['pip', 'pip3', 'pipx', 'poetry', 'conda', 'gem', 'bundle', 'composer', 'choco', 'winget', 'scoop', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'nuget', 'msiexec']);
const DOWNLOADERS = new Set(['npx', 'pnpx', 'bunx', 'dlx']);
const DANGEROUS_SHELL_TEXT = /\b(rm\s+-[a-z]*r|rm\s+-[a-z]*f|del\s+\/[sqf]|rmdir\s+\/s|rd\s+\/s|Remove-Item|format\s+[a-z]:|diskpart|reg\s+(add|delete)|Set-ItemProperty\s+.*HKLM|sc\s+(config|delete|stop)|Stop-Service|Set-ExecutionPolicy|-Verb\s+RunAs|Start-Process\b.*RunAs|runas|sudo|gsudo|shutdown|Restart-Computer|bcdedit|vssadmin|cipher\s+\/w|takeown|icacls|Get-ChildItem\s+env:|\bset\s*$|printenv|\benv\s*$|Invoke-Expression|iex\b|DownloadString|Add-MpPreference|net\s+user|net\s+localgroup)\b/i;
const NETWORK_SHELL_TEXT = /https?:\/\/|\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|npm\s+(i|install|ci|add)|pip\s+install|git\s+(push|pull|fetch|clone))\b/i;
const URL_ARG = /^[a-z][a-z0-9+.-]*:\/\/|^(data|file|javascript|blob|ftp|ssh):|^git@[^:]+:|^[^@\s/]+@[^:\s/]+:/i;
const VALIDATION_SCRIPT = /^(test|lint|typecheck|type-check|check|build|format:check|test:[\w:.-]+|lint:[\w:.-]+|check:[\w:.-]+)$/;

// ---------- option allow lists ----------
// spec: { flags: [...], valued: [...] (next argument or =value),
//   patterns: [RegExp] (whole token), operands: true|false }
const v = (...names) => names;
function optionsOk(args, spec) {
  const flags = new Set(spec.flags || []);
  const valued = new Set(spec.valued || []);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') return spec.operands !== false ? { ok: true } : { ok: false, bad: a };
    if (!a.startsWith('-') || a === '-') {
      if (spec.operands === false) return { ok: false, bad: a };
      continue;
    }
    if ((spec.patterns || []).some((re) => re.test(a))) continue;
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (flags.has(a)) continue;
    if (valued.has(name)) { if (!a.includes('=')) i += 1; continue; }
    return { ok: false, bad: a };
  }
  return { ok: true };
}

const GIT_FORMAT = [/^--(format|pretty|date|since|until|after|before|author|committer|grep|max-count|skip|abbrev|diff-filter|stat|unified|relative|find-renames|untracked-files|porcelain|sort|contains|merged|no-merged|points-at|ignored|color)=[^=]*$/, /^-\d+$/, /^-n\d+$/, /^-U\d+$/, /^-M\d*%?$/];
const GIT_READ_SPECS = {
  status: { flags: v('--short', '-s', '--branch', '-b', '--porcelain', '--long', '-u', '--ignored', '--no-renames', '--renames', '--ahead-behind', '--no-ahead-behind', '-v', '--verbose', '--show-stash'), patterns: GIT_FORMAT, operands: true },
  diff: { flags: v('--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--cached', '--staged', '-p', '--patch', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '--word-diff', '--no-renames', '--summary', '--check', '--no-color', '-R', '--raw', '--minimal', '--histogram', '--patience', '--exit-code', '--quiet', '--no-ext-diff', '--no-textconv'), patterns: GIT_FORMAT, operands: true },
  log: { flags: v('--oneline', '--graph', '--decorate', '--all', '--branches', '--tags', '--remotes', '--stat', '--shortstat', '--name-only', '--name-status', '-p', '--patch', '--no-merges', '--merges', '--first-parent', '--reverse', '--abbrev-commit', '--follow', '--date-order', '--topo-order', '--no-color', '--summary', '--no-ext-diff', '--no-textconv'), valued: v('-n'), patterns: GIT_FORMAT, operands: true },
  show: { flags: v('--stat', '--name-only', '--name-status', '--oneline', '-p', '--patch', '--no-patch', '-s', '--summary', '--abbrev-commit', '--no-color', '--no-ext-diff', '--no-textconv'), patterns: GIT_FORMAT, operands: true },
  'rev-parse': { flags: v('--abbrev-ref', '--short', '--verify', '--show-toplevel', '--git-dir', '--is-inside-work-tree', '--symbolic-full-name', '--show-prefix', '--quiet', '-q'), patterns: [/^--short=\d+$/], operands: true },
  'ls-files': { flags: v('-c', '--cached', '-m', '--modified', '-o', '--others', '--exclude-standard', '-d', '--deleted', '-s', '--stage', '--full-name'), operands: true },
  blame: { flags: v('-w', '-s', '-e', '--porcelain', '--line-porcelain', '--no-textconv', '-l', '--show-email'), valued: v('-L'), patterns: [/^-L\S+$/], operands: true },
  describe: { flags: v('--tags', '--always', '--long', '--dirty', '--all'), patterns: [/^--abbrev=\d+$/], operands: true },
  shortlog: { flags: v('-s', '-n', '-e', '--summary', '--numbered', '--email', '--all'), patterns: GIT_FORMAT, operands: true },
  grep: { flags: v('-n', '--line-number', '-i', '--ignore-case', '-w', '-v', '-l', '--files-with-matches', '-L', '-c', '--count', '-E', '-F', '-G', '--cached', '-h', '-H', '-I', '--heading', '--break', '--no-textconv', '--full-name'), valued: v('-e', '-A', '-B', '-C', '--max-depth'), patterns: [/^-[ABC]\d+$/], operands: true },
  'rev-list': { flags: v('--count', '--all', '--no-merges', '--first-parent', '--reverse'), patterns: GIT_FORMAT, operands: true },
  'ls-tree': { flags: v('-r', '-d', '-t', '--name-only', '--full-tree', '-l', '--long'), operands: true },
  'merge-base': { flags: v('--is-ancestor', '--all'), operands: true },
  'name-rev': { flags: v('--name-only', '--tags', '--always'), operands: true },
  branch: { flags: v('--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--no-color'), patterns: GIT_FORMAT, operands: false }
};
// What Kenlith adds to git runs (measured 2026-11-10, git 2.54: a repository's
// log.showSignature runs gpg.program on log and show: RC3 adds --no-show-signature;
// core.fsmonitor runs on `git status`, diff.external on `git diff`).
const GIT_NO_PROGRAMS = { diff: ['--no-ext-diff', '--no-textconv'], log: ['--no-ext-diff', '--no-textconv', '--no-show-signature'], show: ['--no-ext-diff', '--no-textconv', '--no-show-signature'], grep: ['--no-textconv'], blame: ['--no-textconv'] };
// RC3: --format=%G? and %GG verify signatures whatever --no-show-signature
// says, starting the repository's gpg.program (measured); an empty program
// from the environment cannot be started.
const GIT_HARDEN_ENV = [
  { name: 'GIT_CONFIG_COUNT', value: '4' },
  { name: 'GIT_CONFIG_KEY_0', value: 'core.fsmonitor' }, { name: 'GIT_CONFIG_VALUE_0', value: 'false' },
  { name: 'GIT_CONFIG_KEY_1', value: 'gpg.program' }, { name: 'GIT_CONFIG_VALUE_1', value: '' },
  { name: 'GIT_CONFIG_KEY_2', value: 'gpg.ssh.program' }, { name: 'GIT_CONFIG_VALUE_2', value: '' },
  { name: 'GIT_CONFIG_KEY_3', value: 'gpg.x509.program' }, { name: 'GIT_CONFIG_VALUE_3', value: '' }
];

const TOOL_SPECS = {
  tsc: { flags: v('--noEmit', '-b', '--build', '--verbose', '--listFiles', '--skipLibCheck', '--strict', '--incremental', '--noErrorTruncation', '--pretty'), valued: v('-p', '--project'), patterns: [/^--pretty=(true|false)$/], operands: false },
  eslint: { flags: v('--quiet', '--cache', '--no-eslintrc', '--report-unused-disable-directives', '--no-inline-config'), valued: v('--ext', '--max-warnings', '-c', '--config', '--ignore-path'), patterns: [/^(-f|--format)=(stylish|compact|json|unix|visualstudio|tap|checkstyle|junit)$/], operands: true },
  prettier: { flags: v('--check', '-c', '--list-different', '-l', '--no-config', '--no-editorconfig'), valued: v('--config', '--ignore-path'), operands: true },
  stylelint: { flags: v('--quiet', '--allow-empty-input', '--no-color'), valued: v('--max-warnings', '--config', '--ignore-path'), operands: true },
  jest: { flags: v('-i', '--runInBand', '--ci', '--silent', '--verbose', '--coverage', '--passWithNoTests', '--bail', '--no-cache', '--listTests'), valued: v('-t', '--testNamePattern', '--maxWorkers', '--testPathPattern'), operands: true },
  vitest: { flags: v('run', '--run', '--coverage', '--passWithNoTests', '--silent'), valued: v('-t', '--testNamePattern', '--bail'), patterns: [/^--reporter=(default|verbose|dot|basic)$/], operands: true },
  mocha: { flags: v('--bail', '-b', '--recursive', '--exit', '--forbid-only', '--forbid-pending', '--no-colors'), valued: v('-g', '--grep', '--timeout', '-t'), patterns: [/^(-R|--reporter)=(spec|dot|tap|min|list)$/], operands: true },
  ava: { flags: v('--verbose', '--fail-fast', '--serial'), valued: v('--match', '-m'), operands: true },
  tap: { flags: v('--reporter=tap', '--reporter=spec'), operands: true }
};
const NODE_TEST_SPEC = { flags: v('--test', '--test-only', '--test-force-exit', '--experimental-test-coverage'), patterns: [/^--test-reporter=(spec|tap|dot|junit|lcov)$/, /^--test-(name|skip)-pattern=.+$/, /^--test-(concurrency|timeout)=\d+$/], operands: true };
const PY_SPECS = {
  pytest: { flags: v('-q', '-v', '-vv', '-x', '-s', '-l', '--collect-only', '--co', '--lf', '--ff', '--no-header', '--strict-markers'), valued: v('-k', '-m', '--maxfail', '--tb', '-r'), patterns: [/^--(maxfail|tb)=\S+$/, /^-r[a-zA-Z]+$/], operands: true },
  unittest: { flags: v('-v', '-q', '-f', '-b', 'discover'), valued: v('-k', '-s', '-p', '-t'), operands: true },
  compileall: { flags: v('-q', '-f'), operands: true },
  mypy: { flags: v('--strict', '--ignore-missing-imports', '--no-error-summary', '--pretty', '--show-error-codes'), valued: v('-p', '--package', '--config-file'), operands: true },
  flake8: { flags: v('--count', '--statistics'), patterns: [/^--max-line-length=\d+$/], operands: true }
};

function firstOperand(args) {
  for (const arg of args) if (!arg.startsWith('-')) return arg.toLowerCase();
  return '';
}

function classifyGit(args, add, harden) {
  for (const arg of args) {
    if (!arg.startsWith('-')) break;
    if (/^(-c|--config-env|--exec-path|-C|--git-dir|--work-tree|--namespace)/.test(arg)) return add('C', 'force', 'git configuration or path overrides (they can run other programs)');
    if (!/^--(no-pager|version)$/.test(arg)) return add('B', 'unknown', `git option ${arg}`);
  }
  const index = args.findIndex((a) => !a.startsWith('-'));
  const sub = index < 0 ? '' : args[index].toLowerCase();
  const rest = index < 0 ? [] : args.slice(index + 1);
  if (!sub) return args.length === 1 && args[0] === '--version' ? add('A', 'read-only', 'git version') : add('B', 'unknown', 'git without a subcommand');
  if (sub === 'push' && rest.some((a) => /^(-f|--force|--force-with-lease|--mirror|--delete|-d|--prune)$/.test(a) || /^--force/.test(a) || /^\+/.test(a))) return add('C', 'force', 'force or deleting push');
  if (sub === 'reset' && rest.includes('--hard')) return add('C', 'destructive', 'git reset --hard discards work');
  if (sub === 'clean') return add('C', 'destructive', 'git clean deletes files');
  if (['filter-branch', 'gc', 'prune', 'replace', 'update-ref'].includes(sub)) return add('C', 'destructive', `git ${sub} rewrites or removes history`);
  if (sub === 'config') {
    const writes = rest.some((a) => /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)$/.test(a)) || rest.filter((a) => !a.startsWith('-')).length >= 2;
    if (writes) return add('C', 'credential', 'git config writes can store credentials or run programs');
    return add('B', 'machine-info', 'git config reads can show stored credentials or settings');
  }
  if (sub === 'remote' && rest.length && rest.every((a) => a === '-v' || a === '--verbose')) return add('A', 'read-only', 'lists remotes');
  const spec = GIT_READ_SPECS[sub];
  if (spec) {
    const ok = optionsOk(rest, spec);
    if (!ok.ok) return add('B', 'unknown', `git ${sub} with ${ok.bad} (not an option Kenlith runs without asking)`);
    if (GIT_NO_PROGRAMS[sub]) harden.args = { after: index, insert: GIT_NO_PROGRAMS[sub] };
    return add('A', 'read-only', `git ${sub} reads the repository`);
  }
  if (['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule', 'remote', 'archive', 'send-email', 'request-pull'].includes(sub)) return add('B', 'network', `git ${sub} contacts a remote`);
  if (['add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'stash', 'tag', 'reset', 'rm', 'mv', 'cherry-pick', 'revert', 'am', 'apply', 'init', 'notes', 'worktree', 'branch', 'config'].includes(sub)) return add('B', 'vcs-mutation', `git ${sub} changes the repository`);
  return add('B', 'unknown', `git ${sub} (not a form Kenlith runs without asking)`);
}

// A project script's text is Class A only if it is one or more commands
// joined by && that are each a Class A form of a validation tool.
function scriptBodyIsSafe(body) {
  if (typeof body !== 'string' || !body.trim() || /[|;<>$`'"()%!^*?{}[\]\\\r\n]|&(?!&)/.test(body.replace(/&&/g, ''))) return false;
  for (const part of body.split('&&').map((p) => p.trim())) {
    const tokens = part.split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const name = tokens[0].toLowerCase().replace(/\.(cmd|exe|js)$/, '');
    if (!['tsc', 'eslint', 'prettier', 'stylelint', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'node'].includes(name)) return false;
    const r = classify({ name, args: tokens.slice(1), env: [], launch: 'direct', projectLocal: false, timeoutMs: 1000, executable: name });
    if (r.cls !== 'A') return false;
  }
  return true;
}

function classifyPackageManager(name, args, add, project) {
  const sub = firstOperand(args);
  if (args.length === 1 && /^(--version|-v)$/.test(args[0])) return add('A', 'read-only', `${name} version`);
  if (['publish', 'unpublish', 'login', 'logout', 'adduser', 'token', 'owner', 'deprecate', 'dist-tag', 'access', 'team', 'org'].includes(sub)) return add('C', 'publish', `${name} ${sub} acts on a registry account`);
  if (['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'link', 'dedupe', 'prune', 'rebuild'].includes(sub)) return add('B', 'install', `${name} ${sub} installs or changes dependencies (network)`);
  if (['exec', 'x', 'dlx', 'create', 'init', 'audit', 'outdated', 'view', 'info', 'search', 'pack'].includes(sub)) return add('B', 'network', `${name} ${sub} may download or contact the registry`);
  if (sub === 'config' && args.some((a) => a === 'set' || a === 'delete' || a === 'edit')) return add('C', 'credential', `${name} config writes may store credentials`);
  // Only the bare forms: `npm test`, `npm run <name>`, `yarn <name>`, `pnpm <name>`.
  let script;
  if (args.length === 1 && ['test', 't', 'tst'].includes(args[0])) script = 'test';
  else if (args.length === 2 && ['run', 'run-script'].includes(args[0])) script = args[1];
  else if (args.length === 1 && (name === 'yarn' || name === 'pnpm') && !args[0].startsWith('-')) script = args[0];
  if (!script) return add('B', 'project-script', `${name} ${args.join(' ')} (options or extra arguments are shown for approval)`);
  let scripts;
  try { scripts = JSON.parse(project.packageJson || '{}').scripts || {}; } catch { scripts = {}; }
  const body = scripts[script];
  if (typeof body !== 'string') return add('B', 'project-script', `the script "${script}" is not in package.json`);
  if (project.npmrcRisky) return add('B', 'project-script', 'the project .npmrc changes how scripts run (script-shell, node-options or similar)');
  if (!VALIDATION_SCRIPT.test(script)) return add('B', 'project-script', `runs the project script "${script}": ${body}`);
  for (const [label, text] of [[script, body], [`pre${script}`, scripts[`pre${script}`]], [`post${script}`, scripts[`post${script}`]]]) {
    if (text === undefined) continue;
    if (!scriptBodyIsSafe(text)) return add('B', 'project-script', `the "${label}" script is not only a known check: ${text}`);
  }
  return add('A', 'local-validation', `the project's "${script}" script (${body})`);
}

// The class of a resolved execution. `project`: { packageJson, npmrcRisky }
// read by the host (src/exec-service.js).
function classify(execution, project = {}) {
  const effects = new Set();
  const reasons = [];
  const harden = {};
  let cls = 'A';
  const rank = { A: 0, B: 1, C: 2 };
  const add = (c, effect, reason) => {
    if (rank[c] > rank[cls]) cls = c;
    effects.add(effect);
    reasons.push({ cls: c, effect, reason });
  };
  const name = execution.name;
  const args = execution.args;
  const text = execution.launch === 'shell' ? String(execution.shellText || '') : [name, ...args].join(' ');

  // ---- hard conditions ----
  if (ELEVATION.has(name) || /-Verb\s+RunAs/i.test(text)) add('C', 'elevation', 'asks for administrator rights');
  if (ENV_DUMP.has(name)) add('C', 'credential', 'prints the environment (may hold credentials)');
  if (DESTRUCTIVE.has(name)) add('C', 'destructive', `${name} deletes or changes system or file state`);
  if (REMOTE_CLOUD.has(name)) add('C', 'remote-control', `${name} controls a remote machine or cloud account (not supported in 0.7.0)`);
  if (execution.launch === 'cmd' && args.some((a) => !CMD_SAFE_ARG.test(a))) add('C', 'shell-injection', 'a .cmd/.bat program with an argument outside the safe character set');
  if (execution.launch === 'cmd' && /[%^"!&|<>]/.test(execution.executable)) add('C', 'shell-injection', 'a .cmd/.bat program whose path cmd.exe would interpret');
  for (const { name: envName } of execution.env) {
    if (DENIED_ENV.test(envName) || SECRET_NAME.test(envName)) add('C', 'credential', `sets ${envName}, which can change what runs or hold a secret`);
    else if (!ALLOWED_ENV.has(envName.toUpperCase())) add('B', 'environment', `sets ${envName}`);
  }
  if (execution.timeoutMs > 600_000) add('C', 'unbounded', 'timeout above 600 s');

  // ---- semantics ----
  const spec = TOOL_SPECS[name];
  if (SHELLS.has(name) || execution.launch === 'shell') {
    if (DANGEROUS_SHELL_TEXT.test(text)) add('C', 'destructive', 'the shell text contains a destructive, elevated or system command');
    else add('B', 'shell', 'runs a shell command');
    if (NETWORK_SHELL_TEXT.test(text)) add('B', 'network', 'the shell text uses the network');
  } else if (name === 'git') classifyGit(args, add, harden);
  else if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) classifyPackageManager(name, args, add, project);
  else if (DOWNLOADERS.has(name)) add('B', 'network', `${name} may download and run code`);
  else if (name === 'node' || name === 'deno') {
    if (args.length === 1 && /^(--version|-v)$/.test(args[0])) add('A', 'read-only', `${name} version`);
    else if (args[0] === '--test' && optionsOk(args.slice(1), NODE_TEST_SPEC).ok) add('A', 'local-validation', 'runs the project\'s tests');
    else if (args[0] === '--check' && args.length === 2 && !args[1].startsWith('-')) add('A', 'read-only', 'checks syntax');
    else if (args.some((a) => /^(-e|--eval|-p|--print)$/.test(a) || /^--(eval|print)=/.test(a))) add('B', 'unknown', 'runs code written in the request');
    else if (args.some((a) => /^--inspect/.test(a) && /=(?!(127\.0\.0\.1|localhost|\d+$))/.test(a))) add('C', 'remote-control', 'opens a debugger to another host');
    else add('B', 'unknown', 'runs a project script or loads code (options are shown for approval)');
  } else if (name === 'python' || name === 'python3' || name === 'py') {
    const module = args[0] === '-m' ? args[1] : undefined;
    if (args.length === 1 && /^(--version|-V)$/.test(args[0])) add('A', 'read-only', 'python version');
    else if (module && PY_SPECS[module] && optionsOk(args.slice(2), PY_SPECS[module]).ok) add('A', 'local-validation', `python -m ${module}`);
    else if (module === 'pip' || module === 'venv') add('B', 'install', `python -m ${module}`);
    else if (module === 'http.server') add('B', 'network', 'starts a web server');
    else add('B', 'unknown', 'runs a script, code or a module with options Kenlith does not run without asking');
  } else if (name === 'dotnet') {
    const sub = firstOperand(args);
    if (args.length === 1 && /^--(version|info)$/.test(args[0])) add('A', 'read-only', 'dotnet version');
    else if ((sub === 'build' || sub === 'test') && args.includes('--no-restore') && optionsOk(args.slice(1), { flags: v('--no-restore', '--no-build', '--nologo'), valued: v('-c', '--configuration', '--filter', '-v', '--verbosity'), operands: true }).ok) add('A', 'local-validation', `dotnet ${sub} --no-restore`);
    else if (['nuget', 'publish'].includes(sub) && args.includes('push')) add('C', 'publish', 'publishes a package');
    else add('B', 'network', `dotnet ${sub} may restore packages or run project code`);
  } else if (name === 'cargo' || name === 'go') {
    const sub = firstOperand(args);
    if (args.length === 1 && args[0] === '--version') add('A', 'read-only', `${name} version`);
    else if (sub === 'publish' || sub === 'login') add('C', 'publish', `${name} ${sub}`);
    else add('B', 'network', `${name} ${sub} may download dependencies or run build scripts`);
  } else if (name === 'ruff' || name === 'biome') {
    const sub = firstOperand(args);
    if ((sub === 'check' || sub === 'lint') && !args.some((a) => /^--(fix|write|apply|unsafe)/.test(a)) && optionsOk(args.slice(1), { flags: v('--quiet', '-q', '--no-cache'), patterns: [/^--output-format=(text|concise|full|json)$/], operands: true }).ok) add('A', 'local-validation', `${name} ${sub}`);
    else add('B', 'source-mutation', `${name} ${args.join(' ')} may rewrite files`);
  } else if (spec) {
    if (args.some((a) => /^(--watch|-w|--watchAll|watch)$/.test(a))) add('C', 'unbounded', 'watch mode never ends');
    else {
      const ok = optionsOk(args, spec);
      if (name === 'vitest' && ['dev', 'bench', 'init', 'list'].includes(firstOperand(args))) add('B', 'unknown', `vitest ${firstOperand(args)}`);
      else if (ok.ok) add('A', 'local-validation', `${name} checks the project`);
      else add('B', 'source-mutation', `${name} with ${ok.bad} may write files or load extra code`);
    }
  } else if (INSTALLERS.has(name)) add('B', 'install', `${name} installs software (network)`);
  else if (NETWORK.has(name)) {
    const sub = firstOperand(args);
    if ((name === 'gh' && ['auth', 'secret', 'ssh-key', 'gpg-key'].includes(sub)) || (name === 'docker' && ['login', 'push'].includes(sub))) add('C', 'credential', `${name} ${sub}`);
    else add('B', 'network', `${name} uses the network`);
  } else if (MACHINE_INFO.has(name)) add('B', 'machine-info', `${name} reports information about this computer`);
  else if (MUTATING_FILE_TOOLS.has(name)) {
    if (name === 'robocopy' && args.some((a) => /^\/(mir|purge|move)$/i.test(a))) add('C', 'destructive', 'robocopy mirror or move deletes files');
    else add('B', 'source-mutation', `${name} changes files outside Review Before Apply`);
  } else add('B', 'unknown', `${name} (not a program Kenlith knows)`);

  // ---- generic detections ----
  if (args.some((a) => URL_ARG.test(a.includes('=') && a.startsWith('-') ? a.slice(a.indexOf('=') + 1) : a) && !/^[A-Za-z]:[\\/]/.test(a))) add('B', 'network', 'an argument is a network address or a URL-like value');
  if (execution.projectLocal && cls === 'A') add('B', 'project-script', 'runs a program from the project folder');
  if (name === 'git') harden.env = GIT_HARDEN_ENV;
  return { cls, effects: [...effects], reasons, harden };
}

// Applies the hardening to a git execution: the argv and environment Kenlith adds.
function hardened(execution, harden) {
  if (!harden || (!harden.args && !harden.env)) return execution;
  const args = execution.args.slice();
  if (harden.args) args.splice(harden.args.after + 1, 0, ...harden.args.insert.filter((x) => !args.includes(x)));
  return { ...execution, args, kenlithEnv: [...(execution.kenlithEnv || []), ...(harden.env || [])] };
}

const EFFECT_WORDS = {
  'read-only': 'reads the project', 'local-validation': 'checks the project locally', 'source-mutation': 'changes files outside Review Before Apply',
  'vcs-mutation': 'changes the git repository', network: 'uses the network', install: 'installs or changes dependencies (network)',
  'machine-info': 'reports information about this computer', shell: 'runs a shell command', 'project-script': 'runs a script from the project',
  unknown: 'effects not known to Kenlith', environment: 'sets environment variables'
};

module.exports = { ALLOWED_ENV, CMD_SAFE_ARG, EFFECT_WORDS, GIT_HARDEN_ENV, SECRET_NAME, classify, hardened, optionsOk };
