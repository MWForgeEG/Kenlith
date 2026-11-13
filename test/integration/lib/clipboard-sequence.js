'use strict';

// The Windows clipboard sequence number: a counter the system increases each
// time the clipboard changes. Reading it never reads the clipboard's
// contents. A test that leaves it unchanged did not write the clipboard.
// (Something else on the machine, such as the user copying text during the
// run, also changes it; a change is a reason to look, not proof of a write.)

const { execFileSync } = require('node:child_process');

const SCRIPT = [
  'Add-Type -Namespace PlanChat -Name Clip -MemberDefinition',
  "'[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();';",
  '[PlanChat.Clip]::GetClipboardSequenceNumber()'
].join(' ');

function clipboardSequence() {
  if (process.platform !== 'win32') return undefined;
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', SCRIPT], { encoding: 'utf8' }).trim());
  } catch {
    return undefined;
  }
}

module.exports = { clipboardSequence };
