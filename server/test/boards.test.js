import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkCode, normalizeCode } from '../core/codes.js';
import { listEvents } from '../core/events.js';
import { hashPassword } from '../core/passwords.js';
import { startApp } from './helpers.js';

const PW = 'raid night 8pm';
const MIN = 60 * 1000;

describe('codes', () => {
  test('3–32 letters, numbers and hyphens, case-insensitive', () => {
    assert.equal(normalizeCode('  PNC-Raids '), 'pnc-raids');
    assert.deepEqual(checkCode('PNC-Raids'), { ok: true, code: 'pnc-raids' });
    assert.equal(checkCode('ab').ok, false);
    assert.equal(checkCode('a'.repeat(33)).ok, false);
    assert.equal(checkCode('a'.repeat(32)).ok, true);
    for (const bad of ['pnc raids', 'pnc_raids', 'pnc/raids', 'café-night', '', '../etc']) assert.equal(checkCode(bad).ok, false, bad);
  });
});

describe('creating and opening boards', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('an unknown code is free; creating it opens it and logs board.created against the display name', async () => {
    const free = await app.request('/api/boards/pnc-autumn');
    assert.equal(free.status, 404);
    assert.deepEqual(free.body, { status: 'free', code: 'pnc-autumn', full: false });

    const made = await app.request('/api/boards', { method: 'POST', body: { code: 'PNC-Autumn', actor: '  Path  ' } });
    assert.equal(made.status, 201);
    assert.equal(made.body.status, 'open');
    assert.deepEqual(Object.keys(made.body.board).sort(), ['code', 'createdAt', 'hasPassword']);
    assert.equal(made.body.board.code, 'pnc-autumn');
    assert.equal(made.body.board.hasPassword, false);

    const row = app.db.prepare('SELECT * FROM boards WHERE code = ?').get('pnc-autumn');
    const { events } = listEvents(app.db, row.id, { limit: 10 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'board.created');
    assert.equal(events[0].actor, 'Path');
    assert.deepEqual(events[0].payload, { hasPassword: false });

    // Same board whatever the case.
    const opened = await app.request('/api/boards/PNC-AUTUMN');
    assert.equal(opened.status, 200);
    assert.equal(opened.body.board.code, 'pnc-autumn');
  });

  test('no display name is logged as "Someone"', async () => {
    await app.request('/api/boards', { method: 'POST', body: { code: 'no-name' } });
    const row = app.db.prepare('SELECT id FROM boards WHERE code = ?').get('no-name');
    assert.equal(listEvents(app.db, row.id).events[0].actor, 'Someone');
  });

  test('a code that is taken cannot be created again', async () => {
    const again = await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-autumn', password: PW } });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'exists');
  });

  test('invalid codes and passwords are refused with field errors that never echo them', async () => {
    const r1 = await app.request('/api/boards', { method: 'POST', body: { code: 'no spaces' } });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.field, 'code');
    assert.ok(!r1.text.includes('no spaces'));
    const r2 = await app.request('/api/boards', { method: 'POST', body: { code: 'short-pw', password: 'abc' } });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.field, 'password');
    assert.ok(!r2.text.includes('"abc"'));
    assert.equal((await app.request('/api/boards/a_b')).status, 400);
  });

  test('a password is stored only as an argon2id hash, never in the log', async () => {
    const made = await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids', password: PW, actor: 'Path' } });
    assert.equal(made.status, 201);
    assert.equal(made.body.board.hasPassword, true);
    assert.ok(!made.text.includes(PW));
    const row = app.db.prepare('SELECT * FROM boards WHERE code = ?').get('pnc-raids');
    assert.match(row.password_hash, /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    assert.ok(!row.password_hash.includes(PW));
    assert.equal(row.password_version, 1);
    const logged = app.db.prepare('SELECT payload FROM events WHERE board_id = ?').pluck().all(row.id).join();
    assert.equal(logged, '{"hasPassword":true}');
    // The creator's browser gets access straight away.
    const opened = await app.request('/api/boards/pnc-raids', { cookie: made.cookie });
    assert.equal(opened.status, 200);
  });
});

describe('a password board without access reveals only that it is locked', () => {
  let app;
  let creatorCookie;
  before(async () => {
    app = await startApp();
    creatorCookie = (await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids', password: PW } })).cookie;
  });
  after(() => app.close());

  const LOCKED = { status: 'locked', code: 'pnc-raids' };

  test('every board endpoint, without access', async () => {
    const get = await app.request('/api/boards/pnc-raids');
    assert.equal(get.status, 403);
    assert.deepEqual(get.body, LOCKED);

    const upper = await app.request('/api/boards/PNC-RAIDS');
    assert.deepEqual(upper.body, LOCKED);

    // Any route under the board, including ones that don't exist yet, answers "locked" before anything else.
    for (const path of ['/events', '/cards', '/anything/at/all']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const r = await app.request(`/api/boards/pnc-raids${path}`, { method, body: method === 'GET' ? undefined : {} });
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.deepEqual(r.body, LOCKED, `${method} ${path}`);
      }
    }

    const wrong = await app.request('/api/boards/pnc-raids/unlock', { method: 'POST', body: { password: 'not it at all' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, { error: "That password didn't work.", code: 'wrong_password' });

    const lock = await app.request('/api/boards/pnc-raids/lock', { method: 'POST' });
    assert.equal(lock.status, 204);
    assert.equal(lock.text, '');

    // Creating over it says only that the code is taken.
    const create = await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids' } });
    assert.equal(create.status, 409);
    assert.deepEqual(Object.keys(create.body).sort(), ['code', 'error']);

    for (const r of [get, wrong, lock, create]) {
      assert.ok(!/createdAt|hasPassword|argon|password_hash/.test(r.text), r.text);
      assert.equal(r.setCookie.filter((c) => !c.includes('Max-Age=0')).length, 0, 'no grant without the password');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });

  test('a tampered or borrowed cookie is no key', async () => {
    const [name, value] = creatorCookie.split('=');
    const [id, version, mac] = value.split('.');
    const forged = [
      `${name}=${id}.${version}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
      `${name}=${id}.${Number(version) + 1}.${mac}`,
      `${name}=${Number(id) + 1}.${version}.${mac}`,
      `${name}=garbage`,
    ];
    for (const cookie of forged) {
      const r = await app.request('/api/boards/pnc-raids', { cookie });
      assert.deepEqual(r.body, LOCKED, cookie);
    }
    // A grant for one board doesn't open another.
    const other = await app.request('/api/boards', { method: 'POST', body: { code: 'other-raids', password: PW } });
    const r = await app.request('/api/boards/pnc-raids', { cookie: other.cookie });
    assert.deepEqual(r.body, LOCKED);
  });

  test('the right password unlocks this browser; lock forgets it', async () => {
    const unlock = await app.request('/api/boards/pnc-raids/unlock', { method: 'POST', body: { password: PW }, ip: '198.51.100.20' });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.board.hasPassword, true);
    const set = unlock.setCookie[0];
    assert.match(set, /^nu_access=\d+\.1\.[A-Za-z0-9_-]{43}; Path=\/api\/boards\/pnc-raids; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    assert.ok(!set.includes(PW));

    const opened = await app.request('/api/boards/pnc-raids', { cookie: unlock.cookie });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.status, 'open');

    const lock = await app.request('/api/boards/pnc-raids/lock', { method: 'POST', cookie: unlock.cookie });
    assert.match(lock.setCookie[0], /^nu_access=; Path=\/api\/boards\/pnc-raids; Max-Age=0; HttpOnly; SameSite=Strict$/);
  });

  test('through the tunnel (HTTPS) the cookie is also Secure', async () => {
    const unlock = await app.request('/api/boards/pnc-raids/unlock', {
      method: 'POST',
      body: { password: PW },
      ip: '198.51.100.21',
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.match(unlock.setCookie[0], /; Secure$/);
  });
});

describe('when the password changes, old grants land on "the password changed"', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('simulated change: version bump → stale grant → new password unlocks again', async () => {
    const made = await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids', password: PW } });
    const oldCookie = made.cookie;
    assert.equal((await app.request('/api/boards/pnc-raids', { cookie: oldCookie })).status, 200);

    // There is no change UI yet: do what it will do, in the database.
    const next = 'new raid password';
    app.db
      .prepare('UPDATE boards SET password_hash = ?, password_version = password_version + 1 WHERE code = ?')
      .run(await hashPassword(next), 'pnc-raids');

    const stale = await app.request('/api/boards/pnc-raids', { cookie: oldCookie });
    assert.equal(stale.status, 403);
    assert.deepEqual(stale.body, { status: 'locked', code: 'pnc-raids', reason: 'password_changed' });

    // The old password no longer works; the new one does, and its grant carries version 2.
    const oldPw = await app.request('/api/boards/pnc-raids/unlock', { method: 'POST', body: { password: PW }, cookie: oldCookie });
    assert.equal(oldPw.status, 401);
    const newPw = await app.request('/api/boards/pnc-raids/unlock', { method: 'POST', body: { password: next }, cookie: oldCookie });
    assert.equal(newPw.status, 200);
    assert.match(newPw.cookie, /^nu_access=\d+\.2\./);
    assert.equal((await app.request('/api/boards/pnc-raids', { cookie: newPw.cookie })).status, 200);
  });

  test('the database itself refuses removing a password, adding one later, or changing it without a version bump', async () => {
    await app.request('/api/boards', { method: 'POST', body: { code: 'open-one' } });
    const hash = await hashPassword(PW);
    assert.throws(() => app.db.prepare('UPDATE boards SET password_hash = NULL, password_version = 0 WHERE code = ?').run('pnc-raids'), /never removed/);
    assert.throws(() => app.db.prepare('UPDATE boards SET password_hash = ?, password_version = 1 WHERE code = ?').run(hash, 'open-one'), /never gain/);
    assert.throws(() => app.db.prepare('UPDATE boards SET password_hash = ? WHERE code = ?').run(hash, 'pnc-raids'), /raise password_version/);
  });

  test('events are append-only and boards are never hard-deleted while live', () => {
    assert.throws(() => app.db.prepare("UPDATE events SET actor = 'x'").run(), /append-only/);
    assert.throws(() => app.db.prepare('DELETE FROM events').run(), /append-only/);
    assert.throws(() => app.db.prepare('DELETE FROM boards').run(), /retired/);
  });
});

describe('wrong passwords: 10 per network per 15 minutes, one shared counter', () => {
  let app;
  before(async () => {
    app = await startApp();
    await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids', password: PW } });
    await app.request('/api/boards', { method: 'POST', body: { code: 'alt-raids', password: 'alt password!' } });
  });
  after(() => app.close());

  const attempt = (password, ip, code = 'pnc-raids') =>
    app.request(`/api/boards/${code}/unlock`, { method: 'POST', body: { password }, ip });

  test('the 11th wrong password is refused with a countdown, even if it is right; the window slides', async () => {
    const ip = '203.0.113.7';
    // Ten wrong, split across two boards: the counter is per network, not per board.
    for (let i = 0; i < 10; i++) {
      const r = await attempt(`wrong ${i}`, ip, i % 2 ? 'alt-raids' : 'pnc-raids');
      assert.equal(r.status, 401, `attempt ${i + 1}`);
      app.clock.advance(10 * 1000);
    }
    const eleventh = await attempt('wrong 11', ip);
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.code, 'too_many_passwords');
    // The first failure was 100 s ago: room again in 15 min − 100 s = 800 s.
    assert.equal(eleventh.body.retryAfter, 800);
    assert.equal(eleventh.headers.get('retry-after'), '800');

    // Refused before checking, so even the right password doesn't get through (and doesn't reveal it was right).
    const right = await attempt(PW, ip);
    assert.equal(right.status, 429);

    // Another network is unaffected.
    assert.equal((await attempt(PW, '203.0.113.8')).status, 200);

    // The countdown counts down; when the oldest failure leaves the window, exactly one more try is allowed.
    app.clock.advance(400 * 1000);
    assert.equal((await attempt('x', ip)).body.retryAfter, 400);
    app.clock.advance(400 * 1000);
    assert.equal((await attempt('wrong again', ip)).status, 401);
    assert.equal((await attempt('and again', ip)).status, 429);
  });

  test('a right password never resets the count (your own board buys no guesses at another)', async () => {
    const ip = '203.0.113.30';
    for (let i = 0; i < 9; i++) assert.equal((await attempt(`wrong ${i}`, ip)).status, 401);
    assert.equal((await attempt('alt password!', ip, 'alt-raids')).status, 200);
    assert.equal((await attempt('wrong 10', ip)).status, 401);
    assert.equal((await attempt('wrong 11', ip)).status, 429);
  });

  test('fifteen wrong passwords at once: exactly ten are checked', async () => {
    const ip = '203.0.113.40';
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => attempt(`parallel ${i}`, ip)));
    const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    assert.deepEqual(counts, { 401: 10, 429: 5 });
  });

  test('a malformed attempt costs nothing', async () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < 12; i++) {
      assert.equal((await app.request('/api/boards/pnc-raids/unlock', { method: 'POST', body: {}, ip })).status, 400);
    }
    assert.equal((await attempt(PW, ip)).status, 200);
  });
});

describe('unknown codes: 30 per network per 15 minutes', () => {
  let app;
  let openCookie;
  before(async () => {
    app = await startApp();
    openCookie = (await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-autumn' }, ip: '192.0.2.99' })).cookie;
    await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids', password: PW }, ip: '192.0.2.99' });
  });
  after(() => app.close());

  test('the 31st miss is refused; while limited only boards opened before still answer', async () => {
    const ip = '192.0.2.1';
    // Opening real boards doesn't count.
    for (let i = 0; i < 5; i++) assert.equal((await app.request('/api/boards/pnc-autumn', { ip })).status, 200);
    for (let i = 0; i < 30; i++) assert.equal((await app.request(`/api/boards/nope-${i}`, { ip })).status, 404, `miss ${i + 1}`);
    const limited = await app.request('/api/boards/nope-31', { ip });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'too_many_lookups');
    assert.ok(limited.body.retryAfter > 0 && limited.body.retryAfter <= 900);

    // Existing boards are indistinguishable from unknown ones to this network now...
    assert.equal((await app.request('/api/boards/pnc-autumn', { ip })).status, 429);
    assert.equal((await app.request('/api/boards/pnc-raids', { ip })).status, 429);
    // ...creating is refused too (otherwise "already exists" would answer the question)...
    assert.equal((await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids' }, ip })).status, 429);
    // ...but a board this browser has opened before still opens by its link.
    assert.equal((await app.request('/api/boards/pnc-autumn', { ip, cookie: openCookie })).status, 200);
    // Another network is unaffected.
    assert.equal((await app.request('/api/boards/nope-31', { ip: '192.0.2.2' })).status, 404);

    app.clock.advance(15 * MIN);
    assert.equal((await app.request('/api/boards/nope-31', { ip })).status, 404);
  });
});

describe('the board cap', () => {
  let app;
  before(async () => {
    app = await startApp({ maxBoards: 2 });
  });
  after(() => app.close());

  test('creating past the cap is refused plainly; a free code says so before you fill anything in', async () => {
    assert.equal((await app.request('/api/boards', { method: 'POST', body: { code: 'one-board' } })).status, 201);
    assert.equal((await app.request('/api/boards/two-board')).body.full, false);
    assert.equal((await app.request('/api/boards', { method: 'POST', body: { code: 'two-board' } })).status, 201);
    assert.deepEqual((await app.request('/api/boards/three-board')).body, { status: 'free', code: 'three-board', full: true });
    const third = await app.request('/api/boards', { method: 'POST', body: { code: 'three-board' } });
    assert.equal(third.status, 409);
    assert.equal(third.body.code, 'board_limit');
    // Existing boards still open.
    assert.equal((await app.request('/api/boards/one-board')).status, 200);
  });

  test('concurrent creations cannot overshoot it', async () => {
    const app2 = await startApp({ maxBoards: 3 });
    const results = await Promise.all(
      // With passwords, so the hashing (async) interleaves the requests before their transactions.
      Array.from({ length: 8 }, (_, i) => app2.request('/api/boards', { method: 'POST', body: { code: `race-${i}`, password: PW }, ip: `192.0.2.${i + 10}` })),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(app2.db.prepare('SELECT COUNT(*) FROM boards').pluck().get(), 3);
    await app2.close();
  });
});
