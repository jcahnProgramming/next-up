/**
 * Cards: the rules both sides enforce. Plain JS with no Node imports: the client imports this same file (like
 * core/codes.js), so the edit sheet and the API can never disagree about what a valid card is.
 */

/** The three lanes, in board order. The id is what's stored; the name is what's shown. */
export const LANES = Object.freeze([
  Object.freeze({ id: 'up_next', name: 'Up Next' }),
  Object.freeze({ id: 'now_playing', name: 'Now Playing' }),
  Object.freeze({ id: 'played', name: 'Played' }),
]);
export const LANE_IDS = Object.freeze(LANES.map((l) => l.id));
export const laneName = (id) => LANES.find((l) => l.id === id)?.name ?? null;

/** The most live (not deleted) cards one board holds. Deleted cards don't count. */
export const MAX_CARDS = 200;
export const cardLimitMessage = `This board has ${MAX_CARDS} games, the most a board can hold. Delete one to add another.`;

export const TITLE_MAX = 60;

/** A logo's id is its file name in logos/ without the extension (logos/README.md). Never a URL or a path. */
export const LOGO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LOGO_ID_MAX = 64;

/** Trims, collapses whitespace and drops control characters. Doesn't validate. */
export function cleanTitle(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** { ok: true, title } or { ok: false, error }. Length counts characters as people see them (code points). */
export function checkTitle(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Type the game’s name.' };
  const title = cleanTitle(value);
  const n = [...title].length;
  if (n === 0) return { ok: false, error: 'Type the game’s name.' };
  if (n > TITLE_MAX) return { ok: false, error: `Keep the name to ${TITLE_MAX} characters or fewer.` };
  return { ok: true, title };
}

/** { ok: true, logo } (null for no logo) or { ok: false, error }. Checks the shape only: the library is the client's. */
export function checkLogo(value) {
  if (value === null || value === undefined || value === '') return { ok: true, logo: null };
  if (typeof value !== 'string' || value.length > LOGO_ID_MAX || !LOGO_ID.test(value)) {
    return { ok: false, error: 'That isn’t a logo from the library.' };
  }
  return { ok: true, logo: value };
}

export function checkLane(value) {
  return LANE_IDS.includes(value) ? { ok: true, lane: value } : { ok: false, error: 'Choose Up Next, Now Playing or Played.' };
}
