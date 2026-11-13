'use strict';

// Kenlith 0.5.0 real-editor test of project awareness and the read-only
// tools (Phases 2, 3, 4, 6). One editor process with a throwaway profile on a
// synthetic folder that holds a junction to an outside folder, a .env file,
// node_modules, and a folder excluded by the folder's own files.exclude.
// Kenlith runs from the throwaway test copy (fake sign-in and model, network
// blocked). Nothing is sent anywhere.
//
// Usage: node test/integration/project-awareness.js <editor executable> <label>

const fs = require('node:fs');
const path = require('node:path');
const { launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy } = require('./lib/test-copy');

const [executable, label = 'editor'] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}
const MARKER = `OUTSIDE_MARKER_${Date.now()}`;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 300)}`}`);
};

async function main() {
  const box = await makeSandbox('kenlith-pa-', { 'workbench.colorTheme': 'Default Dark Modern' });
  const project = path.join(box.sandbox, 'projects', 'calc');
  const outside = path.join(box.sandbox, 'projects', 'outside');
  const write = (rel, text) => { const full = path.join(project, ...rel.split('/')); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'OUTSIDE.txt'), `const leaked = "${MARKER}";\n`);
  write('README.md', '# Calculator\n\nAdds numbers.\n');
  write('src/calculator.js', 'function addAll(list) {\n  return list.reduce((sum, value) => sum + value, 0);\n}\nmodule.exports = { addAll };\n');
  write('src/format.js', 'function formatTotal(total) { return `Total: ${total}`; }\n');
  write('.env', `API_KEY=${MARKER}\n`);
  write('node_modules/dep/index.js', `module.exports = "${MARKER}";\n`);
  write('generated/out.js', `// ${MARKER} generated\n`);
  write('.vscode/settings.json', JSON.stringify({ 'files.exclude': { '**/generated': true } }));
  fs.symlinkSync(outside, path.join(project, 'linked'), 'junction');
  const before = fs.readFileSync(path.join(project, 'src', 'calculator.js'), 'utf8');

  console.log(`[${label}] sandbox ${box.sandbox}`);
  const copy = testCopy(box.sandbox);
  const { child, exited } = launch(executable, {
    developmentPaths: [copy],
    userData: box.userData,
    sandbox: box.sandbox,
    openPaths: [project],
    env: { PLAN_CHAT_IT_SCENARIO: 'project', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_MARKER: MARKER, PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) }
  });
  const reportFile = path.join(box.sandbox, 'project-awareness.json');
  await waitFor(() => fs.existsSync(reportFile), 150000, 250).catch(() => undefined);
  const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  box.close();
  if (!fs.existsSync(reportFile)) {
    check('the scenario reported', false, 'no report');
  } else {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const c = report.checks;
    console.log(`[${label}] ${report.host} ${report.version}`);
    check('no errors in the editor', report.errors.length === 0, report.errors);
    check('the window is in project calc; the service exists', c.context?.kind === 'project' && c.context.label === 'calc' && c.serviceExists, c.context);
    check('awareness state without file reads: project, trusted, not shared', c.state?.kind === 'project' && c.state.trusted === true && c.state.sharing === 'none', c.state);
    check('editor signals from real tabs: active src/calculator.js; README.md open; .env left out', c.signals?.activeRelPath === 'src/calculator.js' && c.signals.openRelPaths.includes('README.md') && !c.signals.openRelPaths.includes('.env'), c.signals);
    check('open documents: the edited file is marked dirty', c.open?.ok && c.open.documents.some((d) => d.path === 'src/calculator.js' && d.dirty === true && d.active === true), c.open);
    check('read file returns the saved text, not the unsaved edit', c.readActive?.ok && /function addAll/.test(c.readActive.text) && !c.unsavedSeen, c.readActive?.lines);
    check('.env refused (sensitive)', c.readEnv?.ok === false && c.readEnv.reason === 'sensitive', c.readEnv);
    check('node_modules refused (excluded)', c.readNodeModules?.ok === false && c.readNodeModules.reason === 'excluded', c.readNodeModules);
    check('junction to an outside folder: not listed, not readable', c.readJunction?.ok === false && !c.root?.entries?.includes('linked/'), { read: c.readJunction, entries: c.root?.entries });
    check('files.exclude from the folder settings: generated/ not listed, not readable', c.readGenerated?.ok === false && !c.root?.entries?.includes('generated/'), c.readGenerated);
    check('traversal refused', c.readOutside?.ok === false && c.readOutside.reason === 'invalid-path', c.readOutside);
    check('no output contains outside, secret, node_modules or excluded text', c.markerSeen === false && (c.searchMarker?.matches || []).length === 0);
    check('summary and find files work on the real folder', c.summary?.ok && c.summary.topLevel.includes('src/') && c.find?.ok && c.find.paths.includes('src/calculator.js'), { top: c.summary?.topLevel, find: c.find?.paths });
    check('every returned file is recorded with its SHA-256', (c.sources || []).length > 0 && c.sources.every((s) => /^[0-9a-f]{64}$/.test(s.fileSha256)), c.sources);
    check('"explain this file" picks the active file', c.select?.status === 'ok' && c.select.first === 'src/calculator.js' && c.select.reasons.includes('active editor file'), c.select);
    check('nothing in the project changed', c.fileUnchanged && fs.readFileSync(path.join(project, 'src', 'calculator.js'), 'utf8') === before);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`[${label}] project awareness: ${passed} passed, ${results.length - passed} failed`);
  if (process.env.PLAN_CHAT_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.PLAN_CHAT_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PLAN_CHAT_EVIDENCE_DIR, `project-awareness-${label}.json`), JSON.stringify(results, null, 2));
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
