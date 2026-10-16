import { z } from 'zod';
import { MAX_PLAYERS, PLAYER_NAME_MAX, playerExistsMessage, playerLimitMessage } from '../core/cardDetail.js';
import { appendEvent, declareEventType } from '../core/events.js';
import { ordinal, withLiveCard } from '../cards/events.js';
import { playerQueries } from './store.js';

/**
 * Sign-ups. Each payload carries enough to undo it without reading anything else:
 *
 *   player.added     { cardId, playerId, name, position }   not restorable: undoing it is removing the player
 *   player.removed   { cardId, playerId, name, position }   restore: put playerId back, at `position`
 *   player.restored  { cardId, playerId, name, position }   restore: remove them again (History put them back)
 *
 * `position` is the player's place in the card's sign-up list at that moment (0 = first). A removed player is only
 * tombstoned and the list is ordered by when each player signed up, so clearing the tombstone puts them back exactly
 * where they were; `position` and `name` let History say where and who. Adding isn't restorable: undoing it is
 * removing the player, which the card already offers.
 *
 * Restoring a removed player is refused, plainly, when someone of that name (ignoring case) has signed up since, or
 * the card already has MAX_PLAYERS. If the card has been deleted since, History asks to bring it back too.
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
  line: (p, { cardTitle }) => ({ verb: 'added player', subject: p.name, detail: ` to ${cardTitle(p.cardId)}` }),
});

export const PLAYER_REMOVED = declareEventType({
  type: 'player.removed',
  restorable: true,
  payload: z.object(fields),
  line: (p, { cardTitle, isRestore }) => ({
    verb: 'removed player',
    subject: p.name,
    detail: ` from ${cardTitle(p.cardId)}${isRestore ? ' again, undoing a restore' : ''}`,
    tone: 'del',
  }),
  restore: { plan: planPutBack },
});

export const PLAYER_RESTORED = declareEventType({
  type: 'player.restored',
  restorable: true,
  payload: z.object(fields),
  line: (p, { cardTitle }) => ({ verb: 'restored player', subject: p.name, detail: ` to ${cardTitle(p.cardId)}` }),
  restore: { plan: planRemoveAgain },
});

const queriesOf = new WeakMap();
const playersOf = (db) => {
  if (!queriesOf.has(db)) queriesOf.set(db, playerQueries(() => db));
  return queriesOf.get(db);
};

const refuse = (code, error) => ({ refuse: { code, error } });

// player.removed: the same player back on the card, in their old place in the sign-up order.
function planPutBack(ctx, event, opts) {
  const p = event.payload;
  const base = withLiveCard(ctx, p.cardId, opts);
  if (base.refuse) return base;
  const q = playersOf(ctx.db);
  const player = q.byId(p.cardId, p.playerId);
  if (!player) return refuse('player_gone', 'That player no longer exists.');
  if (!player.deleted_at) return refuse('nothing_to_restore', `${player.name} is already signed up.`);
  // Someone of that name (any case) has signed up since: putting this one back would make two.
  const taken = q.liveByKey(p.cardId, player.name_key);
  if (taken) return refuse('player_exists', playerExistsMessage(taken.name));
  const count = q.liveCount(p.cardId);
  if (count >= MAX_PLAYERS) return refuse('player_limit', playerLimitMessage);
  const at = q.indexOf(player);
  const title = base.card.title;
  return {
    preview: {
      title: `Put ${player.name} back on ${title}?`,
      text: `Signs ${player.name} up again, in the place they had.`,
      rows: [
        ...base.rows,
        {
          label: 'Players',
          now: { kind: 'text', value: count === 1 ? '1 signed up' : `${count} signed up` },
          after: { kind: 'text', value: `${count + 1}, with ${player.name} ${ordinal(at + 1)}` },
        },
      ],
      notes: base.notes,
      action: 'Restore',
    },
    apply(actor) {
      const pre = base.pre?.apply(actor);
      q.untombstone(p.cardId, player.id);
      const position = q.indexOf(q.byId(p.cardId, player.id));
      appendEvent(ctx.db, {
        boardId: ctx.boardId,
        type: PLAYER_RESTORED,
        actor,
        payload: { cardId: p.cardId, playerId: player.id, name: player.name, position },
        restores: event.id,
      });
      return { rebalanced: pre?.rebalanced ?? false };
    },
  };
}

// player.restored: take them off the card again.
function planRemoveAgain(ctx, event, opts) {
  const p = event.payload;
  const base = withLiveCard(ctx, p.cardId, opts);
  if (base.refuse) return base;
  const q = playersOf(ctx.db);
  const player = q.byId(p.cardId, p.playerId);
  if (!player) return refuse('player_gone', 'That player no longer exists.');
  if (player.deleted_at) return refuse('nothing_to_restore', `${player.name} has already been removed.`);
  const count = q.liveCount(p.cardId);
  return {
    preview: {
      title: `Remove ${player.name} from ${base.card.title} again?`,
      text: `Takes ${player.name} off the sign-up list, as it was before this restore.`,
      rows: [
        ...base.rows,
        {
          label: 'Players',
          now: { kind: 'text', value: count === 1 ? '1 signed up' : `${count} signed up` },
          after: { kind: 'text', value: `${count - 1}, without ${player.name}` },
        },
      ],
      notes: base.notes,
      action: 'Remove again',
    },
    apply(actor) {
      const pre = base.pre?.apply(actor);
      const position = q.indexOf(player);
      q.tombstone(p.cardId, player.id);
      appendEvent(ctx.db, {
        boardId: ctx.boardId,
        type: PLAYER_REMOVED,
        actor,
        payload: { cardId: p.cardId, playerId: player.id, name: player.name, position },
        restores: event.id,
      });
      return { rebalanced: pre?.rebalanced ?? false };
    },
  };
}
