import { z } from 'zod';

/**
 * The change log: one append-only `events` table every board change writes to (the database refuses updates, and
 * deletes outside purging a retired board; core/schema.js).
 *
 * Event types DECLARE themselves here rather than living in a hardcoded list: a feature calls declareEventType() for
 * each kind of change it makes, next to the code that makes it, and appendEvent() refuses any type nobody declared.
 * Each declaration's payload is a strict zod schema, so a stray field (a password, a hash) can't ride along into the
 * log by accident.
 *
 *   declareEventType({ type: 'card.moved', restorable: true, payload: z.object({ ... }) })
 *
 * restorable: whether History will offer Restore on it. Password events are never restorable.
 */
const registry = new Map();
const TYPE = /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/;

export function declareEventType({ type, restorable = false, payload }) {
  if (!TYPE.test(type ?? '')) throw new Error(`event type "${type}" must look like noun.verb (lower case, snake_case parts)`);
  if (registry.has(type)) throw new Error(`event type "${type}" is declared twice`);
  if (!(payload instanceof z.ZodObject)) throw new Error(`event type "${type}" needs a zod object payload schema`);
  registry.set(type, Object.freeze({ type, restorable: Boolean(restorable), payload: payload.strict() }));
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

/** Appends one event. Call it inside the same transaction as the change it records. Returns the event id. */
export function appendEvent(db, { boardId, type, actor, payload = {} }) {
  const def = registry.get(type);
  if (!def) throw new Error(`event type "${type}" was never declared`);
  const data = def.payload.parse(payload);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO events (board_id, type, actor, payload) VALUES (?, ?, ?, ?)')
    .run(boardId, type, cleanActor(actor), JSON.stringify(data));
  return Number(lastInsertRowid);
}

/**
 * A page of a board's events, newest first, in the (board_id, created_at) index's order. `before` is the cursor the
 * previous page returned as `next` (opaque); null for the first page. Returns { events, next }, next null at the end.
 */
export function listEvents(db, boardId, { limit = 50, before = null } = {}) {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 1), 200);
  const [at = null, id = null] = before ? String(before).split('~') : [];
  const rows = db
    .prepare(
      `SELECT id, type, actor, payload, created_at FROM events
       WHERE board_id = ? AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(boardId, at, at, at, Number(id), n + 1);
  const page = rows.slice(0, n).map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor,
    payload: JSON.parse(r.payload),
    at: r.created_at,
    restorable: registry.get(r.type)?.restorable ?? false,
  }));
  const last = page[page.length - 1];
  return { events: page, next: rows.length > n ? `${last.at}~${last.id}` : null };
}
