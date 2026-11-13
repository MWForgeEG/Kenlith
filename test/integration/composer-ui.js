'use strict';

// Kenlith 0.7.0 RC2 editor-tab acceptance (DEC-PLANCHAT-035): the compact
// composer, the + menu, the model selector, the project state, the cards and
// Arabic text, in Light, Dark, High Contrast Dark and High Contrast Light, at
// several editor widths, with the side bar open and closed, beside code and in
// one full-width group. Throwaway profile, synthetic signed-in session, no
// model request (nothing is sent). Cards are shown by posting the extension's
// own card messages into the page (marked "injected" in the evidence): their
// ids are unknown to the extension, so a click on them does nothing.
//
// Usage: node test/integration/composer-ui.js <editor executable> <label> [evidence dir]
//        (PLAN_CHAT_CANDIDATE_VSIX=<vsix> runs a packaged candidate)

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
const evidence = evidenceArg || path.join(__dirname, '..', '..', 'docs', 'release-evidence', 'kenlith-0.7.0', 'composer', label);
fs.mkdirSync(evidence, { recursive: true });
const PORT = 9371;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${new Date().toISOString().slice(11, 19)}  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
};

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
async function workbench() {
  const target = (await targets()).find((item) => item.type === 'page' && /workbench/.test(item.url));
  return Cdp.connect(target.webSocketDebuggerUrl);
}

// Every Kenlith chat page by its title.
async function chatViews() {
  const views = {};
  for (const target of (await targets()).filter((item) => item.url.startsWith('vscode-webview://'))) {
    const web = await Cdp.connect(target.webSocketDebuggerUrl).catch(() => undefined);
    if (!web) continue;
    const title = await Promise.race([web.evaluate("document.getElementById('active-frame')?.contentDocument?.getElementById('chatTitle')?.textContent || null").catch(() => null), sleep(3000).then(() => null)]);
    if (title && !views[title]) views[title] = { web, title, frameBase: target.url.split('?')[0], frameId: new URL(target.url).searchParams.get('id') };
    else web.close();
  }
  return views;
}
// The page of a chat, preferring the one drawn on screen: after its editor
// groups are joined, Antigravity can keep a hidden leftover page for a chat,
// whose scripts never answer.
async function view(title, timeout = 20000) {
  let found;
  await waitFor(async () => {
    const candidates = [];
    for (const target of (await targets()).filter((item) => item.url.startsWith('vscode-webview://'))) {
      const web = await Cdp.connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (!web) continue;
      const shown = await Promise.race([web.evaluate("document.getElementById('active-frame')?.contentDocument?.getElementById('chatTitle')?.textContent || null").catch(() => null), sleep(3000).then(() => null)]);
      if (shown && shown.includes(title)) candidates.push({ web, title: shown, frameBase: target.url.split('?')[0], frameId: new URL(target.url).searchParams.get('id') });
      else web.close();
    }
    for (const c of candidates) {
      if (!found && currentPage && await frameOf(currentPage, c).catch(() => null)) found = c;
    }
    if (!found && candidates.length && !currentPage) found = candidates[0];
    for (const c of candidates) if (c !== found) c.web.close();
    return Boolean(found);
  }, timeout, 500);
  return found;
}
const inChat = (v, expression) => v.web.evaluate(`(() => { const f = document.getElementById('active-frame'); const d = f.contentDocument; const w = f.contentWindow; return (${expression}); })()`);
const frameOf = (page, v) => page.evaluate(`(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(v.frameBase)}) && new URL(i.src).searchParams.get('id') === ${JSON.stringify(v.frameId)}); if (!f) return null; const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
async function clickIn(page, input, v, selector) {
  await hideWelcome(page);
  const outer = await frameOf(page, v);
  const inner = await v.web.evaluate(`(() => { const f = document.getElementById('active-frame'); const r = f.getBoundingClientRect(); const e = f.contentDocument.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 }; })()`);
  if (!outer || !inner) throw new Error(`cannot click ${selector}`);
  await input.click(outer.x + inner.x, outer.y + inner.y);
}
// Antigravity's first-run welcome can come back over the workbench in a new
// profile (seen in this test); it is the editor's, hidden for the test.
const hideWelcome = (page) => page.evaluate("(() => { const o = document.querySelector('.antigravity-ide-welcome'); if (o) o.style.display = 'none'; return true; })()").catch(() => undefined);
// The first key or click after focus moves into a chat page can be taken by
// the editor while it hands focus over; each step checks its precondition
// and tries once more (recorded in retries.json, never hidden).
const retries = [];
let clearNotes = async () => undefined;
async function focusPrompt(page, input, v) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickIn(page, input, v, '#prompt');
    await sleep(500);
    if ((await inChat(v, 'd.activeElement && d.activeElement.id')) === 'prompt') return true;
    retries.push({ step: 'focus message box', attempt });
  }
  return false;
}
async function openMenu(page, input, v) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickIn(page, input, v, '#plus');
    await sleep(400);
    if (await inChat(v, "!d.getElementById('plusMenu').classList.contains('hidden')")) return true;
    retries.push({ step: 'open + menu', attempt });
    // An editor notification (the test profile's "extensions are temporarily
    // disabled") can sit over the + button in the left group.
    await clearNotes();
  }
  return false;
}
async function screenshot(page, name) {
  await hideWelcome(page);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name), Buffer.from(shot.data, 'base64'));
}

// ---------- colour ----------
function parseColor(text) {
  if (!text) return null;
  let m = /^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)$/.exec(text.trim());
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
  m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(text.trim());
  if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const over = (fg, bg, alpha = 1) => {
  const a = (fg.a ?? 1) * alpha;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
};
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };

// What the composer looks like now (inside the chat page).
const MEASURE = `(() => {
  const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width || !r.height || e.closest('.hidden')) return null; return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: Math.round(r.width), h: Math.round(r.height) }; };
  const box = vis(d.getElementById('composerBox'));
  const controls = {};
  for (const id of ['plus', 'models', 'effort', 'stop', 'send']) { const v = vis(d.getElementById(id)); if (v) controls[id] = v; }
  const names = Object.keys(controls);
  const overlaps = [];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    const a = controls[names[i]]; const b = controls[names[j]];
    if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) overlaps.push(names[i] + '/' + names[j]);
  }
  const vw = d.documentElement.clientWidth;
  const clipped = names.filter((n) => { const c = controls[n]; return !box || c.l < box.l - 1 || c.r > box.r + 1 || c.t < box.t - 1 || c.b > box.b + 1 || c.l < 0 || c.r > vw + 1; });
  const models = d.getElementById('models');
  const chip = d.getElementById('panelContext');
  const header = vis(d.querySelector('.header'));
  const cs = (e) => w.getComputedStyle(e);
  const send = d.getElementById('send'); const plus = d.getElementById('plus'); const prompt = d.getElementById('prompt');
  return {
    vw, overflowX: d.documentElement.scrollWidth - vw, box, controls, overlaps, clipped,
    promptH: vis(prompt) ? vis(prompt).h : null, barH: vis(d.getElementById('composerBar')) ? vis(d.getElementById('composerBar')).h : null,
    modelInComposer: Boolean(models.closest('#composerBar')), modelText: models.selectedOptions[0] ? models.selectedOptions[0].textContent : null, modelTitle: models.title,
    modelTextFits: models.scrollWidth <= models.clientWidth + 2 || cs(models).textOverflow === 'ellipsis',
    attachShown: Boolean(vis(d.getElementById('attach'))),
    chip: chip && !chip.classList.contains('hidden') ? chip.querySelector('.project-text').textContent + ' · ' + chip.querySelector('.project-state').textContent : null,
    chipTitle: chip ? chip.title : null,
    headerHeight: header ? header.h : 0,
    colors: {
      page: cs(d.body).backgroundColor, box: cs(d.getElementById('composerBox')).backgroundColor, boxBorder: cs(d.getElementById('composerBox')).borderTopColor,
      sendFg: cs(send).color, sendBg: cs(send).backgroundColor, sendBorder: cs(send).borderTopColor,
      plusFg: cs(plus).color, plusBorder: cs(plus).borderTopColor,
      modelFg: cs(models).color, promptFg: cs(prompt).color,
      chipFg: chip ? cs(chip.querySelector('.project-text')).color : null, chipStateFg: chip ? cs(chip.querySelector('.project-state')).color : null, chipBg: chip ? cs(chip).backgroundColor : null
    }
  };
})()`;

function colorChecks(tag, m) {
  const c = Object.fromEntries(Object.entries(m.colors).map(([k, v]) => [k, parseColor(v)]));
  if (!c.page) return { ok: false, why: 'unreadable colours', raw: m.colors };
  const page = c.page.a < 1 ? over(c.page, { r: 0, g: 0, b: 0 }) : c.page;
  const box = c.box && c.box.a > 0 ? over(c.box, page) : page;
  const sendBg = c.sendBg && c.sendBg.a > 0 ? over(c.sendBg, box) : box;
  const out = {
    sendIcon: ratio(over(c.sendFg, sendBg), sendBg),
    plusIcon: ratio(over(c.plusFg, box), box),
    modelText: ratio(over(c.modelFg, box), box),
    promptText: ratio(over(c.promptFg, box), box),
    boxEdge: ratio(over(c.boxBorder, page), page),
    chipState: c.chipStateFg ? ratio(over(c.chipStateFg, c.chipBg && c.chipBg.a > 0 ? over(c.chipBg, page) : page), c.chipBg && c.chipBg.a > 0 ? over(c.chipBg, page) : page) : null,
    chipText: c.chipFg ? ratio(over(c.chipFg, c.chipBg && c.chipBg.a > 0 ? over(c.chipBg, page) : page), c.chipBg && c.chipBg.a > 0 ? over(c.chipBg, page) : page) : null
  };
  const ok = out.sendIcon >= 3 && out.plusIcon >= 3 && out.modelText >= 4.5 && out.promptText >= 4.5 && out.boxEdge >= 3 && (out.chipText === null || out.chipText >= 4.5) && (out.chipState === null || out.chipState >= 4.5);
  return { ok, ...out };
}

let current;
let currentPage;
async function main() {
  const top = makeOwnedTempDir('kenlith-cmp-');
  const project = path.join(top, 'demo-project');
  fs.mkdirSync(path.join(project, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'notes.js'), '// Synthetic project for the 0.7.0 composer test.\nconst release = "0.7.0";\nmodule.exports = { release };\n');
  const box = await makeSandbox('kenlith-cmp-', { 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Dark Modern' });
  const copy = testCopy(box.sandbox, { surface: 'workspace' });
  const read = (name) => { const file = path.join(box.sandbox, `ws-${name}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const write = (name, data = {}) => fs.writeFileSync(path.join(box.sandbox, `ws-${name}.json`), JSON.stringify(data));
  let n = 0;
  const cmd = async (request) => { n += 1; write(`cmd-${n}`, request); await waitFor(() => read(`cmd-${n}-done`), 30000, 200); return read(`cmd-${n}-done`); };
  const run = launch(executable, { developmentPaths: [copy], userData: box.userData, sandbox: box.sandbox, port: PORT, openPaths: [project], env: { PLAN_CHAT_IT_SCENARIO: 'workspace', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_PHASE: 'composer', PLAN_CHAT_IT_KEEP_OPEN: '1', PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort) } });
  current = run;
  console.log(`[${label}] sandbox ${box.sandbox}`);
  await waitFor(() => read('ready-composer') || read('error-composer'), 120000, 300);
  const ready = read('ready-composer');
  if (!ready) throw new Error('the composer phase did not start');
  let page = await workbench();
  currentPage = page;
  let input = inputFor(page);
  await page.evaluate("(() => { const o = document.querySelector('.antigravity-ide-welcome'); if (o) o.style.display = 'none'; return true; })()");
  await sleep(1500);
  clearNotes = () => cmd({ command: 'notifications.clearAll', wait: 300 });
  await clearNotes();
  const setWidth = async (width) => { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(1200); await cmd({ command: 'workbench.action.evenEditorWidths', wait: 800 }); };

  // Title: the chat title is the tab title, Arabic included.
  const labels = ready.tabs.filter((t) => t.webview).map((t) => t.label);
  check('tab titles are the chat titles (هلا هلا kept as typed)', labels.includes('هلا هلا') && labels.some((l) => l.startsWith('Release notes')), labels);

  // Measures every visible chat page in the current layout.
  async function measureVisible(tag, minimum = 1) {
    try { return await measureOnce(tag, minimum); } catch (error) {
      // The editor reloaded its window under the test: wait, find the pages again.
      results.push({ name: `note: ${tag}: the page was not reachable (${error.message}); measured again after 15 s`, ok: true, note: true });
      await sleep(15000);
      await hideWelcome(page);
      return measureOnce(tag, minimum);
    }
  }
  async function measureOnce(tag, minimum = 1) {
    const views = await chatViews();
    let seen = 0;
    for (const v of Object.values(views)) {
      const frame = await frameOf(page, v);
      if (!frame) { v.web.close(); continue; }
      seen += 1;
      const m = await inChat(v, MEASURE);
      const name = `${tag}: "${v.title}" (${m.vw}px)`;
      check(`${name}: composer compact (box ≤ 120px tall empty, header ≤ 48px), no overlap, nothing clipped, no sideways scroll`, m.box && m.box.h <= 120 && m.headerHeight <= 48 && !m.overlaps.length && !m.clipped.length && m.overflowX <= 0, { box: m.box && [m.box.w, m.box.h], prompt: m.promptH, bar: m.barH, header: m.headerHeight, overlaps: m.overlaps, clipped: m.clipped, overflowX: m.overflowX });
      check(`${name}: model selector in the composer beside Send (its tooltip names the model), + shown, Attach Selection under +`, m.modelInComposer && Boolean(m.controls.models && m.controls.send && m.controls.plus) && !m.attachShown && Boolean(m.modelText) && m.modelTitle === 'Model: ' + m.modelText, { inComposer: m.modelInComposer, attachShown: m.attachShown, model: m.modelText, controls: Object.keys(m.controls) });
      check(`${name}: project state shown compactly ("demo-project · not shared")`, m.chip === 'demo-project · not shared' && /Nothing from it is sent until you allow it/.test(m.chipTitle || ''), { chip: m.chip });
      const colors = colorChecks(tag, m);
      check(`${name}: contrast (Send icon, + icon ≥ 3:1; model, message text ≥ 4.5:1; box edge ≥ 3:1; project text ≥ 4.5:1)`, colors.ok, colors);
      v.web.close();
    }
    check(`${tag}: ${minimum} or more chat pages visible and measured`, seen >= minimum, seen);
  }

  // Cards (injected) in the Arabic chat: complete, isolated, inside the page.
  async function cardsCheck(tag) {
    const h = await view('هلا هلا');
    if (!await frameOf(page, h)) { check(`${tag}: cards: the Arabic chat is visible`, false); h.web.close(); return; }
    const messageId = await inChat(h, "[...d.querySelectorAll('#messages article.assistant')].at(-1)?.dataset.id || null");
    const post = (message) => inChat(h, `(w.postMessage(${JSON.stringify(message)}, '*'), true)`);
    await post({ type: 'command', command: { id: 'injected-1', digest: 'injected', command: 'npm install left-pad', executable: 'C:\\Program Files\\nodejs\\npm.cmd', args: ['install', 'left-pad'], cwd: 'src/app', env: [{ name: 'NODE_ENV', value: 'test' }], timeoutSeconds: 120, effects: ['installs or changes dependencies (network)'], reasons: ['npm install installs or changes dependencies (network)'], purpose: 'ثبّت الحزمة قبل تشغيل الاختبارات' } });
    await post({ type: 'proposals', chatId: ready.ids.h, proposals: [{ id: 'injected-p', messageId, state: 'review', actionable: true, summary: 'غيّر رقم الإصدار إلى 0.7.0', files: [{ relPath: 'src/app/notes.js', addedLines: 1, removedLines: 1 }] }] });
    await sleep(600);
    const shown = await inChat(h, `(() => {
      const vw = d.documentElement.clientWidth;
      const fits = (e) => { if (!e || e.closest('.hidden')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= vw + 1 && e.scrollWidth <= e.clientWidth + 2; };
      const line = d.getElementById('commandLine');
      const facts = [...d.querySelectorAll('#commandFacts li')].map((li) => ({ text: li.textContent, dir: li.querySelector('span').dir }));
      const why = d.querySelector('#commandWhy bdi');
      const review = d.querySelector('.review-card');
      return {
        commandFits: fits(d.getElementById('commandCard')), lineFits: fits(line), lineDir: w.getComputedStyle(line).direction, line: line.textContent,
        facts, whyDir: w.getComputedStyle(why).direction, run: d.getElementById('commandRun').textContent, decline: d.getElementById('commandDecline').textContent,
        reviewFits: fits(review), reviewText: review ? review.textContent.replace(/\\s+/g, ' ').slice(0, 600) : null, summaryDir: review && review.querySelector('bdi') ? w.getComputedStyle(review.querySelector('bdi')).direction : null,
        overflowX: d.documentElement.scrollWidth - vw
      };
    })()`);
    const fact = (name) => shown.facts.find((f) => f.text.startsWith(name + ':'));
    check(`${tag}: command card (injected) in the Arabic chat shows program, arguments, folder, time limit, environment, effect, why; technical values left to right`,
      shown.commandFits && shown.lineFits && shown.lineDir === 'ltr' && /npm\.cmd install left-pad/.test(shown.line)
      && fact('Folder')?.text.includes('src/app') && fact('Folder')?.dir === 'ltr' && fact('Time limit')?.text.includes('120 s') && fact('Environment')?.text.includes('NODE_ENV=test') && fact('Environment')?.dir === 'ltr'
      && /network/.test(fact('Effect')?.text || '') && /network/.test(fact('Why Kenlith asks')?.text || '') && shown.whyDir === 'rtl' && shown.run === 'Run' && shown.decline === "Don't run" && shown.overflowX <= 0, shown);
    check(`${tag}: Review Before Apply card (injected) in the Arabic chat fits, keeps its file name, Arabic summary right to left`, shown.reviewFits && shown.summaryDir === 'rtl' && /src\/app\/notes\.js/.test(shown.reviewText || '') && /Apply/.test(shown.reviewText || ''), { fits: shown.reviewFits, summaryDir: shown.summaryDir, text: shown.reviewText });
    await screenshot(page, `${tag.replace(/[^a-z0-9]+/gi, '-')}-cards.png`);
    await post({ type: 'command', command: null });
    await post({ type: 'consent', consent: { label: 'demo-project', provider: 'OpenAI', account: 'synthetic.user@example.test', excerpts: [{ relPath: 'src/notes.js', startLine: 1, endLine: 2, text: 'const release = "0.7.0";' }], withheld: 0 } });
    await sleep(400);
    const consent = await inChat(h, "(() => { const c = d.getElementById('consentCard'); const vw = d.documentElement.clientWidth; const r = c.getBoundingClientRect(); const name = d.querySelector('#consentList li div'); return { fits: !c.closest('.hidden') && r.right <= vw + 1 && r.left >= -1, allow: d.getElementById('consentAllow').textContent, without: d.getElementById('consentWithout').textContent, nameDir: name ? w.getComputedStyle(name).direction : null }; })()");
    check(`${tag}: sharing card (injected) fits; Allow, Send without project files; file names left to right`, consent.fits && /^Allow for demo-project and send$/.test(consent.allow) && consent.without === 'Send without project files' && consent.nameDir === 'ltr', consent);
    await post({ type: 'consent', consent: null });
    await post({ type: 'proposals', chatId: ready.ids.h, proposals: [] });
    h.web.close();
  }

  // The + menu by keyboard, in the English chat.
  async function menuCheck(tag) {
    const a = await view('Release notes');
    if (!await frameOf(page, a)) { check(`${tag}: menu: the chat is visible`, false); a.web.close(); return; }
    const tabs = [];
    for (let i = 0; i < 2; i += 1) { await focusPrompt(page, input, a); await input.press('Tab'); tabs.push(await inChat(a, "d.activeElement && d.activeElement.id")); if (tabs.at(-1) === 'plus') break; retries.push({ step: 'Tab to +', attempt: i + 1 }); }
    const onPlus = tabs.at(-1);
    const focus = await inChat(a, "(() => { const s = w.getComputedStyle(d.getElementById('plus')); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, box: w.getComputedStyle(d.getElementById('composerBox')).backgroundColor, page: w.getComputedStyle(d.body).backgroundColor }; })()");
    const fc = parseColor(focus.color); const fb = parseColor(focus.box) || parseColor(focus.page);
    const focusRatio = fc && fb ? ratio(fc, fb.a > 0 ? over(fb, parseColor(focus.page)) : parseColor(focus.page)) : 0;
    check(`${tag}: Tab from the message box reaches +, with a visible focus ring (≥ 3:1)`, onPlus === 'plus' && focus.style !== 'none' && focus.width > 0 && focusRatio >= 3, { onPlus, tabs, ...focus, focusRatio });
    await input.press('Enter');
    await sleep(300);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await sleep(200);
    const menu = await inChat(a, "(() => { const m = d.getElementById('plusMenu'); const r = m.getBoundingClientRect(); const vw = d.documentElement.clientWidth; const vh = d.documentElement.clientHeight; const items = [...m.querySelectorAll('[role=menuitem]')]; const cs = (e) => w.getComputedStyle(e); return { open: !m.classList.contains('hidden'), expanded: d.getElementById('plus').getAttribute('aria-expanded'), focused: d.activeElement && d.activeElement.id, labels: items.map((i) => i.querySelector('.menu-label').textContent), inside: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1, fg: cs(items[1]).color, desc: cs(items[1].querySelector('.menu-desc')).color, descOpacity: cs(items[1].querySelector('.menu-desc')).opacity, bg: cs(m).backgroundColor, itemBg: cs(items[1]).backgroundColor, page: cs(d.body).backgroundColor }; })()");
    const menuBg = over(parseColor(menu.bg) || parseColor(menu.page), parseColor(menu.page));
    const ib = parseColor(menu.itemBg);
    const mbg = ib && ib.a > 0 ? over(ib, menuBg) : menuBg;
    const textRatio = ratio(over(parseColor(menu.fg), mbg), mbg);
    const descRatio = ratio(over(parseColor(menu.desc), mbg, Number(menu.descOpacity)), mbg);
    check(`${tag}: Enter opens the + menu with only real actions, focus on the first, inside the page; text ≥ 4.5:1`, menu.open && menu.expanded === 'true' && menu.focused === 'menuAttach'
      && JSON.stringify(menu.labels) === JSON.stringify(['Attach selection', 'Project sharing…', 'Project context settings…']) && menu.inside && textRatio >= 4.5 && descRatio >= 4.5, { ...menu, textRatio, descRatio });
    await input.press('ArrowDown');
    const second = await inChat(a, "d.activeElement && d.activeElement.id");
    await input.press('ArrowUp');
    await input.press('ArrowUp');
    const wrapped = await inChat(a, "d.activeElement && d.activeElement.id");
    await input.press('Escape');
    await sleep(200);
    const closed = await inChat(a, "({ open: !d.getElementById('plusMenu').classList.contains('hidden'), focused: d.activeElement && d.activeElement.id, expanded: d.getElementById('plus').getAttribute('aria-expanded') })");
    check(`${tag}: arrows move through the menu (wrapping); Escape closes it and returns focus to +`, second === 'menuSharing' && wrapped === 'menuSettings' && !closed.open && closed.focused === 'plus' && closed.expanded === 'false', { second, wrapped, closed });
    a.web.close();
  }

  const THEMES = [
    ['dark', 'Default Dark Modern', 2],
    ['light', 'Default Light Modern', 1],
    ['hc-dark', 'Default High Contrast', 3],
    ['hc-light', 'Default High Contrast Light', 4]
  ];
  for (const [tag, theme, kind] of THEMES) {
    const state = await cmd({ theme, wait: 1500 });
    check(`${tag}: the editor uses ${theme}`, state.theme === kind, state.theme);
    await setWidth(1600);
    await measureVisible(`${tag}, two chats side by side, 1600px window`, 2);
    await cardsCheck(`${tag}, 1600px`);
    await menuCheck(`${tag}, 1600px`);
    await screenshot(page, `${tag}-1600.png`);
    await setWidth(900);
    await measureVisible(`${tag}, narrow split, 900px window`, 2);
    await cardsCheck(`${tag}, narrow split`);
    await screenshot(page, `${tag}-900.png`);
  }
  // Dark, two chats side by side: the interactions first (Antigravity can
  // reload its window during the layout changes below; see the note).
  await cmd({ theme: 'Default Dark Modern', wait: 1500 });
  await setWidth(1600);
  await clearNotes();
  // Tab order, the model selector, the menu actions (English chat).
  const a = await view('Release notes');
  await focusPrompt(page, input, a);
  const order = [await inChat(a, 'd.activeElement && d.activeElement.id')];
  // 0.8.0 (DEC-PLANCHAT-040): Thinking follows the model (test/integration/thinking-ui.js).
  for (let i = 0; i < 4; i += 1) { await input.press('Tab'); order.push(await inChat(a, 'd.activeElement && d.activeElement.id')); }
  check('tab order in the composer: message, +, model, Thinking, Send', JSON.stringify(order) === JSON.stringify(['prompt', 'plus', 'models', 'effort', 'send']), order);
  const before = await inChat(a, "d.getElementById('models').value");
  const options = await inChat(a, "[...d.getElementById('models').options].map((o) => o.value)");
  await inChat(a, "(d.getElementById('models').focus(), true)");
  await input.press(options.indexOf(before) < options.length - 1 ? 'ArrowDown' : 'ArrowUp');
  await sleep(600);
  const after = await inChat(a, "d.getElementById('models').value");
  const stored = await cmd({ state: true, wait: 600 });
  check('the model selector in the composer changes this chat\'s model (stored for the chat)', options.length >= 2 && after !== before && stored.chats?.a?.model === after, { before, after, options, stored: stored.chats?.a });
  const prompt = await inChat(a, "(() => { const p = d.getElementById('prompt'); return { h: p.getBoundingClientRect().height }; })()");
  await focusPrompt(page, input, a);
  await input.type('line one\nline two\nline three\nline four');
  await sleep(300);
  const grown = await inChat(a, "(() => { const p = d.getElementById('prompt'); return { h: p.getBoundingClientRect().height, scroll: p.scrollHeight, client: p.clientHeight }; })()");
  check('the message box grows with its text (no resize handle needed)', grown.h > prompt.h && grown.scroll <= grown.client + 4, { before: prompt.h, after: grown });
  await inChat(a, "(() => { const p = d.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  // + Attach selection with no selection in an editor: Kenlith's own notice.
  let attach;
  try {
    const a3 = await view('Release notes');
    if (!await openMenu(page, input, a3)) throw new Error('the + menu did not open');
    await clickIn(page, input, a3, '#menuAttach');
    attach = await waitFor(() => inChat(a3, "(() => { const n = d.getElementById('attachNotice'); const c = d.getElementById('attachCard'); return (!n.classList.contains('hidden') && n.textContent.trim()) || (!c.classList.contains('hidden') && 'card') || null; })()").catch(() => null), 8000, 300);
  } catch (error) {
    attach = null;
    await screenshot(page, 'attach-step.png').catch(() => undefined);
    const now = await cmd({ wait: 300 }).catch(() => ({}));
    const strip = await page.evaluate("[...document.querySelectorAll('.tab')].map((t) => (t.getAttribute('aria-label') || t.innerText).slice(0, 60) + (t.classList.contains('active') ? ' [active]' : ''))").catch(() => null);
    check('+ Attach selection step completed', false, { error: String(error.message || error), tabs: (now.tabs || []).map((t) => `${t.label}@${t.group}${t.active ? '*' : ''}`), strip });
  }
  check('+ Attach selection runs Kenlith\'s attach (with no selection: its notice)', Boolean(attach), attach);
  // + Project context settings opens the editor's Settings.
  const a4 = await view('Release notes');
  await openMenu(page, input, a4);
  await clickIn(page, input, a4, '#menuSettings');
  await sleep(1500);
  const settings = await cmd({ wait: 300 });
  check('+ Project context settings opens the editor\'s Settings', settings.tabs.some((t) => /Settings/.test(t.label)), settings.tabs.map((t) => t.label));
  await screenshot(page, 'dark-settings-opened.png');
  await cmd({ command: 'workbench.action.closeActiveEditor', wait: 800 });
  // + Project sharing: Kenlith's Manage Project Sharing (a list or a message).
  const a2 = await view('Release notes');
  await openMenu(page, input, a2);
  await clickIn(page, input, a2, '#menuSharing');
  const sharing = await waitFor(() => page.evaluate("(() => { const q = document.querySelector('.quick-input-widget'); if (q && q.getBoundingClientRect().height && getComputedStyle(q).display !== 'none') return 'list: ' + (q.querySelector('.quick-input-title')?.innerText || q.innerText.slice(0, 80)); const t = [...document.querySelectorAll('.notification-toast')].find((x) => /shar/i.test(x.innerText)); return t ? 'message: ' + t.innerText.slice(0, 120) : null; })()"), 8000, 300);
  check('+ Project sharing opens Kenlith\'s Manage Project Sharing', Boolean(sharing), sharing);
  await input.press('Escape');
  // Arabic typed in the Arabic chat: right to left; the composer stays intact.
  await cmd({ openChat: 'h', wait: 1500 });
  let h2 = await view('هلا هلا');
  if (!h2) { await sleep(15000); await hideWelcome(page); await cmd({ openChat: 'h', wait: 1500 }); h2 = await view('هلا هلا'); }
  await focusPrompt(page, input, h2);
  await input.type('اكتب ملخص الإصدار من فضلك');
  await sleep(300);
  const ar = await inChat(h2, MEASURE.replace('return {\n    vw,', "return { promptDir: w.getComputedStyle(d.getElementById('prompt')).direction, bubbleDir: (() => { const p = [...d.querySelectorAll('#messages .bubble p')].find((e) => /[\\u0600-\\u06FF]/.test(e.textContent)); return p ? w.getComputedStyle(p).direction : null; })(), codeDir: (() => { const c = d.querySelector('#messages .bubble code'); return c ? w.getComputedStyle(c).direction : null; })(), vw,"));
  check('Arabic: typed text runs right to left; Arabic replies right to left, inline code left to right; the composer has no overlap or clipping', ar.promptDir === 'rtl' && ar.bubbleDir === 'rtl' && ar.codeDir === 'ltr' && !ar.overlaps.length && !ar.clipped.length && ar.overflowX <= 0, { promptDir: ar.promptDir, bubbleDir: ar.bubbleDir, codeDir: ar.codeDir, overlaps: ar.overlaps, clipped: ar.clipped });
  await openMenu(page, input, h2);
  const arMenu = await inChat(h2, "(() => { const m = d.getElementById('plusMenu'); const r = m.getBoundingClientRect(); return { open: !m.classList.contains('hidden'), inside: r.left >= -1 && r.right <= d.documentElement.clientWidth + 1 }; })()");
  check('Arabic chat: the + menu opens inside the page', arMenu.open && arMenu.inside, arMenu);
  await screenshot(page, 'dark-arabic-menu.png');
  await input.press('Escape');

  // Dark: more layouts (measurements only).
  await setWidth(1200);
  await measureVisible('dark, side by side, 1200px window', 2);
  await cmd({ command: 'workbench.action.closeSidebar' });
  await setWidth(1600);
  await measureVisible('dark, side bar closed, 1600px window', 2);
  await setWidth(760);
  await measureVisible('dark, side bar closed, 760px window', 2);
  await screenshot(page, 'dark-sidebar-closed-760.png');
  await cmd({ command: 'workbench.view.extension.planChat' });
  await setWidth(1600);
  await cmd({ openFile: 'src/notes.js', column: 1, wait: 1200 });
  await measureVisible('dark, beside code (notes.js | chat), 1600px window', 1);
  await screenshot(page, 'dark-beside-code.png');
  const joined = await cmd({ command: 'workbench.action.joinAllGroups', wait: 1200 });
  const reopened = await cmd({ openChat: 'a', wait: 1500 });
  const chatTabs = (tabs) => tabs.filter((t) => t.webview).map((t) => `${t.label}@${t.group}`);
  const dupes = (tabs) => { const l = tabs.filter((t) => t.webview).map((t) => t.label); return l.filter((x, i) => l.indexOf(x) !== i); };
  check('layout changes keep one tab per chat (join all groups, then open a chat that is already open)', !dupes(joined.tabs).length && !dupes(reopened.tabs).length, { joined: chatTabs(joined.tabs), reopened: chatTabs(reopened.tabs) });
  await measureVisible('dark, one full-width group, side bar open', 1);
  await cmd({ command: 'workbench.action.closeSidebar' });
  await measureVisible('dark, one full-width group, side bar closed', 1);
  await screenshot(page, 'dark-full-width.png');
  await cmd({ command: 'workbench.view.extension.planChat' });

  // Recorded, not hidden: a window reload by the editor itself during the run.
  const reloaded = read('reloaded-composer');
  if (reloaded) results.push({ name: 'note: the editor reloaded its window during the run (its own first-run onboarding); the suite carried on with the same chats', ok: true, detail: reloaded, note: true });
  await page.send('Emulation.clearDeviceMetricsOverride');
  write(`cmd-${n + 1}`, { done: true });
  page.close();
  await Promise.race([run.exited, sleep(15000)]);
  run.child.kill();
  // Its helper processes let go of the profile shortly after the window.
  await Promise.race([run.exited, sleep(5000)]);
  await sleep(3000);
  box.close();
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ label, executable: path.basename(executable), results }, null, 2));
  fs.writeFileSync(path.join(evidence, 'retries.json'), JSON.stringify(retries, null, 2));
  const failed = results.filter((result) => !result.ok).length;
  console.log(`[${label}] composer: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ label, error: String(error?.stack || error), results }, null, 2));
  try {
    const shot = await Promise.race([currentPage?.send('Page.captureScreenshot', { format: 'png' }), sleep(10000)]);
    if (shot?.data) fs.writeFileSync(path.join(evidence, 'error.png'), Buffer.from(shot.data, 'base64'));
  } catch { /* no page */ }
  try { current?.child.kill(); } catch { /* gone */ }
  process.exit(2);
});
