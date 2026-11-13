'use strict';

// Kenlith 0.6.0 Review Before Apply in a real extension host (VS Code or
// Antigravity IDE): the proposal modules of this source tree against the
// real vscode.workspace.applyEdit, real text documents, Undo/Redo and Save.
// A synthetic folder only; no model, no network, no Kenlith UI.
// Test IDs: docs/kenlith-0.6.0/TEST-MATRIX.md (H01–H09).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const SRC = process.env.KENLITH_SRC;
const { computeEdits, applyEdits, textSha256 } = require(path.join(SRC, 'proposal.js'));
const { applyProposal, captureBase, editorAdapter } = require(path.join(SRC, 'proposal-apply.js'));

const root = process.env.KENLITH_FOLDER;
const results = [];
const editor = editorAdapter(vscode);
const full = (rel) => path.join(root, ...rel.split('/'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The file entry Apply uses, built the way the review service builds it.
async function entry(relPath, pairs) {
  const captured = await captureBase(root, relPath, editor);
  if (!captured.ok) return captured;
  const computed = computeEdits(captured.text, pairs);
  assert.equal(computed.ok, true, JSON.stringify(computed));
  return { ok: true, relPath, base: captured.base, edits: computed.edits, proposedTextSha256: textSha256(applyEdits(captured.text, computed.edits)), proposed: applyEdits(captured.text, computed.edits) };
}

async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack || error) });
  }
}

async function closeAll() {
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => undefined);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(200);
}

async function run() {
  const write = (rel, text) => { fs.mkdirSync(path.dirname(full(rel)), { recursive: true }); fs.writeFileSync(full(rel), text); };

  await check('H01 two clean files: one WorkspaceEdit changes both documents to the reviewed text; nothing saved', async () => {
    write('h01/a.js', 'const a = 1;\nconsole.log(a);\n');
    write('h01/b.js', 'const b = 2;\n');
    const a = await entry('h01/a.js', [{ find: 'const a = 1;', replace: 'const a = 10;' }]);
    const b = await entry('h01/b.js', [{ find: 'const b = 2;', replace: 'const b = 20;' }]);
    const result = await applyProposal({ files: [a, b] }, { root, editor });
    assert.equal(result.ok, true, JSON.stringify(result));
    const docA = await vscode.workspace.openTextDocument(full('h01/a.js'));
    const docB = await vscode.workspace.openTextDocument(full('h01/b.js'));
    assert.equal(docA.getText(), a.proposed);
    assert.equal(docB.getText(), b.proposed);
    assert.equal(docA.isDirty && docB.isDirty, true, 'unsaved after Apply');
    assert.equal(fs.readFileSync(full('h01/a.js'), 'utf8'), 'const a = 1;\nconsole.log(a);\n', 'disk unchanged');
    await closeAll();
  });

  await check('H02 an open document with unsaved edits is refused before any proposal (DEC-PLANCHAT-027)', async () => {
    write('h02/a.js', 'let x = 1;\n');
    const doc = await vscode.workspace.openTextDocument(full('h02/a.js'));
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), '// typed\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(doc.isDirty, true);
    const refused = await captureBase(root, 'h02/a.js', editor);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'unsaved-changes');
    assert.equal(fs.readFileSync(full('h02/a.js'), 'utf8'), 'let x = 1;\n');
    await closeAll();
  });

  await check('H03 race: the second document changes after Kenlith\'s checks and before the edit; neither document changes', async () => {
    write('h03/a.js', 'A = 1;\n');
    write('h03/b.js', 'B = 1;\n');
    const a = await entry('h03/a.js', [{ find: 'A = 1;', replace: 'A = 2;' }]);
    const b = await entry('h03/b.js', [{ find: 'B = 1;', replace: 'B = 2;' }]);
    const result = await applyProposal({ files: [a, b] }, {
      root,
      editor,
      hooks: {
        beforeEdit: async (targets) => {
          const other = targets[1].document;
          const edit = new vscode.WorkspaceEdit();
          edit.insert(other.uri, new vscode.Position(0, 0), '// another extension\n');
          await vscode.workspace.applyEdit(edit);
        }
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'validate');
    assert.equal(result.relPath, 'h03/b.js');
    const docA = await vscode.workspace.openTextDocument(full('h03/a.js'));
    assert.equal(docA.getText(), 'A = 1;\n', 'the first file was not changed');
    assert.equal(docA.isDirty, false);
    await closeAll();
  });

  await check('H04 the document becomes dirty after the proposal: Apply refuses it and keeps the user\'s edit', async () => {
    write('h04/a.js', 'value = 1;\n');
    const a = await entry('h04/a.js', [{ find: 'value = 1;', replace: 'value = 2;' }]);
    const doc = await vscode.workspace.openTextDocument(full('h04/a.js'));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(1, 0), '// mine\n');
    await vscode.workspace.applyEdit(edit);
    const result = await applyProposal({ files: [a] }, { root, editor });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsaved-changes');
    assert.equal(doc.getText(), 'value = 1;\n// mine\n');
    await closeAll();
  });

  await check('H05 a hard link or a junction swapped in after the proposal is refused at Apply', async () => {
    write('h05/a.js', 'h = 1;\n');
    const a = await entry('h05/a.js', [{ find: 'h = 1;', replace: 'h = 2;' }]);
    fs.linkSync(full('h05/a.js'), full('h05/second-name.js'));
    const linked = await applyProposal({ files: [a] }, { root, editor });
    assert.equal(linked.ok, false);
    assert.equal(linked.code, 'hard-link');
    fs.rmSync(full('h05/second-name.js'));
    write('h05b/inner/c.js', 'c = 1;\n');
    const c = await entry('h05b/inner/c.js', [{ find: 'c = 1;', replace: 'c = 2;' }]);
    const copy = path.join(path.dirname(root), 'outside-copy');
    fs.cpSync(full('h05b/inner'), copy, { recursive: true });
    fs.renameSync(full('h05b/inner'), full('h05b/inner-old'));
    fs.symlinkSync(copy, full('h05b/inner'), 'junction');
    const junction = await applyProposal({ files: [c] }, { root, editor });
    assert.equal(junction.ok, false, JSON.stringify(junction));
    assert.equal(fs.readFileSync(path.join(copy, 'c.js'), 'utf8'), 'c = 1;\n', 'the outside copy is untouched');
    await closeAll();
  });

  await check('H06 Undo restores the base text and Redo the reviewed text', async () => {
    write('h06/a.js', 'one\ntwo\n');
    const a = await entry('h06/a.js', [{ find: 'two', replace: 'TWO' }]);
    const doc = await vscode.workspace.openTextDocument(full('h06/a.js'));
    await vscode.window.showTextDocument(doc);
    const result = await applyProposal({ files: [a] }, { root, editor });
    assert.equal(result.ok, true);
    assert.equal(doc.getText(), 'one\nTWO\n');
    await vscode.commands.executeCommand('undo');
    await sleep(200);
    assert.equal(doc.getText(), 'one\ntwo\n', 'undo');
    await vscode.commands.executeCommand('redo');
    await sleep(200);
    assert.equal(doc.getText(), 'one\nTWO\n', 'redo');
    await closeAll();
  });

  await check('H08 H09 saving after Apply writes exactly the reviewed bytes (LF and CRLF files)', async () => {
    write('h08/lf.js', 'x = 1;\ny = 2;\n');
    write('h08/crlf.js', 'x = 1;\r\ny = 2;\r\n');
    const lf = await entry('h08/lf.js', [{ find: 'x = 1;\ny = 2;', replace: 'x = 1;\nz = 3;\ny = 2;' }]);
    const crlf = await entry('h08/crlf.js', [{ find: 'x = 1;\ny = 2;', replace: 'x = 1;\nz = 3;\ny = 2;' }]);
    assert.equal(crlf.base.eol, '\r\n');
    const result = await applyProposal({ files: [lf, crlf] }, { root, editor });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const document of result.documents) assert.equal(await document.save(), true);
    assert.equal(fs.readFileSync(full('h08/lf.js'), 'utf8'), 'x = 1;\nz = 3;\ny = 2;\n');
    assert.equal(fs.readFileSync(full('h08/crlf.js'), 'utf8'), 'x = 1;\r\nz = 3;\r\ny = 2;\r\n');
    assert.equal(textSha256(fs.readFileSync(full('h08/crlf.js'), 'utf8')), crlf.proposedTextSha256);
    await closeAll();
  });

  await check('H10 a file not open in the editor: Apply opens it, edits it, leaves it unsaved and the disk unchanged', async () => {
    write('h10/a.js', 'n = 1;\n');
    const a = await entry('h10/a.js', [{ find: 'n = 1;', replace: 'n = 2;' }]);
    assert.equal(a.base.documentOpen, false);
    const result = await applyProposal({ files: [a] }, { root, editor });
    assert.equal(result.ok, true);
    assert.equal(result.documents[0].getText(), 'n = 2;\n');
    assert.equal(result.documents[0].isDirty, true);
    assert.equal(fs.readFileSync(full('h10/a.js'), 'utf8'), 'n = 1;\n');
    await closeAll();
  });
}

module.exports = {
  async run() {
    const report = { host: vscode.env.appName, version: vscode.version, results };
    try {
      await run();
    } catch (error) {
      results.push({ name: 'suite', ok: false, error: String(error?.stack || error) });
    }
    fs.writeFileSync(process.env.KENLITH_RESULT, JSON.stringify(report, null, 2));
  }
};
