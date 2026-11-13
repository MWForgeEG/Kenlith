'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

// Starts `node <worker> <json spec>` as an independent OS process and resolves
// with its exit code, parsed JSON result line and raw output.
function runWorker(worker, spec, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, worker), JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${worker} timed out: ${stderr.slice(-500)}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      let result;
      try {
        result = line ? JSON.parse(line) : undefined;
      } catch {
        result = undefined;
      }
      resolve({ code, result, stdout, stderr, pid: child.pid });
    });
  });
}

module.exports = { runWorker };
