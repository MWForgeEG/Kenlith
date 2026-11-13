'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ALLOWED_ATTRIBUTES, parse, render, renderPlain, safeUrl } = require('../src/markdown');
const { createDocument, elements, serialize } = require('./helpers/fake-dom');

const doc = createDocument();
const html = (text) => serialize(render(doc, text));
const tree = (text) => {
  const root = doc.createElement('div');
  root.append(render(doc, text));
  return root;
};
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'pre', 'button']);

// Every element and attribute the renderer produced is on the allowlist, no
// event handler attribute exists, and every link is an absolute http(s) URL.
function assertSafe(root, input) {
  for (const element of elements(root)) {
    assert.ok(ALLOWED_TAGS.has(element.localName), `${element.localName} from ${JSON.stringify(input)}`);
    for (const [name, value] of element.attributes) {
      assert.ok(ALLOWED_ATTRIBUTES.has(name), `attribute ${name} from ${JSON.stringify(input)}`);
      assert.ok(!name.startsWith('on'), name);
      if (name === 'href') {
        assert.match(value, /^https?:\/\//);
        assert.equal(safeUrl(value), value);
      }
    }
  }
}

test('markdown: paragraphs, emphasis, line breaks, lists, links and fenced code', () => {
  const output = html([
    'Hello **bold** and *em* and `code`.',
    'Second line',
    '',
    '- one',
    '- two',
    '',
    '3. three',
    '4. four',
    '',
    '[OpenAI](https://openai.com/) <https://example.test/a>',
    '',
    '```js',
    'const a = 1;',
    '```'
  ].join('\n'));
  assert.equal(output, [
    '<p dir="auto">Hello <strong>bold</strong> and <em>em</em> and <code dir="ltr">code</code>.<br>Second line</p>',
    '<ul dir="ltr"><li><p dir="auto">one</p></li><li><p dir="auto">two</p></li></ul>',
    '<ol dir="ltr" start="3"><li><p dir="auto">three</p></li><li><p dir="auto">four</p></li></ol>',
    '<p dir="auto"><a href="https://openai.com/" title="https://openai.com/" dir="auto">OpenAI</a> ',
    '<a href="https://example.test/a" title="https://example.test/a" dir="auto">https://example.test/a</a></p>',
    '<div class="code-block" dir="ltr"><div class="code-head"><span class="code-lang">js</span>',
    '<button type="button" class="copy" aria-label="Copy js code" data-copy="">Copy</button></div>',
    '<pre dir="ltr"><code>const a = 1;</code></pre></div>'
  ].join(''));
});

test('markdown: quotes, headings, rules, nested lists with code, snake_case stays literal', () => {
  const output = html('> quote **x**\n\n# Title\n\n---\n\nsnake_case_name\n\n- a\n  - nested\n    ```\n    code\n    ```\n- b');
  assert.match(output, /^<blockquote dir="ltr"><p dir="auto">quote <strong>x<\/strong><\/p><\/blockquote><h3 dir="auto">Title<\/h3><hr>/);
  assert.match(output, /<p dir="auto">snake_case_name<\/p>/);
  assert.match(output, /<li><p dir="auto">nested<\/p><div class="code-block" dir="ltr">.*<pre dir="ltr"><code>code<\/code><\/pre><\/div><\/li>/);
});

test('markdown: malicious input never produces markup, handlers or unsafe links', () => {
  const corpus = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="https://evil.test/"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x]( javascript:alert(1) )',
    '[x](java\tscript:alert(1))',
    '[x](javascript&#58;alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[x](vbscript:msgbox(1))',
    '[x](file:///C:/Windows/win.ini)',
    '[x](command:workbench.action.reloadWindow)',
    '[x](vscode://publisher.extension/path)',
    '[x](//evil.test/x)',
    '[x](/relative/path)',
    '[x](https://user' + ':secret@evil.test/)',
    '<javascript:alert(1)>',
    '![x](https://tracker.test/pixel.png)',
    '![x](javascript:alert(1))',
    '[click](https://ok.test/ "title" onmouseover="alert(1)")',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '```html\n<script>alert(1)</script>\n```',
    '`<img src=x onerror=alert(1)>`',
    'https://ok.test/"onmouseover="alert(1)',
    '[x](https://ok.test/\u202Eexe.txt)',
    '**[x](javascript:alert(1))**',
    '[**x**](https://ok.test/)<script>alert(1)</script>'
  ];
  for (const input of corpus) {
    const root = tree(input);
    assertSafe(root, input);
  }

  // The dangerous text is still shown, as text.
  assert.equal(tree('<script>alert(1)</script>').textContent, '<script>alert(1)</script>');
  assert.equal(tree('&lt;script&gt;').textContent, '&lt;script&gt;');
  // Unsafe destinations are not links at all.
  for (const input of ['[x](javascript:alert(1))', '[x](command:workbench.action.reloadWindow)', '[x](file:///C:/Windows/win.ini)', '[x](https://user' + ':secret@evil.test/)']) {
    assert.equal(elements(tree(input)).some((element) => element.localName === 'a'), false, input);
  }
  // Images are never loaded: no img element, only a link to the address.
  const image = tree('![x](https://tracker.test/pixel.png)');
  assert.deepEqual(elements(image).map((element) => element.localName), ['p', 'a']);
  assert.equal(image.textContent, 'Image: x');
  // A bare URL ends at the quote; the rest is text.
  const bare = elements(tree('https://ok.test/"onmouseover="alert(1)')).find((element) => element.localName === 'a');
  assert.equal(bare.getAttribute('href'), 'https://ok.test/');
});

test('markdown: safeUrl accepts only absolute http(s) URLs without credentials or control characters', () => {
  assert.equal(safeUrl('https://example.test/a?b=1#c'), 'https://example.test/a?b=1#c');
  assert.equal(safeUrl('HTTP://Example.TEST'), 'http://example.test/');
  for (const value of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'file:///x', 'command:x', 'vscode://x', 'mailto:a@b.test',
    '//evil.test', '/relative', 'https://user' + ':pw@evil.test', 'https://ok.test/a b', 'https://ok.test/\u0000', `https://ok.test/${'a'.repeat(3000)}`, '', undefined, 42]) {
    assert.equal(safeUrl(value), undefined, String(value));
  }
});

test('markdown: code keeps its exact characters, order and line breaks, and Copy gets the original', () => {
  const body = [
    "const greeting = 'مرحبا بالعالم';\t// تعليق عربي",
    '  indented line with trailing spaces   ',
    'path = "C:\\\\GPT Extension\\\\src\\\\view.js";',
    'emoji = "👋🏽 👨‍👩‍👧";',
    'html = "</script><script>alert(1)</script>";',
    'hidden = "\u202Eevil\u202C";',
    '',
    'end'
  ].join('\n');
  const root = tree('```js\n' + body + '\n```');
  const pre = elements(root).find((element) => element.localName === 'pre');
  const copy = elements(root).find((element) => element.localName === 'button');
  assert.equal(pre.getAttribute('dir'), 'ltr');
  assert.equal(copy.copySource, body, 'Copy carries the original text');
  // On screen, the hidden direction characters are shown as markers; nothing else differs.
  assert.equal(pre.textContent, body.replace('\u202E', '[U+202E]').replace('\u202C', '[U+202C]'));
  assert.ok(elements(pre).some((element) => element.getAttribute('class') === 'bidi-mark'));

  // Inline code: same rule.
  const inline = tree('خذ `a\u202Eb` كما هو');
  assert.equal(elements(inline).find((element) => element.localName === 'code').textContent, 'a[U+202E]b');

  // An unclosed fence (a reply still streaming, or cut off) is still code.
  assert.deepEqual(parse('```js\nconst a = 1;'), [{ type: 'code', lang: 'js', text: 'const a = 1;', open: true }]);
});

test('markdown: Arabic, English and mixed text get the right direction, without reordering the text', () => {
  const arabicList = tree('تقوم الدالة:\n\n1. تقرأ الملف.\n2. تضيف `addMessage`.\n\n```js\nawait store.addMessage(\'user\', text);\n```');
  const [paragraph, list] = arabicList.childNodes;
  assert.equal(paragraph.getAttribute('dir'), 'auto');
  assert.equal(list.localName, 'ol');
  assert.equal(list.getAttribute('dir'), 'rtl');
  // Items inherit it: dir="auto" on an item would skip its paragraph and fall
  // back to left-to-right, drawing the number on the wrong side.
  assert.equal(list.childNodes[0].getAttribute('dir'), null);
  assert.equal(tree('> اقتباس عربي\n> سطر ثان').childNodes[0].getAttribute('dir'), 'rtl');
  assert.equal(tree('> an English quote').childNodes[0].getAttribute('dir'), 'ltr');
  const code = elements(arabicList).find((element) => element.localName === 'pre');
  assert.equal(code.getAttribute('dir'), 'ltr');
  assert.equal(code.textContent, "await store.addMessage('user', text);", 'logical order, not reversed');

  // A list item that starts with code takes its direction from the Arabic after it.
  assert.equal(tree('- `x` قيمة\n- `y` قيمة').childNodes[0].getAttribute('dir'), 'rtl');
  assert.equal(tree('- first\n- second').childNodes[0].getAttribute('dir'), 'ltr');

  // Paths, URLs and punctuation inside Arabic prose.
  const prose = 'افتح C:\\GPT\\src\\view.js ثم src/store.js، وراجع https://example.test/a. 👋🏽';
  const root = tree(prose);
  const isolated = elements(root).filter((element) => element.getAttribute('dir') === 'ltr').map((element) => element.textContent);
  assert.deepEqual(isolated, ['C:\\GPT\\src\\view.js', 'src/store.js']);
  assert.equal(elements(root).find((element) => element.localName === 'a').getAttribute('href'), 'https://example.test/a');
  assert.equal(root.textContent, prose, 'the text itself is unchanged');

  // Mixed English sentence with an Arabic phrase: one paragraph, auto direction.
  const mixed = tree('The title is «شرح دالة الحفظ» (saved in `conversations.json`).');
  assert.equal(mixed.textContent, 'The title is «شرح دالة الحفظ» (saved in conversations.json).');
});

test('markdown: plain messages keep every character and give each line its own direction', () => {
  const text = 'سطر عربي\nEnglish line\n**not bold** <b>x</b>\n```\nx = 1\n```';
  const root = doc.createElement('div');
  root.append(renderPlain(doc, text));
  const lines = root.childNodes.filter((node) => node.getAttribute('class') === 'line');
  assert.deepEqual(lines.map((line) => line.textContent), ['سطر عربي', 'English line', '**not bold** <b>x</b>']);
  assert.ok(lines.every((line) => line.getAttribute('dir') === 'auto'));
  assert.equal(elements(root).find((element) => element.localName === 'pre').textContent, 'x = 1');
  assertSafe(root, text);
});

test('markdown: hostile shapes render in bounded time', () => {
  const inputs = [
    '>'.repeat(5000) + ' deep',
    Array.from({ length: 400 }, (_, index) => `${'  '.repeat(index)}- level ${index}`).join('\n'),
    '*'.repeat(50000),
    '_a '.repeat(30000),
    '`'.repeat(1) + ' x'.repeat(50000),
    '` '.repeat(50000),
    '['.repeat(50000),
    '[a]('.repeat(20000),
    '- item\n' + '\n'.repeat(100000) + '- item',
    '**a '.repeat(30000)
  ];
  for (const input of inputs) {
    const started = Date.now();
    const root = tree(input);
    assertSafe(root, input.slice(0, 40));
    assert.ok(Date.now() - started < 3000, `slow on ${JSON.stringify(input.slice(0, 20))}: ${Date.now() - started} ms`);
  }

  // Above the size limit a message is shown as plain text, not parsed.
  const huge = '**x** '.repeat(40000);
  const root = tree(huge);
  assert.equal(elements(root).some((element) => element.localName === 'strong'), false);
  assert.equal(root.textContent, huge);
});
