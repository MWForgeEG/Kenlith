'use strict';

// Real-editor test of the Kenlith view in the actual sidebar (UI slice 2).
//
// Starts an isolated editor (throwaway profile, development host) with the
// test-only harness extension, which gives the real view synthetic sign-in,
// model, clipboard and browser (suite/sidebar-ui.js). This script drives the
// editor over its DevTools port with trusted input and checks the view at
// sidebar widths of about 240, 300 and 500 px in Dark Modern, Light Modern
// and High Contrast. It measures colour contrast and reads the browser's
// accessibility tree. Screenshots are of the editor window itself.
//
// Usage: node test/integration/sidebar-ui.js <Code.exe or Antigravity IDE.exe> <label> [screenshot folder]

const fs = require('node:fs');
const path = require('node:path');
const { clipboardSequence } = require('./lib/clipboard-sequence');
const { connect, inputFor, launch, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { testCopy } = require('./lib/test-copy');

// --folder: open a synthetic project folder (mixed Arabic and English name)
// instead of an empty window (stage 2).
const folderMode = process.argv.includes('--folder');
const [executable, label = 'editor', shotsArgument] = process.argv.slice(2).filter((item) => item !== '--folder');
// Long on purpose (WP-02 T02-06): the context indicator must truncate, not overflow.
const FOLDER_NAME = 'مشروع-alpha-with-a-long-folder-name';
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path (Code.exe or Antigravity IDE.exe).');
  process.exit(2);
}
const root = path.resolve(__dirname, '..', '..');
const shots = path.resolve(shotsArgument || path.join(root, 'design', 'uiux-review', 'slice-2', 'real'));
fs.mkdirSync(shots, { recursive: true });

const EMAIL = 'synthetic.user@example.test';
// Stage 3: the code attached in the view (synthetic; Arabic inside a string).
const UI_MARKER = 'UI_MARKER_51c';
const UI_CODE = `function greet(name) {\n  const text = "مرحبا، " + name; // ${UI_MARKER}\n  return text;\n}\n`;
const THEMES = [['dark', 'Default Dark Modern'], ['light', 'Default Light Modern'], ['hc', 'Default High Contrast']];
const WIDTHS = [240, 300, 500];

const results = [];
const measurements = { widths: [], contrast: {}, accessibility: null, viewTitle: null };
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`}`);
};
const note = (name, detail) => {
  results.push({ name, ok: true, note: true, detail });
  console.log(`  NOTE  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`);
};
const notVerified = (name, detail) => {
  results.push({ name, ok: true, notVerified: true, detail });
  console.log(`  NOT VERIFIED  ${name}  ${detail}`);
};

// Contrast of text and of key edges, from computed colours. Background is the
// first opaque ancestor background, with translucent layers composited on top.
const CONTRAST = `(() => {
  const parse = (value) => { const s = /color\\(srgb ([\\d.e-]+) ([\\d.e-]+) ([\\d.e-]+)(?: \\/ ([\\d.]+))?\\)/.exec(value || ''); if (s) return { r: +s[1] * 255, g: +s[2] * 255, b: +s[3] * 255, a: s[4] === undefined ? 1 : +s[4] }; const m = /rgba?\\(([^)]+)\\)/.exec(value || ''); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const backgroundOf = (element) => {
    const layers = [];
    for (let e = element; e; e = e.parentElement) {
      const c = parse(w.getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) { const top = layers.pop(); base = { r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 }; }
    return base;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const out = [];
  const text = (name, element, need = 4.5, pseudo) => {
    if (!element) return;
    const fg = parse(w.getComputedStyle(element, pseudo).color);
    const bg = backgroundOf(element);
    const blended = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 } : fg;
    out.push({ name, kind: 'text', fg: hex(blended), bg: hex(bg), ratio: +ratio(blended, bg).toFixed(2), need });
  };
  const edge = (name, element, colorValue, need = 3) => {
    if (!element) return;
    const fg = parse(colorValue);
    if (!fg || fg.a === 0) { out.push({ name, kind: 'edge', fg: 'none', bg: hex(backgroundOf(element.parentElement)), ratio: 0, need }); return; }
    const bg = backgroundOf(element.parentElement);
    out.push({ name, kind: 'edge', fg: hex(fg), bg: hex(bg), ratio: +ratio(fg, bg).toFixed(2), need });
  };
  const q = (s) => d.querySelector(s);
  text('chat history button', q('#chatTitle'));
  text('model selector', q('#models'));
  text('Account button', q('#account'));
  text('Send button', q('#send'));
  text('message input text', q('#prompt'));
  text('message input placeholder', q('#prompt'), 4.5, '::placeholder');
  text('reply text', q('#messages article.assistant .bubble p'));
  text('link', q('#messages a'));
  text('inline code', q('#messages .bubble p code'));
  text('code block', q('#messages pre code'));
  text('Copy button', q('#messages .copy'));
  text('plan label', q('#planRow span'));
  text('Manage usage link', q('#manageUsage'));
  edge('message input border', q('#prompt'), w.getComputedStyle(q('#prompt')).borderTopColor);
  edge('history button border', q('#history'), w.getComputedStyle(q('#history')).borderTopColor);
  edge('model selector border', q('#models'), w.getComputedStyle(q('#models')).borderTopColor);
  const focus = w.getComputedStyle(d.documentElement).getPropertyValue('--vscode-focusBorder').trim();
  const probe = d.createElement('span'); probe.style.color = focus; d.body.append(probe); const focusColor = w.getComputedStyle(probe).color; probe.remove();
  edge('focus outline', q('#history'), focusColor);
  return out;
})()`;

async function main() {
  // Metadata only: the clipboard's change counter, never its contents.
  const clipboardBefore = clipboardSequence();
  const box = await makeSandbox('plan-chat-sidebar-', { 'workbench.colorTheme': 'Default Dark Modern', 'workbench.sideBar.location': 'left', 'window.menuStyle': 'custom' });
  const port = 9300 + Math.floor(Math.random() * 600);
  const resultFile = path.join(box.sandbox, 'result.json');
  // The view runs from a throwaway test copy whose entry point gives it the
  // synthetic parts (lib/test-copy.js, test-main.js).
  const projectFolder = folderMode ? path.join(box.sandbox, 'projects', FOLDER_NAME) : undefined;
  // Stage 3: synthetic code to attach. In the folder window it is inside the
  // project; in the empty window (General) it is a loose folder, whose files
  // cannot be attached there (untitled editors are used instead).
  const codeDir = folderMode ? path.join(projectFolder, 'src') : path.join(box.sandbox, 'loose');
  fs.mkdirSync(codeDir, { recursive: true });
  fs.writeFileSync(path.join(codeDir, 'greet.js'), UI_CODE);
  fs.writeFileSync(path.join(codeDir, 'big.txt'), 'x'.repeat(12_001));
  if (folderMode) {
    fs.writeFileSync(path.join(projectFolder, 'readme.txt'), 'synthetic\n');
    fs.writeFileSync(path.join(projectFolder, '.env'), 'NOT_A_REAL_KEY=synthetic-value\n');
  }
  const { child, exited } = launch(executable, {
    developmentPaths: [testCopy(box.sandbox)],
    openPaths: folderMode ? [projectFolder] : [],
    userData: box.userData,
    sandbox: box.sandbox,
    port,
    env: {
      PLAN_CHAT_IT_UI_DIR: box.sandbox,
      PLAN_CHAT_IT_RESULT: resultFile,
      PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort)
    }
  });

  const hostLog = () => {
    const file = path.join(box.sandbox, 'host-events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const hostEvents = (type) => hostLog().filter((event) => event.type === type);
  let sequence = 0;
  async function command(body) {
    sequence += 1;
    fs.writeFileSync(path.join(box.sandbox, `control-${sequence}.json.tmp`), JSON.stringify(body));
    fs.renameSync(path.join(box.sandbox, `control-${sequence}.json.tmp`), path.join(box.sandbox, `control-${sequence}.json`));
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
  }

  let web;
  let page;
  try {
    if (!(await waitFor(() => fs.existsSync(path.join(box.sandbox, 'ready.json')), 120000, 250))) throw new Error('the scenario did not start');
    const chats = JSON.parse(fs.readFileSync(path.join(box.sandbox, 'ready.json'), 'utf8')).chats;
    const connection = await connect(port, 'history');
    ({ web, page } = connection);
    const { frameBase } = connection;
    const input = inputFor(page);
    const pageEval = (expression) => page.evaluate(expression);
    const inPage = (expression) => web.evaluate(`(() => { const f = document.getElementById('active-frame'); const d = f.contentDocument; const w = f.contentWindow; return (${expression}); })()`);

    // Antigravity covers a fresh profile with a welcome screen; "Get Started"
    // would begin its onboarding, so the overlay is hidden in this profile.
    const coveredBy = () => pageEval(`(() => { const frame = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(frameBase)})); const r = frame.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(60, r.height / 2)); return top === frame ? null : top ? (top.tagName + '.' + String(top.className)).slice(0, 100) : 'nothing'; })()`);
    const cover = await coveredBy();
    if (cover && /antigravity-ide-welcome/.test(cover)) {
      await pageEval("document.querySelectorAll('.antigravity-ide-welcome').forEach((n) => { n.classList.remove('visible'); n.style.display = 'none'; })");
      note('first-run welcome overlay hidden (test profile only)', cover);
    }
    check('the view is not covered by other editor UI', await waitFor(async () => !(await coveredBy()), 60000, 500), cover || 'never covered');

    async function frameRect() {
      const outer = await pageEval(`(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(frameBase)})); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
      const inner = await inPage("(() => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()");
      return { x: outer.x + inner.x, y: outer.y + inner.y, width: outer.width, height: outer.height };
    }
    async function centerOf(expression, reveal = false) {
      const boxIn = await inPage(`(() => { const e = ${expression}; if (!e) return null;
        if (${reveal}) { const list = d.getElementById('messages'); list.scrollTop += e.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2; }
        const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!boxIn) throw new Error(`no element for ${expression}`);
      const offset = await frameRect();
      return { x: offset.x + boxIn.x, y: offset.y + boxIn.y };
    }
    // Before each click into the view: what does the workbench have at that
    // point? Anything other than the webview frame is recorded and, once,
    // dismissed with Escape before retrying.
    const blocked = [];
    const topAt = (p) => pageEval(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); const f = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(frameBase)})); return e === f ? null : e ? (e.tagName + '.' + String(e.className)).slice(0, 120) : 'nothing'; })()`);
    const click = async (expression, reveal) => {
      let p = await centerOf(expression, reveal);
      const over = await topAt(p);
      if (over) {
        blocked.push({ expression: expression.slice(0, 60), over });
        await input.press('Escape');
        await sleep(300);
        p = await centerOf(expression, false);
      }
      await input.click(p.x, p.y);
    };
    async function sidebarShot(name) {
      const rect = await pageEval("(() => { const r = document.querySelector('.part.sidebar').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()");
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
      fs.writeFileSync(path.join(shots, `${label}-${name}.png`), Buffer.from(data, 'base64'));
      // Seen in testing: the first click into the webview right after a
      // clipped capture can be lost. Let the window settle first.
      await sleep(500);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 5, y: rect.y + rect.height / 2 });
      await sleep(200);
    }
    async function windowShot(name) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, `${label}-${name}.png`), Buffer.from(data, 'base64'));
    }
    async function setSidebarWidth(target) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const info = await pageEval(`(() => {
          const s = document.querySelector('.part.sidebar').getBoundingClientRect();
          const sash = [...document.querySelectorAll('.monaco-sash.vertical')].map((x) => x.getBoundingClientRect()).filter((r) => r.height > 200 && Math.abs(r.left + r.width / 2 - s.right) < 8)[0];
          return { left: s.left, right: s.right, width: s.width, sash: sash && { x: sash.left + sash.width / 2, y: sash.top + sash.height / 2 } };
        })()`);
        if (!info.sash) throw new Error('sidebar sash not found');
        if (Math.abs(info.width - target) <= 2) break;
        await input.drag(info.sash, { x: info.left + target, y: info.sash.y });
      }
      const frame = await frameRect();
      const sidebar = await pageEval("document.querySelector('.part.sidebar').getBoundingClientRect().width");
      return { sidebar: Math.round(sidebar), webview: Math.round(frame.width) };
    }
    const dialog = () => pageEval("(() => { const box = document.querySelector('.monaco-dialog-box'); if (!box || !box.getBoundingClientRect().width) return null; return { text: box.innerText, buttons: [...box.querySelectorAll('.monaco-button')].map((b) => b.innerText.trim()).filter(Boolean) }; })()");
    async function clickDialogButton(text) {
      const p = await pageEval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!p) throw new Error(`dialog button ${text} not found`);
      await input.click(p.x, p.y);
    }
    const quickPick = () => pageEval("(() => { const w = document.querySelector('.quick-input-widget'); if (!w || !w.getBoundingClientRect().height || getComputedStyle(w).display === 'none') return null; return { title: (w.querySelector('.quick-input-title') || {}).innerText || '', rows: [...w.querySelectorAll('.monaco-list-row')].map((r) => r.getAttribute('aria-label') || r.innerText) }; })()");
    const viewTitle = () => pageEval(`(() => {
      const t = document.querySelector('.part.sidebar .composite.title');
      const labels = [...t.querySelectorAll('.action-item .action-label')].map((a) => a.getAttribute('aria-label') || a.title || a.innerText).filter(Boolean);
      return { label: (t.querySelector('.title-label') || t).innerText.trim(), actions: labels };
    })()`);
    async function clickTitleAction(prefix) {
      const p = await pageEval(`(() => { const a = [...document.querySelectorAll('.part.sidebar .composite.title .action-item .action-label')].find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(prefix)})); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!p) throw new Error(`title action ${prefix} not found`);
      await input.click(p.x, p.y);
    }
    const chatTitle = () => inPage("d.getElementById('chatTitle').textContent");
    // Antigravity's first-run notice in its side panel can hold keyboard
    // focus in a fresh test profile; clicking the Quick Pick's input puts the
    // focus back where a user would put it. (The notice is never answered.)
    async function focusQuickPickInput() {
      const p = await pageEval("(() => { const i = document.querySelector('.quick-input-widget input'); if (!i || !i.getBoundingClientRect().width) return null; const r = i.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()");
      if (p) await input.click(p.x, p.y);
    }
    const streaming = () => inPage("!d.getElementById('stop').classList.contains('hidden')");
    const state = () => inPage(`(() => { const list = d.getElementById('messages'); const articles = [...d.querySelectorAll('#messages article.message')];
      return { distanceFromEnd: list.scrollHeight - list.scrollTop - list.clientHeight, scrollTop: list.scrollTop, jump: !d.getElementById('jump').classList.contains('hidden'),
        stop: !d.getElementById('stop').classList.contains('hidden'), sendDisabled: d.getElementById('send').disabled, promptDisabled: d.getElementById('prompt').disabled,
        prompt: d.getElementById('prompt').value, articles: articles.length, unique: new Set(articles.map((a) => a.dataset.id)).size,
        lastAssistant: (articles.filter((a) => a.classList.contains('assistant')).at(-1)?.querySelector('.bubble')?.textContent || '').length,
        announcer: d.getElementById('announcer').textContent, alerts: d.getElementById('alerts').textContent,
        banner: d.getElementById('errorBanner').classList.contains('hidden') ? '' : d.getElementById('errorBanner').textContent }; })()`);
    async function focusPrompt() {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await click("d.getElementById('prompt')");
        if (await inPage("d.activeElement && d.activeElement.id === 'prompt'")) return attempt;
        await sleep(500);
      }
      throw new Error('the input did not keep focus');
    }
    // Keyboard route to the history button: click inside the conversation
    // (focuses the page), then Shift+Tab back to it.
    async function focusHistoryByKeyboard() {
      await click("[...d.querySelectorAll('#messages article.user .bubble')].at(-1) || d.getElementById('messages')", true);
      for (let step = 0; step < 8; step += 1) {
        if ((await inPage("d.activeElement && d.activeElement.id")) === "history") return;
        await input.press("Tab", "shift");
      }
      throw new Error("Shift+Tab did not reach the history button");
    }
    // T02-04: every mouse opening of History is counted; there is no retry.
    const historyClicks = { total: 0, failed: [] };
    async function openChat(fragment) {
      historyClicks.total += 1;
      await click("d.getElementById('history')");
      if (!(await waitFor(quickPick, 5000))) {
        historyClicks.failed.push(fragment);
        check(`T02-04: History opened on the first click (opening for "${fragment}")`, false, 'the list did not appear; continuing by keyboard, not counted as a pass');
        await focusHistoryByKeyboard();
        await input.press('Enter');
        if (!(await waitFor(quickPick, 5000))) throw new Error('history did not open by keyboard either');
      }
      await sleep(400); // let the Quick Pick input take focus before typing
      await input.type(fragment);
      await sleep(300);
      await input.press('Enter');
      await sleep(600);
    }

    await waitFor(() => inPage("d.querySelectorAll('#messages article.message').length > 0"), 30000);
    console.log(`[${label}] sidebar view found; driving it`);

    // ---------- precondition: the session's first workbench Enter (WP-02 T02-01) ----------
    // In a fresh Antigravity profile the first Enter delivered to any Quick Pick
    // is intercepted by the editor and its first-run side panel opens
    // (docs/WP-02-CLOSURE-REPORT.md). It is spent here on a probe list that is
    // not Kenlith's, and the outcome is recorded; every Kenlith list below
    // is tested with ordinary Enter presses.
    await command({ cmd: 'probeQuickPick', api: 'showQuickPick' });
    await waitFor(quickPick, 5000);
    await sleep(400);
    await input.press('Enter');
    await sleep(1500);
    const probeAccepted = hostEvents('sqp.result').some((event) => event.picked);
    for (let index = 0; index < 3 && (await quickPick()); index += 1) { await input.press('Escape'); await sleep(300); }
    note('precondition: first workbench Enter of the session, on a probe list (not Kenlith)', probeAccepted ? 'accepted normally' : 'intercepted by the editor (Antigravity first-run behaviour, WP-02 T02-01); the probe list did not receive it');

    // ---------- browser guard ----------
    await command({ cmd: 'canary' });
    const canaryDialog = await waitFor(dialog, 3000);
    if (canaryDialog) {
      const open = canaryDialog.buttons.find((b) => /^open$/i.test(b));
      if (open) await clickDialogButton(open);
    }
    await waitFor(() => box.browserCalls().some((line) => line.includes('/canary')) || box.sinkHits.length, 10000);
    const guardOk = box.browserCalls().some((line) => line.includes('/canary')) && box.sinkHits.length === 0;
    check('browser guard: editor-level navigation goes to the stub, not a browser', guardOk, { stub: box.browserCalls().length, sinkHits: box.sinkHits.length });

    // ---------- header and title bar ----------
    const title = await viewTitle();
    measurements.viewTitle = title;
    check('view title shows the product name once', /^kenlith$/i.test(title.label.replace(/\s+/g, ' ')), title.label);
    check('exactly one New Chat action, in the view title', title.actions.filter((a) => /^New Chat/.test(a)).length === 1, title.actions);
    check('History action in the view title', title.actions.some((a) => /^Show Chat History/.test(a)), title.actions);
    const header = await inPage(`({ brand: Boolean(d.querySelector('.brand')), newChatInView: Boolean(d.getElementById('newChat')), bodyHasEmail: d.body.innerText.includes(${JSON.stringify(EMAIL)}), chatTitle: d.getElementById('chatTitle').textContent, label: d.getElementById('history').getAttribute('aria-label') })`);
    check('webview: no brand line, no second New Chat, email not shown while the account panel is closed', !header.brand && !header.newChatInView && !header.bodyHasEmail, header);
    check('history button names the open chat', header.chatTitle === 'اشرح لي كيف تعمل دالة addMessage في store.js' && header.label.endsWith(header.chatTitle), header);


    const speakers = await inPage("(() => { const roles = [...d.querySelectorAll('#messages .role')]; return { count: roles.length, texts: [...new Set(roles.map((r) => r.textContent))], maxWidth: Math.max(...roles.map((r) => r.getBoundingClientRect().width)) }; })()");
    check('speaker names: not shown, still in the page for screen readers', speakers.count > 0 && speakers.maxWidth <= 1 && speakers.texts.includes('You') && speakers.texts.includes('Assistant'), speakers);

    // ---------- widths × themes ----------
    for (const [tag, theme] of THEMES) {
      await command({ cmd: 'theme', name: theme });
      await sleep(1500);
      for (const width of WIDTHS) {
        const measured = await setSidebarWidth(width);
        await inPage("(d.getElementById('messages').scrollTop = d.getElementById('messages').scrollHeight, true)");
        await sleep(400);
        const layout = await inPage(`(() => {
          const visible = (s) => { const e = d.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= w.innerWidth + 1; };
          return { overflowX: d.documentElement.scrollWidth - d.documentElement.clientWidth, history: visible('#history'), models: visible('#models'), account: visible('#account'), send: visible('#send'), prompt: visible('#prompt'),
            accountText: d.getElementById('account').scrollWidth <= d.getElementById('account').clientWidth + 1 };
        })()`);
        measurements.widths.push({ theme: tag, target: width, ...measured, ...layout });
        check(`${tag} @${width}: controls fit; no sideways scrolling`, layout.overflowX <= 0 && layout.history && layout.models && layout.account && layout.send && layout.prompt && layout.accountText, { ...measured, ...layout });
        await sidebarShot(`${tag}-${width}-conversation`);
      }
      await setSidebarWidth(300);
      measurements.contrast[tag] = await inPage(CONTRAST);
      // Recorded, not pass/fail: most of these colours are the theme's own
      // (the same tokens VS Code uses for its inputs); the report says which.
      const failing = measurements.contrast[tag].filter((item) => item.ratio < item.need);
      note(`${tag}: contrast measured for ${measurements.contrast[tag].length} pairs; below target: ${failing.length}`, failing.map((item) => `${item.name} ${item.ratio}:1 (needs ${item.need})`).join('; ') || 'none');
      // M1-0: the two new controls are checked, not only recorded.
      const planPairs = measurements.contrast[tag].filter((item) => item.name === 'plan label' || item.name === 'Manage usage link');
      check(`M1-0: ${tag}: plan label and Manage usage text meet 4.5:1`, planPairs.length === 2 && planPairs.every((item) => item.ratio >= 4.5), planPairs.map((item) => `${item.name} ${item.fg} on ${item.bg} ${item.ratio}:1`).join('; ') || 'not found');

      await click("d.getElementById('account')");
      await sleep(300);
      const panel = await inPage(`({ expanded: d.getElementById('account').getAttribute('aria-expanded'), email: d.getElementById('accountName').textContent, visible: !d.getElementById('accountPanel').classList.contains('hidden') })`);
      check(`${tag}: Account panel shows the email; no sign-out`, panel.expanded === 'true' && panel.visible && panel.email === EMAIL && hostEvents('auth.signOut').length === 0, panel);
      await sidebarShot(`${tag}-300-account`);
      await input.press('Escape');
    }
    await command({ cmd: 'theme', name: 'Default Dark Modern' });
    await sleep(1200);

    // ---------- stage 2: context, history scope, read-only (keyboard only, WP-02 T02-02) ----------
    const expectedContext = folderMode ? FOLDER_NAME : 'General';
    const chip = await inPage("({ staticShown: !d.getElementById('projectStatic').classList.contains('hidden'), pickerShown: !d.getElementById('projectPicker').classList.contains('hidden'), text: d.querySelector('#projectStatic .project-text').textContent, dir: d.querySelector('#projectStatic .project-text').getAttribute('dir') })");
    check(`stage 2: the context indicator shows "${expectedContext}" (no picker: one context)`, chip.staticShown && !chip.pickerShown && chip.text === expectedContext && chip.dir === 'auto', chip);
    await focusHistoryByKeyboard();
    await input.press('Enter');
    const scoped = await waitFor(quickPick, 5000);
    check('stage 2: history is scoped to this context and offers All Chats', scoped && scoped.title.includes(`(${expectedContext})`) && scoped.rows.some((r) => /All Chats/.test(r)) && !scoped.rows.some((r) => /Elsewhere/.test(r)), scoped && { title: scoped.title, rows: scoped.rows.slice(0, 4) });
    await sleep(400);
    await input.type('All Chats');
    await sleep(400);
    await input.press('Enter');
    await waitFor(async () => /All Chats/.test((await quickPick())?.title || ''), 5000);
    const allChats = await quickPick();
    check('T02-02 keyboard: History → type "All Chats" → Enter opens All Chats', allChats && /All Chats/.test(allChats.title), allChats ? allChats.title : hostLog().filter((e) => /history|allChats|qp./.test(e.type)).slice(-4));
    check("stage 2: All Chats lists the other project's chat, marked read-only", allChats && allChats.rows.some((r) => /Elsewhere/.test(r) && /read-only here/.test(r) && /مشروع-بيتا/.test(r)), allChats && allChats.rows.slice(0, 6));
    await sleep(400);
    await input.type('Elsewhere');
    await sleep(400);
    await input.press('Enter');
    await waitFor(() => inPage("!d.getElementById('readOnlyBar').classList.contains('hidden')"), 5000);
    const readOnly = await inPage("({ text: d.getElementById('readOnlyText').textContent, action: d.getElementById('readOnlyMove').textContent, sendDisabled: d.getElementById('send').disabled, title: d.getElementById('chatTitle').textContent })");
    check("T02-02 keyboard: in All Chats, type → Enter opens the other project's chat read-only, with the move action; Send is off", readOnly.text.includes('Read-only: this chat is in Other projects (مشروع-بيتا)') && readOnly.action === (folderMode ? 'Move to this project' : 'Move to General') && readOnly.sendDisabled && readOnly.title.startsWith('Elsewhere'), readOnly);
    await sidebarShot('dark-300-read-only');
    await inPage("(d.getElementById('readOnlyBack').focus(), true)");
    await input.press('Enter');
    await waitFor(() => inPage("d.getElementById('readOnlyBar').classList.contains('hidden')"), 5000);
    check("stage 2: Back (keyboard) returns to this context's chat", (await chatTitle()) === 'اشرح لي كيف تعمل دالة addMessage في store.js', await chatTitle());

    // ---------- WP-05 (DEC-PLANCHAT-009): Relink of an earlier-scheme chat, keyboard only ----------
    if (folderMode) {
      const legacyId = hostEvents('seeded')[0]?.chats.legacy;
      const tagBefore = await command({ cmd: 'tagOf', id: legacyId });
      check('Relink: the seeded chat carries an earlier-scheme project tag (no scheme marker)', tagBefore && tagBefore.kind === 'project' && tagBefore.scheme === undefined, tagBefore);
      await focusHistoryByKeyboard();
      await input.press('Enter');
      const scopedLegacy = await waitFor(quickPick, 5000);
      check('Relink: the earlier-scheme chat is not in this project\'s history', scopedLegacy && !scopedLegacy.rows.some((r) => /Legacy relink/.test(r)), scopedLegacy && scopedLegacy.rows.slice(0, 6));
      await sleep(400);
      await input.type('All Chats');
      await sleep(400);
      await input.press('Enter');
      await waitFor(async () => /All Chats/.test((await quickPick())?.title || ''), 5000);
      const allLegacy = await quickPick();
      check('Relink: All Chats lists it as read-only here', allLegacy && allLegacy.rows.some((r) => /Legacy relink/.test(r) && /read-only here/.test(r)), allLegacy && allLegacy.rows.slice(0, 8));
      await sleep(400);
      await input.type('Legacy relink');
      await sleep(400);
      await input.press('Enter');
      await waitFor(() => inPage("!d.getElementById('readOnlyBar').classList.contains('hidden')"), 5000);
      const bar = await inPage("({ text: d.getElementById('readOnlyText').textContent, action: d.getElementById('readOnlyMove').textContent, sendDisabled: d.getElementById('send').disabled, title: d.getElementById('chatTitle').textContent })");
      check('Relink: opened read-only under "Earlier identity key", action "Relink to this project", Send off', /Earlier identity key/.test(bar.text) && bar.action === 'Relink to this project' && bar.sendDisabled && bar.title.startsWith('Legacy relink'), bar);
      await sidebarShot('dark-300-relink');
      await inPage("(d.getElementById('readOnlyMove').focus(), true)");
      await input.press('Enter');
      const relinked = await waitFor(() => inPage("d.getElementById('readOnlyBar').classList.contains('hidden')"), 5000);
      const tagAfter = await command({ cmd: 'tagOf', id: legacyId });
      const windowKey = await command({ cmd: 'contextKey' });
      check('Relink (keyboard Enter on the action): the chat is now this project\'s, same id, tagged with scheme 2; the read-only bar is gone', relinked && tagAfter?.scheme === 2 && tagAfter.key === windowKey && tagAfter.key !== tagBefore.key && (await chatTitle()).startsWith('Legacy relink') && (await command({ cmd: 'chatIds' })).includes(legacyId), { tagAfter, title: await chatTitle() });
      // Back to the Arabic chat, which the checks below expect to be open.
      await command({ cmd: 'openChat', id: hostEvents('seeded')[0].chats.arabic });
      await waitFor(async () => (await chatTitle()) === 'اشرح لي كيف تعمل دالة addMessage في store.js', 5000);
    }

    // ---------- direction (real engine) ----------
    const render = await inPage(`(() => {
      const arabic = [...d.querySelectorAll('#messages article.assistant .bubble')].at(-1);
      const list = arabic.querySelector('ol'); const pre = arabic.querySelector('pre');
      const node = pre.querySelector('code').firstChild; const range = d.createRange();
      range.setStart(node, 0); range.setEnd(node, 1); const first = range.getBoundingClientRect().left;
      range.setStart(node, node.data.length - 1); range.setEnd(node, node.data.length); const last = range.getBoundingClientRect().left;
      return { list: w.getComputedStyle(list).direction, item: w.getComputedStyle(list.querySelector('li')).direction,
        markerRight: parseFloat(w.getComputedStyle(list).paddingRight) > parseFloat(w.getComputedStyle(list).paddingLeft),
        pre: w.getComputedStyle(pre).direction, code: pre.textContent, firstLeft: first < last,
        path: (arabic.querySelector('span.ltr') || {}).textContent, lastParagraph: w.getComputedStyle([...arabic.querySelectorAll('p')].at(-1)).direction };
    })()`);
    check('Arabic reply: list right-to-left, numbers on the right; code left-to-right in logical order', render.list === 'rtl' && render.item === 'rtl' && render.markerRight && render.pre === 'ltr' && render.firstLeft && render.code === "await store.addMessage('user', text, chatId);", render);
    check('mixed Arabic and English line keeps the path as one left-to-right unit', render.path === 'C:\\Users\\synthetic\\src\\store.js' && render.lastParagraph === 'rtl', render);

    // ---------- history and New Chat ----------
    await click("d.getElementById('history')");
    const pick = await waitFor(quickPick, 5000);
    check('history rows show a relative time; the open chat says so', pick && pick.rows.some((r) => /(just now|minutes? ago|hours? ago) · open now/.test(r)) && pick.rows.some((r) => /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(r)), pick && pick.rows.slice(0, 3));
    check('history opens the editor\'s Quick Pick with New Chat and every chat', pick && /Chat History/.test(pick.title) && pick.rows.some((r) => /New Chat/.test(r)) && pick.rows.some((r) => /Refactor the budget check/.test(r)) && pick.rows.some((r) => /Mixed:/.test(r)) && pick.rows.some((r) => /اشرح لي/.test(r)), pick);
    await input.press('Escape');
    await sleep(500);
    const afterEscape = await inPage("d.activeElement && d.activeElement.id");
    const viewFocused = await pageEval(`(() => { const e = document.activeElement; return Boolean(e && e.tagName === 'IFRAME' && String(e.src || '').startsWith(${JSON.stringify(frameBase)})); })()`);
    check('T02-07: Escape closes History and keyboard focus returns to the History button', afterEscape === 'history' && viewFocused, { afterEscape, viewFocused });
    await inPage("(d.getElementById('account').focus(), true)");
    await input.press('Enter');
    await sleep(300);
    await input.press('Escape');
    await sleep(300);
    const accountEscape = await inPage("({ open: !d.getElementById('accountPanel').classList.contains('hidden'), focused: d.activeElement && d.activeElement.id })");
    check('T02-07: Account opened with Enter, closed with Escape; focus returns to Account', !accountEscape.open && accountEscape.focused === 'account', accountEscape);

    // Keyboard only, twice: history button opened with Enter, then with Space.
    // Each starts after a mouse-opened history pick (openChat), so both start
    // from the same state.
    await openChat('Mixed');
    await focusHistoryByKeyboard();
    await input.press('Enter');
    await waitFor(quickPick, 5000);
    await sleep(400);
    await input.type('Refactor the budget');
    await sleep(300);
    const beforeEnter = await pageEval("(() => { const w = document.querySelector('.quick-input-widget'); return w ? { value: (w.querySelector('input') || {}).value, rows: [...w.querySelectorAll('.monaco-list-row')].map((r) => (r.getAttribute('aria-label') || '').slice(0, 30)), focused: document.activeElement && document.activeElement.tagName + '.' + document.activeElement.className } : null; })()");
    await input.press('Enter');
    await sleep(700);
    check('keyboard (history opened with Enter): type → Enter opens that chat (same id)', (await command({ cmd: 'currentChat' })) === chats.english, { title: await chatTitle(), beforeEnter });

    await openChat('اشرح لي');
    await focusHistoryByKeyboard();
    await input.press('Space');
    await waitFor(quickPick, 5000);
    await sleep(400);
    await input.type('Refactor the budget');
    await sleep(300);
    await input.press('Enter');
    await sleep(700);
    check('keyboard (history opened with Space): type → Enter opens that chat (same id)', (await command({ cmd: 'currentChat' })) === chats.english, await chatTitle());

    await focusHistoryByKeyboard();
    await input.press('Enter');
    await waitFor(quickPick, 5000);
    await input.press('Enter'); // first item: New Chat
    await sleep(700);
    const afterKeyboardNew = await inPage("({ title: d.getElementById('chatTitle').textContent, messages: d.querySelectorAll('#messages article.message').length })");
    check('keyboard: history → Enter on "New Chat" starts a new chat', afterKeyboardNew.title === 'New chat' && afterKeyboardNew.messages === 0, afterKeyboardNew);

    await openChat('Mixed');
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 });
    await waitFor(quickPick, 5000);
    await sleep(400);
    await input.type('Kenlith: New Chat');
    await sleep(500);
    await input.press('Enter');
    await sleep(800);
    check('keyboard: command palette "Kenlith: New Chat" works', (await chatTitle()) === 'New chat', await chatTitle());

    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 });
    await waitFor(quickPick, 5000);
    await sleep(400);
    await input.type('Kenlith: Sign Out');
    await sleep(600);
    const paletteRows = (await quickPick())?.rows || [];
    check('Sign Out is not offered in the command palette (Account panel only)', !paletteRows.some((r) => /Kenlith: Sign Out/.test(r)), paletteRows.slice(0, 5));
    await input.press('Escape');
    await sleep(300);

    await openChat('Refactor the budget');
    await clickTitleAction('New Chat');
    await sleep(700);
    check('mouse: the view-title New Chat action works', (await chatTitle()) === 'New chat', await chatTitle());
    const ids = await command({ cmd: 'chatIds' });
    check('existing chats keep their ids', [chats.english, chats.mixed, chats.arabic].every((id) => ids.includes(id)), ids.length);
    await openChat('اشرح لي');
    check('history reopens the Arabic chat', (await command({ cmd: 'currentChat' })) === chats.arabic);

    // ---------- model selection ----------
    await click("d.getElementById('models')");
    await input.press('Escape');
    await inPage("(d.getElementById('models').focus(), true)");
    await input.press('ArrowDown');
    await sleep(300);
    const selected = await inPage("d.getElementById('models').value");
    check('keyboard: model selector changes the model', selected === 'model-b', selected);

    // ---------- streaming, draft, Stop ----------
    const requestsBefore = hostEvents('openai.request').length;
    const articlesBefore = await inPage("d.querySelectorAll('#messages article.message').length");
    await focusPrompt();
    await input.type('Summarise the request budget rules.');
    await input.press('Enter');
    await waitFor(streaming, 10000);
    await waitFor(() => inPage(`d.querySelectorAll('#messages article.message').length >= ${articlesBefore + 2}`), 10000);
    check('the chosen model is the one requested', hostEvents('openai.request').at(-1)?.model === 'model-b', hostEvents('openai.request').at(-1)?.model);
    await inPage("(() => { const b = [...d.querySelectorAll('#messages article.assistant .bubble')].at(-1); w.__renders = 0; new w.MutationObserver(() => { w.__renders += 1; }).observe(b, { childList: true }); return true; })()");
    await sleep(700);
    const listCenter = await centerOf("d.getElementById('messages')");
    await input.wheel(listCenter.x, listCenter.y, -4000);
    const scrolled = await state();
    await sleep(1200);
    const later = await state();
    check('scrolled up during a stream, the view stays put; Jump to latest appears', later.lastAssistant > scrolled.lastAssistant && Math.abs(later.scrollTop - scrolled.scrollTop) < 4 && later.jump, { before: scrolled.scrollTop, after: later.scrollTop });
    await focusPrompt();
    await input.type('quick: draft typed while streaming');
    await input.press('Enter');
    await sleep(300);
    const drafted = await state();
    check('draft typed during the stream is kept; Enter does not send it', drafted.prompt === 'quick: draft typed while streaming' && hostEvents('openai.request').length === requestsBefore + 1, drafted.prompt);
    await sidebarShot('dark-300-streaming');
    await inPage("(w.__stopClicks = 0, d.getElementById('stop').addEventListener('click', () => { w.__stopClicks += 1; }), true)");
    const stopProbe = await inPage("(() => { const r = d.getElementById('stop').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const e = d.elementFromPoint(x, y); return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], inner: e ? e.id || e.className || e.tagName : null, viewport: [w.innerWidth, w.innerHeight] }; })()");
    await click("d.getElementById('stop')");
    await sleep(300);
    note('Stop click reached the page / the provider', { page: await inPage('w.__stopClicks'), provider: hostEvents('provider.stop').length, probe: stopProbe });
    await waitFor(async () => !(await streaming()), 10000);
    await sleep(500);
    const stopped = await state();
    const renders = await inPage('w.__renders');
    const deltas = hostEvents('openai.deltas').at(-1)?.count;
    const total = hostEvents('openai.pieces').at(-1)?.total;
    check('Stop cuts the reply short and keeps the partial text; no lost or duplicate messages',
      !stopped.stop && deltas < total && stopped.lastAssistant > 0 && stopped.articles === stopped.unique && stopped.articles === articlesBefore + 2, { deltas, total, articles: stopped.articles, unique: stopped.unique });
    check('streamed text rendered in batches', renders > 0 && deltas > 0 && renders < deltas / 2, { renders, deltas });
    await focusPrompt();
    await input.press('Enter');
    await waitFor(async () => (await state()).announcer.startsWith('Response complete. Done.'), 10000);
    check('the kept draft sends afterwards; the reply is announced', (await state()).announcer.startsWith('Response complete. Done.'), (await state()).announcer.slice(0, 60));

    // ---------- error, once ----------
    await focusPrompt();
    await input.type('please fail now');
    await input.press('Enter');
    await waitFor(async () => (await state()).alerts, 10000);
    await sleep(800);
    const failed = await state();
    // Visible copies only: the conversation and the banner (the screen-reader
    // alert region is visually hidden and counted separately below).
    const shownTimes = await inPage("(d.getElementById('messages').innerText.match(/Synthetic failure/g) || []).length + (d.getElementById('errorBanner').classList.contains('hidden') ? 0 : (d.getElementById('errorBanner').innerText.match(/Synthetic failure/g) || []).length)");
    const toasts = await pageEval("[...document.querySelectorAll('.notification-toast')].filter((t) => t.innerText.includes('Synthetic failure')).length");
    check('a failed reply is shown once: in the message, not the banner, not a notification', shownTimes === 1 && !failed.banner && toasts === 0, { shownTimes, banner: failed.banner, toasts });
    check('the failure is announced through an alert region', failed.alerts.includes('Synthetic failure'), failed.alerts.slice(0, 80));
    await sidebarShot('dark-300-error');

    // ---------- M1-0: ChatGPT plan usage (SIWC guidelines) ----------
    let m1Welcome = false;
    const USAGE_URL = 'https://chatgpt.com/settings/usage';
    const lastMessage = () => inPage("(() => { const a = [...d.querySelectorAll('#messages article.message')].at(-1); return a ? { error: a.classList.contains('error'), text: a.innerText, action: Boolean(a.querySelector('.usage-action')) } : null; })()");
    check('M1-0: a failure whose text only mentions a usage limit (no structured code) offers no Manage usage', (await lastMessage())?.action === false, (await lastMessage())?.text.slice(0, 80));
    const startWelcome = await command({ cmd: 'welcomeState' });
    check('M1-0: a user signed in before this version ran is not shown the welcome (marked at activation)', startWelcome?.existingSession === true && !(await dialog()), startWelcome);
    const plan = await inPage("({ row: !d.getElementById('planRow').classList.contains('hidden'), text: d.getElementById('planRow').innerText, below: d.getElementById('planRow').previousElementSibling.id, panelClosed: d.getElementById('accountPanel').classList.contains('hidden'), panelAfterRow: d.getElementById('accountPanel').previousElementSibling.id, note: !d.getElementById('planNote').classList.contains('hidden') && d.getElementById('planNote').textContent })");
    check('M1-0: "Using ChatGPT plan" with Manage usage directly under the model selector; the Account panel says Kenlith is free', plan.row && /Using ChatGPT plan/.test(plan.text) && /Manage usage/.test(plan.text) && plan.below === 'accountPanel' && plan.panelClosed && plan.panelAfterRow === 'accountRow' && /Kenlith is free/.test(plan.note || ''), plan);
    const clearPrompt = () => inPage("(d.getElementById('prompt').value = '', d.getElementById('prompt').dispatchEvent(new Event('input')), true)");
    // Sending after the usage-limit error is paused: Send gives the text back
    // unsent; the banner offers Manage usage and Resume; Resume ends the pause.
    const pausedProbe = async (label) => {
      const requestsBefore = (await command({ cmd: 'synthetic' })).requests.length;
      await clearPrompt();
      await focusPrompt();
      await input.type('quick while paused');
      await input.press('Enter');
      await waitFor(async () => /paused/.test((await state()).banner || ''), 8000);
      const paused = await inPage("({ banner: d.getElementById('errorBanner').classList.contains('hidden') ? '' : d.getElementById('errorBanner').innerText, buttons: [...d.querySelectorAll('#errorBanner button')].map((b) => b.textContent), prompt: d.getElementById('prompt').value })");
      const requestsAfter = (await command({ cmd: 'synthetic' })).requests.length;
      check(`M1-0: ${label}: a send while paused makes no request, gives the text back, and offers Manage usage then Resume`, /Sending is paused/.test(paused.banner) && paused.buttons.join(',') === 'Manage usage,Resume' && paused.prompt === 'quick while paused' && requestsAfter === requestsBefore, { ...paused, requestsBefore, requestsAfter });
      await click("[...d.querySelectorAll('#errorBanner button')].find((b) => b.textContent === 'Resume')");
      await waitFor(async () => !(await state()).banner, 5000);
      const resumed = await inPage("({ banner: !d.getElementById('errorBanner').classList.contains('hidden'), note: d.getElementById('contextNote').textContent })");
      check(`M1-0: ${label}: Resume ends the pause and says so`, !resumed.banner && /Sending is resumed/.test(resumed.note), resumed);
      await clearPrompt();
    };
    const failWith = async (text, expect) => {
      await clearPrompt();
      await focusPrompt();
      await input.type(text);
      await input.press('Enter');
      await waitFor(async () => { const m = await lastMessage(); return m && m.error && expect.test(m.text); }, 10000);
      await sleep(500);
      return lastMessage();
    };
    const before = await failWith('usage limit before streaming', /usage limit reached/);
    const usageBanner = (await state()).banner;
    check('M1-0: the structured usage-limit error before the stream offers Manage usage in the failed message (also after the view re-renders the chat), not the banner', before?.action === true && !usageBanner, { before, usageBanner });
    await sidebarShot('dark-300-usage-limit');
    const openedBefore = (await command({ cmd: 'synthetic' })).opened.length;
    await click("[...d.querySelectorAll('#messages .usage-action')].at(-1)", true);
    const usageDialog = await waitFor(dialog, 5000);
    check('M1-0: Manage usage asks first and shows the ChatGPT usage address', usageDialog && usageDialog.text.includes(USAGE_URL), usageDialog);
    if (usageDialog) {
      await windowShot('dark-manage-usage-prompt');
      await clickDialogButton('Cancel');
      await sleep(500);
    }
    check('M1-0: cancelling opens nothing', (await command({ cmd: 'synthetic' })).opened.length === openedBefore);
    // Keyboard: the plan line's Manage usage, then Open Link.
    await inPage("(d.getElementById('manageUsage').focus(), true)");
    await input.press('Tab', 'shift');
    await input.press('Tab');
    const usageFocus = await inPage("(() => { const e = d.activeElement; const s = w.getComputedStyle(e); const r = e.getBoundingClientRect(); return { id: e.id, outline: s.outlineStyle + ' ' + s.outlineWidth, height: Math.round(r.height) }; })()");
    check('M1-0: Manage usage is reachable with Tab, shows a focus outline and is at least 24 px high', usageFocus.id === 'manageUsage' && !usageFocus.outline.startsWith('none') && usageFocus.height >= 24, usageFocus);
    await input.press('Enter');
    if (await waitFor(dialog, 5000)) {
      await clickDialogButton('Open Link');
      await sleep(600);
    }
    const openedUsage = await command({ cmd: 'synthetic' });
    check('M1-0: Enter on Manage usage, then Open Link, opens only the ChatGPT usage page (stand-in browser)', openedUsage.opened.length === openedBefore + 1 && openedUsage.opened.at(-1) === USAGE_URL && box.sinkHits.length === 0, openedUsage.opened.slice(-2));
    await pausedProbe('after the error before the stream');
    const during = await failWith('usage limit during streaming', /Partial reply before the limit/);
    check('M1-0: the usage-limit error after part of the reply keeps the partial text and offers Manage usage', during?.action === true && /Partial reply before the limit/.test(during.text) && /usage limit reached/.test(during.text), during);
    await pausedProbe('after the error during the stream');
    const rate = await failWith('please answer, rate limited', /rate limit reached/);
    check('M1-0: an unrelated 429 keeps its own message and offers no Manage usage', rate?.action === false, rate);

    // ---------- accessibility tree ----------
    const { frameTree } = await web.send('Page.getFrameTree');
    const inner = (frameTree.childFrames || []).find((child) => child.frame.id)?.frame.id;
    await web.send('Accessibility.enable');
    const { nodes } = await web.send('Accessibility.getFullAXTree', inner ? { frameId: inner } : {});
    const named = nodes.filter((n) => !n.ignored && n.role && ['button', 'combobox', 'textbox', 'main', 'alert', 'status', 'link', 'group', 'heading', 'list'].includes(n.role.value))
      .map((n) => ({ role: n.role.value, name: n.name?.value || '', expanded: n.properties?.find((p) => p.name === 'expanded')?.value?.value }));
    measurements.accessibility = named;
    const has = (role, test) => named.some((n) => n.role === role && test(n.name));
    check('accessibility tree: named history button, model combobox, Account, message box, Send, Conversation, alert and status regions',
      has('button', (n) => n.startsWith('Chat history. Open chat:')) && has('combobox', (n) => n === 'Model') && has('button', (n) => n === 'Account') && has('textbox', (n) => n === 'Message')
      && has('button', (n) => n === 'Send') && has('main', (n) => n === 'Conversation') && named.some((n) => n.role === 'alert') && named.some((n) => n.role === 'status'),
      named.filter((n) => ['button', 'combobox', 'textbox', 'main', 'alert', 'status'].includes(n.role)).slice(0, 14));
    check('accessibility tree: no unnamed buttons or links', named.filter((n) => ['button', 'link'].includes(n.role) && !n.name.trim()).length === 0, named.filter((n) => ['button', 'link'].includes(n.role) && !n.name.trim()));

    // ---------- keyboard order and focus ----------
    // Put focus in the webview (a click on a speaker label focuses nothing
    // but the page), start at the history button, then walk with Tab.
    await click("[...d.querySelectorAll('#messages article.user .bubble')].at(-1)", true);
    await inPage("(d.getElementById('history').focus(), true)");
    // Focus set by script does not show a focus ring; come back to the
    // history button with the keyboard so it is measured as a user sees it.
    await input.press('Tab');
    await input.press('Tab', 'shift');
    const visited = [{ id: await inPage('d.activeElement.id'), outline: await inPage("(() => { const s = w.getComputedStyle(d.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; })()") }];
    for (let index = 0; index < 50; index += 1) {
      await input.press('Tab');
      const focused = await inPage("(() => { const e = d.activeElement; if (!e || e === d.body) return null; const s = w.getComputedStyle(e); return { id: e.id || e.className || e.tagName, outline: s.outlineStyle + ' ' + s.outlineWidth }; })()");
      if (!focused) break;
      visited.push(focused);
      if (focused.id === 'send') break;
    }
    const order = visited.map((v) => v.id);
    check('keyboard: Tab reaches history, model, Account, conversation, input, Attach Selection and Send, each with a visible outline', ['history', 'models', 'account', 'messages', 'prompt', 'attach', 'send'].every((id) => order.includes(id)) && visited.every((v) => !v.outline.startsWith('none') && !/ 0px$/.test(v.outline)), visited.map((v) => `${v.id}(${v.outline})`).join(' → '));
    await sidebarShot('dark-300-focus');

    // ---------- Copy and links (synthetic clipboard and browser) ----------
    await inPage("(d.addEventListener('click', (event) => { w.__lastClick = (event.target.className || event.target.tagName) + ':' + String(event.target.textContent).slice(0, 20); }, true), true)");
    await click("[...d.querySelectorAll('#messages .code-block')].find((b) => b.querySelector('pre').textContent.startsWith('await store.addMessage')).querySelector('button.copy')", true);
    await waitFor(async () => (await command({ cmd: 'synthetic' })).clipboard.length > 0, 3000, 300);
    const afterCopy = await command({ cmd: 'synthetic' });
    check('Copy hands the exact code to the clipboard (synthetic)', afterCopy.clipboard.at(-1) === "await store.addMessage('user', text, chatId);", { copies: afterCopy.clipboard.length, clicked: await inPage('w.__lastClick || null') });
    notVerified('writing to the real Windows clipboard in the editor', 'covered only by unit tests against a fake; this test never touches the system clipboard');

    if (guardOk) {
      await openChat('Refactor the budget');
      await inPage("(w.__reachedWindow = 0, w.addEventListener('click', () => { w.__reachedWindow += 1; }), true)");
      await click("[...d.querySelectorAll('#messages a')].find((a) => a.textContent === 'the design note')", true);
      const linkDialog = await waitFor(dialog, 5000);
      check('link: Kenlith asks first, showing the full address', linkDialog && linkDialog.text.includes(`http://127.0.0.1:${box.sinkPort}/plan-chat-ui-link`), linkDialog);
      if (linkDialog) {
        await windowShot('dark-link-prompt');
        await clickDialogButton('Open Link');
        await sleep(600);
      }
      const opened = await command({ cmd: 'synthetic' });
      check('link: "Open Link" reaches the stand-in browser only; the click never reaches the editor\'s own handler',
        opened.opened.at(-1) === `http://127.0.0.1:${box.sinkPort}/plan-chat-ui-link` && (await inPage('w.__reachedWindow')) === 0 && box.sinkHits.length === 0, { opened: opened.opened.length, sinkHits: box.sinkHits.length });
    } else {
      notVerified('clicking links in the real editor', 'skipped: the browser guard did not prove itself');
    }

    // Screenshot of the history list, taken last: a full-window capture while
    // a Quick Pick is open was seen to leave the next Quick Pick unable to
    // accept a choice (a test artifact; nothing after this uses one).
    await click("d.getElementById('history')");
    if (await waitFor(quickPick, 5000)) {
      await windowShot('dark-history-quick-pick');
      await input.press('Escape');
      await sleep(500);
    }

    // ---------- stage 3: attach selected code ----------
    // Synthetic code in a real editor; the view is driven with trusted mouse
    // and keyboard input. Requests are the fake model's (no network).
    const openCode = (select = [0, 0, 4, 0]) => (folderMode
      ? command({ cmd: 'openFile', path: path.join(codeDir, 'greet.js'), select })
      : command({ cmd: 'openUntitled', content: UI_CODE, select }));
    const card = () => inPage(`(() => { const c = d.getElementById('attachCard'); const pre = d.getElementById('attachText'); const node = pre.firstChild;
      let firstLeft = null; if (node && node.data && node.data.length > 9) { const r = d.createRange(); r.setStart(node, 0); r.setEnd(node, 1); const a = r.getBoundingClientRect().left; r.setStart(node, 8); r.setEnd(node, 9); firstLeft = a < r.getBoundingClientRect().left; }
      return { visible: !c.classList.contains('hidden'), state: d.getElementById('attachState').textContent, source: d.getElementById('attachSource').textContent, sourceDir: d.getElementById('attachSource').getAttribute('dir'),
        size: d.getElementById('attachSize').textContent, flags: [...d.querySelectorAll('#attachFlags li')].map((li) => li.textContent), text: pre.textContent,
        textDirection: w.getComputedStyle(pre).direction, firstLeft, approveShown: !d.getElementById('attachApprove').classList.contains('hidden'),
        sendDisabled: d.getElementById('send').disabled, focused: d.activeElement && d.activeElement.id,
        notice: d.getElementById('attachNotice').classList.contains('hidden') ? '' : d.getElementById('attachNoticeText').textContent, alerts: d.getElementById('alerts').textContent }; })()`);
    const requests = async () => (await command({ cmd: 'synthetic' })).requests;
    const focusedWithRing = () => inPage("(() => { const e = d.activeElement; const s = w.getComputedStyle(e); return { id: e.id, outline: s.outlineStyle + ' ' + s.outlineWidth }; })()");
    const sourcePattern = folderMode ? /^src\/greet\.js · lines 1–4 · javascript$/ : /^Untitled-\d+ · lines 1–4 · javascript$/;

    await clickTitleAction('New Chat');
    await sleep(700);
    const requestsAtStart = (await requests()).length;
    await openCode();
    await sleep(600);
    // The editor's own context menu: Attach Selection appears with a selection.
    const editorPoint = await pageEval("(() => { const e = document.querySelector('.editor-group-container .monaco-editor .view-lines'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 8 }; })()");
    let menuItems = [];
    if (editorPoint) {
      await input.click(editorPoint.x, editorPoint.y, 'right');
      await sleep(900);
      // The workbench draws its menus inside a shadow root.
      menuItems = await pageEval(`(() => { const out = []; const visit = (root) => { root.querySelectorAll('.action-label').forEach((a) => out.push((a.getAttribute('aria-label') || a.textContent || '').trim())); root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) visit(e.shadowRoot); }); };
        visit(document); return out.filter(Boolean); })()`);
      if (!menuItems.length) await windowShot('debug-editor-context-menu');
      await input.press('Escape');
      await sleep(300);
    }
    if (!menuItems.length) {
      notVerified('stage 3: the editor context menu offers Attach Selection', 'the context menu could not be read from the page');
    } else {
      check('T02-05: the editor context menu offers "Attach Selection to Kenlith" when text is selected', menuItems.some((item) => item === 'Attach Selection to Kenlith'), menuItems.filter((item) => /Attach|Plan/i.test(item)));
    }
    await openCode();
    await sleep(500);
    await click("d.getElementById('attach')");
    await waitFor(async () => (await card()).visible, 8000);
    const review = await card();
    check('stage 3: Attach Selection opens the review card with the complete selected text, unchanged', review.visible && review.text === UI_CODE && review.state === 'Review, then approve', { state: review.state, sameText: review.text === UI_CODE, length: review.text.length });
    check('stage 3: the card names the source and lines, and gives sizes with a rough token estimate', sourcePattern.test(review.source) && review.sourceDir === 'ltr' && /^\d[\d,]* chars · [\d,]+ bytes UTF-8 · ≈ [\d,]+ tokens \(rough estimate\)$/.test(review.size) && (folderMode || review.flags.includes('Untitled editor: no file on disk.')), { source: review.source, size: review.size, flags: review.flags });
    check('stage 3: code in the card is left-to-right, Arabic string inside it included', review.textDirection === 'ltr' && review.firstLeft === true, { direction: review.textDirection, firstLeft: review.firstLeft });
    check('stage 3: Send waits for approval; focus is on Approve', review.sendDisabled && review.focused === 'attachApprove', { sendDisabled: review.sendDisabled, focused: review.focused });
    {
      const { frameTree } = await web.send('Page.getFrameTree');
      const frameId = (frameTree.childFrames || []).find((child) => child.frame.id)?.frame.id;
      await web.send('Accessibility.enable');
      const { nodes } = await web.send('Accessibility.getFullAXTree', frameId ? { frameId } : {});
      const named = nodes.filter((n) => !n.ignored && n.role).map((n) => ({ role: n.role.value, name: n.name?.value || '' }));
      check('stage 3: accessibility tree: an "Attached code" region with named Approve, Refresh and Remove buttons and a named code box',
        named.some((n) => n.role === 'region' && n.name === 'Attached code') && ['Approve', 'Refresh', 'Remove', 'Attach Selection'].every((name) => named.some((n) => n.role === 'button' && n.name === name)) && named.some((n) => n.name === 'Attached code, exactly as it will be sent'),
        named.filter((n) => /Attach|Approve|Refresh|Remove/.test(n.name)));
    }
    await sidebarShot('dark-300-attach-card');
    check('stage 3: attaching made no model request', (await requests()).length === requestsAtStart);

    // Keyboard: Approve → Refresh → Remove and back, then Enter approves.
    await inPage("(d.getElementById('attachApprove').focus(), true)");
    await input.press('Tab');
    const toRefresh = await focusedWithRing();
    await input.press('Tab');
    const toRemove = await focusedWithRing();
    await input.press('Tab', 'shift');
    await input.press('Tab', 'shift');
    const backToApprove = await focusedWithRing();
    check('stage 3: keyboard: Tab moves Approve → Refresh → Remove, Shift+Tab back, each with a visible outline', toRefresh.id === 'attachRefresh' && toRemove.id === 'attachRemove' && backToApprove.id === 'attachApprove' && [toRefresh, toRemove, backToApprove].every((f) => !f.outline.startsWith('none') && !/ 0px$/.test(f.outline)), [toRefresh, toRemove, backToApprove]);
    await input.press('Enter');
    await waitFor(async () => (await card()).state.startsWith('Approved'), 5000);
    const approved = await card();
    check('stage 3: Enter on Approve approves (no request); focus moves to the message box; Send is available', approved.state === 'Approved: sent with your next message' && !approved.approveShown && !approved.sendDisabled && approved.focused === 'prompt' && (await requests()).length === requestsAtStart, { state: approved.state, focused: approved.focused, sendDisabled: approved.sendDisabled });
    await sidebarShot('dark-300-attach-approved');

    // Arabic question, sent with the code.
    await input.type('اشرح هذه الدالة');
    await input.press('Enter');
    await waitFor(() => inPage("Boolean([...d.querySelectorAll('#messages article.assistant')].at(-1)?.querySelector('.reply-context'))"), 8000);
    await waitFor(async () => !(await streaming()), 8000);
    await sleep(300);
    const sent = await inPage(`(() => { const user = [...d.querySelectorAll('#messages article.user')].at(-1); const reply = [...d.querySelectorAll('#messages article.assistant')].at(-1); const chip = user.querySelector('.attach-chip');
      return { chip: chip ? chip.innerText : '', chipPathDir: chip ? chip.querySelector('span[dir]').getAttribute('dir') : '', userText: user.querySelector('.bubble').innerText.trim(), userDirection: w.getComputedStyle(user.querySelector('.bubble .line') || user.querySelector('.bubble')).direction,
        label: reply.querySelector('.reply-context span').textContent, button: (reply.querySelector('.reply-context button') || {}).textContent, cardVisible: !d.getElementById('attachCard').classList.contains('hidden') }; })()`);
    const afterSend = await requests();
    const turn = afterSend.at(-1) || [];
    check('stage 3: the message shows what was attached (metadata only) and that the code is not kept', /📎 Attached: (src\/greet\.js|Untitled-\d+) · lines 1–4 · \d[\d,]* chars · sent once/.test(sent.chip) && /not kept on this computer/.test(sent.chip) && sent.chipPathDir === 'ltr' && sent.userText === 'اشرح هذه الدالة' && !sent.cardVisible, sent);
    check('stage 3: the Arabic question reads right-to-left', sent.userDirection === 'rtl', sent.userDirection);
    check('stage 3: the reply says it is not sent with follow-ups, with an Include button', sent.label === 'Not sent with follow-up messages (contains a reply to attached code).' && sent.button === 'Include in follow-ups', sent);
    check('stage 3: one request carried the typed text, then the code exactly once', afterSend.length === requestsAtStart + 1 && turn.at(-1) === `اشرح هذه الدالة\n\n[Code selection attached by the user for this message]\n\`\`\`\n${UI_CODE}\n\`\`\`` && afterSend.filter((request) => request.join('\n').includes(UI_MARKER)).length === 1, { requests: afterSend.length - requestsAtStart });
    await sidebarShot('dark-300-attachment-sent');

    await focusPrompt();
    await input.type('quick: and then?');
    await input.press('Enter');
    await waitFor(async () => (await requests()).length > afterSend.length, 8000);
    await waitFor(async () => !(await streaming()), 8000);
    const followUp = (await requests()).at(-1) || [];
    check('stage 3: follow-up: no code, and the reply to it left out; the typed question kept', !followUp.join('\n').includes(UI_MARKER) && !followUp.join('\n').includes('ATTACHED-REPLY') && followUp.includes('اشرح هذه الدالة'), followUp.map((content) => content.slice(0, 40)));

    // Include in follow-ups: confirmation, then the reply is sent; Stop including.
    await click("d.querySelector('#messages .reply-context button')", true);
    const includeDialog = await waitFor(dialog, 8000);
    check('stage 3: Include in follow-ups asks first and says what will be sent', includeDialog && /Include this answer in follow-up messages\?/.test(includeDialog.text) && /may contain code from your attachment/.test(includeDialog.text) && includeDialog.buttons.includes('Include in Follow-ups'), includeDialog);
    if (includeDialog) {
      await windowShot('dark-include-confirmation');
      await clickDialogButton('Include in Follow-ups');
    }
    await waitFor(() => inPage("/^Sent with follow-up/.test(d.querySelector('#messages .reply-context span').textContent)"), 5000);
    const included = await inPage("({ label: d.querySelector('#messages .reply-context span').textContent, button: d.querySelector('#messages .reply-context button').textContent })");
    check('stage 3: after confirming, the reply is marked as sent with follow-ups; Stop including offered', included.label === 'Sent with follow-up messages (you included this reply to attached code).' && included.button === 'Stop including', included);
    const beforeIncluded = (await requests()).length;
    await focusPrompt();
    await input.type('quick: one more');
    await input.press('Enter');
    await waitFor(async () => (await requests()).length > beforeIncluded, 8000);
    await waitFor(async () => !(await streaming()), 8000);
    const withReply = (await requests()).at(-1) || [];
    check('stage 3: an included reply is sent with the next message; the code itself is not', withReply.some((content) => content.startsWith('ATTACHED-REPLY')) && !withReply.join('\n').includes(UI_MARKER), withReply.map((content) => content.slice(0, 40)));
    await click("d.querySelector('#messages .reply-context button')", true);
    await waitFor(() => inPage("/^Not sent/.test(d.querySelector('#messages .reply-context span').textContent)"), 5000);
    check('stage 3: Stop including returns the reply to "not sent", with no prompt', /^Not sent/.test(await inPage("d.querySelector('#messages .reply-context span').textContent")) && !(await dialog()));

    // Changed after capture, card and chip colours in every theme, then Remove by keyboard.
    await openCode();
    await sleep(400);
    await click("d.getElementById('attach')");
    await waitFor(async () => (await card()).visible, 8000);
    await command({ cmd: 'editActive', text: '// edited after capture\n' });
    await waitFor(async () => (await card()).flags.some((flag) => /changed after this was captured/.test(flag)), 5000);
    const changed = await card();
    check('stage 3: an edit after capture is flagged; the card still holds the captured text', changed.flags.some((flag) => /changed after this was captured/.test(flag)) && changed.text === UI_CODE, changed.flags);
    const CARD_CONTRAST = CONTRAST.replace(/  text\('chat history button'[\s\S]*?edge\('focus outline', q\('#history'\), focusColor\);/, () => `  text('card title', q('#attachTitle'));
  text('card state', q('#attachState'));
  text('card source', q('#attachSource'));
  text('card size', q('#attachSize'));
  text('card flag', q('#attachFlags li'));
  text('card notice', q('.attach-note'));
  text('attached code', q('#attachText'));
  text('Approve button', q('#attachApprove'));
  text('Refresh button', q('#attachRefresh'));
  text('Attach Selection button', q('#attach'));
  text('attachment chip', q('#messages .attach-chip'));
  text('reply context label', q('#messages .reply-context span'));
  text('Include button', q('#messages .reply-context button'));
  edge('card border', q('#attachCard'), w.getComputedStyle(q('#attachCard')).borderTopColor);
  const focus = w.getComputedStyle(d.documentElement).getPropertyValue('--vscode-focusBorder').trim();
  const probe = d.createElement('span'); probe.style.color = focus; d.body.append(probe); const focusColor = w.getComputedStyle(probe).color; probe.remove();
  edge('focus outline', q('#attachApprove'), focusColor);`);
    if (CARD_CONTRAST === CONTRAST) throw new Error('card contrast expression was not built');
    measurements.stage3Contrast = {};
    for (const [tag, theme] of THEMES) {
      await command({ cmd: 'theme', name: theme });
      await sleep(1500);
      await inPage("(d.getElementById('messages').scrollTop = d.getElementById('messages').scrollHeight, true)");
      measurements.stage3Contrast[tag] = await inPage(CARD_CONTRAST);
      const lowText = measurements.stage3Contrast[tag].filter((item) => item.kind === 'text' && item.ratio < item.need);
      check(`stage 3: ${tag}: card, chip and reply label text meet 4.5:1`, lowText.length === 0, lowText.map((item) => `${item.name} ${item.ratio}:1`).join('; ') || `${measurements.stage3Contrast[tag].length} pairs`);
      const edges = measurements.stage3Contrast[tag].filter((item) => item.kind === 'edge');
      note(`stage 3: ${tag}: card edge and focus outline`, edges.map((item) => `${item.name} ${item.ratio}:1`).join('; '));
      await sidebarShot(`${tag}-300-attach-changed`);
    }
    await command({ cmd: 'theme', name: 'Default Dark Modern' });
    await sleep(1200);
    await inPage("(d.getElementById('attachApprove').focus(), true)");
    await input.press('Tab');
    await input.press('Tab');
    const onRemove = await inPage('d.activeElement.id');
    await input.press('Enter');
    await waitFor(async () => !(await card()).visible, 5000);
    const removed = await card();
    check('stage 3: keyboard Remove clears the card, says nothing was sent, and returns focus to Attach Selection', onRemove === 'attachRemove' && !removed.visible && removed.notice === 'Attachment removed. Nothing was sent.' && removed.focused === 'attach', { onRemove, notice: removed.notice, focused: removed.focused });

    // Refusals shown in the view: oversized, then a blocked or not-allowed file.
    if (folderMode) await command({ cmd: 'openFile', path: path.join(codeDir, 'big.txt'), select: [0, 0, 0, 12_001] });
    else await command({ cmd: 'openUntitled', content: 'x'.repeat(12_001), select: [0, 0, 0, 12_001] });
    await sleep(400);
    await click("d.getElementById('attach')");
    await waitFor(async () => /12,001 characters/.test((await card()).notice), 5000);
    const oversized = await card();
    check('stage 3: an oversized selection is refused in the view with its size and the limit; announced as an alert', /The selection is 12,001 characters; the limit is 12,000\./.test(oversized.notice) && !oversized.visible && /12,001 characters/.test(oversized.alerts), oversized.notice);
    await sidebarShot('dark-300-attach-refused');
    if (folderMode) await command({ cmd: 'openFile', path: path.join(projectFolder, '.env'), select: [0, 0, 1, 0] });
    else await command({ cmd: 'openFile', path: path.join(codeDir, 'greet.js'), select: [0, 0, 4, 0] });
    await sleep(400);
    await click("d.getElementById('attach')");
    const refusal = folderMode ? /\.env is an environment file\. Code from these files is never attached\./ : /In General, only code from an untitled editor can be attached\./;
    await waitFor(async () => refusal.test((await card()).notice), 5000);
    check(folderMode ? 'stage 3: a .env file is refused in the view, with no override' : 'stage 3: in General, a file from disk is refused in the view', refusal.test((await card()).notice) && !(await card()).visible, (await card()).notice);
    await click("d.getElementById('attachNoticeClose')");
    check('stage 3: the notice can be dismissed', !(await card()).notice);

    // Starting a new chat discards a pending attachment.
    await openCode();
    await sleep(400);
    await click("d.getElementById('attach')");
    await waitFor(async () => (await card()).visible, 8000);
    await clickTitleAction('New Chat');
    await waitFor(async () => !(await card()).visible, 5000);
    check('stage 3: New Chat discards the pending code and says so', /new chat was started\. Nothing was sent\./.test((await card()).notice), (await card()).notice);
    check('stage 3: no request carried the code except the one approved turn', (await requests()).filter((request) => request.join('\n').includes(UI_MARKER)).length === 1);
    note('stage 3: unsaved synthetic editors closed without saving', `${await command({ cmd: 'discardEditors' })} left unsaved`);

    // ---------- WP-02 T02-06: real sidebar layout matrix ----------
    // The long-title chat, an error reply in it, and an attachment card open,
    // in three themes at about 240, 300 and 500 px.
    await openChat('Long title');
    await focusPrompt();
    await input.type('please fail now');
    await input.press('Enter');
    await waitFor(async () => (await state()).alerts, 10000);
    await sleep(600);
    await openCode();
    await sleep(400);
    await click("d.getElementById('attach')");
    await waitFor(async () => (await card()).visible, 8000);
    const LAYOUT = `(() => {
      const fits = (selector) => { const e = d.querySelector(selector); if (!e) return 'missing'; const r = e.getBoundingClientRect(); if (!r.width) return 'hidden'; return r.left >= -1 && r.right <= w.innerWidth + 1 ? 'ok' : 'clipped ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + w.innerWidth; };
      const controls = ['#history', '#models', '#account', '#prompt', '#attach', '#send', '#attachApprove', '#attachRefresh', '#attachRemove'];
      const title = d.getElementById('chatTitle');
      const chipText = [...d.querySelectorAll('.project-chip:not(.hidden) .project-text')][0];
      const bubbles = [...d.querySelectorAll('#messages .bubble')].filter((b) => b.scrollWidth > b.clientWidth + 1).length;
      const pres = [...d.querySelectorAll('#messages .code-block pre, #attachText')].map((p) => ({ scrolls: p.scrollWidth > p.clientWidth + 1, inside: p.getBoundingClientRect().right <= w.innerWidth + 1 }));
      return {
        overflowX: d.documentElement.scrollWidth - d.documentElement.clientWidth,
        controls: Object.fromEntries(controls.map((selector) => [selector, fits(selector)])),
        title: title.scrollWidth > title.clientWidth + 1 ? 'truncated with ' + w.getComputedStyle(title).textOverflow : 'fits',
        chip: chipText ? (chipText.scrollWidth > chipText.clientWidth + 1 ? 'truncated with ' + w.getComputedStyle(chipText).textOverflow : 'fits') : 'none',
        overflowingBubbles: bubbles,
        codeBlocks: pres.length, codeOutside: pres.filter((p) => !p.inside).length, codeScrolling: pres.filter((p) => p.scrolls).length
      };
    })()`;
    measurements.layoutMatrix = [];
    for (const [tag, theme] of THEMES) {
      await command({ cmd: 'theme', name: theme });
      await sleep(1500);
      for (const width of WIDTHS) {
        const measured = await setSidebarWidth(width);
        await inPage("(d.getElementById('messages').scrollTop = d.getElementById('messages').scrollHeight, true)");
        await sleep(400);
        const layout = await inPage(LAYOUT);
        measurements.layoutMatrix.push({ theme: tag, target: width, ...measured, ...layout });
        const controlsOk = Object.values(layout.controls).every((value) => value === 'ok');
        check(`T02-06 ${tag} @${width}: long title, long path, long code, error reply and attachment card fit; no sideways scrolling`,
          layout.overflowX <= 0 && controlsOk && layout.overflowingBubbles === 0 && layout.codeOutside === 0 && layout.title !== 'fits but overflowing' && (layout.chip === 'fits' || layout.chip === 'truncated with ellipsis' || layout.chip === 'none') && (layout.title === 'fits' || layout.title === 'truncated with ellipsis'),
          { ...measured, ...layout });
        await sidebarShot(`wp02-${tag}-${width}-layout`);
      }
    }
    await command({ cmd: 'theme', name: 'Default Dark Modern' });
    await sleep(1200);
    await inPage("(d.getElementById('attachRemove').focus(), true)");
    await input.press('Enter');
    await waitFor(async () => !(await card()).visible, 5000);
    // Streaming at the narrowest and widest sizes.
    await setSidebarWidth(240);
    await focusPrompt();
    await input.type('Summarise the request budget rules for the layout check.');
    await input.press('Enter');
    await waitFor(streaming, 10000);
    await sleep(1500);
    const streaming240 = await inPage(LAYOUT);
    await sidebarShot('wp02-dark-240-streaming');
    await setSidebarWidth(500);
    await sleep(800);
    const streaming500 = await inPage(LAYOUT);
    await sidebarShot('wp02-dark-500-streaming');
    check('T02-06 dark @240 and @500 while a reply streams: no sideways scrolling; Stop and input visible', streaming240.overflowX <= 0 && streaming500.overflowX <= 0 && streaming240.controls['#prompt'] === 'ok' && streaming500.controls['#prompt'] === 'ok', { streaming240, streaming500 });
    await inPage("(d.getElementById('stop').focus(), true)");
    await input.press('Enter');
    await waitFor(async () => !(await streaming()), 10000);
    await setSidebarWidth(300);
    note('T02-06 layout matrix measurements', measurements.layoutMatrix.map((m) => `${m.theme}@${m.target}: overflow ${m.overflowX}, title ${m.title}, chip ${m.chip}, code blocks ${m.codeBlocks} (${m.codeScrolling} scroll inside)`).join('; '));

    // ---------- M1-4: project context (folder mode only) ----------
    if (folderMode) {
      await command({ cmd: 'projectSubject', on: true });
      await command({ cmd: 'newChatCommand' });
      await sleep(800);
      const consentState = () => inPage("({ shown: !d.getElementById('consentCard').classList.contains('hidden'), text: d.getElementById('consentText').textContent, allow: d.getElementById('consentAllow').textContent, items: [...d.querySelectorAll('#consentList li > div')].map((e) => e.textContent), focus: d.activeElement && d.activeElement.id, prompt: d.getElementById('prompt').value })");
      const must = async (label, condition, ms) => { if (!(await waitFor(condition, ms))) throw new Error(`M1-4: timed out waiting for ${label}`); };
      const askProject = async (question) => {
        await inPage("(d.getElementById('prompt').value = '', d.getElementById('prompt').dispatchEvent(new Event('input')), true)");
        await focusPrompt();
        await input.type(question);
        await input.press('Enter');
      };
      const requestsBefore = (await command({ cmd: 'synthetic' })).requests.length;
      await askProject('quick: how does greet work in greet.js?');
      await must('the consent card', async () => (await consentState()).shown, 10000);
      const card = await consentState();
      const afterCard = (await command({ cmd: 'synthetic' })).requests.length;
      check('M1-4: a project question shows the consent card first: project, OpenAI, account and the files it would send; nothing sent yet',
        card.shown && card.text.includes(FOLDER_NAME) && card.text.includes('OpenAI') && card.text.includes(EMAIL) && card.items.some((item) => item.startsWith('src/greet.js')) && afterCard === requestsBefore,
        { ...card, requestsBefore, afterCard });
      check('M1-4: keyboard focus moves to the consent card', card.focus === 'consentTitle', card.focus);
      await sidebarShot('m1-4-consent-card');
      await input.press('Escape');
      await waitFor(async () => !(await consentState()).shown, 5000);
      const cancelled = await consentState();
      check('M1-4: Escape cancels: the card closes, nothing is sent, the question comes back', !cancelled.shown && cancelled.prompt === 'quick: how does greet work in greet.js?' && (await command({ cmd: 'synthetic' })).requests.length === requestsBefore, cancelled);

      await askProject('quick: how does greet work in greet.js?');
      await must('the consent card', async () => (await consentState()).shown, 10000);
      await click("d.getElementById('consentWithout')");
      await must('the request without project files', async () => (await command({ cmd: 'synthetic' })).requests.length > requestsBefore, 10000);
      await must('the reply to end', async () => !(await streaming()), 15000);
      const withoutSent = await command({ cmd: 'synthetic' });
      const withoutFooter = await inPage("[...d.querySelectorAll('#messages article.message.assistant')].at(-1)?.querySelector('.project-footer')?.textContent || ''");
      check('M1-4: Send without project files: the text alone goes, with the honest instruction, and the reply says so',
        !withoutSent.requests.at(-1).join('\n').includes('[Project context') && /No files from the user's project were provided/.test(withoutSent.instructions.at(-1)) && /Answered without project files/.test(withoutFooter),
        { last: withoutSent.requests.at(-1).at(-1), withoutFooter });

      await askProject('quick: explain greet in greet.js please');
      await must('the consent card', async () => (await consentState()).shown, 10000);
      const allowLabel = (await consentState()).allow;
      await click("d.getElementById('consentAllow')");
      await must('the request with project context', async () => (await command({ cmd: 'synthetic' })).requests.length > withoutSent.requests.length, 10000);
      await must('the reply to end', async () => !(await streaming()), 15000);
      const allowed = await command({ cmd: 'synthetic' });
      const sentTurn = allowed.requests.at(-1).at(-1);
      check('M1-4: Allow sends the original question once, with the excerpts labelled as project data',
        allowLabel === 'Allow for ' + FOLDER_NAME + ' and send' && sentTurn.startsWith('quick: explain greet in greet.js please') && sentTurn.includes('[Project context:') && sentTurn.includes('File: src/greet.js') && allowed.requests.length === withoutSent.requests.length + 1,
        { allowLabel, sentTurn: sentTurn.slice(0, 160) });
      await click("[...d.querySelectorAll('#messages article.message.assistant')].at(-1).querySelector('.project-footer summary')", true);
      await sleep(300);
      const footer = await inPage("(() => { const f = [...d.querySelectorAll('#messages article.message.assistant')].at(-1).querySelector('.project-footer'); return f ? { text: f.innerText, open: f.querySelector('details').open } : null; })()");
      check('M1-4: the reply shows which project files it used (relative path and lines)', Boolean(footer && footer.open && /Used \d+ project excerpts?/.test(footer.text) && /src\/greet\.js \(lines \d+-\d+\)/.test(footer.text)), footer);
      await sidebarShot('m1-4-context-footer');

      await askProject('quick: and what does greet return in greet.js?');
      await must('the follow-up request', async () => (await command({ cmd: 'synthetic' })).requests.length > allowed.requests.length, 10000);
      await must('the reply to end', async () => !(await streaming()), 15000);
      const followUp = await command({ cmd: 'synthetic' });
      const noCard = !(await consentState()).shown;
      check('M1-4: a follow-up in the same project uses the permission without asking again', noCard && followUp.requests.at(-1).at(-1).includes('[Project context:'), { noCard });

      // The user setting turns project context off: nothing is read or sent.
      const off = await command({ cmd: 'setProjectContext', value: false });
      await sleep(500);
      const beforeOff = (await command({ cmd: 'synthetic' })).requests.length;
      await askProject('quick: and greet once more in greet.js?');
      await must('the request with project context off', async () => (await command({ cmd: 'synthetic' })).requests.length > beforeOff, 10000);
      await must('the reply to end', async () => !(await streaming()), 15000);
      const offSent = await command({ cmd: 'synthetic' });
      check('M1-4: with kenlith.projectContext.enabled set to false in user settings, a project question sends no project context and asks nothing',
        off === false && !(await consentState()).shown && !offSent.requests.at(-1).join('\n').includes('[Project context'), { off, last: offSent.requests.at(-1).at(-1) });
      await command({ cmd: 'setProjectContext', value: undefined });
      await sleep(500);
      await click("d.getElementById('account')");
      await click("d.getElementById('manageSharing')");
      const sharing = await waitFor(quickPick, 6000);
      check('M1-4: Manage project sharing lists this project', Boolean(sharing && /Project Sharing/.test(sharing.title) && sharing.rows.some((row) => row.includes(FOLDER_NAME))), sharing);
      if (sharing) {
        await input.press('Escape');
        await sleep(500);
      }
      // Leave the Account panel closed, as the sign-out steps below expect.
      if (await inPage("d.getElementById('account').getAttribute('aria-expanded') === 'true'")) {
        await click("d.getElementById('account')");
        await sleep(300);
      }
      await command({ cmd: 'projectSubject', on: false });
    }

    // ---------- sign-out ----------
    await click("d.getElementById('account')");
    await click("d.getElementById('signOut')");
    const confirm = await waitFor(dialog, 8000);
    check('Sign Out… asks for confirmation', confirm && /Sign out of ChatGPT in Kenlith\?/.test(confirm.text), confirm);
    if (confirm) {
      await windowShot('dark-sign-out-confirmation');
      await clickDialogButton('Cancel');
      await sleep(1000);
      check('cancelled: no sign-out', hostEvents('auth.signOut').length === 0);
      await click("d.getElementById('account')");
      await click("d.getElementById('signOut')");
      if (await waitFor(dialog, 8000)) {
        await clickDialogButton('Sign Out');
        await waitFor(() => hostEvents('auth.signOut').length > 0, 8000);
        await sleep(800);
        const out = await inPage("!d.getElementById('signedOut').classList.contains('hidden')");
        const afterTitle = await viewTitle();
        check('confirmed: the sign-out runs once; the view shows sign-in; New Chat and History leave the title bar', hostEvents('auth.signOut').length === 1 && out && !afterTitle.actions.some((a) => /^New Chat|^Show Chat History/.test(a)), afterTitle.actions);
        await sidebarShot('dark-300-signed-out');
        m1Welcome = true;

        // ---------- M1-0: first-sign-in welcome ----------
        await command({ cmd: 'clearWelcome' });
        await click("d.getElementById('signIn')");
        // 0.7.0 (U4): a notification, not a modal dialog, so it never covers a card.
        const welcomeToast = () => pageEval("(() => { const t = [...document.querySelectorAll('.notification-toast')].find((x) => x.getBoundingClientRect().width && x.innerText.includes('ChatGPT plan')); if (!t) return null; return { text: t.innerText, buttons: [...t.querySelectorAll('.monaco-button')].map((b) => b.innerText.trim()).filter(Boolean) }; })()");
        const welcome = await waitFor(welcomeToast, 8000);
        const modalWelcome = await dialog();
        check('M1-0: the first sign-in shows the ChatGPT plan welcome as a notification (not a modal dialog): plan usage, usage limits, free app, one Got it button', welcome && !modalWelcome && /You’re using your ChatGPT plan/.test(welcome.text) && /usage limits/.test(welcome.text) && /Kenlith itself is free/.test(welcome.text) && welcome.buttons.length === 1 && welcome.buttons[0] === 'Got it', { welcome, modalWelcome });
        if (welcome) {
          await windowShot('dark-siwc-welcome');
          const p = await pageEval("(() => { const t = [...document.querySelectorAll('.notification-toast')].find((x) => x.innerText.includes('ChatGPT plan')); const b = t && [...t.querySelectorAll('.monaco-button')].find((x) => x.innerText.trim() === 'Got it'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
          if (p) await input.click(p.x, p.y);
          await sleep(800);
        }
        const dismissed = await command({ cmd: 'welcomeState' });
        const planAfter = await inPage("!d.getElementById('planRow').classList.contains('hidden')");
        check('M1-0: Got it is remembered, and the plan label shows after sign-in', dismissed?.dismissed === true && planAfter, { dismissed, planAfter });
        await click("d.getElementById('account')");
        await click("d.getElementById('signOut')");
        if (await waitFor(dialog, 8000)) {
          await clickDialogButton('Sign Out');
          await waitFor(() => hostEvents('auth.signOut').length > 1, 8000);
          await sleep(800);
        } else {
          check('M1-0: the second sign-out was confirmed, so the later sign-in can be checked', false);
        }
        await click("d.getElementById('signIn')");
        await waitFor(() => hostEvents('auth.signIn').length > 1, 8000);
        await sleep(2500);
        const again = await dialog();
        check('M1-0: a later sign-in shows no welcome', !again && hostEvents('auth.signIn').length === 2, again);
      }
    }

    if (!m1Welcome) check('M1-0: the first-sign-in welcome checks ran (they need the confirmed sign-out above)', false);
    check(`T02-04: History opened on the first click every time (${historyClicks.total} mouse openings, no retry)`, historyClicks.failed.length === 0, historyClicks.failed.length ? historyClicks.failed : undefined);
    note('clicks that first found other editor UI over the view', blocked.length ? blocked : 'none');
    check('no network request from the extension host', hostEvents('blockedFetch').length === 0, hostEvents('blockedFetch'));
    check('no browser opened: the local sink saw no request', box.sinkHits.length === 0, box.sinkHits);
    await command({ cmd: 'done' });
  } catch (error) {
    check('run completed', false, String(error?.stack || error));
    await command({ cmd: 'done' }).catch(() => undefined);
  } finally {
    web?.close();
    page?.close();
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    if (code === 'timeout') child.kill();
    box.close();
  }

  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : {};
  const clipboardAfter = clipboardSequence();
  check('the Windows clipboard was not changed during the run (sequence number)', clipboardBefore !== undefined && clipboardBefore === clipboardAfter, { before: clipboardBefore, after: clipboardAfter });
  if (report.errors?.length) check('scenario reported no errors', false, report.errors);
  const summary = { label, host: report.host, version: report.version, passed: results.filter((r) => r.ok && !r.note && !r.notVerified).length, failed: results.filter((r) => !r.ok).length, notVerified: results.filter((r) => r.notVerified).length, results, measurements };
  fs.writeFileSync(path.join(shots, `${label}-results.json`), JSON.stringify(summary, null, 2));
  console.log(`[${label}] ${report.host} ${report.version}: ${summary.passed} passed, ${summary.failed} failed, ${summary.notVerified} not verified`);
  console.log(`Sandbox profile: ${box.sandbox}`);
  process.exit(summary.failed ? 1 : 0);
}

main();
