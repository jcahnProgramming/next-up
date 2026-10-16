#!/usr/bin/env node
/**
 * Validates CHANGELOG.json before the build.
 *
 * Wire into package.json:
 *   "build": "node scripts/check-changelog.js && <your build command>"
 *
 * A malformed entry fails the build, and with it the deploy. That is the
 * whole point: a changelog you can forget is a changelog that rots.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'CHANGELOG.json');

const ALLOWED_SECTIONS = ['New', 'Improved', 'Fixed', 'Removed'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  console.error(`\nCHANGELOG.json: ${message}\n`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(FILE, 'utf8');
} catch {
  fail(`not found at ${FILE}`);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (err) {
  fail(`is not valid JSON — ${err.message}`);
}

if (!Array.isArray(doc.releases) || doc.releases.length === 0) {
  fail('needs a non-empty "releases" array');
}

const compare = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

let previous = null;

doc.releases.forEach((entry, index) => {
  const where = `releases[${index}]`;

  if (typeof entry.version !== 'string' || !SEMVER.test(entry.version)) {
    fail(`${where}.version must look like 1.2.3 — got ${JSON.stringify(entry.version)}`);
  }
  if (typeof entry.date !== 'string' || !ISO_DATE.test(entry.date)) {
    fail(`${where}.date must be YYYY-MM-DD — got ${JSON.stringify(entry.date)}`);
  }
  if (Number.isNaN(Date.parse(entry.date))) {
    fail(`${where}.date is not a real date — got ${entry.date}`);
  }
  if (typeof entry.title !== 'string' || entry.title.trim() === '') {
    fail(`${where}.title must be a non-empty string`);
  }
  if (typeof entry.sections !== 'object' || entry.sections === null) {
    fail(`${where}.sections must be an object`);
  }

  const names = Object.keys(entry.sections);
  if (names.length === 0) {
    fail(`${where}.sections is empty — omit sections that don't apply, but keep at least one`);
  }
  for (const name of names) {
    if (!ALLOWED_SECTIONS.includes(name)) {
      fail(`${where}.sections has unknown section "${name}" — allowed: ${ALLOWED_SECTIONS.join(', ')}`);
    }
    const items = entry.sections[name];
    if (!Array.isArray(items) || items.length === 0) {
      fail(`${where}.sections.${name} must be a non-empty array — omit the section instead`);
    }
    items.forEach((item, i) => {
      if (typeof item !== 'string' || item.trim() === '') {
        fail(`${where}.sections.${name}[${i}] must be a non-empty string`);
      }
    });
  }

  if (previous && compare(entry.version, previous) >= 0) {
    fail(
      `${where}.version (${entry.version}) is not lower than the entry above it (${previous}) — ` +
      'newest release goes first'
    );
  }
  previous = entry.version;
});

console.log(`CHANGELOG.json ok — ${doc.releases.length} release(s), current ${doc.releases[0].version}`);
