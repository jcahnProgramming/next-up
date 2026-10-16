/**
 * A board's live stream (server/live/hub.js), as plain JS so node:test runs it as it ships. No React here; the board
 * uses it through useLive.js.
 *
 *   const live = connectLive({ code, since, onStatus, onChange, onReset, onLocked });
 *   live.retry()   try again now (the Retry button, coming back online, waking from sleep)
 *   live.close()   stop for good (leaving the board)
 *
 * It reads the stream with fetch rather than EventSource: EventSource can't tell "locked" (403) or "too many
 * connections" (429) from a dropped line, and can't send this tab's id as a header.
 *
 * Status, through onStatus({ status, why, since }):
 *   connecting    the first connection, not caught up yet
 *   live          caught up (the server said ready) and hearing from it: a byte at least every STALE_MS
 *   reconnecting  dropped; trying again with backoff (why: 'busy' when the server refused for too many connections)
 *   offline       the browser says it's offline
 *   down          the browser says it's online but Next Up hasn't answered for DOWN_AFTER_MS
 * `since` is when the board was last known current (the moment it stopped being live), for "as of 14:32".
 * Anything but live means "Editing paused until we reconnect." It is never live while nothing is arriving: the
 * server sends a heartbeat every 25 s, and STALE_MS of silence counts as dropped.
 *
 * Changes arrive in id order through onChange(data, id), each once: an id at or below the last one applied is
 * skipped (a replay overlapping what came before), and the next connection resumes after the last id applied. A
 * reset (too far behind to replay) calls onReset() to reload the board, and the stream carries on from the head.
 */
export const STALE_MS = 60_000;
export const DOWN_AFTER_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_S = [1, 2, 4, 8, 15, 30];

export function connectLive({
  code,
  since,
  tab,
  onStatus,
  onChange,
  onReset,
  onLocked,
  fetchImpl = (...a) => fetch(...a),
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
}) {
  let lastId = since;
  let attempt = 0;
  let closed = false;
  let ctl = null; // the current connection's AbortController
  let wait = null; // the backoff timer
  let stale = null; // the silence watchdog
  let everLive = false;
  let failingSince = null; // when the current run of failures began
  let lastLive = now(); // when the board was last known current
  let state = { status: 'connecting', why: null, since: null };
  let lastByte = now();

  const set = (status, why = null) => {
    const next = { status, why, since: status === 'live' || status === 'connecting' ? null : lastLive };
    if (next.status === state.status && next.why === state.why && next.since === state.since) return;
    state = next;
    onStatus?.(state);
  };

  const heard = () => {
    lastByte = now();
    clearTimer(stale);
    stale = setTimer(() => drop(), state.status === 'live' ? STALE_MS : CONNECT_TIMEOUT_MS);
  };

  function connect() {
    if (closed) return;
    clearTimer(wait);
    wait = null;
    if (!isOnline()) return failed(null, 'offline');
    const mine = new AbortController();
    ctl = mine;
    if (!everLive) set('connecting');
    heard();
    const q = new URLSearchParams({ since: String(lastId) });
    if (tab) q.set('tab', tab);
    fetchImpl(`/api/boards/${code}/live?${q}`, { credentials: 'same-origin', cache: 'no-store', signal: mine.signal })
      .then(async (res) => {
        if (mine !== ctl) return;
        const type = res.headers.get('content-type') ?? '';
        if (!type.startsWith('text/event-stream')) {
          const data = await res.json().catch(() => null);
          if (mine !== ctl) return;
          if (data?.status === 'locked') return lock(data.reason === 'password_changed');
          return failed(res.status === 429 ? 'busy' : null, null, res.status === 429 ? Number(data?.retryAfter) || 30 : 0);
        }
        await read(res.body, mine);
        if (mine === ctl && !closed) failed(); // the server ended it (a restart, a deploy)
      })
      .catch(() => {
        if (mine === ctl && !closed) failed();
      });
  }

  async function read(body, mine) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser((frame) => {
      if (mine !== ctl) return;
      handle(frame);
    });
    for (;;) {
      const { value, done } = await reader.read();
      if (done || mine !== ctl) return;
      heard();
      parse(decoder.decode(value, { stream: true }));
    }
  }

  function handle({ event, data, id }) {
    if (event === 'change') {
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= lastId) return;
      try {
        onChange?.(JSON.parse(data), n);
      } catch (err) {
        // A change the page couldn't apply: reload the board rather than drift from it.
        console.error('Next Up: a live change could not be applied; reloading the board', err);
        onReset?.();
      }
      lastId = n;
    } else if (event === 'ready') {
      everLive = true;
      attempt = 0;
      failingSince = null;
      set('live');
      heard();
    } else if (event === 'reset') {
      lastId = JSON.parse(data).head;
      onReset?.();
    } else if (event === 'locked') {
      lock(JSON.parse(data).reason === 'password_changed');
    }
  }

  function lock(changed) {
    stop();
    onLocked?.(changed);
  }

  // The line went quiet or dropped: abort it and try again.
  function drop() {
    if (closed) return;
    ctl?.abort();
    ctl = null;
    failed();
  }

  function failed(why = null, status = null, retryAfterS = 0) {
    if (closed) return;
    ctl?.abort();
    ctl = null;
    clearTimer(stale);
    if (state.status === 'live') lastLive = now();
    failingSince ??= now();
    const offline = status === 'offline' || !isOnline();
    if (offline) set('offline');
    else if (now() - failingSince >= DOWN_AFTER_MS && why !== 'busy') set('down');
    else set('reconnecting', why);
    if (offline) return; // coming back online calls retry()
    const base = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)];
    attempt++;
    const jitter = 0.8 + Math.random() * 0.4;
    wait = setTimer(connect, Math.max(base * jitter, retryAfterS) * 1000);
  }

  function stop() {
    closed = true;
    ctl?.abort();
    ctl = null;
    clearTimer(wait);
    clearTimer(stale);
  }

  connect();

  return {
    retry() {
      if (closed) return;
      attempt = 0;
      ctl?.abort();
      ctl = null;
      connect();
    },
    /** After sleep or a network change: reconnect now if the line has been quiet longer than a heartbeat allows. */
    check() {
      if (closed) return;
      if (state.status !== 'live' || now() - lastByte > 35_000) this.retry();
    },
    close: stop,
    get lastId() {
      return lastId;
    },
  };
}

/**
 * Server-Sent Events framing: feed it text as it arrives; it calls onFrame({ event, data, id }) per message.
 * Comments (heartbeats) and unknown fields are skipped. Handles messages split across chunks, and \r\n.
 */
export function createSseParser(onFrame) {
  let buf = '';
  return (text) => {
    buf += text.replace(/\r\n?/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let id;
      const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const at = line.indexOf(':');
        const field = at === -1 ? line : line.slice(0, at);
        const value = at === -1 ? '' : line.slice(at + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
      if (data.length) onFrame({ event, data: data.join('\n'), id });
    }
  };
}
