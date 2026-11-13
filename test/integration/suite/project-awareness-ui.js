'use strict';

// Scenario "project" for test/integration/project-awareness.js (Kenlith
// 0.5.0). Runs only inside the throwaway test copy (lib/test-copy.js copies it
// to test-scenario/project.js) with the fakes of sidebar-ui.js (no network,
// fake sign-in). In a real editor window on a real synthetic folder it checks
// the Project Context service through the editor's own API: the open tabs, the
// active editor, unsaved changes, files.exclude from the folder's settings, and
// the read-only tools against a real junction, .env and node_modules. Nothing
// is sent anywhere; the result goes to PLAN_CHAT_IT_UI_DIR/project-awareness.json.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (name, args) => ({ callId: name, name, arguments: JSON.stringify(args) });

async function run(provider) {
  const dir = process.env.PLAN_CHAT_IT_UI_DIR;
  const marker = process.env.PLAN_CHAT_IT_MARKER || 'OUTSIDE_MARKER';
  const report = { host: vscode.env.appName, version: vscode.version, trusted: vscode.workspace.isTrusted, checks: {}, outputs: [], errors: [] };
  const write = () => fs.writeFileSync(path.join(dir, 'project-awareness.json'), JSON.stringify(report, null, 2));
  try {
    for (let index = 0; index < 200 && provider.windowContext?.kind !== 'project'; index += 1) await sleep(100);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    report.checks.context = { kind: provider.windowContext?.kind, label: provider.windowContext?.label };
    const service = provider.projectContext;
    report.checks.serviceExists = Boolean(service);
    report.checks.stateBeforeEditors = service.state({ sharing: 'none' });

    // Real tabs: README.md, .env (sensitive) and src/calculator.js (active, then edited without saving).
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'README.md')), { preview: false });
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, '.env')), { preview: false });
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'src', 'calculator.js')), { preview: false });
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '// UNSAVED_EDIT\n'));
    await sleep(300);
    report.checks.signals = service.editorSignals();
    report.checks.state = service.state({ sharing: 'none' });

    const turn = await service.createTurn({ limits: { maxRounds: 50, maxCalls: 50, maxTurnChars: 1e6 } });
    const tools = [
      ['summary', call('project_summary', {})],
      ['root', call('project_list_directory', { path: null })],
      ['open', call('project_open_documents', {})],
      ['readActive', call('project_read_file', { path: 'src/calculator.js', start_line: null, end_line: null })],
      ['readEnv', call('project_read_file', { path: '.env', start_line: null, end_line: null })],
      ['readNodeModules', call('project_read_file', { path: 'node_modules/dep/index.js', start_line: null, end_line: null })],
      ['readJunction', call('project_read_file', { path: 'linked/OUTSIDE.txt', start_line: null, end_line: null })],
      ['readGenerated', call('project_read_file', { path: 'generated/out.js', start_line: null, end_line: null })],
      ['readOutside', call('project_read_file', { path: '../outside/OUTSIDE.txt', start_line: null, end_line: null })],
      ['searchMarker', call('project_search_text', { query: 'leaked' })],
      ['find', call('project_find_files', { query: 'calculator format' })]
    ];
    for (const [label, item] of tools) {
      const [output] = await turn.runRound([item]);
      report.checks[label] = output.result;
      report.outputs.push(output.output);
    }
    report.checks.markerSeen = report.outputs.some((output) => output.includes(marker));
    report.checks.unsavedSeen = report.outputs.some((output) => output.includes('UNSAVED_EDIT'));
    report.checks.sources = turn.sentSources();
    const explain = await service.select({ query: 'explain this file' });
    report.checks.select = { status: explain.status, first: explain.excerpts[0]?.relPath, reasons: explain.excerpts[0]?.reasons };
    report.checks.sharingState = await provider.projectSharingState();
    // Leave nothing unsaved, so the window closes without a prompt.
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    report.checks.fileUnchanged = fs.readFileSync(path.join(folder, 'src', 'calculator.js'), 'utf8').startsWith('function addAll');
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  write();
}

module.exports = { run };
