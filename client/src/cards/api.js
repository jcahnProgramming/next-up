import { request } from '../boards/api.js';
import { readDisplayName } from '../prefs/displayName.js';

/**
 * The cards API (server/cards/routes.js). Every call resolves to one plain result, never throws:
 *
 *   { kind: 'ok', card, rebalanced? } | { kind: 'ok', cards, limit }   rebalanced: other cards' keys changed (reload)
 *   { kind: 'locked', changed }        the board locked under us (lock pressed in another tab, or the password changed)
 *   { kind: 'invalid', field, error }  the server refused an input
 *   { kind: 'conflict', card }         someone else changed the card first; `card` is the latest
 *   { kind: 'gone' }                   the card was deleted
 *   { kind: 'full', error }            the board holds the most cards it can
 *   { kind: 'error', offline }         couldn't reach Next Up, or it failed
 *
 * Changes carry this browser's display name as `actor` (a label; "Someone" when there's none).
 */
const base = (code) => `/api/boards/${code}/cards`;

function read(r) {
  if (r.failed) return { kind: 'error', offline: r.offline };
  const { status, data } = r;
  if (data?.status === 'locked') return { kind: 'locked', changed: data.reason === 'password_changed' };
  if (status === 200 || status === 201) {
    if (data?.card) return { kind: 'ok', card: data.card, rebalanced: data.rebalanced === true };
    if (Array.isArray(data?.cards)) return { kind: 'ok', cards: data.cards, next: data.next ?? null, limit: data.limit, head: data.head };
  }
  if (data?.code === 'conflict' && data.card) return { kind: 'conflict', card: data.card };
  if (data?.code === 'card_gone') return { kind: 'gone' };
  if (data?.code === 'card_limit') return { kind: 'full', error: data.error };
  if (status === 400 && data?.field) return { kind: 'invalid', field: data.field, error: data.error };
  return { kind: 'error', offline: false };
}

/**
 * Every live card on the board, following the server's pages (a board holds at most its limit, so a page or two).
 * `head` is the board's newest event id as of the first page: where its live stream picks up (changes after it are
 * replayed, and applying one the cards already show is harmless).
 */
export async function loadCards(code) {
  const cards = [];
  let after = null;
  let limit = null;
  let head = null;
  for (let page = 0; page < 20; page++) {
    const r = read(await request(`${base(code)}${after ? `?after=${encodeURIComponent(after)}` : ''}`));
    if (r.kind !== 'ok') return r;
    cards.push(...r.cards);
    limit = r.limit;
    head ??= Number.isSafeInteger(r.head) ? r.head : null;
    if (!r.next) return { kind: 'ok', cards, limit, head };
    after = r.next;
  }
  return { kind: 'error', offline: false };
}

const actor = () => readDisplayName() ?? undefined;

export const addCard = async (code, { title, logo, lane, goLive, serverInfo }) =>
  read(await request(base(code), { method: 'POST', body: { title, logo, lane, goLive, serverInfo, actor: actor() } }));

export const editCard = async (code, card, changes) =>
  read(await request(`${base(code)}/${card.id}`, { method: 'PATCH', body: { ...changes, version: card.version, actor: actor() } }));

/** Places the card at `index` among `lane`'s other cards; `afterId` is the card just above that gap (null: the top). */
export const moveCard = async (code, card, { lane, index, afterId }) =>
  read(await request(`${base(code)}/${card.id}/move`, { method: 'POST', body: { lane, index, afterId, actor: actor() } }));

export const deleteCard = async (code, card) =>
  read(await request(`${base(code)}/${card.id}`, { method: 'DELETE', body: { version: card.version, actor: actor() } }));

/**
 * A card's sign-ups (server/players/routes.js). Besides the kinds above:
 *
 *   { kind: 'ok', players, limit }                  the list, in sign-up order
 *   { kind: 'ok', player, playerCount }             added or removed; playerCount is the card's new count
 *   { kind: 'exists', error, player }               that name is already on the card (`player` as written there)
 *   { kind: 'players-full', error }                 the card has the most players it can hold
 *   { kind: 'player-gone' }                         someone else removed that player first
 *   { kind: 'gone' }                                the card was deleted
 */
const players = (code, card) => `${base(code)}/${card.id}/players`;

function readPlayers(r) {
  if (r.failed) return { kind: 'error', offline: r.offline };
  const { status, data } = r;
  if (data?.status === 'locked') return { kind: 'locked', changed: data.reason === 'password_changed' };
  if ((status === 200 || status === 201) && data?.player) return { kind: 'ok', player: data.player, playerCount: data.playerCount };
  if (status === 200 && Array.isArray(data?.players)) return { kind: 'ok', players: data.players, next: data.next ?? null, limit: data.limit };
  if (data?.code === 'player_exists') return { kind: 'exists', error: data.error, player: data.player };
  if (data?.code === 'player_limit') return { kind: 'players-full', error: data.error };
  if (data?.code === 'player_gone') return { kind: 'player-gone' };
  if (data?.code === 'card_gone') return { kind: 'gone' };
  if (status === 400 && data?.field) return { kind: 'invalid', field: data.field, error: data.error };
  return { kind: 'error', offline: false };
}

/** Everyone signed up to the card, following the server's pages (a card holds at most its limit: one page). */
export async function loadPlayers(code, card) {
  const list = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const r = readPlayers(await request(`${players(code, card)}${after ? `?after=${encodeURIComponent(after)}` : ''}`));
    if (r.kind !== 'ok') return r;
    list.push(...r.players);
    if (!r.next) return { kind: 'ok', players: list, limit: r.limit };
    after = r.next;
  }
  return { kind: 'error', offline: false };
}

export const addPlayer = async (code, card, name) =>
  readPlayers(await request(players(code, card), { method: 'POST', body: { name, actor: actor() } }));

export const removePlayer = async (code, card, player) =>
  readPlayers(await request(`${players(code, card)}/${player.id}`, { method: 'DELETE', body: { actor: actor() } }));
