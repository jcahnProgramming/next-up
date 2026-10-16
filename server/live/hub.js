import { describeEvents } from '../history/routes.js';
import { eventsAfter, latestEventId } from '../core/events.js';
import { cardBody, cardStore } from '../cards/store.js';
import { playerBody, playerQueries } from '../players/store.js';

/**
 * Live sync: every open board's new changes, pushed to everyone viewing it, over Server-Sent Events.
 *
 * It rides on the change log rather than a channel of its own: a stream sends a board's `events` rows in id order,
 * each with its id, so a browser that drops resumes from the last id it saw and misses nothing. What a stream sends:
 *
 *   id: <event id>  event: change  data: { entry, card, lane, player, own }
 *       entry   the change as History lists it (history/routes.js describeEvents), so an open History panel adds it
 *       card    the card it's about as it is NOW (cardBody, plus `deleted`), or null; applying it twice is harmless
 *       lane    { id, cards: [[id, position], …] } that card's lane as it is now, so a rebalanced lane re-sorts
 *       player  the player it's about as they are now (playerBody, plus `removed`), or null
 *       own     true when this browser tab made the change (it already shows it: no flash, no "changed by")
 *   event: ready    { head }  caught up; from here on it's live
 *   event: reset    { head }  too far behind to replay (more than REPLAY_MAX changes): reload the board, then carry on
 *   event: locked   { status: 'locked', code, reason: 'password_changed' }  the password changed; the stream ends
 *   ": hb"          a heartbeat comment every HEARTBEAT_MS, well inside Cloudflare's ~100 s idle cut-off
 *
 * Nothing here knows one event type from another. Which changes were a tab's own is learned as they're written
 * (core/events.js appendContext), not from the payload: the events table holds no tab ids.
 *
 * Streams are counted per network and per board, and in all; past a limit the route answers 429 and the browser
 * backs off. A board with nobody viewing holds nothing: its entry goes with its last stream, and the heartbeat timer
 * runs only while some stream is open. Every way a stream ends (the browser leaving, a write failing, a slow reader,
 * close()) goes through drop().
 */
export const HEARTBEAT_MS = 25_000;
export const REPLAY_MAX = 200;
export const LIVE_LIMITS = Object.freeze({ perNetwork: 20, perBoard: 100, total: 2000 });
// A reader this far behind (bytes queued and unsent) is cut off; it reconnects and catches up from its last id.
const MAX_BUFFERED = 1024 * 1024;
const MAX_ORIGINS = 5000;

export function createLiveHub({ db, heartbeatMs = HEARTBEAT_MS, limits = LIVE_LIMITS, replayMax = REPLAY_MAX }) {
  const boards = new Map(); // boardId → { id, code, streams: Set }
  const networks = new Map(); // network → open streams
  const origins = new Map(); // eventId → { tab, row }: which tab wrote it, the newest MAX_ORIGINS
  let total = 0;
  let timer = null;

  const stores = () => ({ cards: cardStore(db), players: playerQueries(db) });

  /** Whether one more stream fits: null, or which limit it hits. */
  function refusal(network, boardId) {
    if (total >= limits.total) return 'total';
    if ((networks.get(network) ?? 0) >= limits.perNetwork) return 'network';
    if ((boards.get(boardId)?.streams.size ?? 0) >= limits.perBoard) return 'board';
    return null;
  }

  /**
   * Opens a stream for `board` (its row; access already checked) on `res`, catching up from `since` (the last event
   * id the browser has; null: from now). Returns false, writing nothing, if a limit is hit.
   */
  function open({ req, res, board, network, tab, since }) {
    if (refusal(network, board.id)) return false;
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: nothing between here and the browser (Cloudflare) may compress or rewrite it; compression
      // holds events back until a block fills.
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, heartbeatMs);

    const s = { res, network, tab, boardId: board.id, code: board.code, version: board.password_version, lastId: 0, open: true };
    let ch = boards.get(board.id);
    if (!ch) boards.set(board.id, (ch = { id: board.id, code: board.code, streams: new Set() }));
    ch.streams.add(s);
    networks.set(network, (networks.get(network) ?? 0) + 1);
    total++;
    timer ??= setInterval(beat, heartbeatMs);
    timer.unref?.();
    res.on('close', () => drop(s));
    res.on('error', () => drop(s));

    write(s, ': open\n\n');
    const head = latestEventId(db(), board.id);
    if (since === null || since > head) {
      // From now (or an id this board never reached, e.g. a browser that saw a board since purged): nothing to
      // replay that the browser could place, so start at the head; a stale id gets a reset.
      s.lastId = head;
      if (since !== null) write(s, frame('reset', { head }));
    } else {
      s.lastId = since;
      catchUp(ch, [s], since);
    }
    if (s.open) write(s, frame('ready', { head: s.lastId }));
    return true;
  }

  function drop(s) {
    if (!s.open) return;
    s.open = false;
    const ch = boards.get(s.boardId);
    if (ch) {
      ch.streams.delete(s);
      if (ch.streams.size === 0) boards.delete(s.boardId);
    }
    const n = (networks.get(s.network) ?? 1) - 1;
    if (n > 0) networks.set(s.network, n);
    else networks.delete(s.network);
    total--;
    if (total === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!s.res.writableEnded) s.res.end();
  }

  function write(s, text) {
    if (!s.open) return;
    try {
      s.res.write(text);
    } catch {
      return drop(s);
    }
    if (s.res.writableLength > MAX_BUFFERED) drop(s);
  }

  /** Sends `streams` everything after `from` they haven't had, or a reset if that's more than replayMax. */
  function catchUp(ch, streams, from) {
    const events = eventsAfter(db(), ch.id, from, replayMax + 1);
    if (events.length > replayMax) {
      const head = latestEventId(db(), ch.id);
      for (const s of streams) {
        s.lastId = head;
        write(s, frame('reset', { head }));
      }
      return;
    }
    if (events.length === 0) return;
    const messages = build(ch.id, events);
    for (const s of streams) {
      for (const m of messages) {
        if (m.id <= s.lastId) continue;
        write(s, m.own && m.tab === s.tab ? m.mine : m.theirs);
        s.lastId = m.id;
      }
    }
  }

  // One message per event, built once for every stream on the board.
  function build(boardId, events) {
    const { cards, players } = stores();
    const entries = describeEvents(db(), boardId, events);
    const lanes = new Map();
    const laneOf = (lane) => {
      if (!lanes.has(lane)) lanes.set(lane, cards.q.laneRows(boardId, lane).map((r) => [r.id, r.position]));
      return lanes.get(lane);
    };
    return events.map((e, i) => {
      const row = Number.isSafeInteger(e.cardId) ? cards.q.byId(boardId, e.cardId) : null;
      const card = row ? { ...cardBody(row), deleted: row.deleted_at !== null } : null;
      const pid = e.payload.playerId;
      const prow = row && Number.isSafeInteger(pid) ? players.byId(row.id, pid) : null;
      const data = {
        entry: entries[i],
        card,
        lane: card && !card.deleted ? { id: card.lane, cards: laneOf(card.lane) } : null,
        player: prow ? { ...playerBody(prow), removed: prow.deleted_at !== null } : null,
      };
      // Kept (up to MAX_ORIGINS) after sending: a tab that reconnects and replays its own change still knows it.
      const origin = origins.get(e.id);
      // The reported row must be the one stored: an id reported by a transaction that rolled back is reused.
      const own = Boolean(origin && origin.row.type === e.type && origin.row.actor === e.actor && origin.row.payload === e.raw);
      const theirs = frame('change', { ...data, own: false }, e.id);
      return { id: e.id, own, tab: origin?.tab ?? null, theirs, mine: own ? frame('change', { ...data, own: true }, e.id) : theirs };
    });
  }

  /** The board may have changed (a write finished): check its password and send its streams what's new. */
  function notify(boardId) {
    const ch = boards.get(boardId);
    if (!ch || !checkPassword(ch)) return;
    let from = Infinity;
    for (const s of ch.streams) from = Math.min(from, s.lastId);
    if (from === Infinity) return;
    catchUp(ch, [...ch.streams], from);
  }

  // A stream carries the password version its access was granted at. A change ends it with "password_changed",
  // so the page shows that lock screen; a board gone altogether (purged) just ends. True when the streams go on.
  function checkPassword(ch) {
    const row = db().prepare('SELECT password_version FROM boards WHERE id = ? LIMIT 1').get(ch.id);
    let ok = true;
    for (const s of [...ch.streams]) {
      if (row && row.password_version === s.version) continue;
      ok = false;
      if (row) write(s, frame('locked', { status: 'locked', code: s.code, reason: 'password_changed' }));
      drop(s);
    }
    return ok;
  }

  function beat() {
    for (const ch of [...boards.values()]) {
      if (!checkPassword(ch)) continue;
      for (const s of [...ch.streams]) write(s, ': hb\n\n');
    }
  }

  return {
    open,
    notify,
    refusal,
    /** The appendContext callback for one request from browser tab `tab`: notes which events that tab wrote. */
    recorder(tab) {
      if (!tab) return null;
      return (id, row) => {
        origins.set(id, { tab, row });
        if (origins.size > MAX_ORIGINS) origins.delete(origins.keys().next().value);
      };
    },
    /** Open streams, boards with viewers, networks with streams, remembered origins: for tests and the memory check. */
    stats: () => ({ streams: total, boards: boards.size, networks: networks.size, origins: origins.size, timer: timer !== null }),
    /** Ends every stream (shutdown). */
    close() {
      for (const ch of [...boards.values()]) for (const s of [...ch.streams]) drop(s);
    },
  };
}

function frame(event, data, id) {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
