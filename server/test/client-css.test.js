import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(fileURLToPath(import.meta.url), '../../../client/src');

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [],
  );
}

// The production build's CSS minifier keeps only the LAST of `backdrop-filter` / `-webkit-backdrop-filter` when both
// carry the same value. Written standard-first, the build shipped only the -webkit- one, which Chrome and Edge
// ignore: every glass surface lost its blur in production (0.2.0–0.3.0), though `npm run dev` looked right.
test('backdrop-filter is written after -webkit-backdrop-filter, so the build keeps it', () => {
  const bad = [];
  for (const file of cssFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*backdrop-filter\s*:/.test(line) && /^\s*-webkit-backdrop-filter\s*:/.test(lines[i + 1] ?? '')) {
        bad.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(bad, [], `put -webkit-backdrop-filter first at: ${bad.join(', ')}`);
});
