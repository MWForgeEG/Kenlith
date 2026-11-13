'use strict';

// Downgrade and upgrade-compatibility tests load the code of earlier Kenlith
// (Plan Chat) releases from their original release packages. Those historical
// packages are not distributed in this repository, so the tests that need them
// are skipped here with this reason. They run as part of the release gates
// before every stable Kenlith release (see docs/RELEASING.md).

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const FILES = [
  'releases/plan-chat-antigravity-0.1.1.vsix',
  'releases/plan-chat-antigravity-0.1.2.vsix',
  'releases/plan-chat-antigravity-0.2.0.vsix',
  'releases/plan-chat-antigravity-0.3.0.vsix',
  'backups/baseline-0.1.0/plan-chat-antigravity-0.1.0.vsix',
  'backups/release-baseline-2026-10-28/src/project.js'
];

const missing = FILES.filter((file) => !fs.existsSync(path.join(root, file)));

// false when every historical package is present; otherwise the skip reason.
const HISTORICAL_SKIP = missing.length === 0
  ? false
  : 'needs historical release packages that are not distributed in this repository';

module.exports = { HISTORICAL_SKIP };
