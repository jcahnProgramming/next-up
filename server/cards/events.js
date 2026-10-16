import { z } from 'zod';
import { DATE_MAX_YEAR, DATE_MIN_YEAR, SERVER_INFO_MAX, dateParts } from '../core/cardDetail.js';
import { LANE_IDS } from '../core/cardRules.js';
import { declareEventType } from '../core/events.js';

/**
 * Card changes. Each payload carries enough to undo the change without reading anything else:
 *
 *   card.created  { cardId, card }             undo: tombstone cardId
 *   card.edited   { cardId, before, after }    undo: put `before` back (lane and place included)
 *   card.deleted  { cardId, card }             undo: clear the tombstone and put the card back where `card` says
 *   card.moved    { cardId, before, after }    undo: put the card back at `before`'s place
 *   card.detail_edited  { cardId, before, after }  undo: put `before`'s go-live date and server info back
 *
 * `card` / `before` / `after` of the first three are the card's whole editable state at that moment; a move's are
 * only its place. A place is the lane, the position key and its index in the lane (0 = top): the key puts it back
 * exactly if the lane hasn't been rebalanced since, and the index puts it back as close as the board now allows if
 * it has.
 *
 * Every change of lane or order is a card.moved, whether it came from a drag, the keyboard or the edit sheet's Lane
 * dropdown, so History treats every move the same. An edit that changes the name and the lane at once logs both:
 * the card.edited (lane unchanged), then the card.moved.
 *
 * When a card gains fields they join CardState as optional, so older events still parse: from 0.6.0 a card.created
 * or card.deleted also carries the go-live date and server info, so restoring a deleted card brings them back.
 * card.edited stays the name and logo; the go-live date and server info are card.detail_edited, whose before/after
 * are only those two fields. An edit that changes the name, the details and the lane at once logs card.edited, then
 * card.detail_edited, then card.moved. Sign-ups are events of their own (players/events.js).
 */
const goLive = z
  .string()
  .refine((v) => dateParts(v) !== null, `a date from ${DATE_MIN_YEAR}-01-01 to ${DATE_MAX_YEAR}-12-31`)
  .nullable();
// The route counts characters as code points; this bound is UTF-16 units, so twice that is always enough.
const serverInfo = z.string().max(SERVER_INFO_MAX * 2);

const CardState = z.strictObject({
  title: z.string().min(1).max(60),
  logo: z.string().max(64).nullable(),
  lane: z.enum(LANE_IDS),
  position: z.string().min(1).max(64),
  index: z.number().int().min(0),
  goLive: goLive.optional(),
  serverInfo: serverInfo.optional(),
});

const Detail = z.strictObject({ goLive, serverInfo });

const Place = z.strictObject({
  lane: z.enum(LANE_IDS),
  position: z.string().min(1).max(64),
  index: z.number().int().min(0),
});

const cardId = z.number().int().positive();

// Restore is offered on edits, deletes and moves. Undoing a creation is a delete, which the
// board already offers, so History lists it without a Restore.
export const CARD_CREATED = declareEventType({
  type: 'card.created',
  restorable: false,
  payload: z.object({ cardId, card: CardState }),
});

export const CARD_EDITED = declareEventType({
  type: 'card.edited',
  restorable: true,
  payload: z.object({ cardId, before: CardState, after: CardState }),
});

export const CARD_DELETED = declareEventType({
  type: 'card.deleted',
  restorable: true,
  payload: z.object({ cardId, card: CardState }),
});

export const CARD_MOVED = declareEventType({
  type: 'card.moved',
  restorable: true,
  payload: z.object({ cardId, before: Place, after: Place }),
});

export const CARD_DETAIL_EDITED = declareEventType({
  type: 'card.detail_edited',
  restorable: true,
  payload: z.object({ cardId, before: Detail, after: Detail }),
});
