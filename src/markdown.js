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
  // 0.9.0: a bare address ends at a private-use character (a citation token).
  const BARE_URL = /https?:\/\/[^\s<>"\uE000-\uF8FF]+/iy;
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
    // 0.9.0: inside code a citation is not drawn; its covered text comes back.
    if (citeContext) text = restoreCites(text);
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
          if (citeContext && node.text.includes(CITE_OPEN)) appendCitedText(doc, parent, node.text, (part) => doc.createTextNode(part));
          else parent.append(doc.createTextNode(node.text));
          break;
        case 'ltr': {
          const span = element(doc, 'span', { dir: 'ltr', class: 'ltr' });
          if (citeContext && node.text.includes(CITE_OPEN)) appendCitedText(doc, span, node.text, (part) => doc.createTextNode(part));
          else span.textContent = node.text;
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
    if (citeContext) text = restoreCites(text);
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

  // ---------- citations (Kenlith 0.9.0 Deep Research) ----------
  //
  // A citation is { url, title, start, end }: a URL citation annotation from
  // OpenAI, already mapped by the host (src/citations.js) to UTF-16 offsets
  // in the stored text, or without offsets when its place could not be
  // proven. The annotation is the authority: the text it covers (the model's
  // own Markdown link, in the live evidence) is replaced by a citation built
  // only from the annotation's URL and title. Nothing in the covered text or
  // the title is interpreted as HTML.

  const MAX_CITATIONS = 200;
  const MAX_TITLE = 300;
  const CITE_OPEN = '\uE000';
  const CITE_CLOSE = '\uE001';
  const CITE_BASE = 0xE100;
  const CITE_TOKEN = /\uE000([\uE100-\uE1FF])\uE001/g;
  const PRIVATE_MARKS = /[\uE000\uE001\uE100-\uE1FF]/g;

  // The same page under different tracking parameters or fragments is one
  // source. Only `utm_*` parameters and the fragment are dropped.
  function citationKey(raw) {
    const href = safeUrl(raw);
    if (!href) return undefined;
    const url = new URL(href);
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(name)) url.searchParams.delete(name);
    }
    if (![...url.searchParams.keys()].length) url.search = '';
    return url.href;
  }

  function hostOf(raw) {
    const href = safeUrl(raw);
    if (!href) return '';
    return new URL(href).hostname.replace(/^www\./, '');
  }

  // Plain, bounded title text: no control or directional characters.
  function cleanTitle(raw) {
    const text = String(raw ?? '').replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    const characters = Array.from(text);
    return characters.length > MAX_TITLE ? `${characters.slice(0, MAX_TITLE - 1).join('')}…` : characters.join('');
  }

  // Whether `span` (the text an annotation covers) is exactly a citation of
  // the annotation's URL: a Markdown link to it, or the bare address, either
  // optionally in parentheses, with nothing else. A range that is off by
  // even one character does not pass, so a wrong offset unit is never
  // accepted by accident.
  // Each form is anchored at both ends, and a wrapping parenthesis counts
  // only as a pair. In the wrapped forms the address is the shortest match
  // that leaves exactly the wrapper's ")" (so an address ending in a
  // parenthesised part keeps it); in the plain forms it runs to the last ")".
  const CITATION_SPANS = [
    /^\(\s*\[[^\]\n]*\]\(\s*<?(https?:\/\/[^\s<>]+?)>?\s*\)\s*\)$/i,
    /^\[[^\]\n]*\]\(\s*<?(https?:\/\/[^\s<>]+?)>?\s*\)$/i,
    /^\(\s*<?(https?:\/\/[^\s<>]+?)>?\s*\)$/i,
    /^<(https?:\/\/[^\s<>]+)>$/i,
    /^(https?:\/\/[^\s<>]+)$/i
  ];
  // The address in the span must be the annotation's address exactly (as a
  // parsed http(s) URL): the citation key is for deduplication only.
  function spanCarries(span, url) {
    const href = safeUrl(url);
    if (!href || typeof span !== 'string' || !span || span !== span.trim() || span.length > MAX_URL_LENGTH + 400) return false;
    return CITATION_SPANS.some((pattern) => {
      const match = pattern.exec(span);
      return Boolean(match && safeUrl(match[1]) === href);
    });
  }

  // Citations that are safe to place in `text`: valid offsets, not splitting
  // a surrogate pair, carrying their URL, and not overlapping an earlier one.
  function placeable(text, citations) {
    const placed = [];
    for (const citation of (Array.isArray(citations) ? citations : []).slice(0, MAX_CITATIONS)) {
      const { start, end } = citation || {};
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) continue;
      if (/[\uDC00-\uDFFF]/.test(text[start] || '') || /[\uD800-\uDBFF]/.test(text[end - 1] || '')) continue;
      if (!spanCarries(text.slice(start, end), citation.url)) continue;
      placed.push(citation);
    }
    placed.sort((a, b) => a.start - b.start);
    // Overlaps: compared with the last citation kept, not just the previous one.
    const kept = [];
    for (const citation of placed) if (!kept.length || citation.start >= kept.at(-1).end) kept.push(citation);
    return kept;
  }

  // Citation tokens back to the text they replaced (inside code).
  function restoreCites(text) {
    return String(text).replace(CITE_TOKEN, (token, mark) => citeContext.tokens[mark.charCodeAt(0) - CITE_BASE]?.original ?? '');
  }

  // The Sources list: one entry per cited page, in order of first citation
  // in the text, then those without a proven place. Only annotation data.
  function citationSources(text, citations) {
    const list = (Array.isArray(citations) ? citations : []).slice(0, MAX_CITATIONS);
    const placed = new Set(placeable(String(text ?? ''), list));
    const ordered = [...list.filter((c) => placed.has(c)).sort((a, b) => a.start - b.start), ...list.filter((c) => !placed.has(c))];
    const sources = [];
    const byKey = new Map();
    for (const citation of ordered) {
      const key = citationKey(citation?.url);
      if (!key) continue;
      if (!byKey.has(key)) {
        const source = { n: sources.length + 1, key, url: safeUrl(citation.url), title: cleanTitle(citation.title) || hostOf(citation.url), host: hostOf(citation.url) };
        byKey.set(key, source);
        sources.push(source);
      }
    }
    return { sources, byKey };
  }

  // Set while renderCited() renders; read by renderInline() and code text.
  let citeContext = null;

  function citationElement(doc, source) {
    const link = element(doc, 'a', {
      href: source.url,
      class: 'citation',
      dir: 'ltr',
      title: `${source.title} — ${source.url}`,
      'aria-label': `Source ${source.n}: ${source.title}, ${source.host}`
    });
    const number = element(doc, 'span', { class: 'citation-n' });
    number.textContent = String(source.n);
    const host = element(doc, 'span', { class: 'citation-host' });
    host.textContent = source.host;
    link.append(number, host);
    return link;
  }

  // Text that may hold citation tokens: tokens become citation links; any
  // other private-use mark was removed before parsing.
  function appendCitedText(doc, parent, text, wrap) {
    let last = 0;
    for (const match of text.matchAll(CITE_TOKEN)) {
      if (match.index > last) parent.append(wrap(text.slice(last, match.index)));
      const source = citeContext.tokens[match[1].charCodeAt(0) - CITE_BASE];
      if (source) parent.append(citationElement(doc, source));
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.append(wrap(text.slice(last)));
  }

  // A Deep Research answer: the Markdown text with each placed citation's
  // covered text replaced by a citation link. Citations that cannot be
  // placed safely leave the text as it is (they still appear in Sources).
  function renderCited(doc, text, citations) {
    const source = String(text ?? '');
    if (source.length > MAX_MARKDOWN_LENGTH) return renderPlain(doc, source);
    const { byKey } = citationSources(source, citations);
    const placed = placeable(source, citations);
    if (!placed.length) return render(doc, source);
    const tokens = [];
    let marked = '';
    let last = 0;
    for (const citation of placed) {
      const entry = byKey.get(citationKey(citation.url));
      marked += source.slice(last, citation.start).replace(PRIVATE_MARKS, '\uFFFD');
      if (entry && tokens.length < 0x100) {
        marked += CITE_OPEN + String.fromCharCode(CITE_BASE + tokens.length) + CITE_CLOSE;
        // The covered text is kept for code, where a citation is not drawn.
        tokens.push({ ...entry, original: source.slice(citation.start, citation.end).replace(PRIVATE_MARKS, '\uFFFD') });
      } else {
        marked += source.slice(citation.start, citation.end).replace(PRIVATE_MARKS, '\uFFFD');
      }
      last = citation.end;
    }
    marked += source.slice(last).replace(PRIVATE_MARKS, '\uFFFD');
    const fragment = doc.createDocumentFragment();
    citeContext = { tokens };
    try {
      renderBlocks(doc, fragment, parse(marked));
    } finally {
      citeContext = null;
    }
    return fragment;
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

  return { parse, parseInline, render, renderPlain, renderCited, citationSources, citationKey, cleanTitle, hostOf, spanCarries, placeable, safeUrl, firstStrongDirection, ALLOWED_ATTRIBUTES, MAX_CITATIONS };
});
