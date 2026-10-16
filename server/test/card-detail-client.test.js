import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { addMonths, daysBetween, formatBadge, formatDate, monthGrid, relativeTo } from '../../client/src/cards/dates.js';
import { linkify } from '../../client/src/cards/linkify.js';

// The client's pure helpers for the card panel: plain JS, so node:test runs them as they ship.

describe('server info links (client/src/cards/linkify.js)', () => {
  const links = (text) => linkify(text).filter((p) => p.href);
  const whole = (text) =>
    linkify(text)
      .map((p) => p.text)
      .join('');

  test('only http:// and https:// become links', () => {
    assert.deepEqual(links('javascript:alert(1)'), []);
    assert.deepEqual(links('JaVaScRiPt:alert(document.cookie)'), []);
    assert.deepEqual(links('data:text/html,<script>alert(1)</script>'), []);
    assert.deepEqual(links('vbscript:msgbox file:///etc/passwd ftp://x.com mailto:a@b.co steam://connect/1.2.3.4'), []);
    assert.deepEqual(links('www.example.com and example.com'), []);
    assert.deepEqual(links('https:// and http://'), []);
  });

  test('a URL with trailing punctuation links without it; the punctuation stays text', () => {
    assert.deepEqual(linkify('see https://x.com/a.'), [{ text: 'see ' }, { text: 'https://x.com/a', href: 'https://x.com/a' }, { text: '.' }]);
    assert.deepEqual(
      links('Guide: https://x.com/a, then https://x.com/b; or https://x.com/c!?').map((p) => p.href),
      ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'],
    );
    assert.deepEqual(links('"https://x.com/q"').map((p) => p.href), ['https://x.com/q']);
    assert.deepEqual(links('(https://x.com/a)').map((p) => p.href), ['https://x.com/a']);
    // A bracket that's part of the URL stays.
    assert.deepEqual(links('https://en.wikipedia.org/wiki/Rust_(video_game).').map((p) => p.href), ['https://en.wikipedia.org/wiki/Rust_(video_game)']);
  });

  test('an HTML tag is text; only the URL inside it links', () => {
    const pieces = linkify('<a href="javascript:alert(1)">https://x.com</a><img src=x onerror=alert(1)>');
    assert.deepEqual(
      pieces.filter((p) => p.href).map((p) => p.href),
      ['https://x.com/'],
    );
    assert.equal(whole('<a href="javascript:alert(1)">https://x.com</a><img src=x onerror=alert(1)>'), '<a href="javascript:alert(1)">https://x.com</a><img src=x onerror=alert(1)>');
    // A URL can't run into a tag or quote to smuggle anything along.
    assert.deepEqual(links('<a href="https://x.com/a">').map((p) => p.text), ['https://x.com/a']);
  });

  test('a markdown link is text with its URL linked; the javascript: kind links nothing', () => {
    assert.deepEqual(linkify('[mods](https://thunderstore.io/c/valheim)'), [
      { text: '[mods](' },
      { text: 'https://thunderstore.io/c/valheim', href: 'https://thunderstore.io/c/valheim' },
      { text: ')' },
    ]);
    assert.deepEqual(links('[click](javascript:alert(1))'), []);
    // Only the https part of "javascript:https://…" links, and it goes to that https address.
    assert.deepEqual(links('javascript:https://x.com').map((p) => p.href), ['https://x.com/']);
  });

  test('nothing is lost: the pieces put back together are the text exactly', () => {
    const text = 'PNC Valhalla (dedicated)\n203.0.113.42:2456\nPassword: skål-and-sail\nMods: https://thunderstore.io/c/valheim/p/pnc/modpack/\n<b>not bold</b>';
    assert.equal(whole(text), text);
    assert.deepEqual(links(text).map((p) => p.href), ['https://thunderstore.io/c/valheim/p/pnc/modpack/']);
    assert.deepEqual(links('http://203.0.113.42:8080/status').map((p) => p.href), ['http://203.0.113.42:8080/status']);
  });
});

describe('go-live dates (client/src/cards/dates.js)', () => {
  test('formats from the three numbers, never as an instant', () => {
    assert.equal(formatDate('2026-10-24'), 'Sat 24 Oct 2026');
    assert.equal(formatDate('2026-10-24', { year: false }), 'Sat 24 Oct');
    assert.equal(formatDate('2028-02-29'), 'Tue 29 Feb 2028');
    assert.equal(formatDate('nope'), '');
    assert.equal(formatBadge('2026-10-24', '2026-10-15'), 'Sat 24 Oct');
    assert.equal(formatBadge('2027-01-02', '2026-10-15'), 'Sat 2 Jan 2027', 'another year says which');
  });

  test('relative wording and month arithmetic', () => {
    assert.equal(relativeTo('2026-10-24', '2026-10-15'), 'In 9 days');
    assert.equal(relativeTo('2026-10-16', '2026-10-15'), 'Tomorrow');
    assert.equal(relativeTo('2026-10-15', '2026-10-15'), 'Goes live today');
    assert.equal(relativeTo('2026-10-14', '2026-10-15'), 'Live 1 day');
    assert.equal(relativeTo('2026-10-03', '2026-10-15'), 'Live 12 days');
    // Across a daylight-saving change (25 Oct 2026 in Europe) a day is still a day.
    assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
    const oct = monthGrid(2026, 10);
    assert.equal(oct.length, 35);
    assert.deepEqual(oct[0], { date: '2026-09-28', day: 28, inMonth: false }, 'Monday first');
    assert.equal(oct.find((c) => c.date === '2026-10-24').inMonth, true);
  });

  test('a date shows as the same day in every time zone', () => {
    // Each zone runs in its own process (TZ is read at start-up), formatting the same stored value.
    const zones = ['Pacific/Honolulu', 'America/Los_Angeles', 'UTC', 'Europe/London', 'Asia/Tokyo', 'Pacific/Kiritimati'];
    const script = `
      import { formatDate, formatBadge } from ${JSON.stringify(new URL('../../client/src/cards/dates.js', import.meta.url).href)};
      const naive = new Date('2026-10-24').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      console.log(JSON.stringify({ ours: formatDate('2026-10-24'), badge: formatBadge('2026-10-24', '2026-01-01'), naive,
        offset: new Date(2026, 9, 24).getTimezoneOffset() }));`;
    const seen = zones.map((tz) => {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return { tz, ...JSON.parse(run.stdout) };
    });
    assert.ok(new Set(seen.map((s) => s.offset)).size >= 4, 'the zones really differ');
    for (const s of seen) {
      assert.equal(s.ours, 'Sat 24 Oct 2026', s.tz);
      assert.equal(s.badge, 'Sat 24 Oct', s.tz);
    }
    // What this guards against: parsing the date as an instant shows the day before west of Greenwich.
    assert.equal(seen.find((s) => s.tz === 'Pacific/Honolulu').naive, 'Fri 23 Oct');
  });
});

