'use strict';

// The chat webview (0.4.0): the HTML, styles and script of a chat surface,
// shown in an editor tab (src/panels.js) or, for tests, a webview view. The
// host side of a chat is src/engine.js; nothing here sends or stores.

const fs = require('fs');
const path = require('path');
const { randomToken } = require('./util');

// "just now", "5 minutes ago", "yesterday", "3 weeks ago" for a stored ISO
// time; empty when the time is missing or unreadable.
function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const units = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
  const [unit, size] = units.find(([, length]) => Math.abs(seconds) >= length) || units.at(-1);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}

// The line under a project-derived reply: only what is true of that reply
// (0.5.0 RC5). Inlined into the webview below; no backticks or template
// placeholders in it. `projectShared` is written when a reply ends (0.5.0
// RC5, src/engine.js); a reply stored without it is older, and then a reply
// with no excerpts was one that replayed earlier answers based on project
// files (0.3.0 to 0.4.1). '' means no label.
function projectFooterLabel(item) {
  const used = Array.isArray(item.contextUsed) ? item.contextUsed : [];
  if (used.length) return 'Used ' + used.length + ' project ' + (used.length === 1 ? 'excerpt' : 'excerpts');
  const shared = item.projectShared;
  if (!shared || typeof shared !== 'object') return 'Based on earlier answers that used project files';
  if (Number(shared.toolResults) > 0) return 'Based on project information shared for this reply';
  if (shared.earlierAnswers === true) return 'Based on earlier answers that used project information';
  return '';
}

// Inlined into the webview under the page nonce (see src/markdown.js).
let markdownSource;
function markdownScript() {
  if (markdownSource === undefined) {
    const source = fs.readFileSync(path.join(__dirname, 'markdown.js'), 'utf8');
    if (/<\/script/i.test(source)) {
      throw new Error('src/markdown.js must not contain a closing script tag.');
    }
    markdownSource = source;
  }
  return markdownSource;
}

// `mode`: 'panel' for an editor tab (0.4.0), 'view' for the side bar layout.
function getWebviewHtml(webview, { mode = 'view' } = {}) {
  const pageMode = mode === 'panel' ? 'panel' : 'view';
  const nonce = randomToken(18);
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    "font-src 'none'"
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kenlith</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      /* Edges of the input, model selector and history button. The default
         themes' input and dropdown borders measure 1.5:1 against the sidebar;
         this mix of the theme's own foreground and background reaches at
         least 3:1 in Dark and Light Modern. High Contrast themes keep their
         contrastBorder. */
      --field-border: var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 60%, var(--vscode-sideBar-background)));
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 13px/1.45 var(--vscode-font-family);
      height: 100vh;
      overflow: hidden;
    }
    button, select, textarea { font: inherit; }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 5px;
      padding: 7px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled { opacity: .55; cursor: default; }
    :focus { outline: none; }
    :focus-visible,
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    textarea:focus { outline-offset: -1px; }
    /* minmax(0, 1fr): a long code line scrolls inside its block instead of
       widening the whole view (it pushed Account and Send out of a narrow sidebar). */
    #app { display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: minmax(0, 1fr); height: 100vh; }
    .header {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-line { display: flex; align-items: center; gap: 8px; }
    .status-line { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .history {
      display: flex;
      align-items: center;
      gap: 6px;
      /* Takes the row's remaining width after the context indicator. */
      flex: 1 1 0;
      min-width: 0;
      padding: 5px 7px;
      text-align: start;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--field-border);
      border-radius: 4px;
    }
    .history:hover { background: var(--vscode-dropdown-background); border-color: var(--vscode-focusBorder); }
    .chat-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chevron { flex: none; }
    /* The window's context: a project folder or General (stage 2). */
    .project-chip {
      /* Keeps its natural width (up to half the row since 0.5.0, which adds
         the sharing state), so "General" or a short folder name is not cut. */
      flex: 0 0 auto;
      max-width: 50%;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-badge-background, var(--vscode-button-secondaryBackground));
      border: 1px solid var(--field-border);
    }
    .project-chip .project-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    /* 0.5.0: the sharing state gives way before the project name does (its
       full wording is in the tooltip and the accessible name). */
    .project-chip .project-state { flex: 0 100 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .project-chip .project-text { flex: 0 1 auto; }
    .project-chip .project-state:not(:empty)::before { content: "·"; margin-inline: 4px; }
    button.project-chip { cursor: pointer; }
    button.project-chip:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-badge-background, var(--vscode-button-secondaryBackground)); }
    .notice { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .readonly-bar {
      display: grid;
      gap: 6px;
      padding: 7px 9px;
      border: 1px solid var(--field-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      font-size: 12px;
    }
    .readonly-bar .row { display: flex; flex-wrap: wrap; gap: 6px; }
    .readonly-bar button { padding: 3px 9px; }
    .error-note {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-inputValidation-errorBorder);
      font-size: 12px;
    }
    select {
      min-width: 0;
      flex: 1;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--field-border);
      border-radius: 4px;
      padding: 5px 7px;
    }
    .account-panel {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .account-heading { font-weight: 650; }
    .account-line { overflow-wrap: anywhere; }
    .account-note { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .account-panel button { justify-self: start; }
    .messages-wrap { position: relative; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
    #messages { overflow-y: auto; min-height: 0; min-width: 0; padding: 10px; }
    .jump {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      padding: 3px 12px;
      border-radius: 12px;
      font-size: 12px;
      white-space: nowrap;
      box-shadow: 0 1px 4px var(--vscode-widget-shadow, transparent);
    }
    .welcome {
      margin: 12px 0;
      padding: 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 9px;
      background: var(--vscode-editor-background);
    }
    .welcome h2 { margin: 0 0 7px; font-size: 15px; }
    .welcome p { margin: 7px 0; color: var(--vscode-descriptionForeground); }
    .message { margin: 0 0 12px; }
    /* Speaker names stay in the page for screen readers but are not shown;
       the user's messages are set apart by position and background. */
    .role {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .message.user { margin-inline-start: 15%; }
    .bubble {
      overflow-wrap: anywhere;
      padding: 9px 10px;
      border-radius: 8px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .message.user .bubble { background: var(--vscode-textBlockQuote-background); }
    .message.error .bubble { border-color: var(--vscode-inputValidation-errorBorder); }
    .bubble > :first-child { margin-top: 0; }
    .bubble > :last-child { margin-bottom: 0; }
    .bubble p, .bubble ul, .bubble ol, .bubble blockquote { margin: 0 0 8px; }
    .bubble h3, .bubble h4, .bubble h5, .bubble h6 { margin: 10px 0 6px; font-size: 13px; }
    .bubble h3 { font-size: 14px; }
    .bubble ul, .bubble ol { padding-inline-start: 22px; }
    .bubble li > p { margin: 0 0 4px; }
    .bubble blockquote {
      margin-inline: 0;
      padding-inline-start: 9px;
      border-inline-start: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
      color: var(--vscode-descriptionForeground);
    }
    .bubble hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
    .bubble a { color: var(--vscode-textLink-foreground); }
    .bubble a:hover { color: var(--vscode-textLink-activeForeground); }
    .bubble .line { white-space: pre-wrap; min-height: 1.45em; }
    .bubble code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .95em;
      padding: 0 3px;
      border-radius: 3px;
      /* Set explicitly: the editor's default webview style colours code with
         textPreformat-foreground, which Antigravity's High Contrast theme
         makes black on black. */
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, var(--vscode-textBlockQuote-background));
    }
    [dir]:not(textarea) { unicode-bidi: isolate; }
    .code-block {
      margin: 6px 0 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      text-align: left;
    }
    .code-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 4px 2px 9px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textCodeBlock-background, var(--vscode-textBlockQuote-background));
    }
    .code-head .copy { padding: 1px 8px; font-size: 11px; }
    .code-block pre {
      margin: 0;
      padding: 8px 10px;
      overflow-x: auto;
      background: var(--vscode-editor-background);
    }
    .code-block pre code { padding: 0; background: none; white-space: pre; font-size: var(--vscode-editor-font-size, 12px); }
    .bidi-mark {
      padding: 0 2px;
      border-radius: 3px;
      color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
      outline: 1px dashed currentColor;
    }
    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 7px;
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    textarea {
      width: 100%;
      min-height: 70px;
      max-height: 220px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--field-border);
      border-radius: 6px;
      padding: 8px;
    }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
    .actions { display: flex; gap: 7px; justify-content: flex-end; }
    .hidden { display: none !important; }
    .context-note {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .plan-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .link-button {
      min-height: 24px;
      padding: 2px 4px;
      color: var(--vscode-textLink-foreground);
      background: none;
      border-color: transparent;
      text-decoration: underline;
    }
    .link-button:hover {
      color: var(--vscode-textLink-activeForeground);
      background: none;
    }
    .error-banner .action, .error-note + .action, .message .usage-action {
      display: block;
      margin-top: 7px;
    }
    .error-banner {
      padding: 7px 9px;
      color: var(--vscode-inputValidation-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 5px;
    }
    /* Attached code (stage 3): the review card above the input, notices,
       the chip on a sent message and the label on its reply. Code is always
       left-to-right; the card's own text follows the page. */
    .attach-card, .attach-notice {
      display: grid;
      gap: 6px;
      padding: 7px 9px;
      border: 1px solid var(--field-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      font-size: 12px;
    }
    .attach-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
    .consent-text, .consent-notice { margin: 0; overflow-wrap: anywhere; }
    .consent-list { margin: 4px 0 0; padding-inline-start: 18px; display: grid; gap: 4px; }
    .consent-list pre { margin: 2px 0 0; max-height: 9em; overflow: auto; white-space: pre; font-size: 11px; }
    /* RC4: a long line (a tool result is one line of JSON) must not widen the card past the chat. */
    .consent-card, .consent-details, .consent-list, .consent-list li { min-width: 0; max-width: 100%; }
    .consent-list pre.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
    /* 0.7.0 command card: the exact command wraps inside the card. */
    .command-line { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: 12px; max-width: 100%; min-width: 0; }
    /* 0.6.0 review card: under its reply; paths stay left-to-right. */
    .review-card { margin-block: 6px; min-width: 0; max-width: 100%; }
    .review-files li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; min-width: 0; }
    .review-path { overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .review-applied { border-color: var(--vscode-testing-iconPassed, var(--field-border)); }
    .review-failed, .review-invalidated { border-color: var(--vscode-inputValidation-warningBorder, var(--field-border)); }
    .project-footer { color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
    .project-footer ul { margin: 2px 0 0; padding-inline-start: 18px; }
    .attach-title { font-weight: 650; }
    .attach-state, .attach-meta, .attach-note { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .attach-note { margin: 0; }
    .attach-flags { margin: 0; padding-inline-start: 18px; display: grid; gap: 2px; }
    .attach-flags .warn { font-weight: 600; }
    .attach-text {
      margin: 0;
      max-height: 160px;
      overflow: auto;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      text-align: left;
      white-space: pre;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, var(--vscode-textBlockQuote-background));
    }
    .attach-confirm { display: flex; align-items: flex-start; gap: 6px; }
    .attach-confirm input { margin: 2px 0 0; }
    .attach-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .attach-row button, .attach-notice button { padding: 3px 9px; }
    .attach-notice { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
    .attach-notice.refused { border-color: var(--vscode-inputValidation-warningBorder, var(--field-border)); }
    .actions #attach { margin-inline-end: auto; }
    .attach-chip {
      margin-top: 6px;
      padding-top: 5px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      overflow-wrap: anywhere;
    }
    .reply-context {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      padding-top: 5px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .reply-context button { padding: 1px 8px; font-size: 11px; }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }
    /* 0.4.0 editor tab: the chat fills the editor. Text keeps a readable
       measure, centred, while code blocks may use the full width. */
    body[data-mode="panel"] .composer { background: var(--vscode-editor-background); }
    body[data-mode="panel"] #messages { padding: 16px max(16px, calc((100% - 56rem) / 2)); }
    body[data-mode="panel"] .header { padding-inline: max(10px, calc((100% - 56rem) / 2)); }
    body[data-mode="panel"] .composer { padding-inline: max(10px, calc((100% - 56rem) / 2)); }
    body[data-mode="panel"] .message.user { margin-inline-start: min(15%, 8rem); }
    /* UX-05: in a tab the side bar already shows the account and usage, so the
       header keeps only the project and the model; the title is in the tab. */
    body[data-mode="panel"] #account,
    body[data-mode="panel"] #accountPanel,
    body[data-mode="panel"] #planRow,
    body[data-mode="panel"] #history { display: none !important; }
    body[data-mode="panel"] #conversationRow { display: none !important; }
    .model-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
    body:not([data-mode="panel"]) .model-label { display: none; }
    body[data-mode="panel"] .message.user { margin-inline-start: auto; max-width: min(85%, 44rem); }
    .chat-title { unicode-bidi: plaintext; }
    /* 0.7.0 RC2 (DEC-PLANCHAT-035): one compact composer box. Colours,
       borders, hover and focus come from the editor's theme. */
    .composer-box { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; }
    .send-icon { display: none; }
    .icon-button {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; flex: none;
      border-radius: 50%;
      color: var(--vscode-foreground);
      background: transparent;
      border: 1px solid var(--field-border);
    }
    .icon-button:hover, .icon-button[aria-expanded="true"] { background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryBackground)); }
    .bar-spacer { flex: 1 1 auto; }
    .model-slot { display: contents; }
    .composer-bar { position: relative; }
    .plus-menu {
      position: absolute;
      bottom: calc(100% + 6px);
      inset-inline-start: 0;
      z-index: 20;
      display: grid;
      width: max-content;
      min-width: min(17rem, calc(100vw - 32px));
      max-width: min(24rem, calc(100vw - 32px));
      padding: 4px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--field-border)));
      border-radius: 8px;
      box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent);
    }
    .menu-item {
      display: grid; gap: 1px;
      padding: 6px 10px;
      text-align: start;
      color: inherit;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
    }
    .menu-item:hover, .menu-item:focus-visible {
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, inherit));
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      border-color: var(--vscode-menu-selectionBorder, transparent);
    }
    .menu-label { font-size: 13px; }
    .menu-desc { font-size: 11px; opacity: .85; }
    /* The tab sits on the editor background, not the side bar's: the field
       edge is mixed against that, so it keeps its 3:1. */
    body[data-mode="panel"] { background: var(--vscode-editor-background); --field-border: var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 60%, var(--vscode-editor-background))); }
    body[data-mode="panel"] .header { padding-block: 6px; gap: 6px; }
    /* The project state: text on the page (the theme's badge colours paired
       with the text colour measured 3.9:1 in Dark Modern, 1.6:1 in High
       Contrast Light). The sharing state stays a separate, quieter word. */
    body[data-mode="panel"] #panelContext { max-width: 100%; padding: 2px 8px; background: transparent; border-color: var(--field-border); border-radius: 10px; }
    body[data-mode="panel"] .composer { border-top: none; padding-block: 6px 12px; }
    body[data-mode="panel"] .composer-box {
      gap: 0;
      /* The page colour, not the input colour: the theme focus ring keeps 3:1
         against it (Dark Modern: 3.6:1, against its input colour 2.9:1); the
         edge (3:1) marks the box. */
      background: var(--vscode-editor-background);
      border: 1px solid var(--field-border);
      border-radius: 12px;
    }
    body[data-mode="panel"] .composer-box:focus-within { border-color: var(--vscode-focusBorder); }
    body[data-mode="panel"] .composer-box textarea {
      min-height: 44px;
      max-height: 40vh;
      resize: none;
      border: none;
      background: transparent;
      border-radius: 12px 12px 0 0;
      padding: 10px 12px 4px;
    }
    body[data-mode="panel"] .composer-box textarea:focus { outline: none; }
    body[data-mode="panel"] .composer-bar { align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px 8px; }
    body[data-mode="panel"] .composer-model {
      flex: 0 1 auto;
      min-width: 0;
      max-width: min(16rem, 45%);
      padding: 3px 6px;
      font-size: 12px;
      border-color: transparent;
      background: transparent;
      border-radius: 6px;
      text-overflow: ellipsis;
    }
    body[data-mode="panel"] .composer-model:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-dropdown-background)); border-color: var(--field-border); }
    body[data-mode="panel"] .composer-model option { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
    /* 0.8.0 (DEC-PLANCHAT-040): Thinking sits beside the model, in the same
       style; its label hides first when the composer is narrow. */
    .effort-select { flex: 0 1 auto; }
    .effort-label { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    body:not([data-mode="panel"]) .effort-label { display: none; }
    body[data-mode="panel"] .composer-model.effort-select { max-width: min(9rem, 32%); }
    /* One line in the editor tab, as in 0.7.0: when narrow the two selects
       shrink (their tooltips give the full text) instead of wrapping. */
    body[data-mode="panel"] .composer-bar { flex-wrap: nowrap; }
    body[data-mode="panel"] .composer-model { min-width: 0; }
    body[data-mode="panel"] .composer-model.effort-select { min-width: 2.9rem; }
    body[data-mode="panel"][data-narrow] .composer-bar { gap: 4px; padding-inline: 6px; }
    /* The select keeps its name (aria-label "Thinking") without the word. */
    body[data-narrow] .effort-label { display: none; }
    .effort-note { font-size: 12px; color: var(--vscode-descriptionForeground); padding-inline: 12px; padding-block-end: 6px; }
    body[data-mode="panel"] #send {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; flex: none;
      border-radius: 50%;
    }
    body[data-mode="panel"] #send .send-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    body[data-mode="panel"] #send .send-icon { display: block; }
    body[data-mode="panel"] #stop { padding: 3px 10px; border-radius: 14px; }
    body:not([data-mode="panel"]) #send { padding: 7px 10px; }
    .reply-status { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .other-reply .row { margin-top: 4px; }
    .reply-state { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .other-reply { font-size: 12px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body data-mode="${pageMode}">
  <div id="app">
    <header class="header">
      <div id="status" class="status-line hidden" role="status"></div>
      <div id="notice" class="notice hidden" role="status"></div>
      <div id="conversationRow" class="header-line hidden">
        <span id="projectStatic" class="project-chip hidden"><span class="visually-hidden">Context:</span> <span class="project-text" dir="auto"></span><span class="project-state"></span></span>
        <button id="projectPicker" class="project-chip hidden" type="button" aria-haspopup="listbox"><span class="project-text" dir="auto"></span><span class="project-state" aria-hidden="true"></span></button>
        <button id="history" class="history" type="button" aria-haspopup="listbox" aria-label="Chat history">
          <span id="chatTitle" class="chat-title" dir="auto">New chat</span>
          <svg class="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
      <div id="accountRow" class="header-line hidden">
        <span id="panelContext" class="project-chip hidden"><span class="visually-hidden">Context:</span> <span class="project-text" dir="auto"></span><span class="project-state"></span></span>
        <label class="model-label" for="models">Model</label>
        <select id="models" aria-label="Model"></select>
        <!-- 0.8.0 (DEC-PLANCHAT-040): the Thinking level for this chat's next Send.
             The host decides which levels a model accepts and checks every Send again. -->
        <label id="effortLabel" class="effort-label" for="effort">Thinking</label>
        <select id="effort" class="effort-select" aria-label="Thinking" aria-describedby="effortNote"></select>
        <button id="account" class="secondary" aria-expanded="false" aria-controls="accountPanel">Account</button>
      </div>
      <div id="accountPanel" class="account-panel hidden" role="group" aria-labelledby="accountHeading">
        <div id="accountHeading" class="account-heading">ChatGPT account</div>
        <div class="account-line">Signed in as <span id="accountName" dir="auto"></span></div>
        <p class="account-note">Kenlith is an unofficial client. Chats are saved on this computer only.</p>
        <p id="planNote" class="account-note hidden">Kenlith is free. Messages you send count toward your ChatGPT plan’s usage limits.</p>
        <p class="account-note">Sign Out asks you to confirm first. Your local chats are kept.</p>
        <button id="manageSharing" class="secondary" type="button">Manage project sharing…</button>
        <button id="signOut" class="secondary">Sign Out…</button>
      </div>
      <div id="planRow" class="plan-line hidden">
        <span>Using ChatGPT plan</span>
        <button id="manageUsage" class="link-button" type="button">Manage usage</button>
      </div>
      <div id="errorBanner" class="error-banner hidden" role="alert"></div>
    </header>
    <div class="messages-wrap">
      <main id="messages" tabindex="0" aria-label="Conversation" aria-busy="false"></main>
      <button id="jump" class="secondary jump hidden" type="button">Jump to latest</button>
    </div>
    <section class="composer" aria-label="Message composer">
      <div id="signedOut">
        <button id="signIn">Continue with ChatGPT</button>
      </div>
      <div id="signedIn" class="hidden">
        <div id="contextNote" class="context-note hidden" role="status"></div>
        <div id="otherReply" class="other-reply hidden" role="status"><span id="otherReplyText"></span>
          <div class="row"><button id="otherReplyShow" class="secondary" type="button">Go to that chat</button> <button id="otherReplyStop" class="secondary" type="button">Stop that reply</button></div>
        </div>
        <div id="replyStatus" class="reply-status hidden" role="status">Kenlith is replying… Press Escape or Stop to stop it.</div>
        <div id="readOnlyBar" class="readonly-bar hidden" role="status">
          <span id="readOnlyText" dir="auto"></span>
          <div class="row">
            <button id="readOnlyMove" class="secondary" type="button"></button>
            <button id="readOnlyBack" class="secondary" type="button">Back to my chat</button>
          </div>
        </div>
        <div id="attachNotice" class="attach-notice hidden" role="status">
          <span id="attachNoticeText" dir="auto"></span>
          <button id="attachNoticeClose" class="secondary" type="button" aria-label="Dismiss notice">Dismiss</button>
        </div>
        <section id="consentCard" class="attach-card consent-card hidden" role="group" aria-labelledby="consentTitle" aria-describedby="consentText">
          <div id="consentTitle" class="attach-title" tabindex="-1">Share project context with OpenAI?</div>
          <p id="consentText" class="consent-text" dir="auto"></p>
          <p class="attach-note">Never sent: files that look like secrets, blocked files, other projects and whole files. Nothing is sent until you choose.</p>
          <details id="consentDetails" class="consent-details">
            <summary>Show what would be sent</summary>
            <ul id="consentList" class="consent-list"></ul>
          </details>
          <p id="consentNotice" class="attach-note consent-notice hidden" role="status"></p>
          <div class="attach-row">
            <button id="consentAllow" type="button">Allow and send</button>
            <button id="consentWithout" class="secondary" type="button">Send without project files</button>
            <button id="consentCancel" class="secondary" type="button">Cancel</button>
          </div>
        </section>
        <section id="commandCard" class="attach-card consent-card hidden" role="group" aria-labelledby="commandTitle">
          <div id="commandTitle" class="attach-title" tabindex="-1">Run this command?</div>
          <p id="commandWhy" class="consent-text" dir="auto"></p>
          <pre id="commandLine" class="wrap command-line" dir="ltr" tabindex="0"></pre>
          <ul id="commandFacts" class="consent-list"></ul>
          <p class="attach-note">Nothing runs until you choose. Run starts exactly this, once.</p>
          <div class="attach-row">
            <button id="commandRun" type="button">Run</button>
            <button id="commandDecline" class="secondary" type="button">Don't run</button>
          </div>
        </section>
        <section id="outputCard" class="attach-card consent-card hidden" role="group" aria-labelledby="outputTitle">
          <div id="outputTitle" class="attach-title" tabindex="-1">Share this command output?</div>
          <p id="outputWhy" class="consent-text" dir="auto"></p>
          <details id="outputDetails" class="consent-details"><summary>Show the output</summary><pre id="outputText" class="wrap" dir="ltr" tabindex="0"></pre></details>
          <div class="attach-row">
            <button id="outputShare" type="button">Share with ChatGPT</button>
            <button id="outputWithhold" class="secondary" type="button">Don't share</button>
          </div>
        </section>
        <section id="attachCard" class="attach-card hidden" aria-labelledby="attachTitle">
          <div class="attach-head">
            <span id="attachTitle" class="attach-title">Attached code</span>
            <span id="attachState" class="attach-state"></span>
          </div>
          <div class="attach-meta"><span id="attachSource" dir="ltr"></span></div>
          <div id="attachSize" class="attach-meta"></div>
          <ul id="attachFlags" class="attach-flags"></ul>
          <pre id="attachText" class="attach-text" dir="ltr" tabindex="0" aria-label="Attached code, exactly as it will be sent"></pre>
          <p class="attach-note">Sent once with your next message. The answer to it is not sent with follow-up messages unless you include it.</p>
          <label id="attachConfirmRow" class="attach-confirm hidden"><input id="attachConfirm" type="checkbox"> <span id="attachConfirmText"></span></label>
          <div class="attach-row">
            <button id="attachApprove" type="button">Approve</button>
            <button id="attachRefresh" class="secondary" type="button">Refresh</button>
            <button id="attachRemove" class="secondary" type="button">Remove</button>
          </div>
        </section>
        <div id="composerBox" class="composer-box">
          <textarea id="prompt" dir="auto" placeholder="Message ChatGPT…" aria-label="Message"></textarea>
          <div id="composerBar" class="actions composer-bar">
            <!-- 0.7.0 RC2 (DEC-PLANCHAT-035): in the editor tab, actions are under + .
                 Only things Kenlith can do; each item posts an existing message. -->
            <button id="plus" class="icon-button hidden" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="plusMenu" aria-label="Actions: attach selection, project sharing, project settings" title="Actions">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
            <div id="plusMenu" class="plus-menu hidden" role="menu" aria-labelledby="plus">
              <button id="menuAttach" class="menu-item" type="button" role="menuitem"><span class="menu-label">Attach selection</span><span class="menu-desc">The code selected in the editor. You review it before it is sent.</span></button>
              <button id="menuSharing" class="menu-item" type="button" role="menuitem"><span class="menu-label">Project sharing…</span><span class="menu-desc">See or stop what projects share with OpenAI.</span></button>
              <button id="menuSettings" class="menu-item" type="button" role="menuitem"><span class="menu-label">Project context settings…</span><span class="menu-desc">Turn project files, tools, proposed changes or commands on or off.</span></button>
            </div>
            <button id="attach" class="secondary" type="button" title="Attach the code selected in the editor. You review it before anything is sent.">Attach Selection</button>
            <span class="bar-spacer"></span>
            <span id="modelSlot" class="model-slot"></span>
            <button id="stop" class="secondary hidden" aria-label="Stop response">Stop</button>
            <button id="send" aria-label="Send" title="Send (Enter)"><span class="send-text">Send</span><svg class="send-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2.5M3 6.5L7 2.5l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
          <div id="effortNote" class="effort-note hidden" role="status" aria-live="polite"></div>
        </div>
      </div>
    </section>
    <div id="announcer" class="visually-hidden" role="status" aria-live="polite"></div>
    <div id="alerts" class="visually-hidden" role="alert"></div>
  </div>
  <script nonce="${nonce}">${markdownScript()}</script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const md = window.PlanChatMarkdown;
    const elements = {
      status: document.getElementById('status'),
      accountRow: document.getElementById('accountRow'),
      account: document.getElementById('account'),
      accountPanel: document.getElementById('accountPanel'),
      accountName: document.getElementById('accountName'),
      planRow: document.getElementById('planRow'),
      consentCard: document.getElementById('consentCard'),
      commandCard: document.getElementById('commandCard'),
      commandTitle: document.getElementById('commandTitle'),
      commandWhy: document.getElementById('commandWhy'),
      commandLine: document.getElementById('commandLine'),
      commandFacts: document.getElementById('commandFacts'),
      commandRun: document.getElementById('commandRun'),
      commandDecline: document.getElementById('commandDecline'),
      outputCard: document.getElementById('outputCard'),
      outputTitle: document.getElementById('outputTitle'),
      outputWhy: document.getElementById('outputWhy'),
      outputText: document.getElementById('outputText'),
      outputShare: document.getElementById('outputShare'),
      outputWithhold: document.getElementById('outputWithhold'),
      consentTitle: document.getElementById('consentTitle'),
      consentText: document.getElementById('consentText'),
      consentDetails: document.getElementById('consentDetails'),
      consentList: document.getElementById('consentList'),
      consentNotice: document.getElementById('consentNotice'),
      consentAllow: document.getElementById('consentAllow'),
      consentWithout: document.getElementById('consentWithout'),
      consentCancel: document.getElementById('consentCancel'),
      manageSharing: document.getElementById('manageSharing'),
      planNote: document.getElementById('planNote'),
      manageUsage: document.getElementById('manageUsage'),
      conversationRow: document.getElementById('conversationRow'),
      history: document.getElementById('history'),
      projectStatic: document.getElementById('projectStatic'),
      projectPicker: document.getElementById('projectPicker'),
      notice: document.getElementById('notice'),
      readOnlyBar: document.getElementById('readOnlyBar'),
      readOnlyText: document.getElementById('readOnlyText'),
      readOnlyMove: document.getElementById('readOnlyMove'),
      readOnlyBack: document.getElementById('readOnlyBack'),
      chatTitle: document.getElementById('chatTitle'),
      models: document.getElementById('models'),
      effort: document.getElementById('effort'),
      effortLabel: document.getElementById('effortLabel'),
      effortNote: document.getElementById('effortNote'),
      modelLabel: document.querySelector('label.model-label'),
      modelSlot: document.getElementById('modelSlot'),
      plus: document.getElementById('plus'),
      plusMenu: document.getElementById('plusMenu'),
      composerBar: document.getElementById('composerBar'),
      menuAttach: document.getElementById('menuAttach'),
      menuSharing: document.getElementById('menuSharing'),
      menuSettings: document.getElementById('menuSettings'),
      messages: document.getElementById('messages'),
      jump: document.getElementById('jump'),
      signedOut: document.getElementById('signedOut'),
      signedIn: document.getElementById('signedIn'),
      prompt: document.getElementById('prompt'),
      send: document.getElementById('send'),
      stop: document.getElementById('stop'),
      signIn: document.getElementById('signIn'),
      signOut: document.getElementById('signOut'),
      error: document.getElementById('errorBanner'),
      contextNote: document.getElementById('contextNote'),
      announcer: document.getElementById('announcer'),
      alerts: document.getElementById('alerts'),
      attach: document.getElementById('attach'),
      attachNotice: document.getElementById('attachNotice'),
      attachNoticeText: document.getElementById('attachNoticeText'),
      attachNoticeClose: document.getElementById('attachNoticeClose'),
      attachCard: document.getElementById('attachCard'),
      attachState: document.getElementById('attachState'),
      attachSource: document.getElementById('attachSource'),
      attachSize: document.getElementById('attachSize'),
      attachFlags: document.getElementById('attachFlags'),
      attachText: document.getElementById('attachText'),
      attachConfirmRow: document.getElementById('attachConfirmRow'),
      attachConfirm: document.getElementById('attachConfirm'),
      attachConfirmText: document.getElementById('attachConfirmText'),
      attachApprove: document.getElementById('attachApprove'),
      attachRefresh: document.getElementById('attachRefresh'),
      attachRemove: document.getElementById('attachRemove'),
      otherReply: document.getElementById('otherReply'),
      otherReplyText: document.getElementById('otherReplyText'),
      otherReplyShow: document.getElementById('otherReplyShow'),
      otherReplyStop: document.getElementById('otherReplyStop'),
      replyStatus: document.getElementById('replyStatus'),
      panelContext: document.getElementById('panelContext')
    };
    const MODE = document.body.dataset.mode;
    // Unsent text is sent to the extension, which keeps it for this chat
    // across restarts (0.4.0); never with a request.
    const DRAFT_DELAY = 300;

    // The view follows new text only while it is within this many pixels of the end.
    const FOLLOW_MARGIN = 48;
    // Streamed text is rendered at most this often, not on every token.
    const RENDER_DELAY = 80;
    // A streaming reply longer than this is shown as plain text until it ends.
    const LIVE_MARKDOWN_LIMIT = 60000;

    const state = {
      signedIn: false,
      busy: false,
      streaming: false,
      messages: new Map(),
      // Why a reply failed in this session, and its action (Manage usage).
      // Neither is stored, but both survive the re-render after each send.
      liveFailures: new Map(),
      conversationId: undefined,
      follow: true,
      pending: new Set(),
      renderTimer: undefined,
      copyButton: undefined,
      readOnly: false,
      // Display copy of the pending attachment; the extension keeps the text it sends.
      attachment: undefined,
      attachFromView: false,
      // Another chat of this window is replying (one request at a time).
      otherReply: null,
      draftTimer: undefined
    };

    function post(type, extra = {}) { vscode.postMessage({ type, ...extra }); }
    function setHidden(element, hidden) { element.classList.toggle('hidden', hidden); }
    function speak(region, text) {
      // Clearing first makes screen readers announce the same text again.
      region.textContent = '';
      setTimeout(() => { region.textContent = text; }, 30);
    }
    function announce(text) { speak(elements.announcer, text); }
    // Project context consent (M1-4). The card shows what would be sent;
    // nothing is sent until a choice is made, and the choice is made here,
    // in this window.
    // Names from the file system are shown without direction-control
    // characters, which could make one name look like another.
    function plainText(value) { return String(value).replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ''); }
    function visibleText(value) { return Array.from(String(value), (c) => (plainText(c) === c ? c : '[?]')).join(''); }
    function renderConsent(consent, notice) {
      state.consent = consent || null;
      setHidden(elements.consentCard, !consent);
      elements.consentNotice.textContent = notice || '';
      setHidden(elements.consentNotice, !notice);
      if (!consent) {
        if (notice) announce(notice);
        updateSend();
        return;
      }
      const tools = Array.isArray(consent.tools) ? consent.tools : null;
      elements.consentText.textContent = tools
        // DEC-PLANCHAT-024: the model asked to look in the project during a reply.
        ? 'ChatGPT asked to look in ' + plainText(consent.label) + '. To continue, Kenlith would send ' + tools.length + ' '
          + (tools.length === 1 ? 'result' : 'results') + ' from ' + plainText(consent.label) + ' to ' + consent.provider
          + ', using ' + consent.account + '. Allowing applies to this project and ChatGPT account until you stop sharing.'
        : 'To answer, Kenlith would send ' + consent.excerpts.length + ' short '
          + (consent.excerpts.length === 1 ? 'excerpt' : 'excerpts') + ' from ' + plainText(consent.label) + ' to ' + consent.provider
          + ', using ' + consent.account + '. Allowing applies to this project and ChatGPT account until you stop sharing.'
          + (consent.withheld ? ' ' + consent.withheld + ' matching ' + (consent.withheld === 1 ? 'file was' : 'files were') + ' withheld.' : '');
      elements.consentAllow.textContent = 'Allow for ' + plainText(consent.label) + ' and send';
      elements.consentWithout.textContent = tools ? 'Answer without project files' : 'Send without project files';
      elements.consentList.replaceChildren();
      for (const item of tools || []) {
        const li = document.createElement('li');
        const name = document.createElement('div');
        name.dir = 'ltr';
        name.textContent = plainText(item.name);
        const pre = document.createElement('pre');
        pre.className = 'wrap';
        pre.dir = 'ltr';
        pre.tabIndex = 0;
        pre.textContent = item.text;
        li.append(name, pre);
        elements.consentList.append(li);
      }
      for (const excerpt of tools ? [] : consent.excerpts) {
        const li = document.createElement('li');
        const name = document.createElement('div');
        name.dir = 'ltr';
        name.textContent = plainText(excerpt.relPath) + ' (lines ' + excerpt.startLine + '-' + excerpt.endLine + ')';
        const pre = document.createElement('pre');
        pre.dir = 'ltr';
        pre.tabIndex = 0;
        pre.textContent = excerpt.text;
        li.append(name, pre);
        elements.consentList.append(li);
      }
      elements.consentDetails.open = false;
      elements.consentAllow.disabled = false;
      elements.consentWithout.disabled = false;
      updateSend();
      elements.consentTitle.focus();
      announce('Kenlith asks before sharing project files. ' + elements.consentText.textContent);
    }
    function decideConsent(choice) {
      if (!state.consent) return;
      // One decision per card: buttons stay off until the extension answers.
      for (const button of [elements.consentAllow, elements.consentWithout]) button.disabled = choice !== 'cancel';
      post('consentDecision', { choice });
    }

    // Manage usage is the primary recovery action for the ChatGPT plan
    // usage-limit error (SIWC guidelines); other errors have none.
    function usageButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action usage-action';
      button.textContent = 'Manage usage';
      button.addEventListener('click', () => post('manageUsage'));
      return button;
    }
    function showError(message, action) {
      const text = document.createElement('span');
      text.textContent = message || '';
      elements.error.replaceChildren(text);
      if (message && (action === 'manageUsage' || action === 'usagePaused')) elements.error.append(usageButton());
      if (message && action === 'usagePaused') {
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'action secondary resume-action';
        resume.textContent = 'Resume';
        resume.addEventListener('click', () => post('resumeUsage'));
        elements.error.append(resume);
      }
      setHidden(elements.error, !message);
    }
    function setBusy(busy, label) {
      state.busy = busy;
      elements.signIn.disabled = busy;
      elements.account.disabled = busy;
      elements.signOut.disabled = busy;
      updateSend();
      elements.status.textContent = busy && label ? label : '';
      setHidden(elements.status, !(busy && label));
    }
    function setStreaming(streaming) {
      state.streaming = streaming;
      // The input stays editable during a reply, so the next message can be
      // drafted; Send stays disabled until the reply ends or is stopped.
      updateSend();
      setHidden(elements.stop, !streaming);
      setHidden(elements.replyStatus, !streaming);
      elements.messages.setAttribute('aria-busy', String(streaming));
      if (!streaming) flushRenders();
    }

    // Send waits while attached code is not yet approved.
    function updateSend() {
      elements.send.disabled = state.busy || state.streaming || state.readOnly || Boolean(state.otherReply)
        || Boolean(state.attachment && !state.attachment.approved);
    }
    function renderOtherReply(other) {
      state.otherReply = other || null;
      // 0.6.0 (DEC-PLANCHAT-028): a reply waiting for a sharing decision is
      // not "replying".
      elements.otherReplyText.textContent = !other ? ''
        : other.waiting
          ? '"' + other.title + '" is waiting for ' + (other.waitingFor === 'command' ? 'you to approve a command' : other.waitingFor === 'output' ? 'your decision to share command output' : 'your decision to share project files') + '. You can write here; Send is available when that reply ends.'
          : 'Kenlith is replying in "' + other.title + '". You can write here; Send is available when that reply ends.';
      setHidden(elements.otherReply, !other);
      updateSend();
    }
    // 0.6.0 Review Before Apply: one card per proposal, under the reply that
    // made it. Text and buttons come from the extension; the summary is the
    // model's text, shown as text. Nothing on the card changes a file: Apply
    // asks the extension, which checks the proposal and every file again.
    function renderProposals(chatId, proposals) {
      if (chatId !== state.conversationId) return;
      const list = Array.isArray(proposals) ? proposals : [];
      // A card whose content did not change is left as it is, so a click in
      // progress is never lost to a redraw.
      const key = JSON.stringify(list);
      const shown = elements.messages.querySelectorAll('.review-card');
      if (key === state.proposalsKey && shown.length === list.length) return;
      state.proposalsKey = key;
      for (const old of shown) old.remove();
      for (const proposal of list) {
        const cardEl = reviewCard(proposal);
        const after = state.messages.get(proposal.messageId)?.container;
        if (after && after.parentNode === elements.messages) after.after(cardEl);
        else elements.messages.append(cardEl);
      }
      contentChanged();
    }
    function reviewCard(proposal) {
      const section = document.createElement('section');
      section.className = 'attach-card review-card review-' + proposal.state;
      section.setAttribute('role', 'group');
      const titleId = 'review-title-' + proposal.id;
      section.setAttribute('aria-labelledby', titleId);
      const title = document.createElement('div');
      title.id = titleId;
      title.className = 'attach-title';
      title.tabIndex = -1;
      const n = proposal.files.length;
      title.textContent = proposal.state === 'refused' ? 'Proposed changes could not be prepared'
        : proposal.state === 'applied' ? 'Changes applied (not saved)'
          : proposal.state === 'reverted' ? 'Changes undone'
          : 'Proposed changes' + (proposal.actionable ? ' · not applied' : '');
      section.append(title);
      if (proposal.summary) {
        const summary = document.createElement('p');
        summary.className = 'consent-text';
        // RC2: the model's words are isolated, so an Arabic summary runs right
        // to left after the English label.
        const said = document.createElement('bdi');
        said.className = 'model-words';
        said.dir = 'auto';
        said.textContent = plainText(proposal.summary);
        summary.append('ChatGPT suggests: ', said);
        section.append(summary);
      }
      if (proposal.actionable) {
        const note = document.createElement('p');
        note.className = 'attach-note';
        note.textContent = 'Nothing has changed yet. Apply writes exactly the diff shown into the editor, without saving; Reject changes nothing.';
        section.append(note);
      }
      if (n) {
        const list = document.createElement('ul');
        list.className = 'consent-list review-files';
        for (const file of proposal.files) {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.dir = 'ltr';
          name.className = 'review-path';
          name.textContent = plainText(file.relPath);
          const counts = document.createElement('span');
          counts.className = 'attach-meta';
          counts.dir = 'ltr';
          counts.textContent = ' −' + file.removedLines + ' +' + file.addedLines + ' ';
          counts.setAttribute('aria-label', file.removedLines + ' lines removed, ' + file.addedLines + ' lines added');
          const show = document.createElement('button');
          show.type = 'button';
          show.className = 'secondary';
          show.textContent = 'Show diff';
          show.setAttribute('aria-label', 'Show diff for ' + plainText(file.relPath));
          show.addEventListener('click', () => post('showDiff', { proposalId: proposal.id, path: file.relPath }));
          li.append(name, counts, show);
          list.append(li);
        }
        section.append(list);
      }
      for (const refusal of proposal.refusals || []) {
        const p = document.createElement('p');
        p.className = 'attach-note';
        p.dir = 'auto';
        p.textContent = refusal.text;
        section.append(p);
      }
      const status = document.createElement('p');
      status.className = 'attach-note review-status';
      status.setAttribute('role', 'status');
      status.textContent = proposal.status || '';
      section.append(status);
      if (proposal.actionable) {
        const row = document.createElement('div');
        row.className = 'attach-row';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'review-apply';
        apply.textContent = 'Apply changes to ' + n + ' ' + (n === 1 ? 'file' : 'files');
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'secondary review-reject';
        reject.textContent = 'Reject';
        const decide = (choice) => {
          // One decision per card: both buttons stay off until the extension answers.
          apply.disabled = true;
          reject.disabled = true;
          status.textContent = choice === 'apply' ? 'Checking the files…' : 'Rejecting…';
          post('reviewDecision', { proposalId: proposal.id, digest: proposal.digest, choice });
        };
        apply.addEventListener('click', () => decide('apply'));
        reject.addEventListener('click', () => decide('reject'));
        row.append(apply, reject);
        section.append(row);
      }
      return section;
    }
    // Each draft carries when it was typed; the extension keeps the newest
    // and never lets an older one replace it (D-1).
    function saveDraftSoon() {
      clearTimeout(state.draftTimer);
      const rev = Date.now();
      state.draftTimer = setTimeout(() => post('draft', { text: elements.prompt.value, rev }), DRAFT_DELAY);
    }
    // A saved draft is shown only in an empty composer.
    function restoreSavedDraft(text) {
      if (typeof text === 'string' && text && !elements.prompt.value) {
        elements.prompt.value = text; fitPrompt();
        state.filledFromDraft = text;
      }
    }
    // Text put in the box from a saved draft, untouched since, that has since
    // been sent (from here or elsewhere) is removed: it is in the chat now.
    function dropSentDraft(conversation) {
      const filled = state.filledFromDraft;
      if (!filled || elements.prompt.value !== filled) { state.filledFromDraft = undefined; return; }
      const asked = (conversation?.messages || []).filter((m) => m.role === 'user').map((m) => m.content);
      if (asked.length && asked[asked.length - 1] === filled.trim()) {
        elements.prompt.value = ''; fitPrompt();
        state.filledFromDraft = undefined;
      }
    }
    // Restore after a restart needs only which chat this tab shows; the
    // extension checks it again. No text is kept here.
    function rememberChat(id) {
      if (MODE === 'panel' && id) vscode.setState({ chatId: id });
    }
    function count(value) { return Number(value).toLocaleString('en-US'); }
    function lineText(start, end) { return start === end ? 'line ' + start : 'lines ' + start + '–' + end; }

    // The review card (stage 3, §4.1): the exact text that would be sent, its
    // source and size, flags, and Approve, Refresh and Remove.
    function renderAttachment(info, notice) {
      const before = state.attachment;
      state.attachment = info || undefined;
      setHidden(elements.attachCard, !info);
      if (info) {
        elements.attachState.textContent = info.approved ? 'Approved: sent with your next message' : 'Review, then approve';
        elements.attachSource.textContent = info.displayPath + ' · ' + lineText(info.startLine, info.endLine) + ' · ' + info.languageId;
        elements.attachSize.textContent = count(info.chars) + ' chars · ' + count(info.utf8Bytes) + ' bytes UTF-8 · ≈ ' + count(info.tokens) + ' tokens (rough estimate)';
        if (!before || before.id !== info.id) {
          elements.attachText.textContent = info.text;
          elements.attachText.scrollTop = 0;
          elements.attachConfirm.checked = false;
        }
        const flags = [];
        if (info.credentialLines.length) flags.push(['warn', 'Possible credentials on ' + (info.credentialLines.length === 1 ? 'line ' : 'lines ') + info.credentialLines.join(', ') + '. Nothing is removed automatically.']);
        if (info.changed) flags.push(['warn', 'The document changed after this was captured. The text below is what will be sent; Refresh takes the current text.']);
        if (info.unsaved) flags.push(['', 'Unsaved changes: sending the text as it is in the editor, not the saved file.']);
        if (info.untitled) flags.push(['', 'Untitled editor: no file on disk.']);
        if (info.envExample) flags.push(['warn', 'Example environment file: check that it holds no real values.']);
        if (info.multipleSelections) flags.push(['', 'Only the first of ' + info.multipleSelections + ' selections is attached.']);
        if (info.tokens > 3000) flags.push(['', 'Large attachment: about ' + count(info.tokens) + ' tokens of your ChatGPT plan usage.']);
        elements.attachFlags.replaceChildren(...flags.map(([tone, text]) => {
          const item = document.createElement('li');
          if (tone) item.className = tone;
          item.textContent = text;
          return item;
        }));
        setHidden(elements.attachFlags, !flags.length);
        const flagged = info.credentialLines.length > 0;
        setHidden(elements.attachConfirmRow, !flagged || info.approved);
        elements.attachConfirmText.textContent = 'I reviewed ' + (info.credentialLines.length === 1 ? 'line ' : 'lines ') + info.credentialLines.join(', ') + ': send anyway';
        elements.attachApprove.disabled = info.approved || (flagged && !elements.attachConfirm.checked);
        setHidden(elements.attachApprove, info.approved);
      }
      if (notice === null) {
        setHidden(elements.attachNotice, true);
      } else if (notice) {
        elements.attachNoticeText.textContent = notice.text;
        elements.attachNotice.classList.toggle('refused', notice.tone === 'refused');
        setHidden(elements.attachNotice, false);
        speak(notice.tone === 'refused' ? elements.alerts : elements.announcer, notice.text);
      }
      if (info && (!before || before.id !== info.id)) {
        announce('Code attached: ' + lineText(info.startLine, info.endLine) + ' of ' + info.displayPath + '. Review it, then approve.');
        if (state.attachFromView) elements.attachApprove.focus();
      } else if (info && info.approved && before && !before.approved) {
        announce('Attachment approved. It will be sent with your next message.');
        elements.prompt.focus();
      }
      state.attachFromView = false;
      updateSend();
    }

    // Under a sent message: what was attached. The code itself is not kept.
    function attachmentChip(attachments) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      for (const entry of attachments) {
        const line = document.createElement('div');
        const outcome = entry.outcome === 'stopped' ? 'request stopped' : entry.outcome === 'failed' ? 'request failed' : 'sent once';
        const icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '📎 ';
        const where = document.createElement('span');
        where.dir = 'ltr';
        where.textContent = entry.displayPath;
        line.append(icon, 'Attached: ', where, ' · ' + lineText(entry.startLine, entry.endLine) + ' · ' + count(entry.chars) + ' chars · ' + outcome);
        chip.append(line);
      }
      const note = document.createElement('div');
      note.textContent = 'The attached code is not kept on this computer. Attach it again to ask more about it.';
      chip.append(note);
      return chip;
    }

    // On a reply to attached code (§5.1a): whether it is sent with follow-up
    // messages, and the button that changes that for this reply only.
    // What a reply was based on (M1-4): the project files it used, as
    // relative paths and line ranges, or that it was answered without them.
    ${projectFooterLabel.toString()}
    function renderProjectFooter(item) {
      item.projectFooter?.remove();
      item.projectFooter = undefined;
      // Not before the reply has text, and never for a request that was not sent.
      if (item.role !== 'assistant' || !item.content || item.projectNotSent) return;
      const row = document.createElement('div');
      row.className = 'project-footer';
      if (item.withoutProjectFiles) {
        row.textContent = 'Answered without project files.';
      } else if (item.provenance === 'project-derived' && projectFooterLabel(item)) {
        const used = item.contextUsed;
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = projectFooterLabel(item);
        details.append(summary);
        if (used.length) {
          const list = document.createElement('ul');
          for (const entry of used) {
            const li = document.createElement('li');
            li.dir = 'ltr';
            li.textContent = plainText(entry.relPath) + ' (lines ' + entry.range[0] + '-' + entry.range[1] + ')';
            list.append(li);
          }
          details.append(list);
        }
        row.append(details);
      } else {
        return;
      }
      item.projectFooter = row;
      item.container.append(row);
    }
    // 0.7.0: the commands a reply ran (or that were refused or declined).
    function renderCommandsFooter(item) {
      item.commandsFooter?.remove();
      item.commandsFooter = undefined;
      const runs = Array.isArray(item.commands) ? item.commands : [];
      if (item.role !== 'assistant' || !runs.length) return;
      const row = document.createElement('div');
      row.className = 'project-footer';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Kenlith handled ' + runs.length + ' ' + (runs.length === 1 ? 'command' : 'commands') + ' for this answer';
      details.append(summary);
      const list = document.createElement('ul');
      const words = { succeeded: 'finished (exit 0)', nonzero: 'failed', 'timed-out': 'stopped at its time limit', cancelled: 'cancelled', 'launch-failed': 'could not start', blocked: 'refused by Kenlith', declined: 'not run (you declined)', void: 'not run', interrupted: 'interrupted' };
      for (const r of runs) {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.dir = 'ltr';
        code.textContent = plainText(String(r.command || '')).slice(0, 200);
        li.append(code, ' ' + (words[r.status] || r.status) + (r.status === 'nonzero' && r.exitCode !== null ? ' (exit ' + r.exitCode + ')' : '') + (r.cls === 'B' ? ' · approved by you' : r.cls === 'A' ? ' · safe local check' : ''));
        list.append(li);
      }
      details.append(list);
      row.append(details);
      item.commandsFooter = row;
      item.container.append(row);
    }
    // 0.7.0: one approval card for a consequential command (DEC-PLANCHAT-031).
    function renderCommand(card) {
      state.command = card || null;
      setHidden(elements.commandCard, !card);
      if (!card) { updateSend(); return; }
      // RC2: the task name and the model's words are isolated (an Arabic
      // purpose runs right to left after the English label).
      elements.commandWhy.replaceChildren();
      const isolated = (text) => { const b = document.createElement('bdi'); b.className = 'model-words'; b.dir = 'auto'; b.textContent = plainText(text); return b; };
      if (card.task) elements.commandWhy.append('Task "', isolated(card.task), '". ');
      if (card.purpose) elements.commandWhy.append('ChatGPT says: ', isolated(card.purpose));
      // The host refuses text-direction characters in a command; should one
      // reach the card anyway, it shows as [?] rather than reordering the line.
      elements.commandLine.textContent = visibleText(card.shellText ? card.shellText : [card.executable].concat(card.args.map((a) => (/[\\s"]/.test(a) ? JSON.stringify(a) : a))).join(' '));
      elements.commandFacts.replaceChildren();
      // [name, value, technical]: technical values (paths, variables) keep
      // left-to-right isolation in an Arabic chat; sentences follow their text.
      const facts = [['Folder', card.cwd === '.' ? 'the project folder' : card.cwd, card.cwd !== '.'], ['Time limit', card.timeoutSeconds + ' s', true]];
      facts.push(card.env.length ? ['Environment', card.env.map((e) => e.name + '=' + e.value).join(', '), true] : ['Environment', 'no changes', false]);
      // RC2: the effect is always its own line (network, repository, files),
      // and the host's reasons say why it needs this approval.
      const effects = (card.effects || []).join('; ');
      if (effects) facts.push(['Effect', effects, false]);
      const why = (card.reasons && card.reasons.length ? card.reasons : card.effects).join('; ');
      if (why) facts.push(['Why Kenlith asks', why, false]);
      for (const [name, value, technical] of facts) {
        const li = document.createElement('li');
        const b = document.createElement('strong');
        b.textContent = name + ': ';
        const v = document.createElement('span');
        v.dir = technical ? 'ltr' : 'auto';
        v.textContent = plainText(String(value));
        li.append(b, v);
        elements.commandFacts.append(li);
      }
      elements.commandRun.disabled = false;
      elements.commandDecline.disabled = false;
      updateSend();
      elements.commandTitle.focus();
      announce('Kenlith asks before running a command. ' + elements.commandLine.textContent);
    }
    function decideCommand(choice) {
      if (!state.command) return;
      elements.commandRun.disabled = true;
      elements.commandDecline.disabled = true;
      post('commandDecision', { id: state.command.id, digest: state.command.digest, choice });
    }
    function renderOutputCard(card) {
      state.outputCard = card || null;
      setHidden(elements.outputCard, !card);
      if (!card) return;
      elements.outputWhy.textContent = 'Kenlith ran ' + plainText(card.command) + '. Its output may go beyond this project: ' + plainText(card.why) + ' Nothing from it is sent until you choose.';
      elements.outputText.textContent = visibleText(card.text);
      elements.outputShare.disabled = false;
      elements.outputWithhold.disabled = false;
      elements.outputTitle.focus();
    }
    function decideOutput(choice) {
      if (!state.outputCard) return;
      elements.outputShare.disabled = true;
      elements.outputWithhold.disabled = true;
      post('outputDecision', { id: state.outputCard.id, choice });
    }
    function renderReplyContext(item) {
      renderProjectFooter(item);
      renderCommandsFooter(item);
      item.replyContext?.remove();
      item.replyContext = undefined;
      if (!item.attachmentTurn) return;
      const row = document.createElement('div');
      row.className = 'reply-context';
      const text = document.createElement('span');
      const included = item.contextPolicy === 'included';
      text.textContent = included
        ? 'Sent with follow-up messages (you included this reply to attached code).'
        : 'Not sent with follow-up messages (contains a reply to attached code).';
      row.append(text);
      // An answer that may use project files is governed by the project
      // permission, not by Include in follow-ups.
      // Not for a reply that did not finish (0.4.0): it is never sent again.
      if (!item.error && item.provenance !== 'project-derived' && !item.interrupted && !item.replyingElsewhere && !item.live && !item.inProgress) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.dataset.replyContext = included ? 'exclude' : 'include';
        button.textContent = included ? 'Stop including' : 'Include in follow-ups';
        row.append(button);
      }
      item.replyContext = row;
      item.container.append(row);
    }

    function setAccountOpen(open, returnFocus) {
      elements.account.setAttribute('aria-expanded', String(open));
      setHidden(elements.accountPanel, !open);
      if (!open && returnFocus) elements.account.focus();
    }

    function nearBottom() {
      const list = elements.messages;
      return list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_MARGIN;
    }
    function scrollToBottom() { elements.messages.scrollTop = elements.messages.scrollHeight; }
    function contentChanged() {
      if (state.follow) {
        scrollToBottom();
      } else {
        setHidden(elements.jump, false);
      }
    }

    function spokenText(content) {
      const holder = document.createElement('div');
      holder.append(md.render(document, content));
      holder.querySelectorAll('.code-head').forEach((node) => node.remove());
      const text = holder.textContent.replace(/\\s+/g, ' ').trim();
      return text.length > 400 ? text.slice(0, 400) + '…' : text;
    }

    function renderBody(item) {
      const markdown = item.role === 'assistant' && !item.error
        && !(item.live && item.content.length > LIVE_MARKDOWN_LIMIT);
      item.bubble.replaceChildren(markdown ? md.render(document, item.content) : md.renderPlain(document, item.content));
      // A failed reply that kept partial text says why under it. The reason
      // is not stored; a failed reply loaded from history gets a short note.
      if (item.error && !item.content.startsWith('Request failed:')) {
        const note = document.createElement('div');
        note.className = 'error-note';
        note.dir = 'auto';
        note.textContent = item.errorText ? 'Reply incomplete: ' + item.errorText : 'This reply did not finish.';
        item.bubble.append(note);
      }
      // Shown with the live failure only; not stored with the message.
      if (item.error && item.action === 'manageUsage') item.bubble.append(usageButton());
      // 0.8.0: OpenAI refused the Thinking level; Default is offered, not chosen.
      if (item.error && item.action === 'effortDefault') item.bubble.append(effortDefaultButton());
      // 0.4.0: a reply cut off by a crash or quit, or still being written in
      // another window.
      // DEC-PLANCHAT-017: a reply the user stopped is never shown as complete.
      if (item.stopped && !item.error) {
        const note = document.createElement('div');
        note.className = 'reply-state';
        note.textContent = 'Stopped: you stopped this reply before it finished. Only the text received is shown.';
        item.bubble.append(note);
      }
      if (item.interrupted || item.replyingElsewhere) {
        const note = document.createElement('div');
        note.className = 'reply-state';
        note.textContent = item.interrupted
          ? 'Interrupted: the editor closed before this reply finished. ChatGPT will not see this partial reply in later messages.'
          : 'Replying in another window…';
        item.bubble.append(note);
      }
    }
    function scheduleRender(id) {
      state.pending.add(id);
      if (!state.renderTimer) state.renderTimer = setTimeout(flushRenders, RENDER_DELAY);
    }
    function flushRenders() {
      clearTimeout(state.renderTimer);
      state.renderTimer = undefined;
      if (!state.pending.size) return;
      for (const id of state.pending) {
        const item = state.messages.get(id);
        if (item) renderBody(item);
      }
      state.pending.clear();
      contentChanged();
    }

    function renderConversation(conversation) {
      const sameChat = Boolean(conversation) && conversation.id === state.conversationId;
      // 0.7.0: a refresh that brings exactly the messages already shown (the
      // history file changed, for example a checkpoint) leaves the page as it
      // is, so a click in progress on a card or button is not lost to a redraw.
      const signature = conversation && state.signedIn ? JSON.stringify(conversation.messages || []) : null;
      if (sameChat && signature !== null && signature === state.renderedSignature && elements.messages.childElementCount && !state.pending.size) return;
      state.renderedSignature = signature;
      const keepScroll = sameChat && !state.follow ? elements.messages.scrollTop : undefined;
      state.conversationId = conversation?.id;
      state.messages = new Map();
      state.pending.clear();
      elements.messages.replaceChildren();
      if (!state.signedIn) {
        const card = document.createElement('div');
        card.className = 'welcome';
        const heading = document.createElement('h2');
        heading.textContent = 'Sign in to chat';
        const text = document.createElement('p');
        text.textContent = 'Sign in through OpenAI. No API key is required. This app cannot read your personal ChatGPT history or memory; conversations here stay local.';
        card.append(heading, text);
        elements.messages.append(card);
        return;
      }
      for (const message of conversation?.messages || []) addMessage(message, true);
      if (keepScroll === undefined) {
        state.follow = true;
        setHidden(elements.jump, true);
        scrollToBottom();
      } else {
        elements.messages.scrollTop = keepScroll;
      }
    }
    function addMessage(message, batch) {
      if (!message || state.messages.has(message.id)) return;
      const container = document.createElement('article');
      container.className = 'message ' + message.role + (message.error ? ' error' : '');
      container.dataset.id = message.id;
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = message.role === 'user' ? 'You' : 'Assistant';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      container.append(role, bubble);
      elements.messages.append(container);
      const item = { container, bubble, role: message.role, content: message.content || '', error: Boolean(message.error), live: false, attachmentTurn: Boolean(message.attachmentTurn), contextPolicy: message.contextPolicy, errorText: state.liveFailures.get(message.id)?.errorText, action: state.liveFailures.get(message.id)?.action, provenance: message.provenance, contextUsed: Array.isArray(message.contextUsed) ? message.contextUsed : [], projectShared: message.projectShared, commands: Array.isArray(message.commands) ? message.commands : [], withoutProjectFiles: Boolean(message.withoutProjectFiles), projectNotSent: Boolean(message.projectNotSent), interrupted: Boolean(message.interrupted), replyingElsewhere: Boolean(message.replyingElsewhere), inProgress: Boolean(message.inProgress), stopped: Boolean(message.stopped) };
      state.messages.set(message.id, item);
      renderBody(item);
      if (Array.isArray(message.attachments) && message.attachments.length) container.append(attachmentChip(message.attachments));
      renderReplyContext(item);
      if (!batch) contentChanged();
    }
    function updateMessage(id, content, error, errorText, action, projectNotSent) {
      const item = state.messages.get(id);
      if (!item) return;
      state.pending.delete(id);
      item.content = content || '';
      item.error = Boolean(error);
      item.errorText = errorText;
      item.action = action;
      if (projectNotSent) item.projectNotSent = true;
      item.inProgress = false;
      if (item.error) state.liveFailures.set(id, { errorText, action }); else state.liveFailures.delete(id);
      item.live = false;
      item.container.classList.toggle('error', item.error);
      renderBody(item);
      renderReplyContext(item);
      contentChanged();
      if (item.role === 'assistant' && item.error) {
        // The failure is shown once, in the message; this only announces it.
        speak(elements.alerts, errorText ? 'Reply incomplete. ' + errorText : item.content);
      } else if (item.role === 'assistant' && item.content) {
        announce('Response complete. ' + spokenText(item.content));
      }
    }
    function appendDelta(id, delta) {
      const item = state.messages.get(id);
      if (!item) return;
      item.content += delta;
      // The first piece of a reply: controls for finished replies go away.
      if (!item.live) { item.live = true; renderReplyContext(item); }
      scheduleRender(id);
    }
    function removeMessage(id) {
      const item = state.messages.get(id);
      if (!item) return;
      state.pending.delete(id);
      item.container.remove();
      state.messages.delete(id);
    }
    function renderModels(models, selected) {
      elements.models.replaceChildren();
      for (const model of models || []) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        option.selected = model.id === selected;
        elements.models.append(option);
      }
      modelTitle();
    }
    // RC2: a narrow composer cuts the model name; its full name is the tooltip.
    function modelTitle() {
      const name = elements.models.selectedOptions[0] ? elements.models.selectedOptions[0].textContent : '';
      elements.models.title = name ? 'Model: ' + name : 'Model';
    }
    // 0.8.0 (DEC-PLANCHAT-040): the Thinking selector shows the level the next
    // Send uses. The host sends the levels each model accepts (src/reasoning.js);
    // the page only shows them, and the host checks every Send again.
    function renderEffort(info) {
      state.reasoning = info || null;
      elements.effort.replaceChildren();
      if (!info) { effortTitle(); renderEffortNote(''); return; }
      const labels = state.narrow ? info.shortLabels : info.labels;
      for (const value of info.options || []) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = labels[value] || value;
        option.title = info.descriptions[value] || '';
        option.selected = value === info.effective;
        elements.effort.append(option);
      }
      effortTitle();
      renderEffortNote(info.note);
    }
    function effortTitle() {
      const info = state.reasoning;
      const value = elements.effort.value;
      elements.effort.title = info && value ? 'Thinking: ' + info.labels[value] + '. ' + info.descriptions[value] : 'Thinking';
    }
    function renderEffortNote(text) {
      elements.effortNote.textContent = text || '';
      setHidden(elements.effortNote, !text);
    }
    // A model change: the chat's level is kept if the new model accepts it;
    // otherwise the next Send uses Default, and the note says so. The host
    // confirms with its own state.
    function effortForModel(model) {
      const info = state.reasoning;
      if (!info) return;
      const options = (info.byModel && info.byModel[model]) || ['default'];
      const effective = options.includes(info.choice) ? info.choice : 'default';
      renderEffort({ ...info, options, effective, note: effective !== info.choice ? info.fallbackNote : '' });
    }
    function effortDefaultButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action secondary effort-action';
      button.textContent = 'Use Default';
      button.title = 'Use the model’s default thinking level for your next message';
      button.addEventListener('click', () => {
        post('selectEffort', { effort: 'default' });
        announce('Thinking set to Default for your next message.');
      });
      return button;
    }
    // The history button shows the open chat's title; the list itself is the
    // editor's Quick Pick (showHistory in the extension).
    function renderConversations(list) {
      const current = (list?.items || []).find((conversation) => conversation.id === list.currentId);
      const title = current?.title || 'New chat';
      elements.chatTitle.textContent = title;
      elements.history.setAttribute('aria-label', 'Chat history. Open chat: ' + title);
      elements.history.title = 'Chat history';
    }
    function hydrate(message) {
      state.signedIn = Boolean(message.session);
      setHidden(elements.signedOut, state.signedIn);
      setHidden(elements.signedIn, !state.signedIn);
      setHidden(elements.accountRow, !state.signedIn);
      elements.accountRow.classList.toggle('panel-row', MODE === 'panel');
      setHidden(elements.conversationRow, !state.signedIn);
      if (!state.signedIn) setAccountOpen(false);
      elements.accountName.textContent = state.signedIn
        ? (message.session.email || message.session.name || 'ChatGPT account')
        : '';
      // Only for a session whose requests use the ChatGPT plan.
      setHidden(elements.planRow, !(state.signedIn && message.planUsage));
      setHidden(elements.planNote, !(state.signedIn && message.planUsage));
      renderModels(message.models, message.selectedModel);
      state.shownChat = message.conversation ? message.conversation.id : undefined;
      renderEffort(state.signedIn ? message.reasoning : null);
      renderConversations(message.conversationList);
      renderConversation(message.conversation);
      renderAttachment(message.attachment, null);
      showError(message.modelError || '', message.modelErrorAction);
      if (message.streaming !== undefined) setStreaming(Boolean(message.streaming));
      renderOtherReply(message.otherReply);
      restoreSavedDraft(message.draft);
      rememberChat(message.conversation && message.conversation.id);
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'hydrate': renderContext(message.context); renderReadOnly(message.readOnly, message.conversation); hydrate(message); break;
        case 'projectState': renderContext(message.context); break;
        // 0.8.0: only for the chat shown here (a late answer for a chat this
        // page has left is ignored), checked against the model selected here.
        case 'reasoning':
          if (message.chatId && state.shownChat && message.chatId !== state.shownChat) break;
          renderEffort(message.reasoning);
          effortForModel(elements.models.value);
          break;
        case 'conversation':
          renderContext(message.context);
          renderConversations(message.conversationList);
          renderReadOnly(message.readOnly, message.conversation);
          renderConversation(message.conversation);
          if (message.otherReply !== undefined) renderOtherReply(message.otherReply);
          // 0.8.0: the shown chat's Thinking level, for the model selected here.
          state.shownChat = message.conversation ? message.conversation.id : undefined;
          if (message.reasoning && state.signedIn) { renderEffort(message.reasoning); effortForModel(elements.models.value); }
          dropSentDraft(message.conversation);
          restoreSavedDraft(message.draft);
          rememberChat(message.conversation && message.conversation.id);
          break;
        case 'conversationList': renderConversations(message.conversationList); break;
        case 'messageAdded': addMessage(message.message); break;
        case 'assistantDelta': appendDelta(message.messageId, message.delta); break;
        case 'messageUpdated': updateMessage(message.messageId, message.content, message.error, message.errorText, message.action, message.projectNotSent); break;
        case 'messageRemoved': removeMessage(message.messageId); break;
        case 'streamState': setStreaming(message.streaming); if (message.otherReply !== undefined) renderOtherReply(message.otherReply); break;
        case 'busy': setBusy(message.busy, message.label); break;
        case 'attachment': renderAttachment(message.attachment, message.notice); break;
        case 'consent': renderConsent(message.consent, message.notice); break;
        case 'command': renderCommand(message.command); break;
        case 'commandOutput': renderOutputCard(message.card); break;
        case 'proposals': renderProposals(message.chatId, message.proposals); break;
        case 'messagePolicy': {
          const item = state.messages.get(message.messageId);
          if (item) {
            item.contextPolicy = message.contextPolicy;
            renderReplyContext(item);
            announce(message.contextPolicy === 'included' ? 'This reply will be sent with follow-up messages.' : 'This reply will not be sent with follow-up messages.');
            item.replyContext?.querySelector('button')?.focus();
          }
          break;
        }
        case 'error': showError(message.message, message.action); break;
        case 'restoreDraft':
          // A refused message comes back for correction, unless the user has
          // already started typing something else.
          if (!elements.prompt.value) {
            elements.prompt.value = message.text; fitPrompt();
            elements.prompt.focus();
            saveDraftSoon();
          }
          break;
        case 'contextNote':
          elements.contextNote.textContent = message.text || '';
          setHidden(elements.contextNote, !message.text);
          break;
        case 'focusControl':
          if (message.id === 'history') elements.history.focus();
          // 0.4.0: a chat tab became active. A waiting consent card comes first.
          if (message.id === 'prompt') {
            if (state.consent) elements.consentTitle.focus();
            else if (!elements.signedIn.classList.contains('hidden')) elements.prompt.focus();
          }
          break;
        case 'copied':
          announce('Copied.');
          if (state.copyButton) {
            const button = state.copyButton;
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = 'Copy'; }, 1500);
          }
          break;
      }
    });

    elements.messages.addEventListener('scroll', () => {
      state.follow = nearBottom();
      if (state.follow) setHidden(elements.jump, true);
    });
    window.addEventListener('resize', () => { if (state.follow) scrollToBottom(); });
    elements.jump.addEventListener('click', () => {
      state.follow = true;
      scrollToBottom();
      setHidden(elements.jump, true);
      elements.messages.focus({ preventScroll: true });
    });
    // A link in a message opens only after the extension shows its full
    // address and the user agrees. The click is stopped here, so the editor's
    // own webview link handling (which opens the browser at once) never sees it.
    function openLinkFrom(event) {
      const link = event.target.closest && event.target.closest('a[href]');
      if (!link) return false;
      event.preventDefault();
      event.stopPropagation();
      post('openLink', { url: link.getAttribute('href') });
      return true;
    }
    elements.messages.addEventListener('auxclick', (event) => {
      if (event.button === 1) openLinkFrom(event);
    });
    // Copy goes through the extension so the code is copied exactly.
    elements.messages.addEventListener('click', (event) => {
      if (openLinkFrom(event)) return;
      const reply = event.target.closest && event.target.closest('button[data-reply-context]');
      if (reply) {
        const article = reply.closest('article');
        post('setReplyContext', { messageId: article && article.dataset.id, include: reply.dataset.replyContext === 'include' });
        return;
      }
      const copy = event.target.closest && event.target.closest('button[data-copy]');
      if (copy) {
        state.copyButton = copy;
        post('copyText', { text: typeof copy.copySource === 'string' ? copy.copySource : '' });
      }
    });

    elements.account.addEventListener('click', () => setAccountOpen(elements.accountPanel.classList.contains('hidden')));
    // Escape anywhere in the page closes an open Account panel. Listening only
    // on the button and panel missed it when a click had left focus on the
    // page body (seen on the first click into the view in Antigravity).
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.accountPanel.classList.contains('hidden')) {
        event.preventDefault();
        setAccountOpen(false, true);
      }
    });
    document.addEventListener('click', (event) => {
      if (!elements.accountPanel.contains(event.target) && !elements.account.contains(event.target)) setAccountOpen(false);
    });
    elements.signIn.addEventListener('click', () => { showError(''); post('signIn'); });
    elements.manageUsage.addEventListener('click', () => post('manageUsage'));
    elements.manageSharing.addEventListener('click', () => post('manageProjectSharing'));
    elements.consentAllow.addEventListener('click', () => decideConsent('allow'));
    elements.commandRun.addEventListener('click', () => decideCommand('run'));
    elements.commandDecline.addEventListener('click', () => decideCommand('decline'));
    elements.outputShare.addEventListener('click', () => decideOutput('share'));
    elements.outputWithhold.addEventListener('click', () => decideOutput('withhold'));
    elements.consentWithout.addEventListener('click', () => decideConsent('without'));
    elements.consentCancel.addEventListener('click', () => decideConsent('cancel'));
    elements.consentCard.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); decideConsent('cancel'); }
    });
    // The extension asks for confirmation before anything is signed out.
    elements.signOut.addEventListener('click', () => {
      setAccountOpen(false, true);
      post('signOut');
    });
    // New Chat lives in the view's title bar (and in this list), not here.
    elements.history.addEventListener('click', () => post('showHistory'));
    elements.projectPicker.addEventListener('click', () => post('chooseProject'));
    elements.readOnlyMove.addEventListener('click', () => post('moveReadOnly'));
    elements.readOnlyBack.addEventListener('click', () => post('leaveReadOnly'));
    elements.attach.addEventListener('click', () => {
      state.attachFromView = true;
      post('attachSelection');
    });
    // 0.7.0 RC2 (DEC-PLANCHAT-035): the editor tab's composer holds the model
    // selector (the same native select, moved) and a + menu for the actions
    // Kenlith has. The side bar view keeps its own layout.
    // The editor tab's message box grows with its text (up to 40% of the
    // view; CSS max-height), instead of a resize handle.
    function fitPrompt() {
      if (MODE !== 'panel') return;
      elements.prompt.style.height = 'auto';
      elements.prompt.style.height = elements.prompt.scrollHeight + 2 + 'px';
    }
    elements.prompt.addEventListener('input', fitPrompt);
    new MutationObserver(fitPrompt).observe(elements.prompt, { attributes: true, attributeFilter: ['disabled'] });
    window.addEventListener('resize', fitPrompt);
    if (MODE === 'panel') {
      elements.modelSlot.append(elements.models);
      elements.models.classList.add('composer-model');
      // 0.8.0: Thinking follows the model, in the same style.
      elements.modelSlot.append(elements.effortLabel, elements.effort);
      elements.effort.classList.add('composer-model');
      setHidden(elements.modelLabel, true);
      setHidden(elements.attach, true);
      setHidden(elements.plus, false);
    }
    const menuItems = () => [...elements.plusMenu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled);
    function setMenuOpen(open, focusButton) {
      setHidden(elements.plusMenu, !open);
      elements.plus.setAttribute('aria-expanded', String(open));
      if (open) menuItems()[0]?.focus();
      else if (focusButton) elements.plus.focus();
    }
    elements.plus.addEventListener('click', () => setMenuOpen(elements.plusMenu.classList.contains('hidden')));
    elements.plus.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true); if (event.key === 'ArrowUp') menuItems().at(-1)?.focus(); }
    });
    elements.plusMenu.addEventListener('keydown', (event) => {
      const items = menuItems();
      const at = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false, true); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
      else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
      else if (event.key === 'Tab') setMenuOpen(false);
    });
    document.addEventListener('click', (event) => {
      if (!elements.plusMenu.classList.contains('hidden') && !elements.plusMenu.contains(event.target) && !elements.plus.contains(event.target)) setMenuOpen(false);
    });
    const fromMenu = (action) => () => { setMenuOpen(false, true); action(); };
    elements.menuAttach.addEventListener('click', fromMenu(() => { state.attachFromView = true; post('attachSelection'); }));
    elements.menuSharing.addEventListener('click', fromMenu(() => post('manageProjectSharing')));
    elements.menuSettings.addEventListener('click', fromMenu(() => post('openProjectSettings')));
    elements.attachConfirm.addEventListener('change', () => {
      if (state.attachment) elements.attachApprove.disabled = !elements.attachConfirm.checked;
    });
    elements.attachApprove.addEventListener('click', () => {
      if (state.attachment) post('approveAttachment', { id: state.attachment.id, reviewed: elements.attachConfirm.checked });
    });
    elements.attachRefresh.addEventListener('click', () => {
      if (state.attachment) {
        state.attachFromView = true;
        post('refreshAttachment', { id: state.attachment.id });
      }
    });
    elements.attachRemove.addEventListener('click', () => {
      if (state.attachment) {
        post('removeAttachment', { id: state.attachment.id });
        (MODE === 'panel' ? elements.plus : elements.attach).focus();
      }
    });
    elements.attachNoticeClose.addEventListener('click', () => {
      setHidden(elements.attachNotice, true);
      elements.prompt.focus();
    });

    // The window's context (stage 2): a project folder, or General with the
    // reason. A picker only where there is a choice (multi-root windows).
    function renderContext(info) {
      if (!info) return;
      let text = info.label;
      if (info.kind === 'project' && !info.available) text += ' (folder unavailable)';
      if (info.kind === 'general') {
        const reasons = { remote: ' (remote folder)', choose: ' (choose a project)', 'folder-removed': ' (folder removed)' };
        text = 'General' + (reasons[info.reason] || '');
      }
      // 0.5.0: what Kenlith knows locally vs what is shared with OpenAI.
      const states = {
        'not-shared': ['not shared', 'Kenlith sees this project on this computer. Nothing from it is sent until you allow it in a chat.'],
        shared: ['shared', 'You allowed Kenlith to send short excerpts of this project with your questions. Manage project sharing stops it.'],
        off: ['files off', 'Project context is turned off in settings: Kenlith does not read or send project files.']
      };
      const state = info.kind === 'project' && info.available !== false ? states[info.sharing] : undefined;
      for (const element of [elements.projectStatic, elements.projectPicker, elements.panelContext]) {
        element.querySelector('.project-text').textContent = text;
        element.querySelector('.project-state').textContent = state ? state[0] : '';
      }
      setHidden(elements.panelContext, MODE !== 'panel');
      setHidden(elements.projectStatic, info.canChoose);
      setHidden(elements.projectPicker, !info.canChoose);
      elements.projectPicker.setAttribute('aria-label', 'Context: ' + text + (state ? ', ' + state[0] : '') + '. Choose project');
      elements.projectStatic.title = 'Chats in this list belong to: ' + text + (state ? '. ' + state[1] : '');
      elements.projectPicker.title = state ? state[1] : '';
      elements.panelContext.title = state ? state[1] : '';
      elements.notice.textContent = info.regenerated
        ? 'The project identity key was recreated. Earlier project chats are under All Chats, Earlier identity key; none were deleted.'
        : '';
      setHidden(elements.notice, !info.regenerated);
    }

    // A chat of another context, shown read-only until moved here.
    function renderReadOnly(info, conversation) {
      state.readOnly = Boolean(info);
      setHidden(elements.readOnlyBar, !info);
      updateSend();
      // RC2: in the editor tab, attach lives under +; neither is offered read-only.
      setHidden(elements.attach, state.readOnly || MODE === 'panel');
      setHidden(elements.plus, state.readOnly || MODE !== 'panel');
      if (state.readOnly) setMenuOpen(false);
      if (!info) return;
      elements.readOnlyText.textContent = 'Read-only: this chat is in ' + info.sectionLabel + (info.label ? ' (' + info.label + ')' : '') + '.';
      elements.readOnlyMove.textContent = info.action ? info.action.label : '';
      setHidden(elements.readOnlyMove, !info.action);
      // An editor tab shows one chat; "Back to my chat" belongs to the side bar layout.
      setHidden(elements.readOnlyBack, info.back === false);
      if (conversation) {
        elements.chatTitle.textContent = conversation.title || 'New chat';
        elements.history.setAttribute('aria-label', 'Chat history. Showing read-only: ' + (conversation.title || 'New chat'));
      }
    }
    elements.stop.addEventListener('click', () => {
      post('stop');
      announce('Stopping the response.');
    });
    elements.models.addEventListener('change', () => { modelTitle(); effortForModel(elements.models.value); post('selectModel', { model: elements.models.value }); });
    // 0.8.0: a new level applies from the next Send; a reply in progress keeps its own.
    elements.effort.addEventListener('change', () => {
      if (state.reasoning) state.reasoning = { ...state.reasoning, choice: elements.effort.value, effective: elements.effort.value, note: '' };
      effortTitle();
      renderEffortNote('');
      post('selectEffort', { effort: elements.effort.value });
    });
    // A narrow composer uses the short labels (XHigh) and hides the word Thinking.
    if (self.ResizeObserver) {
      new ResizeObserver(() => {
        const narrow = elements.composerBar.getBoundingClientRect().width < 380;
        if (narrow === Boolean(state.narrow)) return;
        state.narrow = narrow;
        if (narrow) document.body.dataset.narrow = ''; else delete document.body.dataset.narrow;
        if (state.reasoning) renderEffort(state.reasoning);
      }).observe(elements.composerBar);
    }
    elements.send.addEventListener('click', send);
    elements.prompt.addEventListener('input', () => { state.filledFromDraft = undefined; saveDraftSoon(); });
    // Escape in the message box stops a reply that is streaming.
    elements.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.streaming && !state.consent) {
        event.preventDefault();
        post('stop');
        announce('Stopping the response.');
      }
    });
    elements.otherReplyShow.addEventListener('click', () => post('showOtherReply'));
    elements.otherReplyStop.addEventListener('click', () => { post('stopOtherReply'); announce('Stopping the other reply.'); });
    elements.prompt.addEventListener('keydown', (event) => {
      // Enter that confirms an IME composition is not a send.
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      send();
    });
    function sendIdOf() {
      return (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    }
    function send() {
      const text = elements.prompt.value.trim();
      if (!text) return;
      if (state.readOnly) {
        announce('This chat is read-only here. Move it here first, or go back to your chat.');
        return;
      }
      if (state.otherReply) {
        announce('Kenlith is replying in another chat. Send this when that reply ends.');
        return;
      }
      if (state.streaming || state.busy) {
        // The draft stays in the input; one request at a time.
        announce('Wait for the current response to finish, or press Stop.');
        return;
      }
      if (state.attachment && !state.attachment.approved) {
        announce('Approve or remove the attached code first.');
        return;
      }
      if (state.consent) {
        announce('Choose whether to share project files for your previous message first.');
        elements.consentTitle.focus();
        return;
      }
      elements.prompt.value = ''; fitPrompt();
      showError('');
      state.follow = true;
      // Only the attachment's id: the extension sends the text it captured.
      clearTimeout(state.draftTimer);
      // A new id per Send: the extension sends a message once even if this arrives twice.
      // 0.8.0: the Thinking level shown is the level requested (checked again by the host).
      post('send', { text, model: elements.models.value, effort: state.reasoning && elements.effort.value ? elements.effort.value : undefined, attachmentId: state.attachment ? state.attachment.id : undefined, sendId: sendIdOf(), draftRev: Date.now() });
    }

    post('ready');
  </script>
</body>
</html>`;
}

module.exports = { getWebviewHtml, projectFooterLabel, relativeTime };
// 0.3.0 name of the host class, kept for callers and tests: the engine.
Object.defineProperty(module.exports, 'ChatViewProvider', { enumerable: true, get: () => require('./engine').ChatEngine });
