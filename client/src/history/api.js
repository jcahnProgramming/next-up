import { request } from '../boards/api.js';
import { readDisplayName } from '../prefs/displayName.js';

/**
 * The History API (server/history/routes.js). Every call resolves to one plain result, never throws:
 *
 *   { kind: 'ok', events, next, card? }      a page of changes, newest first (card: the card it's filtered to)
 *   { kind: 'preview', preview }             what restoring would do: { title, text, rows, notes, action, token }
 *   { kind: 'restored', rebalanced }         done; the board should reload
 *   { kind: 'refused', code, error, … }      not done, and why (already_restored, card_deleted, card_limit, …)
 *   { kind: 'changed', error, preview }      the board changed after the confirmation was shown: the new one
 *   { kind: 'locked', changed }              the board locked under us
 *   { kind: 'gone' }                         no such change (or card) on this board
 *   { kind: 'error', offline }               couldn't reach Next Up, or it failed
 *
 * A restore carries this browser's display name as `actor` (a label; "Someone" when there's none).
 */
const base = (code) => `/api/boards/${code}/history`;

function read(r) {
  if (r.failed) return { kind: 'error', offline: r.offline };
  const { status, data } = r;
  if (data?.status === 'locked') return { kind: 'locked', changed: data.reason === 'password_changed' };
  if (status === 200 && Array.isArray(data?.events)) return { kind: 'ok', events: data.events, next: data.next ?? null, card: data.card ?? null };
  if (status === 200 && data?.preview) return { kind: 'preview', preview: data.preview };
  if (status === 200 && data?.restored) return { kind: 'restored', rebalanced: data.rebalanced === true };
  if (data?.code === 'changed' && data.preview) return { kind: 'changed', error: data.error, preview: data.preview };
  if (status === 404) return { kind: 'gone' };
  if (status === 409 && data?.code) return { kind: 'refused', ...data };
  return { kind: 'error', offline: false };
}

/** One page: the newest 50, or the 50 before `before` (the previous page's `next`). `cardId` filters to one card. */
export async function loadHistory(code, { before = null, cardId = null } = {}) {
  const q = new URLSearchParams();
  if (before) q.set('before', before);
  if (cardId) q.set('card', String(cardId));
  const s = q.toString();
  return read(await request(`${base(code)}${s ? `?${s}` : ''}`));
}

export const previewRestore = async (code, eventId, { withCard = false } = {}) =>
  read(await request(`${base(code)}/${eventId}/restore${withCard ? '?withCard=1' : ''}`));

export const restoreEvent = async (code, eventId, { token, withCard = false }) =>
  read(
    await request(`${base(code)}/${eventId}/restore`, {
      method: 'POST',
      body: { token, withCard, actor: readDisplayName() ?? undefined },
    }),
  );
