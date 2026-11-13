'use strict';

// Real-editor tests for the 0.4.0 workspace (UX-02, UX-03, UX-05, UX-06 #5,
// #6, #19, #20, #22): the shipped wiring in a throwaway profile, driven over
// the editor's debugging port with trusted mouse and keyboard input.
//
// Phase 1 (dark theme): the Account and Chats trees, chats in editor tabs
// (active group and beside), opening a chat from the tree, sending with the
// keyboard, Arabic right-to-left text, an unsent draft, and a reply that is
// still streaming when the editor quits. Phase 2 (light theme, same profile):
// tabs restored, the draft back, the cut-off reply marked interrupted, and no
// request sent by itself. Screenshots of both are saved as evidence.
//
// Usage: node test/integration/workspace-ui.js <editor executable> <label> [evidence dir]

const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');
const { Cdp, inputFor, launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy } = require('./lib/test-copy');

const [executable, label = 'editor', evidenceArg] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path.');
  process.exit(2);
}
const evidence = evidenceArg || path.join(__dirname, '..', '..', 'docs', 'release-evidence', 'UX-040', 'integration', label);
fs.mkdirSync(evidence, { recursive: true });
const PORT = 9361;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
};

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
async function workbench() {
  const target = (await targets()).find((item) => item.type === 'page' && /workbench/.test(item.url));
  return Cdp.connect(target.webSocketDebuggerUrl);
}
const hideWelcome = (page) => page.evaluate("(() => { const o = document.querySelector('.antigravity-ide-welcome'); if (o) o.style.display = 'none'; return true; })()");

// The chat webview whose title shows `title`.
async function chatView(title, timeout = 30000) {
  let found;
  await waitFor(async () => {
    for (const target of (await targets()).filter((item) => item.url.startsWith('vscode-webview://'))) {
      const web = await Cdp.connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (!web) continue;
      const shown = await web.evaluate("document.getElementById('active-frame')?.contentDocument?.getElementById('chatTitle')?.textContent || null").catch(() => null);
      if (shown && shown.includes(title)) {
        // Every Kenlith tab's frame shares the address up to '?'; its own
        // id parameter tells them apart.
        found = { web, frameBase: target.url.split('?')[0], frameId: new URL(target.url).searchParams.get('id') };
        return true;
      }
      web.close();
    }
    return false;
  }, timeout, 400);
  return found;
}
const inChat = (view, expression) => view.web.evaluate(`(() => { const f = document.getElementById('active-frame'); const d = f.contentDocument; const w = f.contentWindow; return (${expression}); })()`);
async function clickInChat(page, input, view, selector) {
  const outer = await page.evaluate(`(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(view.frameBase)}) && new URL(i.src).searchParams.get('id') === ${JSON.stringify(view.frameId)}); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const inner = await view.web.evaluate(`(() => { const f = document.getElementById('active-frame'); const r = f.getBoundingClientRect(); const e = f.contentDocument.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 }; })()`);
  if (!outer || !inner) throw new Error(`cannot click ${selector}`);
  await input.click(outer.x + inner.x, outer.y + inner.y);
}
// Types into a chat's message box. The click must put keyboard focus in the
// box; a tab shown again reloads its page, and the first click can land
// before it is ready (recorded in typing.json, never hidden).
const typing = [];
async function typeInto(page, input, view, text) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickInChat(page, input, view, '#prompt');
    await sleep(300);
    const focused = await inChat(view, "d.activeElement && d.activeElement.id");
    if (focused !== 'prompt') {
      const outer = await page.evaluate(`(() => { const f = [...document.querySelectorAll('iframe')].filter((i) => i.src && i.src.startsWith(${JSON.stringify(view.frameBase)})); return f.map((i) => { const r = i.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }); })()`);
      const inner = await view.web.evaluate("(() => { const f = document.getElementById('active-frame'); const r = f.getBoundingClientRect(); const e = f.contentDocument.getElementById('prompt').getBoundingClientRect(); return { frame: { x: r.left, y: r.top, w: r.width, h: r.height }, prompt: { x: e.left, y: e.top, w: e.width, h: e.height }, hasFocus: f.contentDocument.hasFocus() }; })()");
      const hit = outer[0] ? await page.evaluate(`(() => { const e = document.elementFromPoint(${outer[0].x + inner.frame.x + inner.prompt.x + inner.prompt.w / 2}, ${outer[0].y + inner.frame.y + inner.prompt.y + inner.prompt.h / 2}); return e ? e.tagName + '.' + String(e.className).slice(0, 60) : null; })()`) : null;
      typing.push({ text: text.slice(0, 30), attempt, focused, outer, inner, hit });
      await screenshot(page, `typing-fail-${attempt}.png`).catch(() => undefined);
      await sleep(700);
      continue;
    }
    await input.type(text);
    await sleep(200);
    const value = await inChat(view, "d.getElementById('prompt').value");
    typing.push({ text: text.slice(0, 30), attempt, focused, typed: value === text });
    if (value === text) return true;
  }
  return false;
}
const rowLabels = (page) => page.evaluate("[...document.querySelectorAll('.monaco-list-row')].map((r) => r.getAttribute('aria-label') || '').filter(Boolean)");
async function clickRow(page, input, text) {
  const point = await waitFor(() => page.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find((x) => (x.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})); if (!r) return null; const b = r.getBoundingClientRect(); return b.height ? { x: b.left + Math.min(60, b.width / 2), y: b.top + b.height / 2 } : null; })()`), 15000, 300);
  if (!point) throw new Error(`no row ${text}`);
  await input.click(point.x, point.y);
}
async function clickTab(page, input, text) {
  const point = await page.evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find((x) => (x.getAttribute('aria-label') || x.innerText).includes(${JSON.stringify(text)})); if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (point) await input.click(point.x, point.y);
  return Boolean(point);
}
async function screenshot(page, name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name), Buffer.from(shot.data, 'base64'));
}

async function main() {
  const top = makeOwnedTempDir('plan-chat-ws-');
  const project = path.join(top, 'demo-project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'notes.js'), '// Synthetic project for the 0.4.0 workspace test.\nconst release = "0.4.0";\n');
  const box = await makeSandbox('plan-chat-ws-', { 'window.restoreWindows': 'one', 'workbench.colorTheme': 'Default Dark Modern' });
  const copy = testCopy(box.sandbox, { surface: 'workspace' });
  const read = (name) => { const file = path.join(box.sandbox, `ws-${name}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const write = (name, data = {}) => fs.writeFileSync(path.join(box.sandbox, `ws-${name}.json`), JSON.stringify(data));
  const start = (phase) => launch(executable, { developmentPaths: [copy], userData: box.userData, sandbox: box.sandbox, port: PORT, openPaths: [project], env: { PLAN_CHAT_IT_SCENARIO: 'workspace', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_PHASE: phase, PLAN_CHAT_IT_KEEP_OPEN: '1', PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) } });
  console.log(`[${label}] sandbox ${box.sandbox}`);

  // ---------- phase 1 ----------
  let run = start('1');
  await waitFor(() => read('ready-1') || read('error-1'), 120000, 300);
  if (read('error-1')) throw new Error(read('error-1').errors.join('\n'));
  const ready = read('ready-1');
  let page = await workbench();
  const input = inputFor(page);
  await hideWelcome(page);
  await sleep(1500);
  const webTabs = ready.tabs.filter((tab) => tab.webview);
  check('chats open as editor tabs: one in the active group, one beside it', webTabs.length === 2 && new Set(webTabs.map((tab) => tab.group)).size === 2, ready.tabs);

  const labels = await rowLabels(page);
  check('Account: who is signed in, "Using ChatGPT plan", the model for new chats', labels.some((l) => /synthetic\.user@example\.test/.test(l)) && labels.some((l) => /Using ChatGPT plan/.test(l)) && labels.some((l) => /Model for new chats/.test(l)), labels);
  check('Chats: this project, the user group, chats with states; other contexts read-only', labels.some((l) => /This project: demo-project/.test(l)) && labels.some((l) => /^Group Release/.test(l)) && labels.some((l) => /Release notes for the workspace, open in a tab/.test(l)) && labels.some((l) => /General, .*opens read-only/.test(l)), labels);
  check('no usage figures and no Web mode anywhere in the side bar', !labels.some((l) => /%|quota|tokens left|\bWeb\b/i.test(l)), labels.filter((l) => /%|quota|Web/i.test(l)));

  const viewA = await chatView('Release notes for the workspace');
  const viewB = await chatView('ما هي خطة الإصدار').catch(() => undefined);
  if (!viewB) {
    // Diagnostics: every webview the editor lists, and what it shows.
    const seen = [];
    for (const target of (await targets()).filter((item) => item.url.startsWith('vscode-webview://'))) {
      const web = await Cdp.connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (!web) { seen.push({ url: target.url.slice(0, 80), connect: false }); continue; }
      seen.push({ id: new URL(target.url).searchParams.get('id'), title: await web.evaluate("document.getElementById('active-frame')?.contentDocument?.getElementById('chatTitle')?.textContent ?? null").catch((error) => 'error: ' + error.message), mode: await web.evaluate("document.getElementById('active-frame')?.contentDocument?.body?.dataset.mode ?? null").catch(() => null) });
      web.close();
    }
    fs.writeFileSync(path.join(evidence, 'diag-missing-b.json'), JSON.stringify({ seen, tabs: ready.tabs }, null, 2));
    await screenshot(page, 'diag-missing-b.png');
  }
  check('each tab shows its own chat in the panel layout', Boolean(viewA && viewB) && (await inChat(viewA, "d.body.dataset.mode")) === 'panel', { a: Boolean(viewA), b: Boolean(viewB) });
  const rtl = await inChat(viewB, "(() => { const p = [...d.querySelectorAll('#messages .bubble p, #messages .bubble .line')].find((e) => /[\\u0600-\\u06FF]/.test(e.textContent)); const c = d.querySelector('#messages .bubble code'); return { text: p ? w.getComputedStyle(p).direction : null, code: c ? w.getComputedStyle(c).direction : null }; })()");
  check('Arabic messages run right to left; inline code stays left to right', rtl.text === 'rtl' && rtl.code === 'ltr', rtl);
  await screenshot(page, 'p1-sidebar-and-tabs-dark.png');

  // Open a chat from the side bar.
  await clickRow(page, input, 'Long running question');
  const viewC = await chatView('Long running question');
  check('clicking a chat in the side bar opens it in an editor tab', Boolean(viewC));

  // Keyboard: type and press Enter in chat A.
  check('typing reaches chat A', await typeInto(page, input, viewA, 'quick: second question from the keyboard'));
  await input.press('Enter');
  const replied = await waitFor(async () => (await inChat(viewA, "d.querySelectorAll('#messages article.message').length")) >= 4 && !(await inChat(viewA, "!d.getElementById('stop').classList.contains('hidden')")), 20000, 300);
  check('Enter sends from the composer; the reply appears in the same tab', replied);
  await clickInChat(page, input, viewA, '#prompt');
  await input.press('Tab');
  const nextFocus = await inChat(viewA, "d.activeElement && d.activeElement.id");
  // 0.7.0 RC2: in the editor tab the next control is the + actions button.
  check('keyboard: Tab moves from the message box to the next control (the + actions button)', nextFocus === 'plus', nextFocus);

  // A draft in chat B, not sent. Chat C opened in B's group, so B is shown
  // again first (a hidden tab's page is unloaded and reloaded when shown).
  await clickTab(page, input, 'ما هي خطة الإصدار');
  viewB.web.close();
  const viewB2 = await chatView('ما هي خطة الإصدار');
  const focusedAfterSwitch = await waitFor(async () => (await inChat(viewB2, "d.hasFocus() && d.activeElement && d.activeElement.id")) === 'prompt', 5000, 200).catch(() => false);
  check('switching to a chat tab puts the keyboard focus in its message box, with no extra click', focusedAfterSwitch);
  check('typing reaches chat B after its tab is shown again', await typeInto(page, input, viewB2, 'Unsent draft: مسودة غير مرسلة'));
  await sleep(1500);
  write('go-2');
  await waitFor(() => read('state-2'), 30000, 300);
  const state2 = read('state-2');
  check('the sent question and its reply are stored in chat A only; one request', state2.aMessages.length === 4 && state2.requests.length === 1 && state2.aMessages[2].content === 'quick: second question from the keyboard', state2);
  check('the unsent draft is kept for chat B, exactly as typed', state2.draftB?.text === 'Unsent draft: مسودة غير مرسلة', state2.draftB);
  await screenshot(page, 'p1-after-send-dark.png');

  // D-1 (RC5): Send with project consent, in the real editor.
  write('go-p');
  await waitFor(() => read('ready-p'), 30000, 300);
  let viewP;
  await waitFor(async () => { viewP = await chatView('New chat', 3000).catch(() => undefined); return Boolean(viewP); }, 30000, 500);
  const question = 'quick: what does the release constant in src/notes.js hold?';
  check('D-1: typing reaches the new project chat', await typeInto(page, input, viewP, question));
  await sleep(500);
  await input.press('Enter');
  const cardShown = await waitFor(async () => !(await inChat(viewP, "d.getElementById('consentCard').classList.contains('hidden')")), 20000, 200);
  check('D-1: Send that needs project consent shows the card', cardShown);
  const boxWhileWaiting = [];
  for (let i = 0; i < 6; i += 1) { boxWhileWaiting.push(await inChat(viewP, "d.getElementById('prompt').value")); await sleep(400); }
  check('D-1: while the card waits, the sent question does not come back into the message box', boxWhileWaiting.every((value) => value === ''), boxWhileWaiting);
  await screenshot(page, 'd1-consent-card-empty-box.png');
  check('D-1: a newer draft can be typed while the card waits', await typeInto(page, input, viewP, 'newer draft while waiting'));
  await sleep(800);
  await clickInChat(page, input, viewP, '#consentAllow');
  const repliedP = await waitFor(async () => (await inChat(viewP, "d.querySelectorAll('#messages article.assistant').length")) >= 1 && !(await inChat(viewP, "!d.getElementById('stop').classList.contains('hidden')")), 30000, 300);
  check('D-1: Allow sends; the reply arrives', repliedP);
  await sleep(1500);
  const boxAfter = await inChat(viewP, "d.getElementById('prompt').value");
  check('D-1: after the reply the question is not in the box; the newer draft is kept', boxAfter === 'newer draft while waiting', boxAfter);
  await screenshot(page, 'd1-after-reply-newer-draft-kept.png');
  write('done-p');
  await waitFor(() => read('state-p'), 30000, 300);
  const stateP = read('state-p');
  const userP = stateP.messages.filter((m) => m.role === 'user');
  check('D-1: the question is stored once, with the project excerpt; one more request', userP.length === 1 && userP[0].content === question && userP[0].contextUsed.includes('src/notes.js') && stateP.requests.length === state2.requests.length + 1, stateP);
  check('D-1: the stored draft is the newer text, not the question', stateP.draft === 'newer draft while waiting', stateP.draft);
  viewP.web.close();

  // D-2 (0.5.0 RC3, DEC-PLANCHAT-024): with sharing stopped, a question that
  // matches no file still reaches the tools; the tool result waits on the card.
  write('go-t');
  await waitFor(() => read('ready-t'), 30000, 300);
  check('D-2: sharing is stopped before the question', read('ready-t').activeBefore === 0, read('ready-t'));
  let viewT;
  await waitFor(async () => { viewT = await chatView('New chat', 3000).catch(() => undefined); return Boolean(viewT); }, 30000, 500);
  // RC5: in Arabic, so the reply's project label is checked in a right-to-left chat.
  const questionT = 'quick TOOLCARD: من أين أبدأ البحث عن هذا الخلل؟';
  check('D-2: typing reaches a new project chat', await typeInto(page, input, viewT, questionT));
  await sleep(500);
  await input.press('Enter');
  const toolCard = await waitFor(async () => /ChatGPT asked to look in/.test(await inChat(viewT, "d.getElementById('consentCard').classList.contains('hidden') ? '' : d.getElementById('consentText').textContent")), 20000, 200);
  check('D-2: an unmatched question reaches the tools; their result waits on the card', toolCard);
  const cardT = await inChat(viewT, "({ text: d.getElementById('consentText').textContent, allow: d.getElementById('consentAllow').textContent, without: d.getElementById('consentWithout').textContent, items: [...d.querySelectorAll('#consentList li')].map((li) => li.firstChild.textContent), shown: (d.querySelector('#consentList pre') || {}).textContent || '', stop: !d.getElementById('stop').classList.contains('hidden') })");
  check('D-2: the card names the tool and shows the exact result; the reply can still be stopped', cardT.items.join() === 'project_summary' && /src\//.test(cardT.shown) && cardT.without === 'Answer without project files' && /Allow for demo-project and send/.test(cardT.allow) && cardT.stop, cardT);
  await inChat(viewT, "(d.getElementById('consentDetails').open = true, true)");
  await sleep(300);
  // RC4: the one-line JSON result must not widen the card past the chat.
  const fitT = await inChat(viewT, "(() => { const card = d.getElementById('consentCard'); const width = d.documentElement.clientWidth; const cancel = d.getElementById('consentCancel').getBoundingClientRect(); return { width, card: Math.round(card.getBoundingClientRect().right), cancel: Math.round(cancel.right), cancelShown: cancel.width > 0 && cancel.right <= width }; })()");
  check('D-2: with the result shown, the card fits the chat and Cancel stays visible', fitT.card <= fitT.width && fitT.cancelShown, fitT);
  await screenshot(page, 'd2-tool-consent-card.png');
  await clickInChat(page, input, viewT, '#consentAllow');
  const repliedT = await waitFor(async () => /TOOL-REPLY/.test(await inChat(viewT, "d.getElementById('messages').textContent")) && !(await inChat(viewT, "!d.getElementById('stop').classList.contains('hidden')")), 30000, 300);
  check('D-2: Allow sends the result; the reply arrives', repliedT);
  // RC5: a summary with no README sends names and counts only: the label must not claim files or earlier answers.
  const labelT = await inChat(viewT, "(() => { const a = [...d.querySelectorAll('#messages article.message.assistant')].at(-1); const f = a && a.querySelector('.project-footer'); const b = a && a.querySelector('.bubble'); if (!f) return null; const r = f.getBoundingClientRect(); return { text: f.querySelector('summary') ? f.querySelector('summary').textContent : f.textContent, dir: w.getComputedStyle(f).direction, bubbleDir: b ? w.getComputedStyle(b.querySelector('p') || b).direction : null, fits: r.right <= d.documentElement.clientWidth && r.width > 0 }; })()");
  check('D-2: the reply label says project information was shared for this reply, in a right-to-left chat, and fits', labelT && labelT.text === 'Based on project information shared for this reply' && labelT.bubbleDir === 'rtl' && labelT.fits, labelT);
  await screenshot(page, 'd2-after-allow.png');
  write('done-t');
  await waitFor(() => read('state-t'), 30000, 300);
  const stateT = read('state-t');
  check('D-2: one request offering tools; one tool result handed over after Allow; the reply is project-derived under the new grant', stateT.requests.length === 1 && stateT.requests[0].tools && stateT.requests[0].toolOutputs === 1 && stateT.reply?.provenance === 'project-derived' && stateT.active.length === 1 && stateT.reply.consentId === stateT.active[0], stateT);
  viewT.web.close();

  // D-3 (0.6.0 Review Before Apply, DEC-PLANCHAT-026 to 028): the model
  // proposes an edit; the card comes after the reply; Show diff opens the
  // editor diff; Apply changes the editor document, not the disk.
  write('go-r');
  await waitFor(() => read('ready-r'), 30000, 300);
  let viewR;
  await waitFor(async () => { viewR = await chatView('New chat', 3000).catch(() => undefined); return Boolean(viewR); }, 30000, 500);
  check('D-3: typing reaches a new project chat', await typeInto(page, input, viewR, 'PROPOSE: set the release to 0.6.0'));
  await sleep(500);
  await input.press('Enter');
  const cardShownR = await waitFor(async () => Boolean(await inChat(viewR, "Boolean(d.querySelector('.review-card .review-apply'))")), 20000, 200);
  check('D-3: the review card appears with Apply and Reject', cardShownR);
  const cardR = await inChat(viewR, "(() => { const c = d.querySelector('.review-card'); const prev = c.previousElementSibling; const r = c.getBoundingClientRect(); return { title: c.querySelector('.attach-title').textContent, files: [...c.querySelectorAll('.review-path')].map((e) => e.textContent), status: c.querySelector('.review-status').textContent, apply: c.querySelector('.review-apply').textContent, reject: c.querySelector('.review-reject').textContent, afterReply: Boolean(prev && prev.classList.contains('assistant') && /PROPOSE-REPLY/.test(prev.textContent)), stopHidden: d.getElementById('stop').classList.contains('hidden'), fits: r.right <= d.documentElement.clientWidth && r.width > 0 }; })()");
  check('D-3: the card comes after the finished reply, says nothing has changed, names the file, and fits', cardR.title === 'Proposed changes · not applied' && cardR.files.join() === 'src/notes.js' && /Nothing has been changed yet/.test(cardR.status) && cardR.apply === 'Apply changes to 1 file' && cardR.reject === 'Reject' && cardR.afterReply && cardR.stopHidden && cardR.fits, cardR);
  // The row's accessible name carries the spoken status.
  const rowR = await waitFor(async () => (await rowLabels(page)).some((l) => /PROPOSE.*proposed changes waiting for your review/.test(l) && !/replying/.test(l)), 10000, 300);
  check('D-3: the Chats list says the changes wait for review, not "replying"', rowR, (await rowLabels(page)).filter((l) => /PROPOSE/.test(l)));
  await screenshot(page, 'd3-review-card.png');
  const showButton = await inChat(viewR, "(() => { const b = d.querySelector('.review-card .review-files button'); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: d.documentElement.clientWidth, vh: d.documentElement.clientHeight }; })()");
  // A click that lands while the chat redraws after the reply is lost (the
  // 0.5.0 history refresh redraws every message); one more click is allowed
  // and the count is recorded.
  let showClicks = 0;
  const diffShown = () => page.evaluate("[...document.querySelectorAll('.tab')].some((t) => /proposed by ChatGPT/.test(t.getAttribute('aria-label') || t.innerText))");
  for (; showClicks < 2 && !(await diffShown()); ) {
    showClicks += 1;
    await clickInChat(page, input, viewR, '.review-card .review-files button');
    await waitFor(diffShown, 4000, 200);
  }
  const afterShow = await inChat(viewR, "({ note: d.getElementById('contextNote').textContent, cards: d.querySelectorAll('.review-card').length, active: d.activeElement && (d.activeElement.className || d.activeElement.id) })").catch((error) => ({ error: String(error) }));
  await screenshot(page, 'd3-review-diff.png');
  write('reviewing-r');
  await waitFor(() => read('state-r1'), 30000, 300);
  const r1 = { ...read('state-r1'), showButton, afterShow, showClicks };
  check('D-3: Show diff opens the editor diff; before Apply the file is unchanged on disk and in the editor; status "review"', r1.diag.diffDocuments === 2 && r1.diffTabs.length === 1 && /notes\.js: current ↔ proposed by ChatGPT \(not applied\)/.test(r1.diffTabs[0]) && /"0\.4\.0"/.test(r1.disk) && !r1.dirty && r1.status === 'review', r1);
  // The suite closes the diff; the chat tab is shown again (its page may reload).
  await waitFor(() => read('diff-closed-r'), 30000, 300);
  await sleep(1000);
  viewR.web.close();
  viewR = await chatView('PROPOSE');
  if (!viewR) throw new Error('D-3: the chat tab could not be found again');
  const againR = await waitFor(async () => Boolean(await inChat(viewR, "Boolean(d.querySelector('.review-card .review-apply'))")), 15000, 200);
  check('D-3: the card is still there when the chat is shown again', againR);
  await clickInChat(page, input, viewR, '.review-card .review-apply');
  const appliedR = await waitFor(async () => /Applied to 1 file in the editor\. Not saved yet/.test(await inChat(viewR, "(d.querySelector('.review-card .review-status') || {}).textContent || ''")), 20000, 300);
  check('D-3: after Apply the card says the change is in the editor and not saved', appliedR);
  await screenshot(page, 'd3-applied.png');
  write('done-r');
  await waitFor(() => read('closed-r'), 30000, 300);
  const stateR = read('state-r');
  check('D-3: the editor document holds exactly the reviewed text, unsaved; the disk is unchanged; the chat is idle', stateR.text === '// Synthetic project for the 0.4.0 workspace test.\nconst release = "0.6.0";\n' && stateR.dirty && /"0\.4\.0"/.test(stateR.disk) && stateR.status === undefined && stateR.requests.length === 1, stateR);
  check('D-3: the edit was reverted before the quit (test cleanup)', /"0\.4\.0"/.test(read('closed-r').disk), read('closed-r'));
  viewR.web.close();

  // D-4 (0.7.0, DEC-PLANCHAT-030/031): a safe check runs with no card; a
  // consequential run waits for one card with the exact command; Run runs it once.
  write('go-x');
  await waitFor(() => read('ready-x'), 30000, 300);
  let viewX;
  await waitFor(async () => { viewX = await chatView('New chat', 3000).catch(() => undefined); return Boolean(viewX); }, 30000, 500);
  check('D-4: typing reaches a new project chat', await typeInto(page, input, viewX, 'RUNCMD: check the node version and record a marker'));
  await sleep(500);
  await input.press('Enter');
  const cardX = await waitFor(async () => !(await inChat(viewX, "d.getElementById('commandCard').classList.contains('hidden')")), 20000, 200);
  check('D-4: the consequential run waits for one approval card', cardX);
  const shownX = await inChat(viewX, "(() => { const c = d.getElementById('commandCard'); const r = c.getBoundingClientRect(); const l = d.getElementById('commandLine'); const lr = l.getBoundingClientRect(); return { title: d.getElementById('commandTitle').textContent, line: l.textContent, lineDir: l.dir, facts: [...d.querySelectorAll('#commandFacts li')].map((li) => li.textContent), run: d.getElementById('commandRun').textContent, decline: d.getElementById('commandDecline').textContent, fits: r.right <= d.documentElement.clientWidth && r.width > 0 && lr.right <= r.right + 1 && l.scrollWidth <= l.clientWidth + 1 }; })()");
  check('D-4: the card shows the exact program, arguments, folder, time limit, environment, effect and why it asks; Run and Don\'t run; it fits', shownX.title === 'Run this command?' && /node(\.exe)?"? -e .*appendFileSync/.test(shownX.line) && shownX.lineDir === 'ltr' && shownX.facts.some((f) => /^Folder: the project folder/.test(f)) && shownX.facts.some((f) => /^Time limit: 120 s/.test(f)) && shownX.facts.some((f) => /^Why Kenlith asks: runs code written in the request/.test(f)) && shownX.facts.some((f) => /^Environment: no changes/.test(f)) && shownX.facts.some((f) => /^Effect: /.test(f)) && shownX.run === 'Run' && shownX.decline === "Don't run" && shownX.fits, shownX);
  const rowX = await waitFor(async () => (await rowLabels(page)).some((l) => /RUNCMD.*waiting for you to approve a command/.test(l)), 10000, 300);
  check('D-4: the Chats list says it waits for a command approval', rowX, (await rowLabels(page)).filter((l) => /RUNCMD/.test(l)));
  await screenshot(page, 'd4-command-card.png');
  write('card-x');
  await waitFor(() => read('state-x1'), 30000, 300);
  const x1 = read('state-x1');
  check('D-4: nothing consequential ran before Run; status "command-approval"', x1.status === 'command-approval' && x1.markerBeforeRun === false, x1);
  await clickInChat(page, input, viewX, '#commandRun');
  const repliedX = await waitFor(async () => /RUNCMD-REPLY/.test(await inChat(viewX, "d.getElementById('messages').textContent")) && (await inChat(viewX, "d.getElementById('commandCard').classList.contains('hidden')")), 30000, 300);
  check('D-4: after Run the reply arrives and the card is gone', repliedX);
  const footerX = await waitFor(async () => /Kenlith handled 2 commands/.test(await inChat(viewX, "(([...d.querySelectorAll('#messages article.message.assistant')].at(-1) || {}).textContent || '')")), 10000, 300);
  check('D-4: the reply lists the two runs it handled', footerX);
  await screenshot(page, 'd4-after-run.png');
  write('done-x');
  await waitFor(() => read('state-x'), 30000, 300);
  const sx = read('state-x');
  check('D-4: the safe check ran without a card (Class A), the approved run ran exactly once (Class B); the chat is idle', sx.marker === 'x' && sx.commands.length === 2 && sx.commands[0].cls === 'A' && sx.commands[0].status === 'succeeded' && sx.commands[1].cls === 'B' && sx.commands[1].status === 'succeeded' && sx.status === undefined && sx.requests.length === 1, sx);
  // U3: mark the drawn messages, refresh with the same history, and look for the mark.
  const marked = await inChat(viewX, "(() => { const m = d.getElementById('messages'); if (!m.firstElementChild) return false; m.firstElementChild.dataset.u3 = 'kept'; return true; })()");
  write('go-u3');
  await waitFor(() => read('done-u3'), 20000, 200);
  const kept = await inChat(viewX, "d.getElementById('messages').firstElementChild?.dataset.u3 || null");
  check('U3: a refresh with the same messages leaves the drawn conversation in place (no redraw to lose a click)', marked && kept === 'kept', { marked, kept });
  viewX.web.close();

  // A reply still streaming when the editor quits.
  // Its tab may be scrolled out of the strip: open it from the Chats list.
  await clickRow(page, input, 'Long running question');
  viewC.web.close();
  const viewC2 = await chatView('Long running question');
  check('typing reaches chat C after its tab is shown again', await typeInto(page, input, viewC2, 'HANG please continue'));
  await input.press('Enter');
  const streaming = await waitFor(async () => /cut off by the restart/.test(await inChat(viewC2, "d.getElementById('messages').textContent")), 20000, 300);
  check('a reply streams in chat C', streaming);
  const replyingLabel = await waitFor(async () => (await rowLabels(page)).some((l) => /Long running question, replying/.test(l)), 10000, 300);
  check('the side bar shows the chat as replying (also for screen readers)', replyingLabel, (await rowLabels(page)).filter((l) => /Long running/.test(l)));
  await screenshot(page, 'p1-replying-dark.png');
  write('go-3');
  await waitFor(() => read('state-3'), 30000, 300);
  const state3 = read('state-3');
  check('while streaming: the reply is saved as in progress and this window owns it', state3.cLast?.inProgress && state3.leaseLive && state3.replying === 'replying', state3);
  for (const web of [viewA, viewB2, viewC2]) web?.web.close();
  page.close();
  const code1 = await Promise.race([run.exited, sleep(45000).then(() => 'timeout')]);
  check('the editor quit during the reply', code1 !== 'timeout', code1);
  if (code1 === 'timeout') run.child.kill();

  // ---------- phase 2 ----------
  const settingsFile = path.join(box.userData, 'User', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
  await sleep(1500);
  run = start('2');
  await waitFor(() => read('ready-p2') || read('error-2'), 120000, 300);
  if (read('error-2')) throw new Error(read('error-2').errors.join('\n'));
  const p2 = read('ready-p2');
  const restoredTabs = p2.tabs.filter((tab) => tab.webview).map((tab) => tab.label);
  // Five since 0.5.0 RC3 (D-2 opens one more chat tab), six since 0.6.0 (D-3).
  // Seven since 0.7.0 (D-4 opens one more chat tab).
  check('after the restart all seven chat tabs are back', ['Release notes for the workspace', 'Long running question'].every((title) => restoredTabs.includes(title)) && restoredTabs.length === 7, p2.tabs);
  check('nothing is sent by itself after the restart', p2.requestsAtStart === 0, p2.requestsAtStart);
  page = await workbench();
  const input2 = inputFor(page);
  await hideWelcome(page);
  await sleep(1000);
  // B was in the background of its group at quit: shown, it is restored.
  let restoredB = await chatView('ما هي خطة الإصدار', 3000).catch(() => undefined);
  if (!restoredB) {
    if (!(await clickTab(page, input2, 'ما هي خطة الإصدار')) || !(restoredB = await chatView('ما هي خطة الإصدار', 8000).catch(() => undefined))) {
      // The tab may be scrolled out of the strip: open the chat from the Chats list.
      const icon = await page.evaluate("(() => { const a = [...document.querySelectorAll('a.action-label')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Kenlith') && x.getBoundingClientRect().width > 0); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      const open = await page.evaluate("[...document.querySelectorAll('.part.sidebar .pane-header')].some((h) => /Chats/.test(h.textContent))");
      if (icon && !open) await input2.click(icon.x, icon.y);
      await clickRow(page, input2, 'ما هي خطة الإصدار');
      restoredB = await chatView('ما هي خطة الإصدار', 20000).catch(() => undefined);
    }
  }
  const draftShown = restoredB ? await inChat(restoredB, "d.getElementById('prompt').value") : null;
  check('the draft is back in chat B\'s message box', draftShown === 'Unsent draft: مسودة غير مرسلة', draftShown);
  let restoredC = await chatView('Long running question', 3000).catch(() => undefined);
  if (!restoredC) {
    await clickTab(page, input2, 'Long running question');
    restoredC = await chatView('Long running question', 20000).catch(() => undefined);
  }
  const note = restoredC ? await inChat(restoredC, "[...d.querySelectorAll('.reply-state')].map((e) => e.textContent).join(' ')") : '';
  check('the reply cut off by the restart is kept and marked Interrupted', /Interrupted: the editor closed before this reply finished/.test(note), note);
  await screenshot(page, 'p2-restored-light.png');
  write('go-p2');
  await waitFor(() => read('state-p2'), 30000, 300);
  const sp2 = read('state-p2');
  check('stored: interrupted, no longer in progress, excluded from follow-up context', sp2.cLast?.interrupted && !sp2.cLast.inProgress && sp2.cLast.contextPolicy === 'excluded', sp2.cLast);
  check('no request was sent in the restarted window', sp2.requests.length === 0, sp2.requests);
  check('the user group survives the restart', JSON.stringify(sp2.groups) === JSON.stringify(['Release']), sp2.groups);
  for (const web of [restoredB, restoredC]) web?.web.close();
  page.close();
  const code2 = await Promise.race([run.exited, sleep(45000).then(() => 'timeout')]);
  if (code2 === 'timeout') run.child.kill();
  box.close();
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ label, executable: path.basename(executable), results, typing }, null, 2));
  const failed = results.filter((result) => !result.ok).length;
  console.log(`[${label}] workspace: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ label, error: String(error?.stack || error), results }, null, 2));
  process.exit(2);
});
