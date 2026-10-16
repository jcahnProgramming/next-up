import { z } from 'zod';
import { MAX_PLAYERS } from '../../core/cardDetail.js';
import { MAX_CARDS, cleanTitle, laneName } from '../../core/cardRules.js';
import { storeOf } from '../../cards/events.js';
import { playerBody, playerQueries } from '../../players/store.js';
import { LOCKED, LOCKED_NOTE, codeInput, findBoard } from './board.js';

const titleKey = (s) => cleanTitle(s).normalize('NFC').toLowerCase();

/**
 * The card a caller means, on this board only: { row }, { choices } when a title fits more than one card, or a throw.
 * A number is a card id. Text is a title, matched exactly ignoring case; text that is only digits and fits no title
 * is tried as an id. Ids are looked up within the board, so another board's card is "no such card" like any other.
 */
function pickCard(db, boardId, card) {
  const { q } = storeOf(db);
  const byId = (id) => {
    const row = Number.isSafeInteger(id) && id > 0 ? q.byId(boardId, id) : null;
    if (!row) throw new Error('There’s no card with that id on this board. get_board lists its cards.');
    if (row.deleted_at) throw new Error(`That card (${row.title}) was deleted from this board. get_history shows who deleted it.`);
    return { row };
  };
  if (typeof card === 'number') return byId(card);

  const key = titleKey(card);
  const matches = q.page(boardId, null, MAX_CARDS).filter((r) => titleKey(r.title) === key);
  if (matches.length === 1) return { row: matches[0] };
  if (matches.length > 1) {
    return {
      choices: matches.map((r) => ({ id: r.id, title: r.title, lane: laneName(r.lane), position: q.indexOf(r) + 1 })),
    };
  }
  if (/^\d{1,15}$/.test(card.trim())) return byId(Number(card.trim()));
  throw new Error('No card on this board has that title. get_board lists its cards.');
}

/** get_card: one card in full, players included. */
export default {
  name: 'get_card',
  title: 'Get a card on a Next Up board',
  description:
    'Reads one card on a Next Up board in full: title, logo id (null when none), lane, position in the lane (1 = ' +
    'top), go-live date (YYYY-MM-DD, or null), server info (plain text exactly as typed, "" when not set), the ' +
    'players signed up in sign-up order, and when the card was created and last edited (signing players up doesn’t ' +
    'count as an edit). `card` is the card’s id from get_board, or its exact title (case doesn’t matter). If a title ' +
    'fits more than one card, the answer is {"status":"ambiguous","choices":[…]}: ask again with one of their ids. ' +
    LOCKED_NOTE,
  input: {
    code: codeInput,
    card: z
      .union([z.number().int(), z.string().min(1).max(200)])
      .describe('The card’s id (from get_board), or its exact title, case-insensitive.'),
  },
  resolve({ code, card }, { db }) {
    const found = findBoard(db, code);
    if (found.locked) return LOCKED;
    const picked = pickCard(db, found.board.id, card);
    if (picked.choices) return { status: 'ambiguous', choices: picked.choices };

    const row = picked.row;
    const players = playerQueries(() => db).page(row.id, null, MAX_PLAYERS).map(playerBody);
    return {
      status: 'open',
      card: {
        id: row.id,
        title: row.title,
        logo: row.logo,
        lane: laneName(row.lane),
        position: storeOf(db).q.indexOf(row) + 1,
        goLive: row.go_live,
        serverInfo: row.server_info,
        players: players.map((p) => ({ name: p.name, signedUpAt: p.addedAt })),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  },
};
