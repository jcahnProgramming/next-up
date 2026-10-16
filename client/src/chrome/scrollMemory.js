/**
 * Scroll on navigation (the app uses BrowserRouter, which keeps whatever scroll position the window had, so a page
 * reached from the bottom bar opened scrolled to the bottom).
 *
 *   a new page (PUSH / REPLACE to another path)   → the top, and focus moves to the page's main heading
 *   Back / Forward (POP)                          → the position that page had when it was left
 *   the same page with another query or hash      → stays where it is (filters, ranges, settings groups)
 *
 * Positions are kept per history entry (location.key) in sessionStorage, so they survive a reload. Plain JS, so the
 * policy and the restore are tested in node (not yet tested here; home-dashboard tests it).
 */
export function scrollDecision({ navType, prevPath, nextPath }) {
  if (navType === 'POP') return 'restore';
  if (prevPath !== null && prevPath === nextPath) return 'stay';
  return 'top';
}

const STORE_KEY = 'nu.scroll';
const MAX_ENTRIES = 50;

export function createScrollMemory({ storage = safeSession() } = {}) {
  let positions = {};
  try {
    positions = JSON.parse(storage?.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    positions = {};
  }
  const persist = () => {
    try {
      const keys = Object.keys(positions);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete positions[k];
      storage?.setItem(STORE_KEY, JSON.stringify(positions));
    } catch {
      /* storage blocked or full: positions still live for this page */
    }
  };
  return {
    save(key, y) {
      if (!key) return;
      positions[key] = Math.max(0, Math.round(y));
      persist();
    },
    get: (key) => positions[key] ?? null,
  };
}

/**
 * Scrolls to `y` once the page is tall enough to get there (content arrives after a Back, e.g. the dashboard's cards),
 * trying for up to `forMs`. Returns a cancel function. Uses timers, not animation frames (those pause in a hidden tab).
 */
export function restoreScroll(win, doc, y, { everyMs = 50, forMs = 2000 } = {}) {
  if (!y) {
    win.scrollTo(0, 0);
    return () => {};
  }
  const until = Date.now() + forMs;
  let timer = null;
  const attempt = () => {
    const room = doc.documentElement.scrollHeight - win.innerHeight;
    if (room >= y || Date.now() >= until) {
      win.scrollTo(0, Math.min(y, Math.max(0, room)));
      return;
    }
    timer = setTimeout(attempt, everyMs);
  };
  attempt();
  return () => clearTimeout(timer);
}

/** The page's main heading: focused (without scrolling) when a new page opens, for keyboard and screen reader users. */
export function focusMainHeading(doc) {
  const h = doc.querySelector('main h1');
  if (!h) return false;
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
  return doc.activeElement === h;
}

function safeSession() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
