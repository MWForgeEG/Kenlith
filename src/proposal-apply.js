'use strict';

// Kenlith 0.6.0: base snapshots and the Apply executor
// (docs/kenlith-0.6.0/ARCHITECTURE.md §5, §7).
//
// This is the only module that changes a project file, and it does so only
// through the editor: one WorkspaceEdit into the editor documents, never a
// disk write and never a save. Before the edit, every target is checked
// against the base the reviewed diff was built from: the bytes on disk
// (contained read: no link, no hard link, same identity) and the editor
// document (not dirty, same text). The last check runs synchronously right
// before applyEdit, so no document event can arrive in between. After the
// edit, every document must hold exactly the reviewed result.

const path = require('node:path');
const { readContained } = require('./workspace-safety');
const { applyEdits, lineEnding, textSha256 } = require('./proposal');

const MAX_FILE_BYTES = 512 * 1024;

const fail = (code, relPath, detail) => ({ ok: false, code, ...(relPath ? { relPath } : {}), ...(detail ? { detail } : {}) });

function samePath(a, b) {
  const x = path.normalize(String(a));
  const y = path.normalize(String(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// What a proposal for `relPath` is built from, or why the file cannot be a
// target (DEC-PLANCHAT-027: an open document with unsaved changes never is).
async function captureBase(root, relPath, editor) {
  const read = await readContained(root, relPath, { maxBytes: MAX_FILE_BYTES });
  if (!read.ok) return fail(read.reason, relPath);
  const fsPath = path.join(root, ...relPath.split('/'));
  const document = editor.findDocument(fsPath);
  if (document?.isDirty) return fail('unsaved-changes', relPath, 'The file has unsaved edits in the editor. Save or discard them, then ask again.');
  if (document && textSha256(document.getText()) !== textSha256(read.text)) return fail('editor-out-of-date', relPath, 'The editor shows different text than the saved file.');
  const eol = lineEnding(read.text);
  if (eol === 'mixed') return fail('mixed-line-endings', relPath, 'The file mixes line endings.');
  return {
    ok: true,
    text: read.text,
    base: {
      sha256: read.sha256,
      textSha256: textSha256(read.text),
      size: read.size,
      mtimeMs: read.mtimeMs,
      ino: String(read.ino),
      eol,
      documentOpen: Boolean(document),
      ...(document ? { documentVersion: document.version } : {})
    }
  };
}

// The disk side of a target, checked against its base: { ok, text }.
async function checkDisk(root, file) {
  const read = await readContained(root, file.relPath, { maxBytes: MAX_FILE_BYTES });
  if (!read.ok) return fail(read.reason === 'missing' ? 'missing' : read.reason, file.relPath);
  const base = file.base;
  if (read.sha256 !== base.sha256 || read.size !== base.size) return fail('changed', file.relPath, 'The file changed after this proposal was made.');
  if (String(read.ino) !== String(base.ino)) return fail('replaced', file.relPath, 'The file was replaced after this proposal was made.');
  if (read.mtimeMs !== base.mtimeMs) return fail('changed', file.relPath, 'The file was written after this proposal was made.');
  return { ok: true, text: read.text };
}

// The editor side, without opening anything: an open target must be clean
// and show the base text.
function checkOpenDocument(root, file, editor) {
  const document = editor.findDocument(path.join(root, ...file.relPath.split('/')));
  if (!document) return { ok: true };
  if (document.isDirty) return fail('unsaved-changes', file.relPath, 'The file has unsaved edits in the editor.');
  if (textSha256(document.getText()) !== file.base.textSha256) return fail('changed', file.relPath, 'The file\'s text in the editor changed after this proposal was made.');
  return { ok: true };
}

// Steps 4 to 7 of §5. `hooks.beforeEdit` is for tests (a race just before
// the edit). Returns { ok: true, documents } or a failure with `stage`:
// 'validate' (nothing written), 'apply' (the editor refused; `unchanged`
// says whether every document still holds its base) or 'verify' (the result
// differs; `differs` names the files).
async function applyProposal(proposal, { root, editor, hooks = {} }) {
  const targets = [];
  for (const file of proposal.files) {
    const disk = await checkDisk(root, file);
    if (!disk.ok) return { ...disk, stage: 'validate' };
    const fsPath = path.join(root, ...file.relPath.split('/'));
    let document;
    try {
      document = await editor.openDocument(fsPath);
    } catch (error) {
      return { ...fail('unreadable', file.relPath, String(error?.message || error)), stage: 'validate' };
    }
    if (!document || !samePath(document.fsPath ?? document.uri?.fsPath, fsPath)) return { ...fail('changed', file.relPath, 'The editor opened a different file.'), stage: 'validate' };
    targets.push({ file, document, version: document.version });
  }
  if (hooks.beforeEdit) await hooks.beforeEdit(targets);
  // Synchronous from here to applyEdit: no editor event runs in between.
  for (const target of targets) {
    if (target.document.isDirty) return { ...fail('unsaved-changes', target.file.relPath, 'The file has unsaved edits in the editor.'), stage: 'validate' };
    if (target.document.version !== target.version || textSha256(target.document.getText()) !== target.file.base.textSha256) {
      return { ...fail('changed', target.file.relPath, 'The file\'s text in the editor changed after this proposal was made.'), stage: 'validate' };
    }
  }
  let applied;
  try {
    applied = await editor.applyEdits(targets.map(({ document, file }) => ({ document, edits: file.edits })));
  } catch (error) {
    applied = false;
    targets.error = String(error?.message || error);
  }
  if (!applied) {
    const differs = targets.filter((target) => textSha256(target.document.getText()) !== target.file.base.textSha256).map((target) => target.file.relPath);
    return { ...fail('editor-refused', undefined, targets.error || 'The editor refused the change.'), stage: 'apply', unchanged: differs.length === 0, differs };
  }
  const differs = targets.filter((target) => textSha256(target.document.getText()) !== target.file.proposedTextSha256).map((target) => target.file.relPath);
  if (differs.length) return { ...fail('result-differs', differs[0], 'After the change, the text is not the reviewed result.'), stage: 'verify', differs };
  return { ok: true, documents: targets.map((target) => target.document) };
}

// The proposed text of a file from its verified base text.
function proposedText(baseText, file) {
  return applyEdits(baseText, file.edits);
}

// The editor adapter over the vscode API. Only this touches applyEdit,
// openTextDocument and textDocuments.
function editorAdapter(vscode) {
  return {
    findDocument(fsPath) {
      return (vscode.workspace.textDocuments || []).find((document) => document.uri?.scheme === 'file' && samePath(document.uri.fsPath, fsPath));
    },
    async openDocument(fsPath) {
      return vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    },
    async applyEdits(targets) {
      const edit = new vscode.WorkspaceEdit();
      for (const { document, edits } of targets) {
        for (const item of edits) edit.replace(document.uri, new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)), item.text);
      }
      return vscode.workspace.applyEdit(edit);
    },
    // Beside the chat, so its review card (and the Applied, not saved
    // status) stays in view.
    async show(documents) {
      for (const document of documents) {
        try { await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }); } catch { /* shown is a convenience */ }
      }
    },
    async showDiff(left, right, title) {
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
  };
}

module.exports = { MAX_FILE_BYTES, applyProposal, captureBase, checkDisk, checkOpenDocument, editorAdapter, proposedText, samePath };
