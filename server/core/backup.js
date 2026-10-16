import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nightly backups of the database (RESTORE.md says how to put one back).
 *
 * SQLite's online backup API copies the open database page by page, restarting if a write lands mid-copy, so a backup
 * is a consistent snapshot even while boards are being edited. The raw file is never copied. Each copy is written as
 * a hidden `.staged` file in the staging folder, switched out of WAL mode (so it is one self-contained file), opened
 * again and checked with `PRAGMA integrity_check`, copied to the backup folder and compared byte for byte, and only
 * then renamed to `next-up-YYYY-MM-DD.db` (the UTC date). A copy that fails
 * any step is removed and the failure is logged as `[backup] FAILED`; the previous good backups stay.
 *
 * Kept KEEP_DAYS days: anything named like a backup and dated earlier is deleted after each good backup. Nothing
 * else in the folder is ever touched.
 *
 * A backup holds everything in the database, board password hashes and the access-grant signing key included: the
 * folder it goes to must be as private as the database itself.
 */
export const KEEP_DAYS = 30;
// When the nightly backup runs, in UTC (the container's clock). The copy is consistent at any hour; this is just quiet.
export const BACKUP_HOUR_UTC = 4;
const NAME = /^next-up-(\d{4}-\d{2}-\d{2})\.db$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const backupName = (ms) => `next-up-${new Date(ms).toISOString().slice(0, 10)}.db`;

/** The backups in `dir`, newest first: [{ name, date }]. */
export function listBackups(dir) {
  return readdirSync(dir)
    .map((name) => ({ name, date: NAME.exec(name)?.[1] }))
    .filter((b) => b.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Opens a backup file read-only and checks it. Throws unless it is a sound Next Up database. */
export function verifyBackup(file) {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = copy.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`integrity_check said: ${String(result).slice(0, 200)}`);
    // A sound file that isn't ours (or is empty) is no backup either.
    const migrations = copy.prepare("SELECT COUNT(*) FROM _migrations WHERE scope = 'core'").pluck().get();
    if (!migrations) throw new Error('no migrations recorded: not a Next Up database');
    return {
      boards: copy.prepare('SELECT COUNT(*) FROM boards').pluck().get(),
      events: copy.prepare('SELECT COUNT(*) FROM events').pluck().get(),
    };
  } finally {
    copy.close();
  }
}

/**
 * Takes one backup now. Resolves to { file, bytes, boards, events, removed } or rejects (partial files removed).
 * @param {{ db: import('better-sqlite3').Database, dir: string, stagingDir?: string, now?: number, pagesPerStep?: number }} opts
 *   stagingDir: where the copy is built and checked (default: dir). On <HOST> it's the data folder on the cache, so
 *     SQLite never opens a file on <USER_SHARE> (Unraid's FUSE share, where its file locking isn't dependable); the
 *     finished, closed file is then copied to dir and compared byte for byte.
 *   pagesPerStep: pages copied between yields to the event loop (default: SQLite's 100)
 */
export async function runBackup({ db, dir, stagingDir = dir, now = Date.now(), pagesPerStep = 100 }) {
  const name = backupName(now);
  const staged = join(stagingDir, `.${name}.staged`);
  const partial = join(dir, `.${name}.partial`);
  const cleanUp = () => {
    rmSync(staged, { force: true });
    rmSync(partial, { force: true });
  };
  cleanUp();
  try {
    await db.backup(staged, { progress: () => pagesPerStep });
    // The copy carries the source's WAL flag; a backup should be one file that opens anywhere, read-only included.
    const copy = new Database(staged, { fileMustExist: true });
    try {
      copy.pragma('journal_mode = DELETE');
    } finally {
      copy.close();
    }
    const counts = verifyBackup(staged);
    if (staged !== partial) {
      // A plain copy of a finished file nothing has open, checked to be identical before it counts.
      copyFileSync(staged, partial);
      if (sha256(staged) !== sha256(partial)) throw new Error('the copy in the backup folder differs from the checked one');
    }
    renameSync(partial, join(dir, name));
    rmSync(staged, { force: true });
    return { file: join(dir, name), bytes: statSync(join(dir, name)).size, ...counts, removed: prune(dir, now) };
  } catch (err) {
    cleanUp();
    throw err;
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Deletes backups dated more than KEEP_DAYS days before `now` (today's counts as day 1). Returns their names. */
export function prune(dir, now) {
  const oldest = new Date(now - (KEEP_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const removed = [];
  for (const { name, date } of listBackups(dir)) {
    if (date >= oldest) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** Ms from `now` until the next BACKUP_HOUR_UTC:00. */
export function msUntilNext(now) {
  const next = new Date(now);
  next.setUTCHours(BACKUP_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

/**
 * Runs backups every night at BACKUP_HOUR_UTC, and once shortly after start-up when the newest one is more than a
 * day old (a container that was down at 04:00 doesn't skip a night). Every failure is logged loudly. Returns stop().
 */
export function scheduleBackups({ db, dir, stagingDir = dir, now = Date.now, startDelayMs = 60_000, log = console }) {
  let timer = null;
  let stopped = false;
  const once = async () => {
    const started = now();
    try {
      const r = await runBackup({ db: db(), dir, stagingDir, now: started });
      log.log(`[backup] ${r.file}: ${r.bytes} bytes, integrity ok, ${r.boards} boards, ${r.events} events, ${now() - started} ms` +
        (r.removed.length ? `; removed ${r.removed.length} older than ${KEEP_DAYS} days` : ''));
    } catch (err) {
      // Error messages here come from SQLite and the file system (paths, never values from the database).
      log.error(`[backup] FAILED: no backup was written to ${dir}. ${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}`);
    }
  };
  const next = () => {
    if (stopped) return;
    timer = setTimeout(() => once().finally(next), msUntilNext(now()));
    timer.unref();
  };
  let newest = null;
  try {
    newest = listBackups(dir)[0]?.name ?? null;
  } catch (err) {
    log.error(`[backup] FAILED: can't read the backup folder ${dir}. ${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}`);
  }
  const newestMs = newest ? Date.parse(NAME.exec(newest)[1]) : 0;
  if (now() - newestMs > DAY_MS) {
    timer = setTimeout(() => once().finally(next), startDelayMs);
    timer.unref();
  } else {
    next();
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
