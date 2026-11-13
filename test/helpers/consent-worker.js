'use strict';

// Runs a ConsentStore in its own OS process, as one editor window would.
// Usage: node consent-worker.js <json spec>
// spec: { storageDir, barrierDir, label, grantKey, lockOptions, pollMs, watchFs,
//         actions: [{ do: 'read' | 'mint' | 'grant' | 'revoke' | 'invalidate'
//                       | 'signal' | 'wait' | 'holdLock' | 'pauseAt' | 'watchFor' | 'sleep', ... }] }
// Barriers are files in barrierDir: 'signal' creates one, 'wait' polls for it.
// 'pauseAt' makes the next pass through a named store step create a barrier
// and wait for another, so two processes interleave in a fixed order.
// Prints one JSON line with every action's outcome.

const fs = require('node:fs');
const path = require('node:path');
const { ConsentStore } = require('../../src/consent');
const { acquireLock } = require('../../src/lock');

const spec = JSON.parse(process.argv[2]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const barrier = (name) => path.join(spec.barrierDir, name);

async function waitFor(name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(barrier(name))) {
    if (Date.now() > deadline) throw new Error(`barrier ${name} never appeared`);
    await sleep(10);
  }
}

const pauses = {};
const hooks = new Proxy({}, {
  get: (target, step) => (pauses[step]?.length ? async () => {
    const { signal, wait } = pauses[step].shift();
    if (signal) fs.writeFileSync(barrier(signal), '');
    if (wait) await waitFor(wait);
  } : undefined)
});

async function main() {
  const store = new ConsentStore(spec.storageDir, { lockOptions: spec.lockOptions, pollMs: spec.pollMs, watchFs: spec.watchFs, hooks });
  const results = [];
  let lastRead;
  let token;
  for (const action of spec.actions) {
    switch (action.do) {
      case 'read':
        lastRead = await store.read(spec.grantKey);
        results.push({ do: 'read', ...lastRead });
        break;
      case 'mint':
        token = store.mintToken(spec.grantKey, lastRead.revision);
        results.push({ do: 'mint', revision: lastRead.revision });
        break;
      case 'grant':
        results.push({ do: 'grant', ...(await store.grant(spec.grantKey, { expectedRevision: action.expectedRevision ?? lastRead.revision, token, projectLabel: 'project-a' })) });
        break;
      case 'revoke':
      case 'invalidate':
        results.push({ do: action.do, ...(await store[action.do](spec.grantKey, `${spec.label}-${action.do}`)) });
        break;
      case 'signal':
        fs.writeFileSync(barrier(action.name), '');
        break;
      case 'wait':
        await waitFor(action.name, action.timeoutMs);
        break;
      case 'holdLock': {
        const handle = await acquireLock(path.join(spec.storageDir, 'consents.lock'));
        if (action.signal) fs.writeFileSync(barrier(action.signal), '');
        await sleep(action.ms);
        await handle.release();
        results.push({ do: 'holdLock', ms: action.ms });
        break;
      }
      case 'pauseAt':
        (pauses[action.step] ||= []).push({ signal: action.signal, wait: action.wait });
        break;
      case 'watchFor': {
        const started = Date.now();
        const seen = await new Promise((resolve) => {
          const handle = store.watch((event) => {
            if (event.state === action.state) {
              handle.dispose();
              resolve({ ...event, elapsedMs: Date.now() - started });
            }
          });
          handle.ready.then(() => { if (action.signal) fs.writeFileSync(barrier(action.signal), ''); });
          setTimeout(() => { handle.dispose(); resolve(null); }, action.timeoutMs || 10_000);
        });
        results.push({ do: 'watchFor', seen });
        break;
      }
      case 'sleep':
        await sleep(action.ms);
        break;
      default:
        throw new Error(`unknown action ${action.do}`);
    }
  }
  return results;
}

main().then(
  (results) => { console.log(JSON.stringify({ label: spec.label, pid: process.pid, results })); },
  (error) => { console.log(JSON.stringify({ label: spec.label, error: String(error?.stack || error) })); process.exitCode = 1; }
);
