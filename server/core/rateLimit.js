/**
 * In-memory sliding-window limiter, keyed by network (core/network.js). It survives nothing: a restart forgets every
 * count, which is fine for limits measured in minutes.
 *
 *   check(key)          → { ok, retryAfterMs }   is there room for one more?
 *   take(key)           → slot | null           count one now (null when there's no room); a slot can be refunded
 *   refund(slot)                                 un-count a slot (a password that turned out to be right)
 *
 * take() is what makes concurrent attempts safe: each one claims its place before any slow work (hashing) starts, so
 * ten in flight at once can't all slip under a limit of ten.
 *
 * Memory is bounded: past maxKeys networks, expired entries are swept and then the oldest-touched dropped.
 */
export function createLimiter({ limit, windowMs, now = Date.now, maxKeys = 50_000 }) {
  const hits = new Map(); // key → ascending timestamps within the window

  const live = (key) => {
    const list = hits.get(key);
    if (!list) return [];
    const from = now() - windowMs;
    while (list.length && list[0] <= from) list.shift();
    if (!list.length) hits.delete(key);
    return list;
  };

  const sweep = () => {
    for (const key of hits.keys()) live(key);
    for (const key of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(key);
    }
  };

  const check = (key) => {
    const list = live(key);
    if (list.length < limit) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: Math.max(1000, list[list.length - limit] + windowMs - now()) };
  };

  return {
    limit,
    windowMs,
    check,
    take(key) {
      if (!check(key).ok) return null;
      const at = now();
      const list = hits.get(key) ?? [];
      list.push(at);
      // Re-insert so Map order is "least recently touched first" for the sweep.
      hits.delete(key);
      hits.set(key, list);
      if (hits.size > maxKeys) sweep();
      return { key, at };
    },
    refund(slot) {
      if (!slot) return;
      const list = hits.get(slot.key);
      const i = list ? list.indexOf(slot.at) : -1;
      if (i >= 0) list.splice(i, 1);
      if (list && !list.length) hits.delete(slot.key);
    },
    size: () => hits.size,
  };
}

export const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * The app's limits. One instance per app: the password limiter is the ONE shared counter that both the lock screen and
 * Settings' current-password checks use, so a failure in one place counts against the other.
 */
export function createLimits({ now = Date.now } = {}) {
  return {
    // Wrong board passwords: 10 per network per 15 minutes, across every board and every place a password is checked.
    passwords: createLimiter({ limit: 10, windowMs: FIFTEEN_MINUTES, now }),
    // Codes that don't exist (and creation attempts): 30 per network per 15 minutes.
    lookups: createLimiter({ limit: 30, windowMs: FIFTEEN_MINUTES, now }),
  };
}
