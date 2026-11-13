'use strict';

// Drives a real editor window over its DevTools port: launch in a throwaway
// profile, find the workbench page and a webview by an element id, and send
// trusted mouse and keyboard input. Node built-ins only (fetch, WebSocket).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { makeOwnedTempDir, removeOwnedTempDir } = require('../../helpers/owned-temp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// A throwaway profile, a stub "browser" that only records the address it is
// given, and a local server that records any request (a real browser that
// opened a test link would show up there).
// `close()` stops the server and leaves the files (some runners read their
// reports after it); `remove()` deletes the folder once the editor has exited.
// Whatever is not removed is removed when the runner exits
// (test/helpers/owned-temp.js; PLAN_CHAT_KEEP_TEMP=1 keeps it).
async function makeSandbox(prefix, settings) {
  const sandbox = makeOwnedTempDir(prefix);
  const server = http.createServer();
  try {
    const userData = path.join(sandbox, 'user-data');
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    const browserLog = path.join(sandbox, 'browser-stub.txt');
    const browserStub = path.join(sandbox, 'browser-stub.cmd');
    fs.writeFileSync(browserStub, `@echo %*>>"${browserLog}"\r\n`);
    const hits = [];
    server.on('request', (request, response) => {
      hits.push(request.url);
      response.end('Plan Chat UI test sink');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'window.dialogStyle': 'custom',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'window.restoreWindows': 'none',
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'extensions.autoUpdate': false,
      'security.workspace.trust.enabled': false,
      'workbench.externalBrowser': browserStub,
      ...settings
    }, null, 2));
    return {
      sandbox,
      userData,
      sinkPort: server.address().port,
      sinkHits: hits,
      browserCalls: () => (fs.existsSync(browserLog) ? fs.readFileSync(browserLog, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []),
      close: () => server.close(),
      remove: () => removeOwnedTempDir(sandbox)
    };
  } catch (error) {
    server.close();
    removeOwnedTempDir(sandbox);
    throw error;
  }
}

// `developmentPaths`: the extensions loaded as development extensions.
// `installed: true` keeps the sandbox's extensions folder enabled (for an
// installed copy); otherwise other extensions are disabled.
// Refuses any profile that is not a throwaway folder under the system temp
// folder, and the real editors' profile folders in particular. Checked before
// every launch, so no test can open the user's own history or credentials.
function assertIsolatedProfile(userData) {
  const resolved = path.resolve(userData).toLowerCase();
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  const appData = path.resolve(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')).toLowerCase();
  const real = ['Code', 'Code - Insiders', 'Antigravity', 'Antigravity IDE'].map((name) => path.join(appData, name).toLowerCase());
  if (!resolved.startsWith(temp + path.sep) || real.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))) {
    throw new Error(`Refusing to launch: ${userData} is not an isolated throwaway profile.`);
  }
  return true;
}

// workspaceTrust (WP-06): keep Workspace Trust on, for Restricted Mode checks.
function launch(executable, { developmentPaths, userData, sandbox, port, env, installed = false, openPaths = [], workspaceTrust = false }) {
  assertIsolatedProfile(userData);
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    ...openPaths,
    ...developmentPaths.map((item) => `--extensionDevelopmentPath=${item}`),
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(sandbox, 'extensions')}`,
    ...(port ? [`--remote-debugging-port=${port}`] : []),
    ...(installed ? [] : ['--disable-extensions']),
    ...(workspaceTrust ? [] : ['--disable-workspace-trust']),
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    // WP-05: keep painting when another window covers the test window (on
    // Windows, Chromium stops drawing occluded windows, and screenshots then
    // time out). Test runs only; the product is not affected.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ], { env: childEnv, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, exited };
}

const listTargets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

// The webview whose inner document has an element with `markerId`, and the
// workbench page whose DOM holds that webview's frame.
async function connect(port, markerId) {
  let web;
  let webTarget;
  await waitFor(async () => {
    for (const target of (await listTargets(port)).filter((item) => item.url.startsWith('vscode-webview://'))) {
      const candidate = await Cdp.connect(target.webSocketDebuggerUrl);
      const found = await candidate.evaluate(`Boolean(document.getElementById('active-frame')?.contentDocument?.getElementById(${JSON.stringify(markerId)}))`).catch(() => false);
      if (found) {
        web = candidate;
        webTarget = target;
        return true;
      }
      candidate.close();
    }
    return false;
  }, 90000, 500);
  if (!web) throw new Error(`no webview with #${markerId}`);
  const frameBase = webTarget.url.split('?')[0];
  let page;
  let pageTarget;
  await waitFor(async () => {
    for (const target of (await listTargets(port)).filter((item) => item.type === 'page')) {
      const candidate = await Cdp.connect(target.webSocketDebuggerUrl);
      const holds = await candidate.evaluate(`[...document.querySelectorAll('iframe')].some((item) => item.src && item.src.startsWith(${JSON.stringify(frameBase)}))`).catch(() => false);
      if (holds) {
        page = candidate;
        pageTarget = target;
        return true;
      }
      candidate.close();
    }
    return false;
  }, 30000, 500);
  if (!page) throw new Error('no workbench page holds the webview');
  return { web, webTarget, page, pageTarget, frameBase };
}

const KEYS = {
  Tab: { code: 'Tab', keyCode: 9 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  P: { code: 'KeyP', keyCode: 80 }
};
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// Trusted input sent to the workbench page; it reaches whatever has focus,
// including an element inside a webview.
function inputFor(page) {
  return {
    async click(x, y, button = 'left') {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
      await sleep(150);
    },
    async drag(from, to) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let step = 1; step <= 10; step += 1) {
        const x = from.x + ((to.x - from.x) * step) / 10;
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: from.y, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: from.y, button: 'left', clickCount: 1 });
      await sleep(400);
    },
    async wheel(x, y, deltaY) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
      await sleep(200);
    },
    async press(name, ...modifiers) {
      const key = KEYS[name];
      const base = { key: key.key || name, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: modifiers.reduce((sum, item) => sum | MODIFIERS[item], 0) };
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (key.text && !base.modifiers) await page.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key.text });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(150);
    },
    type: (text) => page.send('Input.insertText', { text })
  };
}

module.exports = { Cdp, assertIsolatedProfile, connect, inputFor, launch, makeSandbox, sleep, waitFor };
