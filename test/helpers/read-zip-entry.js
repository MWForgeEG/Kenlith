'use strict';

// Reads one file out of a ZIP archive (a .vsix is one) into memory, for the
// old-release read-back test. Read-only: nothing is extracted to disk and
// nothing is installed. Supports stored and deflated entries.

const fs = require('node:fs');
const zlib = require('node:zlib');

// Text by default; { raw: true } returns the bytes (for binary files such as icons).
function readZipEntry(archivePath, entryName, { raw = false } = {}) {
  const data = fs.readFileSync(archivePath);
  let end = data.length - 22;
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip archive');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      const localName = data.readUInt16LE(localOffset + 26);
      const localExtra = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const body = data.subarray(start, start + compressedSize);
      const bytes = method === 0 ? body : zlib.inflateRawSync(body);
      return raw ? bytes : bytes.toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${entryName} not found in ${archivePath}`);
}

module.exports = { readZipEntry };
