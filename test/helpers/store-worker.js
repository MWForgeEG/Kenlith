'use strict';

// Runs ConversationStore operations in its own OS process against a shared
// storage directory. Usage: node store-worker.js <json spec>
// spec: { storageDir, startAt, label, ops: [{ op, ... }] }
// Prints one JSON line: { ok, label, results } or { ok: false, error }.

const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('./fake-vscode');
const { acquireLock } = require('../../src/lock');
const { ConversationStore } = require('../../src/store');

async function main() {
  const spec = JSON.parse(process.argv[2]);
  if (spec.crashOnCommit) {
    // Dies at the moment the finished temporary file would replace the history
    // file: the write is complete on disk but never committed.
    const rename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      if (String(to).endsWith('conversations.json')) {
        process.exit(9);
      }
      return rename(from, to);
    };
  }
  const context = createContext({ storageDir: spec.storageDir });
  const store = new ConversationStore(context);
  if (spec.context) {
    // A window's context (stage 2): new chats are tagged with it.
    store.setContext(spec.context);
  }
  if (spec.lockOptions) {
    store.lockOptions = { ...store.lockOptions, ...spec.lockOptions };
  }
  if (spec.startAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, spec.startAt - Date.now())));
  }

  const results = [];
  const vars = {};
  for (const step of spec.ops) {
    try {
      await runStep(step);
    } catch (error) {
      if (!spec.continueOnError) throw error;
      results.push({ op: step.op, content: step.content, error: String(error?.message || error), code: error?.code });
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, label: spec.label, results, vars })}\n`);

  async function runStep(step) {
    const conversationId = step.conversationId || vars[step.conversationVar];
    switch (step.op) {
      case 'init':
        await store.initialize();
        break;
      case 'new': {
        const conversation = await store.newConversation();
        if (step.as) vars[step.as] = conversation.id;
        results.push({ op: 'new', id: conversation.id });
        break;
      }
      case 'add': {
        const message = await store.addMessage(step.role || 'user', step.content, conversationId);
        if (step.as) vars[step.as] = message.id;
        results.push({ op: 'add', id: message.id, content: step.content });
        break;
      }
      case 'select':
        await store.selectConversation(conversationId);
        break;
      case 'update':
        await store.updateMessage(conversationId, vars[step.messageVar], step.content, step.details || {});
        break;
      case 'move':
        // Changes the chat's context tag (Move or Relink), as the view does.
        await store.moveConversation(conversationId, step.tag);
        results.push({ op: 'move' });
        break;
      case 'remove':
        await store.removeMessage(conversationId, vars[step.messageVar]);
        break;
      case 'checkpoints': {
        // 0.4.0: a window streaming a reply, saving its text every
        // `intervalMs` for `count` rounds (as the engine does, much faster).
        let written = 0;
        let skipped = 0;
        for (let round = 0; round < step.count; round += 1) {
          const ok = await store.checkpointReply(conversationId, step.messageId || vars[step.messageVar], `${step.content || 'partial'} ${round}`);
          if (ok) written += 1; else skipped += 1;
          await new Promise((resolve) => setTimeout(resolve, step.intervalMs || 50));
        }
        results.push({ op: 'checkpoints', written, skipped });
        break;
      }
      case 'holdLock': {
        // Takes the history lock like a window in the middle of a save.
        await acquireLock(path.join(spec.storageDir, 'conversations.lock'));
        results.push({ op: 'holdLock' });
        process.stdout.write(`${JSON.stringify({ ok: true, label: spec.label, holding: true })}\n`);
        break;
      }
      case 'sleep':
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        break;
      case 'crash':
        // Simulates a hard crash: no finally blocks, no lock release.
        process.exit(step.code ?? 3);
        break;
      default:
        throw new Error(`Unknown op ${step.op}`);
    }
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error), code: error?.code })}\n`);
  process.exitCode = 1;
});
