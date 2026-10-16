/**
 * A card's details: go-live date, server info and player sign-ups. The rules both sides enforce; plain JS with no
 * Node imports, so the client imports this same file (like core/cardRules.js) and the two can't disagree.
 */

// ---------- go-live date ----------

/**
 * A go-live date is a calendar DATE, 'YYYY-MM-DD', with no time and no time zone: "Sat 24 Oct" is the same day for
 * everyone, wherever they are. It is never turned into an instant (no `new Date('2026-10-24')`, which is UTC
 * midnight and shows as the 23rd west of Greenwich); every calculation works on the three numbers.
 */
export const DATE_MIN_YEAR = 2000;
export const DATE_MAX_YEAR = 2099;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** { year, month (1–12), day } of a valid date string, else null. */
export function dateParts(value) {
  const m = typeof value === 'string' ? DATE.exec(value) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < DATE_MIN_YEAR || year > DATE_MAX_YEAR || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' for these numbers (no checking). */
export function dateString(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** { ok: true, goLive } (null: not set) or { ok: false, error }. */
export function checkGoLive(value) {
  if (value === null || value === undefined || value === '') return { ok: true, goLive: null };
  if (!dateParts(value)) return { ok: false, error: 'Choose a date from the calendar.' };
  return { ok: true, goLive: value };
}

// ---------- server info ----------

/** Free text, at most this many characters (as people count them: code points). */
export const SERVER_INFO_MAX = 2000;

/** One kind of line break, no control characters but line breaks and tabs, no blank lines at either end. */
export function cleanServerInfo(value) {
  return (
    String(value ?? '')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/^\n+|\s+$/g, '')
  );
}

/** { ok: true, serverInfo } ('' means not set) or { ok: false, error }. */
export function checkServerInfo(value) {
  if (value === null || value === undefined) return { ok: true, serverInfo: '' };
  if (typeof value !== 'string') return { ok: false, error: 'Server info is plain text.' };
  const serverInfo = cleanServerInfo(value);
  if ([...serverInfo].length > SERVER_INFO_MAX) {
    return { ok: false, error: `Keep server info to ${SERVER_INFO_MAX.toLocaleString('en')} characters or fewer.` };
  }
  return { ok: true, serverInfo };
}

// ---------- players ----------

/** The most players signed up to one card. Removed players don't count. */
export const MAX_PLAYERS = 100;
export const PLAYER_NAME_MAX = 32;

/** Trims, collapses whitespace and drops control characters. Doesn't validate. */
export function cleanPlayerName(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * What two names must not share on one card: "Larias", "larias" and "LARIAS" are one player. NFC first, so an
 * accented letter typed two different ways is one letter. The database holds a unique index on it, too.
 */
export function playerKey(name) {
  return cleanPlayerName(name).normalize('NFC').toLowerCase();
}

/** { ok: true, name } or { ok: false, error }. Length counts characters as people see them (code points). */
export function checkPlayerName(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Type a name.' };
  const name = cleanPlayerName(value).normalize('NFC');
  const n = [...name].length;
  if (n === 0) return { ok: false, error: 'Type a name.' };
  if (n > PLAYER_NAME_MAX) return { ok: false, error: `Keep the name to ${PLAYER_NAME_MAX} characters or fewer.` };
  return { ok: true, name };
}

export const playerExistsMessage = (name) => `${name} is already signed up.`;
export const playerLimitMessage = `This card has ${MAX_PLAYERS} players, the most a card can hold.`;
