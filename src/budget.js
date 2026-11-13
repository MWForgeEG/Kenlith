'use strict';

// Hard limit on the text of one model request: the instructions plus every
// input message, counted in UTF-16 code units (JavaScript string length).
// This bounds what the extension sends; it is not the model's token limit,
// which depends on the tokenizer and the text.

const REQUEST_BUDGET = 80_000;

class RequestBudgetError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RequestBudgetError';
    this.code = 'REQUEST_BUDGET';
    this.details = details;
  }
}

function formatCount(value) {
  return value.toLocaleString('en-US');
}

// Composes the request input from stored history and the new user text.
// The new text and the instructions are never shortened: if they do not fit,
// the request is refused. Older history is left out whole, oldest first, and
// a leading reply whose question was left out is dropped too, so the model
// never sees an answer without its question.
//
// With attached code (stage 3), `text` is the whole turn (typed text, framing
// and code) and `attachment` the code's length, so a refusal can say which
// part is large.
function composeWithinBudget({ instructions, history, text, limit = REQUEST_BUDGET, attachment }) {
  const fixed = instructions.length + text.length;
  if (instructions.length >= limit) {
    throw new RequestBudgetError(
      `Your Kenlith instructions are ${formatCount(instructions.length)} characters, which leaves no room in the ${formatCount(limit)}-character request limit. Shorten kenlith.instructions in your user settings. Nothing was sent or saved.`,
      { instructions: instructions.length, text: text.length, limit }
    );
  }
  if (fixed > limit && attachment !== undefined) {
    throw new RequestBudgetError(
      `This message and its attached code are too long to send together. With your instructions they need ${formatCount(fixed)} characters (attached code ${formatCount(attachment)}), and one request is limited to ${formatCount(limit)}. Shorten the message or attach less code, by ${formatCount(fixed - limit)} characters. Nothing was sent or saved; the attachment is still there.`,
      { instructions: instructions.length, text: text.length, attachment, limit }
    );
  }
  if (fixed > limit) {
    throw new RequestBudgetError(
      `This message is too long to send. With your instructions it needs ${formatCount(fixed)} characters, and one request is limited to ${formatCount(limit)}. Shorten it by ${formatCount(fixed - limit)} characters. Nothing was sent or saved.`,
      { instructions: instructions.length, text: text.length, limit }
    );
  }

  const selected = [];
  let used = fixed;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const length = history[index].content.length;
    if (used + length > limit) {
      break;
    }
    selected.unshift(history[index]);
    used += length;
  }
  while (selected.length && selected[0].role !== 'user') {
    used -= selected[0].content.length;
    selected.shift();
  }

  const messages = [
    ...selected.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: text }
  ];
  const total = instructions.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total !== used || total > limit) {
    throw new Error('Request budget calculation failed. Nothing was sent.');
  }
  return { messages, total, omitted: history.length - selected.length };
}

module.exports = { REQUEST_BUDGET, RequestBudgetError, composeWithinBudget };
