'use strict';

async function* parseSse(stream) {
  if (!stream) {
    throw new Error('The streaming response had no body.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseBlock(block);
      if (event) {
        yield event;
      }
    }
  }

  buffer += decoder.decode();
  const finalEvent = parseBlock(buffer.trim());
  if (finalEvent) {
    yield finalEvent;
  }
}

function parseBlock(block) {
  if (!block || block.startsWith(':')) {
    return undefined;
  }

  const lines = block.split('\n');
  let eventName;
  const data = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }

  if (!data.length) {
    return undefined;
  }

  const joined = data.join('\n');
  if (joined === '[DONE]') {
    return { event: eventName || 'done', data: '[DONE]' };
  }

  try {
    return { event: eventName, data: JSON.parse(joined) };
  } catch {
    return { event: eventName, data: joined };
  }
}

module.exports = { parseBlock, parseSse };
