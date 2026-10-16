import { MAX_CARDS } from '../core/cardRules.js';
import { keyAfter, keyBetween, spreadKeys, tooLong } from '../core/positions.js';

/**
 * Cards in the database: the queries and the placement rules the card routes (cards/routes.js) and History's
 * restores (cards/events.js) share, so a card restored to a lane is placed exactly the way a dragged one is.
 *
 * Every placement writes only the card it places, unless the lane's keys hit their length cap: then that one lane
 * is rebalanced first (`rebalanced: true`: other cards' keys changed). Call the writers inside a write transaction.
 */
export function cardStore(db) {
  const q = queries(db);

  // The bottom of a lane: a key after its last live card, and the index the card will have.
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
  // share a key (nothing fits between equal keys).
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

  /**
   * Where a card would go back to a place it once had ({ lane, position, index }), as close as the lane now allows.
   * Reads only. If its old key still falls at its old index among the lane's other cards, it goes back on that key
   * exactly; otherwise at its old index, or the bottom if the lane is shorter now.
   *   → { lane, index, of (the lane's size with the card in it), exact (back at its old index), key (reusable or null) }
   */
  function placeNear(boardId, cardId, place) {
    const others = q.laneRows(boardId, place.lane).filter((r) => r.id !== cardId);
    const byKey = others.filter((r) => r.position < place.position).length;
    const keyFree = !others.some((r) => r.position === place.position);
    const index = byKey === place.index ? byKey : Math.min(place.index, others.length);
    return {
      lane: place.lane,
      index,
      of: others.length + 1,
      exact: index === place.index,
      key: byKey === index && keyFree ? place.position : null,
      others,
    };
  }

  /** Writes a placeNear() answer's key: the old key when it still fits, else a new one in that gap. */
  function claim(boardId, near) {
    if (near.key) return { position: near.key, rebalanced: false };
    return placeBetween(boardId, near.lane, near.others, near.index);
  }

  return { q, bottomOf, placeBetween, rebalance, placeNear, claim };
}

/** What the API says about a card. */
export function cardBody(row) {
  return {
    id: row.id,
    title: row.title,
    logo: row.logo,
    lane: row.lane,
    position: row.position,
    goLive: row.go_live,
    serverInfo: row.server_info,
    playerCount: row.player_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A card.edited's before or after: the name and logo, and the card's place.
export function stateOf(row, index) {
  return { title: row.title, logo: row.logo, lane: row.lane, position: row.position, index };
}

// A card.created's, card.deleted's or card.restored's card: everything a person can set on it, and its place.
export function wholeStateOf(row, index) {
  return { ...stateOf(row, index), goLive: row.go_live, serverInfo: row.server_info };
}

// A card.detail_edited's before or after.
export const detailOf = (row) => ({ goLive: row.go_live, serverInfo: row.server_info });

// What q.update writes, as the card has it now.
export const editableOf = (row) => ({
  title: row.title,
  logo: row.logo,
  lane: row.lane,
  position: row.position,
  goLive: row.go_live,
  serverInfo: row.server_info,
});

export const placeOf = ({ lane, position, index }) => ({ lane, position, index });

function queries(db) {
  const cache = new Map();
  const st = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db().prepare(sql));
    return cache.get(sql);
  };
  // player_count: the card's live sign-ups (players_live_name's index; at most MAX_PLAYERS).
  const COLS = `id, board_id, lane, position, title, logo, go_live, server_info, version, created_at, updated_at, deleted_at,
    (SELECT COUNT(*) FROM players p WHERE p.card_id = cards.id AND p.deleted_at IS NULL) AS player_count`;
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
    // Titles for History's lines, a page of ids at a time (never more than the page holds).
    titles: (boardId, ids) =>
      ids.length === 0
        ? []
        : st(`SELECT id, title FROM cards WHERE board_id = ? AND id IN (${ids.map(() => '?').join(', ')}) LIMIT ${ids.length}`).all(
            boardId,
            ...ids,
          ),
    insert: (boardId, c) =>
      Number(
        st('INSERT INTO cards (board_id, lane, position, title, logo, go_live, server_info) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          boardId,
          c.lane,
          c.position,
          c.title,
          c.logo,
          c.goLive,
          c.serverInfo,
        ).lastInsertRowid,
      ),
    update: (boardId, id, c) =>
      st(
        `UPDATE cards SET title = ?, logo = ?, lane = ?, position = ?, go_live = ?, server_info = ?, version = version + 1,
         updated_at = ${NOW} WHERE board_id = ? AND id = ?`,
      ).run(c.title, c.logo, c.lane, c.position, c.goLive, c.serverInfo, boardId, id),
    tombstone: (boardId, id) =>
      st(`UPDATE cards SET deleted_at = ${NOW}, version = version + 1, updated_at = ${NOW} WHERE board_id = ? AND id = ?`).run(boardId, id),
    // History's restore of a deleted card: back on the board, at a place in a lane.
    untombstone: (boardId, id, lane, position) =>
      st(
        `UPDATE cards SET deleted_at = NULL, lane = ?, position = ?, version = version + 1, updated_at = ${NOW}
         WHERE board_id = ? AND id = ? AND deleted_at IS NOT NULL`,
      ).run(lane, position, boardId, id),
    setPosition: (boardId, id, position) => st('UPDATE cards SET position = ? WHERE board_id = ? AND id = ?').run(position, boardId, id),
  };
}
