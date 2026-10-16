import { z } from 'zod';
import { DATE_MAX_YEAR, DATE_MIN_YEAR, SERVER_INFO_MAX, dateParts } from '../core/cardDetail.js';
import { LANE_IDS, MAX_CARDS, cardLimitMessage, laneName } from '../core/cardRules.js';
import { appendEvent, declareEventType, latestCardEvent } from '../core/events.js';
import { cardStore, editableOf, placeOf, stateOf, wholeStateOf } from './store.js';

/**
 * Card changes. Each payload carries enough to undo the change without reading anything else:
 *
 *   card.created  { cardId, card }             not restorable: undoing it is a delete, which the board offers
 *   card.edited   { cardId, before, after }    restore: put back the name and logo `before` had, where they differ
 *   card.deleted  { cardId, card }             restore: clear the tombstone and put the card back where `card` says
 *   card.restored { cardId, card }             restore: delete it again (a deleted card brought back by History)
 *   card.moved    { cardId, before, after }    restore: put the card back at `before`'s place
 *   card.detail_edited  { cardId, before, after }  restore: put `before`'s go-live date and server info back
 *
 * `card` / `before` / `after` of the first four are the card's whole editable state at that moment; a move's are
 * only its place. A place is the lane, the position key and its index in the lane (0 = top): the key puts it back
 * exactly if the lane hasn't changed around it since, and the index puts it back as close as the board now allows
 * if it has (cardStore().placeNear).
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
 *
 * A restore only ever writes NEW events (marked `restores`), the same types a person's own change writes, so a
 * restore is itself restorable. Restoring a change to a card that has been deleted since asks first; with
 * `withCard` it brings the card back too (a card.restored for that delete), unless the board is full.
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

// ---------- the types ----------

export const CARD_CREATED = declareEventType({
  type: 'card.created',
  restorable: false,
  payload: z.object({ cardId, card: CardState }),
  line: (p) => ({ verb: 'added', subject: p.card.title, detail: ` to ${laneName(p.card.lane)}` }),
});

// The name and logo. Restore puts back only the fields this edit changed.
const EDIT_FIELDS = [
  { key: 'title', label: 'Name', kind: 'text', noun: 'name' },
  { key: 'logo', label: 'Logo', kind: 'logo', noun: 'logo' },
];

export const CARD_EDITED = declareEventType({
  type: 'card.edited',
  restorable: true,
  payload: z.object({ cardId, before: CardState, after: CardState }),
  line: (p, { isRestore }) => {
    const renamed = p.before.title !== p.after.title;
    const relogo = p.before.logo !== p.after.logo;
    if (isRestore) return { verb: 'restored', subject: p.after.title, detail: ` · ${nounsOf(EDIT_FIELDS, p)}` };
    if (renamed) return { verb: 'renamed', subject: p.before.title, detail: ` to ${p.after.title}${relogo ? ' and changed its logo' : ''}` };
    return { verb: 'changed the logo of', subject: p.after.title, detail: '' };
  },
  restore: { plan: (ctx, event, opts) => planFields(ctx, event, opts, EDIT_FIELDS, 'card.edited') },
});

// The go-live date and server info. Restore puts back only the fields this edit changed.
const DETAIL_FIELDS = [
  { key: 'goLive', label: 'Go-live', kind: 'date', noun: 'go-live date' },
  { key: 'serverInfo', label: 'Server info', kind: 'info', noun: 'server info' },
];

export const CARD_DETAIL_EDITED = declareEventType({
  type: 'card.detail_edited',
  restorable: true,
  payload: z.object({ cardId, before: Detail, after: Detail }),
  line: (p, { cardTitle, isRestore }) => ({
    verb: isRestore ? 'restored' : 'edited',
    subject: cardTitle(p.cardId),
    detail: ` · ${nounsOf(DETAIL_FIELDS, p)}`,
  }),
  restore: { plan: (ctx, event, opts) => planFields(ctx, event, opts, DETAIL_FIELDS, 'card.detail_edited') },
});

export const CARD_MOVED = declareEventType({
  type: 'card.moved',
  restorable: true,
  payload: z.object({ cardId, before: Place, after: Place }),
  line: (p, { cardTitle, isRestore }) => {
    const title = cardTitle(p.cardId);
    if (isRestore) return { verb: 'moved', subject: title, detail: ` back to ${laneName(p.after.lane)}, ${ordinal(p.after.index + 1)}` };
    if (p.before.lane !== p.after.lane) return { verb: 'moved', subject: title, detail: ` · ${laneName(p.before.lane)} → ${laneName(p.after.lane)}` };
    return { verb: 'moved', subject: title, detail: ` · ${laneName(p.after.lane)}, ${ordinal(p.before.index + 1)} → ${ordinal(p.after.index + 1)}` };
  },
  restore: { plan: planMove },
});

export const CARD_DELETED = declareEventType({
  type: 'card.deleted',
  restorable: true,
  payload: z.object({ cardId, card: CardState }),
  line: (p, { isRestore }) => ({ verb: 'deleted', subject: p.card.title, detail: isRestore ? ' again, undoing a restore' : '', tone: 'del' }),
  restore: { plan: (ctx, event) => planUndelete(ctx, event) },
});

export const CARD_RESTORED = declareEventType({
  type: 'card.restored',
  restorable: true,
  payload: z.object({ cardId, card: CardState }),
  line: (p) => ({ verb: 'restored', subject: p.card.title, detail: ` to ${laneName(p.card.lane)}` }),
  restore: { plan: planRedelete },
});

// ---------- restoring ----------

const stores = new WeakMap();
/** The card store for a raw connection (History's ctx carries the connection itself). */
export function storeOf(db) {
  if (!stores.has(db)) stores.set(db, cardStore(() => db));
  return stores.get(db);
}

const nothing = (error) => ({ refuse: { code: 'nothing_to_restore', error } });
const gone = () => ({ refuse: { code: 'card_gone', error: 'That card no longer exists.' } });

/**
 * The card a restore acts on, live. If it has been deleted since: without opts.withCard, a refusal saying so (and
 * whether it could come back: canRestoreCard); with it, the card as it will be once its delete is undone, plus that
 * undo (`pre`) to apply first. → { card, index, pre?, rows, notes } | { refuse }
 */
export function withLiveCard(ctx, id, opts = {}) {
  const { q } = storeOf(ctx.db);
  const card = q.byId(ctx.boardId, id);
  if (!card) return gone();
  if (!card.deleted_at) return { card, index: q.indexOf(card), pre: null, rows: [], notes: [] };
  const full = q.liveCount(ctx.boardId) >= MAX_CARDS;
  if (!opts.withCard || full) {
    return {
      refuse: {
        code: 'card_deleted',
        canRestoreCard: !full,
        title: card.title,
        error: full
          ? `${card.title} has been deleted since, and it can’t come back: ${cardLimitMessage}`
          : `${card.title} has been deleted since this change.`,
      },
    };
  }
  const deletion = latestCardEvent(ctx.db, ctx.boardId, id, CARD_DELETED);
  if (!deletion) return gone();
  const pre = planUndelete(ctx, deletion);
  if (pre.refuse) return pre;
  const near = pre.near;
  return {
    card: { ...card, deleted_at: null, lane: near.lane },
    index: near.index,
    pre,
    rows: [{ label: 'Card', now: { kind: 'text', value: 'Deleted' }, after: { kind: 'text', value: 'Back on the board' } }],
    notes: [`${card.title} has been deleted since this change, so it comes back too: ${laneName(near.lane)}, ${ordinal(near.index + 1)} of ${near.of}.`],
  };
}

// card.edited and card.detail_edited: put back each field this event changed, leaving everything else as it is now.
function planFields(ctx, event, opts, fields, type) {
  const p = event.payload;
  const base = withLiveCard(ctx, p.cardId, opts);
  if (base.refuse) return base;
  const changed = fields.filter((f) => p.before[f.key] !== p.after[f.key]);
  const now = editableOf(base.card);
  const title = base.card.title;
  if (changed.length === 0 || (!base.pre && changed.every((f) => now[f.key] === p.before[f.key]))) {
    return nothing(`${title} already has the ${listOf(changed.map((f) => f.noun))} it had before this change.`);
  }
  const notes = [...base.notes];
  if (changed.some((f) => now[f.key] !== p.after[f.key])) {
    notes.push(`${title} has been changed since. Only what this change touched goes back; the rest stays as it is now.`);
  }
  return {
    preview: {
      title: `Restore ${title}?`,
      text: `Puts back the ${listOf(changed.map((f) => f.noun))} from before this change.`,
      rows: [
        ...base.rows,
        ...changed.map((f) => ({ label: f.label, now: { kind: f.kind, value: now[f.key] }, after: { kind: f.kind, value: p.before[f.key] } })),
      ],
      notes,
      action: 'Restore',
    },
    apply(actor) {
      base.pre?.apply(actor);
      const { q } = storeOf(ctx.db);
      const card = q.byId(ctx.boardId, p.cardId);
      const next = editableOf(card);
      for (const f of changed) next[f.key] = p.before[f.key];
      q.update(ctx.boardId, card.id, next);
      const saved = q.byId(ctx.boardId, card.id);
      const index = q.indexOf(saved);
      const [before, after] =
        type === 'card.edited'
          ? [stateOf(card, index), stateOf(saved, index)]
          : [{ goLive: card.go_live, serverInfo: card.server_info }, { goLive: saved.go_live, serverInfo: saved.server_info }];
      appendEvent(ctx.db, { boardId: ctx.boardId, type, actor, payload: { cardId: card.id, before, after }, restores: event.id });
      return { rebalanced: base.pre?.rebalanced ?? false };
    },
  };
}

// card.moved: back to the place it had before this move, as close as the lane now allows.
function planMove(ctx, event, opts) {
  const p = event.payload;
  const base = withLiveCard(ctx, p.cardId, opts);
  if (base.refuse) return base;
  const { placeNear } = storeOf(ctx.db);
  const { card, index } = base;
  const near = placeNear(ctx.boardId, card.id, p.before);
  const title = card.title;
  if (!base.pre && card.lane === near.lane && index === near.index) return nothing(`${title} is already there.`);
  const notes = [...base.notes];
  if (!near.exact) {
    notes.push(
      `${laneName(near.lane)} has changed since, so ${title} goes ${ordinal(near.index + 1)}, as close to where it was as the lane allows.`,
    );
  }
  // Where it is now (nowhere, if it's coming back from a delete), counted in its own lane.
  const was = base.pre ? null : { lane: card.lane, index, of: laneSize(ctx, card.lane) };
  return {
    preview: {
      title: `Move ${title} back?`,
      text: `Puts it back where it was before this move: ${laneName(near.lane)}, ${ordinal(p.before.index + 1)}.`,
      rows: [
        ...base.rows,
        { label: 'Lane', now: { kind: 'lane', value: was?.lane ?? null }, after: { kind: 'lane', value: near.lane } },
        {
          label: 'Position',
          now: { kind: 'place', value: was ? { index: was.index, of: was.of } : null },
          after: { kind: 'place', value: { index: near.index, of: near.of } },
        },
      ],
      notes,
      action: 'Move it back',
    },
    apply(actor) {
      const pre = base.pre?.apply(actor);
      const store = storeOf(ctx.db);
      const live = store.q.byId(ctx.boardId, card.id);
      const from = store.q.indexOf(live);
      const target = store.placeNear(ctx.boardId, card.id, p.before);
      if (live.lane === target.lane && from === target.index) return { rebalanced: pre?.rebalanced ?? false };
      const placed = store.claim(ctx.boardId, target);
      store.q.update(ctx.boardId, card.id, { ...editableOf(live), lane: target.lane, position: placed.position });
      const saved = store.q.byId(ctx.boardId, card.id);
      appendEvent(ctx.db, {
        boardId: ctx.boardId,
        type: CARD_MOVED,
        actor,
        payload: { cardId: card.id, before: placeOf(stateOf(live, from)), after: placeOf(stateOf(saved, target.index)) },
        restores: event.id,
      });
      return { rebalanced: Boolean(pre?.rebalanced || placed.rebalanced) };
    },
  };
}

// card.deleted: the card back on the board, where it was when deleted (as close as the lane now allows), with its
// go-live date, server info and sign-ups (only the card was tombstoned). Refused when the board is full.
function planUndelete(ctx, event) {
  const p = event.payload;
  const { q, placeNear } = storeOf(ctx.db);
  const card = q.byId(ctx.boardId, p.cardId);
  if (!card) return gone();
  if (!card.deleted_at) return nothing(`${card.title} is already on the board.`);
  if (q.liveCount(ctx.boardId) >= MAX_CARDS) return { refuse: { code: 'card_limit', error: cardLimitMessage } };
  const near = placeNear(ctx.boardId, card.id, placeOf(p.card));
  const notes = near.exact
    ? []
    : [`${laneName(near.lane)} has changed since, so ${card.title} goes ${ordinal(near.index + 1)}, as close to where it was as the lane allows.`];
  return {
    near,
    preview: {
      title: `Restore ${card.title}?`,
      text: 'Puts the card back on the board, with its go-live date, server info and sign-ups.',
      rows: [
        { label: 'Card', now: { kind: 'text', value: 'Deleted' }, after: { kind: 'text', value: 'On the board' } },
        { label: 'Lane', now: { kind: 'lane', value: null }, after: { kind: 'lane', value: near.lane } },
        { label: 'Position', now: { kind: 'place', value: null }, after: { kind: 'place', value: { index: near.index, of: near.of } } },
      ],
      notes,
      action: 'Restore',
    },
    apply(actor) {
      const store = storeOf(ctx.db);
      const target = store.placeNear(ctx.boardId, card.id, placeOf(p.card));
      const placed = store.claim(ctx.boardId, target);
      store.q.untombstone(ctx.boardId, card.id, target.lane, placed.position);
      const saved = store.q.byId(ctx.boardId, card.id);
      appendEvent(ctx.db, {
        boardId: ctx.boardId,
        type: CARD_RESTORED,
        actor,
        payload: { cardId: card.id, card: wholeStateOf(saved, target.index) },
        restores: event.id,
      });
      return { rebalanced: placed.rebalanced };
    },
  };
}

// card.restored: take the card off the board again.
function planRedelete(ctx, event) {
  const { q } = storeOf(ctx.db);
  const card = q.byId(ctx.boardId, event.payload.cardId);
  if (!card) return gone();
  if (card.deleted_at) return nothing(`${card.title} is already deleted.`);
  return {
    preview: {
      title: `Delete ${card.title} again?`,
      text: 'Takes the card off the board again, as it was before this restore.',
      rows: [{ label: 'Card', now: { kind: 'text', value: 'On the board' }, after: { kind: 'text', value: 'Deleted' } }],
      notes: [],
      action: 'Delete it again',
    },
    apply(actor) {
      const store = storeOf(ctx.db);
      const live = store.q.byId(ctx.boardId, card.id);
      const state = wholeStateOf(live, store.q.indexOf(live));
      store.q.tombstone(ctx.boardId, card.id);
      appendEvent(ctx.db, { boardId: ctx.boardId, type: CARD_DELETED, actor, payload: { cardId: card.id, card: state }, restores: event.id });
      return { rebalanced: false };
    },
  };
}

// ---------- wording ----------

const laneSize = (ctx, lane) => storeOf(ctx.db).q.laneCount(ctx.boardId, lane);

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** "name", "name and logo", "go-live date, server info and logo". */
export function listOf(words) {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// The fields an edit changed, for its History line: "go-live date, server info".
function nounsOf(fields, p) {
  return fields
    .filter((f) => p.before[f.key] !== p.after[f.key])
    .map((f) => f.noun)
    .join(', ');
}
