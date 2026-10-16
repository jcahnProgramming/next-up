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

  test('editing logs before and after; changing lane too logs a move, to the bottom of the new lane', async () => {
    const add = await api('', { method: 'POST', body: { title: 'Palworld', lane: 'up_next' } });
    await api('', { method: 'POST', body: { title: 'Enshrouded', lane: 'played' } });
    const card = add.body.card;

    const edit = await api(`/${card.id}`, { method: 'PATCH', body: { version: 1, title: 'Palworld (modded)', logo: 'palworld', lane: 'played', actor: 'Bunzato' } });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.card.version, 2);
    assert.equal(edit.body.card.lane, 'played');
    const played = (await api()).body.cards.filter((c) => c.lane === 'played');
    assert.equal(played[played.length - 1].id, card.id, 'moved to the bottom of Played');

    // The name and logo are an edit (its lane unchanged); the lane is a move. Both restorable, both by Bunzato.
    const [moved, edited] = eventsOf(app, b.id);
    assert.equal(edited.type, 'card.edited');
    assert.equal(edited.actor, 'Bunzato');
    assert.equal(edited.restorable, true);
    assert.deepEqual(edited.payload.before, { title: 'Palworld', logo: null, lane: 'up_next', position: card.position, index: 0 });
    assert.deepEqual(edited.payload.after, { title: 'Palworld (modded)', logo: 'palworld', lane: 'up_next', position: card.position, index: 0 });
    assert.equal(moved.type, 'card.moved');
    assert.equal(moved.actor, 'Bunzato');
    assert.equal(moved.restorable, true);
    assert.deepEqual(moved.payload, {
      cardId: card.id,
      before: { lane: 'up_next', position: card.position, index: 0 },
      after: { lane: 'played', position: edit.body.card.position, index: played.length - 1 },
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

describe('moving cards (drag and drop, keyboard, the Lane dropdown)', () => {
  let app;
  let b;
  const CODE = 'pnc-moves';
  const api = (path = '', opts = {}) => app.request(`/api/boards/${CODE}/cards${path}`, opts);
  const add = async (title, lane) => (await api('', { method: 'POST', body: { title, lane } })).body.card;
  const move = (card, body) => api(`/${card.id}/move`, { method: 'POST', body });
  const titles = async (lane) => (await api()).body.cards.filter((c) => c.lane === lane).map((c) => c.title);
  // Every card row on every board, as the database holds it: what a write could have touched.
  const rows = () => app.db.prepare('SELECT id, board_id, lane, position, title, logo, version, updated_at, deleted_at FROM cards ORDER BY id').all();
  const changedRows = (before, after) => after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map((r) => r.id);

  before(async () => {
    app = await startApp();
    b = await board(app, CODE);
    for (const t of ['Palworld', 'V Rising', 'Enshrouded', 'Conan Exiles']) await add(t, 'up_next');
    for (const t of ['Valheim', 'Snowrunner']) await add(t, 'now_playing');
  });
  after(() => app.close());

  test('a drop within a lane writes exactly one card row and logs card.moved with before and after', async () => {
    const cards = (await api()).body.cards;
    const conan = cards.find((c) => c.title === 'Conan Exiles');
    const was = rows();
    const events = eventsOf(app, b.id).length;

    // Conan Exiles (4th) goes between Palworld and V Rising: index 1 among the lane's other cards.
    const r = await move(conan, { lane: 'up_next', index: 1, afterId: cards.find((c) => c.title === 'Palworld').id, actor: 'Path' });
    assert.equal(r.status, 200);
    assert.equal(r.body.moved, true);
    assert.equal(r.body.rebalanced, undefined);
    assert.equal(r.body.card.version, 2);
    assert.deepEqual(await titles('up_next'), ['Palworld', 'Conan Exiles', 'V Rising', 'Enshrouded']);

    assert.deepEqual(changedRows(was, rows()), [conan.id], 'only the moved card’s row changed');
    const all = eventsOf(app, b.id);
    assert.equal(all.length, events + 1);
    const [moved] = all;
    assert.equal(moved.type, 'card.moved');
    assert.equal(moved.actor, 'Path');
    assert.equal(moved.restorable, true);
    assert.deepEqual(moved.payload, {
      cardId: conan.id,
      before: { lane: 'up_next', position: conan.position, index: 3 },
      after: { lane: 'up_next', position: r.body.card.position, index: 1 },
    });
  });

  test('a drop into another lane, at any position, also writes only that card', async () => {
    const cards = (await api()).body.cards;
    const vRising = cards.find((c) => c.title === 'V Rising');
    const valheim = cards.find((c) => c.title === 'Valheim');
    const was = rows();
    const r = await move(vRising, { lane: 'now_playing', index: 1, afterId: valheim.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.lane, 'now_playing');
    assert.deepEqual(await titles('now_playing'), ['Valheim', 'V Rising', 'Snowrunner']);
    assert.deepEqual(await titles('up_next'), ['Palworld', 'Conan Exiles', 'Enshrouded']);
    assert.deepEqual(changedRows(was, rows()), [vRising.id]);
    const [moved] = eventsOf(app, b.id);
    assert.equal(moved.actor, 'Someone');
    assert.deepEqual(moved.payload.before, { lane: 'up_next', position: vRising.position, index: 2 });
    assert.deepEqual(moved.payload.after, { lane: 'now_playing', position: r.body.card.position, index: 1 });

    // To the top (afterId null) and the bottom (index past the end) of an empty lane alike.
    const top = await move(r.body.card, { lane: 'played', index: 0, afterId: null });
    assert.equal(top.body.card.lane, 'played');
    assert.deepEqual(await titles('played'), ['V Rising']);
  });

  test('dropping a card back where it started changes nothing and logs nothing', async () => {
    const cards = (await api()).body.cards;
    const palworld = cards.find((c) => c.title === 'Palworld');
    const conan = cards.find((c) => c.title === 'Conan Exiles');
    const was = rows();
    const events = eventsOf(app, b.id).length;
    for (const body of [
      { lane: 'up_next', index: 0 },
      { lane: 'up_next', index: 0, afterId: null },
    ]) {
      const r = await move(palworld, body);
      assert.equal(r.status, 200);
      assert.equal(r.body.moved, false);
      assert.equal(r.body.card.version, palworld.version);
    }
    // Conan Exiles is 2nd: "after Palworld" is where it already is.
    assert.equal((await move(conan, { lane: 'up_next', index: 1, afterId: palworld.id })).body.moved, false);
    assert.deepEqual(rows(), was);
    assert.equal(eventsOf(app, b.id).length, events);
  });

  test('afterId keeps the mover’s intent when the lane changed under them; the index is the fallback', async () => {
    const cards = (await api()).body.cards;
    const enshrouded = cards.find((c) => c.title === 'Enshrouded');
    const valheim = cards.find((c) => c.title === 'Valheim');
    // The mover saw Now Playing as [Valheim, V Rising, Snowrunner] and dropped after Valheim, index 1; meanwhile
    // someone added a card at the top... simulated by an index that no longer matches: afterId wins.
    const r = await move(enshrouded, { lane: 'now_playing', index: 0, afterId: valheim.id });
    assert.deepEqual(await titles('now_playing'), ['Valheim', 'Enshrouded', 'Snowrunner']);
    // An afterId that isn't in that lane (moved away or deleted) falls back to the index, clamped to the lane.
    const back = await move(r.body.card, { lane: 'up_next', index: 99, afterId: valheim.id });
    assert.equal(back.status, 200);
    assert.deepEqual(await titles('up_next'), ['Palworld', 'Conan Exiles', 'Enshrouded']);
  });

  test('two people moving the same card at nearly the same time: the later write wins, both are logged', async () => {
    const card = (await api()).body.cards.find((c) => c.title === 'Snowrunner');
    const events = eventsOf(app, b.id).length;
    // Both started from the same version; moves name none, so neither is refused.
    const first = await move(card, { lane: 'played', index: 0, actor: 'Path' });
    const second = await move(card, { lane: 'up_next', index: 0, actor: 'Bunzato' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await api()).body.cards.find((c) => c.id === card.id).lane, 'up_next');
    const [later, earlier] = eventsOf(app, b.id);
    assert.equal(eventsOf(app, b.id).length, events + 2);
    assert.deepEqual([earlier.actor, earlier.payload.after.lane], ['Path', 'played']);
    assert.deepEqual([later.actor, later.payload.before.lane, later.payload.after.lane], ['Bunzato', 'played', 'up_next']);
  });

  test('a move bumps the version, so an edit sheet opened before it gets the conflict, not a silent overwrite', async () => {
    const card = (await api()).body.cards.find((c) => c.title === 'Palworld');
    await move(card, { lane: 'played', index: 0 });
    const stale = await api(`/${card.id}`, { method: 'PATCH', body: { version: card.version, lane: 'up_next' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.card.lane, 'played');
  });

  test('bad moves are refused and write nothing; a deleted card says so', async () => {
    const card = (await api()).body.cards[0];
    const was = rows();
    for (const [body, field] of [
      [{ lane: 'backlog', index: 0 }, 'lane'],
      [{ index: 0 }, 'lane'],
      [{ lane: 'played' }, 'index'],
      [{ lane: 'played', index: -1 }, 'index'],
      [{ lane: 'played', index: 1.5 }, 'index'],
      [{ lane: 'played', index: '0' }, 'index'],
      [{ lane: 'played', index: 0, afterId: 'x' }, 'afterId'],
      [{ lane: 'played', index: 0, afterId: 0 }, 'afterId'],
    ]) {
      const r = await move(card, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.field, field, JSON.stringify(body));
    }
    assert.deepEqual(rows(), was);
    const doomed = await add('Doomed', 'up_next');
    await api(`/${doomed.id}`, { method: 'DELETE', body: { version: 1 } });
    const r = await move(doomed, { lane: 'played', index: 0 });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'card_gone');
    assert.equal((await api('/abc/move', { method: 'POST', body: { lane: 'played', index: 0 } })).status, 404);
    // Another board's card can't be moved through this one.
    await board(app, 'elsewhere');
    const theirs = (await app.request('/api/boards/elsewhere/cards', { method: 'POST', body: { title: 'Theirs', lane: 'up_next' } })).body.card;
    assert.equal((await move(theirs, { lane: 'played', index: 0 })).status, 404);
  });

  test('a gap whose key would pass the cap rebalances that one lane first, order kept, and says so', async () => {
    const lb = await board(app, 'tight-gap');
    const insert = app.db.prepare("INSERT INTO cards (board_id, lane, position, title) VALUES (?, ?, ?, ?)");
    // Two neighbours whose keys already differ only in the 64th character: nothing shorter than 65 fits between.
    insert.run(lb.id, 'up_next', `${'V'.repeat(63)}1`, 'Upper');
    insert.run(lb.id, 'up_next', `${'V'.repeat(63)}2`, 'Lower');
    insert.run(lb.id, 'played', 'V', 'Elsewhere');
    const mover = (await app.request('/api/boards/tight-gap/cards', { method: 'POST', body: { title: 'Mover', lane: 'played' } })).body.card;
    const lanePlayed = app.db.prepare("SELECT id, position FROM cards WHERE board_id = ? AND lane = 'played' AND id != ?").all(lb.id, mover.id);
    const upper = app.db.prepare("SELECT id FROM cards WHERE title = 'Upper'").pluck().get();

    const r = await app.request(`/api/boards/tight-gap/cards/${mover.id}/move`, { method: 'POST', body: { lane: 'up_next', index: 1, afterId: upper } });
    assert.equal(r.status, 200);
    assert.equal(r.body.rebalanced, true);
    const cards = (await app.request('/api/boards/tight-gap/cards')).body.cards;
    assert.deepEqual(cards.filter((c) => c.lane === 'up_next').map((c) => c.title), ['Upper', 'Mover', 'Lower']);
    assert.ok(cards.every((c) => c.position.length <= 2), cards.map((c) => c.position).join(','));
    // Only the target lane was rebalanced.
    assert.deepEqual(app.db.prepare("SELECT id, position FROM cards WHERE board_id = ? AND lane = 'played'").all(lb.id), lanePlayed);
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
    ['POST', `/cards/${cardId}/move`, { lane: 'played', index: 0 }],
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
