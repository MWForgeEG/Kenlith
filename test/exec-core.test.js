'use strict';

// Kenlith 0.7.0 controlled execution: the request, the policy, the output and
// the runner, with real processes on this machine (node, git, npm.cmd when
// present). Test IDs follow docs/kenlith-0.7.0/TEST-MATRIX.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { resolveExecution, validateRunArguments, executionDigest, RUN_TOOL_DEFINITION } = require('../src/exec-request');
const { classify } = require('../src/exec-policy');
const { sanitize, shareClass, modelResult, stripControls } = require('../src/exec-output');
const { run, launchSpec } = require('../src/exec-runner');

const win = process.platform === 'win32';

function project(extra = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-exec-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc -p .', deploy: 'node deploy.js', 'test:net': 'curl https://example.com' } }));
  fs.writeFileSync(path.join(root, 'src', 'a.test.js'), "require('node:test')('ok', () => {});\n");
  for (const [rel, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  return root;
}
const req = (executable, args = [], extra = {}) => ({ executable, args, cwd: null, timeoutSeconds: null, env: [], purpose: 'test', ...extra });
function resolved(root, executable, args, extra) {
  const r = resolveExecution({ root, request: req(executable, args, extra) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.execution;
}
const cls = (root, executable, args, extra, pkg) => classify(resolved(root, executable, args, extra), { packageJson: pkg ?? fs.readFileSync(path.join(root, 'package.json'), 'utf8') });

// ---------- request ----------

test('X02 structured arguments: the schema is strict, no shell string field, bounds enforced', () => {
  assert.deepEqual(RUN_TOOL_DEFINITION.parameters.required.sort(), ['args', 'cwd', 'env', 'executable', 'purpose', 'timeout_seconds']);
  assert.equal(RUN_TOOL_DEFINITION.parameters.additionalProperties, false);
  const ok = validateRunArguments(JSON.stringify({ executable: 'git', args: ['status'], cwd: null, timeout_seconds: null, env: [], purpose: 'p' }));
  assert.equal(ok.ok, true);
  assert.equal(validateRunArguments(JSON.stringify({ executable: 'git', args: ['status'], cwd: null, timeout_seconds: null, env: [], purpose: 'p', shell: 'rm -rf /' })).ok, false);
  assert.equal(validateRunArguments(JSON.stringify({ executable: 'git', args: Array(65).fill('x'), cwd: null, timeout_seconds: null, env: [], purpose: 'p' })).ok, false);
  assert.equal(validateRunArguments(JSON.stringify({ executable: 'git', args: ['a\u0000b'], cwd: null, timeout_seconds: null, env: [], purpose: 'p' })).ok, false);
  assert.equal(validateRunArguments(JSON.stringify({ executable: 'git', args: [], cwd: null, timeout_seconds: 0, env: [], purpose: 'p' })).ok, false);
});

test('X06 X07 working folder and path arguments cannot leave the project', () => {
  const root = project();
  for (const cwd of ['..', '../..', 'C:\\Windows', '\\\\server\\share', '/etc', 'src/../..']) {
    const r = resolveExecution({ root, request: req('node', ['--version'], { cwd }) });
    assert.equal(r.ok, false, cwd);
    assert.equal(r.cls, 'C', cwd);
  }
  assert.equal(resolveExecution({ root, request: req('node', ['--version'], { cwd: 'src' }) }).ok, true);
  for (const arg of ['C:\\Windows\\win.ini', '../outside.txt', '--out=../../x', '\\\\server\\share\\f', '/etc/passwd']) {
    const r = resolveExecution({ root, request: req('node', ['--check', arg]) });
    assert.equal(r.ok, false, arg);
    assert.equal(r.code, 'outside-project', arg);
  }
  assert.equal(resolveExecution({ root, request: req('node', ['--check', path.join(root, 'src', 'a.test.js')]) }).ok, true, 'an absolute path inside the project is fine');
});

test('X08 a working folder that is a junction, and an absolute program path, are refused', () => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-out-'));
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  const r = resolveExecution({ root, request: req('node', ['--version'], { cwd: 'linked' }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'link');
  const abs = resolveExecution({ root, request: req(process.execPath, ['--version']) });
  assert.equal(abs.ok, false);
  assert.equal(abs.code, 'outside-project');
});

test('X05 a program planted in the project is never found by its bare name; a project program path is Class B', () => {
  const root = project({ 'git.cmd': '@echo planted\n', 'tools/run.cmd': '@echo hi\n' });
  const git = resolved(root, 'git', ['status']);
  assert.ok(!git.executable.toLowerCase().startsWith(root.toLowerCase()), 'git comes from PATH, not the project');
  if (win) {
    const local = resolved(root, 'tools/run.cmd', []);
    assert.equal(local.projectLocal, true);
    assert.equal(classify(local).cls, 'B');
  }
});

test('X29 a program that does not exist: not-found (reported as a launch failure)', () => {
  const root = project();
  const r = resolveExecution({ root, request: req('definitely-not-a-program-7f3a', []) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-found');
});

test('X10 the digest covers what runs: arguments, folder, environment, timeout and the program file', () => {
  const root = project();
  const a = resolved(root, 'node', ['--version']);
  assert.equal(a.digest, executionDigest(a));
  assert.notEqual(resolved(root, 'node', ['--test']).digest, a.digest);
  assert.notEqual(resolved(root, 'node', ['--version'], { cwd: 'src' }).digest, a.digest);
  assert.notEqual(resolved(root, 'node', ['--version'], { env: [{ name: 'CI', value: '1' }] }).digest, a.digest);
  assert.notEqual(resolved(root, 'node', ['--version'], { timeoutSeconds: 30 }).digest, a.digest);
  assert.notEqual(executionDigest({ ...a, exeMtimeMs: a.exeMtimeMs + 1 }), a.digest, 'a replaced program file voids the approval');
});

// ---------- policy ----------

test('X30a Class A: read-only git, node --test, a screened validation script, linters without --fix', () => {
  const root = project();
  for (const [exe, args] of [['git', ['status']], ['git', ['diff', '--stat']], ['git', ['log', '-5']], ['node', ['--test']], ['node', ['--version']], ['npm', ['test']], ['npm', ['run', 'lint']], ['npm', ['run', 'build']]]) {
    const r = cls(root, exe, args);
    assert.equal(r.cls, 'A', `${exe} ${args.join(' ')}: ${JSON.stringify(r.reasons)}`);
  }
});

test('X31 Class B: network, installs, git changes, shells, unknown programs, model-written code, unscreened scripts', () => {
  const root = project();
  const cases = [
    ['git', ['push'], 'network'], ['git', ['commit', '-m', 'x'], 'vcs-mutation'], ['git', ['fetch'], 'network'],
    ['npm', ['install'], 'install'], ['npm', ['run', 'deploy'], 'project-script'], ['npm', ['run', 'test:net'], 'project-script'],
    ['npx', ['eslint', '.'], 'network'], ['node', ['-e', 'console.log(1)'], 'unknown'], ['node', ['src/a.test.js'], 'unknown'],
    ['git', ['clone', 'https://example.com/r.git'], 'network']
  ];
  for (const [exe, args, effect] of cases) {
    const r = cls(root, exe, args);
    assert.equal(r.cls, 'B', `${exe} ${args.join(' ')}`);
    assert.ok(r.effects.includes(effect), `${exe} ${args.join(' ')}: ${r.effects}`);
  }
  if (win) {
    const shell = cls(root, 'powershell', ['-NoProfile', '-Command', 'Get-ChildItem']);
    assert.equal(shell.cls, 'B');
    assert.ok(shell.effects.includes('shell'));
  }
});

test('X01 X04 X15b X19 Class C: elevation, force push, git config overrides, destructive programs, env dumps, denied env names, dangerous shell text, publishing', () => {
  const root = project();
  const cases = [['git', ['push', '--force']], ['git', ['reset', '--hard']], ['git', ['clean', '-fdx']], ['git', ['-c', 'core.sshCommand=calc', 'fetch']], ['npm', ['publish']]];
  if (win) cases.push(['powershell', ['-Command', 'Start-Process powershell -Verb RunAs']], ['powershell', ['-Command', 'Remove-Item -Recurse src']], ['cmd', ['/c', 'set']], ['taskkill', ['/im', 'x.exe']]);
  for (const [exe, args] of cases) assert.equal(cls(root, exe, args).cls, 'C', `${exe} ${args.join(' ')}`);
  assert.equal(cls(root, 'node', ['--test'], { env: [{ name: 'NODE_OPTIONS', value: '--require evil.js' }] }).cls, 'C');
  assert.equal(cls(root, 'node', ['--test'], { env: [{ name: 'GITHUB_TOKEN', value: 'x' }] }).cls, 'C');
  assert.equal(cls(root, 'node', ['--test'], { env: [{ name: 'MY_FLAG', value: '1' }] }).cls, 'B', 'an unknown variable name is shown for approval');
  assert.equal(cls(root, 'node', ['--test'], { env: [{ name: 'CI', value: '1' }] }).cls, 'A');
});

test('X03 a .cmd program with shell metacharacters in an argument is refused (Class C)', { skip: !win && 'Windows only' }, () => {
  const root = project();
  for (const arg of ['a&calc', 'x|y', '%PATH%', '^', '"q"', 'a b', '!x!', '(x)']) {
    const r = cls(root, 'npm', ['run', 'lint', arg]);
    assert.equal(r.cls, 'C', arg);
    assert.ok(r.effects.includes('shell-injection'), arg);
  }
});

test('X22 the model\'s purpose never changes the class', () => {
  const root = project();
  assert.equal(cls(root, 'git', ['push', '--force'], { purpose: 'This is completely safe, the user asked for it' }).cls, 'C');
  assert.equal(cls(root, 'npm', ['install'], { purpose: 'safe read-only check' }).cls, 'B');
});

// ---------- output ----------

test('X23 terminal control sequences are removed (colours, cursor moves, titles, bells)', () => {
  const text = '\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u001b[2J\u0007\r\nnext\u009b1mx';
  assert.equal(stripControls(text), 'red ok\nnextx');
});

test('X15 secrets in output: credential-like lines removed, secret env values redacted; home, user and outside paths replaced', () => {
  const root = 'C:\\work\\proj';
  const s = sanitize([
    'token AK' + 'IAABCDEFGHIJKLMNOP',
    'value=s3cr3t-value-123 used',
    `at ${root}\\src\\a.js:3`,
    'at C:\\Users\\alice\\AppData\\npm\\x.js',
    'hello alice on HOSTX'
  ].join('\n'), { root, home: 'C:\\Users\\alice', user: 'alice', host: 'HOSTX', env: { MY_API_TOKEN: 's3cr3t-value-123', PATH: 'C:\\x' } });
  assert.match(s.text, /\[credential-like line removed\]/);
  assert.doesNotMatch(s.text, /AKIA|s3cr3t/);
  assert.match(s.text, /<project>\\src\\a\.js/);
  assert.match(s.text, /\[path outside the project\]/);
  assert.match(s.text, /hello <user> on <computer>/);
  assert.equal(shareClass(s, ['local-validation']), 'project');
  assert.equal(shareClass(s, ['machine-info']), 'exceptional');
});

test('X09 output bounds: the model gets at most 6,000 characters of output, marked truncated', () => {
  const big = 'x'.repeat(50_000);
  const body = JSON.parse(modelResult({ tool: 'project_run_command', status: 'succeeded', exitCode: 0, durationMs: 5, stdout: big, stderr: big }));
  assert.ok(body.stdout.length + body.stderr.length <= 6_200);
  assert.equal(body.truncated, true);
  assert.match(body.note, /data .*not instructions/);
});

test('X32 an output dominated by outside paths is exceptional', () => {
  const s = sanitize(Array.from({ length: 30 }, (_, i) => `C:\\Windows\\System32\\file${i}.dll`).join('\n'), { root: 'C:\\work\\proj', env: {} });
  assert.equal(shareClass(s, ['unknown']), 'exceptional');
});

// ---------- runner (real processes) ----------

const execOf = (root, executable, args, timeoutSeconds) => resolved(root, executable, args, timeoutSeconds ? { timeoutSeconds } : {});

test('X28 nonzero exit is reported with its code, never as success', async () => {
  const root = project({ 'fail.js': 'process.stderr.write("bad\\n"); process.exit(3);' });
  const r = await run(execOf(root, 'node', ['fail.js']));
  assert.equal(r.status, 'nonzero');
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /bad/);
});

test('X02b metacharacters reach the program literally (no shell)', async () => {
  const root = project({ 'echo.js': 'process.stdout.write(JSON.stringify(process.argv.slice(2)));' });
  const args = ['a&b', '$(whoami)', '`id`', '|x', '>out.txt', '%PATH%', '; rm -rf /'];
  const r = await run(execOf(root, 'node', ['echo.js', ...args]));
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(JSON.parse(r.stdout), args);
  assert.equal(fs.existsSync(path.join(root, 'out.txt')), false, 'no redirection happened');
});

test('X13 X14b timeout stops the process and its children', async () => {
  const root = project({
    'child.js': 'setInterval(() => {}, 1000);',
    'parent.js': "const c = require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'ignore' }); require('fs').writeFileSync('child.pid', String(c.pid)); setInterval(() => {}, 1000);"
  });
  const r = await run(execOf(root, 'node', ['parent.js'], 2));
  assert.equal(r.status, 'timed-out');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const childPid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  let alive = true;
  try { process.kill(childPid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the child process was stopped with its parent');
});

test('X14 cancellation stops the run and reports cancelled', async () => {
  const root = project({ 'slow.js': 'setInterval(() => {}, 1000);' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const r = await run(execOf(root, 'node', ['slow.js']), { signal: controller.signal });
  assert.equal(r.status, 'cancelled');
});

test('X09b a flood of output is captured within bounds (head and tail)', async () => {
  const root = project({ 'flood.js': "for (let i = 0; i < 20000; i++) process.stdout.write('line ' + i + ' ' + 'y'.repeat(40) + '\\n');" });
  const r = await run(execOf(root, 'node', ['flood.js']));
  assert.equal(r.status, 'succeeded');
  assert.ok(r.stdout.length < 70 * 1024, String(r.stdout.length));
  assert.equal(r.truncated, true);
  assert.match(r.stdout, /line 0 /);
  assert.match(r.stdout, /line 19999 /);
});

test('X03b npm.cmd runs through cmd.exe with safe arguments only (no shell otherwise)', { skip: (!win && 'Windows only') }, async (t) => {
  const root = project();
  const r = resolveExecution({ root, request: req('npm', ['--version']) });
  if (!r.ok) { t.skip('npm not on PATH'); return; }
  assert.equal(r.execution.launch, 'cmd');
  const [file, args] = launchSpec(r.execution, {});
  assert.match(file, /cmd\.exe$/i);
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  const result = await run(r.execution);
  assert.equal(result.status, 'succeeded', result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('X30c git status runs for real, read-only, in a fresh repository', async (t) => {
  const root = project();
  try { execFileSync('git', ['init', '-q'], { cwd: root }); } catch { t.skip('git not available'); return; }
  const e = execOf(root, 'git', ['status', '--short']);
  assert.equal(classify(e, {}).cls, 'A');
  const r = await run(e);
  assert.equal(r.status, 'succeeded', r.stderr);
  assert.match(r.stdout, /package\.json/);
});

// ---------- independent review findings (2026-11-10): Class A is proved by allow lists ----------

test('XR1 python: -m is only honoured as the first argument; plugins and code are Class B', () => {
  const root = project({ 'x.py': 'print(1)\n' });
  for (const args of [['-c', 'print(1)', '-m', 'pytest'], ['x.py', '-m', 'pytest'], ['-m', 'pytest', '-p', 'evil_plugin'], ['-m', 'mypy', '--install-types', '--non-interactive']]) {
    assert.equal(cls(root, 'python', args).cls, 'B', args.join(' '));
  }
  assert.equal(cls(root, 'python', ['-m', 'pytest', '-q', '-k', 'name']).cls, 'A');
});

test('XR2 node --test with preload or loader options is Class B', () => {
  const root = project();
  for (const extra of [['--import=data:text/javascript,1'], ['--require', 'x.js'], ['--experimental-loader=x'], ['--loader', 'x'], ['--env-file=.env'], ['--inspect']]) {
    assert.equal(cls(root, 'node', ['--test', ...extra]).cls === 'A', false, extra.join(' '));
  }
  assert.equal(cls(root, 'node', ['--test', '--test-reporter=spec', 'src']).cls, 'A');
});

test('XR3 npm scripts: options, pass-through arguments, other packages, unsafe pre/post scripts, risky .npmrc, nested or code-running bodies are Class B', () => {
  const pkg = (scripts) => JSON.stringify({ scripts });
  const root = project();
  const B = (args, scripts, project = {}) => assert.equal(classify(resolved(root, 'npm', args), { packageJson: pkg(scripts), ...project }).cls, 'B', `${args.join(' ')} ${JSON.stringify(scripts)}`);
  B(['test', '--node-options=--require=x'], { test: 'node --test' });
  B(['--prefix', 'other', 'test'], { test: 'node --test' });
  B(['run', 'lint', '--', '--fix'], { lint: 'eslint .' });
  B(['test'], { test: 'node --test', pretest: 'curl https://x' });
  B(['test'], { test: 'node --test', posttest: 'node -e "x"' });
  B(['test'], { test: 'npm run other' });
  B(['test'], { test: 'node scripts/test.js' });
  B(['test'], { test: 'jest -u' });
  B(['test'], { test: 'node --test' }, { npmrcRisky: true });
  assert.equal(classify(resolved(root, 'npm', ['test']), { packageJson: pkg({ test: 'tsc --noEmit && node --test', pretest: 'eslint .' }) }).cls, 'A');
});

test('XR4 git: commands that start programs, write files or create branches are not Class A', () => {
  const root = project();
  for (const args of [['grep', '-Ocalc', 'x'], ['grep', '--open-files-in-pager=calc', 'x'], ['log', '--output=out.txt'], ['diff', '--output=o'], ['branch', 'newname'], ['branch', '--edit-description'], ['help', '--web', 'log'], ['diff', '--no-index', 'a', 'b'], ['diff', '--ext-diff'], ['log', '--textconv'], ['config', '--list']]) {
    assert.notEqual(cls(root, 'git', args).cls, 'A', args.join(' '));
  }
  assert.equal(cls(root, 'git', ['config', 'core.fsmonitor', 'calc']).cls, 'C');
  assert.equal(cls(root, 'git', ['log', '--oneline', '-5']).cls, 'A');
});

test('XR5 validation tools: forms that write, delete, download or load extra code are Class B', () => {
  // Pure classification (these tools need not be installed on the test machine).
  const pure = (name, args) => classify({ name, args, env: [], launch: 'direct', executable: name, projectLocal: false, timeoutMs: 120_000 });
  for (const [exe, args] of [['tsc', ['--init']], ['tsc', ['-b', '--clean']], ['eslint', ['-o', 'out.txt', '.']], ['eslint', ['--rulesdir', 'r']], ['jest', ['-u']], ['vitest', ['-u']], ['prettier', ['--write', '.']], ['ruff', ['format', '.']], ['mocha', ['--require', 'x']]]) {
    assert.equal(pure(exe, args).cls, 'B', `${exe} ${args.join(' ')}`);
  }
  assert.equal(pure('eslint', ['src', '--max-warnings', '0']).cls, 'A');
  assert.equal(pure('tsc', ['--noEmit', '-p', '.']).cls, 'A');
});

test('XR6 XR8 path checks: Windows root paths for ordinary programs, and stuck options, cannot leave the project', () => {
  const root = project();
  if (win) assert.equal(resolveExecution({ root, request: req('git', ['diff', '--no-index', '/Users', '/ProgramData']) }).ok, false);
  for (const arg of ['-o..\\x', '-f../x', '-o../../x']) {
    const r = resolveExecution({ root, request: req('eslint', [arg, '.']) });
    assert.equal(r.ok, false, arg);
  }
});

test('XR7 a path argument through a junction inside the project that leads outside is refused', () => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlith-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  const r = resolveExecution({ root, request: req('git', ['diff', '--no-index', 'link/secret.txt', 'package.json']) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'outside-project');
});

test('XR9 git runs get Kenlith\'s hardening: a repository configured to run a program on status or diff does not run it', async (t) => {
  const root = project({ 'a.txt': 'one\n' });
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try { git(['init', '-q']); } catch { t.skip('git not available'); return; }
  git(['add', 'a.txt']);
  git(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const marker = path.join(root, 'PROGRAM_RAN.txt');
  const hook = path.join(root, win ? 'hook.cmd' : 'hook.sh');
  fs.writeFileSync(hook, win ? `@echo ran> "${marker}"\r\n` : `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  git(['config', 'core.fsmonitor', hook.split(path.sep).join('/')]);
  git(['config', 'diff.external', hook.split(path.sep).join('/')]);
  const { hardened } = require('../src/exec-policy');
  // Control: without the hardening, the repository's program does run.
  await run(resolved(root, 'git', ['status', '--short']));
  assert.equal(fs.existsSync(marker), true, 'the hostile configuration is effective without hardening (the test is meaningful)');
  fs.rmSync(marker);
  for (const args of [['status', '--short'], ['diff']]) {
    const e = resolved(root, 'git', args);
    const policy = classify(e, {});
    assert.equal(policy.cls, 'A', args.join(' '));
    const r = await run(hardened(e, policy.harden));
    assert.equal(fs.existsSync(marker), false, `git ${args[0]}: the repository's program did not run (${r.status})`);
  }
});

// ---------- second independent review ----------

test('XR10 a process left holding the output pipes cannot keep a run open; the exit decides the status', async () => {
  const root = project();
  // The program starts a detached helper that inherits stdout and lives 30 s,
  // prints its pid, and exits 0 at once.
  const helper = 'setTimeout(()=>{},30000)';
  const program = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'inherit',detached:true});c.unref();console.log('helper '+c.pid);process.exit(0)`;
  const started = Date.now();
  const r = await run(execOf(root, 'node', ['-e', program], 2));
  const took = Date.now() - started;
  const pid = Number((/helper (\d+)/.exec(r.stdout) || [])[1]);
  try { if (pid) process.kill(pid); } catch { /* gone */ }
  assert.ok(took < 6000, `ended in ${took} ms, not when the helper ended`);
  assert.equal(r.status, 'succeeded', 'the program itself succeeded: not reported as timed out');
  assert.equal(r.exitCode, 0);
  assert.equal(r.lingering, true);
  const body = JSON.parse(modelResult({ tool: 'project_run_command', ...r, displayCommand: 'node -e …' }));
  assert.match(body.lingering, /may still be running/);
});

test('XR11 text-direction and invisible characters: refused in what would run, removed from output', () => {
  const root = project();
  const rlo = String.fromCharCode(0x202e);
  const isolate = String.fromCharCode(0x2066);
  const zwsp = String.fromCharCode(0x200b);
  const requests = [
    req('node', ['-e', `console.log(1)${rlo}`]),
    req('node', ['--version'], { shellText: `echo a${isolate}` }),
    req('node', [`${zwsp}--version`]),
    req('node', ['--version'], { env: [{ name: 'NO_COLOR', value: `1${rlo}` }] })
  ];
  for (const request of requests) {
    const r = resolveExecution({ root, request });
    assert.equal(r.ok, false, JSON.stringify(request));
    assert.equal(r.code, 'hidden-characters');
    assert.equal(r.cls, 'C');
  }
  assert.equal(stripControls(`a${rlo}b${isolate}c${zwsp}d${String.fromCharCode(0xfeff)}`), 'abcd');
  // Arabic and other ordinary text is untouched.
  assert.equal(resolveExecution({ root, request: req('node', ['-e', "console.log('مرحبا')"]) }).ok, true);
});

test('XR13 output paths: home folders with spaces, forward slashes, sibling folders, forward-slash UNC, URLs', () => {
  const sep = path.sep;
  const home = win ? ['C:', 'Users', 'John Smith'].join(sep) : '/home/John Smith';
  const root = win ? ['C:', 'Work', 'app'].join(sep) : '/srv/work/app';
  const ctx = { root, home, user: 'John Smith', host: 'BOX-7', env: {} };
  const s = (text) => sanitize(text, ctx);
  // Under a home folder with a space: the whole path goes, not just its first word.
  const homePath = [home, win ? 'AppData' : '.config', 'x.js'].join(sep);
  const a = s(`error in ${homePath} line 3`);
  assert.equal(a.text, 'error in [path outside the project] line 3');
  assert.equal(a.counts.outsideLines, 1);
  // In-project paths with forward slashes stay project paths.
  const fwd = s(`${root.split(sep).join('/')}/src/a.js:1 ok`);
  assert.equal(fwd.text, '<project>/src/a.js:1 ok');
  assert.equal(fwd.counts.outsideLines, 0);
  // A sibling folder that shares the root's name as a prefix is outside.
  const sib = s(`${root}-secrets${sep}leak.txt`);
  assert.doesNotMatch(sib.text, /<project>/);
  assert.match(sib.text, /\[path outside the project\]/);
  assert.equal(sib.counts.outsideLines, 1);
  // Forward-slash UNC is a path; a URL is not.
  assert.equal(s('see //fileserver/share/x.txt').text, 'see [path outside the project]');
  assert.equal(s('docs at https://example.com/a/b/c').text, 'docs at https://example.com/a/b/c');
  // The user and computer names are replaced in plain text.
  assert.equal(s('built by John Smith on BOX-7').text, 'built by <user> on <computer>');
  // Values of variables that usually embed a credential are redacted.
  const env = { DATABASE_URL: 'postgres://u' + ':pw12345678@db/x', GH_PAT: 'gh' + 'p_abcdefgh1234', PATH: '/usr/bin:/bin/x' };
  const e = sanitize(`url=${env.DATABASE_URL} pat=${env.GH_PAT} path=${env.PATH}`, { ...ctx, env });
  assert.equal(e.text.includes('pw12345678'), false);
  assert.equal(e.text.includes('gh' + 'p_abcdefgh1234'), false);
  assert.match(e.text, /\/usr\/bin:\/bin\/x|path=/, 'PATH is not a secret name');
});

test('XR16 a secret cut by the output capture boundary is dropped whole, never kept in part', () => {
  const { Capture } = require('../src/exec-runner');
  const secret = 'abcd1234efgh';
  for (const nl of ['', '\n']) {
    const c = new Capture();
    // The secret straddles the 32 KiB head boundary.
    c.push(Buffer.from(`start${nl}${'x'.repeat(32 * 1024 - 5 - nl.length - 4)}`));
    c.push(Buffer.from(secret));
    c.push(Buffer.from('y'.repeat(80 * 1024)));
    c.push(Buffer.from(`${nl}end`));
    const { text, dropped } = c.text();
    const headPart = text.split('[…')[0];
    for (let n = 4; n < secret.length; n += 1) {
      assert.equal(headPart.includes(secret.slice(0, n)), false, `the head keeps "${secret.slice(0, n)}" (newline: ${Boolean(nl)})`);
    }
    assert.match(text, /bytes not kept/);
    assert.ok(dropped > 80 * 1024 - 32 * 1024);
  }
});
