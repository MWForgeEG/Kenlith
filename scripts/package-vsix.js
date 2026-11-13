'use strict';

// Builds dist/<name>-<version>.vsix from the project files using
// only Node.js built-ins. The layout matches the 0.1.0 and 0.1.1 releases:
// extension/<files>, [Content_Types].xml and extension.vsixmanifest.
// It never overwrites an existing VSIX.
//
// Options (WP-06):
//   --out <dir>       write into <dir> instead of dist/ (a candidate folder)
//   --label <text>    file name suffix, e.g. "rc1" → <name>-<version>-rc1.vsix
//                     (the package version inside is unchanged)
//   --artifact <base> file name base instead of package.json "name", e.g.
//                     "kenlith-antigravity" (Kenlith 0.4.1). The extension ID
//                     inside the package stays package.json publisher.name.
// SOURCE_DATE_EPOCH (seconds) fixes every entry's timestamp, so the same
// source gives a byte-identical file. Without it, the current time is used.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const option = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const label = option('--label');
if (label !== undefined && !/^[a-z0-9.-]+$/i.test(label)) throw new Error('--label may hold only letters, digits, dots and hyphens.');
const artifact = option('--artifact') || pkg.name;
if (!/^[a-z0-9][a-z0-9.-]*$/.test(artifact)) throw new Error('--artifact may hold only lowercase letters, digits, dots and hyphens.');
const outDir = path.resolve(root, option('--out') || 'dist');
const outFile = path.join(outDir, `${artifact}-${pkg.version}${label ? `-${label}` : ''}.vsix`);
const stamp = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date();
if (Number.isNaN(stamp.getTime())) throw new Error('SOURCE_DATE_EPOCH is not a number of seconds.');

if (fs.existsSync(outFile)) {
  console.error(`Refusing to overwrite ${outFile}`);
  process.exit(1);
}

const extensionFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'README.md',
  'SECURITY.md',
  'media/chat.svg',
  'media/chat-tab.svg',
  'media/icon.png',
  ...fs.readdirSync(path.join(root, 'src'))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => `src/${name}`)
];

const manifestTemplate = fs.readFileSync(path.join(root, 'build', 'extension.vsixmanifest'), 'utf8');
const identity = /<Identity\b[^>]*\bVersion="[^"]*"/;
if (!identity.test(manifestTemplate)) {
  throw new Error('build/extension.vsixmanifest has no Identity Version attribute.');
}
// The template's identity must be package.json's; it is never changed here.
const templateId = /<Identity\b[^>]*\bId="([^"]*)"/.exec(manifestTemplate)?.[1];
const templatePublisher = /<Identity\b[^>]*\bPublisher="([^"]*)"/.exec(manifestTemplate)?.[1];
if (templateId !== pkg.name || templatePublisher !== pkg.publisher) {
  throw new Error(`build/extension.vsixmanifest identity ${templatePublisher}.${templateId} does not match package.json ${pkg.publisher}.${pkg.name}.`);
}
// Version, display name, description, tags and engine come from package.json,
// so the two can no longer differ (R-24).
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (text, pattern, value, what) => {
  if (!pattern.test(text)) throw new Error(`build/extension.vsixmanifest has no ${what}.`);
  return text.replace(pattern, value);
};
let manifest = manifestTemplate.replace(identity, (match) => match.replace(/Version="[^"]*"/, `Version="${pkg.version}"`));
manifest = fill(manifest, /<DisplayName>[^<]*<\/DisplayName>/, `<DisplayName>${xml(pkg.displayName)}</DisplayName>`, 'DisplayName');
manifest = fill(manifest, /<Description xml:space="preserve">[^<]*<\/Description>/, `<Description xml:space="preserve">${xml(pkg.description)}</Description>`, 'Description');
manifest = fill(manifest, /<Tags>[^<]*<\/Tags>/, `<Tags>${xml((pkg.keywords || []).join(','))}</Tags>`, 'Tags');
manifest = fill(manifest, /(<Property Id="Microsoft\.VisualStudio\.Code\.Engine" Value=")[^"]*(")/, `$1${xml(pkg.engines.vscode)}$2`, 'engine property');

const entries = [
  ...extensionFiles.map((file) => ({ name: `extension/${file}`, data: fs.readFileSync(path.join(root, file)) })),
  { name: '[Content_Types].xml', data: fs.readFileSync(path.join(root, 'build', '[Content_Types].xml')) },
  { name: 'extension.vsixmanifest', data: Buffer.from(manifest, 'utf8') }
];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, zip(entries), { flag: 'wx' });
console.log(outFile);

function dosDateTime(date) {
  // UTC, so a fixed SOURCE_DATE_EPOCH gives the same bytes in any time zone.
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

function zip(files) {
  const { time, day } = dosDateTime(stamp);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = zlib.deflateRawSync(file.data);
    const crc = zlib.crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
