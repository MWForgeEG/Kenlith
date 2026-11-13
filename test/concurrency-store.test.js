'use strict';

// Conversation history shared by several independent OS processes, the way
// several editor windows share one profile's globalStorage.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/fake-vscode');
const { runWorker } = require('./helpers/processes');
const { acquireLock } = require('../src/lock');

const AR = 'مرحبا بالعالم 👋🏽 **نص** `code`';

function historyPath(dir) {
  return path.join(dir, 'conversations.json');
}

function readHistory(dir) {
  return JSON.parse(fs.readFileSync(historyPath(dir), 'utf8'));
}

function chat(dir, id) {
  return readHistory(dir).conversations.find((conversation) => conversation.id === id);
}

async function store(dir, ops, extra = {}) {
  const run = await runWorker('store-worker.js', { storageDir: dir, ops, ...extra });
  assert.equal(run.code, 0, `worker failed: ${run.stdout}${run.stderr}`);
  assert.equal(run.result.ok, true, run.stdout);
  return run.result;
}

// A history whose current chat already has a message, plus its ID.
async function seeded() {
  const dir = makeTempDir();
  await store(dir, [{ op: 'init' }, { op: 'add', content: 'seed' }]);
  return { dir, chatId: readHistory(dir).currentId };
}

function together(count, build) {
  const startAt = Date.now() + 1500;
  return Promise.all(Array.from({ length: count }, (_, index) => build(index, startAt)));
}

test('two processes create different chats at the same time; every chat survives', async () => {
  const { dir } = await seeded();
  await together(2, (worker, startAt) => store(dir, Array.from({ length: 10 }, (_, index) => [
    { op: 'new' },
    { op: 'add', content: `w${worker} chat ${index} ${AR}` }
  ]).flat(), { startAt, label: `w${worker}` }));

  const history = readHistory(dir);
  assert.equal(history.conversations.length, 21);
  assert.equal(new Set(history.conversations.map((item) => item.id)).size, 21);
  for (const worker of [0, 1]) {
    for (let index = 0; index < 10; index += 1) {
      const content = `w${worker} chat ${index} ${AR}`;
      const owners = history.conversations.filter((item) => item.messages.some((message) => message.content === content));
      assert.equal(owners.length, 1, `${content} must be in exactly one chat`);
      assert.deepEqual(owners[0].messages.map((message) => message.content), [content]);
    }
  }
});

test('four processes append to the same chat; all 100 messages kept in each writer\'s order', async () => {
  const { dir, chatId } = await seeded();
  await together(4, (worker, startAt) => store(dir, Array.from({ length: 25 }, (_, index) => ({
    op: 'add', content: `w${worker}-${index} ${AR}`, conversationId: chatId
  })), { startAt }));

  const messages = chat(dir, chatId).messages.slice(1);
  assert.equal(messages.length, 100);
  assert.equal(new Set(messages.map((message) => message.id)).size, 100);
  for (let worker = 0; worker < 4; worker += 1) {
    const own = messages.filter((message) => message.content.startsWith(`w${worker}-`)).map((message) => message.content);
    assert.deepEqual(own, Array.from({ length: 25 }, (_, index) => `w${worker}-${index} ${AR}`));
  }
});

test('a stream finishing in one process while another keeps saving loses nothing', async () => {
  const { dir, chatId } = await seeded();
  await together(2, (worker, startAt) => store(dir, worker === 0
    ? [
      { op: 'add', content: 'question', conversationId: chatId },
      { op: 'add', role: 'assistant', content: '', conversationId: chatId, as: 'reply' },
      { op: 'sleep', ms: 500 },
      { op: 'update', conversationVar: 'chat', conversationId: chatId, messageVar: 'reply', content: `streamed ${AR}` }
    ]
    : [
      ...Array.from({ length: 15 }, (_, index) => ({ op: 'add', content: `other ${index}`, conversationId: chatId })),
      { op: 'new' },
      { op: 'add', content: 'other window new chat' }
    ], { startAt }));

  const messages = chat(dir, chatId).messages;
  assert.equal(messages.find((message) => message.role === 'assistant').content, `streamed ${AR}`);
  assert.equal(messages.filter((message) => message.content.startsWith('other ')).length, 15);
  assert.ok(readHistory(dir).conversations.some((item) => item.messages[0]?.content === 'other window new chat'));
});

test('two first messages at once: both kept, the title comes from one of them', async () => {
  const dir = makeTempDir();
  await store(dir, [{ op: 'init' }]);
  const chatId = readHistory(dir).currentId;
  await together(2, (worker, startAt) => store(dir, [
    { op: 'add', content: worker ? `English first message` : `أول رسالة بالعربي 😀`, conversationId: chatId }
  ], { startAt }));

  const result = chat(dir, chatId);
  assert.equal(result.messages.length, 2);
  assert.ok(['English first message', 'أول رسالة بالعربي 😀'].includes(result.title));
  assert.equal(result.title, result.messages[0].content);
});

test('+ in one window never deletes the empty chat another window has open', async () => {
  const { dir, chatId: seedChat } = await seeded();
  const at = Date.now() + 1500;
  const [a, b] = await Promise.all([
    // Window A opens a fresh empty chat and types into it a little later.
    store(dir, [{ op: 'new', as: 'empty' }, { op: 'sleep', ms: 1500 }, { op: 'add', content: 'typed in A', conversationVar: 'empty' }], { startAt: at }),
    // Window B, on another chat, presses + in the meantime.
    store(dir, [{ op: 'sleep', ms: 400 }, { op: 'select', conversationId: seedChat }, { op: 'add', content: 'b', conversationId: seedChat }, { op: 'new' }], { startAt: at })
  ]);
  assert.equal(chat(dir, a.vars.empty).messages[0].content, 'typed in A');
  assert.ok(b.results.some((entry) => entry.op === 'new'));
});

test('a removed message is not brought back by another process\'s later save or update', async () => {
  const { dir, chatId } = await seeded();
  await together(2, (worker, startAt) => store(dir, worker === 0
    ? [
      { op: 'add', role: 'assistant', content: '', conversationId: chatId, as: 'placeholder' },
      { op: 'sleep', ms: 200 },
      { op: 'remove', conversationId: chatId, messageVar: 'placeholder' },
      { op: 'sleep', ms: 200 },
      { op: 'update', conversationId: chatId, messageVar: 'placeholder', content: 'late update' }
    ]
    : Array.from({ length: 20 }, (_, index) => ({ op: 'add', content: `b${index}`, conversationId: chatId })),
  { startAt }));

  const messages = chat(dir, chatId).messages;
  assert.equal(messages.some((message) => message.role === 'assistant'), false);
  assert.equal(messages.some((message) => message.content === 'late update'), false);
  assert.equal(messages.filter((message) => message.content.startsWith('b')).length, 20);
});

test('a lock that cannot be acquired fails the change and leaves history byte-identical', async () => {
  const { dir, chatId } = await seeded();
  const before = fs.readFileSync(historyPath(dir));
  const lock = await acquireLock(path.join(dir, 'conversations.lock'));
  try {
    const run = await runWorker('store-worker.js', {
      storageDir: dir,
      lockOptions: { timeoutMs: 600 },
      ops: [{ op: 'add', content: 'blocked', conversationId: chatId }]
    });
    assert.equal(run.result.ok, false);
    assert.match(run.result.error, /busy in another window.*not saved/);
    assert.deepEqual(fs.readFileSync(historyPath(dir)), before);
  } finally {
    await lock.release();
  }
  await store(dir, [{ op: 'add', content: 'after release', conversationId: chatId }]);
  assert.deepEqual(chat(dir, chatId).messages.map((message) => message.content), ['seed', 'after release']);
});

test('a process that crashes while holding the lock does not block others for long', async () => {
  const { dir, chatId } = await seeded();
  const crashed = await runWorker('store-worker.js', { storageDir: dir, ops: [{ op: 'holdLock' }, { op: 'crash' }] });
  assert.equal(crashed.code, 3);
  assert.ok(fs.existsSync(path.join(dir, 'conversations.lock')), 'the crashed process left its lock behind');

  const started = Date.now();
  await store(dir, [{ op: 'add', content: 'after crash', conversationId: chatId }]);
  assert.ok(Date.now() - started < 5000, 'a dead owner\'s lock is taken over without waiting for the stale timeout');
  assert.equal(chat(dir, chatId).messages.at(-1).content, 'after crash');
});

test('a hung holder (alive, no heartbeat) is taken over only after the stale period', async () => {
  const { dir, chatId } = await seeded();
  const lockPath = path.join(dir, 'conversations.lock');
  // Owner is this test process (alive) but the heartbeat stopped long ago.
  fs.writeFileSync(lockPath, JSON.stringify({ id: 'hung', pid: process.pid, host: require('node:os').hostname(), createdAt: 0 }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  await store(dir, [{ op: 'add', content: 'after hung', conversationId: chatId }]);
  assert.equal(chat(dir, chatId).messages.at(-1).content, 'after hung');

  // A fresh lock from another machine is never broken early.
  fs.writeFileSync(lockPath, JSON.stringify({ id: 'remote', pid: 1, host: 'another-host', createdAt: Date.now() }));
  const blocked = await runWorker('store-worker.js', {
    storageDir: dir,
    lockOptions: { timeoutMs: 500 },
    ops: [{ op: 'add', content: 'must not land', conversationId: chatId }]
  });
  assert.equal(blocked.result.ok, false);
  fs.rmSync(lockPath);
  assert.equal(chat(dir, chatId).messages.some((message) => message.content === 'must not land'), false);
});

test('a crash during the write leaves the previous history intact; the next process recovers', async () => {
  const { dir, chatId } = await seeded();
  const before = fs.readFileSync(historyPath(dir));
  const crashed = await runWorker('store-worker.js', {
    storageDir: dir,
    crashOnCommit: true,
    ops: [{ op: 'add', content: 'never committed', conversationId: chatId }]
  });
  assert.equal(crashed.code, 9);
  assert.deepEqual(fs.readFileSync(historyPath(dir)), before, 'history file untouched');
  const orphans = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.equal(orphans.length, 1, 'the uncommitted write stays in its own temporary file');

  await store(dir, [{ op: 'add', content: 'recovered', conversationId: chatId }]);
  assert.deepEqual(chat(dir, chatId).messages.map((message) => message.content), ['seed', 'recovered']);
});

test('an unreadable history file is kept aside, never overwritten', async () => {
  const dir = makeTempDir();
  const broken = '{"version":1,"conversations":[{"id":"x","messages":[{"content":"مهم';
  fs.writeFileSync(historyPath(dir), broken);
  await store(dir, [{ op: 'init' }, { op: 'add', content: 'new start' }]);

  const kept = fs.readdirSync(dir).filter((name) => name.startsWith('conversations.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), broken);
  assert.equal(readHistory(dir).conversations[0].messages[0].content, 'new start');
});

test('an existing v1 history with more than 30 chats stays intact under concurrent writes', async () => {
  const dir = makeTempDir();
  const legacy = {
    version: 1,
    currentId: 'c0',
    customTopLevel: 'kept',
    conversations: Array.from({ length: 45 }, (_, index) => ({
      id: `c${index}`,
      title: `محادثة ${index} 🌙`,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      messages: [
        { id: `m${index}a`, role: 'user', content: `سؤال ${index} ✅`, createdAt: '2026-10-01T00:00:00.000Z' },
        { id: `m${index}b`, role: 'assistant', content: `جواب ${index}`, createdAt: '2026-10-01T00:00:01.000Z', stopped: true }
      ]
    })),
    unrecognized: [{ note: 'from a future version' }]
  };
  fs.writeFileSync(historyPath(dir), JSON.stringify(legacy));

  await together(2, (worker, startAt) => store(dir, [
    { op: 'add', content: `w${worker} on c7`, conversationId: 'c7' },
    { op: 'new' },
    { op: 'add', content: `w${worker} new` }
  ], { startAt }));

  const history = readHistory(dir);
  assert.equal(history.version, 1);
  assert.equal(history.customTopLevel, 'kept');
  assert.deepEqual(history.unrecognized, legacy.unrecognized);
  assert.equal(history.conversations.length, 47);
  for (const original of legacy.conversations) {
    const now = history.conversations.find((item) => item.id === original.id);
    if (original.id === 'c7') {
      assert.deepEqual(now.messages.slice(0, 2), original.messages);
      assert.equal(now.messages.length, 4);
    } else {
      assert.deepEqual(now, original);
    }
  }
});

// Another process reading the history file, the way other windows refresh
// their view. Every successful read must parse. Returns stop() → read count.
function startReader(dir, intervalMs) {
  let reads = 0;
  let stop = false;
  const done = (async () => {
    while (!stop) {
      let text;
      try {
        text = fs.readFileSync(historyPath(dir), 'utf8');
      } catch (error) {
        // Windows may refuse the open for an instant while the file is replaced.
        if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
      }
      if (text !== undefined) {
        JSON.parse(text);
        reads += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return async () => {
    stop = true;
    await done;
    return reads;
  };
}

test('with another window reading every 50 ms, every concurrent write lands', async () => {
  const { dir, chatId } = await seeded();
  const stopReader = startReader(dir, 50);
  try {
    await together(3, (worker, startAt) => store(dir, Array.from({ length: 20 }, (_, index) => ({
      op: 'add', content: `${worker}:${index}`, conversationId: chatId
    })), { startAt }));
  } finally {
    assert.ok((await stopReader()) > 5);
  }
  assert.equal(chat(dir, chatId).messages.length, 61);
});

test('with a reader hammering the file, a write may fail but only ever as "not saved", never silently', async () => {
  const { dir, chatId } = await seeded();
  const stopReader = startReader(dir, 1);
  let runs;
  try {
    runs = await together(3, (worker, startAt) => runWorker('store-worker.js', {
      storageDir: dir,
      startAt,
      continueOnError: true,
      ops: Array.from({ length: 20 }, (_, index) => ({ op: 'add', content: `${worker}:${index}`, conversationId: chatId }))
    }));
  } finally {
    await stopReader();
  }
  const reported = runs.flatMap((run) => run.result.results);
  const saved = reported.filter((entry) => !entry.error).map((entry) => entry.content);
  const failed = reported.filter((entry) => entry.error);
  for (const entry of failed) {
    assert.match(entry.error, /not saved|EPERM|EBUSY/);
  }
  const onDisk = chat(dir, chatId).messages.slice(1).map((message) => message.content);
  assert.deepEqual([...onDisk].sort(), [...saved].sort(), 'exactly the writes reported as saved are on disk');
  assert.equal(saved.length + failed.length, 60);
});
