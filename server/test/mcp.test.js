import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpApp } from '../mcp/app.js';
import { checkResolvers } from '../mcp/server.js';
import { resolvers } from '../mcp/resolvers/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const changelog = JSON.parse(readFileSync(new URL('../../CHANGELOG.json', import.meta.url), 'utf8'));
let token = TOKEN;
let server;
let base;

before(async () => {
  server = createMcpApp({ token: () => token }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function connect(bearer) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
}

test('/health is open and reports the version', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', service: 'mcp', version: changelog.releases[0].version });
});

test('without the right bearer token, /mcp answers 401', async () => {
  for (const authorization of [undefined, 'Bearer wrong-token-wrong-token', `Basic ${TOKEN}`]) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: '{}',
    });
    assert.equal(res.status, 401, String(authorization));
  }
});

test('with no token configured (or one under 16 chars) the server never runs open: 503', async () => {
  for (const configured of ['', 'short']) {
    token = configured;
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${configured}` } });
    assert.equal(res.status, 503);
  }
  token = TOKEN;
});

test('lists exactly the declared resolvers, all read-only, and get_version reports CHANGELOG.json', async () => {
  const client = await connect(TOKEN);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), resolvers.map((r) => r.name));
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);

  const result = await client.callTool({ name: 'get_version', arguments: {} });
  const { version, date, title } = changelog.releases[0];
  assert.deepEqual(JSON.parse(result.content[0].text), { app: 'Next Up', version, date, title });
  await client.close();
});

test('malformed resolver declarations are refused at start-up', () => {
  const ok = { name: 'a_tool', description: 'x', input: {}, resolve: () => 1 };
  assert.throws(() => checkResolvers([{ ...ok, name: 'Bad-Name' }]), /snake_case/);
  assert.throws(() => checkResolvers([ok, ok]), /declared twice/);
  assert.throws(() => checkResolvers([{ ...ok, resolve: undefined }]), /resolve/);
  assert.throws(() => checkResolvers([{ ...ok, description: '' }]), /description/);
});
