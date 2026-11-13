'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

// Windows reports sharing violations (antivirus, indexers, another process
// replacing the file) as EPERM/EBUSY/EACCES. They clear within milliseconds.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// About 6 seconds in total: replacing a file fails while another process is
// reading it, so a commit may need to wait out other windows' reads.
async function withRetry(operation, attempts = 36) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_CODES.has(error?.code) || attempt >= attempts - 1) {
        throw error;
      }
      await sleep(Math.min(200, 10 * 2 ** attempt) + Math.random() * 10);
    }
  }
}

// Returns the file text, or undefined when the file does not exist.
async function readTextIfExists(file) {
  try {
    return await withRetry(() => fs.promises.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// Writes a complete temporary file, flushes it to disk, then replaces the
// target in one rename. Readers see either the old or the new file, never a
// partial one; a crash leaves the old file intact plus an orphaned .tmp file.
async function writeFileAtomic(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await withRetry(() => fs.promises.rename(temporary, file));
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = { TRANSIENT_CODES, readTextIfExists, sleep, withRetry, writeFileAtomic };
