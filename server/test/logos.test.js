import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readLibrary, titleCase } from '../../scripts/logos.js';

// Image headers only: the library reads sizes and flags from headers, so these stand in for real art in a temp
// folder. Nothing here is ever in logos/.
function png(width, height, { animated = false } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(animated ? [chunk('acTL', Buffer.alloc(8))] : []),
    chunk('IDAT', Buffer.alloc(10)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function webp(width, height, { animated = false } = {}) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const dirs = [];
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nu-logos-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('each file declares one logo; its name is the file title-cased unless names.json says otherwise', () => {
  const dir = folder({
    'README.md': '# logos',
    'v-rising.webp': webp(1200, 300),
    'final-fantasy-xiv.png': png(1200, 300),
    'helldivers-2.webp': webp(1200, 300),
    'names.json': JSON.stringify({ 'final-fantasy-xiv': 'Final Fantasy XIV' }),
  });
  const { logos, problems } = readLibrary(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    logos.map((l) => [l.id, l.name]),
    [
      ['final-fantasy-xiv', 'Final Fantasy XIV'],
      ['helldivers-2', 'Helldivers 2'],
      ['v-rising', 'V Rising'],
    ],
  );
  assert.equal(titleCase('sons-of-the-forest'), 'Sons Of The Forest');
});

test('an empty library is fine', () => {
  assert.deepEqual(readLibrary(folder({ 'README.md': '' })), { logos: [], problems: [] });
});

test('every kind of bad file is reported by name, and all of them at once', () => {
  const dir = folder({
    'too-small.webp': webp(600, 150),
    'square.png': png(1200, 1200),
    'Bad Name.webp': webp(1200, 300),
    'logo.svg': '<svg onload="alert(1)"/>',
    'photo.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    'moving.webp': webp(1200, 300, { animated: true }),
    'moving-png.png': png(1200, 300, { animated: true }),
    'liar.png': webp(1200, 300),
    'not-an-image.webp': Buffer.from('hello'),
    'huge.webp': Buffer.concat([webp(1200, 300), Buffer.alloc(201 * 1024)]),
    'names.json': JSON.stringify({ 'no-such-game': 'Ghost' }),
  });
  const { logos, problems } = readLibrary(dir);
  assert.deepEqual(logos, []);
  const text = problems.join('\n');
  for (const expected of [
    /too-small\.webp: 600 × 150 px; logo art must be exactly 1200 × 300 px/,
    /square\.png: 1200 × 1200 px/,
    /Bad Name\.webp: name it after the game in lowercase kebab-case/,
    /logo\.svg: name it/,
    /photo\.jpg: name it/,
    /moving\.webp: animated images aren't allowed/,
    /moving-png\.png: animated images aren't allowed/,
    /liar\.png: the file is really WEBP, not PNG/,
    /not-an-image\.webp: not a PNG or WebP image/,
    /huge\.webp: \d+ KB, over the 200 KB limit/,
    /names\.json: "no-such-game" has no image/,
  ]) {
    assert.match(text, expected);
  }
  assert.equal(problems.length, 11);
});

test('two formats of one game, and a broken names.json, are refused', () => {
  const dup = readLibrary(folder({ 'valheim.webp': webp(1200, 300), 'valheim.png': png(1200, 300) }));
  assert.match(dup.problems.join('\n'), /already a logo called "valheim"/);
  const broken = readLibrary(folder({ 'valheim.webp': webp(1200, 300), 'names.json': '{ nope' }));
  assert.match(broken.problems.join('\n'), /names\.json: not valid JSON/);
  const long = readLibrary(folder({ 'valheim.webp': webp(1200, 300), 'names.json': JSON.stringify({ valheim: 'x'.repeat(61) }) }));
  assert.match(long.problems.join('\n'), /must be 1 to 60 characters/);
});

test('check-logos fails the build with the list of problems; the real logos/ passes', () => {
  const script = resolve(fileURLToPath(import.meta.url), '../../../scripts/check-logos.js');
  const dir = folder({ 'too-small.webp': webp(600, 150) });
  let failed = null;
  try {
    execFileSync(process.execPath, [script, dir], { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    failed = err;
  }
  assert.ok(failed, 'exits non-zero');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /logos\/ has 1 problem/);
  assert.match(failed.stderr, /too-small\.webp: 600 × 150 px/);

  const ok = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  assert.match(ok, /^logos ok/);
});
