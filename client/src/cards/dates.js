import { dateParts, dateString, daysInMonth } from '../../../server/core/cardDetail.js';

/**
 * Go-live dates are calendar dates ('YYYY-MM-DD', server/core/cardDetail.js): the same day for everyone, wherever
 * they are. Nothing here turns one into an instant in the viewer's time zone. The weekday comes from Date.UTC on the
 * three numbers, read back with getUTCDay, so a browser in Honolulu and one in Auckland both say "Sat 24 Oct".
 *
 * The only thing that does depend on where the viewer is is "today" (the picker's Today button, "in 9 days"): that is
 * the viewer's own calendar day, which is what they mean by it.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const utc = ({ year, month, day }) => Date.UTC(year, month - 1, day);

/** "Sat 24 Oct 2026"; without the year when `year` is false. '' for something that isn't a date. */
export function formatDate(value, { year = true } = {}) {
  const p = dateParts(value);
  if (!p) return '';
  const dow = DAYS[new Date(utc(p)).getUTCDay()];
  return `${dow} ${p.day} ${MONTHS[p.month - 1].slice(0, 3)}${year ? ` ${p.year}` : ''}`;
}

/** The card front's badge: "Sat 24 Oct", with the year only when it isn't this year. */
export function formatBadge(value, today = todayString()) {
  const p = dateParts(value);
  return p ? formatDate(value, { year: p.year !== dateParts(today)?.year }) : '';
}

/** The viewer's calendar day, as 'YYYY-MM-DD'. */
export function todayString(now = new Date()) {
  return dateString(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'); negative when `to` is earlier. */
export function daysBetween(from, to) {
  return Math.round((utc(dateParts(to)) - utc(dateParts(from))) / 86_400_000);
}

/** "In 9 days", "Tomorrow", "Goes live today", "Live 1 day", "Live 12 days". */
export function relativeTo(value, today = todayString()) {
  if (!dateParts(value) || !dateParts(today)) return '';
  const n = daysBetween(today, value);
  if (n > 1) return `In ${n} days`;
  if (n === 1) return 'Tomorrow';
  if (n === 0) return 'Goes live today';
  return `Live ${-n} ${n === -1 ? 'day' : 'days'}`;
}

/** The date `n` days after `value` (n may be negative). */
export function addDays(value, n) {
  const d = new Date(utc(dateParts(value)) + n * 86_400_000);
  return dateString(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** The same day `n` months on, pulled back to the month's last day if it has fewer days. */
export function addMonths(value, n) {
  const p = dateParts(value);
  const index = p.year * 12 + (p.month - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return dateString(year, month, Math.min(p.day, daysInMonth(year, month)));
}

/**
 * A month's calendar, Monday first: whole weeks of { date, day, inMonth }, starting with the last days of the month
 * before and ending with the first of the month after.
 */
export function monthGrid(year, month) {
  const first = dateString(year, month, 1);
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const cells = Math.ceil((lead + daysInMonth(year, month)) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => {
    const date = addDays(first, i - lead);
    const p = dateParts(date);
    return { date, day: p ? p.day : Number(date.slice(8)), inMonth: i >= lead && i < lead + daysInMonth(year, month) };
  });
}
