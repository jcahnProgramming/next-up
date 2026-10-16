import express from 'express';
import { MAX_CARDS, checkLane, checkLogo, checkTitle } from '../core/cardRules.js';
import { appendEvent } from '../core/events.js';
import { keyAfter, keyBetween, spreadKeys, tooLong } from '../core/positions.js';
import { CARD_CREATED, CARD_DELETED, CARD_EDITED, CARD_MOVED } from './events.js';

/**
 * /api/boards/:code/cards. Mounted by boards/routes.js AFTER requireAccess, so a password board without access never
 * reaches here: every method and path answers only { status: 'locked', code }.
 *
 *   GET    /             a page of the board's live cards, in lane order: { cards, next, limit }   ?limit=&after=
 *   POST   /             add { title, logo?, lane, actor? } to the bottom of the lane → 201 { card }
 *   PATCH  /:id          edit { version, title?, logo?, lane?, actor? } → { card }; a new lane puts it at the bottom
 *   POST   /:id/move     place it { lane, index, afterId?, actor? } → { card, moved }
 *   DELETE /:id          tombstone { version, actor? } → { card } (the card as it was)
 *
 * Every change writes its event (cards/events.js) in the same transaction. Edits and deletes name the version they
 * started from; if someone else changed the card since, the answer is 409 { code: 'conflict', card } with the latest.
 * A move names no version: if two people move the same card at once, the later one wins and both are logged.
 *
 * A placement writes only the card it places, unless the lane's keys hit their length cap: then that one lane is
 * rebalanced first and the answer carries `rebalanced: true` (other cards' keys changed; reload the board).
 */
export function createCardsRouter({ db }) {
  const router = express.Router({ mergeParams: true });
  const q = queries(db);

  router.get('/', (req, res) => {
    const limit = Math.min(Math.max(1, Number.parseInt(req.query.limit, 10) || MAX_CARDS), MAX_CARDS);
    const after = parseCursor(req.query.after);
    if (after === false) return res.status(400).json({ error: 'That page cursor isn’t valid.', field: 'after' });
    const rows = q.page(req.board.id, after, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    res.json({
      cards: page.map(cardBody),
      next: rows.length > limit ? `${last.lane}~${last.position}~${last.id}` : null,
      limit: MAX_CARDS,
    });
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    const title = checkTitle(body.title);
    if (!title.ok) return invalid(res, 'title', title.error);
    const logo = checkLogo(body.logo);
    if (!logo.ok) return invalid(res, 'logo', logo.error);
    const lane = checkLane(body.lane);
    if (!lane.ok) return invalid(res, 'lane', lane.error);
    const boardId = req.board.id;

    const outcome = db().transaction(() => {
      if (q.liveCount(boardId) >= MAX_CARDS) return 'full';
      const place = bottomOf(boardId, lane.lane);
      const id = q.insert(boardId, lane.lane, place.position, title.title, logo.logo);
      const card = q.byId(boardId, id);
      appendEvent(db(), { boardId, type: CARD_CREATED, actor: body.actor, payload: { cardId: id, card: stateOf(card, place.index) } });
      return { card, rebalanced: place.rebalanced };
    }).immediate();
    if (outcome === 'full') return cardLimit(res);
    res.status(201).json(withRebalanced({ card: cardBody(outcome.card) }, outcome.rebalanced));
  });

  router.patch('/:id', (req, res) => {
    const body = req.body ?? {};
    const id = cardIdOf(req, res);
    if (id === null) return undefined;
    const version = versionOf(body, res);
    if (version === null) return undefined;
    const changes = {};
    if (body.title !== undefined) {
      const title = checkTitle(body.title);
      if (!title.ok) return invalid(res, 'title', title.error);
      changes.title = title.title;
    }
    if (body.logo !== undefined) {
      const logo = checkLogo(body.logo);
      if (!logo.ok) return invalid(res, 'logo', logo.error);
      changes.logo = logo.logo;
    }
    if (body.lane !== undefined) {
      const lane = checkLane(body.lane);
      if (!lane.ok) return invalid(res, 'lane', lane.error);
      changes.lane = lane.lane;
    }
    const boardId = req.board.id;

    const outcome = db().transaction(() => {
      const card = q.byId(boardId, id);
      if (!card || card.deleted_at) return { gone: true };
      if (card.version !== version) return { conflict: card };
      const next = { title: card.title, logo: card.logo, lane: card.lane, position: card.position, ...changes };
      const edited = next.title !== card.title || next.logo !== card.logo;
      const moved = next.lane !== card.lane;
      if (!edited && !moved) return { card };
      const before = stateOf(card, q.indexOf(card));
      let place = null;
      if (moved) {
        place = bottomOf(boardId, next.lane);
        next.position = place.position;
      }
      q.update(boardId, id, next);
      const saved = q.byId(boardId, id);
      // The name or logo is an edit and the lane a move, each logged as itself (cards/events.js).
      if (edited) {
        const after = { ...before, title: saved.title, logo: saved.logo };
        appendEvent(db(), { boardId, type: CARD_EDITED, actor: body.actor, payload: { cardId: id, before, after } });
      }
      if (moved) {
        appendEvent(db(), {
          boardId,
          type: CARD_MOVED,
          actor: body.actor,
          payload: { cardId: id, before: placeOf(before), after: placeOf(stateOf(saved, place.index)) },
        });
      }
      return { card: saved, rebalanced: place?.rebalanced ?? false };
    }).immediate();
    if (outcome.gone) return gone(res);
    if (outcome.conflict) return conflict(res, outcome.conflict);
    res.json(withRebalanced({ card: cardBody(outcome.card) }, outcome.rebalanced));
  });

  // Drag and drop, and keyboard moves. `index` is where the card goes among the lane's OTHER live cards (0 = top);
  // `afterId`, when it names a live card in that lane, wins over it (the card the mover saw just above the gap: it
  // keeps their intent if the lane changed under them). Null afterId means the top. Dropping a card back in its own
  // place changes and logs nothing ({ moved: false }).
  router.post('/:id/move', (req, res) => {
    const body = req.body ?? {};
    const id = cardIdOf(req, res);
    if (id === null) return undefined;
    const lane = checkLane(body.lane);
    if (!lane.ok) return invalid(res, 'lane', lane.error);
    if (!Number.isSafeInteger(body.index) || body.index < 0 || body.index > MAX_CARDS) {
      return invalid(res, 'index', 'Reload the board and try again.');
    }
    const afterId = body.afterId;
    if (afterId !== undefined && afterId !== null && !(Number.isSafeInteger(afterId) && afterId > 0)) {
      return invalid(res, 'afterId', 'Reload the board and try again.');
    }
    const boardId = req.board.id;

    const outcome = db().transaction(() => {
      const card = q.byId(boardId, id);
      if (!card || card.deleted_at) return { gone: true };
      const others = q.laneRows(boardId, lane.lane).filter((r) => r.id !== id);
      let index = Math.min(body.index, others.length);
      if (afterId === null) index = 0;
      else if (afterId !== undefined) {
        const at = others.findIndex((r) => r.id === afterId);
        if (at !== -1) index = at + 1;
      }
      const from = q.indexOf(card);
      if (card.lane === lane.lane && from === index) return { card, moved: false };

      const before = placeOf(stateOf(card, from));
      const place = placeBetween(boardId, lane.lane, others, index);
      q.update(boardId, id, { title: card.title, logo: card.logo, lane: lane.lane, position: place.position });
      const saved = q.byId(boardId, id);
      appendEvent(db(), {
        boardId,
        type: CARD_MOVED,
        actor: body.actor,
        payload: { cardId: id, before, after: placeOf(stateOf(saved, index)) },
      });
      return { card: saved, moved: true, rebalanced: place.rebalanced };
    }).immediate();
    if (outcome.gone) return gone(res);
    res.json(withRebalanced({ card: cardBody(outcome.card), moved: outcome.moved }, outcome.rebalanced));
  });

  router.delete('/:id', (req, res) => {
    const body = req.body ?? {};
    const id = cardIdOf(req, res);
    if (id === null) return undefined;
    const version = versionOf(body, res);
    if (version === null) return undefined;
    const boardId = req.board.id;

    const outcome = db().transaction(() => {
      const card = q.byId(boardId, id);
      if (!card || card.deleted_at) return { gone: true };
      if (card.version !== version) return { conflict: card };
      const state = stateOf(card, q.indexOf(card));
      q.tombstone(boardId, id);
      appendEvent(db(), { boardId, type: CARD_DELETED, actor: body.actor, payload: { cardId: id, card: state } });
      return { card };
    }).immediate();
    if (outcome.gone) return gone(res);
    if (outcome.conflict) return conflict(res, outcome.conflict);
    res.json({ card: cardBody(outcome.card) });
  });

  // The bottom of a lane: a key after its last live card, and the index the card will have. A key that would pass the
  // length cap rebalances the lane first (core/positions.js). Call inside the write transaction.
  function bottomOf(boardId, lane) {
    const last = q.lastPosition(boardId, lane);
    const index = q.laneCount(boardId, lane);
    let position = keyAfter(last);
    let rebalanced = false;
    if (tooLong(position)) {
      rebalance(boardId, q.laneIds(boardId, lane));
      position = keyAfter(q.lastPosition(boardId, lane));
      rebalanced = true;
    }
    return { position, index, rebalanced };
  }

  // A key for a card going in at `index` among `others` (the lane's other live cards, in order), written by the
  // caller onto that one card. Rebalances the others first if the gap's key would pass the cap, or if the neighbours
  // share a key (nothing fits between equal keys). Call inside the write transaction.
  function placeBetween(boardId, lane, others, index) {
    const keyAt = (rows, i) => rows[i]?.position ?? null;
    const prev = keyAt(others, index - 1);
    const next = keyAt(others, index);
    const position = prev !== null && next !== null && prev >= next ? null : keyBetween(prev, next);
    if (position !== null && !tooLong(position)) return { position, rebalanced: false };
    const keys = rebalance(boardId, others.map((r) => r.id));
    return { position: keyBetween(keys[index - 1] ?? null, keys[index] ?? null), rebalanced: true };
  }

  // Evenly spaced short keys for these cards, in this order (core/positions.js). Returns the keys.
  function rebalance(boardId, ids) {
    const keys = spreadKeys(ids.length);
    keys.forEach((key, i) => q.setPosition(boardId, ids[i], key));
    return keys;
  }

  return router;
}

/** What the API says about a card. */
function cardBody(row) {
  return {
    id: row.id,
    title: row.title,
    logo: row.logo,
    lane: row.lane,
    position: row.position,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stateOf(row, index) {
  return { title: row.title, logo: row.logo, lane: row.lane, position: row.position, index };
}

const placeOf = ({ lane, position, index }) => ({ lane, position, index });

const withRebalanced = (body, rebalanced) => (rebalanced ? { ...body, rebalanced: true } : body);

function cardIdOf(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== req.params.id) {
    res.status(404).json({ error: 'There’s no such card on this board.', code: 'card_gone' });
    return null;
  }
  return id;
}

function versionOf(body, res) {
  const v = body.version;
  if (!Number.isSafeInteger(v) || v < 1) {
    invalid(res, 'version', 'Reload the board and try again.');
    return null;
  }
  return v;
}

function parseCursor(raw) {
  if (raw === undefined) return null;
  const m = /^(up_next|now_playing|played)~([0-9A-Za-z]{1,64})~(\d{1,15})$/.exec(String(raw));
  return m ? { lane: m[1], position: m[2], id: Number(m[3]) } : false;
}

function invalid(res, field, error) {
  return res.status(400).json({ error, field });
}
function cardLimit(res) {
  return res.status(409).json({ error: `This board has ${MAX_CARDS} games, the most a board can hold. Delete one to add another.`, code: 'card_limit' });
}
function gone(res) {
  return res.status(404).json({ error: 'That card has been deleted.', code: 'card_gone' });
}
function conflict(res, row) {
  return res.status(409).json({ error: 'Someone else changed this card first.', code: 'conflict', card: cardBody(row) });
}

function queries(db) {
  const cache = new Map();
  const st = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db().prepare(sql));
    return cache.get(sql);
  };
  const COLS = 'id, board_id, lane, position, title, logo, version, created_at, updated_at, deleted_at';
  const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  return {
    byId: (boardId, id) => st(`SELECT ${COLS} FROM cards WHERE board_id = ? AND id = ? LIMIT 1`).get(boardId, id) ?? null,
    page: (boardId, after, limit) =>
      after
        ? st(
            `SELECT ${COLS} FROM cards WHERE board_id = ? AND deleted_at IS NULL AND (lane, position, id) > (?, ?, ?)
             ORDER BY lane, position, id LIMIT ?`,
          ).all(boardId, after.lane, after.position, after.id, limit)
        : st(`SELECT ${COLS} FROM cards WHERE board_id = ? AND deleted_at IS NULL ORDER BY lane, position, id LIMIT ?`).all(boardId, limit),
    liveCount: (boardId) => st('SELECT COUNT(*) FROM cards WHERE board_id = ? AND deleted_at IS NULL').pluck().get(boardId),
    laneCount: (boardId, lane) =>
      st('SELECT COUNT(*) FROM cards WHERE board_id = ? AND lane = ? AND deleted_at IS NULL').pluck().get(boardId, lane),
    lastPosition: (boardId, lane) =>
      st('SELECT position FROM cards WHERE board_id = ? AND lane = ? AND deleted_at IS NULL ORDER BY position DESC, id DESC LIMIT 1')
        .pluck()
        .get(boardId, lane) ?? null,
    // Bounded by MAX_CARDS: a lane never holds more live cards than the board does.
    laneIds: (boardId, lane) =>
      st(`SELECT id FROM cards WHERE board_id = ? AND lane = ? AND deleted_at IS NULL ORDER BY position, id LIMIT ${MAX_CARDS}`)
        .pluck()
        .all(boardId, lane),
    laneRows: (boardId, lane) =>
      st(`SELECT id, position FROM cards WHERE board_id = ? AND lane = ? AND deleted_at IS NULL ORDER BY position, id LIMIT ${MAX_CARDS}`).all(
        boardId,
        lane,
      ),
    indexOf: (card) =>
      st(
        `SELECT COUNT(*) FROM cards WHERE board_id = ? AND lane = ? AND deleted_at IS NULL
         AND (position < ? OR (position = ? AND id < ?))`,
      )
        .pluck()
        .get(card.board_id, card.lane, card.position, card.position, card.id),
    insert: (boardId, lane, position, title, logo) =>
      Number(
        st('INSERT INTO cards (board_id, lane, position, title, logo) VALUES (?, ?, ?, ?, ?)').run(boardId, lane, position, title, logo)
          .lastInsertRowid,
      ),
    update: (boardId, id, c) =>
      st(`UPDATE cards SET title = ?, logo = ?, lane = ?, position = ?, version = version + 1, updated_at = ${NOW} WHERE board_id = ? AND id = ?`).run(
        c.title,
        c.logo,
        c.lane,
        c.position,
        boardId,
        id,
      ),
    tombstone: (boardId, id) =>
      st(`UPDATE cards SET deleted_at = ${NOW}, version = version + 1, updated_at = ${NOW} WHERE board_id = ? AND id = ?`).run(boardId, id),
    setPosition: (boardId, id, position) => st('UPDATE cards SET position = ? WHERE board_id = ? AND id = ?').run(position, boardId, id),
  };
}
