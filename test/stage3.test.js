'use strict';

const { HISTORICAL_SKIP } = require('./helpers/historical');

// Phase 3.1 stage 3: selected code attachments (architecture revision 3,
// §4–§6; tests U8–U19 and U24 of §14.1, plus the stage 3 brief). Synthetic
// folders, files and editor documents in temporary directories; fake sign-in
// and model; global fetch is blocked for the whole file, so no request can
// leave the process. No real source file, credential or clipboard is used.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  calls, config, createContext, createEditor, createTextDocument, createWebviewView, makeTempDir,
  setActiveEditor, setActiveTextEditor, setWorkspaceFolders, vscode
} = require('./helpers/fake-vscode');
const { readZipEntry } = require('./helpers/read-zip-entry');
const { captureSelection, classifyPath, composeTurn, credentialLines, fenceFor, isInside, sizeOf } = require('../src/attachments');
const { userMaxSelectionCharacters } = require('../src/settings');
const { ConversationStore, normalizeState } = require('../src/store');
const { ChatViewProvider } = require('../src/view');

const root = path.resolve(__dirname, '..');
// A string that appears only inside synthetic selections; the tests look for it
// in requests, files, logs and messages.
const MARKER = 'SYNTHETIC_SELECTION_7f3a';

const realFetch = globalThis.fetch;
const networkCalls = [];
test.before(() => {
  globalThis.fetch = async (target) => {
    networkCalls.push(String(target));
    throw new Error('Network is blocked in this test file.');
  };
});
test.after(() => { globalThis.fetch = realFetch; });

test.afterEach(() => {
  setWorkspaceFolders(undefined);
  setActiveEditor(undefined);
  config.reset();
  calls.warningChoice = 'Sign Out';
  calls.quickPick = undefined;
  vscode.workspace.isTrusted = true;
});

function folder(name, parent = makeTempDir()) {
  const target = path.join(parent, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function file(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

const CODE = [
  'function add(left, right) {',
  `  // ${MARKER}`,
  '  return left + right;',
  '}',
  ''
].join('\n');

// A project folder with src/app.js, open in a one-folder window, and an editor
// on it with lines 1–4 selected.
function project(name = 'alpha', parent) {
  const directory = folder(name, parent);
  const filePath = file(path.join(directory, 'src', 'app.js'), CODE);
  return { directory, filePath };
}

function editorOn(filePath, { text = CODE, languageId = 'javascript', selection = [0, 0, 4, 0], scheme, isDirty, name, extra = [] } = {}) {
  const document = createTextDocument({ path: filePath, text, languageId, scheme, isDirty, name });
  return createEditor(document, [selection, ...extra]);
}

// One editor window: its own provider and store over a shared storage folder.
// `behaviour.mode`: 'ok', 'fail' (server error after sending) or 'hang'
// (streams "partial" and waits for Stop).
async function openWindow(storageDir) {
  const context = createContext({ storageDir });
  const requests = [];
  const behaviour = { mode: 'ok' };
  const auth = { getSession: async () => ({ email: 'synthetic.user@example.test' }), signIn: async () => {}, signOut: async () => ({ remoteRevoked: true }) };
  const openai = {
    listModels: async () => [{ id: 'model-a', name: 'Model A' }],
    async streamResponse({ instructions, messages, onDelta, signal }) {
      requests.push({ instructions, messages: structuredClone(messages) });
      if (behaviour.mode === 'fail') throw new Error('synthetic server failure');
      if (behaviour.mode === 'hang') {
        onDelta('partial');
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      onDelta(`reply ${requests.length}`);
    }
  };
  const store = new ConversationStore(context);
  const provider = new ChatViewProvider(context, auth, openai, store, { writeClipboard: async () => { throw new Error('clipboard used'); }, openExternal: async () => {} });
  const view = createWebviewView();
  await provider.resolveWebviewView(view);
  // As activateWith wires it (src/extension.js).
  const subscription = vscode.workspace.onDidChangeTextDocument((event) => provider.documentChanged(event));
  test.after(() => subscription.dispose());
  const posted = (type) => view.posted.filter((message) => message.type === type);
  return {
    context,
    store,
    provider,
    view,
    requests,
    behaviour,
    posted,
    card: () => posted('attachment').at(-1)?.attachment,
    notice: () => posted('attachment').at(-1)?.notice,
    attach: () => view.send({ type: 'attachSelection' }),
    approve: (reviewed) => view.send({ type: 'approveAttachment', id: provider.attachment?.snapshot.id, reviewed }),
    send: (text, attachmentId) => view.send({ type: 'send', text, model: 'model-a', attachmentId })
  };
}

const historyText = (storageDir) => fs.readFileSync(path.join(storageDir, 'conversations.json'), 'utf8');
const readHistory = (storageDir) => JSON.parse(historyText(storageDir));
const lastUserContent = (request) => request.messages.at(-1).content;
const requestText = (request) => [request.instructions, ...request.messages.map((message) => message.content)].join('\n');

// A one-folder window on a project with an editor selection, attached and approved.
async function attachedWindow({ editorOptions } = {}) {
  const storage = makeTempDir();
  const alpha = project();
  setWorkspaceFolders([alpha.directory]);
  const window = await openWindow(storage);
  const editor = editorOn(alpha.filePath, editorOptions);
  setActiveTextEditor(editor);
  await window.attach();
  return { storage, alpha, window, editor };
}

// ---------------------------------------------------------------------------
// Capture rules (pure)

test('U13 blocked files: every category refused by name and folder; .env.example flagged, not blocked', () => {
  const blocked = [
    '.env', '.env.local', '.ENV.production',
    'server.pem', 'tls.key', 'store.p12', 'cert.PFX', 'app.jks', 'release.keystore', 'putty.ppk', 'id_rsa', 'id_rsa.pub', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', 'credentials', 'credentials.json', 'vault.kdbx', 'main.tfstate', 'main.tfstate.backup',
    path.join('.ssh', 'config'), path.join('.aws', 'config'), path.join('.azure', 'profile.txt'), path.join('.gnupg', 'notes.txt'), path.join('.kube', 'config'), path.join('.docker', 'config.txt')
  ];
  for (const name of blocked) {
    assert.ok(classifyPath(path.join('C:\\proj', name)).blocked, `${name} is blocked`);
  }
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    assert.deepEqual(classifyPath(path.join('C:\\proj', name)), { envExample: true }, `${name} is allowed but flagged`);
  }
  for (const name of ['app.js', 'environment.ts', 'keys.md', 'credentials.md', 'docker-compose.yml', path.join('docs', 'ssh.md')]) {
    assert.deepEqual(classifyPath(path.join('C:\\proj', name)), {}, `${name} is ordinary`);
  }
});

test('U14 containment: separator boundary; on Windows both resolved paths compared exactly as stored (WP-04 R-27/R-29)', () => {
  // Both arguments come from the native realpath, which returns the stored
  // names whatever case the editor used (see the realpath test below).
  assert.ok(isInside('C:\\Work\\Alpha\\src\\a.js', 'C:\\Work\\Alpha', 'win32'));
  assert.ok(!isInside('C:\\Work\\Alpha\\src\\a.js', 'c:\\work\\alpha', 'win32'), 'a differently stored name is a different folder');
  assert.ok(!isInside(`C:\\Work\\${String.fromCodePoint(0x212A)}\\a.js`, 'C:\\Work\\k', 'win32'), 'Kelvin sign is not "k"');
  assert.ok(isInside('C:\\Work\\Alpha', 'C:\\Work\\Alpha\\', 'win32'));
  assert.ok(!isInside('C:\\Work\\Alpha-2\\a.js', 'C:\\Work\\Alpha', 'win32'), 'a sibling with the same prefix is outside');
  assert.ok(!isInside('/work/Alpha/a.js', '/work/alpha', 'linux'));
  assert.ok(isInside('/work/alpha/a.js', '/work/alpha', 'linux'));
});

test('U13/U14 links: a link to a blocked file is refused; a link out of the project is refused; a link inside is allowed', async (t) => {
  const parent = makeTempDir();
  const alpha = project('alpha', parent);
  const outside = folder('elsewhere', parent);
  file(path.join(outside, 'lib.js'), CODE);
  file(path.join(alpha.directory, '.aws', 'config'), CODE);
  // Directory junctions need no extra rights on Windows.
  fs.symlinkSync(path.join(alpha.directory, '.aws'), path.join(alpha.directory, 'conf'), 'junction');
  fs.symlinkSync(outside, path.join(alpha.directory, 'ext'), 'junction');
  fs.symlinkSync(path.join(alpha.directory, 'src'), path.join(alpha.directory, 'inner'), 'junction');
  const context = { kind: 'project', key: 'k'.repeat(32), label: 'alpha' };
  const options = { maxChars: 12_000, folderPath: alpha.directory };

  await assert.rejects(captureSelection(editorOn(path.join(alpha.directory, 'conf', 'config')), context, options), { code: 'blocked', message: /credentials folder \(through a link\)/ });
  await assert.rejects(captureSelection(editorOn(path.join(alpha.directory, 'ext', 'lib.js')), context, options), { code: 'outside', message: /outside the project folder alpha \(through a link\)/ });
  await assert.rejects(captureSelection(editorOn(path.join(outside, 'lib.js')), context, options), { code: 'outside', message: /outside the project folder alpha, so/ });
  if (process.platform === 'win32') {
    // The editor reports "c:\", the file system "C:\": that is not a link.
    const lowerDrive = (value) => value[0].toLowerCase() + value.slice(1);
    await assert.rejects(captureSelection(editorOn(lowerDrive(path.join(outside, 'lib.js'))), context, options), { code: 'outside', message: /outside the project folder alpha, so/ });
    await assert.rejects(captureSelection(editorOn(lowerDrive(path.join(alpha.directory, '.aws', 'config'))), context, options), { code: 'blocked', message: /^config is a credentials folder\. / });
    const lowered = await captureSelection(editorOn(lowerDrive(alpha.filePath)), context, { ...options, folderPath: lowerDrive(alpha.directory) });
    assert.equal(lowered.source.displayPath, 'src/app.js');
    // Whole-path case variants resolve to the stored names (WP-04): still inside.
    const recased = await captureSelection(editorOn(alpha.filePath.toUpperCase()), context, { ...options, folderPath: alpha.directory.toLowerCase() });
    assert.equal(recased.source.displayPath, 'src/app.js');
  }
  const inside = await captureSelection(editorOn(path.join(alpha.directory, 'inner', 'app.js')), context, options);
  assert.equal(inside.source.displayPath, 'src/app.js', 'the display path is the resolved path inside the project');

  // A file symbolic link, where the system allows creating one.
  file(path.join(alpha.directory, '.env'), 'NOT_A_REAL_KEY=synthetic\n');
  let fileLink = true;
  try {
    fs.symlinkSync(path.join(alpha.directory, '.env'), path.join(alpha.directory, 'notes.txt'), 'file');
  } catch {
    fileLink = false;
  }
  if (fileLink) {
    await assert.rejects(captureSelection(editorOn(path.join(alpha.directory, 'notes.txt'), { text: 'NOT_A_REAL_KEY=synthetic\n', selection: [0, 0, 0, 10] }), context, options), { code: 'blocked', message: /\.env is an environment file \(through a link\)/ });
  } else {
    t.diagnostic('file symbolic links need extra rights here; the junction cases above cover link resolution');
  }
});

test('U15 unsupported sources: remote, virtual, notebook, git, output and unknown schemes are refused with a reason', async () => {
  const context = { kind: 'project', key: 'k'.repeat(32), label: 'alpha' };
  const reasons = {
    'vscode-remote': /a remote file/,
    'vscode-vfs': /a virtual file/,
    'vscode-notebook-cell': /a notebook cell/,
    git: /a Git version/,
    output: /an output panel/,
    'something-new': /a "something-new" document/
  };
  for (const [scheme, reason] of Object.entries(reasons)) {
    const editor = editorOn('/remote/app.js', { scheme });
    await assert.rejects(captureSelection(editor, context, { maxChars: 12_000, folderPath: '/remote' }), { code: 'scheme', message: reason }, scheme);
    assert.equal(editor.document.getTextCalls, 0, `${scheme}: nothing read`);
  }
});

test('capture: empty and whitespace-only selections are refused; a whole file is never taken; multiple selections keep the primary only', async () => {
  const { directory, filePath } = project();
  const context = { kind: 'project', key: 'k'.repeat(32), label: 'alpha' };
  const options = { maxChars: 12_000, folderPath: directory };
  const empty = editorOn(filePath, { selection: [1, 3, 1, 3] });
  await assert.rejects(captureSelection(empty, context, options), { code: 'empty', message: /never attaches a whole file/ });
  assert.equal(empty.document.getTextCalls, 0);
  await assert.rejects(captureSelection(editorOn(filePath, { text: '   \n\t\n', selection: [0, 0, 1, 1] }), context, options), { code: 'empty' });
  await assert.rejects(captureSelection(undefined, context, options), { code: 'no-editor' });

  const multi = await captureSelection(editorOn(filePath, { selection: [2, 0, 3, 1], extra: [[0, 0, 0, 8]] }), context, options);
  assert.equal(multi.text, '  return left + right;\n}');
  assert.equal(multi.flags.multipleSelections, 2);
  assert.deepEqual([multi.source.startLine, multi.source.endLine], [3, 4]);
  // A selection ending at the start of a line does not count that line.
  const whole = await captureSelection(editorOn(filePath), context, options);
  assert.deepEqual([whole.source.startLine, whole.source.endLine], [1, 4]);
  assert.ok(Object.isFrozen(whole) && Object.isFrozen(whole.source) && Object.isFrozen(whole.flags.credentialPattern), 'deeply frozen');
});

test('capture: General accepts untitled editors only; untrusted workspaces are refused', async () => {
  const { directory, filePath } = project();
  const general = { kind: 'general', reason: 'no-folder' };
  await assert.rejects(captureSelection(editorOn(filePath), general, { maxChars: 12_000 }), { code: 'general-file' });
  const untitled = await captureSelection(editorOn(undefined, { scheme: 'untitled', name: 'Untitled-3' }), general, { maxChars: 12_000 });
  assert.equal(untitled.source.displayPath, 'Untitled-3');
  assert.equal(untitled.source.untitled, true);
  assert.equal(untitled.source.folderKey, undefined);
  await assert.rejects(captureSelection(editorOn(filePath), { kind: 'project', key: 'k', label: 'alpha' }, { maxChars: 12_000, folderPath: directory, trusted: false }), { code: 'untrusted' });
});

test('U16 sizes: 12,000 accepted, 12,001 refused before reading; 50,000 in settings means 20,000; workspace values ignored', async () => {
  const { directory, filePath } = project();
  const context = { kind: 'project', key: 'k'.repeat(32), label: 'alpha' };
  assert.equal(userMaxSelectionCharacters(), 12_000);
  const at = (length) => editorOn(filePath, { text: 'x'.repeat(length), selection: [0, 0, 0, length] });

  const ok = await captureSelection(at(12_000), context, { maxChars: userMaxSelectionCharacters(), folderPath: directory });
  assert.equal(ok.chars, 12_000);
  const over = at(12_001);
  await assert.rejects(captureSelection(over, context, { maxChars: userMaxSelectionCharacters(), folderPath: directory }), { code: 'too-large', message: /12,001 characters; the limit is 12,000\. .*Nothing was read/ });
  assert.equal(over.document.getTextCalls, 0, 'an oversized selection is not read');

  config.layers.global['planChat.context.maxSelectionCharacters'] = 50_000;
  assert.equal(userMaxSelectionCharacters(), 20_000);
  config.layers.global['planChat.context.maxSelectionCharacters'] = 'many';
  assert.equal(userMaxSelectionCharacters(), 12_000);
  delete config.layers.global['planChat.context.maxSelectionCharacters'];
  config.layers.workspace['planChat.context.maxSelectionCharacters'] = 20_000;
  config.enforceScopes = false;
  assert.equal(userMaxSelectionCharacters(), 12_000, 'a workspace value is never used');
});

test('U27 Unicode: limits count UTF-16 code units; the card counts UTF-8 bytes and estimates tokens', async () => {
  const { directory, filePath } = project();
  const context = { kind: 'project', key: 'k'.repeat(32), label: 'alpha' };
  const emoji = '😀'.repeat(6_000);
  const ok = await captureSelection(editorOn(filePath, { text: emoji, selection: [0, 0, 0, emoji.length] }), context, { maxChars: 12_000, folderPath: directory });
  assert.deepEqual([ok.chars, ok.utf8Bytes, ok.tokens], [12_000, 24_000, 6_000]);
  const more = `${emoji}😀`;
  await assert.rejects(captureSelection(editorOn(filePath, { text: more, selection: [0, 0, 0, more.length] }), context, { maxChars: 12_000, folderPath: directory }), { code: 'too-large' });

  const arabic = 'const greeting = "مرحبا بالعالم"; // تعليق\n';
  assert.deepEqual(sizeOf(arabic), { chars: arabic.length, utf8Bytes: Buffer.byteLength(arabic), tokens: Math.ceil(Buffer.byteLength(arabic) / 4) });
  const combining = 'e\u0301'.repeat(3);
  assert.equal(sizeOf(combining).chars, 6, 'combining marks count separately');
});

test('U18 credential patterns: line numbers of JWT, sk- keys, Bearer, PEM, AKIA and password= are flagged; nothing is changed', () => {
  const text = [
    'const ordinary = 1;',
    'const token = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c3lu";',
    'const plain = "keyboard";',
    `const key = "sk-${'s'.repeat(24)}";`,
    '-----BEGIN RSA PRI' + 'VATE KEY-----',
    `const id = "AKIA${'A'.repeat(16)}";`,
    'const conn = "Server=db;User=app;Password=synthetic-only;";',
    'headers.Authorization = "Bearer synthetic.bearer.value";',
    'access_token=synthetic-value'
  ].join('\n');
  assert.deepEqual(credentialLines(text), [2, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(credentialLines(CODE), []);
});

test('U12/§5.2 composition: typed text, label and a fence longer than any backtick run; the code is unchanged', () => {
  assert.equal(fenceFor('no ticks'), '```');
  assert.equal(fenceFor('a ``` b'), '````');
  assert.equal(fenceFor('`````'), '``````');
  const snippet = 'const s = `x`;\n```\nnested\n```\n';
  assert.equal(composeTurn('Explain this', snippet), `Explain this\n\n[Code selection attached by the user for this message]\n\`\`\`\`\n${snippet}\n\`\`\`\``);
});

// ---------------------------------------------------------------------------
// Provider: review, approval, sending

test('U11 capture and approve make no network call and no model request; the card shows source, sizes and the exact text', async () => {
  const before = networkCalls.length;
  const { window } = await attachedWindow();
  const card = window.card();
  assert.equal(card.text, CODE.slice(0, CODE.lastIndexOf('}') + 2), 'the complete selected text');
  assert.deepEqual(
    { displayPath: card.displayPath, languageId: card.languageId, startLine: card.startLine, endLine: card.endLine, chars: card.chars, approved: card.approved },
    { displayPath: 'src/app.js', languageId: 'javascript', startLine: 1, endLine: 4, chars: card.text.length, approved: false }
  );
  assert.equal(card.utf8Bytes, Buffer.byteLength(card.text));
  await window.approve();
  assert.equal(window.card().approved, true);
  assert.equal(window.requests.length, 0);
  assert.equal(networkCalls.length, before);
  assert.ok(!fs.existsSync(path.join(window.context.storageDir, 'conversations.json')) || !historyText(window.context.storageDir).includes(MARKER), 'nothing stored by attaching');
});

test('U12/U19/§6 sent once: the code is in exactly one request, with no path, name, language, label or key; history keeps metadata only', async () => {
  const { storage, window } = await attachedWindow();
  await window.approve();
  await window.send('Explain this function', window.provider.attachment.snapshot.id);
  for (let turn = 2; turn <= 5; turn += 1) await window.send(`Follow-up question ${turn}`);

  const carrying = window.requests.filter((request) => requestText(request).includes(MARKER));
  assert.equal(carrying.length, 1, 'the code is in exactly one request');
  assert.equal(window.requests.indexOf(carrying[0]), 0);
  const turn = lastUserContent(window.requests[0]);
  assert.ok(turn.startsWith('Explain this function\n\n[Code selection attached by the user for this message]\n```\n'));
  for (const request of window.requests) {
    const body = requestText(request);
    for (const forbidden of ['app.js', 'src/', 'alpha', 'javascript', window.provider.windowContext.key, window.provider.windowContext.keyId]) {
      assert.ok(!body.includes(forbidden), `no "${forbidden}" in any request`);
    }
  }

  const text = historyText(storage);
  assert.ok(!text.includes(MARKER), 'the code is not in the history file');
  assert.ok(!text.includes(window.requests[0] && 'sha256'), 'no hash stored');
  const chat = readHistory(storage).conversations.find((item) => item.messages.some((message) => message.attachments));
  const user = chat.messages.find((message) => message.attachments);
  assert.equal(user.content, 'Explain this function', 'the stored message holds the typed text only');
  assert.deepEqual(Object.keys(user.attachments[0]).sort(), ['chars', 'displayPath', 'endLine', 'flags', 'id', 'kind', 'languageId', 'outcome', 'sentAt', 'startLine', 'utf8Bytes']);
  assert.deepEqual({ ...user.attachments[0], id: 'x', sentAt: 'x' }, {
    id: 'x', kind: 'selection', displayPath: 'src/app.js', languageId: 'javascript', startLine: 1, endLine: 4,
    chars: user.attachments[0].chars, utf8Bytes: user.attachments[0].utf8Bytes,
    flags: { unsaved: false, untitled: false, credentialPatternConfirmed: false }, outcome: 'sent', sentAt: 'x'
  });
  assert.equal(window.provider.attachment, undefined, 'the approval is used up');
  assert.equal(window.card(), null, 'the card is gone');
});

test('U24 reply exclusion: the reply is left out of turns 2–5; Include adds it after confirmation; Stop including removes it; cancelling changes nothing', async () => {
  const { storage, window } = await attachedWindow();
  await window.approve();
  await window.send('Explain this function', window.provider.attachment.snapshot.id);
  const replyId = readHistory(storage).conversations.flatMap((item) => item.messages).find((message) => message.attachmentTurn).id;
  const included = (index) => window.requests[index].messages.some((message) => message.content === 'reply 1');

  await window.send('turn 2');
  await window.send('turn 3');
  assert.ok(!included(1) && !included(2), 'excluded by default');
  assert.ok(window.requests[1].messages.some((message) => message.content === 'Explain this function'), 'the typed question stays in context');
  assert.ok(window.requests[2].messages.some((message) => message.content === 'reply 2'), 'later replies are ordinary history');

  calls.warningChoice = undefined;
  await window.view.send({ type: 'setReplyContext', messageId: replyId, include: true });
  await window.send('turn 4');
  assert.ok(!included(3), 'cancelled confirmation: still excluded');
  assert.match(calls.warning.at(-1), /Include this answer in follow-up messages\?/);

  calls.warningChoice = 'Include in Follow-ups';
  await window.view.send({ type: 'setReplyContext', messageId: replyId, include: true });
  assert.equal(window.posted('messagePolicy').at(-1).contextPolicy, 'included');
  await window.send('turn 5');
  assert.ok(included(4), 'included after confirmation');
  assert.ok(!requestText(window.requests[4]).includes(MARKER), 'including the reply does not resend the code');

  await window.view.send({ type: 'setReplyContext', messageId: replyId, include: false });
  await window.send('turn 6');
  assert.ok(!included(5), 'Stop including takes effect from the next turn');

  // Only replies to attached code can be changed.
  const ordinary = readHistory(storage).conversations.flatMap((item) => item.messages).find((message) => message.content === 'reply 2');
  await window.view.send({ type: 'setReplyContext', messageId: ordinary.id, include: false });
  assert.match(window.posted('error').at(-1).message, /not a reply to attached code/);
});

test('U8 stale approval: approving or sending a replaced id is refused; a new capture needs its own approval', async () => {
  const { storage, alpha, window } = await attachedWindow();
  const first = window.provider.attachment.snapshot.id;
  setActiveTextEditor(editorOn(alpha.filePath, { selection: [2, 0, 3, 1] }));
  await window.attach();
  const second = window.provider.attachment.snapshot.id;
  assert.notEqual(first, second);

  await window.view.send({ type: 'approveAttachment', id: first });
  assert.equal(window.provider.attachment.approved, false, 'the old id approves nothing');
  assert.match(window.notice().text, /replaced or removed/);

  await window.send('use the old one', first);
  assert.equal(window.requests.length, 0);
  assert.match(window.posted('error').at(-1).message, /replaced or removed\. Nothing was sent/);
  assert.equal(window.posted('restoreDraft').at(-1).text, 'use the old one', 'the draft comes back');

  await window.send('the new one, not approved', second);
  assert.equal(window.requests.length, 0);
  assert.match(window.posted('error').at(-1).message, /Approve the attached code/);
  await window.send('no id while one is pending');
  assert.equal(window.requests.length, 0, 'a send cannot skip a pending attachment');
  assert.ok(!fs.existsSync(path.join(storage, 'conversations.json')) || !readHistory(storage).conversations.some((item) => item.messages.length), 'nothing stored');

  await window.approve();
  await window.send('the new one', second);
  assert.equal(window.requests.length, 1);
  assert.ok(lastUserContent(window.requests[0]).endsWith('  return left + right;\n}\n```'), 'the second capture was sent');
});

test('U9 edits after capture: the card says changed; the approved snapshot is sent exactly; nothing is read again; Refresh needs a new approval', async () => {
  const { window, editor } = await attachedWindow();
  await window.approve();
  const snapshot = window.provider.attachment.snapshot;
  assert.equal(editor.document.getTextCalls, 1);
  editor.document.edit(CODE.replace('left + right', 'right - left'));
  assert.equal(window.card().changed, true);
  assert.equal(window.card().approved, true, 'still approved: it is the text the user approved');

  // Refresh takes the current text and resets approval.
  await window.view.send({ type: 'refreshAttachment', id: snapshot.id });
  const refreshed = window.provider.attachment;
  assert.notEqual(refreshed.snapshot.id, snapshot.id);
  assert.equal(refreshed.approved, false);
  assert.ok(refreshed.snapshot.text.includes('right - left'));
  assert.equal(window.card().changed, false);

  // The older snapshot can no longer be sent.
  await window.send('old', snapshot.id);
  assert.equal(window.requests.length, 0);
  await window.approve();
  await window.send('new', refreshed.snapshot.id);
  assert.ok(lastUserContent(window.requests[0]).includes('right - left'));
  assert.equal(editor.document.getTextCalls, 2, 'one read per capture, none at send');
});

test('U9 sent text equals the snapshot byte for byte after the document changes', async () => {
  const { window, editor } = await attachedWindow();
  await window.approve();
  const { text, id } = window.provider.attachment.snapshot;
  editor.document.edit('// replaced entirely\n');
  await window.send('Explain', id);
  assert.equal(lastUserContent(window.requests[0]), composeTurn('Explain', text));
});

test('Refresh when the document is no longer open keeps the current attachment', async () => {
  const { window } = await attachedWindow();
  const { id } = window.provider.attachment.snapshot;
  setActiveTextEditor(undefined);
  await window.view.send({ type: 'refreshAttachment', id });
  assert.equal(window.provider.attachment.snapshot.id, id);
  assert.match(window.notice().text, /Open src\/app\.js in an editor .* unchanged/);
});

test('U10 unsaved changes: the editor buffer is sent, not the file on disk; the card says so', async () => {
  const storage = makeTempDir();
  const alpha = project();
  fs.writeFileSync(alpha.filePath, 'ON_DISK_ONLY\n');
  setWorkspaceFolders([alpha.directory]);
  const window = await openWindow(storage);
  setActiveTextEditor(editorOn(alpha.filePath, { isDirty: true }));
  await window.attach();
  assert.equal(window.card().unsaved, true);
  await window.approve();
  await window.send('Explain', window.provider.attachment.snapshot.id);
  const sent = lastUserContent(window.requests[0]);
  assert.ok(sent.includes(MARKER) && !sent.includes('ON_DISK_ONLY'));
  assert.equal(readHistory(storage).conversations.flatMap((item) => item.messages).find((message) => message.attachments).attachments[0].flags.unsaved, true);
});

test('U18 in the view: flagged lines need a second confirmation; the code is sent unredacted', async () => {
  const secretLine = `const key = "sk-${'s'.repeat(24)}"; // ${MARKER}`;
  const { storage, window } = await attachedWindow({ editorOptions: { text: `const a = 1;\n${secretLine}\n`, selection: [0, 0, 2, 0] } });
  assert.deepEqual(window.card().credentialLines, [2]);
  await window.approve();
  assert.equal(window.provider.attachment.approved, false, 'one approval is not enough');
  assert.match(window.notice().text, /Lines 2 may contain credentials/);
  await window.approve(true);
  assert.equal(window.provider.attachment.approved, true);
  await window.send('Check this', window.provider.attachment.snapshot.id);
  assert.ok(lastUserContent(window.requests[0]).includes(secretLine), 'sent exactly as reviewed');
  const metadata = readHistory(storage).conversations.flatMap((item) => item.messages).find((message) => message.attachments).attachments[0];
  assert.equal(metadata.flags.credentialPatternConfirmed, true);
  assert.ok(!historyText(storage).includes('sk-'), 'not stored');
});

test('U16/U25 budget: a turn over 80,000 is refused with nothing stored or sent; the attachment and draft are kept', async () => {
  const { storage, window } = await attachedWindow();
  await window.approve();
  const before = fs.existsSync(path.join(storage, 'conversations.json')) ? historyText(storage) : undefined;
  const typed = 'q'.repeat(79_950);
  await window.send(typed, window.provider.attachment.snapshot.id);
  assert.equal(window.requests.length, 0);
  assert.equal(fs.existsSync(path.join(storage, 'conversations.json')) ? historyText(storage) : undefined, before, 'history byte-identical');
  assert.match(window.posted('error').at(-1).message, /message and its attached code are too long .*attached code \d.*Nothing was sent or saved; the attachment is still there/);
  assert.equal(window.posted('restoreDraft').at(-1).text, typed);
  assert.equal(window.provider.attachment.approved, true, 'still approved');
  await window.send('short question', window.provider.attachment.snapshot.id);
  assert.equal(window.requests.length, 1);
  const total = window.requests[0].instructions.length + window.requests[0].messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= 80_000);
});

test('failure before sending keeps the attachment; failure after sending uses it up and records it', async () => {
  const { storage, window } = await attachedWindow();
  await window.approve();
  const id = window.provider.attachment.snapshot.id;
  await window.view.send({ type: 'send', text: 'with a missing model', model: 'model-x', attachmentId: id });
  assert.equal(window.requests.length, 0);
  assert.equal(window.provider.attachment?.snapshot.id, id, 'kept after a refusal before sending');
  assert.equal(window.posted('restoreDraft').at(-1).text, 'with a missing model');

  window.behaviour.mode = 'fail';
  await window.send('this one fails at the server', id);
  assert.equal(window.requests.length, 1);
  assert.equal(window.provider.attachment, undefined, 'used up: the request was sent');
  const messages = readHistory(storage).conversations.flatMap((item) => item.messages);
  assert.equal(messages.find((message) => message.attachments).attachments[0].outcome, 'failed');
  const reply = messages.find((message) => message.attachmentTurn);
  assert.equal(reply.error, true);
  assert.equal(reply.contextPolicy, 'excluded');

  window.behaviour.mode = 'ok';
  await window.send('next turn');
  assert.ok(!requestText(window.requests[1]).includes(MARKER), 'no automatic resend after a failure');
});

test('Stop after sending: the attachment is used up, the outcome is stopped and the partial reply stays excluded', async () => {
  const { storage, window } = await attachedWindow();
  await window.approve();
  window.behaviour.mode = 'hang';
  const sending = window.send('stop me', window.provider.attachment.snapshot.id);
  for (let index = 0; index < 100 && !window.requests.length; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await window.view.send({ type: 'stop' });
  await sending;
  const messages = readHistory(storage).conversations.flatMap((item) => item.messages);
  assert.equal(messages.find((message) => message.attachments).attachments[0].outcome, 'stopped');
  const reply = messages.find((message) => message.attachmentTurn);
  assert.deepEqual([reply.content, reply.stopped, reply.contextPolicy], ['partial', true, 'excluded']);
  window.behaviour.mode = 'ok';
  await window.send('after stop');
  assert.ok(!window.requests[1].messages.some((message) => message.content === 'partial'));
  assert.ok(!requestText(window.requests[1]).includes(MARKER));
});

// ---------------------------------------------------------------------------
// Context and privacy boundaries

test('cancellation: New chat, opening another chat, Remove and a newer capture each discard the pending code', async () => {
  const { window, alpha } = await attachedWindow();
  await window.view.send({ type: 'newChat' });
  assert.equal(window.provider.attachment, undefined);
  assert.match(window.notice().text, /new chat was started\. Nothing was sent/);

  await window.send('a first chat');
  const firstChat = window.provider.store.currentId;
  await window.view.send({ type: 'newChat' });
  setActiveTextEditor(editorOn(alpha.filePath));
  await window.attach();
  await window.view.send({ type: 'selectConversation', conversationId: firstChat });
  assert.equal(window.provider.attachment, undefined);
  assert.match(window.notice().text, /another chat was opened/);

  await window.attach();
  await window.view.send({ type: 'removeAttachment', id: window.provider.attachment.snapshot.id });
  assert.equal(window.provider.attachment, undefined);
  assert.equal(window.card(), null);
  assert.match(window.notice().text, /Attachment removed\. Nothing was sent/);
  assert.equal(window.requests.length, 1);
});

test('A → B while composing: switching the window\'s project discards the code; the old id sends nothing into B', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const alpha = project('alpha', parent);
  const beta = project('beta', parent);
  setWorkspaceFolders([alpha.directory]);
  const window = await openWindow(storage);
  setActiveTextEditor(editorOn(alpha.filePath));
  await window.attach();
  await window.approve();
  const id = window.provider.attachment.snapshot.id;

  // The window's folder is replaced: General until the user chooses (DEC-PLANCHAT-002).
  setWorkspaceFolders([beta.directory]);
  await window.provider.workspaceChanged();
  assert.deepEqual([window.provider.windowContext.kind, window.provider.windowContext.reason], ['general', 'folder-removed']);
  assert.equal(window.provider.attachment, undefined);
  assert.match(window.notice().text, /project changed\. Nothing was sent/);

  await window.send('send it to beta', id);
  assert.equal(window.requests.length, 0);
  assert.equal(window.posted('restoreDraft').at(-1).text, 'send it to beta');
  assert.ok(!fs.existsSync(path.join(storage, 'conversations.json')) || !historyText(storage).includes('send it to beta'));

  // In General a file cannot be attached; after choosing B, A's file is outside it.
  setActiveTextEditor(editorOn(alpha.filePath));
  await window.attach();
  assert.match(window.notice().text, /only code from an untitled editor/);
  calls.quickPick = (items) => items.find((item) => String(item.label).includes('beta'));
  await window.view.send({ type: 'chooseProject' });
  assert.equal(window.provider.windowContext.label, 'beta');
  await window.attach();
  assert.equal(window.provider.attachment, undefined);
  assert.match(window.notice().text, /outside the project folder beta/);
});

test('multi-root: choosing another folder discards the code; a file of the other folder cannot be attached', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const alpha = project('alpha', parent);
  const beta = project('beta', parent);
  setWorkspaceFolders([alpha.directory, beta.directory]);
  setActiveEditor(alpha.filePath);
  const window = await openWindow(storage);
  assert.equal(window.provider.windowContext.label, 'alpha');

  setActiveTextEditor(editorOn(beta.filePath));
  await window.attach();
  assert.equal(window.provider.attachment, undefined, 'beta\'s file is outside alpha');
  setActiveTextEditor(editorOn(alpha.filePath));
  await window.attach();
  assert.ok(window.provider.attachment);

  calls.quickPick = (items) => items.find((item) => String(item.label).includes('beta'));
  await window.view.send({ type: 'chooseProject' });
  assert.equal(window.provider.windowContext.label, 'beta');
  assert.equal(window.provider.attachment, undefined);
});

test('a folder removed from the workspace sends the window to General and discards the code', async () => {
  const storage = makeTempDir();
  const alpha = project();
  setWorkspaceFolders([alpha.directory]);
  const window = await openWindow(storage);
  setActiveTextEditor(editorOn(alpha.filePath));
  await window.attach();
  setWorkspaceFolders([]);
  await window.provider.workspaceChanged();
  assert.equal(window.provider.windowContext.kind, 'general');
  assert.equal(window.provider.attachment, undefined);
});

test('cross-window: another window\'s attachment id is refused; each window keeps its own', async () => {
  const storage = makeTempDir();
  const alpha = project();
  setWorkspaceFolders([alpha.directory]);
  const first = await openWindow(storage);
  const second = await openWindow(storage);
  setActiveTextEditor(editorOn(alpha.filePath));
  await first.attach();
  await first.approve();
  const id = first.provider.attachment.snapshot.id;
  await second.send('forged from another window', id);
  assert.equal(second.requests.length, 0);
  assert.match(second.posted('error').at(-1).message, /replaced or removed/);
  assert.equal(second.provider.attachment, undefined);
  assert.equal(first.provider.attachment.snapshot.id, id, 'the first window is unaffected');
});

test('read-only chat: nothing can be attached or included there', async () => {
  const storage = makeTempDir();
  const parent = makeTempDir();
  const alpha = project('alpha', parent);
  const beta = project('beta', parent);
  setWorkspaceFolders([beta.directory]);
  const other = await openWindow(storage);
  await other.send('a beta chat');
  const betaChat = other.provider.store.currentId;

  setWorkspaceFolders([alpha.directory]);
  const window = await openWindow(storage);
  await window.provider.openReadOnly(betaChat);
  setActiveTextEditor(editorOn(alpha.filePath));
  await window.attach();
  assert.equal(window.provider.attachment, undefined);
  assert.match(window.notice().text, /read-only here/);
  await window.view.send({ type: 'setReplyContext', messageId: 'any', include: true });
  assert.match(window.posted('error').at(-1).message, /read-only here/);
});

test('U17 no content logging: refusals, errors and notices never carry the selected text', async () => {
  const logged = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map(String).join(' '));
  }
  try {
    const parent = makeTempDir();
    const alpha = project('alpha', parent);
    const secret = `password=${MARKER}`;
    file(path.join(alpha.directory, '.env'), `${secret}\n`);
    setWorkspaceFolders([alpha.directory]);
    const storage = makeTempDir();
    const window = await openWindow(storage);
    // Blocked file, oversized, stale id, budget refusal, server failure.
    setActiveTextEditor(editorOn(path.join(alpha.directory, '.env'), { text: `${secret}\n`, selection: [0, 0, 1, 0] }));
    await window.attach();
    setActiveTextEditor(editorOn(alpha.filePath, { text: `${MARKER}\n`.repeat(2_000), selection: [0, 0, 2_000, 0] }));
    await window.attach();
    setActiveTextEditor(editorOn(alpha.filePath, { text: `${secret}\n`, selection: [0, 0, 1, 0] }));
    await window.attach();
    await window.send('stale', 'not-the-id');
    await window.approve(true);
    await window.send('q'.repeat(79_990), window.provider.attachment.snapshot.id);
    window.behaviour.mode = 'fail';
    await window.send('fails', window.provider.attachment.snapshot.id);

    const surfaces = [
      ...logged,
      ...calls.info, ...calls.warning, ...calls.error,
      ...window.posted('error').map((message) => message.message),
      ...window.posted('attachment').map((message) => message.notice?.text || ''),
      ...window.posted('messageUpdated').map((message) => `${message.content} ${message.errorText || ''}`)
    ];
    assert.ok(surfaces.length > 5);
    for (const text of surfaces) assert.ok(!String(text).includes(MARKER), `no selected text in: ${String(text).slice(0, 80)}`);
    assert.ok(!historyText(storage).includes(MARKER));
  } finally {
    Object.assign(console, originals);
  }
});

test('restart: attachment metadata survives; the code and the pending attachment do not; the chip data is metadata only', async () => {
  const { storage, window } = await attachedWindow();
  await window.approve();
  await window.send('Explain this function', window.provider.attachment.snapshot.id);
  setActiveTextEditor(undefined);
  // A pending, unsent attachment in the old window is gone after restart.
  const restarted = await openWindow(storage);
  const hydrate = restarted.posted('hydrate').at(-1);
  assert.equal(hydrate.attachment, null);
  const user = hydrate.conversation.messages.find((message) => message.attachments);
  assert.equal(user.attachments[0].displayPath, 'src/app.js');
  assert.ok(!JSON.stringify(hydrate).includes(MARKER), 'nothing of the code reaches the restarted view');
  const reply = hydrate.conversation.messages.find((message) => message.attachmentTurn);
  assert.equal(reply.contextPolicy, 'excluded');
  await restarted.send('after restart');
  assert.ok(!requestText(restarted.requests[0]).includes(MARKER));
  assert.ok(!restarted.requests[0].messages.some((message) => message.content === 'reply 1'), 'still excluded after restart');
});

test('U22 downgrade read-back: 0.1.2, 0.1.1 and 0.1.0 keep attachment metadata and reply markers', { skip: HISTORICAL_SKIP }, () => {
  const sources = {
    '0.1.2': readZipEntry(path.join(root, 'releases', 'plan-chat-antigravity-0.1.2.vsix'), 'extension/src/store.js'),
    '0.1.1': readZipEntry(path.join(root, 'releases', 'plan-chat-antigravity-0.1.1.vsix'), 'extension/src/store.js'),
    '0.1.0': readZipEntry(path.join(root, 'backups', 'baseline-0.1.0', 'plan-chat-antigravity-0.1.0.vsix'), 'extension/src/store.js')
  };
  const extract = (source, name) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(source)[0];
  const attachments = [{ id: 'a1', kind: 'selection', displayPath: 'src/app.js', languageId: 'javascript', startLine: 1, endLine: 4, chars: 70, utf8Bytes: 70, flags: { unsaved: false, untitled: false, credentialPatternConfirmed: false }, outcome: 'sent', sentAt: '2026-10-28T00:00:00.000Z' }];
  const written = normalizeState({
    version: 1,
    conversations: [{
      id: 'c1', title: 'Explain', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
      context: { kind: 'project', key: 'c'.repeat(32), keyId: 'd'.repeat(12), label: 'alpha' },
      messages: [
        { id: 'm1', role: 'user', content: 'Explain', createdAt: '2026-10-28T00:00:00.000Z', attachments },
        { id: 'm2', role: 'assistant', content: 'reply', createdAt: '2026-10-28T00:00:00.000Z', attachmentTurn: true, contextPolicy: 'excluded' }
      ]
    }]
  });
  for (const [version, source] of Object.entries(sources)) {
    const normalize = new Function('crypto', `${extract(source, 'isConversation')}\n${extract(source, 'createConversation')}\n${extract(source, 'normalizeState')}\nreturn normalizeState;`)(crypto);
    const read = normalize(structuredClone(written));
    assert.deepEqual(read.conversations[0].messages, written.conversations[0].messages, `${version} keeps metadata and markers`);
  }
});

// ---------------------------------------------------------------------------
// Surface: manifest, page and exports

test('manifest: Attach Selection command, editor menu only with a selection, setting scoped to the user; version as decided (0.4.1)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.8.0'); // Kenlith 0.8.0: Thinking effort on the 0.7.0 base
  // WP-02 T02-05: the label names the product; no category, so the palette
  // does not read "Plan Chat: Attach Selection to Plan Chat".
  const attach = manifest.contributes.commands.find((command) => command.command === 'planChat.attachSelection');
  assert.equal(attach.title, 'Attach Selection to Kenlith');
  assert.equal(attach.category, undefined);
  assert.deepEqual(manifest.contributes.menus['editor/context'], [{ command: 'planChat.attachSelection', when: 'editorHasSelection', group: '9_planChat@1' }]);
  const setting = manifest.contributes.configuration.properties['planChat.context.maxSelectionCharacters'];
  assert.deepEqual([setting.default, setting.maximum, setting.scope], [12000, 20000, 'application']);
  assert.ok(manifest.activationEvents.includes('onCommand:planChat.attachSelection'));
});

test('webview page: Attach button, review card with LTR code, Approve/Refresh/Remove, notices and reply controls', () => {
  const { getWebviewHtml } = require('../src/view');
  const html = getWebviewHtml({ cspSource: 'vscode-resource:' });
  for (const piece of [
    '<button id="attach" class="secondary" type="button"',
    '<pre id="attachText" class="attach-text" dir="ltr" tabindex="0"',
    '<span id="attachSource" dir="ltr">',
    'Sent once with your next message. The answer to it is not sent with follow-up messages unless you include it.',
    '>Approve</button>', '>Refresh</button>', '>Remove</button>',
    '<input id="attachConfirm" type="checkbox">',
    "'Include in follow-ups'", "'Stop including'",
    'Not sent with follow-up messages (contains a reply to attached code).',
    'The attached code is not kept on this computer. Attach it again to ask more about it.',
    "attachmentId: state.attachment ? state.attachment.id : undefined"
  ]) {
    assert.ok(html.includes(piece), `page contains: ${piece}`);
  }
  // The webview sends only ids for attachments, never text.
  for (const type of ['approveAttachment', 'refreshAttachment', 'removeAttachment']) {
    assert.match(html, new RegExp(`post\\('${type}', \\{ id: state\\.attachment\\.id(, reviewed: elements\\.attachConfirm\\.checked)? \\}\\)`));
  }
});

test('exports: the extension still exports nothing, and the command returns nothing', async () => {
  const extension = require('../src/extension');
  assert.deepEqual(Object.keys(extension).sort(), ['activate', 'activateWith', 'deactivate']);
  const context = createContext();
  const registered = new Map();
  const original = vscode.commands.registerCommand;
  vscode.commands.registerCommand = (name, callback) => { registered.set(name, callback); return { dispose() {} }; };
  try {
    assert.equal(await extension.activate(context), undefined);
    setActiveTextEditor(undefined);
    assert.equal(await registered.get('planChat.attachSelection')(), undefined);
  } finally {
    vscode.commands.registerCommand = original;
  }
});
