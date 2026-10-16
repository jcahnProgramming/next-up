import express from 'express';
import { createCardsRouter } from '../cards/routes.js';
import { createHistoryRouter } from '../history/routes.js';
import { liveStream, liveWrites } from '../live/routes.js';
import { checkCode, checkNewPassword } from '../core/codes.js';
import { appendEvent } from '../core/events.js';
import { hashPassword, verifyPassword } from '../core/passwords.js';
import { BOARD_CREATED } from './events.js';
import { createGrants } from './grants.js';

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
 *   GET  /:code                 the board
 *   …    /:code/cards/…         its cards (cards/routes.js)
 *   …    /:code/history/…       its change log, and Restore (history/routes.js)
 *   GET  /:code/live            its live stream of new changes, Server-Sent Events (live/routes.js, live/hub.js)
 *   ...                       every later board route goes here, after requireAccess, and is protected by
 *                               construction (server/test/boards.test.js checks an unknown sub-route stays locked)
 *
 * Responses never contain a password, a hash, or (for a locked board) anything but its code and that it's locked.
 */
export function createBoardsRouter({ db, limits, networkOf, live, maxBoards = MAX_BOARDS }) {
  const router = express.Router();
  const grants = createGrants(db);
  const q = queries(db);

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
    if (q.byCode(code.code)) return exists(res);
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
    const row = q.byCode(code.code);
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
  board.use('/cards', createCardsRouter({ db }));
  board.use('/history', createHistoryRouter({ db }));
  board.get('/live', liveStream({ hub: live, networkOf }));

  return router;
}

// What an open (or unlocked) board's API says about it. Its cards come from their own route (cards/routes.js).
function openBody(row) {
  return { status: 'open', board: { code: row.code, hasPassword: row.password_hash !== null, createdAt: row.created_at } };
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
    insert: (code, hash) =>
      Number(st('INSERT INTO boards (code, password_hash, password_version) VALUES (?, ?, ?)').run(code, hash, hash === null ? 0 : 1).lastInsertRowid),
  };
}
