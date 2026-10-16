import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../boards/events.js';
import { appendEvent, cleanActor, declareEventType, declaredEventTypes, listEvents } from '../core/events.js';
import { z } from 'zod';
import { memoryDb } from './helpers.js';

function boardIn(db) {
  return Number(db.prepare("INSERT INTO boards (code) VALUES ('events-test')").run().lastInsertRowid);
}

test('event types declare themselves; undeclared types and stray payload fields are refused', () => {
  const db = memoryDb();
  const boardId = boardIn(db);
  assert.ok(declaredEventTypes().includes('board.created'));
  assert.throws(() => appendEvent(db, { boardId, type: 'card.teleported', payload: {} }), /never declared/);
  assert.throws(() => appendEvent(db, { boardId, type: 'board.created', payload: { hasPassword: true, password: 'oops' } }), /password/);
  assert.throws(() => appendEvent(db, { boardId, type: 'board.created', payload: {} }), /hasPassword/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM events').pluck().get(), 0);
  assert.ok(appendEvent(db, { boardId, type: 'board.created', payload: { hasPassword: false } }) > 0);

  assert.throws(() => declareEventType({ type: 'board.created', payload: z.object({}) }), /declared twice/);
  assert.throws(() => declareEventType({ type: 'Bad-Type', payload: z.object({}) }), /noun\.verb/);
});

test('a later feature declares its own type and can log it straight away', () => {
  const db = memoryDb();
  const boardId = boardIn(db);
  const type = declareEventType({ type: 'test_thing.happened', restorable: true, payload: z.object({ n: z.number() }) });
  appendEvent(db, { boardId, type, actor: 'Path', payload: { n: 1 } });
  const [event] = listEvents(db, boardId).events;
  assert.equal(event.type, 'test_thing.happened');
  assert.equal(event.restorable, true);
  assert.deepEqual(event.payload, { n: 1 });
});

test('history pages newest first with a cursor, never unbounded', () => {
  const db = memoryDb();
  const boardId = boardIn(db);
  for (let i = 0; i < 7; i++) appendEvent(db, { boardId, type: 'board.created', payload: { hasPassword: i % 2 === 0 } });
  const seen = [];
  let cursor = null;
  do {
    const page = listEvents(db, boardId, { limit: 3, before: cursor });
    assert.ok(page.events.length <= 3);
    seen.push(...page.events.map((e) => e.id));
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1]);
  assert.equal(listEvents(db, boardId, { limit: 100000 }).events.length, 7);
});

test('display names are labels: trimmed, collapsed, capped, "Someone" when blank', () => {
  assert.equal(cleanActor('  Path   the\n Bold '), 'Path the Bold');
  assert.equal(cleanActor(''), 'Someone');
  assert.equal(cleanActor(undefined), 'Someone');
  assert.equal(cleanActor({ name: 'x' }), 'Someone');
  assert.equal(cleanActor('x'.repeat(50)).length, 32);
});
