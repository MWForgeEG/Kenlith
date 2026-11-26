'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-053): test fixtures carry no account-derived
// hidden model identifiers. A hidden ("hide") model entry in any test file
// must use a synthetic slug from the allowlist below, or a public model slug
// reused to test duplicate handling. The check is structural (an allowlist),
// never a list of real identifiers: such a list would itself disclose them.
// It also refuses personal data patterns in fixtures.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const TEST_DIR = __dirname;
const SYNTHETIC_HIDDEN = new Set(['hidden-model-a', 'hidden-model-b', 'gpt-hidden', 'h', 'twin']);
// Public model names (official model pages) that a test may mark hidden to
// check duplicate-entry handling.
const PUBLIC = new Set(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

function files(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...files(full));
    else if (/\.(js|json|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Every hidden entry form used in this repository's tests.
const FORMS = [
  /\b(?:one|entry)\(\s*'([^']*)'(?:\s*,\s*'[^']*')?\s*,\s*(?:\{[^}]*visibility:\s*)?'hide'/g,
  /slug:\s*'([^']*)'[^}]*?visibility:\s*'hide'/g,
  /\[\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'hide'\s*\]/g,
  /"slug"\s*:\s*"([^"]*)"[^}]*?"visibility"\s*:\s*"hide"/g
];
const HIDE = /'hide'|"hide"/g;

test('FP-01 every hidden model entry in the tests uses a synthetic or public slug', () => {
  const found = [];
  for (const file of files(TEST_DIR)) {
    if (path.basename(file) === 'fixture-privacy.test.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    const total = (text.match(HIDE) || []).length;
    if (!total) continue;
    let recognized = 0;
    for (const form of FORMS) {
      for (const match of text.matchAll(form)) {
        recognized += 1;
        found.push({ file: path.relative(TEST_DIR, file), slug: match[1] });
      }
    }
    assert.equal(recognized, total, `${path.relative(TEST_DIR, file)}: every "hide" entry must be in a recognized form (${recognized} of ${total})`);
  }
  assert.ok(found.length >= 6, 'the hidden-model tests are still there');
  for (const { file, slug } of found) {
    assert.ok(SYNTHETIC_HIDDEN.has(slug) || PUBLIC.has(slug), `${file}: hidden slug of ${slug.length} characters is not synthetic`);
  }
});

test('FP-02 no personal data patterns in test fixtures', () => {
  const patterns = [
    [/[A-Za-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*example\.(?:test|com|org)\b)[A-Za-z0-9.-]+\.(?:com|net|org|io|sa|eg)\b/, 'an e-mail address outside example domains'],
    [/C:\\\\Users\\\\(?!synthetic|alice|<user>|Public|test)[A-Za-z]/, 'a real Windows profile path'],
    [/\b(?:req|resp)_[0-9a-f]{24,}\b/, 'a request or response ID'],
    [/"chatgpt_account_id"\s*:\s*"[0-9a-f-]{20,}"/, 'an account ID']
  ];
  for (const file of files(TEST_DIR)) {
    if (path.basename(file) === 'fixture-privacy.test.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [pattern, what] of patterns) assert.doesNotMatch(text, pattern, `${path.relative(TEST_DIR, file)}: ${what}`);
  }
});
