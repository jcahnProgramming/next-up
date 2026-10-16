/**
 * Server info is plain text: it is never parsed as HTML or markdown. linkify() splits it into pieces, and the only
 * thing that ever becomes a link is an http:// or https:// URL; every other scheme (javascript:, data:, file:, …)
 * stays text. The caller renders each piece as a React text node or an <a> (React escapes both), so a "<script>" in
 * the text is shown as those characters.
 *
 *   linkify('see https://x.com/a.')  →  [{ text: 'see ' }, { text: 'https://x.com/a', href: 'https://x.com/a' }, { text: '.' }]
 *
 * A URL ends at whitespace, a quote, < > or a backtick. Punctuation that usually ends the sentence rather than the
 * URL (. , ; : ! ? and quotes) is left off the end, as is a closing bracket with no opening one inside the URL, so
 * "(https://x.com/a)" and "[x](https://x.com/a)" link https://x.com/a. Each candidate must parse as a URL whose
 * protocol is http: or https: with a host, or it stays text.
 */
const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"]$/;
const PAIRS = { ')': '(', ']': '[', '}': '{' };

export function linkify(text) {
  const source = String(text ?? '');
  const out = [];
  let at = 0;
  for (const m of source.matchAll(CANDIDATE)) {
    const url = trimEnd(m[0]);
    const href = safeHref(url);
    if (!href) continue;
    if (m.index > at) out.push({ text: source.slice(at, m.index) });
    out.push({ text: url, href });
    at = m.index + url.length;
  }
  if (at < source.length) out.push({ text: source.slice(at) });
  return merge(out);
}

function trimEnd(url) {
  let u = url;
  for (;;) {
    const last = u.at(-1);
    if (TRAILING.test(u)) u = u.slice(0, -1);
    else if (PAIRS[last] && count(u, last) > count(u, PAIRS[last])) u = u.slice(0, -1);
    else return u;
  }
}

const count = (s, ch) => s.split(ch).length - 1;

/** The URL to link to, or null: only http(s) with a host. */
export function safeHref(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  return url.href;
}

// Neighbouring text pieces (left when a candidate failed the check) become one.
function merge(pieces) {
  const out = [];
  for (const p of pieces) {
    const prev = out.at(-1);
    if (prev && !prev.href && !p.href) prev.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
