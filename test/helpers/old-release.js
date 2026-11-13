'use strict';

// Loads the ConversationStore of an earlier release from its authentic VSIX
// (releases/ or backups/), for downgrade tests (WP-03 T03-07, T03-08). The
// store's own files are copied into a temporary folder and required there,
// with the fake `vscode` module; nothing is installed and the release files
// are only read.

const fs = require('node:fs');
const path = require('node:path');
const { makeOwnedTempDir } = require('./owned-temp');
const { readZipEntry } = require('./read-zip-entry');

const root = path.resolve(__dirname, '..', '..');
const PACKAGES = {
  // 0.4.0 downgrade tests: the accepted stable 0.3.0 (store with provenance).
  '0.3.0': { vsix: path.join(root, 'releases', 'plan-chat-antigravity-0.3.0.vsix'), files: ['store.js', 'lock.js', 'fsutil.js', 'provenance.js'] },
  '0.2.0': { vsix: path.join(root, 'releases', 'plan-chat-antigravity-0.2.0.vsix'), files: ['store.js', 'lock.js', 'fsutil.js'] },
  '0.1.2': { vsix: path.join(root, 'releases', 'plan-chat-antigravity-0.1.2.vsix'), files: ['store.js', 'lock.js', 'fsutil.js'] },
  '0.1.0': { vsix: path.join(root, 'backups', 'baseline-0.1.0', 'plan-chat-antigravity-0.1.0.vsix'), files: ['store.js'] }
};

function loadOldStore(version) {
  const spec = PACKAGES[version];
  if (!spec) throw new Error(`no package for ${version}`);
  const directory = makeOwnedTempDir(`plan-chat-old-${version}-`);
  for (const file of spec.files) {
    fs.writeFileSync(path.join(directory, file), readZipEntry(spec.vsix, `extension/src/${file}`));
  }
  return require(path.join(directory, 'store.js'));
}

module.exports = { loadOldStore };
