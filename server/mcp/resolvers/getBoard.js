import { LANES, MAX_CARDS } from '../../core/cardRules.js';
import { storeOf } from '../../cards/events.js';
import { LOCKED, LOCKED_NOTE, codeInput, deletionOf, findBoard } from './board.js';

/**
 * The cards of a board, lane by lane in board order. A board never holds more than MAX_CARDS live cards, and the
 * page asks for one more so a board that somehow did would say so rather than quietly dropping cards.
 */
export function lanesOf(db, boardId) {
  const rows = storeOf(db).q.page(boardId, null, MAX_CARDS + 1);
  const lanes = LANES.map((l) => ({ id: l.id, name: l.name, cards: [] }));
  for (const row of rows.slice(0, MAX_CARDS)) {
    const lane = lanes.find((l) => l.id === row.lane);
    lane?.cards.push({
      id: row.id,
      title: row.title,
      logo: row.logo,
      goLive: row.go_live,
      playerCount: row.player_count,
      position: lane.cards.length + 1,
    });
  }
  return { lanes, truncated: rows.length > MAX_CARDS };
}

/** get_board: a board's lanes and cards, by its code. */
export default {
  name: 'get_board',
  title: 'Get a Next Up board',
  description:
    'Reads one Next Up board by its code: the three lanes in order (Up Next, Now Playing, Played), and in each its ' +
    'cards top to bottom with id, title, logo id (null when none), go-live date (YYYY-MM-DD, or null), player ' +
    'count and position (1 = top). An empty lane has an empty cards list. `deletion` is null, or when the board was ' +
    'deleted and when it will be erased unless someone restores it. You must already know the code: boards can’t be ' +
    `listed or searched. ${LOCKED_NOTE}`,
  input: { code: codeInput },
  resolve({ code }, { db }) {
    const found = findBoard(db, code);
    if (found.locked) return LOCKED;
    const { board } = found;
    const { lanes, truncated } = lanesOf(db, board.id);
    return {
      status: 'open',
      code: board.code,
      createdAt: board.createdAt,
      deletion: deletionOf(board),
      lanes,
      ...(truncated ? { note: `Only the first ${MAX_CARDS} cards are shown.` } : {}),
    };
  },
};
