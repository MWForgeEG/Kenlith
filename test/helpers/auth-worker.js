'use strict';

// Runs AuthService in its own OS process, as one editor window would.
// Usage: node auth-worker.js <json spec>
// spec: { storageDir, secretsFile, secretDelayMs, port, label, startAt,
//         authOptions, actions: [{ do: 'token' | 'signOut' | 'session' | 'sleep' | 'crashInRefresh', ms }] }
// Every request to https://auth.openai.com goes to the shared local server.
// Prints one JSON line with per-action outcomes; tokens are reduced to a
// short label so the parent can compare them without logging secrets.
//
// Test-only options (F-4, WP-02):
// - injectSecretErrors: N — the first N SecretStorage calls throw EPERM,
//   as the file-backed stand-in's mkdir lock does on Windows when another
//   process is removing the same lock directory.
// - noSecretRetry: true — no retry around the stand-in (shows the symptom).
// - barrierDir + barrier: 'before' | 'after' — pause the refresh request
//   before it is sent or after its reply arrives, writing <label>.arrived and
//   waiting for <label>.release, so a test can order steps across processes.

const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('./fake-vscode');
const { AuthService } = require('../../src/auth');
const { withRetry } = require('../../src/fsutil');

const spec = JSON.parse(process.argv[2]);
const realFetch = globalThis.fetch;

async function barrier() {
  if (!spec.barrierDir) return;
  fs.writeFileSync(path.join(spec.barrierDir, `${spec.label}.arrived`), String(Date.now()));
  while (!fs.existsSync(path.join(spec.barrierDir, `${spec.label}.release`))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url).replace('https://auth.openai.com', `http://127.0.0.1:${spec.port}`);
  const refresh = target.endsWith('/api/accounts/oauth/token');
  if (spec.actions.some((action) => action.do === 'crashInRefresh') && refresh) {
    // Simulates the process dying while it holds the refresh lock.
    process.exit(7);
  }
  if (refresh && spec.barrier === 'before') await barrier();
  const response = await realFetch(target, {
    ...options,
    headers: { ...options.headers, 'x-worker': spec.label || '' }
  });
  if (refresh && spec.barrier === 'after') await barrier();
  return response;
};

// The file-backed SecretStorage stand-in locks with mkdir. On Windows,
// mkdir of a directory that another process is removing fails with EPERM
// (measured: docs/release-evidence/M1/WP-02). Kenlith's own files treat
// these codes as transient (src/fsutil.js); the stand-in gets the same retry,
// so a test fails only for what AuthService does.
function hardenSecrets(secrets) {
  let injected = spec.injectSecretErrors || 0;
  const call = (method) => async (...args) => {
    const once = () => {
      if (injected > 0) {
        injected -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, mkdir (injected)'), { code: 'EPERM', syscall: 'mkdir' });
      }
      return secrets[method](...args);
    };
    return spec.noSecretRetry ? once() : withRetry(once);
  };
  return { ...secrets, get: call('get'), store: call('store'), delete: call('delete') };
}

function label(token) {
  const match = /^synthetic-access-(\d+)$/.exec(token || '');
  return match ? `access#${match[1]}` : 'unexpected-token-shape';
}

async function main() {
  const context = createContext({
    storageDir: spec.storageDir,
    secretsFile: spec.secretsFile,
    secretDelayMs: spec.secretDelayMs || 0
  });
  context.secrets = hardenSecrets(context.secrets);
  const auth = new AuthService(context);
  Object.assign(auth, spec.authOptions || {});
  if (spec.startAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, spec.startAt - Date.now())));
  }

  const outcomes = [];
  for (const action of spec.actions) {
    const started = Date.now();
    try {
      if (action.do === 'token' || action.do === 'crashInRefresh') {
        outcomes.push({ do: action.do, ok: true, token: label(await auth.getAccessToken()), ms: Date.now() - started });
      } else if (action.do === 'signOut') {
        const result = await auth.signOut();
        outcomes.push({ do: 'signOut', ok: true, remoteRevoked: result.remoteRevoked });
      } else if (action.do === 'session') {
        const session = await auth.getSession();
        outcomes.push({ do: 'session', ok: true, signedIn: Boolean(session), subject: session?.subject });
      } else if (action.do === 'sleep') {
        await new Promise((resolve) => setTimeout(resolve, action.ms));
      }
    } catch (error) {
      outcomes.push({
        do: action.do,
        ok: false,
        name: error?.name,
        reauthRequired: Boolean(error?.reauthRequired),
        message: String(error?.message || error)
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ label: spec.label, outcomes })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ label: spec.label, fatal: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});
