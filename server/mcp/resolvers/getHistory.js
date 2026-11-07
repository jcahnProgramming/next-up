import { z } from 'zod';
import { listEvents } from '../../core/events.js';
import { describeEvents } from '../../history/routes.js';
import { LOCKED, LOCKED_NOTE, codeInput, findBoard } from './board.js';

export const HISTORY_DEFAULT = 20;
export const HISTORY_MAX = 100;
// The cursor listEvents hands out as `next`: "<created_at>~<event id>" (the same check as the History route's).
const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~\d{1,15}$/;

// History's sentence, worded exactly as the History panel shows it (client/src/history/HistoryPanel.jsx).
const sentence = (e) => `${e.actor} ${e.line.verb}${e.line.subject ? ` ${e.line.subject}` : ''}${e.line.detail}`;
const who = (x) => (x ? { actor: x.actor, at: x.at } : null);

/**
 * get_history: a page of a board's change log, newest first. Each change is what the History panel shows of it
 * (describeEvents, the History route's own): the declared line, who and when, and the restore links. Never the
 * stored payload.
 */
export default {
  name: 'get_history',
  title: 'Get a Next Up board’s history',
  description:
    'Reads the change log of a Next Up board, newest first: each change as the History panel words it ("Bunzato ' +
    'moved Dune · Up Next → Now Playing"), with who made it (a display name anyone can type, not a verified ' +
    'identity), when, the card it was about, and whether it was later restored or itself undid an earlier change. ' +
    `${HISTORY_DEFAULT} changes by default, at most ${HISTORY_MAX}. When \`next\` isn’t null, pass it as \`before\` ` +
    `to read further back. ${LOCKED_NOTE}`,
  input: {
    code: codeInput,
    limit: z.number().int().min(1).max(HISTORY_MAX).optional().describe(`How many changes (default ${HISTORY_DEFAULT}, at most ${HISTORY_MAX}).`),
    before: z.string().max(64).optional().describe('The `next` value from the previous answer, to read older changes.'),
  },
  resolve({ code, limit = HISTORY_DEFAULT, before }, { db }) {
    const found = findBoard(db, code);
    if (found.locked) return LOCKED;
    if (before !== undefined && !CURSOR.test(before)) throw new Error('That `before` isn’t a cursor from get_history. Leave it out to start from the newest change.');
    const boardId = found.board.id;
    const page = listEvents(db, boardId, { limit, before: before ?? null });
    return {
      status: 'open',
      changes: describeEvents(db, boardId, page.events).map((e) => ({
        id: e.id,
        at: e.at,
        actor: e.actor,
        text: sentence(e),
        cardId: e.cardId,
        restoredBy: who(e.restoredBy),
        undoes: who(e.restores),
      })),
      next: page.next,
    };
  },
};
