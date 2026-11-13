'use strict';

// Test-only host for the integration suite when Kenlith itself is loaded as
// an installed extension (not as the development extension). Does nothing.
function activate() {}
function deactivate() {}

module.exports = { activate, deactivate };
