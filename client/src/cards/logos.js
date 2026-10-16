import { useSyncExternalStore } from 'react';
import { logos } from 'virtual:nu-logos';

/**
 * The logo library: [{ id, name, url }], sorted by name, built from logos/ at build time (client/vite.config.js,
 * scripts/logos.js). Images come only from there: nothing is uploaded, typed in or fetched from elsewhere.
 */
export const LOGOS = logos;

const byId = new Map(LOGOS.map((l) => [l.id, l]));

/**
 * The logo a card shows, or null for the no-logo card: when it has none, when its file has left the library since
 * (a card keeps the id; a later build without that file just doesn't know it), or when the image failed to load.
 */
export function useLogo(id) {
  const broken = useSyncExternalStore(subscribe, () => failed);
  if (!id) return null;
  const logo = byId.get(id) ?? null;
  return logo && !broken.has(logo.url) ? logo : null;
}

export const logoById = (id) => (id ? byId.get(id) ?? null : null);

// Images that failed to load, shared by every card and thumbnail showing them (each falls back, none shows broken).
let failed = new Set();
const listeners = new Set();
function subscribe(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function markBroken(url) {
  if (failed.has(url)) return;
  failed = new Set(failed).add(url);
  listeners.forEach((fn) => fn());
}

/** The no-logo card's monogram: the first letters of the first two words, or of the one word ("Soulmask" → "SO"). */
export function initials(title) {
  const words = String(title ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[1]][0]];
  return letters.join('').toLocaleUpperCase();
}
