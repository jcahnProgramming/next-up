import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_KEY, isKey, keyAfter, keyBetween, spreadKeys } from '../core/positions.js';

test('keys order as plain strings, and there is always one between two others', () => {
  assert.equal(keyAfter(null), 'V');
  assert.equal(keyAfter('V'), 'W');
  assert.equal(keyAfter('z'), 'z1');
  assert.equal(keyAfter('zz'), 'zz1');
  assert.equal(keyBetween('V', 'W'), 'VV');
  assert.equal(keyBetween(null, 'V'), 'G');
  assert.equal(keyBetween('V', null), 'W');
  assert.throws(() => keyBetween('W', 'V'), /out of order/);
  assert.throws(() => keyBetween('V0', null), /bad lower key/);

  // Random insertions anywhere stay ordered, valid and short.
  let lane = [];
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  for (let i = 0; i < 2000; i++) {
    const at = rand(lane.length + 1);
    const key = keyBetween(lane[at - 1] ?? null, lane[at] ?? null);
    assert.ok(isKey(key), key);
    lane.splice(at, 0, key);
  }
  assert.deepEqual([...lane].sort(), lane);
  assert.equal(new Set(lane).size, lane.length);
  assert.ok(Math.max(...lane.map((k) => k.length)) <= 8, 'random reordering keeps keys short');
  lane = null;
});

test('appending 200 cards keeps keys under five characters', () => {
  let k = null;
  for (let i = 0; i < 200; i++) k = keyAfter(k);
  assert.ok(k.length <= 4, k);
});

test(`worst case: how many moves into the same gap before a key passes ${MAX_KEY} characters`, () => {
  // Always drop between the same card and the one just placed after it: the gap halves every time.
  const top = 'V';
  let below = 'W';
  let moves = 0;
  for (;;) {
    const key = keyBetween(top, below);
    if (key.length > MAX_KEY) break;
    below = key;
    moves++;
  }
  // Reported in the changelog / handover: rebalancing is needed only after this many adversarial moves in a row.
  assert.ok(moves > 300, `${moves}`);
  console.log(`# positions: ${moves} moves into one gap before a lane needs rebalancing`);
});

test('rebalancing spreads any number of cards over short, ordered keys', () => {
  for (const n of [1, 2, 60, 61, 200]) {
    const keys = spreadKeys(n);
    assert.equal(keys.length, n);
    assert.deepEqual([...keys].sort(), keys);
    assert.equal(new Set(keys).size, n);
    assert.ok(keys.every(isKey), keys.join(','));
    assert.ok(keys.every((k) => k.length <= 2));
  }
});
