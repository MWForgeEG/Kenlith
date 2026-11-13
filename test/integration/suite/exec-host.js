'use strict';

// Kenlith 0.7.0 tasks in a real extension host: the editor's own tasks API
// (vscode.tasks.fetchTasks) for a synthetic folder whose tasks.json holds a
// process task, a shell task and hostile ones; Kenlith's mapping and refusals;
// and one safe task run end to end through the execution service (Class A,
// no approval). No model, no network, no Kenlith UI.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const SRC = process.env.KENLITH_SRC;
const { ExecutionService, fetchWorkspaceTasks } = require(path.join(SRC, 'exec-service.js'));
const { ExecutionStore } = require(path.join(SRC, 'exec-store.js'));

const root = process.env.KENLITH_FOLDER;
const results = [];
async function check(name, run) {
  try { await run(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.stack || error) }); }
}
const assert = require('node:assert/strict');

module.exports = {
  async run() {
    const report = { host: vscode.env.appName, version: vscode.version, results };
    try {
      const realRoot = fs.realpathSync.native(root);
      const tasks = await fetchWorkspaceTasks(vscode, realRoot);
      const byName = Object.fromEntries(tasks.map((t) => [t.name, t]));
      await check('T-1 the editor resolves the workspace tasks; Kenlith sees their real execution kinds', async () => {
        assert.ok(byName['check-syntax'], JSON.stringify(tasks.map((t) => t.name)));
        assert.equal(byName['check-syntax'].execution.kind, 'process');
        assert.equal(byName['say-hello'].execution.kind, 'shell');
        assert.equal(byName['watch-forever'].isBackground, true);
      });
      const svc = new ExecutionService({ store: new ExecutionStore(fs.mkdtempSync(path.join(path.dirname(process.env.KENLITH_RESULT), 'store-'))), fetchTasks: (r) => fetchWorkspaceTasks(vscode, r) });
      await check('T-2 a process task maps to a structured run with ${workspaceFolder} resolved', async () => {
        const r = await svc.taskRequest('check-syntax', realRoot);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.request.executable, 'node');
        assert.equal(r.request.args[0], '--check');
        assert.equal(path.normalize(r.request.args[1]).toLowerCase(), path.join(realRoot, 'src', 'a.js').toLowerCase());
        assert.equal(r.request.shellText, undefined);
      });
      await check('T-3 hostile tasks are refused: background, dependsOn, unknown variables', async () => {
        const want = { 'watch-forever': /background/, chain: /depends on other tasks|custom/, 'reads-env': /env:USERPROFILE/ };
        for (const [name, reason] of Object.entries(want)) {
          const r = await svc.taskRequest(name, realRoot);
          assert.equal(r.ok, false, name);
          assert.match(r.reason, reason, `${name}: ${r.reason}`);
        }
      });
      await check('T-4 a shell task maps to its exact shell text (Class B when run)', async () => {
        const r = await svc.taskRequest('say-hello', realRoot);
        assert.equal(r.ok, true);
        assert.match(r.request.shellText, /echo hello/);
      });
      await check('T-5 a safe process task runs end to end without an approval', async () => {
        await svc.loaded;
        let asked = false;
        const draft = svc.beginTurn({ chatId: 'c', root: realRoot, hasGrant: () => true, askApproval: async () => { asked = true; return 'decline'; }, askOutputSharing: async () => 'withhold', onRunning: () => undefined, signal: new AbortController().signal });
        const out = JSON.parse((await draft.runTask('check-syntax')).raw);
        assert.equal(asked, false, 'no approval for a Class A task');
        assert.equal(out.status, 'succeeded', JSON.stringify(out));
      });
    } catch (error) {
      results.push({ name: 'suite', ok: false, error: String(error?.stack || error) });
    }
    fs.writeFileSync(process.env.KENLITH_RESULT, JSON.stringify(report, null, 2));
  }
};
