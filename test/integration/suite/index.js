'use strict';

// Runs inside a real editor extension host (VS Code or Antigravity IDE).
// Phase "first" creates a chat; phase "second" runs after a full restart of the
// editor against the same profile and checks that the chat survived.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'local-open-source.plan-chat-antigravity';

// Phase "concurrent": two editor processes whose globalStorage folders point to
// one shared synthetic folder write to the same history at the same moment,
// through the activated extension's command and through src/store.js loaded
// inside this real extension host.
async function runConcurrent() {
  const label = process.env.PLAN_CHAT_IT_LABEL;
  const shared = process.env.PLAN_CHAT_IT_SHARED;
  const report = { host: vscode.env.appName, version: vscode.version, label, pid: process.pid, saved: [], errors: [] };
  try {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    const { ConversationStore } = require(path.join(extension.extensionPath, 'src', 'store.js'));
    const store = new ConversationStore({ globalStorageUri: vscode.Uri.file(shared) });
    await store.initialize();

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(process.env.PLAN_CHAT_IT_START_AT) - Date.now())));
    for (let index = 0; index < 40; index += 1) {
      const content = `${label}-${index} مرحبا 👋🏽`;
      try {
        await store.addMessage('user', content, 'shared-chat');
        report.saved.push(content);
        if (index % 10 === 9) {
          await vscode.commands.executeCommand('planChat.newChat');
          report.saved.push(`${label}:newChat`);
        }
      } catch (error) {
        report.errors.push(String(error?.message || error));
      }
    }
  } catch (error) {
    report.errors.push(String(error?.stack || error));
  }
  fs.writeFileSync(process.env.PLAN_CHAT_IT_RESULT, JSON.stringify(report, null, 2));
}

// Phase "restricted": the window was opened on an untrusted synthetic folder
// with trust enforcement on. Records what the editor really does with the
// extension; assertions are made by the runner.
async function runRestricted() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const activeBefore = Boolean(extension?.isActive);
  let openResult;
  try {
    // Executing a contributed command would activate an enabled extension.
    await vscode.commands.executeCommand('planChat.open');
    openResult = 'executed';
  } catch (error) {
    openResult = `rejected: ${String(error?.message || error).slice(0, 120)}`;
  }
  const commands = await vscode.commands.getCommands(true);
  fs.writeFileSync(process.env.PLAN_CHAT_IT_RESULT, JSON.stringify({
    host: vscode.env.appName,
    version: vscode.version,
    isTrusted: vscode.workspace.isTrusted,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).length,
    extensionFound: Boolean(extension),
    extensionPath: extension?.extensionPath,
    activeBefore,
    extensionActive: Boolean(extension?.isActive),
    commandRegistered: commands.includes('planChat.open'),
    openResult
  }, null, 2));
}

// Phase "config": user settings, workspace settings and a language override
// were written by the runner. Records the editor's own merge and inspect()
// layers, and what the extension's settings reader returns.
async function runConfig() {
  const configuration = vscode.workspace.getConfiguration('planChat');
  const languageScoped = vscode.workspace.getConfiguration('planChat', { languageId: 'plaintext' });
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const report = {
    host: vscode.env.appName,
    version: vscode.version,
    isTrusted: vscode.workspace.isTrusted,
    get: {
      instructions: configuration.get('instructions'),
      maxHistoryMessages: configuration.get('maxHistoryMessages')
    },
    inspect: {
      instructions: configuration.inspect('instructions'),
      maxHistoryMessages: configuration.inspect('maxHistoryMessages')
    },
    languageScoped: {
      get: languageScoped.get('instructions'),
      inspect: languageScoped.inspect('instructions')
    }
  };
  const settingsModule = path.join(extension.extensionPath, 'src', 'settings.js');
  if (fs.existsSync(settingsModule)) {
    const settings = require(settingsModule);
    // Kenlith 0.4.1: activation copies the user's planChat.* values to
    // kenlith.* (src/settings.js). Recorded after activation.
    if (settings.SECTION === 'kenlith') {
      await extension.activate();
      const kenlith = vscode.workspace.getConfiguration('kenlith');
      report.kenlith = {
        get: { instructions: kenlith.get('instructions'), maxHistoryMessages: kenlith.get('maxHistoryMessages') },
        inspect: { instructions: kenlith.inspect('instructions'), maxHistoryMessages: kenlith.inspect('maxHistoryMessages') },
        legacyAfter: vscode.workspace.getConfiguration('planChat').inspect('instructions')?.globalValue
      };
    }
    report.extensionReads = {
      instructions: settings.userInstructions(),
      maxHistoryMessages: settings.userMaxHistoryMessages()
    };
  } else {
    report.extensionReads = 'src/settings.js not present (baseline)';
  }
  fs.writeFileSync(process.env.PLAN_CHAT_IT_RESULT, JSON.stringify(report, null, 2));
}

async function run() {
  const phase = process.env.PLAN_CHAT_IT_PHASE;
  if (phase === 'concurrent') {
    return runConcurrent();
  }
  if (phase === 'restricted') {
    return runRestricted();
  }
  if (phase === 'config') {
    return runConfig();
  }
  const resultFile = process.env.PLAN_CHAT_IT_RESULT;
  const results = [];
  const check = async (name, body) => {
    try {
      await body();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.stack || error) });
    }
  };

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const historyFile = path.join(process.env.PLAN_CHAT_IT_USER_DATA, 'User', 'globalStorage', EXTENSION_ID, 'conversations.json');
  const readHistory = () => JSON.parse(fs.readFileSync(historyFile, 'utf8'));

  await check('extension is present and activates', async () => {
    assert.ok(extension, 'extension not found');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  await check('commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['planChat.open', 'planChat.signIn', 'planChat.signOut', 'planChat.newChat']) {
      assert.ok(commands.includes(command), `${command} missing`);
    }
  });

  await check('the chat view opens', async () => {
    await vscode.commands.executeCommand('planChat.open');
  });

  if (phase === 'first') {
    await check('+ on an empty chat stays on it; + on a chat with messages creates a new chat', async () => {
      const empty = readHistory().currentId;
      await vscode.commands.executeCommand('planChat.newChat');
      assert.equal(readHistory().currentId, empty, 'an empty chat is reused, not replaced');
      assert.equal(readHistory().conversations.length, 1);

      // A second store instance on the same folder writes a message, as
      // another window would; the extension's own store must see it.
      const { ConversationStore } = require(path.join(extension.extensionPath, 'src', 'store.js'));
      const other = new ConversationStore({ globalStorageUri: vscode.Uri.file(path.dirname(historyFile)) });
      await other.addMessage('user', 'رسالة من نافذة أخرى 👋🏽', empty);

      await vscode.commands.executeCommand('planChat.newChat');
      const history = readHistory();
      assert.equal(history.version, 1);
      assert.notEqual(history.currentId, empty, 'new chat did not get a new ID');
      assert.equal(history.conversations.length, 2);
      fs.writeFileSync(process.env.PLAN_CHAT_IT_STATE, JSON.stringify({ empty, created: history.currentId }));
    });
  } else {
    await check('both chats from the previous session survived the restart', async () => {
      const { empty, created } = JSON.parse(fs.readFileSync(process.env.PLAN_CHAT_IT_STATE, 'utf8'));
      const history = readHistory();
      assert.ok(history.conversations.some((conversation) => conversation.id === created), 'new chat missing');
      const first = history.conversations.find((conversation) => conversation.id === empty);
      assert.equal(first?.messages[0]?.content, 'رسالة من نافذة أخرى 👋🏽');
      assert.equal(history.currentId, created, 'the last opened chat is remembered');
    });
  }

  await check('atomic saves leave no temporary files behind', async () => {
    const files = fs.readdirSync(path.dirname(historyFile));
    assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);
  });

  fs.writeFileSync(resultFile, JSON.stringify({ host: vscode.env.appName, version: vscode.version, results }, null, 2));
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    throw new Error(`${failed.length} integration check(s) failed`);
  }
}

module.exports = { run };
