import { z } from 'zod';
import { MAX_PLAYERS, PLAYER_NAME_MAX } from '../core/cardDetail.js';
import { declareEventType } from '../core/events.js';

/**
 * Sign-ups. Each payload carries enough to undo it without reading anything else:
 *
 *   player.added    { cardId, playerId, name, position }   undo: remove playerId (a player.removed of its own)
 *   player.removed  { cardId, playerId, name, position }   undo: put playerId back, at `position`
 *
 * `position` is the player's place in the card's sign-up list at that moment (0 = first). A removed player is only
 * tombstoned and the list is ordered by when each player signed up, so clearing the tombstone puts them back exactly
 * where they were; `position` and `name` let History say where and who, and put them back as close as it can even
 * without the row. Adding isn't restorable: undoing it is removing the player, which the card already offers.
 */
const fields = {
  cardId: z.number().int().positive(),
  playerId: z.number().int().positive(),
  name: z.string().min(1).max(PLAYER_NAME_MAX * 2), // UTF-16 units; the route counts code points
  position: z.number().int().min(0).max(MAX_PLAYERS),
};

export const PLAYER_ADDED = declareEventType({
  type: 'player.added',
  restorable: false,
  payload: z.object(fields),
});

export const PLAYER_REMOVED = declareEventType({
  type: 'player.removed',
  restorable: true,
  payload: z.object(fields),
});
