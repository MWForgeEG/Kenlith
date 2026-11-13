'use strict';

// Kenlith 0.8.0 Thinking effort in the real editor (DEC-PLANCHAT-040): the
// Thinking selector beside the model in the editor-tab composer, in Light,
// Dark, High Contrast Dark and High Contrast Light, at several widths, in an
// English and an Arabic chat, with the page mirrored right to left; keyboard
// order, focus ring, a model without a documented level, and what a Send from
// the page hands to the transport. Throwaway profile, synthetic signed-in
// session, the integration fakes (network disabled): no model request leaves.
// The models offered are one documented slug and one that is not.
//
// Usage: node test/integration/thinking-ui.js <editor executable> <label> [evidence dir]
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
const evidence = evidenceArg || path.join(__dirname, '..', '..', 'docs', 'release-evidence', 'kenlith-0.8.0', 'thinking-ui', label);
fs.mkdirSync(evidence, { recursive: true });
const PORT = 9373;
const MODELS = [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { id: 'gpt-7-preview', name: 'GPT-7 Preview' }];
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
// The visible page of a chat by its title.
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
// Sets the select as a user would (value + change event, as the native list does).
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

// The composer now: positions, overlaps, the Thinking control's state and colours.
const MEASURE = `(() => {
  const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width || !r.height || e.closest('.hidden')) return null; return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: Math.round(r.width), h: Math.round(r.height) }; };
  const box = vis(d.getElementById('composerBox'));
  const controls = {};
  for (const id of ['plus', 'models', 'effortLabel', 'effort', 'stop', 'send']) { const v = vis(d.getElementById(id)); if (v) controls[id] = v; }
  const names = Object.keys(controls);
  const overlaps = [];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    const a = controls[names[i]]; const b = controls[names[j]];
    if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) overlaps.push(names[i] + '/' + names[j]);
  }
  const vw = d.documentElement.clientWidth;
  const clipped = names.filter((n) => { const c = controls[n]; return !box || c.l < box.l - 1 || c.r > box.r + 1 || c.t < box.t - 1 || c.b > box.b + 1 || c.l < 0 || c.r > vw + 1; });
  const effort = d.getElementById('effort');
  const note = d.getElementById('effortNote');
  const label = d.getElementById('effortLabel');
  const cs = (e) => w.getComputedStyle(e);
  const order = [...d.getElementById('composerBar').querySelectorAll('select, button')].filter((e) => vis(e)).map((e) => e.id);
  return {
    vw, overflowX: d.documentElement.scrollWidth - vw, box, controls, overlaps, clipped, order,
    dir: cs(d.body).direction,
    inComposer: Boolean(effort.closest('#composerBar')),
    text: effort.selectedOptions[0] ? effort.selectedOptions[0].textContent : null, value: effort.value, title: effort.title,
    options: [...effort.options].map((o) => o.value), optionTexts: [...effort.options].map((o) => o.textContent),
    textFits: effort.scrollWidth <= effort.clientWidth + 2 || cs(effort).textOverflow === 'ellipsis',
    labelShown: Boolean(vis(label)) && label.getBoundingClientRect().width > 2,
    name: effort.getAttribute('aria-label'),
    note: note.classList.contains('hidden') ? '' : note.textContent,
    noteBox: vis(note),
    narrow: d.body.hasAttribute('data-narrow'),
    colors: { page: cs(d.body).backgroundColor, box: cs(d.getElementById('composerBox')).backgroundColor, effortFg: cs(effort).color, labelFg: cs(label).color, noteFg: cs(note).color }
  };
})()`;
function contrast(m) {
  const c = Object.fromEntries(Object.entries(m.colors).map(([k, v]) => [k, parseColor(v)]));
  if (!c.page) return { ok: false, raw: m.colors };
  const page = c.page.a < 1 ? over(c.page, { r: 0, g: 0, b: 0 }) : c.page;
  const box = c.box && c.box.a > 0 ? over(c.box, page) : page;
  const out = { effortText: ratio(over(c.effortFg, box), box), label: ratio(over(c.labelFg, box), box), note: ratio(over(c.noteFg, box), box) };
  return { ok: out.effortText >= 4.5 && out.label >= 4.5 && out.note >= 4.5, ...out };
}

let current;
async function main() {
  const top = makeOwnedTempDir('kenlith-thk-');
  const project = path.join(top, 'demo-project');
  fs.mkdirSync(path.join(project, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'notes.js'), '// Synthetic project for the 0.8.0 Thinking test.\nconst release = "0.8.0";\nmodule.exports = { release };\n');
  const box = await makeSandbox('kenlith-thk-', { 'window.restoreWindows': 'none', 'workbench.colorTheme': 'Default Dark Modern' });
  const copy = testCopy(box.sandbox, { surface: 'workspace' });
  const read = (name) => { const file = path.join(box.sandbox, `ws-${name}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
  const write = (name, data = {}) => fs.writeFileSync(path.join(box.sandbox, `ws-${name}.json`), JSON.stringify(data));
  let n = 0;
  const cmd = async (request) => { n += 1; write(`cmd-${n}`, request); await waitFor(() => read(`cmd-${n}-done`), 30000, 200); return read(`cmd-${n}-done`); };
  const run = launch(executable, { developmentPaths: [copy], userData: box.userData, sandbox: box.sandbox, port: PORT, openPaths: [project], env: { PLAN_CHAT_IT_SCENARIO: 'workspace', PLAN_CHAT_IT_UI_DIR: box.sandbox, PLAN_CHAT_IT_PHASE: 'composer', PLAN_CHAT_IT_KEEP_OPEN: '1', PLAN_CHAT_IT_SINK_PORT: String(box.sinkPort), PLAN_CHAT_IT_MODELS: JSON.stringify(MODELS) } });
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

  async function measure(tag, title, expect) {
    const v = await view(title);
    const m = await inChat(v, MEASURE);
    const name = `${tag}: "${v.title}" (${m.vw}px)`;
    check(`${name}: Thinking is in the composer after the model and before Send; composer compact (box ≤ 120px tall empty); no overlap, nothing clipped, no sideways scroll`,
      m.inComposer && m.box && m.box.h <= 120 && m.order.indexOf('models') >= 0 && m.order.indexOf('models') < m.order.indexOf('effort') && m.order.indexOf('effort') < m.order.indexOf('send') && !m.overlaps.length && !m.clipped.length && m.overflowX <= 0,
      { order: m.order, overlaps: m.overlaps, clipped: m.clipped, overflowX: m.overflowX, box: m.box && [m.box.w, m.box.h] });
    check(`${name}: shows "${expect.text}", named "Thinking", tooltip with the description; word Thinking ${expect.label ? 'shown' : 'hidden (narrow)'}`,
      m.text === expect.text && m.name === 'Thinking' && m.title.startsWith('Thinking: ') && m.labelShown === expect.label && m.textFits, { text: m.text, title: m.title, label: m.labelShown, narrow: m.narrow, fits: m.textFits });
    const colors = contrast(m);
    check(`${name}: contrast of the level, the word Thinking and the note ≥ 4.5:1`, colors.ok, colors);
    v.web.close();
    return m;
  }

  // English chat at High (Extra High where the short label is checked).
  const a0 = await view('Release notes');
  await choose(a0, 'effort', 'xhigh');
  a0.web.close();
  const THEMES = [['dark', 'Default Dark Modern', 2], ['light', 'Default Light Modern', 1], ['hc-dark', 'Default High Contrast', 3], ['hc-light', 'Default High Contrast Light', 4]];
  for (const [tag, theme, kind] of THEMES) {
    const state = await cmd({ theme, wait: 1500 });
    check(`${tag}: the editor uses ${theme}`, state.theme === kind, state.theme);
    await setWidth(1600);
    await measure(`${tag}, 1600px, two chats side by side`, 'Release notes', { text: 'Extra High', label: true });
    await measure(`${tag}, 1600px, two chats side by side`, 'هلا هلا', { text: 'Default', label: true });
    await screenshot(page, `${tag}-1600.png`);
    await setWidth(900);
    await measure(`${tag}, 900px, narrow split`, 'Release notes', { text: 'XHigh', label: false });
    await measure(`${tag}, 900px, narrow split`, 'هلا هلا', { text: 'Default', label: false });
    await screenshot(page, `${tag}-900.png`);
  }
  await cmd({ theme: 'Default Dark Modern', wait: 1500 });
  await cmd({ command: 'workbench.action.closeSidebar' });
  await setWidth(760);
  await measure('dark, side bar closed, 760px', 'Release notes', { text: 'XHigh', label: false });
  await screenshot(page, 'dark-760.png');
  await cmd({ command: 'workbench.view.extension.planChat' });
  await setWidth(1600);

  // The page mirrored right to left (logical CSS): the controls stay intact.
  const r = await view('هلا هلا');
  await inChat(r, "(d.documentElement.dir = 'rtl', true)");
  await sleep(300);
  const rtl = await inChat(r, MEASURE);
  check('right to left (page mirrored): Thinking still between the model and Send, no overlap or clipping', rtl.dir === 'rtl' && !rtl.overlaps.length && !rtl.clipped.length && rtl.overflowX <= 0 && rtl.controls.effort && rtl.controls.models && rtl.controls.effort.r <= rtl.controls.models.l + 0.5,
    { dir: rtl.dir, overlaps: rtl.overlaps, clipped: rtl.clipped, effort: rtl.controls.effort, models: rtl.controls.models });
  await screenshot(page, 'dark-rtl.png');
  await inChat(r, "(d.documentElement.dir = '', true)");
  r.web.close();

  // Keyboard: Tab order, focus ring, arrows change the level, Escape harmless.
  const a = await view('Release notes');
  await focusPrompt(page, input, a);
  const order = [await inChat(a, 'd.activeElement && d.activeElement.id')];
  for (let i = 0; i < 4; i += 1) { await input.press('Tab'); order.push(await inChat(a, 'd.activeElement && d.activeElement.id')); }
  check('tab order: message, +, model, Thinking, Send', JSON.stringify(order) === JSON.stringify(['prompt', 'plus', 'models', 'effort', 'send']), order);
  await input.press('Tab', 'shift');
  const onEffort = await inChat(a, 'd.activeElement && d.activeElement.id');
  const ring = await inChat(a, "(() => { const s = w.getComputedStyle(d.getElementById('effort')); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, box: w.getComputedStyle(d.getElementById('composerBox')).backgroundColor, page: w.getComputedStyle(d.body).backgroundColor }; })()");
  const rc = parseColor(ring.color); const rb = parseColor(ring.box) || parseColor(ring.page);
  const ringRatio = rc && rb ? ratio(rc, rb.a > 0 ? over(rb, parseColor(ring.page)) : parseColor(ring.page)) : 0;
  check('Thinking has a visible focus ring (≥ 3:1)', onEffort === 'effort' && ring.style !== 'none' && ring.width > 0 && ringRatio >= 3, { onEffort, ...ring, ringRatio });
  const before = await inChat(a, "d.getElementById('effort').value");
  await input.press('ArrowUp');
  await sleep(600);
  const after = await inChat(a, "d.getElementById('effort').value");
  await input.press('Escape');
  await sleep(300);
  const afterEscape = await inChat(a, "({ value: d.getElementById('effort').value, focused: d.activeElement && d.activeElement.id, prompt: d.getElementById('prompt').value })");
  let stored = await cmd({ state: true, wait: 600 });
  check('arrows change the level and it is stored for this chat; Escape changes nothing', before === 'xhigh' && after === 'high' && afterEscape.value === 'high' && stored.chats?.a?.reasoningEffort === 'high', { before, after, afterEscape, stored: stored.chats?.a });

  // A model without a documented level: Default only, with the short note; back again.
  await choose(a, 'models', 'gpt-7-preview');
  await sleep(800);
  const unknown = await inChat(a, MEASURE);
  check('a model without a documented level: only Default, the note "This model uses its default thinking level."; the chat keeps its saved level',
    JSON.stringify(unknown.options) === '["default"]' && unknown.text === 'Default' && unknown.note === 'This model uses its default thinking level.' && !unknown.overlaps.length && unknown.overflowX <= 0,
    { options: unknown.options, text: unknown.text, note: unknown.note });
  await screenshot(page, 'dark-unknown-model.png');
  stored = await cmd({ state: true, wait: 600 });
  check('…the saved level is unchanged by the model switch', stored.chats?.a?.reasoningEffort === 'high', stored.chats?.a);
  await choose(a, 'models', 'gpt-6.1-sol');
  await sleep(800);
  const back = await inChat(a, MEASURE);
  check('back on the documented model: High again, all six levels, no note', back.value === 'high' && JSON.stringify(back.options) === JSON.stringify(['default', 'low', 'medium', 'high', 'xhigh', 'max']) && back.note === '' && JSON.stringify(back.optionTexts) === JSON.stringify(['Default', 'Low', 'Medium', 'High', 'Extra High', 'Max']), { value: back.value, options: back.optionTexts, note: back.note });

  // Send from the page: the transport (a fake; network disabled) gets the level
  // shown. The open project asks first (the sharing card, unchanged): Send
  // without project files, so the level also goes through the card's path.
  const steps = [];
  const snap = (tag) => inChat(a, "({ card: !d.getElementById('consentCard').classList.contains('hidden'), prompt: d.getElementById('prompt').value, focused: d.activeElement && d.activeElement.id, announcer: d.getElementById('announcer').textContent })").then((s) => steps.push({ tag, ...s }));
  const sendWithout = async (text) => {
    await focusPrompt(page, input, a);
    await input.type(text);
    await snap(`typed "${text}"`);
    // The first key after focus moves into the page can be taken by the
    // editor (see focusPrompt); Enter is tried again, and recorded.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await focusPrompt(page, input, a);
      await input.press('Enter');
      const taken = await waitFor(() => inChat(a, "!d.getElementById('consentCard').classList.contains('hidden') || !d.getElementById('prompt').value"), 4000, 200).then(() => true, () => false);
      await snap(`Enter ${attempt}`);
      if (taken) break;
      retries.push({ step: `Enter sends "${text}"`, attempt });
    }
    // The page clears the box at once; the card follows when the host has
    // looked through the project.
    const card = await waitFor(() => inChat(a, "!d.getElementById('consentCard').classList.contains('hidden')"), 8000, 200).then(() => true, () => false);
    if (card) { await sleep(300); await clickIn(page, input, a, '#consentWithout'); }
    await sleep(2500);
    await snap('after the card');
  };
  await sendWithout('Thinking check one quick');
  await choose(a, 'effort', 'default');
  await sleep(500);
  await sendWithout('Thinking check two quick');
  stored = await cmd({ state: true, wait: 600 });
  const sent = (stored.requests || []).filter((entry) => /Thinking check/.test(entry.question));
  const pageState = await inChat(a, "({ stop: !d.getElementById('stop').classList.contains('hidden'), articles: d.querySelectorAll('#messages article').length, announcer: d.getElementById('announcer').textContent, alerts: d.getElementById('alerts').textContent, banner: d.getElementById('errorBanner').textContent, note: d.getElementById('contextNote').textContent, notice: d.getElementById('notice').textContent, consent: !d.getElementById('consentCard').classList.contains('hidden'), prompt: d.getElementById('prompt').value, messages: [...d.querySelectorAll('#messages article')].slice(-4).map((e) => e.textContent.slice(0, 120)) })");
  check('Send hands the transport the level shown: High, then Default (none); no request left the test (network disabled)',
    sent.length === 2 && sent[0].effort === 'high' && sent[1].effort === null && sent.every((entry) => entry.model === 'gpt-6.1-sol'), { sent, all: stored.requests, page: pageState, steps });
  a.web.close();

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
  console.log(`[${label}] thinking: ${results.length - failed} passed, ${failed} failed`);
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
