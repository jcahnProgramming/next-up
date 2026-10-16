import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LIVE_LIMITS } from '../live/hub.js';
import { startApp } from './helpers.js';
import { openStream } from './stream.js';

const PW = 'raid night 8pm';
const TAB_A = 'tab-aaaaaaaa';
const TAB_B = 'tab-bbbbbbbb';

async function makeBoard(app, code, password) {
  const made = await app.request('/api/boards', { method: 'POST', body: { code, password, actor: 'Path' } });
  assert.equal(made.status, 201);
  return made.cookie;
}

const call = (app, code, path, { tab = TAB_B, ...opts } = {}) =>
  app.request(`/api/boards/${code}${path}`, { ...opts, headers: { ...(tab ? { 'x-nu-tab': tab } : {}) } });

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('live sync stream', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('is an unbuffered, uncompressed event stream that starts live from the head the cards answer gave', async () => {
    await makeBoard(app, 'live-one');
    const { body } = await call(app, 'live-one', '/cards');
    const s = await openStream(app, 'live-one', { since: body.head });
    assert.equal(s.status, 200);
    assert.match(s.res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(s.res.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(s.res.headers.get('x-accel-buffering'), 'no');
    assert.equal(s.res.headers.get('content-encoding'), null);
    // ready carries the board as it is now, so a page that connects late still learns it's being deleted.
    const board = { code: 'live-one', hasPassword: false, createdAt: (await app.request('/api/boards/live-one')).body.board.createdAt };
    assert.deepEqual(await s.event(), { id: undefined, event: 'ready', data: { head: body.head, board } });
    s.close();
  });

  test('another tab’s change arrives with its id, History entry, and the card as it is now', async () => {
    await makeBoard(app, 'live-two');
    const head = (await call(app, 'live-two', '/cards')).body.head;
    const s = await openStream(app, 'live-two', { since: head, tab: TAB_A });
    assert.equal((await s.event()).event, 'ready');

    const t0 = performance.now();
    const made = await call(app, 'live-two', '/cards', { method: 'POST', body: { title: 'Valheim', lane: 'up_next', actor: 'Bunzato' } });
    const f = await s.event();
    const ms = performance.now() - t0;
    assert.equal(f.event, 'change');
    assert.equal(f.id, head + 1);
    assert.equal(f.data.own, false);
    assert.equal(f.data.entry.id, f.id);
    assert.equal(f.data.entry.type, 'card.created');
    assert.equal(f.data.entry.actor, 'Bunzato');
    assert.deepEqual(f.data.entry.line, { verb: 'added', subject: 'Valheim', detail: ' to Up Next' });
    assert.deepEqual(f.data.card, { ...made.body.card, deleted: false });
    assert.deepEqual(f.data.lane, { id: 'up_next', cards: [[made.body.card.id, made.body.card.position]] });
    assert.equal(f.data.player, null);
    assert.ok(ms < 500, `arrived in ${ms.toFixed(1)} ms`);
    s.close();
  });

  test('a tab’s own change is marked own on its stream and not on anyone else’s', async () => {
    await makeBoard(app, 'live-own');
    const head = (await call(app, 'live-own', '/cards')).body.head;
    const mine = await openStream(app, 'live-own', { since: head, tab: TAB_A });
    const theirs = await openStream(app, 'live-own', { since: head, tab: TAB_B });
    await mine.event();
    await theirs.event();
    await call(app, 'live-own', '/cards', { tab: TAB_A, method: 'POST', body: { title: 'Enshrouded', lane: 'played' } });
    const [a, b] = [await mine.event(), await theirs.event()];
    assert.equal(a.id, b.id);
    assert.equal(a.data.own, true);
    assert.equal(b.data.own, false);
    mine.close();
    theirs.close();
  });

  test('catch-up: reconnecting from the last id replays exactly the changes missed, once each, in order', async () => {
    await makeBoard(app, 'live-gap');
    const added = (await call(app, 'live-gap', '/cards', { method: 'POST', body: { title: 'Soulmask', lane: 'up_next' } })).body.card;
    const head = (await call(app, 'live-gap', '/cards')).body.head;
    const first = await openStream(app, 'live-gap', { since: head });
    assert.equal((await first.event()).event, 'ready');
    first.close(); // the laptop sleeps

    // Five changes elsewhere: a sign-up, a rename, a move, a removal, a delete.
    const p = (await call(app, 'live-gap', `/cards/${added.id}/players`, { method: 'POST', body: { name: 'Mo', actor: 'Kaelis' } })).body.player;
    const renamed = (await call(app, 'live-gap', `/cards/${added.id}`, { method: 'PATCH', body: { title: 'Soulmask EA', version: added.version } })).body.card;
    await call(app, 'live-gap', `/cards/${added.id}/move`, { method: 'POST', body: { lane: 'now_playing', index: 0 } });
    await call(app, 'live-gap', `/cards/${added.id}/players/${p.id}`, { method: 'DELETE', body: {} });
    await call(app, 'live-gap', `/cards/${added.id}`, { method: 'DELETE', body: { version: renamed.version + 1 } });

    const again = await openStream(app, 'live-gap', { since: head });
    const got = [];
    for (;;) {
      const f = await again.event();
      if (f.event === 'ready') break;
      got.push(f);
    }
    assert.deepEqual(got.map((f) => f.id), [head + 1, head + 2, head + 3, head + 4, head + 5]);
    assert.deepEqual(got.map((f) => f.data.entry.type), ['player.added', 'card.edited', 'card.moved', 'player.removed', 'card.deleted']);
    // Each carries the card as it is NOW (deleted), so replaying is safe in any order.
    assert.ok(got.every((f) => f.data.card.deleted === true));
    assert.deepEqual(got[0].data.player, { id: p.id, name: 'Mo', addedAt: p.addedAt, removed: true });
    // Nothing more: no duplicates trail the ready.
    await assert.rejects(again.event(300), /no frame/);
    again.close();
  });

  test('further behind than it can replay: a reset with the head, then it carries on live', async () => {
    const small = await startApp({ live: { replayMax: 3 } });
    try {
      await makeBoard(small, 'live-far');
      for (let i = 0; i < 4; i++) await call(small, 'live-far', '/cards', { method: 'POST', body: { title: `Game ${i}`, lane: 'up_next' } });
      const head = (await call(small, 'live-far', '/cards')).body.head;
      const s = await openStream(small, 'live-far', { since: 1 });
      assert.deepEqual(await s.event(), { id: undefined, event: 'reset', data: { head } });
      const ready = await s.event();
      assert.equal(ready.event, 'ready');
      assert.equal(ready.data.head, head);
      await call(small, 'live-far', '/cards', { method: 'POST', body: { title: 'Next', lane: 'played' } });
      assert.equal((await s.event()).id, head + 1);
      s.close();
    } finally {
      await small.close();
    }
  });

  test('a since this board never reached (newer than its head) is a reset, not a silent gap', async () => {
    await makeBoard(app, 'live-ahead');
    const head = (await call(app, 'live-ahead', '/cards')).body.head;
    const s = await openStream(app, 'live-ahead', { since: head + 1000 });
    assert.deepEqual(await s.event(), { id: undefined, event: 'reset', data: { head } });
    s.close();
  });

  test('a refused change (a stale version) sends nothing', async () => {
    await makeBoard(app, 'live-refused');
    const card = (await call(app, 'live-refused', '/cards', { method: 'POST', body: { title: 'V Rising', lane: 'up_next' } })).body.card;
    const head = (await call(app, 'live-refused', '/cards')).body.head;
    const s = await openStream(app, 'live-refused', { since: head });
    await s.event();
    const r = await call(app, 'live-refused', `/cards/${card.id}`, { method: 'PATCH', body: { title: 'X', version: card.version + 5 } });
    assert.equal(r.status, 409);
    await assert.rejects(s.event(300), /no frame/);
    s.close();
  });

  test('a bad since is refused before anything opens', async () => {
    await makeBoard(app, 'live-bad');
    for (const since of ['-1', 'abc', '1.5', '01']) {
      const r = await app.request(`/api/boards/live-bad/live?since=${since}`);
      assert.equal(r.status, 400, since);
    }
    assert.equal(app.live.stats().streams, 0);
  });
});

describe('live sync and access', () => {
  test('a password board without access answers only "locked", and opens no stream', async () => {
    const app = await startApp();
    try {
      await makeBoard(app, 'live-locked', PW);
      const s = await openStream(app, 'live-locked', { since: 0 });
      assert.equal(s.status, 403);
      assert.match(s.res.headers.get('content-type'), /^application\/json/);
      assert.deepEqual(await s.json(), { status: 'locked', code: 'live-locked' });
      assert.equal(liveStats(app).streams, 0);
    } finally {
      await app.close();
    }
  });

  test('a password change while connected ends the stream with "password_changed"', async () => {
    const app = await startApp({ live: { heartbeatMs: 50 } });
    try {
      const cookie = await makeBoard(app, 'live-pw', PW);
      const head = (await app.request('/api/boards/live-pw/cards', { cookie })).body.head;
      const s = await openStream(app, 'live-pw', { since: head, cookie });
      assert.equal(s.status, 200);
      assert.equal((await s.event()).event, 'ready');
      // Simulated: changing the password isn't built yet. This is what it will write (the triggers require the bump).
      app.db.prepare("UPDATE boards SET password_hash = 'x', password_version = password_version + 1 WHERE code = 'live-pw'").run();
      assert.deepEqual(await s.event(), { id: undefined, event: 'locked', data: { status: 'locked', code: 'live-pw', reason: 'password_changed' } });
      assert.equal(await s.event(), null, 'then the stream ends');
      await until(() => liveStats(app).streams === 0);
      // And reconnecting with the old cookie is the same lock screen.
      const again = await openStream(app, 'live-pw', { since: head, cookie });
      assert.equal(again.status, 403);
      assert.deepEqual(await again.json(), { status: 'locked', code: 'live-pw', reason: 'password_changed' });
    } finally {
      await app.close();
    }
  });
});

describe('live sync limits and clean-up', () => {
  test('the limits chosen', () => {
    assert.deepEqual({ ...LIVE_LIMITS }, { perNetwork: 20, perBoard: 100, total: 2000 });
  });

  test('past a limit: 429 too_many_streams with Retry-After; room again once one closes', async () => {
    const app = await startApp({ live: { limits: { perNetwork: 2, perBoard: 3, total: 4 } } });
    try {
      for (const c of ['lim-a', 'lim-b']) await makeBoard(app, c);
      const open = [];
      open.push(await openStream(app, 'lim-a', { ip: '203.0.113.1' }), await openStream(app, 'lim-a', { ip: '203.0.113.1' }));
      const third = await openStream(app, 'lim-a', { ip: '203.0.113.1' });
      assert.equal(third.status, 429);
      assert.equal(third.res.headers.get('retry-after'), '30');
      assert.equal((await third.json()).code, 'too_many_streams');

      open.push(await openStream(app, 'lim-a', { ip: '203.0.113.2' }));
      const boardFull = await openStream(app, 'lim-a', { ip: '203.0.113.3' });
      assert.equal(boardFull.status, 429, 'four on one board is past perBoard 3');
      open.push(await openStream(app, 'lim-b', { ip: '203.0.113.3' }));
      const allFull = await openStream(app, 'lim-b', { ip: '203.0.113.4' });
      assert.equal(allFull.status, 429, 'a fifth anywhere is past total 4');
      assert.equal(liveStats(app).streams, 4);

      open[0].close();
      await until(() => liveStats(app).streams === 3);
      const room = await openStream(app, 'lim-a', { ip: '203.0.113.1' });
      assert.equal(room.status, 200);
      room.close();
      for (const s of open) s.close();
      await until(() => liveStats(app).streams === 0);
      assert.deepEqual(liveStats(app), { streams: 0, boards: 0, networks: 0, origins: 0, timer: false });
    } finally {
      await app.close();
    }
  });

  test('heartbeats keep an idle stream talking, and stop when nobody is connected', async () => {
    const app = await startApp({ live: { heartbeatMs: 40 } });
    try {
      await makeBoard(app, 'live-hb');
      const s = await openStream(app, 'live-hb');
      assert.deepEqual(await s.next(), { comment: 'open' });
      assert.equal((await s.next()).event, 'ready');
      assert.deepEqual(await s.next(500), { comment: 'hb' });
      assert.deepEqual(await s.next(500), { comment: 'hb' });
      assert.equal(liveStats(app).timer, true);
      s.close();
      await until(() => liveStats(app).streams === 0);
      assert.equal(liveStats(app).timer, false);
    } finally {
      await app.close();
    }
  });

  test('200 streams opened and closed leave nothing behind', async () => {
    const app = await startApp();
    try {
      const codes = ['many-a', 'many-b', 'many-c', 'many-d'];
      for (const c of codes) await makeBoard(app, c);
      const streams = [];
      for (let i = 0; i < 200; i++) {
        const s = await openStream(app, codes[i % 4], { ip: `198.51.100.${(i % 20) + 1}`, tab: `tab-${String(i).padStart(8, '0')}` });
        assert.equal(s.status, 200, `stream ${i}`);
        streams.push(s);
      }
      await Promise.all(streams.map((s) => s.event()));
      assert.deepEqual(liveStats(app), { streams: 200, boards: 4, networks: 20, origins: 0, timer: true });
      // A change reaches all 50 viewers of its board.
      await call(app, 'many-a', '/cards', { method: 'POST', body: { title: 'Palworld', lane: 'up_next' } });
      const viewers = streams.filter((_, i) => i % 4 === 0);
      const got = await Promise.all(viewers.map((s) => s.event()));
      assert.ok(got.every((f) => f.event === 'change' && f.data.card.title === 'Palworld'));
      for (const s of streams) s.close();
      await until(() => liveStats(app).streams === 0);
      // The one origin is the Palworld write's tab, kept so a reconnecting tab still knows it (capped at 5,000).
      assert.deepEqual(liveStats(app), { streams: 0, boards: 0, networks: 0, origins: 1, timer: false });
    } finally {
      await app.close();
    }
  });
});

// The hub of the app startApp built (createApp puts it on app.locals.live).
function liveStats(app) {
  return app.live.stats();
}
