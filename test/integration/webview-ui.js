'use strict';

// Real-webview interaction test for the UI hardening slice.
//
// Starts an isolated editor (throwaway profile and extensions folder) with
// this source tree as the development extension and the "webview-ui" suite
// phase, which shows the real Kenlith page in an editor panel with synthetic
// sign-in and model fakes (see suite/webview-ui.js). This script then drives
// that page through the editor's DevTools port with trusted mouse, wheel and
// keyboard input, checks what the page and the extension host did, and takes
// screenshots in Dark Modern and Light Modern.
//
// Usage: node test/integration/webview-ui.js <Code.exe or Antigravity IDE.exe> <label> [screenshot folder]
// Nothing here touches the installed extension, the real profile or history.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('../helpers/owned-temp');
const { clipboardSequence } = require('./lib/clipboard-sequence');

const [executable, label = 'editor', shotsArgument] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable)) {
  console.error('Pass the editor executable path (Code.exe or Antigravity IDE.exe).');
  process.exit(2);
}
const root = path.resolve(__dirname, '..', '..');
// Kenlith's code: the project, or the release candidate (WP-06, lib/candidate.js).
const { codeRoot } = require('./lib/test-copy');
const shots = path.resolve(shotsArgument || path.join(root, 'design', 'uiux-review', 'slice-1', 'real'));
fs.mkdirSync(shots, { recursive: true });

const sandbox = makeOwnedTempDir('plan-chat-ui-');
fs.writeFileSync(path.join(sandbox, 'browser-stub.cmd'), `@echo %*>>"${path.join(sandbox, 'browser-stub.txt')}"\r\n`);
const userData = path.join(sandbox, 'user-data');
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Default Dark Modern',
  'window.dialogStyle': 'custom',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'window.restoreWindows': 'none',
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.autoUpdate': false,
  'security.workspace.trust.enabled': false,
  // Any editor-level navigation goes to a stub that only records it (slice 2).
  'workbench.externalBrowser': path.join(sandbox, 'browser-stub.cmd')
}, null, 2));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

async function waitFor(predicate, timeout = 15000, interval = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(interval);
  }
  return undefined;
}

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)));
      socket.addEventListener('error', () => reject(new Error(`cannot connect ${url}`)));
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id && this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 20000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const port = 9300 + Math.floor(Math.random() * 600);
const resultFile = path.join(sandbox, 'result.json');
const hostLog = () => {
  const file = path.join(sandbox, 'host-events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const fromWebview = (type) => hostLog().filter((event) => event.type === 'webview' && event.message === type);
const hostEvents = (type) => hostLog().filter((event) => event.type === type);

let sequence = 0;
async function command(body) {
  sequence += 1;
  fs.writeFileSync(path.join(sandbox, `control-${sequence}.json.tmp`), JSON.stringify(body));
  fs.renameSync(path.join(sandbox, `control-${sequence}.json.tmp`), path.join(sandbox, `control-${sequence}.json`));
  const ack = path.join(sandbox, `ack-${sequence}.json`);
  if (!(await waitFor(() => fs.existsSync(ack), 30000))) throw new Error(`no answer to ${body.cmd}`);
  return JSON.parse(fs.readFileSync(ack, 'utf8')).result;
}

async function main() {
  // Metadata only: the clipboard's change counter, never its contents.
  const clipboardBefore = clipboardSequence();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    PLAN_CHAT_IT_PHASE: 'webview-ui',
    PLAN_CHAT_IT_RESULT: resultFile,
    PLAN_CHAT_IT_UI_DIR: sandbox,
    PLAN_CHAT_IT_SCENARIO: 'panel',
    PLAN_CHAT_IT_USER_DATA: userData
  });
  // A normal development window (no --extensionTestsPath: the editor refuses
  // dialogs under a test runner). The harness extension runs the scenario.
  const editor = spawn(executable, [
    `--extensionDevelopmentPath=${codeRoot}`,
    `--extensionDevelopmentPath=${path.join(__dirname, 'ui-harness-extension')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(sandbox, 'extensions')}`,
    `--remote-debugging-port=${port}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window'
  ], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => editor.on('exit', resolve));

  let page;
  let web;
  try {
    if (!(await waitFor(() => fs.existsSync(path.join(sandbox, 'ready.json')), 120000, 250))) {
      throw new Error('the suite did not open the webview');
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

    // The webview whose inner document is the Kenlith page, then the
    // workbench page that contains it (an editor may have more than one page).
    let webTarget;
    let pageTarget;
    await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const target of targets.filter((candidate) => candidate.url.startsWith('vscode-webview://'))) {
        const candidate = await Cdp.connect(target.webSocketDebuggerUrl);
        const found = await candidate.evaluate("Boolean(document.getElementById('active-frame')?.contentDocument?.getElementById('account'))").catch(() => false);
        if (found) {
          web = candidate;
          webTarget = target;
          return true;
        }
        candidate.close();
      }
      return false;
    }, 60000, 500);
    if (!web) throw new Error('Kenlith webview not found among DevTools targets');
    const frameBase = JSON.stringify(webTarget.url.split('?')[0]);
    await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const target of targets.filter((candidate) => candidate.type === 'page')) {
        const candidate = await Cdp.connect(target.webSocketDebuggerUrl);
        const holds = await candidate.evaluate(`[...document.querySelectorAll('iframe')].some((item) => item.src && item.src.startsWith(${frameBase}))`).catch(() => false);
        if (holds) {
          page = candidate;
          pageTarget = target;
          return true;
        }
        candidate.close();
      }
      return false;
    }, 30000, 500);
    if (!page) throw new Error('no editor page holds the Kenlith webview');

    // Something drawn over the webview (a first-run welcome screen, for
    // example) would swallow the clicks. Wait until the webview is on top.
    const coveredBy = () => page.evaluate(`(() => {
      const frame = [...document.querySelectorAll('iframe')].find((item) => item.src && item.src.startsWith(${frameBase}));
      const r = frame.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(80, r.height / 2));
      return top === frame ? null : top ? (top.tagName + '.' + String(top.className)).slice(0, 120) : 'nothing';
    })()`);
    const firstCover = await coveredBy();
    if (firstCover && /antigravity-ide-welcome/.test(firstCover)) {
      // Antigravity's first-run welcome screen on a fresh profile. "Get
      // Started" would begin its onboarding and sign-in, so the overlay is
      // hidden instead, in this throwaway profile only.
      await page.evaluate("document.querySelectorAll('.antigravity-ide-welcome').forEach((node) => { node.classList.remove('visible'); node.style.display = 'none'; })");
      console.log(`[${label}] hid the editor's first-run welcome overlay (test profile only)`);
    }
    const cleared = await waitFor(async () => !(await coveredBy()), 90000, 500);
    check('the webview is not covered by other editor UI before the test clicks', cleared, firstCover ? `initially covered by ${firstCover}; cleared` : 'never covered');
    if (!cleared) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, `${label}-covered.png`), Buffer.from(data, 'base64'));
      throw new Error(`the webview stays covered by ${await coveredBy()}`);
    }

    try {
      const browser = await Cdp.connect(version.webSocketDebuggerUrl);
      const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: pageTarget.id });
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: 1180, height: 820 } });
      browser.close();
    } catch {
      // Window size is cosmetic for the screenshots.
    }

    const inPage = (expression) => web.evaluate(`(() => { const f = document.getElementById('active-frame'); const d = f.contentDocument; const w = f.contentWindow; return (${expression}); })()`);
    const pageEval = (expression) => page.evaluate(expression);

    // Page coordinates of the webview's inner document.
    async function frameOffset() {
      const outer = await pageEval(`(() => { const frame = [...document.querySelectorAll('iframe')].find((item) => item.src && item.src.startsWith(${JSON.stringify(webTarget.url.split('?')[0])})); if (!frame) return null; const r = frame.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
      const inner = await inPage("(() => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()");
      return { x: outer.x + inner.x, y: outer.y + inner.y, width: outer.width, height: outer.height };
    }
    // `reveal` scrolls only the message list (scrollIntoView would also move
    // the editor around the webview), then measures.
    async function centerOf(expression, reveal = false) {
      const box = await inPage(`(() => {
        const e = ${expression};
        if (!e) return null;
        if (${reveal}) {
          const list = d.getElementById('messages');
          list.scrollTop += e.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2;
        }
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      const offset = await frameOffset();
      if (!box) throw new Error(`no element for ${expression}`);
      return { x: offset.x + box.x, y: offset.y + box.y };
    }
    async function click(expression, reveal = false) {
      const { x, y } = await centerOf(expression, reveal);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    }
    async function clickAt(x, y) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    }
    async function wheel(expression, deltaY) {
      const { x, y } = await centerOf(expression);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
      await sleep(200);
    }
    const KEY_CODES = { Tab: 9, Enter: 13, Escape: 27 };
    async function press(key, modifiers = 0) {
      const base = { key, code: key, windowsVirtualKeyCode: KEY_CODES[key], modifiers };
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (key === 'Enter') await page.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(120);
    }
    const type = (text) => page.send('Input.insertText', { text });
    // Clicks the input and confirms it has focus before typing. The editor
    // around the webview can take focus back right after a click (seen once in
    // Antigravity); such retries are recorded in the results.
    const focusRetries = [];
    async function focusPrompt() {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await click("d.getElementById('prompt')");
        if (await inPage("d.activeElement && d.activeElement.id === 'prompt'")) {
          if (attempt > 1) focusRetries.push(attempt);
          return;
        }
        await sleep(500);
      }
      throw new Error("the input did not keep focus after three clicks");
    }
    async function shot(name) {
      const offset = await frameOffset();
      const clip = { x: offset.x, y: offset.y, width: offset.width, height: offset.height, scale: 1 };
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip });
      const file = path.join(shots, `${label}-${name}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    }
    async function windowShot(name) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, `${label}-${name}.png`), Buffer.from(data, 'base64'));
    }
    async function dialog() {
      // The dialog is position: fixed, so it has no offsetParent; use its size.
      return pageEval("(() => { const box = document.querySelector('.monaco-dialog-box'); if (!box || !box.getBoundingClientRect().width) return null; return { text: box.innerText, buttons: [...box.querySelectorAll('.monaco-button')].map((b) => b.innerText.trim()).filter(Boolean) }; })()");
    }
    async function clickDialogButton(text) {
      const position = await pageEval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((x) => x.innerText.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!position) throw new Error(`dialog button ${text} not found`);
      await clickAt(position.x, position.y);
    }
    const streaming = () => inPage("!d.getElementById('stop').classList.contains('hidden')");
    const state = () => inPage(`(() => {
      const list = d.getElementById('messages');
      const articles = [...d.querySelectorAll('#messages article.message')];
      return {
        scrollTop: list.scrollTop,
        distanceFromEnd: list.scrollHeight - list.scrollTop - list.clientHeight,
        jumpVisible: !d.getElementById('jump').classList.contains('hidden'),
        stopVisible: !d.getElementById('stop').classList.contains('hidden'),
        sendDisabled: d.getElementById('send').disabled,
        promptDisabled: d.getElementById('prompt').disabled,
        prompt: d.getElementById('prompt').value,
        busy: list.getAttribute('aria-busy'),
        articles: articles.length,
        uniqueIds: new Set(articles.map((a) => a.dataset.id)).size,
        lastAssistant: (articles.filter((a) => a.classList.contains('assistant')).at(-1)?.querySelector('.bubble')?.textContent || '').length,
        announcer: d.getElementById('announcer').textContent,
        banner: d.getElementById('errorBanner').classList.contains('hidden') ? '' : d.getElementById('errorBanner').textContent,
        bannerRole: d.getElementById('errorBanner').getAttribute('role')
      };
    })()`);

    await waitFor(() => inPage("d.querySelectorAll('#messages article.message').length > 0"), 20000);
    const SEEDED = 18;
    console.log(`[${label}] webview found; driving it`);

    // ---------- rendering, direction, safety (checked once, in the real engine) ----------
    const render = await inPage(`(() => {
      const assistants = [...d.querySelectorAll('#messages article.assistant .bubble')];
      const arabic = assistants.at(-1);
      const list = arabic.querySelector('ol');
      const pre = arabic.querySelector('pre');
      const inline = arabic.querySelector('p code, li code');
      const path = arabic.querySelector('span.ltr');
      const style = (e) => { const s = w.getComputedStyle(e); return { direction: s.direction, unicodeBidi: s.unicodeBidi }; };
      // Visual order of the code line: its first character must be left of its last.
      const node = pre.querySelector('code').firstChild;
      const range = d.createRange();
      range.setStart(node, 0); range.setEnd(node, 1);
      const first = range.getBoundingClientRect().left;
      range.setStart(node, node.data.length - 1); range.setEnd(node, node.data.length);
      const last = range.getBoundingClientRect().left;
      const all = d.getElementById('messages');
      return {
        listDir: list.getAttribute('dir'), list: style(list), item: style(list.querySelector('li')),
        // The marker area (padding-inline-start) is on the right in a right-to-left list.
        markerOnRight: parseFloat(w.getComputedStyle(list).paddingRight) > parseFloat(w.getComputedStyle(list).paddingLeft),
        paragraph: style(arabic.querySelector('p')),
        pre: style(pre), code: pre.textContent,
        codeFirstLeftOfLast: first < last,
        inline: inline && { text: inline.textContent, ...style(inline) },
        path: path && { text: path.textContent, ...style(path) },
        dangerous: all.querySelectorAll('script, img, iframe, svg, object, embed, [onerror], [onload], [onclick], [onmouseover]').length,
        xss: d.body.dataset.xss || null,
        hrefs: [...all.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        hostileText: assistants.at(-3).textContent
      };
    })()`);
    check('Arabic reply: list and its items are right-to-left', render.listDir === 'rtl' && render.list.direction === 'rtl' && render.item.direction === 'rtl', { list: render.list, item: render.item });
    check('Arabic reply: list numbers sit on the right', render.markerOnRight);
    check('Arabic reply: paragraph resolves right-to-left', render.paragraph.direction === 'rtl', render.paragraph);
    check('code block: left-to-right, isolated, text in logical order', render.pre.direction === 'ltr' && render.code === "await store.addMessage('user', text, chatId);", render.pre);
    check('code block: first character drawn left of the last (not reversed)', render.codeFirstLeftOfLast);
    check('inline code inside Arabic: left-to-right and isolated', render.inline && render.inline.direction === 'ltr' && render.inline.unicodeBidi === 'isolate', render.inline);
    check('Windows path inside Arabic: kept as one left-to-right unit', render.path && render.path.text === 'C:\\Users\\synthetic\\src\\store.js' && render.path.direction === 'ltr', render.path);
    check('hostile message: no script, image, frame or handler elements; nothing ran', render.dangerous === 0 && render.xss === null, { dangerous: render.dangerous, xss: render.xss });
    check('hostile message: only http(s) links', render.hrefs.every((href) => /^https:\/\/example\.test\//.test(href)), render.hrefs);
    check('hostile message: the markup is shown as text', render.hostileText.includes('<script>') && render.hostileText.includes('javascript:'), render.hostileText.slice(0, 90));

    for (const theme of ['Default Dark Modern', 'Default Light Modern']) {
      const tag = theme.includes('Dark') ? 'dark' : 'light';
      await command({ cmd: 'theme', name: theme });
      await sleep(1500);
      await inPage("(d.getElementById('messages').scrollTop = d.getElementById('messages').scrollHeight, true)");
      await sleep(300);
      await shot(`${tag}-1-conversation`);
      if (tag === 'dark') await windowShot('dark-0-window');

      // ---------- account ----------
      const signOutsBefore = fromWebview('signOut').length;
      await click("d.getElementById('account')");
      const account = await inPage(`({
        expanded: d.getElementById('account').getAttribute('aria-expanded'),
        panelVisible: !d.getElementById('accountPanel').classList.contains('hidden'),
        name: d.getElementById('accountName').textContent,
        signOutLabel: d.getElementById('signOut').textContent
      })`);
      await sleep(400);
      check(`${tag}: Account opens the account panel and does not sign out`,
        account.expanded === 'true' && account.panelVisible && account.name === 'synthetic.user@example.test'
        && fromWebview('signOut').length === signOutsBefore && hostEvents('auth.signOut').length === 0, account);
      await shot(`${tag}-2-account`);
      // Where keyboard focus is just before Escape (workbench and page).
      const focusBeforeEscape = await pageEval("(() => { const e = document.activeElement; return e ? (e.tagName + '.' + String(e.className)).slice(0, 80) : null; })()");
      // WP-05 T05-07: which extension's webview holds the workbench focus (an
      // editor's own panel is also a webview frame), and whether Kenlith's
      // page has the keyboard focus at all.
      const focusedFrameOwner = await pageEval("(() => { const e = document.activeElement; const m = e && /extensionId=([^&]+)/.exec(e.getAttribute('src') || ''); return m ? decodeURIComponent(m[1]) : null; })()");
      const pageHasFocus = await inPage("d.hasFocus()");
      const pageFocus = await inPage("d.activeElement ? d.activeElement.id || d.activeElement.tagName : null");
      await press('Escape');
      const closed = await inPage("({ hidden: d.getElementById('accountPanel').classList.contains('hidden'), focus: d.activeElement.id, expanded: d.getElementById('account').getAttribute('aria-expanded') })");
      check(`${tag}: Escape closes the panel and returns focus to Account`, closed.hidden && closed.focus === 'account' && closed.expanded === 'false', { ...closed, focusBeforeEscape, focusedFrameOwner, pageHasFocus, pageFocus });

      // ---------- streaming ----------
      const sendsBefore = fromWebview('send').length;
      const requestsBefore = hostEvents('openai.request').length;
      await focusPrompt();
      await type('Summarise the request budget rules.');
      await press('Enter');
      await waitFor(streaming, 10000);
      // The host reports streaming before it adds the new reply: observe that
      // reply, not the previous one.
      const articlesBefore = SEEDED + 2 * requestsBefore;
      await waitFor(() => inPage(`d.querySelectorAll('#messages article.message').length >= ${articlesBefore + 2}`), 10000);
      await inPage(`(() => {
        const bubble = [...d.querySelectorAll('#messages article.assistant .bubble')].at(-1);
        w.__renders = 0;
        new w.MutationObserver(() => { w.__renders += 1; }).observe(bubble, { childList: true });
        return true;
      })()`);
      const during = await state();
      check(`${tag}: while streaming, Stop shows, Send is disabled, the input stays editable`,
        during.stopVisible && during.sendDisabled && !during.promptDisabled && during.busy === 'true', during);

      await sleep(700);
      await wheel("d.getElementById('messages')", -4000);
      const scrolledAt = await state();
      await sleep(1200);
      const later = await state();
      check(`${tag}: scrolled up during a stream, the view stays where the user put it`,
        later.lastAssistant > scrolledAt.lastAssistant && Math.abs(later.scrollTop - scrolledAt.scrollTop) < 4 && later.distanceFromEnd > 100,
        { before: scrolledAt.scrollTop, after: later.scrollTop, grew: later.lastAssistant - scrolledAt.lastAssistant });
      check(`${tag}: "Jump to latest" appears when new text arrives out of view`, later.jumpVisible);

      await focusPrompt();
      await type('quick: draft typed while streaming');
      await press('Enter');
      await sleep(300);
      const drafted = await state();
      check(`${tag}: a draft typed during the stream is kept, and Enter does not send it`,
        drafted.prompt === 'quick: draft typed while streaming' && fromWebview('send').length === sendsBefore + 1, { prompt: drafted.prompt, sends: fromWebview('send').length - sendsBefore });
      await shot(`${tag}-3-streaming`);

      await click("d.getElementById('jump')");
      await sleep(700);
      const followed = await state();
      check(`${tag}: Jump to latest returns to the end, and the view follows again`, followed.distanceFromEnd <= 48 && !followed.jumpVisible, followed.distanceFromEnd);

      await click("d.getElementById('stop')");
      await waitFor(async () => !(await streaming()), 10000);
      await sleep(500);
      const stopped = await state();
      const deltas = hostEvents('openai.deltas').at(-1)?.count;
      const renders = await inPage('w.__renders');
      check(`${tag}: Stop ends the reply; the partial reply stays; no lost or duplicate messages`,
        fromWebview('stop').length >= 1 && !stopped.stopVisible && !stopped.sendDisabled && stopped.lastAssistant > 0
        && stopped.articles === stopped.uniqueIds && stopped.articles === SEEDED + 2 * hostEvents('openai.request').length,
        { articles: stopped.articles, unique: stopped.uniqueIds, requests: hostEvents('openai.request').length });
      check(`${tag}: streamed text is rendered in batches, not once per token`, deltas > 0 && renders > 0 && renders < deltas / 2, { deltas, renders });
      check(`${tag}: one request per send`, hostEvents('openai.request').length === requestsBefore + 1);

      await focusPrompt();
      await press('Enter');
      await waitFor(async () => (await state()).announcer.startsWith('Response complete.'), 10000);
      const done = await state();
      check(`${tag}: the kept draft sends after the reply; the finished reply is announced`, done.announcer.startsWith('Response complete. Done. Short answer with code.'), done.announcer);

      const failuresBefore = await inPage("(d.getElementById('messages').innerText.match(/Synthetic failure/g) || []).length");
      await focusPrompt();
      await type('please fail now');
      await press('Enter');
      // Wait for the new failure (the alert region may still hold the previous pass's text).
      await waitFor(async () => (await inPage("(d.getElementById('messages').innerText.match(/Synthetic failure/g) || []).length")) > failuresBefore, 10000);
      const failed = await state();
      const inMessages = (await inPage("(d.getElementById('messages').innerText.match(/Synthetic failure/g) || []).length")) - failuresBefore;
      // Slice 2: a failed reply is shown once, in the message; the banner stays empty.
      check(`${tag}: a failed reply is shown once, in the message`, inMessages === 1 && !failed.banner, { newInMessages: inMessages, banner: failed.banner.slice(0, 40) });
      await shot(`${tag}-4-error`);
    }

    // ---------- keyboard focus ----------
    await click("[...d.querySelectorAll('#messages article.user .bubble')].at(-1)", true);
    await inPage("(d.getElementById('history').focus(), true)");
    const visited = [];
    for (let index = 0; index < 60; index += 1) {
      await press('Tab');
      const focused = await inPage(`(() => {
        const e = d.activeElement;
        if (!e || e === d.body) return null;
        const s = w.getComputedStyle(e);
        return { id: e.id || e.className || e.tagName, tag: e.tagName, visible: e.matches(':focus-visible'), outline: s.outlineStyle + ' ' + s.outlineWidth, label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 30) };
      })()`);
      if (!focused) break;
      visited.push(focused);
      if (focused.id === 'send') break;
    }
    const ids = visited.map((item) => item.id);
    const outlined = visited.every((item) => !item.outline.startsWith('none') && !/ 0px$/.test(item.outline));
    check('keyboard: Tab reaches model, Account, conversation, input and Send', ['models', 'account', 'messages', 'prompt', 'send'].every((id) => ids.includes(id)), ids.join(' → '));
    check('keyboard: every focused control shows a visible focus outline', outlined, visited.filter((item) => item.outline.startsWith('none') || / 0px$/.test(item.outline)));
    check('keyboard: every focused control has a name', visited.every((item) => item.label), visited.filter((item) => !item.label));
    await click("d.getElementById('send')").catch(() => undefined);
    await press('Tab', 8);
    await shot('light-5-focus');

    // ---------- copy ----------
    const codeFinder = "[...d.querySelectorAll('#messages .code-block')].find((b) => b.querySelector('pre').textContent.startsWith('await store.addMessage')).querySelector('button.copy')";
    await click(codeFinder, true);
    await waitFor(() => fromWebview('copyText').length > 0, 5000);
    const clipboard = await command({ cmd: 'readClipboard' });
    // The synthetic clipboard (slice 2): the system clipboard is not used.
    const expectedCode = "await store.addMessage('user', text, chatId);";
    check('Copy hands the exact code to the clipboard (synthetic clipboard)', clipboard === expectedCode, clipboard === expectedCode ? expectedCode : '(other text; not shown)');
    await sleep(300);
    check('Copy is announced', (await state()).announcer === 'Copied.');

    // ---------- links go through the editor's own confirmation ----------
    // The editor's own webview link handler listens on the page's window; a
    // click that reaches the window would open the browser without asking.
    await inPage("(w.__reachedWindow = 0, w.addEventListener('click', () => { w.__reachedWindow += 1; }), w.addEventListener('auxclick', () => { w.__reachedWindow += 1; }), true)");
    const linkFinder = "[...d.querySelectorAll('#messages a')].find((a) => a.textContent === 'the design note')";
    await click(linkFinder, true);
    const linkDialog = await waitFor(dialog, 5000);
    check('link click: Kenlith asks first and shows the full address',
      linkDialog && linkDialog.text.includes('Open this link in your browser?') && linkDialog.text.includes('https://example.test/plan-chat-ui-test'), linkDialog);
    if (linkDialog) {
      await windowShot('light-5b-link-prompt');
      await clickDialogButton('Cancel');
      await sleep(500);
    }
    const { x: linkX, y: linkY } = await centerOf(linkFinder, true);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: linkX, y: linkY });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: linkX, y: linkY, button: 'middle', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: linkX, y: linkY, button: 'middle', clickCount: 1 });
    const middleDialog = await waitFor(dialog, 5000);
    check('middle-click on a link: same prompt', middleDialog && middleDialog.text.includes('Open this link in your browser?'), middleDialog);
    if (middleDialog) {
      await clickDialogButton('Cancel');
      await sleep(500);
    }
    check('link clicks never reach the editor\'s own link handler', (await inPage('w.__reachedWindow')) === 0 && fromWebview('openLink').length === 2,
      { reachedWindow: await inPage('w.__reachedWindow'), openLink: fromWebview('openLink').length });

    // ---------- WP-05 T05-05 (R-20): the "earlier messages not included" note in the real webview ----------
    const titleBeforeLong = await inPage("d.getElementById('chatTitle').textContent");
    const seededLong = await command({ cmd: 'seedLongChat' });
    await waitFor(() => inPage("d.getElementById('chatTitle').textContent.startsWith('Long question 1')"), 8000);
    const noteRequestsBefore = hostEvents('openai.request').length;
    await focusPrompt();
    await type('quick question after a long chat');
    await press('Enter');
    await waitFor(() => hostEvents('openai.request').length > noteRequestsBefore, 10000);
    await waitFor(() => inPage("!d.getElementById('contextNote').classList.contains('hidden')"), 8000);
    const note = await inPage("({ text: d.getElementById('contextNote').textContent, hidden: d.getElementById('contextNote').classList.contains('hidden'), role: d.getElementById('contextNote').getAttribute('role') })");
    check('R-20: a request over the history budget shows "earlier messages were not included" in the real webview, as a status', !note.hidden && /^\d+ earlier messages? (was|were) not included, to stay within the request limit\.$/.test(note.text) && note.role === 'status', note);
    await waitFor(async () => !(await streaming()), 15000);
    await shot('light-6b-context-note');
    // Back to the chat the checks below use.
    await command({ cmd: 'openChat', id: seededLong.previousId });
    await waitFor(async () => (await inPage("d.getElementById('chatTitle').textContent")) === titleBeforeLong, 8000);

    // ---------- sign-out: cancel, then confirm ----------
    await click("d.getElementById('account')");
    await click("d.getElementById('signOut')");
    const confirmDialog = await waitFor(dialog, 8000);
    check('Sign Out… asks for confirmation first', confirmDialog && /Sign out of ChatGPT in Kenlith\?/.test(confirmDialog.text), confirmDialog);
    await windowShot('light-6-sign-out-confirmation');
    if (confirmDialog) {
      await clickDialogButton('Cancel');
      await sleep(1200);
      const kept = await inPage("!d.getElementById('accountRow').classList.contains('hidden')");
      check('cancelled sign-out: no sign-out action, still signed in', hostEvents('auth.signOut').length === 0 && kept);

      await click("d.getElementById('account')");
      await click("d.getElementById('signOut')");
      const again = await waitFor(dialog, 8000);
      if (again) {
        await clickDialogButton('Sign Out');
        await waitFor(() => hostEvents('auth.signOut').length > 0, 8000);
        await sleep(800);
        const signedOut = await inPage("!d.getElementById('signIn').closest('#signedOut').classList.contains('hidden')");
        check('confirmed sign-out: the existing sign-out runs once; the view shows sign-in', hostEvents('auth.signOut').length === 1 && signedOut, hostEvents('auth.signOut').length);
        await shot('light-7-signed-out');
      } else {
        check('confirmed sign-out: the existing sign-out runs once; the view shows sign-in', false, 'no dialog');
      }
    }

    // Recorded, not counted as a check (WP-05 T05-11 review): it can only pass.
    console.log(`  NOTE  prompt focus on the first click: ${focusRetries.length ? `retried: ${focusRetries.join(', ')}` : 'no retries'}`);
    check('no network request was attempted from the extension host', hostEvents('blockedFetch').length === 0, hostEvents('blockedFetch'));
    await command({ cmd: 'done' });
  } catch (error) {
    check('run completed', false, String(error?.stack || error));
    try {
      await command({ cmd: 'done' });
    } catch {
      // The editor is closed below.
    }
  } finally {
    web?.close();
    page?.close();
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    if (code === 'timeout') editor.kill();
  }

  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : {};
  const clipboardAfter = clipboardSequence();
  check('the Windows clipboard was not changed during the run (sequence number)', clipboardBefore !== undefined && clipboardBefore === clipboardAfter, { before: clipboardBefore, after: clipboardAfter });
  if (report.errors?.length) check('extension host suite reported no errors', false, report.errors);
  const summary = { label, host: report.host, version: report.version, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  fs.writeFileSync(path.join(shots, `${label}-results.json`), JSON.stringify(summary, null, 2));
  console.log(`[${label}] ${report.host} ${report.version}: ${summary.passed} passed, ${summary.failed} failed`);
  console.log(`Sandbox profile: ${sandbox}`);
  process.exit(summary.failed ? 1 : 0);
}

main();
