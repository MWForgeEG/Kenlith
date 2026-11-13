'use strict';

// Real-editor tests for Phase 3.1 stage 3: selected code attachments
// (architecture revision 3, E1, E6, E7, plus the stage 3 brief's switching,
// restart and storage scenarios).
//
// As in stage2.js, every step is a separate editor process with its own
// throwaway profile, and all profiles' Kenlith storage folders are junctions
// to ONE shared synthetic history folder. Folders and files are synthetic.
// Kenlith runs from the throwaway test copy (fake sign-in and model, network
// blocked) with suite/stage3-ui.js, which opens real editors, runs the real
// Attach Selection command and talks to the view as its webview does.
//
// Usage: node test/integration/stage3.js <editor executable> <label>

const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');
const { launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy, root, manifest } = require('./lib/test-copy');

const [executable, label = 'editor'] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const MARKER = 'SYNTHETIC_SELECTION_7f3a';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 300)}`}`);
};

const top = makeOwnedTempDir('plan-chat-stage3-');
const shared = path.join(top, 'shared-storage');
const projects = path.join(top, 'projects');
const alpha = path.join(projects, 'alpha');
const beta = path.join(projects, 'beta');
const outside = path.join(projects, 'outside');
const workspaceFile = path.join(projects, 'both.code-workspace');
for (const dir of [shared, path.join(alpha, 'src'), path.join(beta, 'src'), outside]) fs.mkdirSync(dir, { recursive: true });
const SAMPLE = [
  '// Synthetic sample for Kenlith stage 3 tests.',
  'function greet(name) {',
  `  const text = "مرحبا، " + name; // ${MARKER}`,
  '  return text;',
  '}',
  'module.exports = { greet };',
  ''
].join('\n');
const sample = path.join(alpha, 'src', 'sample.js');
fs.writeFileSync(sample, SAMPLE);
fs.writeFileSync(path.join(alpha, '.env'), 'NOT_A_REAL_KEY=synthetic-value\n');
fs.writeFileSync(path.join(alpha, 'big.txt'), 'x'.repeat(12_001));
fs.writeFileSync(path.join(outside, 'lib.js'), 'const outsideSynthetic = 1;\n');
fs.symlinkSync(outside, path.join(alpha, 'linked'), 'junction');
const other = path.join(beta, 'src', 'other.js');
fs.writeFileSync(other, 'const beta = 1; // BETA_SYNTHETIC\n');
fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }] }, null, 2));
const historyText = () => fs.readFileSync(path.join(shared, 'conversations.json'), 'utf8');

async function profile(stepLabel) {
  const box = await makeSandbox(`plan-chat-s3-${stepLabel}-`, { 'workbench.colorTheme': 'Default Dark Modern' });
  const storageParent = path.join(box.userData, 'User', 'globalStorage');
  fs.mkdirSync(storageParent, { recursive: true });
  fs.symlinkSync(shared, path.join(storageParent, EXTENSION_ID), 'junction');
  return box;
}

async function runStep(step, openPaths = []) {
  const box = await profile(step.label);
  const copy = testCopy(box.sandbox);
  const { child, exited } = launch(executable, {
    developmentPaths: [copy],
    userData: box.userData,
    sandbox: box.sandbox,
    openPaths,
    env: { PLAN_CHAT_IT_SCENARIO: 'stage3', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_STEP: JSON.stringify(step), PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) }
  });
  const reportFile = path.join(box.sandbox, `stage3-${step.label}.json`);
  await waitFor(() => fs.existsSync(reportFile), 180000, 250);
  const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  const blockedFetch = (() => {
    const file = path.join(box.sandbox, 'host-events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('"blockedFetch"')).length : 0;
  })();
  box.close();
  if (!fs.existsSync(reportFile)) {
    check(`${step.label}: the step reported`, false, 'no report');
    return undefined;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const storage = fs.realpathSync.native(report.globalStorage);
  check(`${step.label}: isolated profile; storage is the shared synthetic folder; no network request`, storage.toLowerCase() === fs.realpathSync.native(shared).toLowerCase() && report.globalStorage.toLowerCase().startsWith(box.sandbox.toLowerCase()) && blockedFetch === 0, { storage: report.globalStorage, blockedFetch });
  if (report.errors.length) check(`${step.label}: no errors in the editor`, false, report.errors);
  const failedActions = report.results.filter((entry) => entry.error);
  if (failedActions.length) check(`${step.label}: every action ran`, false, failedActions.map((entry) => `${entry.action}: ${entry.error}`));
  return report;
}

const at = (report, action) => report?.results.find((entry) => entry.action === action);
const requestsOf = (report, action) => (report?.requests || []).filter((request) => request.label === action);
const lastContent = (request) => request?.contents.at(-1) || '';
const anyContent = (request, needle) => Boolean(request?.contents.some((content) => content.includes(needle)));

async function main() {
  console.log(`[${label}] sandbox ${top}`);

  // S1: a folder window on alpha.
  const s1 = await runStep({
    label: 'S1',
    actions: [
      { do: 'open', file: sample, select: [0, 0, 6, 0], label: 'open-sample' },
      { do: 'attach', label: 'E1-attach' },
      { do: 'edit', text: 'const BUFFER_ONLY = 1; // unsaved\n', label: 'edit-after-capture' },
      { do: 'approve', label: 'approve' },
      { do: 'send', text: 'quick: explain the greeting', withAttachment: true, label: 'send-with-code' },
      { do: 'send', text: 'quick: follow-up one', label: 'follow-up' },
      { do: 'select', select: [0, 0, 1, 0], label: 'select-unsaved-line' },
      { do: 'attach', label: 'E6-attach-unsaved' },
      { do: 'approve', label: 'approve-unsaved' },
      { do: 'send', text: 'quick: what is unsaved', withAttachment: true, label: 'E6-send' },
      { do: 'stored', label: 'stored' },
      { do: 'revert', label: 'revert' },
      { do: 'openVirtual', label: 'open-virtual' },
      { do: 'attach', label: 'E7-virtual' },
      { do: 'open', file: path.join(alpha, '.env'), select: [0, 0, 1, 0], label: 'open-env' },
      { do: 'attach', label: 'blocked-env' },
      { do: 'open', file: path.join(alpha, 'linked', 'lib.js'), select: [0, 0, 1, 0], label: 'open-linked' },
      { do: 'attach', label: 'link-outside' },
      { do: 'open', file: path.join(alpha, 'big.txt'), select: [0, 0, 0, 12_001], label: 'open-big' },
      { do: 'attach', label: 'oversized' },
      { do: 'open', file: sample, select: [2, 0, 2, 0], label: 'open-empty-selection' },
      { do: 'attach', label: 'empty-selection' },
      { do: 'select', select: [0, 0, 2, 0], label: 'select-for-pending' },
      { do: 'attach', label: 'left-pending' }
    ]
  }, [alpha]);

  const e1 = at(s1, 'E1-attach');
  check('E1. folder window: Attach Selection (the real command) captures the selection for review', e1?.pending && e1.pending.displayPath === 'src/sample.js' && e1.pending.lines.join() === '1,6' && e1.pending.languageId === 'javascript' && !e1.pending.approved && !e1.pending.untitled && e1.cardShown && e1.activeEditor === 'file', e1);
  check('E1. attaching sent nothing and stored nothing', (s1?.requests || []).every((request) => request.label !== 'E1-attach'));
  const edited = at(s1, 'edit-after-capture');
  check('edit after capture: the card says changed; the snapshot is unchanged', edited?.dirty && edited.pending?.changed && edited.pending.textHash === e1?.pending?.textHash, edited);
  const withCode = requestsOf(s1, 'send-with-code');
  check('send: one request carries the approved snapshot (not the edited buffer); the typed text comes first', withCode.length === 1 && lastContent(withCode[0]).startsWith('quick: explain the greeting\n\n[Code selection attached by the user for this message]\n```\n// Synthetic sample') && lastContent(withCode[0]).includes(MARKER) && !anyContent(withCode[0], 'BUFFER_ONLY'), withCode.map((request) => lastContent(request).slice(0, 120)));
  check('send: no path, file name, language or folder label in the request', withCode.length === 1 && !['sample.js', 'src/', 'alpha', 'javascript'].some((word) => withCode[0].contents.join('\n').includes(word)));
  check('send: the approval is used up', at(s1, 'send-with-code')?.pending === null && at(s1, 'send-with-code')?.cardShown === false);
  const followUp = requestsOf(s1, 'follow-up');
  check('follow-up: the code is not sent again and the reply to it is left out', followUp.length === 1 && !anyContent(followUp[0], MARKER) && !anyContent(followUp[0], 'ATTACHED-REPLY') && anyContent(followUp[0], 'quick: explain the greeting'), followUp[0]?.contents.map((content) => content.slice(0, 50)));
  const e6 = at(s1, 'E6-attach-unsaved');
  check('E6. unsaved buffer: flagged; the sent text is the editor buffer, not the file on disk', e6?.pending?.unsaved && anyContent(requestsOf(s1, 'E6-send')[0], 'BUFFER_ONLY') && !fs.readFileSync(sample, 'utf8').includes('BUFFER_ONLY'), { pending: e6?.pending, sent: lastContent(requestsOf(s1, 'E6-send')[0]).slice(-80) });
  check('E6. the second attachment turn does not resend the first code', requestsOf(s1, 'E6-send').length === 1 && !anyContent(requestsOf(s1, 'E6-send')[0], MARKER));
  const stored = at(s1, 'stored');
  const users = (stored?.messages || []).filter((message) => message.attachments);
  check('stored: user messages hold the typed text and metadata only; replies are marked excluded', users.length === 2 && users.every((message) => !message.content.includes(MARKER) && message.attachments[0].kind === 'selection' && !('text' in message.attachments[0]) && !('sha256' in message.attachments[0])) && (stored.messages || []).filter((message) => message.attachmentTurn).every((message) => message.contextPolicy === 'excluded') && (stored.messages || []).filter((message) => message.attachmentTurn).length === 2, users.map((message) => message.attachments));
  check('revert: the synthetic edit is discarded before the window closes', at(s1, 'revert')?.dirty === false);
  check('E7. a virtual document is refused with a reason', /a "plan-chat-virtual" document/.test(at(s1, 'E7-virtual')?.notice || '') && !at(s1, 'E7-virtual')?.pending, at(s1, 'E7-virtual')?.notice);
  check('blocked: .env is refused, no override offered', /\.env is an environment file\. Code from these files is never attached/.test(at(s1, 'blocked-env')?.notice || '') && !at(s1, 'blocked-env')?.pending, at(s1, 'blocked-env')?.notice);
  check('link: a file reached through a junction out of the project is refused', /outside the project folder alpha \(through a link\)/.test(at(s1, 'link-outside')?.notice || ''), at(s1, 'link-outside')?.notice);
  check('oversized: 12,001 characters refused before reading', /12,001 characters; the limit is 12,000/.test(at(s1, 'oversized')?.notice || '') && !at(s1, 'oversized')?.pending, at(s1, 'oversized')?.notice);
  check('empty selection: refused; no whole file attached', /Nothing is selected/.test(at(s1, 'empty-selection')?.notice || '') && !at(s1, 'empty-selection')?.pending, at(s1, 'empty-selection')?.notice);
  check('a pending attachment exists when the window closes', Boolean(at(s1, 'left-pending')?.pending));

  // S2: restart in alpha.
  const s2 = await runStep({ label: 'S2', actions: [{ do: 'stored', label: 'after-restart' }, { do: 'send', text: 'quick: after restart', label: 'send-after-restart' }] }, [alpha]);
  const restarted = at(s2, 'after-restart');
  check('restart: no pending attachment survives; the view gets none', restarted && restarted.pending === null && restarted.hydratedAttachment === null, restarted && { pending: restarted.pending, hydrated: restarted.hydratedAttachment });
  check('restart: attachment metadata is still on the messages', (restarted?.messages || []).filter((message) => message.attachments).length === 2, (restarted?.messages || []).length);
  const afterRestart = requestsOf(s2, 'send-after-restart');
  check('restart: no automatic resend; replies to attached code still left out', afterRestart.length === 1 && !anyContent(afterRestart[0], MARKER) && !anyContent(afterRestart[0], 'BUFFER_ONLY') && !anyContent(afterRestart[0], 'ATTACHED-REPLY'), afterRestart[0]?.contents.map((content) => content.slice(0, 40)));

  // M1: multi-root workspace, A → B while composing.
  const m1 = await runStep({
    label: 'M1',
    actions: [
      { do: 'choose', folder: 'alpha', label: 'choose-alpha' },
      { do: 'open', file: sample, select: [0, 0, 6, 0], label: 'open-alpha-file' },
      { do: 'attach', label: 'attach-in-alpha' },
      { do: 'approve', label: 'approve-in-alpha' },
      { do: 'remember', label: 'remember' },
      { do: 'choose', folder: 'beta', label: 'switch-to-beta' },
      { do: 'send', text: 'quick: send alpha code into beta', useRemembered: true, label: 'send-old-id-in-beta' },
      { do: 'attach', label: 'alpha-file-in-beta' },
      { do: 'open', file: other, select: [0, 0, 1, 0], label: 'open-beta-file' },
      { do: 'attach', label: 'attach-in-beta' },
      { do: 'newChat', label: 'new-chat-cancels' }
    ]
  }, [workspaceFile]);
  check('M1. attached in alpha', at(m1, 'attach-in-alpha')?.pending?.displayPath === 'src/sample.js' && at(m1, 'attach-in-alpha')?.context.label === 'alpha', at(m1, 'attach-in-alpha'));
  const switched = at(m1, 'switch-to-beta');
  check('A → B: switching the project discards the code and says so', switched?.context.label === 'beta' && switched.pending === null && /project changed\. Nothing was sent/.test(switched.notice || ''), switched);
  const oldId = at(m1, 'send-old-id-in-beta');
  check('A → B: the old attachment id sends nothing; the draft comes back', oldId && !oldId.requestSent && oldId.restoredDraft === 'quick: send alpha code into beta' && /replaced or removed/.test(oldId.errors[0] || ''), oldId);
  check('A → B: alpha\'s file cannot be attached in beta (and is not called a link)', /outside the project folder beta, so/.test(at(m1, 'alpha-file-in-beta')?.notice || ''), at(m1, 'alpha-file-in-beta')?.notice);
  check('A → B: beta\'s own file can be attached', at(m1, 'attach-in-beta')?.pending?.displayPath === 'src/other.js', at(m1, 'attach-in-beta')?.pending);
  check('New chat discards a pending attachment', at(m1, 'new-chat-cancels')?.pending === null && /new chat was started/.test(at(m1, 'new-chat-cancels')?.notice || ''), at(m1, 'new-chat-cancels'));
  check('M1. no request was sent in the multi-root step', (m1?.requests || []).length === 0, (m1?.requests || []).length);

  // G1: empty window (General): untitled editors only.
  const g1 = await runStep({
    label: 'G1',
    actions: [
      { do: 'openUntitled', content: 'const untitledSynthetic = 1; // UNTITLED_MARKER\nconst two = 2;\n', select: [0, 0, 2, 0], label: 'open-untitled' },
      { do: 'attach', label: 'attach-untitled' },
      { do: 'approve', label: 'approve-untitled' },
      { do: 'send', text: 'quick: untitled code', withAttachment: true, label: 'send-untitled' },
      { do: 'open', file: sample, select: [0, 0, 1, 0], label: 'open-file-in-general' },
      { do: 'attach', label: 'file-in-general' },
      { do: 'discard', label: 'discard' }
    ]
  }, []);
  const untitled = at(g1, 'attach-untitled');
  check('General: an untitled editor can be attached (flagged untitled)', untitled?.context.kind === 'general' && untitled.pending?.untitled && /^Untitled-\d+$/.test(untitled.pending.displayPath), untitled);
  check('General: the untitled code is sent once', requestsOf(g1, 'send-untitled').length === 1 && anyContent(requestsOf(g1, 'send-untitled')[0], 'UNTITLED_MARKER'));
  check('General: a file from disk is refused', /only code from an untitled editor/.test(at(g1, 'file-in-general')?.notice || ''), at(g1, 'file-in-general')?.notice);

  // Whole-file checks on the shared history.
  const text = historyText();
  const history = JSON.parse(text);
  const messages = history.conversations.flatMap((conversation) => conversation.messages);
  check('history file: no attached code (markers, buffer text, untitled text)', !text.includes(MARKER) && !text.includes('BUFFER_ONLY') && !text.includes('UNTITLED_MARKER') && !text.includes('مرحبا'), text.length);
  check('history file: no hash, no path to the folders', !/sha256/.test(text) && !/projects[\\/]|[A-Za-z]:\\\\/.test(text));
  check('history file: three sent attachments recorded as metadata', messages.filter((message) => message.attachments).length === 3 && messages.filter((message) => message.attachments).every((message) => message.attachments[0].outcome === 'sent'), messages.filter((message) => message.attachments).map((message) => message.attachments[0]));
  check('no temporary or lock files left', fs.readdirSync(shared).filter((name) => /\.tmp$|\.lock$/.test(name)).length === 0, fs.readdirSync(shared));

  const failed = results.filter((item) => !item.ok).length;
  // PLAN_CHAT_EVIDENCE_DIR, when set, receives the result instead of the historical default path (M1 WP-08), so later runs never write into earlier releases' evidence.
  const out = path.join(process.env.PLAN_CHAT_EVIDENCE_DIR || path.join(root, 'design', 'uiux-review', 'stage3'), `stage3-${label}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ label, passed: results.length - failed, failed, results }, null, 2));
  console.log(`[${label}] stage 3: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
