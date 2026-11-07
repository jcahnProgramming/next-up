import express from 'express';
import { MAX_PLAYERS, checkPlayerName, playerExistsMessage, playerKey, playerLimitMessage } from '../core/cardDetail.js';
import { appendEvent } from '../core/events.js';
import { PLAYER_ADDED, PLAYER_REMOVED } from './events.js';
import { playerBody, playerQueries } from './store.js';

/**
 * /api/boards/:code/cards/:id/players: who's signed up to a card. Mounted by cards/routes.js, which boards/routes.js
 * mounts AFTER requireAccess, so a password board without access never reaches here.
 *
 *   GET    /             the card's players in sign-up order: { players, next, limit }   ?limit=&after=
 *   POST   /             sign up { name, actor? } → 201 { player, playerCount }
 *   DELETE /:playerId    remove { actor? } → { player, playerCount } (the player as they were)
 *
 * Anyone with access can add any name and remove anyone: a name is a label, not an identity (CLAUDE.md). A name
 * already on the card, ignoring case, is refused (409 player_exists, with the name as it's written there), and so is
 * a card's 101st player (409 player_limit). Removing only tombstones the player, so History can put them back.
 * Sign-ups don't touch the card's version: an edit sheet open while someone signs up still saves.
 */
export function createPlayersRouter({ db }) {
  const router = express.Router({ mergeParams: true });
  const q = playerQueries(db);

  // Every route here needs the card live on this board.
  router.use((req, res, next) => {
    const id = Number(req.params.id);
    const card = Number.isSafeInteger(id) && id > 0 && String(id) === req.params.id ? q.card(req.board.id, id) : null;
    if (!card || card.deleted_at) return res.status(404).json({ error: 'That card has been deleted.', code: 'card_gone' });
    req.cardId = card.id;
    next();
  });

  router.get('/', (req, res) => {
    const limit = Math.min(Math.max(1, Number.parseInt(req.query.limit, 10) || MAX_PLAYERS), MAX_PLAYERS);
    const after = parseCursor(req.query.after);
    if (after === false) return res.status(400).json({ error: 'That page cursor isn’t valid.', field: 'after' });
    const rows = q.page(req.cardId, after, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    res.json({
      players: page.map(playerBody),
      next: rows.length > limit ? `${last.created_at}~${last.id}` : null,
      limit: MAX_PLAYERS,
    });
  });

  router.post('/', (req, res) => {
    const body = req.body ?? {};
    const name = checkPlayerName(body.name);
    if (!name.ok) return res.status(400).json({ error: name.error, field: 'name' });
    const boardId = req.board.id;
    const cardId = req.cardId;
    const key = playerKey(name.name);

    const outcome = db().transaction(() => {
      const taken = q.liveByKey(cardId, key);
      if (taken) return { exists: taken };
      const count = q.liveCount(cardId);
      if (count >= MAX_PLAYERS) return { full: true };
      const id = q.insert(boardId, cardId, name.name, key);
      appendEvent(db(), {
        boardId,
        type: PLAYER_ADDED,
        actor: body.actor,
        payload: { cardId, playerId: id, name: name.name, position: count },
      });
      return { player: q.byId(cardId, id), playerCount: count + 1 };
    }).immediate();
    if (outcome.exists) {
      return res.status(409).json({ error: playerExistsMessage(outcome.exists.name), code: 'player_exists', player: playerBody(outcome.exists) });
    }
    if (outcome.full) return res.status(409).json({ error: playerLimitMessage, code: 'player_limit' });
    res.status(201).json({ player: playerBody(outcome.player), playerCount: outcome.playerCount });
  });

  router.delete('/:playerId', (req, res) => {
    const body = req.body ?? {};
    const playerId = Number(req.params.playerId);
    if (!Number.isSafeInteger(playerId) || playerId < 1 || String(playerId) !== req.params.playerId) return playerGone(res);
    const boardId = req.board.id;
    const cardId = req.cardId;

    const outcome = db().transaction(() => {
      const player = q.byId(cardId, playerId);
      if (!player || player.deleted_at) return { gone: true };
      const position = q.indexOf(player);
      q.tombstone(cardId, playerId);
      appendEvent(db(), {
        boardId,
        type: PLAYER_REMOVED,
        actor: body.actor,
        payload: { cardId, playerId, name: player.name, position },
      });
      return { player, playerCount: q.liveCount(cardId) };
    }).immediate();
    if (outcome.gone) return playerGone(res);
    res.json({ player: playerBody(outcome.player), playerCount: outcome.playerCount });
  });

  return router;
}

function playerGone(res) {
  return res.status(404).json({ error: 'That player has already been removed.', code: 'player_gone' });
}

function parseCursor(raw) {
  if (raw === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~(\d{1,15})$/.exec(String(raw));
  return m ? { at: m[1], id: Number(m[2]) } : false;
}
