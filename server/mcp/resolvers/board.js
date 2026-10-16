import { z } from 'zod';
import { checkCode } from '../../core/codes.js';
import { isExpired, purgeAtOf } from '../../boards/retire.js';

/**
 * Shared by the board tools: finding a board by the code the caller gave, and nothing else. There is deliberately no
 * way to list, search or enumerate boards: a code is the key to its board, so the MCP never says a code it wasn't
 * given.
 *
 * A board with a password answers only LOCKED, whatever was asked: no title, cards, counts, logos, events, players
 * or dates. The MCP never takes a password, so it can never open one. The hash itself is never read here.
 */
export const LOCKED = Object.freeze({ status: 'locked' });

export const LOCKED_NOTE =
  'A board with a password answers only {"status":"locked"}, with nothing else about it; the MCP cannot open it ' +
  'and has no way to take a password, so don’t retry or ask for one.';

export const codeInput = z.string().max(64).describe('The board code, as typed into Next Up (case doesn’t matter).');

/**
 * The board for a code: { locked: true }, or { board } with { id, code, createdAt, deletedAt }. Throws (a message
 * safe to show, never repeating the code) for a malformed code, or one with no board. A board past its 24 hours of
 * deleting is gone, as the web app treats it, even before the sweep has erased it (the MCP can't erase anything).
 */
export function findBoard(db, rawCode, now = Date.now()) {
  const code = checkCode(rawCode);
  if (!code.ok) throw new Error(code.error);
  const row =
    db
      .prepare('SELECT id, code, created_at, deleted_at, password_hash IS NOT NULL AS locked FROM boards WHERE code = ? LIMIT 1')
      .get(code.code) ?? null;
  if (!row || isExpired(row, now)) throw new Error('There’s no board with that code.');
  if (row.locked) return { locked: true };
  return { board: { id: row.id, code: row.code, createdAt: row.created_at, deletedAt: row.deleted_at } };
}

/** While a board is being deleted: when that was asked for, and when it will be erased unless restored. Else null. */
export function deletionOf(board) {
  if (!board.deletedAt) return null;
  return { scheduledAt: board.deletedAt, purgeAt: new Date(purgeAtOf({ deleted_at: board.deletedAt })).toISOString() };
}
