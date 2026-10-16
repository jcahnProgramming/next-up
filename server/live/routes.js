import { appendContext } from '../core/events.js';

/**
 * GET /api/boards/:code/live?since=<event id>&tab=<tab id>: the board's live stream (live/hub.js). Registered by
 * boards/routes.js AFTER requireAccess, like every board route: a password board without access answers only
 * { status: 'locked', code } (403), and the stream is never opened.
 *
 *   since   the last event id this browser has applied (the board's cards answer carries `head` for a fresh load).
 *           Missing: from now. Also read from Last-Event-ID, as EventSource sends it.
 *   tab     this browser tab's random id (also sent as X-NU-Tab on its changes), so its own changes are marked `own`
 *
 * Too many streams from this network, to this board, or in all: 429 { code: 'too_many_streams', retryAfter }.
 */
export function liveStream({ hub, networkOf }) {
  return (req, res) => {
    const since = sinceOf(req.query.since ?? req.headers['last-event-id']);
    if (since === false) return res.status(400).json({ error: 'Reload the board and try again.', field: 'since' });
    const network = networkOf(req);
    const opened = hub.open({ req, res, board: req.board, network, tab: tabOf(req.query.tab), since });
    if (!opened) {
      res.set('Retry-After', '30');
      return res.status(429).json({
        error: 'Too many live connections right now. Next Up will keep trying.',
        code: 'too_many_streams',
        retryAfter: 30,
      });
    }
    return undefined;
  };
}

/**
 * Every write to a board (anything but GET) runs inside the hub's recorder for the tab that sent it, and once its
 * answer has gone, the board's streams are told to send what's new. Mount it after the board is resolved.
 */
export function liveWrites({ hub }) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const boardId = req.board.id;
    res.on('finish', () => hub.notify(boardId));
    const record = hub.recorder(tabOf(req.headers['x-nu-tab']));
    return record ? appendContext.run(record, next) : next();
  };
}

/** A tab id: 8–40 letters, digits, - or _. Anything else counts as none. */
export function tabOf(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(raw) ? raw : null;
}

function sinceOf(raw) {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 && String(n) === String(raw) ? n : false;
}
