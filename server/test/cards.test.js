import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MAX_CARDS, checkTitle } from '../core/cardRules.js';
import { listEvents } from '../core/events.js';
import { hashPassword } from '../core/passwords.js';
import { startApp } from './helpers.js';

const PW = 'raid night 8pm';

async function board(app, code, password) {
  const made = await app.request('/api/boards', { method: 'POST', body: { code, password } });
  assert.equal(made.status, 201);
  const id = app.db.prepare('SELECT id FROM boards WHERE code = ?').pluck().get(code);
  return { cookie: made.cookie, id };
}

const eventsOf = (app, boardId) => listEvents(app.db, boardId, { limit: 200 }).events;

describe('cards on an open board', () => {
  let app;
  let b;
  const api = (path = '', opts = {}) => app.request(`/api/boards/pnc-autumn/cards${path}`, opts);
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-autumn');
  });
  after(() => app.close());

  test('a new board has no cards', async () => {
    const r = await api();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { cards: [], next: null, limit: MAX_CARDS });
  });

  test('adding puts the card at the bottom of its lane and logs card.created with the whole card', async () => {
    const one = await api('', { method: 'POST', body: { title: '  Valheim ', lane: 'now_playing', actor: 'Path' } });
    assert.equal(one.status, 201);
    assert.deepEqual(Object.keys(one.body.card).sort(), ['createdAt', 'id', 'lane', 'logo', 'position', 'title', 'updatedAt', 'version']);
    assert.equal(one.body.card.title, 'Valheim');
    assert.equal(one.body.card.logo, null);
    assert.equal(one.body.card.version, 1);
    const two = await api('', { method: 'POST', body: { title: 'V Rising', logo: 'v-rising', lane: 'now_playing' } });
    assert.ok(two.body.card.position > one.body.card.position, 'new cards go to the bottom');

    const [created2, created1] = eventsOf(app, b.id).filter((e) => e.type === 'card.created');
    assert.equal(created1.actor, 'Path');
    assert.equal(created2.actor, 'Someone');
    assert.deepEqual(created2.payload, {
      cardId: two.body.card.id,
      card: { title: 'V Rising', logo: 'v-rising', lane: 'now_playing', position: two.body.card.position, index: 1 },
    });
    assert.equal(created2.restorable, false);

    const list = await api();
    assert.deepEqual(list.body.cards.map((c) => c.title), ['Valheim', 'V Rising']);
  });

  test('bad input is refused per field and nothing is written', async () => {
    const before = app.db.prepare('SELECT COUNT(*) FROM cards').pluck().get();
    const cases = [
      [{ title: '', lane: 'up_next' }, 'title'],
      [{ title: '   ', lane: 'up_next' }, 'title'],
      [{ title: 'x'.repeat(61), lane: 'up_next' }, 'title'],
      [{ title: 42, lane: 'up_next' }, 'title'],
      [{ title: 'Palworld', lane: 'backlog' }, 'lane'],
      [{ title: 'Palworld' }, 'lane'],
      [{ title: 'Palworld', lane: 'up_next', logo: 'https://example.com/x.png' }, 'logo'],
      [{ title: 'Palworld', lane: 'up_next', logo: '../secrets' }, 'logo'],
      [{ title: 'Palworld', lane: 'up_next', logo: 'Palworld' }, 'logo'],
    ];
    for (const [body, field] of cases) {
      const r = await api('', { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.field, field, JSON.stringify(body));
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) FROM cards').pluck().get(), before);
    // 60 characters is fine, counted as characters people see, not bytes.
    assert.equal(checkTitle('é'.repeat(60)).ok, true);
    assert.equal((await api('', { method: 'POST', body: { title: 'ö'.repeat(60), lane: 'played' } })).status, 201);
  });

  test('editing logs before and after; changing lane puts the card at the bottom of the new lane', async () => {
    const add = await api('', { method: 'POST', body: { title: 'Palworld', lane: 'up_next' } });
    await api('', { method: 'POST', body: { title: 'Enshrouded', lane: 'played' } });
    const card = add.body.card;

    const edit = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, title: 'Palworld (modded)', logo: 'palworld', lane: 'played', actor: 'Bunzato' } });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.card.version, 2);
    assert.equal(edit.body.card.lane, 'played');
    const played = (await api()).body.cards.filter((c) => c.lane === 'played');
    assert.equal(played[played.length - 1].id, card.id, 'moved to the bottom of Played');

    const [edited] = eventsOf(app, b.id).filter((e) => e.type === 'card.edited');
    assert.equal(edited.actor, 'Bunzato');
    assert.equal(edited.restorable, true);
    assert.deepEqual(edited.payload.before, { title: 'Palworld', logo: null, lane: 'up_next', position: card.position, index: 0 });
    assert.deepEqual(edited.payload.after, {
      title: 'Palworld (modded)',
      logo: 'palworld',
      lane: 'played',
      position: edit.body.card.position,
      index: played.length - 1,
    });

    // Saving with nothing changed writes nothing.
    const count = eventsOf(app, b.id).length;
    const same = await api(`/${card.id}`, { method: 'PATCH', body: { version: 2, title: 'Palworld (modded)' } });
    assert.equal(same.body.card.version, 2);
    assert.equal(eventsOf(app, b.id).length, count);
  });

  test('an edit or delete from an old version is refused with the latest card, not applied', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'Soulmask', lane: 'up_next' } })).body.card;
    await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, title: 'Soulmask!' } });
    const stale = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, title: 'Mine' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'conflict');
    assert.equal(stale.body.card.title, 'Soulmask!');
    assert.equal(stale.body.card.version, 2);
    const staleDelete = await api(`/${card.id}`, { method: 'DELETE', body: { version: 1 } });
    assert.equal(staleDelete.status, 409);
    assert.equal((await api(`/${card.id}`, { method: 'PATCH', body: { title: 'No version' } })).status, 400);
  });

  test('deleting tombstones the card (the row stays) and logs the whole card', async () => {
    const card = (await api('', { method: 'POST', body: { title: 'Dune Awakening', lane: 'up_next' } })).body.card;
    const del = await api(`/${card.id}`, { method: 'DELETE', body: { version: 1, actor: 'Path' } });
    assert.equal(del.status, 200);
    assert.ok(!(await api()).body.cards.some((c) => c.id === card.id));
    const row = app.db.prepare('SELECT title, deleted_at FROM cards WHERE id = ?').get(card.id);
    assert.equal(row.title, 'Dune Awakening');
    assert.ok(row.deleted_at);

    const [deleted] = eventsOf(app, b.id).filter((e) => e.type === 'card.deleted');
    assert.equal(deleted.restorable, true);
    assert.equal(deleted.payload.cardId, card.id);
    assert.deepEqual(deleted.payload.card, { title: 'Dune Awakening', logo: null, lane: 'up_next', position: card.position, index: 1 });

    // Gone means gone: a second delete or an edit says so.
    assert.equal((await api(`/${card.id}`, { method: 'DELETE', body: { version: 2 } })).body.code, 'card_gone');
    assert.equal((await api(`/${card.id}`, { method: 'PATCH', body: { version: 2, title: 'x' } })).status, 404);
    assert.equal((await api('/abc', { method: 'PATCH', body: { version: 1, title: 'x' } })).status, 404);
    // The database refuses a hard delete of a live board's card.
    assert.throws(() => app.db.prepare('DELETE FROM cards WHERE id = ?').run(card.id), /tombstoned/);
  });

  test('a card on one board cannot be edited through another', async () => {
    await board(app, 'other-board');
    const card = (await api('', { method: 'POST', body: { title: 'Snowrunner', lane: 'up_next' } })).body.card;
    const r = await app.request(`/api/boards/other-board/cards/${card.id}`, { method: 'PATCH', body: { version: 1, title: 'Hijack' } });
    assert.equal(r.status, 404);
    assert.equal(app.db.prepare('SELECT title FROM cards WHERE id = ?').pluck().get(card.id), 'Snowrunner');
  });

  test('listing pages with a cursor in lane order, never more than the cap at once', async () => {
    const seen = [];
    let cursor = null;
    do {
      const r = await api(`?limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
      assert.ok(r.body.cards.length <= 2);
      seen.push(...r.body.cards.map((c) => c.id));
      cursor = r.body.next;
    } while (cursor);
    const all = (await api('?limit=100000')).body.cards.map((c) => c.id);
    assert.deepEqual(seen, all);
    assert.equal((await api('?after=nonsense')).status, 400);
  });
});

describe(`the card cap: ${MAX_CARDS} live cards per board`, () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  test('the next card is refused plainly; deleting one makes room', async () => {
    const b = await board(app, 'full-board');
    // Fill straight in the database (fast), then go through the API for the last one.
    const insert = app.db.prepare("INSERT INTO cards (board_id, lane, position, title) VALUES (?, 'up_next', ?, ?)");
    for (let i = 1; i < MAX_CARDS; i++) insert.run(b.id, `V${i}x`, `Game ${i}`);
    const last = await app.request('/api/boards/full-board/cards', { method: 'POST', body: { title: 'The 200th', lane: 'played' } });
    assert.equal(last.status, 201);
    const over = await app.request('/api/boards/full-board/cards', { method: 'POST', body: { title: 'One more', lane: 'played' } });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'card_limit');
    assert.match(over.body.error, /200 games/);

    await app.request(`/api/boards/full-board/cards/${last.body.card.id}`, { method: 'DELETE', body: { version: 1 } });
    const again = await app.request('/api/boards/full-board/cards', { method: 'POST', body: { title: 'One more', lane: 'played' } });
    assert.equal(again.status, 201, 'deleted cards don’t count');
  });

  test('a lane whose last key is at the length cap is rebalanced, order kept, before the new card goes in', async () => {
    const b = await board(app, 'long-keys');
    const insert = app.db.prepare("INSERT INTO cards (board_id, lane, position, title) VALUES (?, 'up_next', ?, ?)");
    insert.run(b.id, 'V', 'First');
    insert.run(b.id, 'z'.repeat(64), 'Second');
    const r = await app.request('/api/boards/long-keys/cards', { method: 'POST', body: { title: 'Third', lane: 'up_next' } });
    assert.equal(r.status, 201);
    const cards = (await app.request('/api/boards/long-keys/cards')).body.cards;
    assert.deepEqual(cards.map((c) => c.title), ['First', 'Second', 'Third']);
    assert.ok(cards.every((c) => c.position.length <= 2), cards.map((c) => c.position).join(','));
  });

  test('another board is not affected', async () => {
    await board(app, 'roomy-board');
    const r = await app.request('/api/boards/roomy-board/cards', { method: 'POST', body: { title: 'Fine', lane: 'up_next' } });
    assert.equal(r.status, 201);
  });
});

describe('a locked board’s cards answer only "locked"', () => {
  let app;
  let b;
  let cardId;
  const LOCKED = { status: 'locked', code: 'pnc-raids' };
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-raids', PW);
    const made = await app.request('/api/boards/pnc-raids/cards', { method: 'POST', body: { title: 'Secret Raid Game', lane: 'up_next' }, cookie: b.cookie });
    assert.equal(made.status, 201);
    cardId = made.body.card.id;
  });
  after(() => app.close());

  const attempts = () => [
    ['GET', '/cards', undefined],
    ['GET', '/cards?limit=1', undefined],
    ['POST', '/cards', { title: 'Sneaky', lane: 'up_next' }],
    ['PATCH', `/cards/${cardId}`, { version: 1, title: 'Sneaky' }],
    ['DELETE', `/cards/${cardId}`, { version: 1 }],
    ['PATCH', '/cards/999', { version: 1, title: 'Sneaky' }],
  ];

  test('without access: every card call is 403 { status, code } and writes nothing', async () => {
    const before = { cards: app.db.prepare('SELECT COUNT(*) FROM cards').pluck().get(), events: eventsOf(app, b.id).length };
    for (const [method, path, body] of attempts()) {
      const r = await app.request(`/api/boards/pnc-raids${path}`, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.deepEqual(r.body, LOCKED, `${method} ${path}`);
      assert.ok(!/Secret|title|lane|card/i.test(r.text), r.text);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) FROM cards').pluck().get(), before.cards);
    assert.equal(app.db.prepare('SELECT title FROM cards WHERE id = ?').pluck().get(cardId), 'Secret Raid Game');
    assert.equal(eventsOf(app, b.id).length, before.events);
  });

  test('with a grant from before the password changed: "the password changed", nothing else', async () => {
    app.db
      .prepare('UPDATE boards SET password_hash = ?, password_version = password_version + 1 WHERE id = ?')
      .run(await hashPassword('a whole new password'), b.id);
    for (const [method, path, body] of attempts()) {
      const r = await app.request(`/api/boards/pnc-raids${path}`, { method, body, cookie: b.cookie });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.deepEqual(r.body, { ...LOCKED, reason: 'password_changed' }, `${method} ${path}`);
    }
    assert.equal(app.db.prepare('SELECT title FROM cards WHERE id = ?').pluck().get(cardId), 'Secret Raid Game');
  });
});
