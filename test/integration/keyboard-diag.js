'use strict';

// WP-02 T02-01: diagnosis of keyboard acceptance in Kenlith's lists, in a
// real editor (throwaway profile, test copy with synthetic sign-in, model and
// history; network blocked). Each case opens a list with the keyboard, acts
// with the keyboard only, and records:
//   - what Kenlith received (showQuickPick's result, from a wrapper in the
//     test copy), and the events of a createQuickPick probe;
//   - in the workbench: every keydown (target, and whether it reached the
//     window), every change of the focused element (naming the extension that
//     owns a focused webview), Quick Pick visibility, the secondary side bar.
// No mouse input is used for any choice.
//
// Usage: node test/integration/keyboard-diag.js <editor exe> <label> [--folder] [--repeat N]

const fs = require('node:fs');
const path = require('node:path');
const { connect, inputFor, launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy } = require('./lib/test-copy');

const folderMode = process.argv.includes('--folder');
const repeatIndex = process.argv.indexOf('--repeat');
const repeat = repeatIndex > 0 ? Number(process.argv[repeatIndex + 1]) : 1;
const [executable, label = 'editor'] = process.argv.slice(2).filter((item, index, all) => !item.startsWith('--') && all[index - 1] !== '--repeat');
const root = path.resolve(__dirname, '..', '..');
// PLAN_CHAT_EVIDENCE_DIR, when set, receives the result instead of the historical default path (M1 WP-08), so later runs never write into earlier releases' evidence.
const outDir = process.env.PLAN_CHAT_EVIDENCE_DIR || path.join(root, 'design', 'uiux-review', 'wp02', 'keyboard-diag');
fs.mkdirSync(outDir, { recursive: true });

const RECORDER = `(() => {
  window.__diag = [];
  if (window.__diagInstalled) return true;
  window.__diagInstalled = true;
  const t = () => Date.now() % 100000;
  const log = (what) => window.__diag.push([t(), what]);
  const describe = (e) => {
    if (!e) return 'none';
    if (e.tagName === 'IFRAME') { let owner = ''; try { owner = new URL(e.src).searchParams.get('extensionId') || ''; } catch {} return 'IFRAME[' + owner + ']'; }
    return e.tagName + '.' + String(e.className || '').split(' ').slice(0, 2).join('.');
  };
  document.addEventListener('keydown', (e) => { if (['Enter', 'ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) log('keydown ' + e.key + ' at ' + describe(e.target)); }, true);
  window.addEventListener('keydown', (e) => { if (['Enter', 'ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) log('keydown ' + e.key + ' reached window, defaultPrevented=' + e.defaultPrevented); });
  let focused = null; let pick = null; let aux = null;
  setInterval(() => {
    const now = describe(document.activeElement);
    if (now !== focused) { focused = now; log('focus ' + now); }
    const w = document.querySelector('.quick-input-widget');
    const shown = Boolean(w && w.getBoundingClientRect().height && getComputedStyle(w).display !== 'none');
    const title = shown ? ((w.querySelector('.quick-input-title') || {}).innerText || '') : '';
    const state = shown ? 'shown "' + title + '" active="' + ((w.querySelector('.monaco-list-row.focused') || {}).getAttribute?.('aria-label') || '').slice(0, 30) + '"' : 'hidden';
    if (state !== pick) { pick = state; log('quickpick ' + state); }
    const p = document.querySelector('.part.auxiliarybar'); const r = p && p.getBoundingClientRect();
    const a = Boolean(r && r.width > 0 && getComputedStyle(p).display !== 'none');
    if (a !== aux) { aux = a; log('secondary side bar ' + (a ? 'visible' : 'hidden')); }
  }, 20);
  return true;
})()`;

async function main() {
  // --menu-custom: the profile setting the sidebar runner uses (window.menuStyle).
  const box = await makeSandbox('plan-chat-kbd-', { 'workbench.colorTheme': 'Default Dark Modern', 'workbench.sideBar.location': 'left', ...(process.argv.includes('--menu-custom') ? { 'window.menuStyle': 'custom' } : {}) });
  const port = 9300 + Math.floor(Math.random() * 600);
  const projectFolder = folderMode ? path.join(box.sandbox, 'projects', 'proj-alpha') : undefined;
  if (projectFolder) {
    fs.mkdirSync(projectFolder, { recursive: true });
    fs.writeFileSync(path.join(projectFolder, 'readme.txt'), 'synthetic\n');
  }
  // --workspace: a saved two-folder workspace (folders change without a reload).
  const workspaceMode = process.argv.includes('--workspace');
  let workspaceFile;
  if (workspaceMode) {
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(box.sandbox, 'projects', name), { recursive: true });
      fs.writeFileSync(path.join(box.sandbox, 'projects', name, 'readme.txt'), 'synthetic\n');
    }
    workspaceFile = path.join(box.sandbox, 'projects', 'both.code-workspace');
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }] }, null, 2));
  }
  const resultFile = path.join(box.sandbox, 'result.json');
  const { child, exited } = launch(executable, {
    developmentPaths: [testCopy(box.sandbox)],
    openPaths: workspaceFile ? [workspaceFile] : projectFolder ? [projectFolder] : [],
    userData: box.userData,
    sandbox: box.sandbox,
    port,
    env: { PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_RESULT: resultFile, PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) }
  });
  const hostLog = () => {
    const file = path.join(box.sandbox, 'host-events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  let sequence = 0;
  const command = async (body) => {
    sequence += 1;
    fs.writeFileSync(path.join(box.sandbox, `control-${sequence}.json`), JSON.stringify(body));
    const ack = path.join(box.sandbox, `ack-${sequence}.json`);
    if (!(await waitFor(() => fs.existsSync(ack), 30000))) throw new Error(`no answer to ${body.cmd}`);
    // The scenario may still be writing the file: read until it parses.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return JSON.parse(fs.readFileSync(ack, 'utf8')).result;
      } catch (error) {
        if (!(error instanceof SyntaxError) || attempt >= 20) throw error;
        await sleep(50);
      }
    }
  };

  const report = { label, folderMode, cases: [] };
  let web;
  let page;
  try {
    if (!(await waitFor(() => fs.existsSync(path.join(box.sandbox, 'ready.json')), 120000, 250))) throw new Error('the scenario did not start');
    const chats = JSON.parse(fs.readFileSync(path.join(box.sandbox, 'ready.json'), 'utf8')).chats;
    let frameBase;
    ({ web, page, frameBase } = await connect(port, 'history'));
    const input = inputFor(page);
    const pageEval = (expression) => page.evaluate(expression);
    const inPage = (expression) => web.evaluate(`(() => { const f = document.getElementById('active-frame'); const d = f.contentDocument; const w = f.contentWindow; return (${expression}); })()`);
    await pageEval("document.querySelectorAll('.antigravity-ide-welcome').forEach((n) => { n.classList.remove('visible'); n.style.display = 'none'; })");
    await waitFor(() => inPage("d.querySelectorAll('#messages article.message').length > 0"), 30000);
    report.wrapped = await command({ cmd: 'wrapQuickPick' });
    if (process.argv.includes('--keybindings')) {
      report.enterKeybindings = await command({ cmd: 'enterKeybindings' });
      console.log(`  Enter keybindings registered: ${report.enterKeybindings.total}`);
      console.log(`  document length ${report.enterKeybindings.length}, mentions ${report.enterKeybindings.mentions}; sample: ${JSON.stringify(report.enterKeybindings.sample)}`);
      if (process.argv.includes('--keybindings-only')) { await command({ cmd: 'done' }); throw new Error('keybindings only'); }
      for (const entry of report.enterKeybindings.entries) console.log(`    ${entry.slice(0, 260)}`);
    }
    await pageEval(RECORDER);
    await sleep(1500);

    const quickPickTitle = () => pageEval("(() => { const w = document.querySelector('.quick-input-widget'); if (!w || !w.getBoundingClientRect().height || getComputedStyle(w).display === 'none') return null; return (w.querySelector('.quick-input-title') || {}).innerText || ''; })()");
    const palette = async (text) => {
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 });
      await waitFor(quickPickTitle, 5000);
      await sleep(400);
      await input.type(text);
      await sleep(500);
      await input.press('Enter');
    };
    // Keyboard focus on the history button: the view is focused through its
    // own command, then focus moves inside the page with Tab.
    const historyByKeyboard = async () => {
      await palette('Kenlith: Open Kenlith');
      await sleep(800);
      await inPage("(d.getElementById('prompt').focus(), true)");
      for (let index = 0; index < 12 && (await inPage("d.activeElement && d.activeElement.id")) !== 'history'; index += 1) {
        await input.press('Tab', 'shift');
      }
      const focusedOn = await inPage("d.activeElement && d.activeElement.id");
      await input.press('Enter');
      await waitFor(quickPickTitle, 5000);
      return focusedOn;
    };
    // Mouse helpers for the K8–K10 variants: they open or focus a list with a
    // click; the choice is still made with Enter.
    const clickElement = async (expression) => {
      const outer = await pageEval(`(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(frameBase)})); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
      const inner = await inPage(`(() => { const r = f.getBoundingClientRect(); const e = ${expression}; const b = e.getBoundingClientRect(); return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 }; })()`);
      await input.click(outer.x + inner.x, outer.y + inner.y);
    };
    const clickQuickPickInput = async () => {
      const p = await pageEval("(() => { const i = document.querySelector('.quick-input-widget input'); if (!i || !i.getBoundingClientRect().width) return null; const r = i.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()");
      if (p) await input.click(p.x, p.y);
    };
    const historyByMouse = async () => {
      await palette('Kenlith: Open Kenlith');
      await sleep(800);
      await clickElement("d.getElementById('history')");
      await waitFor(quickPickTitle, 5000);
    };
    // Bisect (--bisect): the sidebar runner's earlier phases, replayed in
    // order, each followed by the K2 keyboard test.
    const dialog = () => pageEval("(() => { const box = document.querySelector('.monaco-dialog-box'); if (!box || !box.getBoundingClientRect().width) return null; return [...box.querySelectorAll('.monaco-button')].map((b) => b.innerText.trim()).filter(Boolean); })()");
    const clickDialogButton = async (text) => {
      const at = await pageEval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at) await input.click(at.x, at.y);
    };
    const dragSidebarTo = async (target) => {
      const info = await pageEval("(() => { const s = document.querySelector('.part.sidebar').getBoundingClientRect(); const sash = [...document.querySelectorAll('.monaco-sash.vertical')].map((x) => x.getBoundingClientRect()).filter((r) => r.height > 200 && Math.abs(r.left + r.width / 2 - s.right) < 8)[0]; return { left: s.left, sash: sash && { x: sash.left + sash.width / 2, y: sash.top + sash.height / 2 } }; })()");
      if (info.sash) await input.drag(info.sash, { x: info.left + target, y: info.sash.y });
    };
    const PRELUDES = {
      canary: async () => { await command({ cmd: 'canary' }); const buttons = await waitFor(dialog, 3000); const open = buttons && buttons.find((b) => /^open$/i.test(b)); if (open) await clickDialogButton(open); await sleep(800); },
      themes: async () => { for (const theme of ['Default Light Modern', 'Default High Contrast', 'Default Dark Modern']) { await command({ cmd: 'theme', name: theme }); await sleep(1500); } },
      widths: async () => { for (const width of [240, 300, 500, 300]) { await dragSidebarTo(width); await sleep(400); } },
      account: async () => { await clickElement("d.getElementById('account')"); await sleep(300); await input.press('Escape'); await sleep(300); }
    };
    const reset = async () => {
      for (let index = 0; index < 3 && (await quickPickTitle()) !== null; index += 1) { await input.press('Escape'); await sleep(300); }
      await command({ cmd: 'leaveReadOnly' });
      await sleep(400);
    };

    const CASES = [
      { id: 'K1', name: 'History (keyboard) → type a chat title → Enter (control)', run: async () => { const f = await historyByKeyboard(); await sleep(400); await input.type('Refactor the budget'); await sleep(400); await input.press('Enter'); return { opener: f }; }, expect: async () => (await command({ cmd: 'currentChat' })) === chats.english },
      { id: 'K2', name: 'History (keyboard) → type "All Chats" → Enter', run: async () => { const f = await historyByKeyboard(); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return { opener: f }; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K3', name: 'History (keyboard) → ArrowDown to "All Chats…" → Enter', run: async () => { const f = await historyByKeyboard(); await sleep(400); await input.press('ArrowDown'); await sleep(300); await input.press('Enter'); return { opener: f }; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K4', name: 'Palette "Kenlith: Show All Chats" → type "Elsewhere" → Enter', run: async () => { await palette('Kenlith: Show All Chats'); await waitFor(async () => /All Chats/.test((await quickPickTitle()) || ''), 5000); await sleep(400); await input.type('Elsewhere'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /Elsewhere/.test(await inPage("d.getElementById('readOnlyBar').classList.contains('hidden') ? '' : d.getElementById('chatTitle').textContent")) },
      { id: 'K5', name: 'Palette "Kenlith: Show All Chats" → ArrowDown/Up to a chat → Enter', run: async () => { await palette('Kenlith: Show All Chats'); await waitFor(async () => /All Chats/.test((await quickPickTitle()) || ''), 5000); await sleep(400); await input.press('ArrowDown'); await sleep(200); await input.press('ArrowUp'); await sleep(300); await input.press('Enter'); return {}; }, expect: async () => (await quickPickTitle()) === null && (await command({ cmd: 'currentChat' })) !== undefined },
      { id: 'K8', name: 'History opened by mouse click → type "All Chats" → Enter', run: async () => { await historyByMouse(); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K9', name: 'History (keyboard) → mouse click in the list input → type "All Chats" → Enter', run: async () => { await historyByKeyboard(); await sleep(400); await clickQuickPickInput(); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K10', name: 'History by mouse click → click in the list input → type "All Chats" → Enter (Stage 2 runner sequence)', run: async () => { await historyByMouse(); await sleep(400); await clickQuickPickInput(); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      // H2: CDP screenshots (used by the UI runners for evidence) as the cause.
      { id: 'K11', name: 'Clipped CDP screenshot of the sidebar, then History (keyboard) → type "All Chats" → Enter', run: async () => { const rect = await pageEval("(() => { const r = document.querySelector('.part.sidebar').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()"); await page.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } }); await sleep(500); await historyByKeyboard(); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K12', name: 'History (keyboard) open → full-window CDP screenshot → type "All Chats" → Enter', run: async () => { await historyByKeyboard(); await sleep(400); await page.send('Page.captureScreenshot', { format: 'png' }); await sleep(500); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K13', name: 'After K11/K12: History (keyboard) → type "All Chats" → Enter, no screenshot', run: async () => { await historyByKeyboard(); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') },
      { id: 'K14', name: 'History (keyboard) → Escape → focus back on the History button (T02-07)', run: async () => {
          await historyByKeyboard();
          await inPage("(w.__posts = [], w.addEventListener('message', (e) => w.__posts.push(e.data && e.data.type)), true)");
          await sleep(400);
          await input.press('Escape');
          await sleep(300);
          const early = { view: await inPage('d.activeElement && d.activeElement.id'), workbench: await pageEval("(() => { const e = document.activeElement; if (!e) return null; if (e.tagName === 'IFRAME') { try { return 'IFRAME[' + (new URL(e.src).searchParams.get('extensionId') || '') + ']'; } catch { return 'IFRAME'; } } return e.tagName + '.' + String(e.className).slice(0, 40); })()") };
          await sleep(1200);
          return { early, late: { view: await inPage('d.activeElement && d.activeElement.id'), workbench: await pageEval("(() => { const e = document.activeElement; if (!e) return null; if (e.tagName === 'IFRAME') { try { return 'IFRAME[' + (new URL(e.src).searchParams.get('extensionId') || '') + ']'; } catch { return 'IFRAME'; } } return e.tagName + '.' + String(e.className).slice(0, 40); })()") }, posts: await inPage('w.__posts') };
        }, expect: async () => (await inPage('d.activeElement && d.activeElement.id')) === 'history' && (await pageEval(`(() => { const e = document.activeElement; return Boolean(e && e.tagName === 'IFRAME' && String(e.src || '').startsWith(${JSON.stringify(frameBase)})); })()`)) },
      { id: 'K6', name: 'Probe showQuickPick (not Kenlith\'s list) → type "All Chats" → Enter', run: async () => { await command({ cmd: 'probeQuickPick', api: 'showQuickPick' }); await waitFor(quickPickTitle, 5000); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => hostLog().some((e) => e.type === 'sqp.result' && /All Chats/.test(e.picked || '')) },
      { id: 'K7', name: 'Probe createQuickPick → type "All Chats" → Enter', run: async () => { await command({ cmd: 'probeQuickPick', api: 'createQuickPick' }); await waitFor(quickPickTitle, 5000); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => hostLog().some((e) => e.type === 'cqp.accept' && /All Chats/.test(e.active || '')) }
    ];

    // --first-enter: the All Chats sequence as the very first Enter of the
    // session (no command-palette Enter before it), then repeated. The view
    // gets focus from one click on the message area; the choice is Enter.
    const historyFirstEnter = async () => {
      await clickElement("d.getElementById('messages')");
      await inPage("(d.getElementById('prompt').focus(), true)");
      for (let index = 0; index < 12 && (await inPage("d.activeElement && d.activeElement.id")) !== 'history'; index += 1) await input.press('Tab', 'shift');
      await input.press('Enter');
      await waitFor(quickPickTitle, 5000);
    };
    // --incident (WP-08 T08-01): the WP-07 live driver's original History step,
    // replayed exactly (click History, type "All Chats", Enter; if All Chats did
    // not open within 5 s, click History again, type, Enter). Records where the
    // keyboard focus and the typed text were just before each Enter, and any
    // request the fake model received. No real service is involved.
    const focusNow = async () => ({
      view: await inPage("(d.activeElement && (d.activeElement.id || d.activeElement.tagName)) || null"),
      prompt: await inPage("d.getElementById('prompt').value"),
      workbench: await pageEval("(() => { const e = document.activeElement; if (!e) return null; if (e.tagName === 'IFRAME') { try { return 'IFRAME[' + (new URL(e.src).searchParams.get('extensionId') || '') + ']'; } catch { return 'IFRAME'; } } return e.tagName + '.' + String(e.className).slice(0, 40); })()"),
      quickPick: await quickPickTitle()
    });
    const incidentCase = (id, startFocus) => ({ id, name: `WP-07 driver History step replayed (focus first on ${startFocus || 'nothing in the view'}): click History, type "All Chats", Enter (retry once)`, run: async () => {
      // As in WP-07: the keyboard focus already inside Kenlith's view.
      if (startFocus === 'prompt') await inPage("(d.getElementById('prompt').focus(), true)");
      if (startFocus === 'button') await inPage("(d.getElementById('account').focus(), true)");
      const requestsBefore = hostLog().filter((e) => e.type === 'openai.request').length;
      const attempts = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await clickElement("d.getElementById('history')");
        const opened = Boolean(await waitFor(quickPickTitle, 8000, 200));
        await input.type('All Chats');
        await sleep(400);
        const beforeEnter = await focusNow();
        await input.press('Enter');
        const allChats = Boolean(await waitFor(async () => /All Chats/.test((await quickPickTitle()) || ''), 5000, 200));
        attempts.push({ attempt, opened, beforeEnter, allChats });
        if (allChats) break;
      }
      await input.press('Escape');
      await sleep(1500);
      const sent = hostLog().filter((e) => e.type === 'openai.request').slice(requestsBefore).map((e) => e.question);
      return { attempts, sentToModel: sent };
    }, expect: async () => true });
    const firstEnterCase = (id, name) => ({ id, name, run: async () => { await historyFirstEnter(); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => /All Chats/.test((await quickPickTitle()) || '') });
    // --first-click (T02-04): one mouse click on History per attempt, never
    // repeated; the list must appear within 3 s and still be open 0.5 s later.
    const firstClick = (id, name, before) => ({ id, name, run: async () => {
      const change = before ? await before() : undefined;
      await clickElement("d.getElementById('history')");
      const opened = await waitFor(quickPickTitle, 3000, 50);
      await sleep(500);
      const stayed = Boolean(await quickPickTitle());
      return { opened: Boolean(opened), stayed, change };
    }, expect: async () => true });
    const keyboardNav = async () => {
      await inPage("(d.getElementById('prompt').focus(), true)");
      for (let index = 0; index < 4; index += 1) await input.press('Tab', 'shift');
      await input.press('Tab');
    };
    const clickPlan = [
      ...Array.from({ length: 10 }, (_, index) => firstClick(`C${index + 1}`, 'first click on History')),
      ...Array.from({ length: 3 }, (_, index) => firstClick(`N${index + 1}`, 'first click after keyboard navigation in the view', keyboardNav)),
      ...(workspaceMode ? [
        firstClick('W1', 'first click after choosing project beta', () => command({ cmd: 'chooseContext', folder: 'beta' })),
        firstClick('W2', 'first click after choosing General', () => command({ cmd: 'chooseContext', folder: 'general' })),
        firstClick('W3', 'first click after choosing project alpha', () => command({ cmd: 'chooseContext', folder: 'alpha' })),
        firstClick('W4', 'first click after a folder is removed and added back', () => command({ cmd: 'cycleFolder' })),
        firstClick('W5', 'first click after another folder change', () => command({ cmd: 'cycleFolder' }))
      ] : [])
    ];
    // --identity (WP-03 T03-01): keys for one Arabic/English folder through
    // several URI spellings, computed in the editor with its own Uri.
    if (process.argv.includes('--identity')) {
      const target = path.join(box.sandbox, 'projects', 'مشروع Alpha مثال');
      fs.mkdirSync(target, { recursive: true });
      report.identity = await command({ cmd: 'identityProbe', folder: target });
      const keys = new Set(Object.values(report.identity).map((entry) => entry.key));
      console.log('  identity spellings: ' + Object.keys(report.identity).length + ', distinct keys: ' + keys.size);
      for (const [name, entry] of Object.entries(report.identity)) console.log('    ' + name + ': ' + entry.key.slice(0, 12) + '  ' + entry.fsPath);
    }
    // --identity-unicode (WP-04 T04-04): two physically distinct folders whose
    // names differ only in Unicode composition, keyed through the editor's Uri.
    if (process.argv.includes('--identity-unicode')) {
      const parent = path.join(box.sandbox, 'projects');
      const nfc = path.join(parent, 'Caf' + String.fromCodePoint(0xE9));
      const nfd = path.join(parent, 'Cafe' + String.fromCodePoint(0x301));
      fs.mkdirSync(nfc, { recursive: true });
      fs.mkdirSync(nfd, { recursive: true });
      report.unicode = { folders: fs.readdirSync(parent).map((name) => [...name].map((c) => c.codePointAt(0).toString(16)).join(' ')), nfc: await command({ cmd: 'identityProbe', folder: nfc }), nfd: await command({ cmd: 'identityProbe', folder: nfd }) };
      const keyOf = (probe) => probe['Uri.file'].key;
      console.log('  physical folders: ' + report.unicode.folders.length + ' (' + report.unicode.folders.join(' | ') + ')');
      console.log('  editor fsPaths distinct: ' + (report.unicode.nfc['Uri.file'].fsPath !== report.unicode.nfd['Uri.file'].fsPath) + '; same project key: ' + (keyOf(report.unicode.nfc) === keyOf(report.unicode.nfd)));
      // The case-mapping pairs (R-29), each in its own folder.
      const cp = String.fromCodePoint;
      report.caseMapping = {};
      for (const [name, a, b] of [['Kelvin sign / k', cp(0x212A), 'k'], ['Ohm sign / omega', cp(0x2126), cp(0x3C9)], ['Angstrom sign / a-ring', cp(0x212B), cp(0xE5)], ['I with dot / i + combining dot', cp(0x130), 'i' + cp(0x307)], ['x capital sigma / x final sigma', 'x' + cp(0x3A3), 'x' + cp(0x3C2)]]) {
        const pairParent = path.join(box.sandbox, 'pairs', String(Object.keys(report.caseMapping).length));
        const [one, two] = [path.join(pairParent, a), path.join(pairParent, b)];
        fs.mkdirSync(one, { recursive: true });
        fs.mkdirSync(two, { recursive: true });
        const probes = [await command({ cmd: 'identityProbe', folder: one }), await command({ cmd: 'identityProbe', folder: two })];
        report.caseMapping[name] = { folders: fs.readdirSync(pairParent).length, sameKey: keyOf(probes[0]) === keyOf(probes[1]) };
        console.log('  ' + name + ': physical folders ' + report.caseMapping[name].folders + '; same project key: ' + report.caseMapping[name].sameKey);
      }
    }
    const bisect = process.argv.includes('--bisect');
    const k2 = CASES.find((c) => c.id === 'K2');
    const probeFirst = (id, name, api) => ({ id, name, run: async () => { await command({ cmd: 'probeQuickPick', api }); await waitFor(quickPickTitle, 5000); await sleep(400); await input.type('All Chats'); await sleep(400); await input.press('Enter'); return {}; }, expect: async () => hostLog().some((e) => (e.type === 'sqp.result' && /All Chats/.test(e.picked || '')) || (e.type === 'cqp.accept' && /All Chats/.test(e.active || ''))) });
    const plan = process.argv.includes('--incident')
      ? [incidentCase('I1', process.argv.includes('--from-prompt') ? 'prompt' : process.argv.includes('--from-button') ? 'button' : undefined)]
      : process.argv.includes('--identity') || process.argv.includes('--identity-unicode')
      ? []
      : process.argv.includes('--first-click')
      ? clickPlan
      : process.argv.includes('--first-enter-probe')
      ? [probeFirst('P1', 'Probe list (not Kenlith) as the first Enter of the session', 'showQuickPick'), probeFirst('P2', 'Probe list again', 'showQuickPick'), firstEnterCase('P3', 'Kenlith All Chats after that')]
      : process.argv.includes('--escape')
      ? CASES.filter((c) => c.id === 'K14')
      : process.argv.includes('--first-enter')
      ? [firstEnterCase('F1', 'All Chats as the first Enter of the session'), firstEnterCase('F2', 'Same sequence again'), firstEnterCase('F3', 'Same sequence a third time')]
      : bisect
      ? [{ ...k2, id: 'B0', name: 'K2 with no prelude' }, ...Object.keys(PRELUDES).map((key, index) => ({ ...k2, id: `B${index + 1}`, name: `K2 after prelude "${key}" (cumulative)`, prelude: PRELUDES[key] }))]
      : CASES;
    for (let round = 1; round <= repeat; round += 1) {
      for (const testCase of plan) {
        if (testCase.prelude) { await reset(); await testCase.prelude(); }
        await reset();
        const hostStart = hostLog().length;
        await pageEval('(window.__diag = [], true)');
        let extra = {};
        let error;
        try { extra = await testCase.run(); } catch (caught) { error = String(caught.message || caught); }
        await sleep(2500);
        const ok = extra && 'opened' in extra ? extra.opened : await testCase.expect().catch(() => false);
        const entry = {
          round, id: testCase.id, name: testCase.name, ok, error, ...extra,
          workbench: await pageEval('window.__diag'),
          host: hostLog().slice(hostStart).filter((e) => /^(qp|cqp|sqp|history|allChats)/.test(e.type)).map((e) => ({ ...e, at: e.at % 100000 })),
          endFocus: (await pageEval("(() => { const e = document.activeElement; if (!e) return null; if (e.tagName === 'IFRAME') { try { return 'IFRAME[' + (new URL(e.src).searchParams.get('extensionId') || '') + ']'; } catch { return 'IFRAME'; } } return e.tagName + '.' + String(e.className).slice(0, 30); })()"))
        };
        report.cases.push(entry);
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${round}] ${testCase.id} ${testCase.name}${error ? `  (${error})` : ''}`);
        if (!ok) console.log(`        keys: ${entry.workbench.filter(([, w]) => /keydown|quickpick|focus IFRAME|side bar/.test(w)).map(([at, w]) => `${at} ${w}`).join(' | ').slice(0, 700)}`);
      }
    }
    await reset();
    await command({ cmd: 'done' });
  } catch (error) {
    report.error = String(error.stack || error);
    console.log('ERROR', report.error);
    await command({ cmd: 'done' }).catch(() => undefined);
  } finally {
    web?.close();
    page?.close();
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    if (code === 'timeout') child.kill();
    box.close();
  }
  const out = path.join(outDir, `${label}${folderMode ? '-folder' : ''}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const passed = report.cases.filter((c) => c.ok).length;
  console.log(`[${label}${folderMode ? ' folder' : ''}] ${passed} of ${report.cases.length} keyboard cases passed; details in ${path.relative(root, out)}`);
  // WP-05 T05-11 review: a failed case or two physical folders sharing a key
  // makes the run fail, so the exit code can be trusted.
  const pairs = [...(report.unicode ? [report.unicode.nfc['Uri.file'].key === report.unicode.nfd['Uri.file'].key] : []), ...Object.values(report.caseMapping || {}).map((pair) => pair.sameKey)];
  if (pairs.length) console.log(`[${label}] identity pairs: ${pairs.filter((same) => !same).length} of ${pairs.length} distinct`);
  process.exitCode = passed < report.cases.length || pairs.some(Boolean) ? 1 : 0;
}

main();
