import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MAX_PLAYERS, SERVER_INFO_MAX, checkGoLive, checkPlayerName, playerKey } from '../core/cardDetail.js';
import { eventType, listEvents } from '../core/events.js';
import { startApp } from './helpers.js';

const PW = 'raid night 8pm';

async function board(app, code, password) {
  const made = await app.request('/api/boards', { method: 'POST', body: { code, password } });
  assert.equal(made.status, 201);
  const id = app.db.prepare('SELECT id FROM boards WHERE code = ?').pluck().get(code);
  return { cookie: made.cookie, id };
}

const eventsOf = (app, boardId) => listEvents(app.db, boardId, { limit: 200 }).events;

describe('go-live date and server info', () => {
  let app;
  let b;
  const api = (path = '', opts = {}) => app.request(`/api/boards/pnc-detail/cards${path}`, opts);
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-detail');
  });
  after(() => app.close());

  test('a new card has no date, no server info and no players, and says so plainly', async () => {
    const r = await api('', { method: 'POST', body: { title: 'Valheim', lane: 'up_next' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.card.goLive, null);
    assert.equal(r.body.card.serverInfo, '');
    assert.equal(r.body.card.playerCount, 0);
  });

  test('a card can be added with both, and card.created carries them', async () => {
    const r = await api('', {
      method: 'POST',
      body: { title: 'Enshrouded', lane: 'up_next', goLive: '2026-10-24', serverInfo: 'host: 203.0.113.42:2456\r\npw: skål' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.card.goLive, '2026-10-24');
    assert.equal(r.body.card.serverInfo, 'host: 203.0.113.42:2456\npw: skål', 'line endings become \\n');
    const created = eventsOf(app, b.id).find((e) => e.type === 'card.created' && e.payload.cardId === r.body.card.id);
    assert.equal(created.payload.card.goLive, '2026-10-24');
    assert.equal(created.payload.card.serverInfo, 'host: 203.0.113.42:2456\npw: skål');
  });

  test('editing them logs card.detail_edited with before and after, bumps the version and nothing else', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'Palworld', lane: 'up_next' } })).body.card;
    const info = 'PNC Palworld\n198.51.100.7:8211\nGuide: https://example.org/pnc/palworld';
    const r = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, goLive: '2026-11-07', serverInfo: info, actor: 'Path' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.goLive, '2026-11-07');
    assert.equal(r.body.card.serverInfo, info);
    assert.equal(r.body.card.version, 2);
    const mine = eventsOf(app, b.id).filter((e) => e.payload.cardId === card.id && e.type !== 'card.created');
    assert.deepEqual(
      mine.map((e) => e.type),
      ['card.detail_edited'],
    );
    assert.equal(mine[0].actor, 'Path');
    assert.equal(mine[0].restorable, true);
    assert.deepEqual(mine[0].payload, {
      cardId: card.id,
      before: { goLive: null, serverInfo: '' },
      after: { goLive: '2026-11-07', serverInfo: info },
    });

    // Clearing the date is a detail edit too; the server info it didn't name stays.
    const cleared = await api(`/${card.id}`, { method: 'PATCH', body: { version: 2, goLive: null } });
    assert.equal(cleared.body.card.goLive, null);
    assert.equal(cleared.body.card.serverInfo, info);
    const last = eventsOf(app, b.id)[0];
    assert.deepEqual(last.payload, {
      cardId: card.id,
      before: { goLive: '2026-11-07', serverInfo: info },
      after: { goLive: null, serverInfo: info },
    });

    // Saving the same values changes and logs nothing.
    const count = eventsOf(app, b.id).length;
    const same = await api(`/${card.id}`, { method: 'PATCH', body: { version: 3, goLive: null, serverInfo: `${info}\n\n` } });
    assert.equal(same.body.card.version, 3);
    assert.equal(eventsOf(app, b.id).length, count);
  });

  test('one save that renames, dates and moves logs card.edited, card.detail_edited, card.moved in that order', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'V Risng', lane: 'up_next' } })).body.card;
    const r = await api(`/${card.id}`, {
      method: 'PATCH',
      body: { version: 1, title: 'V Rising', goLive: '2026-12-01', lane: 'now_playing' },
    });
    assert.equal(r.status, 200);
    const mine = eventsOf(app, b.id)
      .filter((e) => e.payload.cardId === card.id && e.type !== 'card.created')
      .reverse();
    assert.deepEqual(
      mine.map((e) => e.type),
      ['card.edited', 'card.detail_edited', 'card.moved'],
    );
    // card.edited stays the name and logo: its before/after carry no date.
    assert.equal(mine[0].payload.after.goLive, undefined);
    assert.equal(mine[0].payload.after.title, 'V Rising');
  });

  test('a stale version on a detail edit gets the conflict and the latest card, never a silent overwrite', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'Soulmask', lane: 'up_next' } })).body.card;
    await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, serverInfo: 'first' } });
    const stale = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, serverInfo: 'second' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'conflict');
    assert.equal(stale.body.card.serverInfo, 'first');
  });

  test('a move keeps the date and server info', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'Abiotic Factor', lane: 'up_next', goLive: '2027-01-02', serverInfo: 'x' } }))
      .body.card;
    const moved = await api(`/${card.id}/move`, { method: 'POST', body: { lane: 'played', index: 0 } });
    assert.equal(moved.body.card.goLive, '2027-01-02');
    assert.equal(moved.body.card.serverInfo, 'x');
  });

  test('bad dates and server info are refused per field, and the database refuses them too', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'Dune', lane: 'up_next' } })).body.card;
    for (const goLive of ['2026-02-30', '2026-13-01', '2026-1-5', '24/10/2026', '2026-10-24T00:00:00Z', 20261024, '1999-12-31', '2100-01-01', true]) {
      const r = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, goLive } });
      assert.equal(r.status, 400, String(goLive));
      assert.equal(r.body.field, 'goLive');
    }
    assert.equal(checkGoLive('2028-02-29').ok, true, 'a leap day is a date');
    assert.equal(checkGoLive('2027-02-29').ok, false);

    const tooLong = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, serverInfo: 'x'.repeat(SERVER_INFO_MAX + 1) } });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, 'serverInfo');
    assert.equal((await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, serverInfo: { html: '<b>' } } })).body.field, 'serverInfo');
    // 2,000 characters as people count them, even when each is two UTF-16 units.
    const emoji = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, serverInfo: '🎮'.repeat(SERVER_INFO_MAX) } });
    assert.equal(emoji.status, 200);
    assert.equal(app.db.prepare('SELECT version FROM cards WHERE id = ?').pluck().get(card.id), 2);

    assert.throws(() => app.db.prepare("UPDATE cards SET go_live = '2026-02-30' WHERE id = ?").run(card.id), /CHECK/);
    assert.throws(() => app.db.prepare('UPDATE cards SET server_info = ? WHERE id = ?').run('x'.repeat(2001), card.id), /CHECK/);
  });

  test('server info is stored as typed: HTML and markdown are text, never rendered or stripped by the server', async () => {
    const raw = '<script>alert(1)</script> [mods](javascript:alert(1)) data:text/html,<b>x</b>';
    const card = (await api('', { method: 'POST', body: { title: 'Raw', lane: 'up_next', serverInfo: raw } })).body.card;
    assert.equal(card.serverInfo, raw);
  });
});

describe('player sign-ups', () => {
  let app;
  let b;
  let card;
  const api = (path = '', opts = {}) => app.request(`/api/boards/pnc-players/cards${path}`, opts);
  const players = (path = '', opts = {}) => api(`/${card.id}/players${path}`, opts);
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-players');
    card = (await api('', { method: 'POST', body: { title: 'Valheim', lane: 'now_playing' } })).body.card;
  });
  after(() => app.close());

  test('nobody is signed up to a new card', async () => {
    const r = await players();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { players: [], next: null, limit: MAX_PLAYERS });
  });

  test('adding trims the name, lists players in sign-up order, counts them on the card and logs player.added', async () => {
    const one = await players('', { method: 'POST', body: { name: '  Path  ', actor: 'Path' } });
    assert.equal(one.status, 201);
    assert.equal(one.body.player.name, 'Path');
    assert.equal(one.body.playerCount, 1);
    await players('', { method: 'POST', body: { name: 'Bunzato' } });
    const three = await players('', { method: 'POST', body: { name: 'Larias', actor: 'Bunzato' } });
    assert.equal(three.body.playerCount, 3);

    const list = await players();
    assert.deepEqual(
      list.body.players.map((p) => p.name),
      ['Path', 'Bunzato', 'Larias'],
    );
    assert.deepEqual(Object.keys(list.body.players[0]).sort(), ['addedAt', 'id', 'name']);
    const onBoard = (await api()).body.cards.find((c) => c.id === card.id);
    assert.equal(onBoard.playerCount, 3);
    assert.equal(onBoard.version, 1, 'sign-ups never touch the card version');

    const added = eventsOf(app, b.id).filter((e) => e.type === 'player.added');
    assert.equal(added.length, 3);
    assert.equal(added[0].restorable, false);
    assert.equal(added[0].actor, 'Bunzato');
    assert.deepEqual(added[0].payload, { cardId: card.id, playerId: three.body.player.id, name: 'Larias', position: 2 });
  });

  test('a name already on the card is refused, ignoring case and spacing, with the name as written there', async () => {
    for (const name of ['larias', 'LARIAS', '  Larias ', 'LaRiAs']) {
      const r = await players('', { method: 'POST', body: { name } });
      assert.equal(r.status, 409, name);
      assert.equal(r.body.code, 'player_exists');
      assert.equal(r.body.error, 'Larias is already signed up.');
      assert.equal(r.body.player.name, 'Larias');
    }
    // Accents typed two ways (é as one character, or e + a combining accent) are one name.
    await players('', { method: 'POST', body: { name: 'Zoé' } });
    const twin = await players('', { method: 'POST', body: { name: 'ZOÉ' } });
    assert.equal(twin.status, 409);
    assert.equal(playerKey('Zoé'), playerKey('ZOÉ'));
    // The database holds the same rule.
    assert.throws(
      () => app.db.prepare('INSERT INTO players (board_id, card_id, name, name_key) VALUES (?, ?, ?, ?)').run(b.id, card.id, 'LARIAS', 'larias'),
      /UNIQUE/,
    );
  });

  test('bad names are refused', async () => {
    for (const name of ['', '   ', 'x'.repeat(33), 42, null]) {
      const r = await players('', { method: 'POST', body: { name } });
      assert.equal(r.status, 400, String(name));
      assert.equal(r.body.field, 'name');
    }
    assert.equal(checkPlayerName('ö'.repeat(32)).ok, true, '32 characters, not bytes');
  });

  test('removing tombstones the player, logs player.removed with their place, and the name can sign up again', async () => {
    const list = (await players()).body.players;
    const bunzato = list.find((p) => p.name === 'Bunzato');
    const r = await players(`/${bunzato.id}`, { method: 'DELETE', body: { actor: 'Path' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.player.name, 'Bunzato');
    assert.equal(r.body.playerCount, list.length - 1);
    assert.ok(!(await players()).body.players.some((p) => p.id === bunzato.id));
    assert.ok(app.db.prepare('SELECT deleted_at FROM players WHERE id = ?').pluck().get(bunzato.id), 'the row stays');

    const removed = eventsOf(app, b.id).find((e) => e.type === 'player.removed');
    assert.equal(removed.restorable, true);
    assert.equal(removed.actor, 'Path');
    assert.deepEqual(removed.payload, { cardId: card.id, playerId: bunzato.id, name: 'Bunzato', position: 1 });

    // Already gone: says so, logs nothing.
    const count = eventsOf(app, b.id).length;
    const again = await players(`/${bunzato.id}`, { method: 'DELETE', body: {} });
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'player_gone');
    assert.equal(eventsOf(app, b.id).length, count);
    assert.equal((await players('/abc', { method: 'DELETE', body: {} })).body.code, 'player_gone');

    const back = await players('', { method: 'POST', body: { name: 'bunzato' } });
    assert.equal(back.status, 201, 'a removed name can sign up again');
    assert.throws(() => app.db.prepare('DELETE FROM players WHERE id = ?').run(bunzato.id), /tombstoned/);
    assert.throws(() => app.db.prepare("UPDATE players SET name = 'X' WHERE id = ?").run(bunzato.id), /never moved or renamed/);
  });

  test(`a card holds at most ${MAX_PLAYERS} players; the next is refused with a plain message`, async () => {
    const big = (await api('', { method: 'POST', body: { title: 'Big raid', lane: 'up_next' } })).body.card;
    const add = (name) => api(`/${big.id}/players`, { method: 'POST', body: { name } });
    for (let i = 1; i <= MAX_PLAYERS; i++) assert.equal((await add(`Player ${i}`)).status, 201);
    const over = await add('One too many');
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'player_limit');
    assert.equal(over.body.error, `This card has ${MAX_PLAYERS} players, the most a card can hold.`);
    assert.equal(app.db.prepare('SELECT COUNT(*) FROM players WHERE card_id = ? AND deleted_at IS NULL').pluck().get(big.id), MAX_PLAYERS);

    // All 100 come back in one page, in order; a smaller page follows the cursor.
    const all = await api(`/${big.id}/players`);
    assert.equal(all.body.players.length, MAX_PLAYERS);
    assert.equal(all.body.players[99].name, 'Player 100');
    const page = await api(`/${big.id}/players?limit=40`);
    assert.equal(page.body.players.length, 40);
    const rest = await api(`/${big.id}/players?limit=100&after=${encodeURIComponent(page.body.next)}`);
    assert.equal(rest.body.players[0].name, 'Player 41');
    assert.equal((await api(`/${big.id}/players?after=nope`)).status, 400);

    // Removing one makes room.
    const first = all.body.players[0];
    await api(`/${big.id}/players/${first.id}`, { method: 'DELETE', body: {} });
    assert.equal((await add('One too many')).status, 201);
  });

  test("a deleted card's players can't be read or changed, and another board's card is not this board's", async () => {
    const gone = (await api('', { method: 'POST', body: { title: 'Gone', lane: 'up_next' } })).body.card;
    const p = (await api(`/${gone.id}/players`, { method: 'POST', body: { name: 'Path' } })).body.player;
    await api(`/${gone.id}`, { method: 'DELETE', body: { version: 1 } });
    assert.equal((await api(`/${gone.id}/players`)).body.code, 'card_gone');
    assert.equal((await api(`/${gone.id}/players`, { method: 'POST', body: { name: 'X' } })).body.code, 'card_gone');
    assert.equal((await api(`/${gone.id}/players/${p.id}`, { method: 'DELETE', body: {} })).body.code, 'card_gone');

    await board(app, 'other-board');
    const theirs = (await app.request('/api/boards/other-board/cards', { method: 'POST', body: { title: 'Theirs', lane: 'up_next' } })).body.card;
    const r = await api(`/${theirs.id}/players`, { method: 'POST', body: { name: 'Sneaky' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'card_gone');
  });

  test('the event types are declared with the agreed restorability', () => {
    assert.equal(eventType('card.detail_edited').restorable, true);
    assert.equal(eventType('player.added').restorable, false);
    assert.equal(eventType('player.removed').restorable, true);
  });
});

describe('a locked board answers only "locked" to every new route', () => {
  let app;
  let b;
  let cardId;
  let playerId;
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-locked', PW);
    const base = '/api/boards/pnc-locked/cards';
    cardId = (await app.request(base, { method: 'POST', body: { title: 'Secret game', lane: 'up_next', goLive: '2026-10-31' }, cookie: b.cookie }))
      .body.card.id;
    playerId = (await app.request(`${base}/${cardId}/players`, { method: 'POST', body: { name: 'Path' }, cookie: b.cookie })).body.player.id;
  });
  after(() => app.close());

  test('without the cookie: the same bare answer, and nothing written', async () => {
    const base = `/api/boards/pnc-locked/cards/${cardId}`;
    const before = app.db.prepare('SELECT (SELECT COUNT(*) FROM events) || (SELECT COUNT(*) FROM players) || (SELECT version FROM cards)').pluck().get();
    const calls = [
      ['GET', `${base}/players`],
      ['GET', `${base}/players?limit=1`],
      ['POST', `${base}/players`, { name: 'Intruder' }],
      ['DELETE', `${base}/players/${playerId}`, {}],
      ['DELETE', `${base}/players/999`, {}],
      ['GET', '/api/boards/pnc-locked/cards/999/players'],
      ['PATCH', base, { version: 1, goLive: '2026-11-01', serverInfo: 'pwned' }],
    ];
    for (const [method, path, body] of calls) {
      const r = await app.request(path, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.deepEqual(r.body, { status: 'locked', code: 'pnc-locked' }, `${method} ${path}`);
      assert.ok(!/Secret|Path|2026-10-31/.test(r.text));
    }
    const now = app.db.prepare('SELECT (SELECT COUNT(*) FROM events) || (SELECT COUNT(*) FROM players) || (SELECT version FROM cards)').pluck().get();
    assert.equal(now, before);
  });

  test('with the cookie: it works', async () => {
    const r = await app.request(`/api/boards/pnc-locked/cards/${cardId}/players`, { cookie: b.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.players.map((p) => p.name),
      ['Path'],
    );
  });
});
