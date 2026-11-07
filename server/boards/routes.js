import express from 'express';
import { createCardsRouter } from '../cards/routes.js';
import { createHistoryRouter } from '../history/routes.js';
import { liveStream, liveWrites } from '../live/routes.js';
import { checkCode, checkNewPassword, normalizeCode } from '../core/codes.js';
import { appendEvent } from '../core/events.js';
import { hashPassword, verifyPassword } from '../core/passwords.js';
import { BOARD_CREATED, BOARD_DELETION_CANCELLED, BOARD_DELETION_SCHEDULED, BOARD_PASSWORD_CHANGED } from './events.js';
import { createGrants } from './grants.js';
import { boardBody, deletedAtNow, isExpired, purgeAtOf, purgeBoard } from './retire.js';

/** The most boards Next Up will hold. How a public, account-free app stays bounded. */
export const MAX_BOARDS = 500;

/**
 * /api/boards
 *
 *   POST /                      create { code, password?, actor? }
 *   POST /:code/lock            forget this browser's access (clears the grant cookie; no lookup)
 *   ── everything below resolves the board first (unknown codes count against the lookup limit) ──
 *   POST /:code/unlock          { password }
 *   ── everything below needs access: a password board without it answers ONLY { status: 'locked', code } ──
 *   GET  /:code                 the board (with `deletion` { scheduledAt, purgeAt, leftMs } while it's being deleted)
 *   POST /:code/password        change it { current, password, actor? } (password boards only; the current password
 *                               counts against the same wrong-password limit as unlocking). This browser gets a fresh
 *                               grant; every other browser's ends, live streams included
 *   POST /:code/deletion        delete it { confirm: the code, actor? }: schedules it, purged 24 h later (retire.js)
 *   DELETE /:code/deletion      restore it { actor? } while it's being deleted
 *   ── while a board is being deleted, every other write answers 409 board_deleting (reading still works) ──
 *   …    /:code/cards/…         its cards (cards/routes.js)
 *   …    /:code/history/…       its change log, and Restore (history/routes.js)
 *   GET  /:code/live            its live stream of new changes, Server-Sent Events (live/routes.js, live/hub.js)
 *   ...                       every later board route goes here, after requireAccess, and is protected by
 *                               construction (server/test/boards.test.js checks an unknown sub-route stays locked)
 *
 * Responses never contain a password, a hash, or (for a locked board) anything but its code and that it's locked.
 */
export function createBoardsRouter({ db, limits, networkOf, live, now = Date.now, maxBoards = MAX_BOARDS }) {
  const router = express.Router();
  const grants = createGrants(db);
  const q = queries(db);
  const openBody = (row) => ({ status: 'open', board: boardBody(row, now()) });

  // A board past its 24 hours of deleting is gone, even before the sweep gets to it: purge it now and say so to its
  // live streams. Returns the row, or null for a free code.
  const current = (code) => {
    const row = q.byCode(code);
    if (!row || !isExpired(row, now())) return row;
    if (purgeBoard(db(), row.id, now())) live.notify(row.id);
    return q.byCode(code);
  };

  // ---------- create ----------
  router.post('/', async (req, res) => {
    const body = req.body ?? {};
    const code = checkCode(body.code);
    if (!code.ok) return res.status(400).json({ error: code.error, field: 'code' });
    const password = body.password === undefined || body.password === null || body.password === '' ? null : body.password;
    if (password !== null) {
      const pw = checkNewPassword(password);
      if (!pw.ok) return res.status(400).json({ error: pw.error, field: 'password' });
    }
    // Every creation attempt counts as a lookup: otherwise "that code already exists" would be an unlimited oracle.
    const slot = limits.lookups.take(networkOf(req));
    if (!slot) return tooManyLookups(res, limits.lookups.check(networkOf(req)).retryAfterMs);
    if (current(code.code)) return exists(res);
    if (q.count() >= maxBoards) return full(res);

    const hash = password === null ? null : await hashPassword(password);
    // Re-checked inside one write transaction: concurrent creations can't both take a code or overshoot the cap.
    const outcome = db().transaction(() => {
      if (q.byCode(code.code)) return 'exists';
      if (q.count() >= maxBoards) return 'full';
      const id = q.insert(code.code, hash);
      appendEvent(db(), { boardId: id, type: BOARD_CREATED, actor: body.actor, payload: { hasPassword: hash !== null } });
      return q.byId(id);
    }).immediate();
    if (outcome === 'exists') return exists(res);
    if (outcome === 'full') return full(res);
    grants.set(req, res, outcome);
    res.status(201).json(openBody(outcome));
  });

  // ---------- re-lock (before resolve: forgetting needs no lookup and reveals nothing) ----------
  router.post('/:code/lock', (req, res) => {
    const code = checkCode(req.params.code);
    if (!code.ok) return res.status(400).json({ error: code.error, field: 'code' });
    grants.clear(req, res, code.code);
    res.status(204).end();
  });

  // ---------- one board ----------
  const board = express.Router({ mergeParams: true });
  router.use('/:code', resolveBoard, board);
  // Every write tells the board's live streams (live/routes.js); a refused one writes nothing and sends nothing.
  board.use(liveWrites({ hub: live }));

  // Synchronous from check to count, so concurrent misses can't slip past the limit.
  function resolveBoard(req, res, next) {
    const code = checkCode(req.params.code);
    if (!code.ok) return res.status(400).json({ error: code.error, field: 'code' });
    const network = networkOf(req);
    const row = current(code.code);
    const grant = grants.read(req, row);
    const room = limits.lookups.check(network);
    // While a network is limited, only boards this browser has opened before answer: any other answer (even
    // "locked") would tell a code-guesser the code exists.
    if (!room.ok && grant === 'none') return tooManyLookups(res, room.retryAfterMs);
    if (!row) {
      limits.lookups.take(network);
      return res.status(404).json({ status: 'free', code: code.code, full: q.count() >= maxBoards });
    }
    req.board = row;
    req.grant = grant;
    next();
  }

  board.post('/unlock', async (req, res) => {
    const row = req.board;
    if (!row.password_hash) {
      grants.set(req, res, row);
      return res.json(openBody(row));
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Type the board password.', field: 'password' });
    }
    // Claim the attempt before hashing; give it back only if the password is right. Success never resets the
    // count: knowing one board's password (your own) mustn't buy guesses at another's.
    const network = networkOf(req);
    const slot = limits.passwords.take(network);
    if (!slot) return tooManyPasswords(res, limits.passwords.check(network).retryAfterMs);
    let right;
    try {
      right = await verifyPassword(row.password_hash, password);
    } catch (err) {
      limits.passwords.refund(slot);
      throw err;
    }
    if (!right) return res.status(401).json({ error: "That password didn't work.", code: 'wrong_password' });
    limits.passwords.refund(slot);
    grants.set(req, res, row);
    res.json(openBody(row));
  });

  board.use(function requireAccess(req, res, next) {
    const row = req.board;
    if (!row.password_hash) {
      if (req.grant !== 'valid') grants.set(req, res, row);
      return next();
    }
    if (req.grant === 'valid') return next();
    res.status(403).json({ status: 'locked', code: row.code, ...(req.grant === 'stale' ? { reason: 'password_changed' } : {}) });
  });

  board.get('/', (req, res) => res.json(openBody(req.board)));

  // ---------- retiring: restore (the one write allowed while a board is being deleted) ----------
  board.delete('/deletion', (req, res) => {
    const outcome = db().transaction(() => {
      const row = q.byId(req.board.id);
      if (!row?.deleted_at) return 'not_deleting';
      q.setDeletedAt(row.id, null);
      appendEvent(db(), { boardId: row.id, type: BOARD_DELETION_CANCELLED, actor: req.body?.actor });
      return q.byId(row.id);
    }).immediate();
    if (outcome === 'not_deleting') {
      return res.status(409).json({ error: 'This board isn’t being deleted.', code: 'not_deleting', board: openBody(req.board).board });
    }
    res.json(openBody(outcome));
  });

  // While a board is being deleted, nothing on it changes until someone restores it; reading (the board, its cards,
  // History, the live stream) goes on. The database refuses the change too (schema.js 006).
  board.use(function pausedWhileDeleting(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || !req.board.deleted_at) return next();
    res.status(409).json({ error: 'This board is being deleted. Restore it to make changes.', code: 'board_deleting', board: openBody(req.board).board });
  });

  // ---------- change the password ----------
  board.post('/password', async (req, res) => {
    const row = req.board;
    const body = req.body ?? {};
    if (!row.password_hash) {
      return res.status(409).json({ error: 'This board has no password, and an open board can never get one.', code: 'no_password' });
    }
    if (typeof body.current !== 'string' || !body.current) {
      return res.status(400).json({ error: 'Type the current password.', field: 'current' });
    }
    const pw = checkNewPassword(body.password);
    if (!pw.ok) return res.status(400).json({ error: pw.error, field: 'password' });
    if (body.password === body.current) {
      return res.status(400).json({ error: 'That’s the password it has now. Choose a new one.', field: 'password' });
    }
    // The same claim-then-refund as unlocking, on the same counter: a wrong guess here counts against the lock screen.
    const network = networkOf(req);
    const slot = limits.passwords.take(network);
    if (!slot) return tooManyPasswords(res, limits.passwords.check(network).retryAfterMs);
    let right;
    try {
      right = await verifyPassword(row.password_hash, body.current);
    } catch (err) {
      limits.passwords.refund(slot);
      throw err;
    }
    if (!right) {
      return res.status(401).json({ error: "That password didn't work.", code: 'wrong_password', field: 'current' });
    }
    limits.passwords.refund(slot);
    const hash = await hashPassword(body.password);
    // Re-read inside the write: a change or a deletion that landed while this was hashing wins.
    const outcome = db().transaction(() => {
      const fresh = q.byId(row.id);
      if (!fresh || fresh.password_version !== row.password_version) return 'changed';
      if (fresh.deleted_at) return 'deleting';
      q.setPassword(row.id, hash, row.password_version + 1);
      appendEvent(db(), { boardId: row.id, type: BOARD_PASSWORD_CHANGED, actor: body.actor });
      return q.byId(row.id);
    }).immediate();
    if (outcome === 'changed') return res.status(403).json({ status: 'locked', code: row.code, reason: 'password_changed' });
    if (outcome === 'deleting') return res.status(409).json({ error: 'This board is being deleted. Restore it to make changes.', code: 'board_deleting' });
    // This browser keeps access at the new version. Every other grant is now stale, and once this answer has gone,
    // liveWrites tells the hub, which ends every stream still on the old version with "password_changed".
    grants.set(req, res, outcome);
    res.json(openBody(outcome));
  });

  // ---------- delete (schedule; retire.js purges it 24 h later) ----------
  board.post('/deletion', (req, res) => {
    const body = req.body ?? {};
    if (normalizeCode(body.confirm) !== req.board.code) {
      return res.status(400).json({ error: 'Type the board’s code to confirm.', field: 'confirm' });
    }
    const outcome = db().transaction(() => {
      const row = q.byId(req.board.id);
      if (row.deleted_at) return row;
      const at = deletedAtNow(now());
      q.setDeletedAt(row.id, at);
      appendEvent(db(), {
        boardId: row.id,
        type: BOARD_DELETION_SCHEDULED,
        actor: body.actor,
        payload: { purgeAt: new Date(purgeAtOf({ deleted_at: at })).toISOString() },
      });
      return q.byId(row.id);
    }).immediate();
    res.json(openBody(outcome));
  });

  board.use('/cards', createCardsRouter({ db }));
  board.use('/history', createHistoryRouter({ db }));
  board.get('/live', liveStream({ hub: live, networkOf }));

  return router;
}

function retry(res, ms) {
  const seconds = Math.ceil(ms / 1000);
  res.set('Retry-After', String(seconds));
  return seconds;
}
function tooManyLookups(res, ms) {
  const retryAfter = retry(res, ms);
  return res.status(429).json({ error: 'Too many codes that don’t exist from your network. Try again soon.', code: 'too_many_lookups', retryAfter });
}
function tooManyPasswords(res, ms) {
  const retryAfter = retry(res, ms);
  return res.status(429).json({ error: 'Too many wrong passwords from your network. Try again soon.', code: 'too_many_passwords', retryAfter });
}
function exists(res) {
  return res.status(409).json({ error: 'Someone has just made a board with this code.', code: 'exists' });
}
function full(res) {
  return res.status(409).json({ error: 'Next Up has reached its limit on boards.', code: 'board_limit' });
}

function queries(db) {
  const cache = new Map();
  const st = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db().prepare(sql));
    return cache.get(sql);
  };
  const COLS = 'id, code, password_hash, password_version, created_at, deleted_at';
  return {
    byCode: (code) => st(`SELECT ${COLS} FROM boards WHERE code = ? LIMIT 1`).get(code) ?? null,
    byId: (id) => st(`SELECT ${COLS} FROM boards WHERE id = ? LIMIT 1`).get(id) ?? null,
    count: () => st('SELECT COUNT(*) FROM boards').pluck().get(),
    setPassword: (id, hash, version) =>
      st('UPDATE boards SET password_hash = ?, password_version = ? WHERE id = ?').run(hash, version, id),
    setDeletedAt: (id, at) => st('UPDATE boards SET deleted_at = ? WHERE id = ?').run(at, id),
    insert: (code, hash) =>
      Number(st('INSERT INTO boards (code, password_hash, password_version) VALUES (?, ?, ?)').run(code, hash, hash === null ? 0 : 1).lastInsertRowid),
  };
}
