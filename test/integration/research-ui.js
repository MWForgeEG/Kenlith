'use strict';

// Kenlith 0.9.0 Deep Research in the real editor: the + menu item, the chip
// above the message box, the composer layout at several widths in Light,
// Dark, High Contrast Dark and High Contrast Light, keyboard use, a research
// run with its progress, citations and Sources (an Arabic answer), Stop and
// Retry, and an unverified model. Throwaway profile, synthetic signed-in
// session, the integration fakes (network disabled): a research request is
// answered by replaying the recorded live run-2 stream
// (test/fixtures-090/live-run2-stream.json); no model request leaves.
//
// Usage: node test/integration/research-ui.js <editor executable> <label> [evidence dir]
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
const evidence = evidenceArg || path.join(__dirname, '..', '..', 'docs', 'release-evidence', 'kenlith-0.9.0', 'research-ui', label);
fs.mkdirSync(evidence, { recursive: true });
const FIXTURE = path.join(__dirname, '..', 'fixtures-090', 'live-run2-stream.json');
const PORT = 9374;
const MODELS = [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }];
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
const frameOf = (page, v) => page.evaluate(`(() => { const f = [...document.querySelectorAll('iframe')].find((i) => i.src && i.src.startsWith(${JSON.stringify(v.frameBase)}) && new URL(i.src).searchParams.get('id') === ${JSON.stringify(v.frameId)}); if (!f) return null; const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()`);
const inChat = (v, expression) => v.web.evaluate(`(() => { const f = document.getElementById('active-frame'); const d = f.contentDocument; const w = f.contentWindow; return (${expression}); })()`);
const hideWelcome = (page) => page.evaluate("(() => { const o = document.querySelector('.antigravity-ide-welcome'); if (o) o.style.display = 'none'; return true; })()").catch(() => undefined);
let currentPage;
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
    for (const c of candidates) if (!found && await frameOf(currentPage, c).catch(() => null)) found = c;
    for (const c of candidates) if (c !== found) c.web.close();
    return Boolean(found);
  }, timeout, 500);
  return found;
}
async function clickIn(page, input, v, selector) {
  await hideWelcome(page);
  const outer = await frameOf(page, v);
  const inner = await v.web.evaluate(`(() => { const f = document.getElementById('active-frame'); const r = f.getBoundingClientRect(); const e = f.contentDocument.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 }; })()`);
  if (!outer || !inner) throw new Error(`cannot click ${selector}`);
  await input.click(outer.x + inner.x, outer.y + inner.y);
}
const retries = [];
async function focusPrompt(page, input, v) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickIn(page, input, v, '#prompt');
    await sleep(500);
    if ((await inChat(v, 'd.activeElement && d.activeElement.id')) === 'prompt') return true;
    retries.push({ step: 'focus message box', attempt });
  }
  return false;
}
async function screenshot(page, name) {
  await hideWelcome(page);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name), Buffer.from(shot.data, 'base64'));
}
const choose = (v, id, value) => inChat(v, `(() => { const s = d.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);

// ---------- colour ----------
function parseColor(text) {
  if (!text) return null;
  let m = /^rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)$/.exec(text.trim());
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
  m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(text.trim());
  if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const over = (fg, bg, alpha = 1) => { const a = (fg.a ?? 1) * alpha; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; };
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };

// The composer with the chip shown: positions, overlaps, colours.
const MEASURE = `(() => {
  const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width || !r.height || e.closest('.hidden')) return null; return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: Math.round(r.width), h: Math.round(r.height) }; };
  const box = vis(d.getElementById('composerBox'));
  const controls = {};
  for (const id of ['researchChip', 'prompt', 'plus', 'models', 'effort', 'stop', 'send']) { const v = vis(d.getElementById(id)); if (v) controls[id] = v; }
  const names = Object.keys(controls);
  const overlaps = [];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    const a = controls[names[i]]; const b = controls[names[j]];
    if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) overlaps.push(names[i] + '/' + names[j]);
  }
  const vw = d.documentElement.clientWidth;
  const clipped = names.filter((n) => { const c = controls[n]; return !box || c.l < box.l - 1 || c.r > box.r + 1 || c.t < box.t - 1 || c.b > box.b + 1 || c.l < 0 || c.r > vw + 1; });
  const bar = [...d.getElementById('composerBar').querySelectorAll('select, button')].filter((e) => vis(e)).map((e) => e.id);
  const barRect = vis(d.getElementById('composerBar'));
  const cs = (e) => w.getComputedStyle(e);
  const chip = d.getElementById('researchChip');
  return {
    vw, overflowX: d.documentElement.scrollWidth - vw, box, controls, overlaps, clipped, bar, barHeight: barRect && barRect.h,
    chipShown: Boolean(vis(chip)), chipAbovePrompt: Boolean(controls.researchChip && controls.prompt && controls.researchChip.b <= controls.prompt.t + 1),
    chipText: chip.textContent.trim(), chipPressed: chip.getAttribute('aria-pressed'), chipFits: chip.scrollWidth <= chip.clientWidth + 2,
    menuChecked: d.getElementById('menuResearch').getAttribute('aria-checked'), placeholder: d.getElementById('prompt').placeholder,
    colors: { page: cs(d.body).backgroundColor, box: cs(d.getElementById('composerBox')).backgroundColor, chipFg: cs(chip).color, chipBorder: cs(chip).borderTopColor }
  };
})()`;
function contrast(m) {
  const c = Object.fromEntries(Object.entries(m.colors).map(([k, v]) => [k, parseColor(v)]));
  if (!c.page) return { ok: false, raw: m.colors };
  const page = c.page.a < 1 ? over(c.page, { r: 0, g: 0, b: 0 }) : c.page;
  const box = c.box && c.box.a > 0 ? over(c.box, page) : page;
  const out = { chipText: ratio(over(c.chipFg, box), box), chipBorder: ratio(over(c.chipBorder, box), box) };
  return { ok: out.chipText >= 4.5 && out.chipBorder >= 3, ...out };
}
// A research answer as drawn: citations, Sources, status, Retry.
const ANSWER = `(() => {
  const article = [...d.querySelectorAll('#messages article.assistant')].at(-1);
  if (!article) return null;
  const cites = [...article.querySelectorAll('a.citation')];
  const sources = article.querySelector('details.sources');
  const vis = (e) => Boolean(e) && e.getBoundingClientRect().height > 0;
  const cs = (e) => w.getComputedStyle(e);
  const first = cites[0];
  const para = first && first.closest('p');
  return {
    status: article.querySelector('.research-status') ? article.querySelector('.research-status').textContent : null,
    meta: article.querySelector('.research-meta') ? article.querySelector('.research-meta').textContent : null,
    cites: cites.length, citeTexts: cites.map((c) => c.textContent), citeHrefs: cites.map((c) => c.getAttribute('href')), citeDirs: cites.map((c) => c.getAttribute('dir')),
    citeLabels: cites.slice(0, 2).map((c) => c.getAttribute('aria-label')),
    citeColor: first ? cs(first).color : null, citeBorder: first ? cs(first).borderTopColor : null, page: cs(d.body).backgroundColor,
    paraDir: para ? cs(para).direction : null,
    // Each paragraph: its direction, and the direction of its first strong
    // letter with the citations left out (the 0.8.0 rule: dir=auto).
    paragraphs: [...article.querySelectorAll('.bubble > p')].map((p) => { const c = p.cloneNode(true); c.querySelectorAll('.citation').forEach((x) => x.remove()); const m = /[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC]|\\p{L}/u.exec(c.textContent); const first = m ? (/[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC]/.test(m[0]) ? 'rtl' : 'ltr') : null; return { dir: cs(p).direction, attr: p.getAttribute('dir'), first, cites: p.querySelectorAll('.citation').length }; }),
    rawLinks: article.querySelectorAll('.bubble a:not(.citation):not(.source-title)').length,
    sourcesSummary: sources ? sources.querySelector('summary').textContent : null,
    sourcesOpen: sources ? sources.open : null,
    sourceItems: sources ? [...sources.querySelectorAll('li')].map((li) => ({ title: li.querySelector('.source-title').textContent, host: li.querySelector('.source-host').textContent, url: li.querySelector('.source-url').textContent, hostDir: li.querySelector('.source-host').getAttribute('dir'), urlDir: li.querySelector('.source-url').getAttribute('dir') })) : [],
    retry: vis(article.querySelector('button[data-research-retry]')),
    notes: [...article.querySelectorAll('.reply-state')].map((n) => n.textContent),
    overflowX: d.documentElement.scrollWidth - d.documentElement.clientWidth
  };
})()`;

let current;
async function main() {
  const top = makeOwnedTempDir('kenlith-dr-');
  const project = path.join(top, 'demo-project');
  fs.mkdirSync(path.join(project, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'notes.js'), '// Synthetic project for the 0.9.0 Deep Research test.\nconst release = "0.9.0";\nmodule.exports = { release };\n');
  const box = await makeSandbox('kenlith-dr-', { 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Dark Modern' });
  const copy = testCopy(box.sandbox, { surface: 'workspace' });
  const read = (name) => { const file = path.join(box.sandbox, `ws-${name}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const write = (name, data = {}) => fs.writeFileSync(path.join(box.sandbox, `ws-${name}.json`), JSON.stringify(data));
  let n = 0;
  const cmd = async (request) => { n += 1; write(`cmd-${n}`, request); await waitFor(() => read(`cmd-${n}-done`), 30000, 200); return read(`cmd-${n}-done`); };
  const run = launch(executable, { developmentPaths: [copy], userData: box.userData, sandbox: box.sandbox, port: PORT, openPaths: [project], env: { PLAN_CHAT_IT_SCENARIO: 'workspace', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_PHASE: 'composer', PLAN_CHAT_IT_KEEP_OPEN: '1', PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort), PLAN_CHAT_IT_MODELS: JSON.stringify(MODELS), PLAN_CHAT_IT_RESEARCH_FIXTURE: FIXTURE } });
  current = run;
  console.log(`[${label}] sandbox ${box.sandbox}`);
  await waitFor(() => read('ready-composer') || read('error-composer'), 120000, 300);
  if (!read('ready-composer')) throw new Error('the composer phase did not start');
  const page = await workbench();
  currentPage = page;
  const input = inputFor(page);
  await hideWelcome(page);
  await sleep(1500);
  await cmd({ command: 'notifications.clearAll', wait: 300 });
  const setWidth = async (width) => { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(1200); await cmd({ command: 'workbench.action.evenEditorWidths', wait: 800 }); };
  const state = () => cmd({ state: true, wait: 600 });

  // ---------- the + menu and the chip (keyboard) ----------
  await setWidth(1600);
  const a = await view('Release notes');
  await focusPrompt(page, input, a);
  await input.press('Tab');
  const onPlus = await inChat(a, 'd.activeElement && d.activeElement.id');
  await input.press('ArrowDown');
  await sleep(400);
  const menu = await inChat(a, "({ open: !d.getElementById('plusMenu').classList.contains('hidden'), focused: d.activeElement && d.activeElement.id, role: d.activeElement && d.activeElement.getAttribute('role'), checked: d.activeElement && d.activeElement.getAttribute('aria-checked'), items: [...d.querySelectorAll('#plusMenu .menu-label')].map((e) => e.textContent.replace('✓', '').trim()) })");
  check('keyboard: Tab to +, ArrowDown opens the menu on "Deep Research" (menuitemcheckbox, not checked), first of four items',
    onPlus === 'plus' && menu.open && menu.focused === 'menuResearch' && menu.role === 'menuitemcheckbox' && menu.checked === 'false' && JSON.stringify(menu.items) === JSON.stringify(['Deep Research', 'Attach selection', 'Project sharing…', 'Project context settings…']), { onPlus, menu });
  await input.press('Escape');
  await sleep(300);
  const afterEscape = await inChat(a, "({ open: !d.getElementById('plusMenu').classList.contains('hidden'), focused: d.activeElement && d.activeElement.id, chip: !d.getElementById('researchRow').classList.contains('hidden') })");
  check('Escape closes the menu, returns focus to +, and turns nothing on', !afterEscape.open && afterEscape.focused === 'plus' && !afterEscape.chip, afterEscape);
  await input.press('ArrowDown');
  await sleep(300);
  await input.press('Enter');
  await sleep(500);
  const on = await inChat(a, MEASURE);
  const onFocus = await inChat(a, "({ focused: d.activeElement && d.activeElement.id, announcer: d.getElementById('announcer').textContent })");
  check('Enter on "Deep Research": the chip appears above the message box (pressed), the item is checked, the placeholder says so, focus is in the message box',
    on.chipShown && on.chipAbovePrompt && on.chipPressed === 'true' && on.menuChecked === 'true' && on.placeholder === 'Ask a research question…' && onFocus.focused === 'prompt' && /Deep Research on/.test(onFocus.announcer), { ...onFocus, chip: on.chipText, placeholder: on.placeholder });
  check('the bar keeps +, model, Thinking and Send in one line; the chip is not in it', JSON.stringify(on.bar) === JSON.stringify(['plus', 'models', 'effort', 'send']) && on.barHeight <= 44, { bar: on.bar, barHeight: on.barHeight });
  // Shift+Tab from the message box reaches the chip; Space turns it off.
  await focusPrompt(page, input, a);
  await input.press('Tab', 'shift');
  const onChip = await inChat(a, 'd.activeElement && d.activeElement.id');
  const ring = await inChat(a, "(() => { const s = w.getComputedStyle(d.getElementById('researchChip')); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, page: w.getComputedStyle(d.body).backgroundColor }; })()");
  const ringRatio = parseColor(ring.color) && parseColor(ring.page) ? ratio(parseColor(ring.color), parseColor(ring.page)) : 0;
  check('the chip is reachable by keyboard and has a visible focus ring (≥ 3:1)', onChip === 'researchChip' && ring.style !== 'none' && ring.width > 0 && ringRatio >= 3, { onChip, ...ring, ringRatio });
  await input.press('Space');
  await sleep(400);
  const off = await inChat(a, MEASURE);
  check('Space on the chip turns Deep Research off: chip hidden, item unchecked, the usual placeholder', !off.chipShown && off.menuChecked === 'false' && off.placeholder === 'Message ChatGPT…', { chip: off.chipShown, checked: off.menuChecked, placeholder: off.placeholder });
  await screenshot(page, 'dark-1600-off.png');

  // ---------- layout and colour with the chip on, every theme and width ----------
  const toggleOn = async (v) => { await clickIn(page, input, v, '#plus'); await sleep(300); await clickIn(page, input, v, '#menuResearch'); await sleep(400); };
  await toggleOn(a);
  a.web.close();
  const h0 = await view('هلا هلا');
  await toggleOn(h0);
  h0.web.close();
  const THEMES = [['dark', 'Default Dark Modern', 2], ['light', 'Default Light Modern', 1], ['hc-dark', 'Default High Contrast', 3], ['hc-light', 'Default High Contrast Light', 4]];
  for (const [tag, theme, kind] of THEMES) {
    const s = await cmd({ theme, wait: 1500 });
    check(`${tag}: the editor uses ${theme}`, s.theme === kind, s.theme);
    for (const width of [1600, 900]) {
      await setWidth(width);
      for (const title of ['Release notes', 'هلا هلا']) {
        const v = await view(title);
        const m = await inChat(v, MEASURE);
        const colors = contrast(m);
        check(`${tag}, ${width}px, "${title}" (${m.vw}px): chip shown above the text, fits; no overlap, nothing clipped, no sideways scroll; chip text ≥ 4.5:1, edge ≥ 3:1`,
          m.chipShown && m.chipAbovePrompt && m.chipFits && !m.overlaps.length && !m.clipped.length && m.overflowX <= 0 && JSON.stringify(m.bar) === JSON.stringify(['plus', 'models', 'effort', 'send']) && colors.ok,
          { overlaps: m.overlaps, clipped: m.clipped, overflowX: m.overflowX, bar: m.bar, box: m.box && [m.box.w, m.box.h], colors });
        v.web.close();
      }
      await screenshot(page, `${tag}-${width}-on.png`);
    }
  }
  await cmd({ theme: 'Default Dark Modern', wait: 1500 });
  await cmd({ command: 'workbench.action.closeSidebar' });
  await setWidth(760);
  {
    const v = await view('Release notes');
    const m = await inChat(v, MEASURE);
    check(`dark, side bar closed, narrow split (${m.vw}px): chip and bar intact`, m.chipShown && m.chipFits && !m.overlaps.length && !m.clipped.length && m.overflowX <= 0, { overlaps: m.overlaps, clipped: m.clipped, vw: m.vw, box: m.box && [m.box.w, m.box.h] });
    v.web.close();
  }
  await screenshot(page, 'dark-760-on.png');
  await cmd({ command: 'workbench.view.extension.planChat' });
  await setWidth(1600);

  // ---------- an unverified model: nothing sent, the verified one offered ----------
  const h = await view('هلا هلا');
  await choose(h, 'models', 'gpt-6.1-sol');
  await sleep(600);
  const before = (await state()).requests.length;
  await focusPrompt(page, input, h);
  await input.type('قارن جداول إصدار Node.js وDeno وBun');
  await input.press('Enter');
  await waitFor(() => inChat(h, "!d.getElementById('errorBanner').classList.contains('hidden')"), 8000, 200).catch(() => undefined);
  const refused = await inChat(h, "({ banner: d.getElementById('errorBanner').textContent, use: d.querySelector('.research-model-action') ? d.querySelector('.research-model-action').textContent : null, prompt: d.getElementById('prompt').value, chip: !d.getElementById('researchRow').classList.contains('hidden') })");
  const afterRefusal = (await state()).requests.length;
  check('a model not verified for Deep Research: nothing sent, the text and the chip come back, "Use GPT-6-Astra" is offered', afterRefusal === before && /verified only with GPT-6-Astra/.test(refused.banner) && refused.use === 'Use GPT-6-Astra' && refused.prompt.includes('Node.js') && refused.chip, { before, afterRefusal, ...refused });
  await screenshot(page, 'dark-unverified-model.png');
  await clickIn(page, input, h, '.research-model-action');
  await sleep(800);
  const switched = await inChat(h, "({ model: d.getElementById('models').value, banner: d.getElementById('errorBanner').classList.contains('hidden'), focused: d.activeElement && d.activeElement.id })");
  check('"Use GPT-6-Astra" selects the model only (no request), closes the notice and returns to the message box', switched.model === 'gpt-6-astra' && switched.banner && switched.focused === 'prompt' && (await state()).requests.length === before, switched);

  // ---------- a research run (Arabic answer from the recorded run) ----------
  await focusPrompt(page, input, h);
  await input.press('Enter');
  const phases = [];
  await waitFor(async () => {
    const s = await inChat(h, ANSWER).catch(() => null);
    if (s?.status && phases.at(-1) !== s.status.split(' · ')[1]) phases.push(s.status.split(' · ')[1]);
    if (s?.status === null && s?.meta) return true;
    return false;
  }, 60000, 150).catch(() => undefined);
  await sleep(1200);
  const done = await inChat(h, ANSWER);
  const after = await state();
  const req = after.requests.at(-1);
  check('Send with Deep Research: the transport gets a research request (web_search, tool_choice required) on GPT-6-Astra; the chip turns off after Send',
    req && req.research === true && JSON.stringify(req.researchTools) === '[{"type":"web_search"}]' && req.researchToolChoice === 'required' && req.model === 'gpt-6-astra' && req.tools === false && !(await inChat(h, MEASURE)).chipShown, req);
  check('progress shows only observed steps, in order: Searching the web, Reading sources, Synthesizing (no percentage)',
    phases.includes('Searching the web…') && phases.includes('Synthesizing…') && phases.indexOf('Searching the web…') < phases.indexOf('Synthesizing…') && phases.every((p) => !/%/.test(p)), phases);
  check('the answer shows 7 clickable citations from the annotations (number and domain, left-to-right), and no raw link text', done.cites === 7 && done.citeHrefs.every((u) => /^https:\/\//.test(u)) && done.citeDirs.every((x) => x === 'ltr') && done.citeTexts[0] === '1nodejs.org' && done.rawLinks === 0, { cites: done.cites, texts: done.citeTexts, labels: done.citeLabels, rawLinks: done.rawLinks });
  check('direction: every paragraph keeps the 0.8.0 rule (dir=auto, first strong letter) with citations left out of it; the Arabic-first paragraph is right to left', done.paragraphs.length >= 4 && done.paragraphs.every((p) => p.attr === 'auto' && p.dir === p.first) && done.paragraphs.some((p) => p.dir === 'rtl'), done.paragraphs);
  const citeColors = { text: ratio(parseColor(done.citeColor), parseColor(done.page)), edge: ratio(parseColor(done.citeBorder), parseColor(done.page)) };
  check('citation text ≥ 4.5:1 and edge ≥ 3:1 on the page', citeColors.text >= 4.5 && citeColors.edge >= 3, citeColors);
  check('a compact, closed "Sources (7)" lists each cited page once with title, domain and address (address and domain left-to-right)', done.sourcesSummary === 'Sources (7)' && done.sourcesOpen === false && done.sourceItems.length === 7 && done.sourceItems.every((s) => s.title && s.host && /^https:\/\//.test(s.url) && s.urlDir === 'ltr' && s.hostDir === 'ltr'), { summary: done.sourcesSummary, items: done.sourceItems.slice(0, 3) });
  check('after the run: "Deep Research · 2 web searches · 3 pages read", no Retry, no extra note', done.meta === 'Deep Research · 2 web searches · 3 pages read' && !done.retry && done.notes.length === 0 && done.overflowX <= 0, { meta: done.meta, retry: done.retry, notes: done.notes });
  check('stored: the reply keeps mode, counts and 7 placed citations, nothing more', after.chats.h.lastReply?.research?.mode === 'deep-research' && after.chats.h.lastReply.research.citations.length === 7 && JSON.stringify(Object.keys(after.chats.h.lastReply.research).sort()) === '["citations","mode","pagesRead","searches"]', after.chats.h.lastReply);
  await clickIn(page, input, h, 'details.sources > summary');
  await sleep(400);
  await screenshot(page, 'dark-research-answer-ar.png');
  for (const [tag, theme] of [['light', 'Default Light Modern'], ['hc-dark', 'Default High Contrast'], ['hc-light', 'Default High Contrast Light']]) {
    await cmd({ theme, wait: 1500 });
    const s = await inChat(h, ANSWER);
    const cc = { text: ratio(parseColor(s.citeColor), parseColor(s.page)), edge: ratio(parseColor(s.citeBorder), parseColor(s.page)) };
    check(`${tag}: citations ≥ 4.5:1 text, ≥ 3:1 edge`, cc.text >= 4.5 && cc.edge >= 3, cc);
    await screenshot(page, `${tag}-research-answer-ar.png`);
  }
  await cmd({ theme: 'Default Dark Modern', wait: 1500 });
  h.web.close();

  // ---------- Stop, then Retry (explicit, sends nothing) ----------
  const r = await view('Release notes');
  await choose(r, 'models', 'gpt-6-astra');
  await sleep(500);
  if (!(await inChat(r, MEASURE)).chipShown) await toggleOn(r);
  const count0 = (await state()).requests.length;
  await focusPrompt(page, input, r);
  await input.type('HANG research the history of the Node.js release schedule');
  await input.press('Enter');
  await waitFor(async () => /Searching the web|Reading sources/.test((await inChat(r, ANSWER))?.status || ''), 15000, 200).catch(() => undefined);
  const running = await inChat(r, "({ status: d.getElementById('replyStatus').textContent, stop: !d.getElementById('stop').classList.contains('hidden') })");
  await focusPrompt(page, input, r);
  await input.press('Escape');
  await waitFor(async () => (await inChat(r, ANSWER))?.retry, 10000, 200).catch(() => undefined);
  const stopped = await inChat(r, ANSWER);
  const afterStop = await state();
  check('while running: "Deep Research is running…" and Stop are shown', /Deep Research is running/.test(running.status) && running.stop, running);
  check('Escape stops the run: the reply says it stopped and did not continue, offers Retry; one request, no retry; stored as stopped',
    stopped.notes.some((t) => /stopped this Deep Research run before it finished\. It did not continue/.test(t)) && stopped.retry && afterStop.requests.length === count0 + 1 && afterStop.chats.a.lastReply.stopped === true && afterStop.chats.a.lastReply.research?.mode === 'deep-research',
    { notes: stopped.notes, retry: stopped.retry, requests: afterStop.requests.length - count0, lastReply: afterStop.chats.a.lastReply });
  await screenshot(page, 'dark-research-stopped.png');
  await inChat(r, "(d.getElementById('prompt').value = '', true)");
  await clickIn(page, input, r, 'button[data-research-retry]');
  await sleep(800);
  const retried = await inChat(r, "({ prompt: d.getElementById('prompt').value, chip: !d.getElementById('researchRow').classList.contains('hidden'), focused: d.activeElement && d.activeElement.id, announcer: d.getElementById('announcer').textContent })");
  const afterRetry = await state();
  check('Retry puts the question back with Deep Research on and sends nothing until Send', retried.prompt.startsWith('HANG research the history') && retried.chip && retried.focused === 'prompt' && afterRetry.requests.length === count0 + 1, { ...retried, requests: afterRetry.requests.length - count0 });

  // ---------- an ordinary message after research: no research fields ----------
  await inChat(r, "(d.getElementById('prompt').value = '', true)");
  await clickIn(page, input, r, '#researchChip');
  await sleep(300);
  await focusPrompt(page, input, r);
  await input.type('An ordinary follow-up message');
  await input.press('Enter');
  await sleep(2500);
  const ordinary = (await state()).requests.at(-1);
  check('with Deep Research off, the next request carries no research (the 0.8.0 request)', ordinary.question.includes('ordinary follow-up') && ordinary.research === false && ordinary.researchTools === null, ordinary);
  r.web.close();

  const reloaded = read('reloaded-composer');
  if (reloaded) results.push({ name: 'note: the editor reloaded its window during the run (its own first-run onboarding); the suite carried on with the same chats', ok: true, detail: reloaded, note: true });
  await page.send('Emulation.clearDeviceMetricsOverride');
  write(`cmd-${n + 1}`, { done: true });
  page.close();
  await Promise.race([run.exited, sleep(15000)]);
  run.child.kill();
  await Promise.race([run.exited, sleep(5000)]);
  await sleep(3000);
  box.close();
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ label, executable: path.basename(executable), results }, null, 2));
  fs.writeFileSync(path.join(evidence, 'retries.json'), JSON.stringify(retries, null, 2));
  const failed = results.filter((result) => !result.ok).length;
  console.log(`[${label}] research: ${results.length - failed} passed, ${failed} failed`);
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
