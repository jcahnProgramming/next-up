import getBoard from './getBoard.js';
import getCard from './getCard.js';
import getHistory from './getHistory.js';
import version from './version.js';

/**
 * Every MCP tool, declared as a resolver. To add a tool, write a file next to this one and add it to the list;
 * never edit the MCP layer (mcp/server.js, mcp/app.js) to do it.
 *
 * A resolver is { name, title, description, input, resolve(args, ctx) }:
 *   name         snake_case, stable forever: a rename breaks every connected client
 *   input        a zod raw shape ({ code: z.string() }), {} for none
 *   resolve      returns plain JSON-able data (it is sent as JSON text). Throw an Error whose message is safe to
 *                show to the AI for an expected failure (not found, bad input).
 *   ctx.db       the shared SQLite connection, opened query_only: SQLite itself refuses writes.
 *
 * Read-only, always: every tool is registered with readOnlyHint, and nothing here may change data. No tool may
 * return a board password (or its hash) or anything else that grants editing.
 *
 * Boards are read by the code the caller gives (resolvers/board.js): no tool lists, searches or enumerates boards or
 * codes, and a board with a password answers only { status: 'locked' }.
 */
export const resolvers = [version, getBoard, getCard, getHistory];
