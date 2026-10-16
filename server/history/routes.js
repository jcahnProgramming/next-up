import express from 'express';
import '../boards/events.js';
import { storeOf } from '../cards/events.js';
import '../players/events.js';
import { getEvent, lineOf, listEvents, planRestore, restorersOf } from '../core/events.js';

/**
 * /api/boards/:code/history. Mounted by boards/routes.js AFTER requireAccess, so a password board without access
 * never reaches here: every method and path answers only { status: 'locked', code }.
 *
 *   GET  /                      a page of the board's changes, newest first: { events, next }   ?limit=&before=&card=
 *   GET  /:eventId/restore      what restoring it would do: { preview } (title, text, rows, notes, action, token)
 *                               ?withCard=1 also brings back a card deleted since
 *   POST /:eventId/restore      do it { token, withCard?, actor? } → { restored: true, rebalanced? }
 *
 * How each change reads and how it's undone are declared by its event type (core/events.js); nothing here knows one
 * type from another. A restore never edits or removes an event: it makes the change and writes NEW events marked
 * `restores`, so it shows in History itself and can be restored in turn.
 *
 * Refusals are 409 { code, error }: not_restorable · already_restored (restoredBy) · nothing_to_restore ·
 * card_deleted (canRestoreCard) · card_limit · player_exists · player_limit · changed (the board changed after the
 * confirmation was shown: `preview` is what restoring does now). An unknown event is 404 event_gone.
 */
/** History shows 50 changes at a time, and never hands out more than 100 in one answer. */
export const PAGE = 50;
const MAX_LIMIT = 100;

export function createHistoryRouter({ db }) {
  const router = express.Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const boardId = req.board.id;
    const limit = Math.min(Math.max(1, Number.parseInt(req.query.limit, 10) || PAGE), MAX_LIMIT);
    const before = req.query.before;
    if (before !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~\d{1,15}$/.test(String(before))) {
      return res.status(400).json({ error: 'That page cursor isn’t valid.', field: 'before' });
    }
    let card = null;
    if (req.query.card !== undefined) {
      const id = idOf(req.query.card);
      card = id === null ? null : storeOf(db()).q.byId(boardId, id);
      if (!card) return res.status(404).json({ error: 'There’s no such card on this board.', code: 'card_gone' });
    }

    const page = listEvents(db(), boardId, { limit, before: before ?? null, cardId: card?.id ?? null });
    const ids = page.events.map((e) => e.id);
    const restoredBy = restorersOf(db(), boardId, ids);
    const undone = eventsByIds(db(), boardId, [...new Set(page.events.map((e) => e.restores).filter((id) => id !== null))]);
    const cardIds = [...new Set(page.events.map((e) => e.cardId).filter((id) => Number.isSafeInteger(id)))];
    const titles = new Map(storeOf(db()).q.titles(boardId, cardIds).map((r) => [r.id, r.title]));
    const cardTitle = (id) => titles.get(id) ?? 'a card';

    res.json({
      events: page.events.map((e) => ({
        id: e.id,
        type: e.type,
        actor: e.actor,
        at: e.at,
        cardId: Number.isSafeInteger(e.cardId) ? e.cardId : null,
        line: lineOf(e, { cardTitle }),
        restorable: e.restorable && !restoredBy.has(e.id),
        restoredBy: restoredBy.get(e.id) ?? null,
        restores: e.restores !== null ? (undone.get(e.restores) ?? null) : null,
      })),
      next: page.next,
      ...(card ? { card: { id: card.id, title: card.title, deleted: card.deleted_at !== null } } : {}),
    });
  });

  router.get('/:eventId/restore', (req, res) => {
    const id = idOf(req.params.eventId);
    const event = id === null ? null : getEvent(db(), req.board.id, id);
    if (!event) return eventGone(res);
    const plan = planRestore(db(), req.board.id, event, { withCard: req.query.withCard === '1' });
    if (plan.refuse) return res.status(409).json(plan.refuse);
    res.json({ preview: plan.preview });
  });

  router.post('/:eventId/restore', (req, res) => {
    const body = req.body ?? {};
    const id = idOf(req.params.eventId);
    if (id === null) return eventGone(res);
    if (typeof body.token !== 'string' || !body.token) {
      return res.status(400).json({ error: 'Open the restore again and confirm it.', field: 'token' });
    }
    const boardId = req.board.id;
    // Worked out again inside the write: what's applied is what the board is now, and only if that is still what
    // the person confirmed.
    const outcome = db().transaction(() => {
      const event = getEvent(db(), boardId, id);
      if (!event) return { gone: true };
      const plan = planRestore(db(), boardId, event, { withCard: body.withCard === true });
      if (plan.refuse) return { refuse: plan.refuse };
      if (plan.preview.token !== body.token) return { changed: plan.preview };
      return { done: plan.apply(body.actor) };
    }).immediate();
    if (outcome.gone) return eventGone(res);
    if (outcome.refuse) return res.status(409).json(outcome.refuse);
    if (outcome.changed) {
      return res.status(409).json({
        code: 'changed',
        error: 'The board changed while this was open. This is what restoring does now.',
        preview: outcome.changed,
      });
    }
    res.json({ restored: true, ...(outcome.done.rebalanced ? { rebalanced: true } : {}) });
  });

  return router;
}

function idOf(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && String(id) === String(raw) ? id : null;
}

function eventGone(res) {
  return res.status(404).json({ error: 'There’s no such change on this board.', code: 'event_gone' });
}

// Who made the changes a page's restores undid, and when: { id, actor, at } by id. At most one page's worth.
function eventsByIds(db, boardId, ids) {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, actor, created_at FROM events WHERE board_id = ? AND id IN (${ids.map(() => '?').join(', ')}) LIMIT ${ids.length}`)
    .all(boardId, ...ids);
  return new Map(rows.map((r) => [r.id, { id: r.id, actor: r.actor, at: r.created_at }]));
}
