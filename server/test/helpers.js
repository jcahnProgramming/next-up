import Database from 'better-sqlite3';
import { createApp } from '../app.js';
import { runMigrations } from '../core/migrations.js';
import { coreMigrations } from '../core/schema.js';

/** A fresh in-memory database with every migration applied (silenced: the runner logs each one). */
export function memoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const log = console.log;
  console.log = () => {};
  try {
    runMigrations(db, 'core', coreMigrations);
  } finally {
    console.log = log;
  }
  return db;
}

/**
 * Starts the web app on a random port with its own database and a clock the test moves.
 * Returns { base, db, clock, request, close }. request(path, { method, body, ip, cookie, headers }) → { status, body, headers, cookie }.
 */
export async function startApp(opts = {}) {
  const db = memoryDb();
  const clock = { t: Date.UTC(2026, 9, 15, 12), now: () => clock.t, advance: (ms) => (clock.t += ms) };
  const server = createApp({ db: () => db, now: clock.now, ...opts }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { method = 'GET', body, ip, cookie, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(ip ? { 'cf-connecting-ip': ip } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const setCookie = res.headers.getSetCookie();
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      text,
      headers: res.headers,
      setCookie,
      // name=value of the first Set-Cookie, as a browser would send it back
      cookie: setCookie[0]?.split(';')[0] ?? null,
    };
  }

  return { base, db, clock, request, close: () => new Promise((r) => server.close(r)) };
}
