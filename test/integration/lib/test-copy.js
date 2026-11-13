'use strict';

// Throwaway copies of the extension for real-editor tests. Nothing here is
// built into a VSIX or installed outside the sandbox folder it is given.
//
// - installedCopy: the runtime files as they would be installed (the editor
//   loads it as an installed extension, in Production mode).
// - testCopy: the same files plus test/integration/test-main.js as the entry
//   point. This copy, and only this copy, gives the view synthetic sign-in,
//   model, clipboard and browser. Its manifest is rewritten in the sandbox;
//   the project's package.json is not touched.

const fs = require('node:fs');
const path = require('node:path');

const { candidateRoot } = require('./candidate');

const root = path.resolve(__dirname, '..', '..', '..');
// Where Kenlith's runtime files come from: the project, or (WP-06) the
// release-candidate package named by PLAN_CHAT_CANDIDATE_VSIX.
const codeRoot = candidateRoot() || root;
const manifest = require(path.join(codeRoot, 'package.json'));
const RUNTIME = ['package.json', 'src', 'media', 'LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md'];

function copyRuntime(target) {
  for (const item of RUNTIME) {
    fs.cpSync(path.join(codeRoot, item), path.join(target, item), { recursive: true });
  }
}

function installedCopy(extensionsDir) {
  const target = path.join(extensionsDir, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
  copyRuntime(target);
  return target;
}

// `surface` (0.4.0):
// - 'legacy' (default): the chat webview in the side bar, as 0.3.0 laid it
//   out. The engine (src/engine.js) and the chat webview (src/view.js) are the
//   product's own; only this throwaway copy's manifest and entry put them in
//   the side bar, so the earlier suites (sidebar-ui, stage2, stage3,
//   webview-ui) keep checking every chat behaviour against the same code.
// - 'workspace': the product as shipped (Account and Chats trees, chats in
//   editor tabs), for test/integration/workspace-ui.js.
function testCopy(sandbox, { surface = process.env.PLAN_CHAT_IT_SURFACE || 'legacy' } = {}) {
  const target = path.join(sandbox, 'plan-chat-test-copy');
  copyRuntime(target);
  fs.copyFileSync(path.join(root, 'test', 'integration', 'test-main.js'), path.join(target, 'test-main.js'));
  fs.mkdirSync(path.join(target, 'test-scenario'), { recursive: true });
  fs.copyFileSync(path.join(root, 'test', 'integration', 'suite', 'sidebar-ui.js'), path.join(target, 'test-scenario', 'sidebar-ui.js'));
  fs.copyFileSync(path.join(root, 'test', 'integration', 'suite', 'stage2-ui.js'), path.join(target, 'test-scenario', 'stage2.js'));
  fs.copyFileSync(path.join(root, 'test', 'integration', 'suite', 'stage3-ui.js'), path.join(target, 'test-scenario', 'stage3.js'));
  fs.copyFileSync(path.join(root, 'test', 'integration', 'suite', 'workspace-ui.js'), path.join(target, 'test-scenario', 'workspace.js'));
  fs.copyFileSync(path.join(root, 'test', 'integration', 'suite', 'restart-review-ui.js'), path.join(target, 'test-scenario', 'restart-review.js'));
  // Kenlith 0.5.0: project awareness (test/integration/project-awareness.js).
  fs.copyFileSync(path.join(root, 'test', 'integration', 'suite', 'project-awareness-ui.js'), path.join(target, 'test-scenario', 'project.js'));
  const testManifest = { ...manifest, main: './test-main.js', activationEvents: [...manifest.activationEvents, 'onStartupFinished'], planChatTestSurface: surface };
  if (surface === 'legacy') {
    // Only the commands the legacy entry registers (the 0.3.0 set), so the
    // Command Palette offers nothing that is not wired in this copy.
    const legacyCommands = new Set(['planChat.open', 'planChat.signIn', 'planChat.signOut', 'planChat.newChat', 'planChat.showHistory', 'planChat.showAllChats', 'planChat.manageProjectSharing', 'planChat.chooseProject', 'planChat.moveToGeneral', 'planChat.attachSelection']);
    testManifest.activationEvents = testManifest.activationEvents.filter((event) => !event.startsWith('onCommand:') || legacyCommands.has(event.slice('onCommand:'.length)));
    testManifest.contributes = {
      ...manifest.contributes,
      commands: manifest.contributes.commands.filter((command) => legacyCommands.has(command.command)),
      views: { planChat: [{ type: 'webview', id: 'planChat.sidebar', name: 'Kenlith', icon: 'media/chat.svg', contextualTitle: 'Kenlith' }] },
      menus: {
        ...manifest.contributes.menus,
        'view/title': [
          { command: 'planChat.newChat', when: 'view == planChat.sidebar && planChat.signedIn', group: 'navigation@1' },
          { command: 'planChat.showHistory', when: 'view == planChat.sidebar && planChat.signedIn', group: 'navigation@2' }
        ],
        'view/item/context': [],
        commandPalette: manifest.contributes.menus.commandPalette.filter((item) => legacyCommands.has(item.command))
      }
    };
  }
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(testManifest, null, 2));
  return target;
}

module.exports = { installedCopy, testCopy, manifest, root, codeRoot };
