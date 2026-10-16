#!/usr/bin/env node
/**
 * Validates logos/ before the build (logos/README.md is the convention; scripts/logos.js does the checking).
 * A file of the wrong size, format or name fails the build, and with it the deploy. The client's Vite plugin runs
 * the same check, so `vite build` alone can't ship a bad file either.
 *
 *   node scripts/check-logos.js [folder]     (default: logos/ at the repo root)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeProblems, readLibrary } from './logos.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] ?? resolve(ROOT, 'logos'));
const { logos, problems } = readLibrary(dir);

if (problems.length) {
  console.error(`\n${describeProblems(problems)}\n`);
  process.exit(1);
}
console.log(`logos ok — ${logos.length === 0 ? 'the library is empty' : `${logos.length} logo${logos.length === 1 ? '' : 's'}`}`);
