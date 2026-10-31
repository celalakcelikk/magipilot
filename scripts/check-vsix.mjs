// npm run package:check (docs/plans/phase-3-package.md AC2, K4): the packaged .vsix holds exactly
// the allowed files, is at most 1 MiB, and its bundle is the production one (no source map).
// Reads the archive with the system `unzip`.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vsix = join(root, process.argv[2] ?? `${pkg.name}-${pkg.version}.vsix`);
const MAX_BYTES = 1024 * 1024;
const ALLOWED = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/media/icon.png',
];
const ICON = 'extension/media/icon.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const unzip = (...args) =>
  execFileSync('unzip', [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

// Some Linux images ship without `unzip` (phase-5-linux D4): say so instead of a stack trace.
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(
      'package:check needs the `unzip` program; install it first (Debian/Ubuntu: sudo apt-get install unzip).',
    );
    process.exit(1);
  }
}

/**
 * Why `png` is not a whole, decodable icon PNG, or undefined when it is (Codex inspections
 * LOGO-001–003). The accepted form is the one media/icon.png is exported in, and nothing else:
 * - every chunk fits and has a good CRC;
 * - the chunks are exactly one 13-byte IHDR, one or more contiguous IDAT, and one empty IEND;
 * - the image is non-interlaced 8-bit RGBA;
 * - its IDAT data inflates to one filter byte and 4 × width bytes per row;
 * - every filter byte is 0–4.
 */
function pngProblem(png) {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return 'no PNG signature';
  const chunks = [];
  for (let at = 8; at < png.length;) {
    if (at + 12 > png.length) return 'a truncated chunk';
    const end = at + 12 + png.readUInt32BE(at);
    if (end > png.length) return 'a truncated chunk';
    const type = png.toString('latin1', at + 4, at + 8);
    if (crc32(png.subarray(at + 4, end - 4)) !== png.readUInt32BE(end - 4))
      return `a bad ${type} CRC`;
    chunks.push({ type, data: png.subarray(at + 8, end - 4) });
    at = end;
  }
  const sequence = chunks.map((chunk) => chunk.type).join(' ');
  if (!/^IHDR( IDAT)+ IEND$/.test(sequence)) {
    return `chunks other than IHDR, IDAT… and IEND (${sequence.slice(0, 60)})`;
  }
  if (chunks[0].data.length !== 13 || chunks.at(-1).data.length !== 0) {
    return 'an IHDR or IEND of the wrong length';
  }
  const idat = chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colour, compression, filter, interlace] = ihdr.subarray(8);
  if (width === 0 || height === 0) return 'an invalid IHDR';
  if (depth !== 8 || colour !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) {
    return 'not a non-interlaced 8-bit RGBA image';
  }
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(idat));
  } catch {
    return 'image data that does not inflate';
  }
  const rowBytes = 1 + 4 * width;
  if (pixels.length !== height * rowBytes) return 'image data of the wrong size';
  for (let row = 0; row < height; row++) {
    if (pixels[row * rowBytes] > 4) return `an unknown filter on row ${row}`;
  }
  return undefined;
}

const problems = [];
const files = unzip('-Z1', vsix).split('\n').filter(Boolean);
for (const file of files) if (!ALLOWED.includes(file)) problems.push(`unexpected file: ${file}`);
for (const file of ALLOWED) if (!files.includes(file)) problems.push(`missing file: ${file}`);

const size = statSync(vsix).size;
if (size > MAX_BYTES) problems.push(`the package has ${size} bytes, more than ${MAX_BYTES}`);

const bundle = unzip('-p', vsix, 'extension/dist/extension.js');
if (bundle.includes('sourceMappingURL')) problems.push('the bundle refers to a source map');
// A development bundle names every module in a `// src/...` comment; the minified one has none
// (line breaks stay inside template literals, so the line count says nothing).
if (/^\/\/ src\//m.test(bundle)) problems.push('the bundle is not the minified production build');
const lines = bundle.split('\n').length;

const manifest = JSON.parse(unzip('-p', vsix, 'extension/package.json'));
if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
  problems.push(`the packaged manifest is ${manifest.name}@${manifest.version}`);
}

// The icon (docs/plans/phase-4-logo.md): the manifest names it, and it is a square PNG of at
// least 128 px; the Marketplace refuses an SVG.
if (manifest.icon !== 'media/icon.png') problems.push(`the packaged icon is ${manifest.icon}`);
if (files.includes(ICON)) {
  const icon = execFileSync('unzip', ['-p', vsix, ICON], { maxBuffer: 16 * 1024 * 1024 });
  const broken = pngProblem(icon);
  if (broken) {
    problems.push(`the icon is not a valid PNG: ${broken}`);
  } else {
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    if (width !== height || width < 128) {
      problems.push(`the icon is not a square of at least 128 px (${width}×${height})`);
    }
  }
}

for (const problem of problems) console.error(`FAIL ${problem}`);
console.log(
  `package:check ${problems.length ? 'FAIL' : 'PASS'} — ${files.length} files, ${size} bytes, ` +
    `bundle ${bundle.length} characters in ${lines} lines`,
);
process.exit(problems.length ? 1 : 0);
