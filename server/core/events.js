import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The change log: one append-only `events` table every board change writes to (the database refuses updates, and
 * deletes outside purging a retired board; core/schema.js).
 *
 * Event types DECLARE themselves here rather than living in a hardcoded list: a feature calls declareEventType() for
 * each kind of change it makes, next to the code that makes it, and appendEvent() refuses any type nobody declared.
 * Each declaration's payload is a strict zod schema, so a stray field (a password, a hash) can't ride along into the
 * log by accident. The declaration also says how History reads it and, when it's restorable, how to undo it, so
 * nothing in shared code ever switches on a type:
 *
 *   declareEventType({
 *     type: 'card.moved',
 *     restorable: true,
 *     payload: z.object({ ... }),
 *     line: (payload, { cardTitle, isRestore }) => ({ verb: 'moved', subject: cardTitle(payload.cardId), detail: ' · Up Next → Played' }),
 *     restore: { plan(ctx, event, opts) { ... } },
 *   })
 *
 * line: History's sentence after the actor's name: "<actor> <verb> <subject><detail>". `tone: 'del'` marks a delete.
 *   `tag`, optional, is the live-update name tag's wording after the actor ("changed the logo"); without it a card's
 *   tag reads "<actor> <verb> this" (live/, client/src/live/).
 *   `cardTitle(id)` is the card's current name; `isRestore` says this event was written by a restore.
 * restorable: whether History offers Restore on it (then `restore` is required). Password events are never.
 * restore.plan(ctx, event, opts): what restoring `event` would do, worked out from the board as it is now. Returns
 *   { refuse: { code, error, ...safe extras } }, or { preview: { title, text, rows, notes, action }, apply(actor) }.
 *   apply() makes the change and appends its events with `restores: event.id`; it never touches past events. plan()
 *   only reads: History calls it once to show the confirmation and again, inside the write, to apply it.
 */
const registry = new Map();
const TYPE = /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/;

export function declareEventType({ type, restorable = false, payload, line, restore }) {
  if (!TYPE.test(type ?? '')) throw new Error(`event type "${type}" must look like noun.verb (lower case, snake_case parts)`);
  if (registry.has(type)) throw new Error(`event type "${type}" is declared twice`);
  if (!(payload instanceof z.ZodObject)) throw new Error(`event type "${type}" needs a zod object payload schema`);
  if (typeof line !== 'function') throw new Error(`event type "${type}" needs line(payload, ctx): how History reads it`);
  if (restorable && typeof restore?.plan !== 'function') throw new Error(`restorable event type "${type}" needs restore.plan()`);
  if (!restorable && restore) throw new Error(`event type "${type}" has a restore but isn't restorable`);
  registry.set(type, Object.freeze({ type, restorable: Boolean(restorable), payload: payload.strict(), line, restore: restore ?? null }));
  return type;
}

export function eventType(type) {
  return registry.get(type) ?? null;
}

export function declaredEventTypes() {
  return [...registry.keys()];
}

/** The display name an event is logged against: a label anyone can type, never an identity. */
export const MAX_ACTOR = 32;
export function cleanActor(value) {
  // eslint-disable-next-line no-control-regex
  const name = String(typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return [...name].slice(0, MAX_ACTOR).join('') || 'Someone';
}

/**
 * Who is writing, for live sync (live/hub.js): a board request runs inside appendContext.run(fn, …), and every event
 * it appends is reported to fn(id, row) as it is written, so the stream can tell a browser tab which changes were its
 * own. It is told before the transaction commits; `row` lets the hub check a reported id is the row it later reads
 * (an id from a rolled-back transaction is reused by the next insert).
 */
export const appendContext = new AsyncLocalStorage();

/**
 * Appends one event. Call it inside the same transaction as the change it records. Returns the event id.
 * `restores`: the id of the event this one undoes, set only by a restore's apply().
 */
export function appendEvent(db, { boardId, type, actor, payload = {}, restores = null }) {
  const def = registry.get(type);
  if (!def) throw new Error(`event type "${type}" was never declared`);
  const data = def.payload.parse(payload);
  const row = { type, actor: cleanActor(actor), payload: JSON.stringify(data) };
  const { lastInsertRowid } = db
    .prepare('INSERT INTO events (board_id, type, actor, payload, restores) VALUES (?, ?, ?, ?, ?)')
    .run(boardId, row.type, row.actor, row.payload, restores);
  const id = Number(lastInsertRowid);
  appendContext.getStore()?.(id, row);
  return id;
}

/** The id of a board's newest event (0 if none): where a live stream starts for a board loaded now. */
export function latestEventId(db, boardId) {
  return db.prepare('SELECT MAX(id) FROM events WHERE board_id = ?').pluck().get(boardId) ?? 0;
}

/**
 * A board's events after `afterId`, oldest first, at most `limit` (never more than MAX_PAGE): what a live stream
 * sends next. Rows as listEvents gives them, plus `raw` (the payload as stored, for the hub's origin check).
 */
export function eventsAfter(db, boardId, afterId, limit) {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_PAGE + 1);
  return db
    .prepare('SELECT id, type, actor, payload, created_at, restores, card_id FROM events WHERE board_id = ? AND id > ? ORDER BY id LIMIT ?')
    .all(boardId, afterId, n)
    .map((r) => ({
      id: r.id,
      type: r.type,
      actor: r.actor,
      payload: JSON.parse(r.payload),
      raw: r.payload,
      at: r.created_at,
      restores: r.restores,
      cardId: r.card_id,
      restorable: registry.get(r.type)?.restorable ?? false,
    }));
}

/** The most events one page holds. */
export const MAX_PAGE = 200;

/**
 * A page of a board's events, newest first, in the (board_id, created_at) index's order; with `cardId`, only that
 * card's (the (board_id, card_id, created_at) index). `before` is the cursor the previous page returned as `next`
 * (opaque); null for the first page. Returns { events, next }, next null at the end. Never more than MAX_PAGE.
 */
export function listEvents(db, boardId, { limit = 50, before = null, cardId = null } = {}) {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_PAGE);
  const [at = null, id = null] = before ? String(before).split('~') : [];
  const rows = db
    .prepare(
      `SELECT id, type, actor, payload, created_at, restores, card_id FROM events
       WHERE board_id = ? AND (? IS NULL OR card_id = ?) AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(boardId, cardId, cardId, at, at, at, Number(id), n + 1);
  const page = rows.slice(0, n).map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor,
    payload: JSON.parse(r.payload),
    at: r.created_at,
    restores: r.restores,
    cardId: r.card_id,
    restorable: registry.get(r.type)?.restorable ?? false,
  }));
  const last = page[page.length - 1];
  return { events: page, next: rows.length > n ? `${last.at}~${last.id}` : null };
}

/** One event of a board by id, as listEvents gives it, or null. */
export function getEvent(db, boardId, id) {
  const r = db
    .prepare('SELECT id, type, actor, payload, created_at, restores, card_id FROM events WHERE board_id = ? AND id = ? LIMIT 1')
    .get(boardId, id);
  if (!r) return null;
  return { id: r.id, type: r.type, actor: r.actor, payload: JSON.parse(r.payload), at: r.created_at, restores: r.restores, cardId: r.card_id };
}

/** The events that restore any of `ids` (at most one each: events_restored_once), as Map(restoredId → event). */
export function restorersOf(db, boardId, ids) {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT id, actor, created_at, restores FROM events WHERE board_id = ? AND restores IN (${ids.map(() => '?').join(', ')})
       LIMIT ${ids.length}`,
    )
    .all(boardId, ...ids);
  return new Map(rows.map((r) => [r.restores, { id: r.id, actor: r.actor, at: r.created_at }]));
}

/** The newest event of `type` about a card (e.g. the delete that took it off the board), or null. */
export function latestCardEvent(db, boardId, cardId, type) {
  const r = db
    .prepare(
      `SELECT id, type, actor, payload, created_at, restores, card_id FROM events
       WHERE board_id = ? AND card_id = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(boardId, cardId, type);
  return r ? { id: r.id, type: r.type, actor: r.actor, payload: JSON.parse(r.payload), at: r.created_at, restores: r.restores, cardId: r.card_id } : null;
}

/**
 * History's sentence for an event, from its type's declaration. An event whose type is no longer declared still
 * shows, plainly, rather than vanishing from the log.
 */
export function lineOf(event, ctx) {
  const def = registry.get(event.type);
  if (!def) return { verb: 'made a change', subject: '', detail: '' };
  const line = def.line(event.payload, { ...ctx, isRestore: event.restores !== null });
  return {
    verb: line.verb,
    subject: line.subject ?? '',
    detail: line.detail ?? '',
    ...(line.tone ? { tone: line.tone } : {}),
    // The live-update name tag on a card ("Bunzato moved this"), when "<verb> this" wouldn't read right.
    ...(line.tag ? { tag: line.tag } : {}),
  };
}

/**
 * What restoring an event would do: { refuse } or { preview, apply }. Refuses an event that isn't restorable or
 * has already been restored (with who restored it, and when). Read-only; apply() is for inside a write transaction.
 */
export function planRestore(db, boardId, event, opts = {}) {
  const def = registry.get(event.type);
  if (!def?.restorable) return { refuse: { code: 'not_restorable', error: 'This change can’t be restored.' } };
  const by = restorersOf(db, boardId, [event.id]).get(event.id);
  if (by) return { refuse: { code: 'already_restored', error: `${by.actor} already restored this.`, restoredBy: by } };
  const plan = def.restore.plan({ db, boardId }, event, opts);
  if (plan.refuse) return plan;
  return { preview: { ...plan.preview, token: tokenOf(plan.preview) }, apply: plan.apply };
}

// What the person confirmed: if the board changes between the confirmation and the restore, the token no longer
// matches and they're shown the new confirmation instead of getting something they didn't agree to.
function tokenOf(preview) {
  return createHash('sha256').update(JSON.stringify(preview)).digest('base64url').slice(0, 22);
}
