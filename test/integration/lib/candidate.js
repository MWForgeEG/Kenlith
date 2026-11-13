'use strict';

// WP-06: real-editor runs against the release-candidate package. When
// PLAN_CHAT_CANDIDATE_VSIX names a .vsix, its extension/ files are extracted
// once per process into a fresh temporary folder, and the runners load Plan
// Chat from there instead of the project's source. The package is only read.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { makeOwnedTempDir } = require('../../helpers/owned-temp');

// Every entry of a zip file: { name, bytes }.
function readZip(file) {
  const data = fs.readFileSync(file);
  let end = data.length - 22;
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error(`${file} is not a zip archive`);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const method = data.readUInt16LE(offset + 10);
    const size = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extra = data.readUInt16LE(offset + 30);
    const comment = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + size);
    out.push({ name, bytes: method === 0 ? body : zlib.inflateRawSync(body) });
    offset += 46 + nameLength + extra + comment;
  }
  return out;
}

// Writes the package's extension/ files into `target`.
function extractExtension(vsix, target) {
  for (const entry of readZip(vsix)) {
    if (!entry.name.startsWith('extension/') || entry.name.includes('..')) continue;
    const out = path.join(target, ...entry.name.slice('extension/'.length).split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, entry.bytes);
  }
  return target;
}

let extracted;
function candidateRoot() {
  const vsix = process.env.PLAN_CHAT_CANDIDATE_VSIX;
  if (!vsix) return undefined;
  if (!fs.existsSync(vsix)) throw new Error(`PLAN_CHAT_CANDIDATE_VSIX does not exist: ${vsix}`);
  if (!extracted) {
    extracted = extractExtension(vsix, makeOwnedTempDir('plan-chat-candidate-'));
    const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
    const version = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8')).version;
    // Recorded in every runner's log: which package this run tested.
    console.log(`[candidate] Kenlith ${version} from ${path.basename(vsix)} (sha256 ${hash})`);
  }
  return extracted;
}

module.exports = { candidateRoot, extractExtension, readZip };
