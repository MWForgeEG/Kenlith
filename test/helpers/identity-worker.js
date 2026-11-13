'use strict';

// Loads (creating if needed) the project identity key in its own OS process.
// Usage: node identity-worker.js <json spec>  spec: { directory, startAt, label }
// Prints one JSON line: { ok, label, keyId } or { ok: false, error }.

require('./fake-vscode');
const { IdentityKeys } = require('../../src/project');

async function main() {
  const spec = JSON.parse(process.argv[2]);
  if (spec.startAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, spec.startAt - Date.now())));
  }
  const keys = new IdentityKeys(spec.directory);
  const record = await keys.load();
  process.stdout.write(`${JSON.stringify({ ok: true, label: spec.label, keyId: record.keyId })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.stack || error) })}\n`);
  process.exit(1);
});
