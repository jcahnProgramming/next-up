import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createApp } from '../app.js';

const changelog = JSON.parse(readFileSync(new URL('../../CHANGELOG.json', import.meta.url), 'utf8'));
let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('/health reports ok and the newest CHANGELOG.json version', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', service: 'web', version: changelog.releases[0].version });
});

test('unknown /api routes are JSON 404s, never the client page', async () => {
  const res = await fetch(`${base}/api/nothing`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});
