import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MAX_PLAYERS } from '../core/cardDetail.js';
import { MAX_CARDS, cardLimitMessage } from '../core/cardRules.js';
import { declaredEventTypes, eventType } from '../core/events.js';
import { startApp } from './helpers.js';

const PW = 'raid night 8pm';

async function board(app, code, password) {
  const made = await app.request('/api/boards', { method: 'POST', body: { code, password, actor: 'Path' } });
  assert.equal(made.status, 201);
  return { cookie: made.cookie, id: app.db.prepare('SELECT id FROM boards WHERE code = ?').pluck().get(code) };
}

/** Every event row as stored, oldest first: what "never rewrites history" is checked against. */
const rawEvents = (app) => app.db.prepare('SELECT id, board_id, type, actor, payload, created_at, restores FROM events ORDER BY id').all();

/** A small API for one board. */
function on(app, code, cookie) {
  const call = (path, opts = {}) => app.request(`/api/boards/${code}${path}`, { cookie, ...opts });
  return {
    call,
    add: async (title, lane = 'up_next', extra = {}) =>
      (await call('/cards', { method: 'POST', body: { title, lane, actor: 'Path', ...extra } })).body.card,
    card: async (id) => (await call('/cards')).body.cards.find((c) => c.id === id) ?? null,
    lane: async (lane) => (await call('/cards')).body.cards.filter((c) => c.lane === lane).map((c) => c.title),
    edit: async (card, changes, actor = 'Kaelis') => (await call(`/cards/${card.id}`, { method: 'PATCH', body: { ...changes, version: card.version, actor } })).body.card,
    move: async (card, lane, index, actor = 'Bunzato') => (await call(`/cards/${card.id}/move`, { method: 'POST', body: { lane, index, actor } })).body.card,
    del: async (card, actor = 'Someone') => call(`/cards/${card.id}`, { method: 'DELETE', body: { version: card.version, actor } }),
    sign: async (card, name) => (await call(`/cards/${card.id}/players`, { method: 'POST', body: { name, actor: 'Path' } })),
    unsign: async (card, player, actor = 'Path') => call(`/cards/${card.id}/players/${player.id}`, { method: 'DELETE', body: { actor } }),
    players: async (card) => (await call(`/cards/${card.id}/players`)).body.players.map((p) => p.name),
    history: async (query = '') => (await call(`/history${query}`)).body,
    latest: async (type) => (await call('/history?limit=100')).body.events.find((e) => e.type === type),
    preview: (eventId, withCard = false) => call(`/history/${eventId}/restore${withCard ? '?withCard=1' : ''}`),
    // Confirm-and-restore, as the sheet does it: fetch the preview, then send its token back.
    restore: async (eventId, { withCard = false, actor = 'Larias' } = {}) => {
      const p = await call(`/history/${eventId}/restore${withCard ? '?withCard=1' : ''}`);
      if (p.status !== 200) return p;
      return call(`/history/${eventId}/restore`, { method: 'POST', body: { token: p.body.preview.token, withCard, actor } });
    },
  };
}

/** The new rows a change appended, and a check that every row before it is exactly as it was. */
function appendedSince(app, snapshot) {
  const now = rawEvents(app);
  assert.deepEqual(now.slice(0, snapshot.length), snapshot, 'every earlier event is unchanged, byte for byte');
  return now.slice(snapshot.length).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

describe('History: the log, newest first, each line declared by its type', () => {
  let app;
  let b;
  let api;
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-history');
    api = on(app, 'pnc-history', b.cookie);
  });
  after(() => app.close());

  test('a new board has one change, its creation, which is not restorable', async () => {
    const h = await api.history();
    assert.equal(h.events.length, 1);
    assert.equal(h.next, null);
    const [e] = h.events;
    assert.equal(e.type, 'board.created');
    assert.equal(e.actor, 'Path');
    assert.deepEqual(e.line, { verb: 'created the board', subject: '', detail: '' });
    assert.equal(e.restorable, false);
    assert.equal(e.restoredBy, null);
    assert.equal(e.restores, null);
  });

  test('lines read as sentences, and only the agreed types offer Restore', async () => {
    const valheim = await api.add('Valheim', 'now_playing');
    await api.move(valheim, 'played', 0);
    await api.sign(valheim, 'Larias');
    const removed = (await api.call(`/cards/${valheim.id}/players`)).body.players[0];
    await api.unsign(valheim, removed);
    const h = await api.history();
    const read = (e) => `${e.actor} ${e.line.verb} ${e.line.subject}${e.line.detail}`;
    assert.deepEqual(h.events.map(read), [
      'Path removed player Larias from Valheim',
      'Path added player Larias to Valheim',
      'Bunzato moved Valheim · Now Playing → Played',
      'Path added Valheim to Now Playing',
      'Path created the board ',
    ]);
    assert.deepEqual(
      h.events.map((e) => [e.type, e.restorable]),
      [
        ['player.removed', true],
        ['player.added', false],
        ['card.moved', true],
        ['card.created', false],
        ['board.created', false],
      ],
    );
    assert.equal(h.events.find((e) => e.type === 'player.removed').line.tone, 'del');
    // A restore that isn't offered is refused if asked for anyway.
    for (const type of ['board.created', 'card.created', 'player.added']) {
      const e = h.events.find((x) => x.type === type);
      const r = await api.preview(e.id);
      assert.equal(r.status, 409, type);
      assert.equal(r.body.code, 'not_restorable', type);
    }
  });

  test('every declared type says how it reads; the restorable ones say how they are undone', () => {
    const restorable = declaredEventTypes().filter((t) => eventType(t).restorable).sort();
    assert.deepEqual(restorable, [
      'card.deleted',
      'card.detail_edited',
      'card.edited',
      'card.moved',
      'card.restored',
      'player.removed',
      'player.restored',
    ]);
    for (const t of declaredEventTypes()) assert.equal(typeof eventType(t).line, 'function', t);
  });

  test('pages are 50 at a time with a cursor, never unbounded, and can be filtered to one card', async () => {
    const card = await api.add('Palworld');
    for (let i = 0; i < 99; i++) await api.sign(card, `Player ${i}`);
    const first = await api.history();
    assert.equal(first.events.length, 50);
    assert.ok(first.next);
    const second = await api.history(`?before=${encodeURIComponent(first.next)}`);
    assert.ok(second.events.length > 0);
    assert.ok(second.events.every((e) => e.id < first.events[49].id), 'the next page is older');
    assert.equal((await api.history('?limit=100000')).events.length, 100, 'never more than 100 in one answer');
    assert.equal((await api.call('/history?before=nope')).status, 400);

    const mine = await api.history(`?card=${card.id}&limit=100`);
    assert.deepEqual(mine.card, { id: card.id, title: 'Palworld', deleted: false });
    assert.equal(mine.events.length, 100);
    assert.equal(mine.next, null);
    assert.ok(mine.events.every((e) => e.cardId === card.id));
    assert.equal((await api.call('/history?card=99999')).status, 404);
  });
});

describe('Restore never rewrites history: it applies the undo and appends a new event', () => {
  let app;
  let b;
  let api;
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-restore');
    api = on(app, 'pnc-restore', b.cookie);
  });
  after(() => app.close());

  test('restoring a move: a new card.moved with before/after reversed, marked as a restore of that move', async () => {
    const enshrouded = await api.add('Enshrouded');
    const valheim = await api.add('Valheim');
    await api.add('Grounded');
    await api.move(valheim, 'now_playing', 0);
    const moved = await api.latest('card.moved');
    const snapshot = rawEvents(app);

    const p = await api.preview(moved.id);
    assert.equal(p.status, 200);
    assert.equal(p.body.preview.title, 'Move Valheim back?');
    assert.deepEqual(p.body.preview.rows, [
      { label: 'Lane', now: { kind: 'lane', value: 'now_playing' }, after: { kind: 'lane', value: 'up_next' } },
      { label: 'Position', now: { kind: 'place', value: { index: 0, of: 1 } }, after: { kind: 'place', value: { index: 1, of: 3 } } },
    ]);
    assert.deepEqual(p.body.preview.notes, []);

    const r = await api.restore(moved.id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { restored: true });
    const [added] = appendedSince(app, snapshot);
    assert.equal(added.type, 'card.moved');
    assert.equal(added.actor, 'Larias');
    assert.equal(added.restores, moved.id);
    const original = JSON.parse(snapshot.find((e) => e.id === moved.id).payload);
    assert.deepEqual(added.payload.before, original.after);
    assert.deepEqual(added.payload.after, original.before, 'back on its exact old key and index');
    assert.deepEqual(await api.lane('up_next'), ['Enshrouded', 'Valheim', 'Grounded']);
    assert.ok(enshrouded);

    // History shows the move as restored (no second Restore) and the restore as "Larias moved Valheim back".
    const h = await api.history();
    const was = h.events.find((e) => e.id === moved.id);
    assert.equal(was.restorable, false);
    assert.deepEqual(was.restoredBy, { id: added.id, actor: 'Larias', at: added.created_at });
    const restore = h.events.find((e) => e.id === added.id);
    assert.deepEqual(restore.restores, { id: moved.id, actor: 'Bunzato', at: moved.at });
    assert.equal(`${restore.actor} ${restore.line.verb} ${restore.line.subject}${restore.line.detail}`, 'Larias moved Valheim back to Up Next, 2nd');
    assert.equal(restore.restorable, true, 'a restore can itself be restored');
  });

  test('restoring a delete: the same card back, with its details and sign-ups, as a new card.restored', async () => {
    const conan = await api.add('Conan Exiles', 'played', { goLive: '2026-10-31', serverInfo: '198.51.100.7:8765' });
    await api.sign(conan, 'Grimtusk');
    const fresh = await api.card(conan.id);
    assert.equal((await api.del(fresh)).status, 200);
    const deleted = await api.latest('card.deleted');
    assert.equal(deleted.line.tone, 'del');
    const snapshot = rawEvents(app);

    const p = await api.preview(deleted.id);
    assert.equal(p.body.preview.title, 'Restore Conan Exiles?');
    assert.equal((await api.restore(deleted.id)).status, 200);
    const [added] = appendedSince(app, snapshot);
    assert.equal(added.type, 'card.restored');
    assert.equal(added.restores, deleted.id);
    assert.deepEqual(added.payload, {
      cardId: conan.id,
      card: { title: 'Conan Exiles', logo: null, lane: 'played', position: fresh.position, index: 0, goLive: '2026-10-31', serverInfo: '198.51.100.7:8765' },
    });
    const back = await api.card(conan.id);
    assert.equal(back.id, conan.id, 'the same card, not a copy');
    assert.equal(back.goLive, '2026-10-31');
    assert.deepEqual(await api.players(back), ['Grimtusk']);
  });

  test('restoring a removed player: the same player back in their old place, as a new player.restored', async () => {
    const vr = await api.add('V Rising', 'now_playing');
    for (const n of ['Aster', 'Larias', 'Bram']) await api.sign(vr, n);
    const larias = (await api.call(`/cards/${vr.id}/players`)).body.players[1];
    await api.unsign(vr, larias, 'Morrigan');
    const removed = await api.latest('player.removed');
    assert.equal(`${removed.actor} ${removed.line.verb} ${removed.line.subject}${removed.line.detail}`, 'Morrigan removed player Larias from V Rising');
    const snapshot = rawEvents(app);

    const p = await api.preview(removed.id);
    assert.equal(p.body.preview.title, 'Put Larias back on V Rising?');
    assert.deepEqual(p.body.preview.rows, [
      { label: 'Players', now: { kind: 'text', value: '2 signed up' }, after: { kind: 'text', value: '3, with Larias 2nd' } },
    ]);
    assert.equal((await api.restore(removed.id)).status, 200);
    const [added] = appendedSince(app, snapshot);
    assert.equal(added.type, 'player.restored');
    assert.equal(added.restores, removed.id);
    assert.deepEqual(added.payload, { cardId: vr.id, playerId: larias.id, name: 'Larias', position: 1 });
    assert.deepEqual(await api.players(vr), ['Aster', 'Larias', 'Bram'], 'back where they were');
  });

  test('restoring a restore undoes the undo (move, delete, player), each one more new event', async () => {
    // Move: the restore was a card.moved; restoring it moves the card forward again.
    const moveBack = (await api.history('?limit=100')).events.find((e) => e.type === 'card.moved' && e.restores);
    let snapshot = rawEvents(app);
    assert.equal((await api.restore(moveBack.id, { actor: 'Path' })).status, 200);
    let [added] = appendedSince(app, snapshot);
    assert.equal(added.type, 'card.moved');
    assert.equal(added.restores, moveBack.id);
    assert.equal(added.payload.after.lane, 'now_playing');

    // Delete: restoring the card.restored deletes the card again (a card.deleted), and that can be restored too.
    const cardBack = await api.latest('card.restored');
    snapshot = rawEvents(app);
    const p = await api.preview(cardBack.id);
    assert.equal(p.body.preview.title, 'Delete Conan Exiles again?');
    assert.equal((await api.restore(cardBack.id, { actor: 'Path' })).status, 200);
    [added] = appendedSince(app, snapshot);
    assert.equal(added.type, 'card.deleted');
    assert.equal(added.restores, cardBack.id);
    assert.equal(await api.card(cardBack.cardId), null);
    const again = (await api.history()).events.find((e) => e.id === added.id);
    assert.equal(`${again.actor} ${again.line.verb} ${again.line.subject}${again.line.detail}`, 'Path deleted Conan Exiles again, undoing a restore');
    assert.equal((await api.restore(added.id)).status, 200);
    assert.ok(await api.card(cardBack.cardId), 'and back once more');

    // Player: restoring the player.restored removes them again.
    const playerBack = await api.latest('player.restored');
    snapshot = rawEvents(app);
    assert.equal((await api.restore(playerBack.id, { actor: 'Path' })).status, 200);
    [added] = appendedSince(app, snapshot);
    assert.equal(added.type, 'player.removed');
    assert.equal(added.restores, playerBack.id);
  });

  test('an event is restored once: History shows it as restored, and a second restore is refused', async () => {
    const moved = (await api.history('?limit=100')).events.find((e) => e.type === 'card.moved' && !e.restores);
    assert.equal(moved.restorable, false);
    assert.ok(moved.restoredBy);
    const p = await api.preview(moved.id);
    assert.equal(p.status, 409);
    assert.equal(p.body.code, 'already_restored');
    assert.equal(p.body.restoredBy.actor, 'Larias');
    const post = await api.call(`/history/${moved.id}/restore`, { method: 'POST', body: { token: 'anything', actor: 'Path' } });
    assert.equal(post.status, 409);
    assert.equal(post.body.code, 'already_restored');
    // The database holds the rule too.
    assert.throws(
      () =>
        app.db
          .prepare("INSERT INTO events (board_id, type, actor, payload, restores) VALUES (?, 'card.moved', 'x', '{}', ?)")
          .run(b.id, moved.id),
      /UNIQUE/,
    );
    assert.throws(() => app.db.prepare('UPDATE events SET restores = NULL WHERE id = ?').run(moved.restoredBy.id), /append-only/);
  });

  test('a restore confirmed against an older board is not applied: the new confirmation comes back instead', async () => {
    const raft = await api.add('Raft');
    const edited = await api.edit(raft, { title: 'Raft 2' });
    const event = await api.latest('card.edited');
    const p = await api.preview(event.id);
    await api.edit(edited, { title: 'Raft 3' }, 'Path');
    const snapshot = rawEvents(app);
    const r = await api.call(`/history/${event.id}/restore`, { method: 'POST', body: { token: p.body.preview.token, actor: 'Larias' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'changed');
    assert.deepEqual(r.body.preview.rows, [{ label: 'Name', now: { kind: 'text', value: 'Raft 3' }, after: { kind: 'text', value: 'Raft' } }]);
    assert.deepEqual(appendedSince(app, snapshot), [], 'nothing written');
    const bad = await api.call(`/history/${event.id}/restore`, { method: 'POST', body: { actor: 'Larias' } });
    assert.equal(bad.status, 400);
  });
});

describe('Restore edge cases, each refused or explained plainly', () => {
  let app;
  let b;
  let api;
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-edges');
    api = on(app, 'pnc-edges', b.cookie);
  });
  after(() => app.close());

  test('an edit on a card deleted since: offers to bring the card back too, and does both', async () => {
    const sotf = await api.add('Sons of the Forest');
    const renamed = await api.edit(sotf, { title: 'Sons of the Forest II' });
    const edit = await api.latest('card.edited');
    await api.del(renamed);

    const asked = await api.preview(edit.id);
    assert.equal(asked.status, 409);
    assert.deepEqual(asked.body, {
      code: 'card_deleted',
      canRestoreCard: true,
      title: 'Sons of the Forest II',
      error: 'Sons of the Forest II has been deleted since this change.',
    });

    const p = await api.preview(edit.id, true);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.preview.rows[0], { label: 'Card', now: { kind: 'text', value: 'Deleted' }, after: { kind: 'text', value: 'Back on the board' } });
    assert.match(p.body.preview.notes[0], /comes back too: Up Next, 1st of 1/);

    const snapshot = rawEvents(app);
    assert.equal((await api.restore(edit.id, { withCard: true })).status, 200);
    const added = appendedSince(app, snapshot);
    assert.deepEqual(added.map((e) => e.type), ['card.restored', 'card.edited']);
    const deletion = JSON.parse(snapshot.findLast((e) => e.type === 'card.deleted').payload);
    assert.equal(deletion.cardId, sotf.id);
    assert.equal(added[0].restores, snapshot.findLast((e) => e.type === 'card.deleted').id, 'the card coming back restores its delete');
    assert.equal(added[1].restores, edit.id);
    assert.equal((await api.card(sotf.id)).title, 'Sons of the Forest');
  });

  test('a move on a card deleted since, on a full board: explains why the card can’t come back', async () => {
    const app2 = await startApp();
    try {
      const b2 = await board(app2, 'pnc-full');
      const api2 = on(app2, 'pnc-full', b2.cookie);
      const card = await api2.add('Valheim');
      const moved = await api2.move(card, 'played', 0);
      const move = await api2.latest('card.moved');
      await api2.del(moved);
      const del = await api2.latest('card.deleted');
      for (let i = 0; i < MAX_CARDS; i++) await api2.add(`Game ${i}`);
      const p = await api2.preview(move.id, true);
      assert.equal(p.status, 409);
      assert.equal(p.body.code, 'card_deleted');
      assert.equal(p.body.canRestoreCard, false);
      assert.equal(p.body.error, `Valheim has been deleted since, and it can’t come back: ${cardLimitMessage}`);

      // Restoring the delete itself at the cap: refused with the cap message.
      const r = await api2.preview(del.id);
      assert.equal(r.status, 409);
      assert.deepEqual(r.body, { code: 'card_limit', error: cardLimitMessage });
    } finally {
      await app2.close();
    }
  });

  test('an edit on a card changed since: only the fields that edit touched go back, shown as now vs restored', async () => {
    const card = await api.add('Satisfactory', 'up_next', { goLive: '2026-10-31', serverInfo: '198.51.100.7:8765' });
    const one = await api.edit(card, { goLive: '2026-11-07', serverInfo: '198.51.100.7:8766' });
    const detail = await api.latest('card.detail_edited');
    const two = await api.edit(one, { title: 'Satisfactory 1.0', serverInfo: '198.51.100.7:9000' }, 'Path');

    const p = await api.preview(detail.id);
    assert.equal(p.status, 200);
    assert.equal(p.body.preview.title, 'Restore Satisfactory 1.0?');
    assert.deepEqual(p.body.preview.rows, [
      { label: 'Go-live', now: { kind: 'date', value: '2026-11-07' }, after: { kind: 'date', value: '2026-10-31' } },
      { label: 'Server info', now: { kind: 'info', value: '198.51.100.7:9000' }, after: { kind: 'info', value: '198.51.100.7:8765' } },
    ]);
    assert.match(p.body.preview.notes.join(' '), /has been changed since\. Only what this change touched goes back/);
    assert.equal((await api.restore(detail.id)).status, 200);
    const now = await api.card(card.id);
    assert.equal(now.title, 'Satisfactory 1.0', 'the later rename stays');
    assert.equal(now.goLive, '2026-10-31');
    assert.equal(now.serverInfo, '198.51.100.7:8765');
    assert.ok(two);
  });

  test('a move back into a lane that has changed: as close as the lane allows, and the confirmation says so', async () => {
    const a = await api.add('Ark', 'played');
    const r = await api.add('Rust', 'played');
    const t = await api.add('Terraria', 'played');
    await api.move(t, 'now_playing', 0); // Terraria was 3rd in Played
    const move = await api.latest('card.moved');
    await api.move(r, 'up_next', 0); // Played is now just Ark
    const p = await api.preview(move.id);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.preview.rows[1].after, { kind: 'place', value: { index: 1, of: 2 } });
    assert.deepEqual(p.body.preview.notes, ['Played has changed since, so Terraria goes 2nd, as close to where it was as the lane allows.']);
    assert.equal((await api.restore(move.id)).status, 200);
    assert.deepEqual(await api.lane('played'), ['Ark', 'Terraria']);
    assert.ok(a);
  });

  test('a card already where the move put it back: nothing to restore, said plainly', async () => {
    const card = await api.add('Core Keeper', 'up_next');
    const moved = await api.move(card, 'played', 0);
    const move = await api.latest('card.moved');
    await api.move(moved, 'up_next', 99, 'Path');
    const p = await api.preview(move.id);
    assert.equal(p.status, 409);
    assert.deepEqual(p.body, { code: 'nothing_to_restore', error: 'Core Keeper is already there.' });
  });

  test('a removed player whose name has signed up again: refused, saying they’re already signed up', async () => {
    const card = await api.add('Lethal Company');
    await api.sign(card, 'Larias');
    const larias = (await api.call(`/cards/${card.id}/players`)).body.players[0];
    await api.unsign(card, larias);
    const removed = await api.latest('player.removed');
    await api.sign(card, 'LARIAS');
    const p = await api.preview(removed.id);
    assert.equal(p.status, 409);
    assert.deepEqual(p.body, { code: 'player_exists', error: 'LARIAS is already signed up.' });
  });

  test(`a removed player on a card with ${MAX_PLAYERS} players: refused with the cap message`, async () => {
    const card = await api.add('Phasmophobia');
    await api.sign(card, 'Larias');
    const larias = (await api.call(`/cards/${card.id}/players`)).body.players[0];
    await api.unsign(card, larias);
    const removed = await api.latest('player.removed');
    for (let i = 0; i < MAX_PLAYERS; i++) assert.equal((await api.sign(card, `P${i}`)).status, 201);
    const p = await api.preview(removed.id);
    assert.equal(p.status, 409);
    assert.deepEqual(p.body, { code: 'player_limit', error: `This card has ${MAX_PLAYERS} players, the most a card can hold.` });
  });

  test('an unknown event, or another board’s event, is "no such change"', async () => {
    const other = await startApp();
    try {
      assert.equal((await api.preview(999999)).status, 404);
      assert.equal((await api.preview('abc')).body.code, 'event_gone');
      // Event 1 on this database is this board's creation; on a fresh board on the same app it isn't theirs.
      const b2 = await board(app, 'pnc-other');
      const theirs = app.db.prepare('SELECT id FROM events WHERE board_id = ? LIMIT 1').pluck().get(b2.id);
      assert.equal((await api.preview(theirs)).status, 404);
    } finally {
      await other.close();
    }
  });
});

describe('History and Restore on a locked board answer only "locked"', () => {
  let app;
  let b;
  let eventId;
  before(async () => {
    app = await startApp();
    b = await board(app, 'pnc-vault', PW);
    const api = on(app, 'pnc-vault', b.cookie);
    const card = await api.add('Secret game');
    await api.move(card, 'played', 0, 'Path');
    eventId = (await api.latest('card.moved')).id;
  });
  after(() => app.close());

  test('without access: the same bare answer to every History path and method, and nothing written', async () => {
    const before = rawEvents(app);
    const calls = [
      ['GET', '/history'],
      ['GET', '/history?limit=1'],
      ['GET', '/history?card=1'],
      ['GET', `/history/${eventId}/restore`],
      ['GET', `/history/${eventId}/restore?withCard=1`],
      ['POST', `/history/${eventId}/restore`, { token: 'x', actor: 'Intruder' }],
      ['GET', '/history/999/restore'],
      ['GET', '/history/anything/else'],
    ];
    for (const [method, path, body] of calls) {
      const r = await app.request(`/api/boards/pnc-vault${path}`, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.deepEqual(r.body, { status: 'locked', code: 'pnc-vault' }, `${method} ${path}`);
      assert.ok(!/Secret|Path|played|card\./i.test(r.text), `${method} ${path} leaks nothing`);
    }
    assert.deepEqual(rawEvents(app), before);
  });

  test('with access: it works', async () => {
    const r = await app.request('/api/boards/pnc-vault/history', { cookie: b.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.events[0].type, 'card.moved');
  });
});
