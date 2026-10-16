/**
 * The logo library (logos/README.md): reads logos/, checks every file against the convention, and returns the
 * registry the client is built with. Used by scripts/check-logos.js (before the build) and by the client's Vite
 * plugin (client/vite.config.js), so a bad file fails the build, and with it the deploy.
 *
 * Each logo declares itself by its file: logos/v-rising.webp is the logo "v-rising". Its display name is the file
 * name title-cased ("V Rising"), unless logos/names.json gives one ({ "final-fantasy-xiv": "Final Fantasy XIV" }).
 *
 * Reads image headers itself (no image library): PNG's IHDR and acTL, WebP's VP8 / VP8L / VP8X.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WIDTH = 1200;
export const HEIGHT = 300;
export const MAX_BYTES = 200 * 1024;
export const NAME_MAX = 60; // a card title's limit: picking a logo fills the title with its name
const ID_MAX = 64;
const FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(webp|png)$/;
const ALLOWED_OTHER = new Set(['README.md', 'names.json', '.gitkeep']);

/** "v-rising" → "V Rising", "helldivers-2" → "Helldivers 2". */
export function titleCase(id) {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * { logos: [{ id, name, file, path, format, bytes }], problems: [string] }, logos sorted by name.
 * A non-empty `problems` means the library is broken and the build must stop.
 */
export function readLibrary(dir) {
  const problems = [];
  const logos = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { logos, problems: [`the logos folder is missing (${dir})`] };
  }

  for (const entry of entries) {
    const file = entry.name;
    if (ALLOWED_OTHER.has(file)) continue;
    if (!entry.isFile()) {
      problems.push(`${file}: only image files go in logos/, no folders`);
      continue;
    }
    const m = FILE.exec(file);
    if (!m) {
      problems.push(
        `${file}: name it after the game in lowercase kebab-case with a .webp or .png extension (letters a-z, digits and single hyphens), e.g. v-rising.webp`,
      );
      continue;
    }
    const [, id, ext] = m;
    if (id.length > ID_MAX) {
      problems.push(`${file}: the name before the extension can be at most ${ID_MAX} characters`);
      continue;
    }
    const path = join(dir, file);
    const bytes = statSync(path).size;
    if (bytes > MAX_BYTES) {
      problems.push(`${file}: ${Math.ceil(bytes / 1024)} KB, over the ${MAX_BYTES / 1024} KB limit; compress it (WebP, quality ~80)`);
      continue;
    }
    const head = readImage(readFileSync(path));
    if (head.error) {
      problems.push(`${file}: ${head.error}`);
      continue;
    }
    if (head.format !== ext) {
      problems.push(`${file}: the file is really ${head.format.toUpperCase()}, not ${ext.toUpperCase()}; fix the extension or re-export it`);
      continue;
    }
    if (head.animated) {
      problems.push(`${file}: animated images aren't allowed; export a single still frame`);
      continue;
    }
    if (head.width !== WIDTH || head.height !== HEIGHT) {
      problems.push(`${file}: ${head.width} × ${head.height} px; logo art must be exactly ${WIDTH} × ${HEIGHT} px`);
      continue;
    }
    if (logos.some((l) => l.id === id)) {
      problems.push(`${file}: there is already a logo called "${id}" in another format; keep one`);
      continue;
    }
    logos.push({ id, name: titleCase(id), file, path, format: ext, bytes });
  }

  // Display names that title-casing gets wrong ("Final Fantasy XIV").
  const namesPath = join(dir, 'names.json');
  let names = null;
  try {
    names = JSON.parse(readFileSync(namesPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') problems.push(`names.json: not valid JSON (${err.message})`);
  }
  if (names !== null) {
    if (typeof names !== 'object' || Array.isArray(names)) {
      problems.push('names.json: must be one object, { "file-name": "Display Name" }');
    } else {
      for (const [id, name] of Object.entries(names)) {
        const logo = logos.find((l) => l.id === id);
        if (!logo) {
          problems.push(`names.json: "${id}" has no image (expected logos/${id}.webp or .png); remove the entry or add the file`);
        } else if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > NAME_MAX) {
          problems.push(`names.json: the name for "${id}" must be 1 to ${NAME_MAX} characters`);
        } else {
          logo.name = name.trim().replace(/\s+/g, ' ');
        }
      }
    }
  }

  logos.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { logos, problems };
}

/** One message for a broken library, listing every problem. */
export function describeProblems(problems) {
  return [
    `logos/ has ${problems.length} problem${problems.length === 1 ? '' : 's'} (see logos/README.md):`,
    ...problems.map((p) => `  - ${p}`),
  ].join('\n');
}

/** { format, width, height, animated } or { error }. */
export function readImage(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return readPng(buf);
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return readWebp(buf);
  return { error: 'not a PNG or WebP image (SVG, JPEG and others aren’t allowed)' };
}

function readPng(buf) {
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return { error: 'a damaged PNG (no IHDR header)' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // APNG declares itself with an acTL chunk before the first IDAT.
  let animated = false;
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'acTL') animated = true;
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + len;
  }
  return { format: 'png', width, height, animated };
}

function readWebp(buf) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const flags = buf[20];
    return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), animated: Boolean(flags & 0x02) };
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return { error: 'a damaged WebP (bad VP8 frame header)' };
    return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return { error: 'a damaged WebP (bad VP8L signature)' };
    const bits = buf.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
  }
  return { error: 'a WebP of a kind Next Up can’t read' };
}
