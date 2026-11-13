'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseBlock, parseSse } = require('../src/sse');

test('parseBlock parses an OpenAI SSE event', () => {
  const parsed = parseBlock('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}');
  assert.equal(parsed.event, 'response.output_text.delta');
  assert.equal(parsed.data.delta, 'Hi');
});

test('parseSse handles split chunks and completion', async () => {
  async function* chunks() {
    yield Buffer.from('data: {"type":"response.output_text.delta","delta":"Hel');
    yield Buffer.from('lo"}\n\ndata: {"type":"response.completed"}\n\n');
  }

  const events = [];
  for await (const event of parseSse(chunks())) {
    events.push(event.data);
  }

  assert.equal(events.length, 2);
  assert.equal(events[0].delta, 'Hello');
  assert.equal(events[1].type, 'response.completed');
});

test('parseBlock recognizes the done sentinel', () => {
  assert.deepEqual(parseBlock('data: [DONE]'), { event: 'done', data: '[DONE]' });
});
