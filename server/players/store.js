/**
 * Players in the database: the queries the sign-up routes (players/routes.js) and History's restores (players/events.js)
 * share. Call the writers inside a write transaction.
 */

/** What the API says about a player. Never the board or card internals beyond the ids. */
export function playerBody(row) {
  return { id: row.id, name: row.name, addedAt: row.created_at };
}

export function playerQueries(db) {
  const cache = new Map();
  const st = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db().prepare(sql));
    return cache.get(sql);
  };
  const COLS = 'id, card_id, name, name_key, created_at, deleted_at';
  const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  return {
    card: (boardId, id) => st('SELECT id, deleted_at FROM cards WHERE board_id = ? AND id = ? LIMIT 1').get(boardId, id) ?? null,
    byId: (cardId, id) => st(`SELECT ${COLS} FROM players WHERE card_id = ? AND id = ? LIMIT 1`).get(cardId, id) ?? null,
    liveByKey: (cardId, key) =>
      st(`SELECT ${COLS} FROM players WHERE card_id = ? AND name_key = ? AND deleted_at IS NULL LIMIT 1`).get(cardId, key) ?? null,
    liveCount: (cardId) => st('SELECT COUNT(*) FROM players WHERE card_id = ? AND deleted_at IS NULL').pluck().get(cardId),
    page: (cardId, after, limit) =>
      after
        ? st(
            `SELECT ${COLS} FROM players WHERE card_id = ? AND deleted_at IS NULL AND (created_at, id) > (?, ?)
             ORDER BY created_at, id LIMIT ?`,
          ).all(cardId, after.at, after.id, limit)
        : st(`SELECT ${COLS} FROM players WHERE card_id = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT ?`).all(cardId, limit),
    // Where a player sits in the card's live sign-up list (0 = first).
    indexOf: (p) =>
      st(
        `SELECT COUNT(*) FROM players WHERE card_id = ? AND deleted_at IS NULL
         AND (created_at < ? OR (created_at = ? AND id < ?))`,
      )
        .pluck()
        .get(p.card_id, p.created_at, p.created_at, p.id),
    insert: (boardId, cardId, name, key) =>
      Number(st('INSERT INTO players (board_id, card_id, name, name_key) VALUES (?, ?, ?, ?)').run(boardId, cardId, name, key).lastInsertRowid),
    // History's restore of a removed player: back where they were (sign-up order is (created_at, id), which never changes).
    untombstone: (cardId, id) => st('UPDATE players SET deleted_at = NULL WHERE card_id = ? AND id = ? AND deleted_at IS NOT NULL').run(cardId, id),
    tombstone: (cardId, id) => st(`UPDATE players SET deleted_at = ${NOW} WHERE card_id = ? AND id = ?`).run(cardId, id),
  };
}
