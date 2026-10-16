/**
 * Card order within a lane: fractional keys, so placing a card anywhere writes that one card and never renumbers the
 * lane.
 *
 * A key is a string of base-62 digits (0-9, A-Z, a-z, in that ASCII order) read as a fraction 0.d1d2d3…, never ending
 * in "0" (so there is always room before it). Plain string comparison orders keys (SQLite's default BINARY collation
 * agrees), and between any two keys there is always another:
 *
 *   keyBetween('V', 'W') → 'VV'      keyBetween(null, 'V') → 'G'      keyAfter('z') → 'z1'
 *
 * Keys grow by about one character for every six cards squeezed into the same gap, and appending at the bottom grows
 * them by one character per 61 cards. Keys are capped at MAX_KEY characters (the database refuses longer ones); a
 * placement that would pass the cap rebalances the lane first (rebalance(): evenly spaced short keys, same order).
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
export const MAX_KEY = 64;
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export const isKey = (k) => typeof k === 'string' && k.length <= MAX_KEY && KEY.test(k);

const digit = (i) => DIGITS[i];
const value = (ch) => DIGITS.indexOf(ch);

/** A key strictly between a and b (either may be null: the start or end of the lane). */
export function keyBetween(a, b) {
  if (a !== null && !isKey(a)) throw new Error('keyBetween: bad lower key');
  if (b !== null && !isKey(b)) throw new Error('keyBetween: bad upper key');
  if (a !== null && b !== null && a >= b) throw new Error('keyBetween: keys out of order');
  if (b === null) return keyAfter(a);
  return midpoint(a ?? '', b);
}

/** The shortest key after a (the bottom of a lane). The first card in a lane gets 'V', a little past the middle. */
export function keyAfter(a) {
  if (a === null || a === undefined) return 'V';
  // Bump the last digit of the shortest prefix that can take it: 'V' → 'W', 'z' → 'z1', 'zz' → 'zz1'.
  for (let len = 1; ; len++) {
    const prefix = a.slice(0, len).padEnd(len, '0');
    const last = value(prefix[len - 1]);
    if (last < BASE - 1) return prefix.slice(0, -1) + digit(last + 1);
  }
}

// a < b as fractions; a may be '' (zero), b null means one. Neither ends in '0'.
function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? value(a[0]) : 0;
  const db = b !== null ? value(b[0]) : BASE;
  if (db - da > 1) return digit(Math.round((da + db) / 2));
  // Neighbouring first digits: b's first digit alone fits if b goes on; otherwise extend a.
  if (b !== null && b.length > 1) return b[0];
  return digit(da) + midpoint(a.slice(1), null);
}

/** Whether a key needs the lane rebalanced before use. */
export const tooLong = (key) => key.length > MAX_KEY;

/** n evenly spaced keys, in order, as short as n allows (two digits holds 3,843). For rebalancing a lane. */
export function spreadKeys(n) {
  if (n <= 0) return [];
  const width = n < BASE - 1 ? 1 : 2;
  const room = BASE ** width - 1;
  const keys = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.round((i * room) / (n + 1));
    let s = '';
    for (let w = 0; w < width; w++) {
      s = digit(v % BASE) + s;
      v = Math.floor(v / BASE);
    }
    keys.push(s.replace(/0+$/, ''));
  }
  return keys;
}
