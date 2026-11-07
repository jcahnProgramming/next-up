import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SECURITY_HEADERS } from '../core/headers.js';
import { startApp } from './helpers.js';

const expectHeaders = (res, what) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, `${what}: ${name}`);
};

test('every kind of answer carries the security headers', async () => {
  const app = await startApp();
  try {
    expectHeaders(await app.request('/health'), '/health');
    const created = await app.request('/api/boards', { method: 'POST', body: { code: 'pnc-raids' } });
    expectHeaders(created, 'create');
    expectHeaders(await app.request('/api/boards/pnc-raids', { cookie: created.cookie }), 'board');
    expectHeaders(await app.request('/api/nothing'), 'api 404');
    expectHeaders(await app.request('/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: undefined }), 'bad request');
    // The live stream: headers plus its own, and still an event stream.
    const ctrl = new AbortController();
    const live = await fetch(`${app.base}/api/boards/pnc-raids/live`, { headers: { cookie: created.cookie }, signal: ctrl.signal });
    expectHeaders(live, 'live');
    assert.match(live.headers.get('content-type'), /^text\/event-stream/);
    ctrl.abort();
  } finally {
    await app.close();
  }
});

test('the policy allows only this origin, and nothing may frame the app', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
});

test('a server error is logged without the board code, the body or the query', async () => {
  const { loggablePath } = await import('../core/errors.js');
  assert.equal(loggablePath('/api/boards/secret-raid/cards/7?since=3'), '/api/boards/:code/cards/7');
  assert.equal(loggablePath('/api/boards/secret-raid'), '/api/boards/:code');
  assert.equal(loggablePath('/health'), '/health');
  // Through the real handler: a database failure inside a board route.
  const app = await startApp();
  const lines = [];
  const error = console.error;
  try {
    const created = await app.request('/api/boards', { method: 'POST', body: { code: 'secret-raid', password: 'hunter2hunter2' } });
    app.db.exec('DROP TABLE cards'); // the cards route now fails with a 500
    console.error = (l) => lines.push(String(l));
    const res = await app.request('/api/boards/secret-raid/cards', {
      method: 'POST', cookie: created.cookie, body: { title: 'Private server notes', lane: 'up_next' },
    });
    assert.equal(res.status, 500);
  } finally {
    console.error = error;
    await app.close();
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[web\] POST \/api\/boards\/:code\/cards failed: /);
  for (const secret of ['secret-raid', 'hunter2', 'Private server', 'nu_access']) assert.ok(!lines[0].includes(secret), secret);
});
