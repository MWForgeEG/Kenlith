// Safe Markdown for chat messages. Runs in two places: under Node (tests, and
// the host's link check) and inside the webview, where view.js inlines this
// file into a nonce script. It must not contain a closing script tag.
//
// parse() turns text into a plain tree; render() builds DOM nodes from it with
// createElement, setAttribute (allowlisted names) and textContent only. Raw
// HTML in a message is never interpreted: it stays visible text.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PlanChatMarkdown = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MAX_DEPTH = 12;
  const MAX_URL_LENGTH = 2048;
  // Longer messages are shown as plain text, so rendering stays fast on any input.
  const MAX_MARKDOWN_LENGTH = 200000;

  // ---------- URLs ----------

  // Only absolute http(s) URLs without credentials become links. Everything
  // else (javascript:, data:, file:, command:, vscode:, relative) stays text.
  function safeUrl(raw) {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    if (!value || value.length > MAX_URL_LENGTH) return undefined;
    if (/[\u0000-\u0020\u007F-\u009F]/.test(value)) return undefined;
    let url;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  }

  // ---------- direction ----------

  const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
  const LETTER = /\p{L}/u;

  // Direction of the first strong letter, ignoring inline code.
  function firstStrongDirection(text) {
    for (const char of text) {
      if (RTL_CHAR.test(char)) return 'rtl';
      if (LETTER.test(char)) return 'ltr';
    }
    return undefined;
  }

  // Text that decides a block's direction. Like dir="auto" in the browser, it
  // skips parts that carry their own direction: code, paths and links.
  function plainText(nodes) {
    let text = '';
    for (const node of nodes || []) {
      if (node.type === 'text') text += node.text;
      else if (node.type === 'break') text += '\n';
      else if (node.type === 'strong' || node.type === 'em') text += plainText(node.children);
    }
    return text;
  }

  // Direction for a container (list, quote), from its first block with text.
  // Containers get it explicitly: dir="auto" on them would skip the inner
  // paragraphs (they carry their own dir) and fall back to left-to-right,
  // putting list markers and quote bars on the wrong side.
  function blockDirection(blocks) {
    for (const block of blocks || []) {
      if (block.type === 'paragraph' || block.type === 'heading') {
        const direction = firstStrongDirection(plainText(block.children));
        if (direction) return direction;
      } else if ((block.type === 'list' || block.type === 'quote') && block.dir) {
        return block.dir;
      }
    }
    return undefined;
  }

  // ---------- blocks ----------

  function expandIndent(line) {
    const match = /^[ \t]*/.exec(line)[0];
    let width = 0;
    for (const char of match) width = char === '\t' ? width + 4 - (width % 4) : width + 1;
    return { width, rest: line.slice(match.length) };
  }

  function indentOf(line) {
    return expandIndent(line).width;
  }

  // Removes up to `count` columns of leading indentation.
  function removeIndent(line, count) {
    const { width, rest } = expandIndent(line);
    if (width <= count) return rest;
    return ' '.repeat(width - count) + rest;
  }

  const isBlank = (line) => /^[ \t]*$/.test(line);

  function nextNonBlank(lines, from) {
    let index = from;
    while (index < lines.length && isBlank(lines[index])) index += 1;
    return index;
  }
  const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}>[ ]?/;
  const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;

  function listMarker(line) {
    const match = LIST_ITEM.exec(line);
    if (!match) return undefined;
    const marker = match[2];
    const ordered = /\d/.test(marker);
    let spacing = match[3].length;
    if (spacing > 4 || spacing === 0) spacing = 1;
    return {
      ordered,
      symbol: ordered ? marker.slice(-1) : marker,
      start: ordered ? Number.parseInt(marker, 10) : undefined,
      contentIndent: match[1].length + marker.length + spacing,
      content: line.slice(match[0].length)
    };
  }

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || Boolean(listMarker(line));
  }

  function parseBlocks(lines, depth) {
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (isBlank(line)) {
        index += 1;
        continue;
      }

      const fence = FENCE.exec(line);
      if (fence) {
        const indent = fence[1].length;
        const mark = fence[2];
        const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
        const body = [];
        let closed = false;
        index += 1;
        while (index < lines.length) {
          if (close.test(lines[index])) {
            closed = true;
            index += 1;
            break;
          }
          body.push(indent ? removeIndentKeepTabs(lines[index], indent) : lines[index]);
          index += 1;
        }
        blocks.push({ type: 'code', lang: fence[3] || '', text: body.join('\n'), open: !closed });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] || '', depth) });
        index += 1;
        continue;
      }

      if (RULE.test(line)) {
        blocks.push({ type: 'rule' });
        index += 1;
        continue;
      }

      if (QUOTE.test(line) && depth < MAX_DEPTH) {
        const inner = [];
        while (index < lines.length && QUOTE.test(lines[index])) {
          inner.push(lines[index].replace(QUOTE, ''));
          index += 1;
        }
        const children = parseBlocks(inner, depth + 1);
        blocks.push({ type: 'quote', children, dir: blockDirection(children) });
        continue;
      }

      const first = listMarker(line);
      if (first && depth < MAX_DEPTH) {
        const list = { type: 'list', ordered: first.ordered, start: first.start, items: [] };
        let marker = first;
        while (marker && marker.ordered === list.ordered && marker.symbol === first.symbol) {
          const itemLines = [marker.content];
          index += 1;
          while (index < lines.length) {
            const next = lines[index];
            if (isBlank(next)) {
              // A run of blank lines is looked at once, not once per line.
              const ahead = nextNonBlank(lines, index);
              if (ahead < lines.length && indentOf(lines[ahead]) >= marker.contentIndent) {
                for (; index < ahead; index += 1) itemLines.push('');
                continue;
              }
              break;
            }
            if (indentOf(next) >= marker.contentIndent) {
              itemLines.push(removeIndent(next, marker.contentIndent));
              index += 1;
              continue;
            }
            if (startsBlock(next)) break;
            if (isBlank(itemLines[itemLines.length - 1])) break;
            itemLines.push(next.trim()); // lazy continuation of the item's paragraph
            index += 1;
          }
          list.items.push({ children: parseBlocks(itemLines, depth + 1) });
          if (index < lines.length && isBlank(lines[index])) {
            const ahead = nextNonBlank(lines, index);
            const again = ahead < lines.length && listMarker(lines[ahead]);
            if (again && again.ordered === list.ordered && again.symbol === first.symbol) index = ahead;
          }
          marker = index < lines.length ? listMarker(lines[index]) : undefined;
        }
        list.dir = blockDirection(list.items[0]?.children);
        blocks.push(list);
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index])) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n'), depth) });
    }
    return blocks;
  }

  // Inside a fenced block only spaces up to the fence's own indentation go.
  function removeIndentKeepTabs(line, count) {
    let removed = 0;
    while (removed < count && line[removed] === ' ') removed += 1;
    return line.slice(removed);
  }

  // ---------- inline ----------

  const PUNCTUATION = /[!-/:-@[-`{-~]/;
  const WORD = /[\p{L}\p{N}]/u;
  // Paths and dotted names in prose are kept left-to-right as a unit.
  const PATH = /(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+[\\/])+[\w.@+-]*[\w@+-]/g;

  // Longest link label looked at; a longer one stays text.
  const MAX_LABEL = 1000;
  const BACKTICKS = /`+/y;
  const BARE_URL = /https?:\/\/[^\s<>"]+/iy;
  const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/iy;

  function matchAt(pattern, text, index) {
    pattern.lastIndex = index;
    return pattern.exec(text);
  }

  // `failed` remembers where a search for a closing delimiter already ran to
  // the end without success, so a later search for the same delimiter from
  // further on returns at once. This keeps long unmatched runs linear.
  function parseInline(text, depth = 0) {
    const failed = new Map();
    const nodes = [];
    let buffer = '';
    const flush = () => {
      if (buffer) nodes.push(...isolatePaths(buffer));
      buffer = '';
    };
    let index = 0;
    while (index < text.length) {
      const char = text[index];

      if (char === '\\' && index + 1 < text.length && PUNCTUATION.test(text[index + 1])) {
        buffer += text[index + 1];
        index += 2;
        continue;
      }
      if (char === '\n') {
        flush();
        nodes.push({ type: 'break' });
        index += 1;
        continue;
      }
      if (char === '`') {
        const run = matchAt(BACKTICKS, text, index)[0];
        const end = findClosingRun(text, index + run.length, run.length, failed);
        if (end !== -1) {
          flush();
          let code = text.slice(index + run.length, end).replace(/\n/g, ' ');
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
          nodes.push({ type: 'code', text: code });
          index = end + run.length;
          continue;
        }
        buffer += run;
        index += run.length;
        continue;
      }
      if (depth < MAX_DEPTH && (text.startsWith('**', index) || text.startsWith('__', index))) {
        const marker = text.slice(index, index + 2);
        const end = opens(text, index, 2, marker) ? findEmphasisEnd(text, index + 2, marker, failed) : -1;
        if (end !== -1) {
          flush();
          nodes.push({ type: 'strong', children: parseInline(text.slice(index + 2, end), depth + 1) });
          index = end + 2;
          continue;
        }
      }
      if (depth < MAX_DEPTH && (char === '*' || char === '_')) {
        const end = opens(text, index, 1, char) ? findEmphasisEnd(text, index + 1, char, failed) : -1;
        if (end !== -1) {
          flush();
          nodes.push({ type: 'em', children: parseInline(text.slice(index + 1, end), depth + 1) });
          index = end + 1;
          continue;
        }
      }
      if (char === '!' && text[index + 1] === '[') {
        const link = parseLink(text, index + 1, failed);
        if (link) {
          flush();
          nodes.push({ type: 'image', alt: link.label, href: safeUrl(link.url) });
          index = link.end;
          continue;
        }
      }
      if (char === '[' && depth < MAX_DEPTH) {
        const link = parseLink(text, index, failed);
        if (link) {
          flush();
          const href = safeUrl(link.url);
          nodes.push(href
            ? { type: 'link', href, children: parseInline(link.label, depth + 1) }
            : { type: 'text', text: text.slice(index, link.end) });
          index = link.end;
          continue;
        }
      }
      if (char === '<') {
        const auto = matchAt(AUTOLINK, text, index);
        const href = auto && safeUrl(auto[1]);
        if (href) {
          flush();
          nodes.push({ type: 'link', href, children: [{ type: 'text', text: auto[1] }] });
          index += auto[0].length;
          continue;
        }
      }
      if ((char === 'h' || char === 'H') && !WORD.test(text[index - 1] || ' ')) {
        const bare = matchAt(BARE_URL, text, index);
        if (bare) {
          const url = trimUrl(bare[0]);
          const href = safeUrl(url);
          if (href) {
            flush();
            nodes.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
            index += url.length;
            continue;
          }
        }
      }
      buffer += char;
      index += 1;
    }
    flush();
    return nodes;
  }

  function findClosingRun(text, from, length, failed) {
    const key = `run:${length}`;
    if (failed.has(key) && failed.get(key) <= from) return -1;
    let index = from;
    while (index < text.length) {
      if (text[index] === '`') {
        const run = matchAt(BACKTICKS, text, index)[0];
        if (run.length === length) return index;
        index += run.length;
      } else {
        index += 1;
      }
    }
    failed.set(key, from);
    return -1;
  }

  // An opening delimiter is followed by a non-space; `_` must not sit inside a word.
  function opens(text, index, length, marker) {
    const after = text[index + length];
    if (!after || /\s/.test(after)) return false;
    if (marker[0] === '_' && WORD.test(text[index - 1] || ' ')) return false;
    return true;
  }

  function findEmphasisEnd(text, from, marker, failed) {
    const key = `em:${marker}`;
    if (failed.has(key) && failed.get(key) <= from) return -1;
    let index = from + 1;
    while (index < text.length) {
      if (text[index] === '`') {
        const run = matchAt(BACKTICKS, text, index)[0];
        const end = findClosingRun(text, index + run.length, run.length, failed);
        index = end === -1 ? index + run.length : end + run.length;
        continue;
      }
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text.startsWith(marker, index) && !/\s/.test(text[index - 1])) {
        if (marker === '*' && text[index + 1] === '*') {
          index += 2;
          continue;
        }
        if (marker[0] === '_' && WORD.test(text[index + marker.length] || ' ')) {
          index += 1;
          continue;
        }
        return index;
      }
      index += 1;
    }
    failed.set(key, from);
    return -1;
  }

  // [label](url "title") starting at the "[" at `start`.
  function parseLink(text, start, failed) {
    let depth = 0;
    let index = start;
    const limit = Math.min(text.length, start + MAX_LABEL);
    for (; index < limit; index += 1) {
      const char = text[index];
      if (char === '\\') {
        index += 1;
      } else if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) break;
      } else if (char === '\n' && text[index + 1] === '\n') {
        return undefined;
      }
    }
    if (depth !== 0 || text[index + 1] !== '(') return undefined;
    const label = text.slice(start + 1, index);
    let cursor = index + 2;
    while (text[cursor] === ' ') cursor += 1;
    // No ")" anywhere after here means no link can end: remember that.
    if (failed.has('paren') && failed.get('paren') <= cursor) return undefined;
    if (text.indexOf(')', cursor) === -1) {
      failed.set('paren', cursor);
      return undefined;
    }
    let url = '';
    if (text[cursor] === '<') {
      const close = text.indexOf('>', cursor);
      if (close === -1 || close - cursor > MAX_URL_LENGTH) return undefined;
      url = text.slice(cursor + 1, close);
      cursor = close + 1;
    } else {
      let parens = 0;
      const urlLimit = Math.min(text.length, cursor + MAX_URL_LENGTH + 1);
      while (cursor < urlLimit) {
        const char = text[cursor];
        if (/\s/.test(char)) break;
        if (char === '(') parens += 1;
        if (char === ')') {
          if (parens === 0) break;
          parens -= 1;
        }
        url += char;
        cursor += 1;
      }
    }
    // An optional title is accepted and dropped.
    const tail = /^(?:[ \t\n]+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?[ \t]*\)/.exec(text.slice(cursor, cursor + 320));
    if (!tail) return undefined;
    return { label, url, end: cursor + tail[0].length };
  }

  function trimUrl(url) {
    let result = url;
    while (/[.,;:!?'"\u060C\u061B)\]}*_]$/.test(result)) {
      if (result.endsWith(')')) {
        const opened = (result.match(/\(/g) || []).length;
        const closed = (result.match(/\)/g) || []).length;
        if (closed <= opened) break;
      }
      result = result.slice(0, -1);
    }
    return result;
  }

  function isolatePaths(text) {
    const nodes = [];
    let last = 0;
    for (const match of text.matchAll(PATH)) {
      if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) });
      nodes.push({ type: 'ltr', text: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
    return nodes;
  }

  function parse(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    return parseBlocks(source.split('\n'), 0);
  }

  // ---------- rendering ----------

  // Directional controls inside code are shown as visible markers, so code
  // cannot be made to look different from what it is. Copy keeps them.
  const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

  function appendCodeText(doc, parent, text) {
    let last = 0;
    for (const match of text.matchAll(BIDI_CONTROL)) {
      if (match.index > last) parent.append(doc.createTextNode(text.slice(last, match.index)));
      const mark = element(doc, 'span', { class: 'bidi-mark', title: 'Hidden direction character' });
      mark.textContent = `[U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`;
      parent.append(mark);
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
  }

  const ALLOWED_ATTRIBUTES = new Set(['class', 'dir', 'href', 'title', 'start', 'type', 'aria-label', 'data-copy']);

  function element(doc, tag, attributes = {}) {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === null) continue;
      if (!ALLOWED_ATTRIBUTES.has(name)) throw new Error(`attribute not allowed: ${name}`);
      node.setAttribute(name, String(value));
    }
    return node;
  }

  function renderInline(doc, parent, nodes) {
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          parent.append(doc.createTextNode(node.text));
          break;
        case 'ltr': {
          const span = element(doc, 'span', { dir: 'ltr', class: 'ltr' });
          span.textContent = node.text;
          parent.append(span);
          break;
        }
        case 'break':
          parent.append(element(doc, 'br'));
          break;
        case 'code': {
          const code = element(doc, 'code', { dir: 'ltr' });
          appendCodeText(doc, code, node.text);
          parent.append(code);
          break;
        }
        case 'strong':
        case 'em': {
          const wrapper = element(doc, node.type);
          renderInline(doc, wrapper, node.children);
          parent.append(wrapper);
          break;
        }
        case 'link': {
          const link = element(doc, 'a', { href: node.href, title: node.href, dir: 'auto' });
          renderInline(doc, link, node.children);
          parent.append(link);
          break;
        }
        case 'image': {
          // Never loaded: shown as a link to the image, or as its text.
          const label = `Image: ${node.alt || 'untitled'}`;
          if (node.href) {
            const link = element(doc, 'a', { href: node.href, title: node.href, dir: 'auto' });
            link.textContent = label;
            parent.append(link);
          } else {
            parent.append(doc.createTextNode(label));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  function renderCode(doc, parent, text, lang) {
    const block = element(doc, 'div', { class: 'code-block', dir: 'ltr' });
    const head = element(doc, 'div', { class: 'code-head' });
    const label = element(doc, 'span', { class: 'code-lang' });
    label.textContent = lang || 'text';
    const copy = element(doc, 'button', { type: 'button', class: 'copy', 'aria-label': `Copy ${lang || 'text'} code`, 'data-copy': '' });
    copy.textContent = 'Copy';
    copy.copySource = text; // exact original text, read by the Copy handler
    head.append(label, copy);
    const pre = element(doc, 'pre', { dir: 'ltr' });
    const code = element(doc, 'code');
    appendCodeText(doc, code, text);
    pre.append(code);
    block.append(head, pre);
    parent.append(block);
  }

  function renderBlocks(doc, parent, blocks) {
    for (const block of blocks) {
      switch (block.type) {
        case 'paragraph': {
          const paragraph = element(doc, 'p', { dir: 'auto' });
          renderInline(doc, paragraph, block.children);
          parent.append(paragraph);
          break;
        }
        case 'heading': {
          const heading = element(doc, `h${Math.min(6, block.level + 2)}`, { dir: 'auto' });
          renderInline(doc, heading, block.children);
          parent.append(heading);
          break;
        }
        case 'rule':
          parent.append(element(doc, 'hr'));
          break;
        case 'quote': {
          const quote = element(doc, 'blockquote', { dir: block.dir });
          renderBlocks(doc, quote, block.children);
          parent.append(quote);
          break;
        }
        case 'list': {
          const list = element(doc, block.ordered ? 'ol' : 'ul', {
            dir: block.dir,
            start: block.ordered && block.start !== 1 ? block.start : undefined
          });
          for (const item of block.items) {
            // Items take the list's direction, so markers stay on one side.
            const entry = element(doc, 'li');
            renderBlocks(doc, entry, item.children);
            list.append(entry);
          }
          parent.append(list);
          break;
        }
        case 'code':
          renderCode(doc, parent, block.text, block.lang);
          break;
        default:
          break;
      }
    }
  }

  // Markdown message (assistant replies).
  function render(doc, text) {
    if (String(text ?? '').length > MAX_MARKDOWN_LENGTH) return renderPlain(doc, text);
    const fragment = doc.createDocumentFragment();
    renderBlocks(doc, fragment, parse(text));
    return fragment;
  }

  // Plain message (the user's own text and error text): every line keeps its
  // characters and gets its own direction; only fenced code is set apart.
  function renderPlain(doc, text) {
    const fragment = doc.createDocumentFragment();
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    while (index < lines.length) {
      const fence = FENCE.exec(lines[index]);
      if (fence) {
        const mark = fence[2];
        const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
        const body = [];
        index += 1;
        while (index < lines.length && !close.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1;
        renderCode(doc, fragment, body.join('\n'), fence[3]);
        continue;
      }
      const line = element(doc, 'div', { class: 'line', dir: 'auto' });
      line.textContent = lines[index];
      fragment.append(line);
      index += 1;
    }
    return fragment;
  }

  return { parse, parseInline, render, renderPlain, safeUrl, firstStrongDirection, ALLOWED_ATTRIBUTES };
});
