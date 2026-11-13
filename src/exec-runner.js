'use strict';

// Kenlith 0.7.0: runs one resolved execution (docs/kenlith-0.7.0/ARCHITECTURE.md §2, §8, §11).
//
// child_process.spawn with shell: false; a Windows .cmd/.bat program (which
// Node refuses without a shell) goes through `cmd.exe /d /s /c` only with
// arguments the policy has limited to a safe character set; an explicit shell
// run (approved, Class B) passes its text to the platform shell. stdin is
// closed, so nothing can wait for a password. Output is captured within bounds
// (first and last 32 KiB per stream). Timeout, Stop and window close stop the
// whole process tree. A run is never retried.

const { spawn, spawnSync } = require('node:child_process');

const KEEP = 32 * 1024;
const CUT_EDGE = 512;
const EXIT_GRACE_MS = 1500; // output still arriving after the program exited
const STOP_GRACE_MS = 5000; // after a stop, before the pipes are cut off

// Keeps the first and last KEEP bytes of a stream and counts the rest.
class Capture {
  constructor() { this.head = []; this.headBytes = 0; this.tail = Buffer.alloc(0); this.total = 0; }
  push(chunk) {
    this.total += chunk.length;
    if (this.headBytes < KEEP) {
      const take = chunk.subarray(0, KEEP - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length) this.tail = Buffer.concat([this.tail, chunk]).subarray(-KEEP);
  }
  // When bytes were dropped, the lines cut at either edge are dropped whole:
  // a cut-off secret could not be recognised (and redacted) later. A line
  // longer than the kept part loses CUT_EDGE characters at the edge instead.
  text() {
    let head = Buffer.concat(this.head).toString('utf8');
    const dropped = this.total - this.headBytes - this.tail.length;
    if (!this.tail.length) return { text: head, dropped: 0 };
    let tail = this.tail.toString('utf8');
    if (dropped <= 0) return { text: head + tail, dropped: 0 };
    const kept = Buffer.byteLength(head) + Buffer.byteLength(tail);
    const lastNl = head.lastIndexOf('\n');
    head = lastNl >= 0 ? head.slice(0, lastNl) : head.slice(0, Math.max(0, head.length - CUT_EDGE));
    const firstNl = tail.indexOf('\n');
    tail = firstNl >= 0 ? tail.slice(firstNl + 1) : tail.slice(CUT_EDGE);
    const notKept = dropped + kept - Buffer.byteLength(head) - Buffer.byteLength(tail);
    return { text: `${head}\n[… ${notKept} bytes not kept …]\n${tail}`, dropped: notKept };
  }
}

// Stops the process and everything it started.
function stopTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
  }
}

const quoteForCmd = (value) => (/[\s"]/.test(value) ? `"${value}"` : value);

// How the process is started for an execution: [file, args, options].
function launchSpec(execution, env, platform = process.platform) {
  const options = { cwd: execution.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' };
  if (execution.launch === 'cmd') {
    // Every argument is in the safe set (src/exec-policy.js), so this line
    // has no character cmd.exe would interpret.
    const line = [`"${execution.executable}"`, ...execution.args.map(quoteForCmd)].join(' ');
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true }];
  }
  if (execution.launch === 'shell') {
    // An approved shell run: the exact text the user saw.
    if (platform === 'win32') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${execution.shellText}"`], { ...options, windowsVerbatimArguments: true }];
    return ['/bin/sh', ['-c', execution.shellText], options];
  }
  return [execution.executable, execution.args.slice(), { ...options, shell: false }];
}

// The environment of the child: the host's, the validated delta, and settings
// that keep tools quiet and non-interactive. Never shown to the model.
function childEnv(execution, hostEnv = process.env) {
  const env = { ...hostEnv };
  for (const { name, value } of execution.env) env[name] = value;
  // What Kenlith adds itself (for git: repository config cannot start programs).
  for (const { name, value } of execution.kenlithEnv || []) env[name] = value;
  Object.assign(env, { CI: env.CI || '1', NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat', PAGER: 'cat' });
  return env;
}

// Runs to completion. Resolves (never rejects) with
// { status, exitCode, signal, startedAt, endedAt, durationMs, stdout, stderr, truncated, error }.
// status: succeeded | nonzero | timed-out | cancelled | launch-failed.
function run(execution, { signal, hostEnv = process.env, platform = process.platform, onStart } = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const out = new Capture();
    const err = new Capture();
    let child;
    let ended = false;
    let reason;
    const finish = (status, extra = {}) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const endedAt = new Date();
      const o = out.text();
      const e = err.text();
      resolve({ status, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), durationMs: endedAt - startedAt, stdout: o.text, stderr: e.text, truncated: Boolean(o.dropped || e.dropped), ...extra });
    };
    // The result follows the program's own exit. Output pipes can stay open
    // after it (a process it started keeps them); then Kenlith waits a short
    // grace for the rest of the output, closes the pipes and reports the exit
    // with `lingering`. A stop that does not end the pipes is cut off too, so
    // a run always ends.
    let exited;
    const closePipes = () => { child?.stdout?.destroy(); child?.stderr?.destroy(); };
    const fromExit = (lingering) => {
      const extra = { exitCode: exited.code, signal: exited.signal, ...(lingering ? { lingering: true } : {}) };
      if (reason) finish(reason, extra);
      else finish(exited.code === 0 ? 'succeeded' : 'nonzero', extra);
    };
    const stop = (why) => {
      if (ended || exited) return;
      reason = why;
      stopTree(child, platform);
      setTimeout(() => {
        if (ended) return;
        closePipes();
        finish(reason, exited ? { exitCode: exited.code, signal: exited.signal } : { exitCode: null });
      }, STOP_GRACE_MS).unref?.();
    };
    const onAbort = () => {
      if (exited) { closePipes(); fromExit(true); } else stop('cancelled');
    };
    const timer = setTimeout(() => stop('timed-out'), execution.timeoutMs);
    timer.unref?.();
    if (signal?.aborted) { finish('cancelled'); return; }
    try {
      const [file, args, options] = launchSpec(execution, childEnv(execution, hostEnv), platform);
      child = spawn(file, args, options);
    } catch (error) {
      finish('launch-failed', { error: String(error?.code || error?.message || error) });
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish('launch-failed', { error: String(error?.code || error?.message || error) }));
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('spawn', () => onStart?.(child.pid));
    child.on('exit', (code, sig) => {
      exited = { code, signal: sig };
      clearTimeout(timer);
      setTimeout(() => { if (!ended) { closePipes(); fromExit(true); } }, EXIT_GRACE_MS).unref?.();
    });
    child.on('close', (code, sig) => {
      if (!exited) exited = { code, signal: sig };
      fromExit(false);
    });
  });
}

module.exports = { Capture, EXIT_GRACE_MS, STOP_GRACE_MS, childEnv, launchSpec, run, stopTree };
