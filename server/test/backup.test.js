import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { KEEP_DAYS, backupName, msUntilNext, prune, runBackup, scheduleBackups, verifyBackup } from '../core/backup.js';
import { runMigrations } from '../core/migrations.js';
import { coreMigrations } from '../core/schema.js';

// Real files in a temp folder (never data/): the backup API and WAL only mean anything on disk.
const root = mkdtempSync(join(tmpdir(), 'nu-backup-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function fileDb() {
  const dir = join(root, `case-${++n}`);
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  const db = new Database(join(dir, 'next-up.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const log = console.log;
  console.log = () => {};
  try {
    runMigrations(db, 'core', coreMigrations);
  } finally {
    console.log = log;
  }
  return { db, dir, backups };
}

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
const addBoards = (db, from, count) => {
  const insert = db.prepare('INSERT INTO boards (code, password_hash, password_version) VALUES (?, NULL, 0)');
  db.transaction(() => {
    for (let i = from; i < from + count; i++) insert.run(`board-${i}`);
  })();
};

test('a backup is a consistent, self-contained copy that passes integrity_check, even with writes during it', async () => {
  const { db, backups } = fileDb();
  addBoards(db, 0, 300);
  // Writes land while the backup is being taken: the online backup restarts as needed and the copy is a snapshot.
  // One page per step, so the copy spans many turns of the event loop and the writer really lands mid-copy.
  let writes = 0;
  const writer = setInterval(() => addBoards(db, 1000 + writes++, 1), 0);
  let r;
  try {
    r = await runBackup({ db, dir: backups, now: day('2026-10-16'), pagesPerStep: 1 });
  } finally {
    clearInterval(writer);
  }
  assert.ok(writes > 0, 'no write landed during the backup');
  assert.equal(r.file, join(backups, 'next-up-2026-10-16.db'));
  assert.ok(r.boards >= 300);
  assert.deepEqual(readdirSync(backups), ['next-up-2026-10-16.db']); // no -wal, -shm or .partial left behind
  const copy = new Database(r.file, { readonly: true });
  assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  copy.close();
  db.close();
});

test('a damaged copy fails verification instead of being kept as a backup', async () => {
  const { db, backups } = fileDb();
  addBoards(db, 0, 2000);
  const r = await runBackup({ db, dir: backups, now: day('2026-10-16') });
  db.close();
  // Overwrite a stretch of pages in the middle: the file still opens, but it isn't the database any more.
  const fd = openSync(r.file, 'r+');
  writeSync(fd, Buffer.alloc(8192, 0xab), 0, 8192, 8192);
  closeSync(fd);
  assert.throws(() => verifyBackup(r.file));
  // And something that isn't a Next Up database at all.
  const other = join(backups, 'other.db');
  new Database(other).close();
  assert.throws(() => verifyBackup(other), /not a Next Up database|no such table/);
});

test(`backups are named by UTC date and kept ${KEEP_DAYS} days; nothing else in the folder is touched`, async () => {
  const { db, backups } = fileDb();
  assert.equal(backupName(Date.parse('2026-10-16T23:59:59Z')), 'next-up-2026-10-16.db');
  for (const d of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-10-15']) writeFileSync(join(backups, `next-up-${d}.db`), '');
  writeFileSync(join(backups, 'keep-me.txt'), 'mine');
  writeFileSync(join(backups, 'next-up-2020-01-01.db.bak'), 'not a backup name');
  const r = await runBackup({ db, dir: backups, now: day('2026-10-16') });
  // 30 days kept: 2026-09-17 … 2026-10-16.
  assert.deepEqual(r.removed.sort(), ['next-up-2026-09-15.db', 'next-up-2026-09-16.db']);
  assert.deepEqual(readdirSync(backups).sort(), [
    'keep-me.txt', 'next-up-2020-01-01.db.bak', 'next-up-2026-09-17.db', 'next-up-2026-10-15.db', 'next-up-2026-10-16.db',
  ]);
  assert.deepEqual(prune(backups, day('2026-10-16')), []);
  db.close();
});

test('a failed backup is logged loudly and leaves the earlier backups alone', async () => {
  const { db, backups } = fileDb();
  writeFileSync(join(backups, 'next-up-2026-10-15.db'), 'yesterday');
  const lines = [];
  const log = { log: (l) => lines.push(['log', l]), error: (l) => lines.push(['error', l]) };
  const missing = join(backups, 'not-mounted');
  const stop = scheduleBackups({ db: () => db, dir: missing, now: () => day('2026-10-16'), startDelayMs: 0, log });
  await new Promise((r) => setTimeout(r, 200));
  stop();
  assert.ok(lines.some(([kind, l]) => kind === 'error' && l.startsWith('[backup] FAILED')), JSON.stringify(lines));
  assert.ok(lines.every(([kind]) => kind === 'error'));
  assert.deepEqual(readdirSync(backups), ['next-up-2026-10-15.db']);
  db.close();
});

test('the schedule backs up at start-up when the newest backup is over a day old, then nightly at 04:00 UTC', async () => {
  const { db, backups } = fileDb();
  const lines = [];
  const log = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
  const stop = scheduleBackups({ db: () => db, dir: backups, now: () => day('2026-10-16'), startDelayMs: 0, log });
  await new Promise((r) => setTimeout(r, 300));
  stop();
  assert.match(lines[0], /^\[backup\] .*next-up-2026-10-16\.db: \d+ bytes, integrity ok/);
  assert.equal(msUntilNext(Date.parse('2026-10-16T03:00:00Z')), 60 * 60 * 1000);
  assert.equal(msUntilNext(Date.parse('2026-10-16T04:00:00Z')), 24 * 60 * 60 * 1000);
  // Today's backup exists: a restart later today doesn't take another.
  const again = [];
  const stop2 = scheduleBackups({ db: () => db, dir: backups, now: () => day('2026-10-16'), startDelayMs: 0, log: { log: (l) => again.push(l), error: (l) => again.push(l) } });
  await new Promise((r) => setTimeout(r, 100));
  stop2();
  assert.deepEqual(again, []);
  db.close();
});

test('built and checked in the staging folder, then copied to the backup folder byte for byte, leaving nothing behind', async () => {
  const { db, dir, backups } = fileDb();
  addBoards(db, 0, 50);
  const r = await runBackup({ db, dir: backups, stagingDir: dir, now: day('2026-10-16') });
  assert.deepEqual(readdirSync(backups), ['next-up-2026-10-16.db']);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('staged')), []);
  assert.equal(verifyBackup(r.file).boards, 50);
  db.close();
});
