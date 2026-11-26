'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-051): deterministic recognition of explicit
// "do not use the internet" instructions (src/web-intent.js). Offline only.
// The list is fixed and finite; these cases document what it recognizes and,
// as importantly, what it must not (quotations, statements, local searches).

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectNoWeb, normalize, RULES } = require('../src/web-intent');

const no = (text) => detectNoWeb(text).noWeb;

test('WI-01 English instructions are recognized, in any case and with any punctuation', () => {
  for (const text of [
    "Don't search the web, just explain closures.",
    'Explain closures. Do not use the internet.',
    'DON’T USE THE INTERNET!!! what is 2+2',
    'dont use the web for this',
    'Please do not browse; summarize what you know.',
    'please don\'t google it',
    'Never look it up online, answer directly.',
    'answer from memory only: capital of France?',
    'Reply from your own knowledge — who wrote Hamlet?',
    'without browsing, what is TCP?',
    'Without using the internet: what is DNS?',
    'no web search please',
    'No internet. What is a monad?',
    'offline only: explain recursion',
    'Stay offline and explain the event loop.',
    "I don't want you to search, just think.",
    'You do not need to use the internet for this.',
    'Avoid searching; use what you know.',
    'Turn off web search for this one.',
    "Don't go online for this."
  ]) assert.equal(no(text), true, text);
});

test('WI-02 Arabic instructions (MSA and Egyptian, with or without hamza and harakat) are recognized', () => {
  for (const text of [
    'لا تبحث في الإنترنت، اشرح لي الـ closures',
    'لا تبحث في الانترنت',
    'لا تَبْحَث، أجب من معلوماتك',
    'بدون بحث، ما هي عاصمة فرنسا؟',
    'من غير ما تدور على النت قولي',
    'من غير بحث لو سمحت',
    'دون البحث في الويب، ما هو DNS؟',
    'متبحثش، جاوب من معلوماتك',
    'ماتبحثش على جوجل',
    'ما تبحثش',
    'لا تستخدم الإنترنت',
    'لا تستعمل النت في الإجابة',
    'متستخدمش النت',
    'بلاش بحث',
    'أرجو عدم البحث في الإنترنت',
    'بدون إنترنت: اشرح الـ recursion',
    'جاوب من ذاكرتك',
    'اوفلاين لو سمحت',
    'ولا تبحث في الإنترنت'
  ]) assert.equal(no(text), true, text);
});

test('WI-03 quoted text, code and quote lines are material, not instructions', () => {
  for (const text of [
    'The doc says "do not use the internet" — is that a good policy?',
    'My teacher wrote “don’t search the web”. What did she mean?',
    'ترجم «لا تبحث في الإنترنت» إلى الإنجليزية',
    'What does `--no-web` or `dont use the internet` mean in this CLI?',
    '```\n// do not use the internet\nconst offline = true;\n```\nWhat does this comment mean?',
    "> don't search\nwhat does this quote mean?"
  ]) assert.equal(no(text), false, text);
  // An unclosed quotation is not stripped (the instruction stays visible).
  assert.equal(no('Please "do not use the internet for this'), true);
});

test('WI-04 statements and local searches are not no-web instructions', () => {
  for (const text of [
    "what's the weather in Cairo?",
    'search the web for the latest Node release',
    "Don't search the project files, just think",
    "Don't search the codebase, read the docs I pasted",
    'لا تبحث في المشروع، فكر فقط',
    'من غير بحث في الملفات، فكر',
    "I don't use the internet much, recommend a book",
    'My app does not use the internet. Why is it slow?',
    "We don't use the web version of Outlook.",
    'The server cannot access the internet; how do I debug it?',
    'how does web search work?',
    "Don't hesitate to search the web",
    "don't search my files, search the web",
    'Is it safe to browse without antivirus?',
    'Write a function that checks whether there is no internet connection.'
  ]) assert.equal(no(text), false, text);
});

test('WI-05 conflicting instructions: an explicit no-internet instruction wins (safe direction)', () => {
  assert.equal(no('Search the web. Actually, don\'t use the internet.'), true);
  assert.equal(no('ابحث في الإنترنت... لا، بدون بحث'), true);
  assert.equal(no('Look this up online — no wait, answer from memory only.'), true);
});

test('WI-06 negated negation and permission forms', () => {
  // Permission to search is not a no-web instruction.
  assert.equal(no('You may use the internet if you need to.'), false);
  assert.equal(no('Feel free to search the web.'), false);
  // "It's fine if you don't search" grants not searching: suppression is consistent with it.
  assert.equal(no("It's fine if you don't search."), true);
});

test('WI-07 normalization: apostrophes, harakat, tatweel, alef forms, width and spacing', () => {
  assert.equal(normalize('Don’t  USE\tthe   Internet!'), " don't use the internet | ");
  assert.equal(normalize('لا تـبـحـث في الإِنترنت'), ' لا تبحث في الانترنت ');
  assert.equal(no('ＤＯＮ’Ｔ ＵＳＥ ＴＨＥ ＩＮＴＥＲＮＥＴ'), true, 'full-width forms (NFKC)');
});

test('WI-08 input bounds: non-strings, empty and very long text', () => {
  for (const value of [undefined, null, '', 7, {}, []]) assert.equal(no(value), false);
  const long = `${'word '.repeat(10_000)}don't use the internet`;
  assert.equal(no(long), false, 'only the first 20,000 characters are read');
  assert.equal(no(`don't use the internet ${'word '.repeat(10_000)}`), true);
});

test('WI-09 the result names the rule that matched, and the rule list is fixed and frozen', () => {
  assert.deepEqual(detectNoWeb("Don't use the internet."), { noWeb: true, rule: 'en-neg-use-web' });
  assert.deepEqual(detectNoWeb('بدون بحث'), { noWeb: true, rule: 'ar-without' });
  assert.deepEqual(detectNoWeb('hello'), { noWeb: false, rule: undefined });
  assert.ok(Object.isFrozen(RULES) && RULES.every((rule) => Object.isFrozen(rule)));
  assert.equal(new Set(RULES.map((rule) => rule.id)).size, RULES.length);
});
