import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONNECT_TIMEOUT_MS, DOWN_AFTER_MS, STALE_MS, connectLive, createSseParser } from '../../client/src/live/connection.js';

// The client's live connection (client/src/live/connection.js), plain JS, run as it ships against a fake fetch and a
// clock the test moves.

describe('SSE framing', () => {
  test('frames split across chunks, \\r\\n, comments and multi-line data', () => {
    const got = [];
    const feed = createSseParser((f) => got.push(f));
    feed(': open\n\nid: 7\nevent: chan');
    feed('ge\r\ndata: {"a":1}\r\n\r\n: hb\n\nevent: ready\ndata: line one\ndata: line two\n\n');
    assert.deepEqual(got, [
      { event: 'change', data: '{"a":1}', id: '7' },
      { event: 'ready', data: 'line one\nline two', id: undefined },
    ]);
  });
});

/** A fake server: each fetch is a connection the test drives (send frames, end it, or answer with JSON). */
function harness({ online = true } = {}) {
  const clock = { t: 1_000_000 };
  const timers = [];
  const conns = [];
  const statuses = [];
  const changes = [];
  const env = {
    online,
    resets: 0,
    locked: null,
    statuses,
    changes,
    conns,
    now: () => clock.t,
    /** Moves the clock, firing timers that fall due (and any they set). */
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers.find((t) => !t.done && t.at <= end);
        if (!next) break;
        clock.t = next.at;
        next.done = true;
        next.fn();
        await flush();
      }
      clock.t = end;
    },
    last: () => conns[conns.length - 1],
    status: () => statuses[statuses.length - 1]?.status,
  };
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      let push;
      let close;
      const body = new ReadableStream({
        start(c) {
          push = (text) => c.enqueue(new TextEncoder().encode(text));
          close = () => c.close();
        },
      });
      const conn = {
        url,
        aborted: false,
        open() {
          resolve({ status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body });
        },
        json(status, data) {
          resolve({ status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data });
        },
        fail() {
          reject(new TypeError('network'));
        },
        send: (text) => push(text),
        change: (id, data = {}) => push(`id: ${id}\nevent: change\ndata: ${JSON.stringify(data)}\n\n`),
        ready: (head) => push(`event: ready\ndata: ${JSON.stringify({ head })}\n\n`),
        end: () => close(),
      };
      signal.addEventListener('abort', () => {
        conn.aborted = true;
        try {
          close();
        } catch {
          // already closed
        }
        reject(new DOMException('aborted', 'AbortError'));
      });
      conns.push(conn);
    });
  const live = (since = 10) =>
    connectLive({
      code: 'pnc',
      since,
      tab: 'tab-test-1',
      onStatus: (s) => statuses.push(s),
      onChange: (data, id) => changes.push(id),
      onReset: () => env.resets++,
      onLocked: (changed) => (env.locked = changed),
      fetchImpl,
      now: env.now,
      setTimer: (fn, ms) => {
        const t = { fn, at: clock.t + ms, done: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) t.done = true;
      },
      isOnline: () => env.online,
    });
  return { env, live };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('live connection (client/src/live/connection.js)', () => {
  test('connecting, then live only once the server says it has caught up; changes in order, each once', async () => {
    const { env, live } = harness();
    live(10);
    assert.equal(env.status(), undefined, 'starts as connecting (the initial state)');
    assert.match(env.last().url, /^\/api\/boards\/pnc\/live\?since=10&tab=tab-test-1$/);
    env.last().open();
    env.last().send(': open\n\n');
    env.last().change(11);
    env.last().change(12);
    await flush();
    assert.notEqual(env.status(), 'live', 'not live while still catching up');
    env.last().ready(12);
    await flush();
    assert.equal(env.status(), 'live');
    env.last().change(12); // a duplicate
    env.last().change(13);
    await flush();
    assert.deepEqual(env.changes, [11, 12, 13]);
  });

  test('a drop: reconnecting, then resume from the last id applied, with backoff', async () => {
    const { env, live } = harness();
    live(10);
    env.last().open();
    env.last().ready(10);
    env.last().change(11);
    await flush();
    env.last().end(); // a deploy restarts the server
    await flush();
    assert.equal(env.status(), 'reconnecting');
    assert.ok(env.statuses.at(-1).since, 'says how old the board is');
    assert.equal(env.conns.length, 1, 'waits before trying again');
    await env.advance(1300);
    assert.equal(env.conns.length, 2);
    assert.match(env.last().url, /since=11/);
    env.last().fail();
    await flush();
    await env.advance(1000);
    assert.equal(env.conns.length, 2, 'the second wait is longer');
    await env.advance(2000);
    assert.equal(env.conns.length, 3);
    env.last().open();
    env.last().change(12);
    env.last().ready(12);
    await flush();
    assert.equal(env.status(), 'live');
    assert.deepEqual(env.changes, [11, 12]);
  });

  test('silence longer than STALE_MS is a drop: never "live" while nothing arrives', async () => {
    const { env, live } = harness();
    live(5);
    env.last().open();
    env.last().ready(5);
    await flush();
    await env.advance(STALE_MS - 1000);
    env.last().send(': hb\n\n'); // a heartbeat keeps it live
    await flush();
    await env.advance(STALE_MS - 1000);
    assert.equal(env.status(), 'live');
    await env.advance(2000); // then nothing for a whole STALE_MS: a laptop asleep, a dead network
    assert.equal(env.status(), 'reconnecting');
    assert.equal(env.conns[0].aborted, true);
  });

  test('a connection that never catches up times out', async () => {
    const { env, live } = harness();
    live(5);
    env.last().open();
    await flush();
    await env.advance(CONNECT_TIMEOUT_MS + 10);
    assert.equal(env.status(), 'reconnecting');
  });

  test('still failing after DOWN_AFTER_MS while the browser says online: "down"; offline says offline and waits', async () => {
    const { env, live } = harness();
    live(5);
    env.last().fail();
    await flush();
    for (let i = 0; i < 6 && env.status() !== 'down'; i++) {
      await env.advance(DOWN_AFTER_MS / 2);
      env.last().fail();
      await flush();
    }
    assert.equal(env.status(), 'down');

    env.online = false;
    const c = live(5);
    await flush();
    assert.equal(env.status(), 'offline');
    const n = env.conns.length;
    await env.advance(120_000);
    assert.equal(env.conns.length, n, 'no retries while offline');
    env.online = true;
    c.retry(); // the 'online' event
    assert.equal(env.conns.length, n + 1);
  });

  test('429: reconnecting with why "busy", waiting at least Retry-After', async () => {
    const { env, live } = harness();
    live(5);
    env.last().json(429, { code: 'too_many_streams', retryAfter: 30 });
    await flush();
    assert.equal(env.status(), 'reconnecting');
    assert.equal(env.statuses.at(-1).why, 'busy');
    await env.advance(29_000);
    assert.equal(env.conns.length, 1);
    await env.advance(12_000);
    assert.equal(env.conns.length, 2);
  });

  test('locked (403, or the stream saying password_changed) stops for good', async () => {
    const a = harness();
    a.live(5);
    a.env.last().json(403, { status: 'locked', code: 'pnc' });
    await flush();
    assert.equal(a.env.locked, false);
    await a.env.advance(120_000);
    assert.equal(a.env.conns.length, 1);

    const b = harness();
    b.live(5);
    b.env.last().open();
    b.env.last().ready(5);
    b.env.last().send('event: locked\ndata: {"status":"locked","code":"pnc","reason":"password_changed"}\n\n');
    await flush();
    assert.equal(b.env.locked, true);
    await b.env.advance(120_000);
    assert.equal(b.env.conns.length, 1);
  });

  test('a reset reloads the board and carries on from the head it gives', async () => {
    const { env, live } = harness();
    live(5);
    env.last().open();
    env.last().send('event: reset\ndata: {"head":900}\n\n');
    env.last().ready(900);
    env.last().change(900); // already covered by the reload
    env.last().change(901);
    await flush();
    assert.equal(env.resets, 1);
    assert.deepEqual(env.changes, [901]);
  });

  test('retry() reconnects now, from the last id', async () => {
    const { env, live } = harness();
    const c = live(5);
    env.last().fail();
    await flush();
    assert.equal(env.conns.length, 1);
    c.retry();
    assert.equal(env.conns.length, 2);
    assert.match(env.last().url, /since=5/);
  });
});
