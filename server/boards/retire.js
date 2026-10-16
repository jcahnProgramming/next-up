/**
 * Retiring a board: deleting it, with 24 hours to change your mind.
 *
 * Deleting only schedules it: `boards.deleted_at` is set to when it was asked for, and for RETIRE_MS the board is
 * "deleting". Everyone who can open it still can, and sees the countdown; nothing on it can change (the routes refuse,
 * and the database refuses any event but the deletion's own: migration 006) until someone restores it, which clears
 * `deleted_at`. Its code stays taken and it still counts against the board cap.
 *
 * Once RETIRE_MS has passed, the board is purged: its players, cards, events and row, in one transaction, and its
 * code is free. The sweep does it every SWEEP_MS (index.js); opening or creating its code after the deadline does it
 * first, so "deleted in 0m" is never a board that still opens. Purging is the one exception to keeping boards and
 * their history forever (CLAUDE.md "Data rules"). It never touches a board whose `deleted_at` is NULL (restored, or
 * never deleted), and the database refuses that too (the *_purge_only_retired triggers, migration 001–003).
 */
export const RETIRE_MS = 24 * 60 * 60 * 1000;
export const SWEEP_MS = 10 * 60 * 1000;
// Boards purged per sweep, at most; the next sweep takes the rest. There are never more than MAX_BOARDS.
const SWEEP_BATCH = 50;

const iso = (ms) => new Date(ms).toISOString();

/** When a retired board's row (deleted_at set) is purged, as ms since the epoch. */
export const purgeAtOf = (row) => Date.parse(row.deleted_at) + RETIRE_MS;

/** True once a retired board is past its 24 hours: it is gone, whether or not the sweep has run yet. */
export const isExpired = (row, now) => Boolean(row?.deleted_at) && now >= purgeAtOf(row);

/**
 * What a board's API says about it (to anyone with access): its code, whether it has a password, when it was made,
 * and, while it's being deleted, `deletion` { scheduledAt, purgeAt, leftMs }. `leftMs` is measured by the server at
 * the moment of answering, so the browser counts down from it rather than trusting its own clock against purgeAt.
 */
export function boardBody(row, now) {
  return {
    code: row.code,
    hasPassword: row.password_hash !== null,
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletion: deletionOf(row, now) } : {}),
  };
}

function deletionOf(row, now) {
  const purgeAt = purgeAtOf(row);
  return { scheduledAt: row.deleted_at, purgeAt: iso(purgeAt), leftMs: Math.max(0, purgeAt - now) };
}

/** The deleted_at a deletion scheduled now writes. */
export const deletedAtNow = (now) => iso(now);

/**
 * Purges one board if, inside this transaction, it is still retired and past its 24 hours. True when it was purged.
 * Players go first (they reference cards), then cards, then events (one statement, so restores that reference other
 * events of the board go with them), then the board.
 */
export function purgeBoard(db, boardId, now) {
  return db.transaction(() => {
    const row = db.prepare('SELECT id, deleted_at FROM boards WHERE id = ? LIMIT 1').get(boardId);
    if (!row || !isExpired(row, now)) return false;
    db.prepare('DELETE FROM players WHERE card_id IN (SELECT id FROM cards WHERE board_id = ?)').run(boardId);
    db.prepare('DELETE FROM cards WHERE board_id = ?').run(boardId);
    db.prepare('DELETE FROM events WHERE board_id = ?').run(boardId);
    db.prepare('DELETE FROM boards WHERE id = ? AND deleted_at IS NOT NULL').run(boardId);
    return true;
  }).immediate();
}

/**
 * Purges every board past its 24 hours (at most SWEEP_BATCH per call; the next sweep takes the rest). Safe to run
 * any number of times, from any number of places: each board is re-checked inside its own transaction. Returns the
 * purged board ids, so their live streams can be told.
 */
export function sweepRetired(db, now) {
  const due = db
    .prepare('SELECT id FROM boards WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY deleted_at LIMIT ?')
    .pluck()
    .all(iso(now - RETIRE_MS), SWEEP_BATCH);
  return due.filter((id) => purgeBoard(db, id, now));
}
