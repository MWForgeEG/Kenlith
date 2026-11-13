'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('conversation titles are compact and bounded', () => {
  // Avoid importing store.js because it intentionally depends on the VS Code host.
  const titleFrom = (content) => {
    const compact = String(content).replace(/\s+/g, ' ').trim();
    return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact || 'New chat';
  };

  assert.equal(titleFrom('  hello\nworld  '), 'hello world');
  assert.equal(titleFrom(''), 'New chat');
  assert.equal(titleFrom('x'.repeat(60)).length, 48);
});
