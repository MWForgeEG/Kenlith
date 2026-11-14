'use strict';

// Kenlith 0.6.0: the Kenlith editor tab icon and the Activity Bar icon as the
// editor draws them, in Light, Dark, High Contrast Dark and High Contrast
// Light themes. Throwaway profiles (signed out, one empty chat); nothing is
// typed or sent. For each theme it records which icon file the editor chose
// for the tab, and measures the drawn pixels: the most common colour of the
// icon area is the background, the colour farthest from it is the icon, and
// their WCAG contrast ratio is reported. Screenshots are clipped to the tab
// strip and the Activity Bar (no chat content, no account).
//
// Usage: node test/integration/editor-icon.js <editor exe> <label> <out dir> [candidate.vsix]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Cdp, makeSandbox, sleep, waitFor } = require('./lib/editor-driver');
const { extractExtension } = require('./lib/candidate');

const [executable, label = 'editor', outArg, vsix] = process.argv.slice(2);
if (!executable || !fs.existsSync(executable) || !outArg) {
  console.error('Usage: editor-icon.js <editor exe> <label> <out dir> [candidate.vsix]');
  process.exit(2);
}
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const repo = path.resolve(__dirname, '..', '..');
const THEMES = [
  { name: 'light', id: 'Default Light Modern', kind: 'vs', expect: 'chat-tab.svg' },
  { name: 'dark', id: 'Default Dark Modern', kind: 'vs-dark', expect: 'chat-tab.svg' },
  { name: 'hc-dark', id: 'Default High Contrast', kind: 'hc-black', expect: 'chat-tab.svg' },
  { name: 'hc-light', id: 'Default High Contrast Light', kind: 'hc-light', expect: 'chat-tab.svg' }
];
// Non-text UI parts need 3:1 (WCAG 1.4.11).
const MIN_CONTRAST = 3;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 400)}`}`);
};

// Runs in the workbench page: decodes a PNG (base64) and measures it.
const MEASURE = `(async (data) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + data;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const counts = new Map();
  for (let i = 0; i < px.length; i += 4) { const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const rgb = (k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
  const lum = ([r, g2, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g2) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  let best = bg, bestRatio = 1, strong = 0;
  for (const [k, n] of counts) { const r = ratio(rgb(k), rgb(bg)); if (r > bestRatio) { bestRatio = r; best = k; } if (r >= 3) strong += n; }
  const hex = (k) => '#' + k.toString(16).padStart(6, '0');
  // 0.9.0: pixels close to the brand colours of the refined tab icon (Deep Forest tile, lighter Signal Mint rings, green rim; DEC-PLANCHAT-042; 0.7.0 used #7FD8A4 rings).
  const near = (k, target) => { const a = rgb(k), b = rgb(target); return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 24; };
  let tile = 0, rings = 0, rim = 0;
  for (const [k, n] of counts) { if (near(k, 0x103d32)) tile += n; if (near(k, 0xb4f0cd)) rings += n; if (near(k, 0x2fa36b)) rim += n; }
  return { background: hex(bg), icon: hex(best), contrast: Math.round(bestRatio * 100) / 100, strongPixels: strong, tilePixels: tile, ringPixels: rings, rimPixels: rim, ringsOnTile: Math.round(ratio(rgb(0xb4f0cd), rgb(0x103d32)) * 100) / 100, size: [c.width, c.height] };
})`;

async function themeRun(theme) {
  const box = await makeSandbox(`kenlith-icon-${theme.name}-`, { 'workbench.colorTheme': theme.id, 'window.autoDetectColorScheme': false, 'workbench.startupEditor': 'none' });
  const dir = path.join(box.sandbox, 'handover');
  fs.mkdirSync(dir, { recursive: true });
  let development = repo;
  if (vsix) development = extractExtension(path.resolve(vsix), path.join(box.sandbox, 'candidate'));
  const port = 9300 + Math.floor(Math.random() * 400);
  const env = { ...process.env, KENLITH_ICON_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--extensionDevelopmentPath=${development}`,
    `--extensionTestsPath=${path.join(__dirname, 'suite', 'editor-icon-host.js')}`,
    `--user-data-dir=${box.userData}`,
    `--extensions-dir=${path.join(box.sandbox, 'extensions')}`,
    `--remote-debugging-port=${port}`,
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'
  ], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const ready = await waitFor(() => fs.existsSync(path.join(dir, 'ready.json')) || fs.existsSync(path.join(dir, 'error.json')), 90000, 300);
    if (!ready || fs.existsSync(path.join(dir, 'error.json'))) {
      check(`${theme.name}: the chat tab opened`, false, fs.existsSync(path.join(dir, 'error.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'error.json'), 'utf8')) : 'timeout');
      return;
    }
    const host = JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8'));
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = await Cdp.connect(targets.find((t) => t.type === 'page' && /workbench/.test(t.url)).webSocketDebuggerUrl);
    await sleep(1500);
    const info = await page.evaluate(`(() => {
      const wb = document.querySelector('.monaco-workbench');
      const kind = ['hc-light', 'hc-black', 'vs-dark', 'vs'].find((k) => wb && wb.classList.contains(k));
      const tab = [...document.querySelectorAll('.tabs-container .tab')].find((t) => /New chat/.test(t.getAttribute('aria-label') || t.innerText));
      // The tab's own icon element (iconPath of a webview panel).
      const iconEl = tab && tab.querySelector('.monaco-icon-label-iconpath');
      const ir = iconEl && iconEl.getBoundingClientRect();
      const tr = tab && tab.getBoundingClientRect();
      const act = [...document.querySelectorAll('.activitybar .action-item')].find((a) => /Kenlith/.test(a.querySelector('.action-label')?.getAttribute('aria-label') || a.getAttribute('aria-label') || ''));
      const ar = act && act.querySelector('.action-label').getBoundingClientRect();
      const strip = document.querySelector('.tabs-container');
      const sr = strip && strip.getBoundingClientRect();
      const bar = document.querySelector('.activitybar');
      const br = bar && bar.getBoundingClientRect();
      const title = document.querySelector('.part.sidebar .title-label');
      return {
        kind,
        tabIconImage: iconEl ? getComputedStyle(iconEl).backgroundImage : null,
        icon: ir && { x: ir.left, y: ir.top, w: ir.width, h: ir.height },
        tab: tr && { x: tr.left, y: tr.top, w: tr.width, h: tr.height },
        activity: ar && { x: ar.left, y: ar.top, w: ar.width, h: ar.height },
        strip: sr && { x: sr.left, y: sr.top, w: Math.min(sr.width, 420), h: sr.height },
        bar: br && { x: br.left, y: br.top, w: br.width, h: Math.min(br.height, 420) },
        sidebarTitle: title ? title.textContent.trim() : null
      };
    })()`);
    check(`${theme.name}: the editor uses the ${theme.id} theme (${theme.kind})`, info.kind === theme.kind, { kind: info.kind, host: host.theme });
    check(`${theme.name}: a Kenlith chat tab with its icon is open`, Boolean(info.tab && info.icon), host.tabs);
    if (!info.tab || !info.icon) return;
    check(`${theme.name}: the tab icon is ${theme.expect}`, String(info.tabIconImage || '').includes(theme.expect), info.tabIconImage);
    const shot = async (clip, scale = 1) => (await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale } })).data;
    // Only the icon element's own box: no tab border or text.
    const tabIcon = await shot({ x: info.icon.x, y: info.icon.y, width: info.icon.w, height: info.icon.h }, 2);
    const tabMeasure = await page.evaluate(`${MEASURE}(${JSON.stringify(tabIcon)})`);
    check(`${theme.name}: the drawn tab icon stands out from the tab (contrast ≥ ${MIN_CONTRAST}:1)`, tabMeasure.contrast >= MIN_CONTRAST && tabMeasure.strongPixels >= 20, tabMeasure);
    // DEC-PLANCHAT-033: the coloured Signal Rings, both brand colours drawn.
    check(`${theme.name}: the drawn tab icon is the coloured Signal Rings (Deep Forest tile and green Signal Mint rings both drawn; rings on tile ${tabMeasure.ringsOnTile}:1)`, tabMeasure.tilePixels >= 40 && tabMeasure.ringPixels >= 20 && tabMeasure.ringsOnTile >= 3, { tile: tabMeasure.tilePixels, rings: tabMeasure.ringPixels, rim: tabMeasure.rimPixels });
    if (info.activity) {
      const actIcon = await shot({ x: info.activity.x, y: info.activity.y, width: info.activity.w, height: info.activity.h }, 2);
      const actMeasure = await page.evaluate(`${MEASURE}(${JSON.stringify(actIcon)})`);
      check(`${theme.name}: the Activity Bar icon stands out (contrast ≥ ${MIN_CONTRAST}:1)`, actMeasure.contrast >= MIN_CONTRAST && actMeasure.strongPixels >= 20, actMeasure);
    } else {
      check(`${theme.name}: the Activity Bar shows Kenlith`, false, 'no Kenlith activity item');
    }
    check(`${theme.name}: the side bar title is Kenlith`, /kenlith/i.test(info.sidebarTitle || ''), info.sidebarTitle);
    fs.writeFileSync(path.join(out, `${label}-${theme.name}-tabs.png`), Buffer.from(await shot({ x: info.strip.x, y: info.strip.y, width: info.strip.w, height: info.strip.h }, 2), 'base64'));
    fs.writeFileSync(path.join(out, `${label}-${theme.name}-activitybar.png`), Buffer.from(await shot({ x: info.bar.x, y: info.bar.y, width: info.bar.w, height: info.bar.h }, 2), 'base64'));
    page.close();
  } finally {
    fs.writeFileSync(path.join(dir, 'done.json'), '{}');
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    if (code === 'timeout') child.kill();
    box.close?.();
  }
}

(async () => {
  for (const theme of THEMES) await themeRun(theme);
  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(path.join(out, `${label}-results.json`), JSON.stringify({ label, candidate: vsix ? path.basename(vsix) : 'source', results }, null, 2));
  console.log(`[${label}] editor icon: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
