import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { RETIRE_MS, SWEEP_MS } from '../boards/retire.js';
import { listEvents } from '../core/events.js';
import { startApp } from './helpers.js';
import { openStream } from './stream.js';

const PW = 'raid night 8pm';
const NEW_PW = 'new raid night 9pm';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

async function makeBoard(app, code, password, ip) {
  const made = await app.request('/api/boards', { method: 'POST', body: { code, password, actor: 'Path' }, ip });
  assert.equal(made.status, 201);
  return made.cookie;
}

const boardRow = (app, code) => app.db.prepare('SELECT * FROM boards WHERE code = ?').get(code) ?? null;
const eventsOf = (app, id) => listEvents(app.db, id, { limit: 100 }).events;
const counts = (app, id) => ({
  boards: app.db.prepare('SELECT COUNT(*) FROM boards WHERE id = ?').pluck().get(id),
  cards: app.db.prepare('SELECT COUNT(*) FROM cards WHERE board_id = ?').pluck().get(id),
  players: app.db.prepare('SELECT COUNT(*) FROM players WHERE board_id = ?').pluck().get(id),
  events: app.db.prepare('SELECT COUNT(*) FROM events WHERE board_id = ?').pluck().get(id),
});

describe('changing a board password', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('wrong current passwords in Settings and on the lock screen share one counter: 10 in all, then too many tries', async () => {
    const ip = '203.0.113.10';
    const cookieA = await makeBoard(app, 'shared-a', PW, ip);
    await makeBoard(app, 'shared-b', PW, '203.0.113.99');
    // 5 wrong on board b's lock screen (no access) …
    for (let i = 0; i < 5; i++) {
      const r = await app.request('/api/boards/shared-b/unlock', { method: 'POST', body: { password: `nope ${i} xx` }, ip });
      assert.equal(r.status, 401, `lock screen try ${i + 1}`);
    }
    // … then 5 wrong current passwords in board a's Settings …
    for (let i = 0; i < 5; i++) {
      const r = await app.request('/api/boards/shared-a/password', {
        method: 'POST', body: { current: `nope ${i} yy`, password: NEW_PW }, cookie: cookieA, ip,
      });
      assert.equal(r.status, 401, `settings try ${i + 1}`);
      assert.equal(r.body.code, 'wrong_password');
      assert.equal(r.body.field, 'current');
    }
    // … and the 11th, in either place, is refused before any check, even with the right password.
    const settings = await app.request('/api/boards/shared-a/password', {
      method: 'POST', body: { current: PW, password: NEW_PW }, cookie: cookieA, ip,
    });
    assert.equal(settings.status, 429);
    assert.equal(settings.body.code, 'too_many_passwords');
    assert.ok(settings.body.retryAfter > 0 && settings.body.retryAfter <= 15 * 60);
    assert.equal(settings.headers.get('retry-after'), String(settings.body.retryAfter));
    const lock = await app.request('/api/boards/shared-b/unlock', { method: 'POST', body: { password: PW }, ip });
    assert.equal(lock.status, 429);
    assert.equal(lock.body.code, 'too_many_passwords');
    // Nothing changed: the password is still the old one.
    assert.equal(boardRow(app, 'shared-a').password_version, 1);
    // The window passes, and it works again.
    app.clock.advance(15 * MIN + 1000);
    const ok = await app.request('/api/boards/shared-a/password', {
      method: 'POST', body: { current: PW, password: NEW_PW }, cookie: cookieA, ip,
    });
    assert.equal(ok.status, 200);
  });

  test('a right current password gives its slot back; the new password follows the creation rules', async () => {
    const ip = '203.0.113.20';
    let cookie = await makeBoard(app, 'rules', PW, ip);
    const post = (body) => app.request('/api/boards/rules/password', { method: 'POST', body, cookie, ip });
    assert.equal((await post({ password: NEW_PW })).body.field, 'current');
    assert.equal((await post({ current: PW, password: 'short' })).body.field, 'password');
    assert.equal((await post({ current: PW, password: 'x'.repeat(129) })).body.field, 'password');
    assert.equal((await post({ current: PW, password: PW })).body.field, 'password');
    assert.equal(app.db.prepare('SELECT password_version FROM boards WHERE code = ?').pluck().get('rules'), 1);
    // Ten right answers in a row never trip the limit.
    let current = PW;
    for (let i = 0; i < 10; i++) {
      const next = `rotation number ${i}`;
      const r = await post({ current, password: next });
      assert.equal(r.status, 200, `change ${i + 1}`);
      current = next;
      cookie = r.cookie; // each change gives this browser a fresh grant
    }
  });

  test('an open board has no password to change, and can never get one', async () => {
    const cookie = await makeBoard(app, 'open-pw');
    const r = await app.request('/api/boards/open-pw/password', { method: 'POST', body: { current: 'anything at all', password: NEW_PW }, cookie });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'no_password');
    assert.equal(boardRow(app, 'open-pw').password_hash, null);
  });

  test('this browser stays in; another browser’s live stream is sent to "password changed" at once', async () => {
    const mine = await makeBoard(app, 'pw-live', PW);
    const theirs = (await app.request('/api/boards/pw-live/unlock', { method: 'POST', body: { password: PW } })).cookie;
    const head = (await app.request('/api/boards/pw-live/cards', { cookie: theirs })).body.head;
    const other = await openStream(app, 'pw-live', { since: head, cookie: theirs, tab: 'tab-other-1' });
    assert.equal((await other.event()).event, 'ready');

    const r = await app.request('/api/boards/pw-live/password', {
      method: 'POST', body: { current: PW, password: NEW_PW, actor: 'Path' }, cookie: mine,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.board.hasPassword, true);
    assert.ok(!r.text.includes(NEW_PW) && !r.text.includes(PW) && !r.text.includes('argon2'));

    // The other browser hears it now, without reloading: the stream says locked and ends.
    const locked = await other.event();
    assert.equal(locked.event, 'locked');
    assert.deepEqual(locked.data, { status: 'locked', code: 'pw-live', reason: 'password_changed' });
    assert.equal(await other.event(), null);
    // And its next request gets the "password changed" lock screen.
    const after = await app.request('/api/boards/pw-live', { cookie: theirs });
    assert.equal(after.status, 403);
    assert.deepEqual(after.body, { status: 'locked', code: 'pw-live', reason: 'password_changed' });

    // This browser was given a fresh grant at the new version and still opens the board and its stream.
    assert.match(r.cookie, /^nu_access=\d+\.2\./);
    assert.equal((await app.request('/api/boards/pw-live', { cookie: r.cookie })).status, 200);
    const again = await openStream(app, 'pw-live', { cookie: r.cookie });
    assert.equal((await again.event()).event, 'ready');
    again.close();
    // The old grant this browser held is stale too: the new cookie is what keeps it in.
    assert.equal((await app.request('/api/boards/pw-live', { cookie: mine })).body.reason, 'password_changed');

    // The new password unlocks; the old one doesn't.
    assert.equal((await app.request('/api/boards/pw-live/unlock', { method: 'POST', body: { password: PW } })).status, 401);
    assert.equal((await app.request('/api/boards/pw-live/unlock', { method: 'POST', body: { password: NEW_PW } })).status, 200);

    // Logged as who and when, with nothing about either password; not restorable.
    const row = boardRow(app, 'pw-live');
    const logged = eventsOf(app, row.id).find((e) => e.type === 'board.password_changed');
    assert.equal(logged.actor, 'Path');
    assert.deepEqual(logged.payload, {});
    assert.equal(logged.restorable, false);
    const raw = app.db.prepare("SELECT payload FROM events WHERE board_id = ? AND type = 'board.password_changed'").pluck().get(row.id);
    assert.equal(raw, '{}');
    const history = await app.request(`/api/boards/pw-live/history`, { cookie: r.cookie });
    const entry = history.body.events.find((e) => e.type === 'board.password_changed');
    assert.equal(entry.line.verb, 'changed the board password');
    assert.equal(entry.restorable, false);
    const restore = await app.request(`/api/boards/pw-live/history/${entry.id}/restore`, { cookie: r.cookie });
    assert.equal(restore.status, 409);
    assert.equal(restore.body.code, 'not_restorable');
  });
});

describe('deleting a board', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  async function fill(code, password) {
    const cookie = await makeBoard(app, code, password);
    const card = (await app.request(`/api/boards/${code}/cards`, { method: 'POST', body: { title: 'Valheim', lane: 'up_next' }, cookie })).body.card;
    await app.request(`/api/boards/${code}/cards/${card.id}/players`, { method: 'POST', body: { name: 'Larias' }, cookie });
    return { cookie, card };
  }

  test('deleting needs the code typed, and only schedules it: the board shows a server-measured countdown', async () => {
    const { cookie } = await fill('del-confirm');
    for (const confirm of [undefined, '', 'del-confirmx', 'pnc-raids']) {
      const r = await app.request('/api/boards/del-confirm/deletion', { method: 'POST', body: { confirm }, cookie });
      assert.equal(r.status, 400);
      assert.equal(r.body.field, 'confirm');
    }
    assert.equal(boardRow(app, 'del-confirm').deleted_at, null);

    const r = await app.request('/api/boards/del-confirm/deletion', { method: 'POST', body: { confirm: ' DEL-Confirm ', actor: 'Path' }, cookie });
    assert.equal(r.status, 200);
    const scheduledAt = new Date(app.clock.t).toISOString();
    assert.deepEqual(r.body.board.deletion, {
      scheduledAt,
      purgeAt: new Date(app.clock.t + RETIRE_MS).toISOString(),
      leftMs: RETIRE_MS,
    });
    app.clock.advance(48 * MIN);
    const later = await app.request('/api/boards/del-confirm', { cookie });
    assert.equal(later.body.board.deletion.leftMs, RETIRE_MS - 48 * MIN);

    const row = boardRow(app, 'del-confirm');
    const logged = eventsOf(app, row.id).find((e) => e.type === 'board.deletion_scheduled');
    assert.equal(logged.actor, 'Path');
    assert.deepEqual(logged.payload, { purgeAt: new Date(Date.parse(scheduledAt) + RETIRE_MS).toISOString() });
    assert.equal(logged.restorable, false);
  });

  test('while deleting: reading works, every change is refused (routes and database), and the code is not free', async () => {
    const { cookie, card } = await fill('del-paused');
    await app.request('/api/boards/del-paused/deletion', { method: 'POST', body: { confirm: 'del-paused' }, cookie });
    const id = boardRow(app, 'del-paused').id;
    const editId = eventsOf(app, id).find((e) => e.type === 'card.created').id;

    // Reading goes on.
    assert.equal((await app.request('/api/boards/del-paused', { cookie })).status, 200);
    assert.equal((await app.request('/api/boards/del-paused/cards', { cookie })).status, 200);
    assert.equal((await app.request(`/api/boards/del-paused/cards/${card.id}/players`, { cookie })).status, 200);
    assert.equal((await app.request('/api/boards/del-paused/history', { cookie })).status, 200);

    // Every change is refused: cards, details, moves, players, restores of single changes, the password, deleting again.
    const writes = [
      ['POST', '/cards', { title: 'New', lane: 'up_next' }],
      ['PATCH', `/cards/${card.id}`, { title: 'Renamed', version: card.version }],
      ['PATCH', `/cards/${card.id}`, { goLive: '2026-11-01', version: card.version }],
      ['POST', `/cards/${card.id}/move`, { lane: 'played', index: 0 }],
      ['DELETE', `/cards/${card.id}`, { version: card.version }],
      ['POST', `/cards/${card.id}/players`, { name: 'Mo' }],
      ['POST', `/history/${editId}/restore`, { token: 'x' }],
      ['POST', '/password', { current: PW, password: NEW_PW }],
      ['POST', '/deletion', { confirm: 'del-paused' }],
    ];
    for (const [method, path, body] of writes) {
      const r = await app.request(`/api/boards/del-paused${path}`, { method, body, cookie });
      assert.equal(r.status, 409, `${method} ${path}`);
      assert.equal(r.body.code, 'board_deleting', `${method} ${path}`);
      assert.ok(r.body.board.deletion.leftMs > 0);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) FROM cards WHERE board_id = ?').pluck().get(id), 1);
    // The database refuses a change too, whatever the app does.
    assert.throws(
      () => app.db.prepare("INSERT INTO events (board_id, type, actor, payload) VALUES (?, 'card.edited', 'x', '{}')").run(id),
      /being deleted/,
    );

    // The code isn't free: looking it up opens the board (no "create it?"), and creating it is refused.
    const free = await app.request('/api/boards/del-paused');
    assert.equal(free.status, 200);
    assert.notEqual(free.body.status, 'free');
    const make = await app.request('/api/boards', { method: 'POST', body: { code: 'del-paused' } });
    assert.equal(make.status, 409);
    assert.equal(make.body.code, 'exists');
  });

  test('a deleting password board still shows only its lock screen without the password', async () => {
    const { cookie } = await fill('del-locked', PW);
    await app.request('/api/boards/del-locked/deletion', { method: 'POST', body: { confirm: 'del-locked' }, cookie });
    const r = await app.request('/api/boards/del-locked');
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { status: 'locked', code: 'del-locked' });
    // With it: unlocking works while it's being deleted, and shows the countdown.
    const u = await app.request('/api/boards/del-locked/unlock', { method: 'POST', body: { password: PW } });
    assert.equal(u.status, 200);
    assert.ok(u.body.board.deletion.leftMs > 0);
  });

  test('live viewers see it scheduled and restored as it happens', async () => {
    const { cookie } = await fill('del-live');
    const head = (await app.request('/api/boards/del-live/cards', { cookie })).body.head;
    const s = await openStream(app, 'del-live', { since: head, cookie, tab: 'tab-viewer-1' });
    assert.equal((await s.event()).data.board.deletion, undefined);

    await app.request('/api/boards/del-live/deletion', { method: 'POST', body: { confirm: 'del-live', actor: 'Path' }, cookie });
    const scheduled = await s.event();
    assert.equal(scheduled.event, 'change');
    assert.equal(scheduled.data.entry.type, 'board.deletion_scheduled');
    assert.equal(scheduled.data.entry.actor, 'Path');
    assert.equal(scheduled.data.board.deletion.leftMs, RETIRE_MS);

    await app.request('/api/boards/del-live/deletion', { method: 'DELETE', body: { actor: 'Kaelis' }, cookie });
    const restored = await s.event();
    assert.equal(restored.data.entry.type, 'board.deletion_cancelled');
    assert.equal(restored.data.entry.actor, 'Kaelis');
    assert.equal(restored.data.board.deletion, undefined);
    s.close();
  });

  test('restoring during the window puts it back to normal, and the sweep never touches it', async () => {
    const { cookie } = await fill('del-restore');
    const id = boardRow(app, 'del-restore').id;
    const before = counts(app, id);
    await app.request('/api/boards/del-restore/deletion', { method: 'POST', body: { confirm: 'del-restore' }, cookie });
    app.clock.advance(23 * HOUR);

    const r = await app.request('/api/boards/del-restore/deletion', { method: 'DELETE', body: { actor: 'Kaelis' }, cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.board.deletion, undefined);
    assert.equal(boardRow(app, 'del-restore').deleted_at, null);
    const logged = eventsOf(app, id).find((e) => e.type === 'board.deletion_cancelled');
    assert.equal(logged.actor, 'Kaelis');
    assert.equal(logged.restorable, false);
    // Restoring twice: it isn't being deleted any more.
    const twice = await app.request('/api/boards/del-restore/deletion', { method: 'DELETE', body: {}, cookie });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'not_deleting');

    // Editing works again.
    const add = await app.request('/api/boards/del-restore/cards', { method: 'POST', body: { title: 'Back', lane: 'played' }, cookie });
    assert.equal(add.status, 201);

    // Well past the original deadline, sweep after sweep: the restored board is untouched (other boards in this
    // suite that were deleted and left do come due, and go).
    for (let i = 0; i < 12; i++) {
      app.clock.advance(SWEEP_MS);
      assert.ok(!app.sweep().includes(id));
    }
    app.clock.advance(7 * 24 * HOUR);
    assert.ok(!app.sweep().includes(id));
    assert.deepEqual(app.sweep(), []);
    assert.deepEqual(counts(app, id), { ...before, cards: before.cards + 1, events: before.events + 3 });
    assert.equal((await app.request('/api/boards/del-restore', { cookie })).status, 200);
    // The database refuses to purge a board that isn't retired, whatever calls it.
    assert.throws(() => app.db.prepare('DELETE FROM boards WHERE id = ?').run(id), /only a retired board/);
  });
});

describe('purging a deleted board after 24 hours', () => {
  test('the sweep purges the board, its cards, players and events, and frees the code; it is safe to repeat', async () => {
    const app = await startApp();
    try {
      const cookie = await makeBoard(app, 'purge-me', PW);
      const keep = await makeBoard(app, 'keep-me');
      for (const code of ['purge-me', 'keep-me']) {
        const c = code === 'purge-me' ? cookie : keep;
        const card = (await app.request(`/api/boards/${code}/cards`, { method: 'POST', body: { title: 'Valheim', lane: 'up_next' }, cookie: c })).body.card;
        await app.request(`/api/boards/${code}/cards/${card.id}/players`, { method: 'POST', body: { name: 'Larias' }, cookie: c });
        const p2 = (await app.request(`/api/boards/${code}/cards/${card.id}/players`, { method: 'POST', body: { name: 'Mo' }, cookie: c })).body.player;
        await app.request(`/api/boards/${code}/cards/${card.id}/players/${p2.id}`, { method: 'DELETE', body: {}, cookie: c });
        const del = await app.request(`/api/boards/${code}/cards/${card.id}`, { method: 'DELETE', body: { version: card.version }, cookie: c });
        assert.equal(del.status, 200);
        // A restore, so the board has an event that references another (events.restores): purged in one statement.
        const ev = (await app.request(`/api/boards/${code}/history`, { cookie: c })).body.events.find((e) => e.type === 'card.deleted');
        const preview = (await app.request(`/api/boards/${code}/history/${ev.id}/restore`, { cookie: c })).body.preview;
        assert.equal((await app.request(`/api/boards/${code}/history/${ev.id}/restore`, { method: 'POST', body: { token: preview.token }, cookie: c })).status, 200);
      }
      const id = boardRow(app, 'purge-me').id;
      const keepId = boardRow(app, 'keep-me').id;
      const keepBefore = counts(app, keepId);
      assert.ok(counts(app, id).cards === 1 && counts(app, id).players === 2 && counts(app, id).events >= 6);

      await app.request('/api/boards/purge-me/deletion', { method: 'POST', body: { confirm: 'purge-me' }, cookie });
      const head = (await app.request('/api/boards/purge-me/cards', { cookie })).body.head;
      const s = await openStream(app, 'purge-me', { since: head, cookie });
      assert.equal((await s.event()).event, 'ready');

      // One minute short of 24 hours: nothing is purged, and it still opens.
      app.clock.advance(RETIRE_MS - MIN);
      assert.deepEqual(app.sweep(), []);
      assert.equal(counts(app, id).boards, 1);
      assert.equal((await app.request('/api/boards/purge-me', { cookie })).body.board.deletion.leftMs, MIN);

      // Past it: the sweep purges everything of that board and nothing of any other.
      app.clock.advance(MIN);
      assert.deepEqual(app.sweep(), [id]);
      assert.deepEqual(counts(app, id), { boards: 0, cards: 0, players: 0, events: 0 });
      assert.deepEqual(counts(app, keepId), keepBefore);
      // Its live viewers are told it's gone.
      assert.deepEqual(await s.event(), { id: undefined, event: 'gone', data: { status: 'free', code: 'purge-me' } });
      assert.equal(await s.event(), null);
      // Safe to run again, and again.
      assert.deepEqual(app.sweep(), []);
      assert.deepEqual(app.sweep(), []);

      // The old link, even with the old access cookie, shows the code as free; a new board can take it.
      const free = await app.request('/api/boards/purge-me', { cookie });
      assert.equal(free.status, 404);
      assert.deepEqual(free.body, { status: 'free', code: 'purge-me', full: false });
      const made = await app.request('/api/boards', { method: 'POST', body: { code: 'purge-me' } });
      assert.equal(made.status, 201);
      assert.equal(made.body.board.hasPassword, false);
      const fresh = boardRow(app, 'purge-me');
      assert.notEqual(fresh.id, id);
      assert.equal(eventsOf(app, fresh.id).length, 1);
      // The old grant opens nothing on the new board (it was for the old board's id).
      assert.equal((await app.request('/api/boards/purge-me/cards', { cookie })).body.cards.length, 0);
    } finally {
      await app.close();
    }
  });

  test('past its 24 hours, a board is gone before the sweep runs: opening the code purges it and shows it free', async () => {
    const app = await startApp();
    try {
      const cookie = await makeBoard(app, 'lazy-purge');
      await app.request('/api/boards/lazy-purge/deletion', { method: 'POST', body: { confirm: 'lazy-purge' }, cookie });
      const id = boardRow(app, 'lazy-purge').id;
      app.clock.advance(RETIRE_MS);
      // Restoring is too late.
      const restore = await app.request('/api/boards/lazy-purge/deletion', { method: 'DELETE', body: {}, cookie });
      assert.equal(restore.status, 404);
      assert.equal(restore.body.status, 'free');
      assert.deepEqual(counts(app, id), { boards: 0, cards: 0, players: 0, events: 0 });
      assert.deepEqual(app.sweep(), []);
    } finally {
      await app.close();
    }
  });

  test('the board cap counts boards being deleted until they are purged', async () => {
    const app = await startApp({ maxBoards: 2 });
    try {
      const cookie = await makeBoard(app, 'cap-one');
      await makeBoard(app, 'cap-two');
      await app.request('/api/boards/cap-one/deletion', { method: 'POST', body: { confirm: 'cap-one' }, cookie });
      assert.equal((await app.request('/api/boards/cap-three')).body.full, true);
      const refused = await app.request('/api/boards', { method: 'POST', body: { code: 'cap-three' } });
      assert.equal(refused.body.code, 'board_limit');
      app.clock.advance(RETIRE_MS);
      assert.equal(app.sweep().length, 1);
      assert.equal((await app.request('/api/boards', { method: 'POST', body: { code: 'cap-three' } })).status, 201);
    } finally {
      await app.close();
    }
  });
});

describe('the new routes on a locked board', () => {
  test('without the password, password change, delete and restore answer only "locked", and change nothing', async () => {
    const app = await startApp();
    try {
      const owner = await makeBoard(app, 'locked-new', PW);
      const stale = (await app.request('/api/boards/locked-new/unlock', { method: 'POST', body: { password: PW } })).cookie;
      const calls = [
        ['POST', '/password', { current: PW, password: NEW_PW }],
        ['POST', '/deletion', { confirm: 'locked-new' }],
        ['DELETE', '/deletion', {}],
        ['GET', '/deletion', undefined],
        ['PUT', '/password', {}],
      ];
      for (const [method, path, body] of calls) {
        const r = await app.request(`/api/boards/locked-new${path}`, { method, body });
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.deepEqual(r.body, { status: 'locked', code: 'locked-new' }, `${method} ${path}`);
      }
      // While it's being deleted, still nothing but "locked" (no countdown, no hint it's going).
      await app.request('/api/boards/locked-new/deletion', { method: 'POST', body: { confirm: 'locked-new' }, cookie: owner });
      for (const [method, path, body] of calls) {
        const r = await app.request(`/api/boards/locked-new${path}`, { method, body });
        assert.deepEqual(r.body, { status: 'locked', code: 'locked-new' }, `${method} ${path} while deleting`);
      }
      await app.request('/api/boards/locked-new/deletion', { method: 'DELETE', body: {}, cookie: owner });
      // After a change, an old grant gets "password changed", and nothing else.
      await app.request('/api/boards/locked-new/password', { method: 'POST', body: { current: PW, password: NEW_PW }, cookie: owner });
      for (const [method, path, body] of calls) {
        const r = await app.request(`/api/boards/locked-new${path}`, { method, body, cookie: stale });
        assert.deepEqual(r.body, { status: 'locked', code: 'locked-new', reason: 'password_changed' }, `${method} ${path} stale`);
      }
      const row = boardRow(app, 'locked-new');
      assert.equal(row.password_version, 2);
      assert.equal(row.deleted_at, null);
    } finally {
      await app.close();
    }
  });
});
