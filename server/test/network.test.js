import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNetworkResolver } from '../core/network.js';

const req = (socket, header) => ({ socket: { remoteAddress: socket }, headers: header ? { 'cf-connecting-ip': header } : {} });

test('behind the tunnel the visitor is CF-Connecting-IP, never the shared cloudflared socket', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '' });
  assert.equal(networkOf(req('172.20.0.5', '198.51.100.7')), '198.51.100.7');
  assert.equal(networkOf(req('172.20.0.5', '198.51.100.8')), '198.51.100.8');
});

test('without the header (LAN, local dev) the socket address is the network', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '' });
  assert.equal(networkOf(req('192.168.1.40')), '192.168.1.40');
  assert.equal(networkOf(req('::ffff:192.168.1.41')), '192.168.1.41');
  assert.equal(networkOf(req('192.168.1.40', 'not-an-ip')), '192.168.1.40');
  assert.equal(networkOf(req(undefined)), 'unknown');
});

test('IPv6 is grouped by /64, so rotating addresses inside one network gains nothing', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '' });
  const a = networkOf(req('172.20.0.5', '2001:db8:aa:bb:1::1'));
  const b = networkOf(req('172.20.0.5', '2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff'));
  assert.equal(a, '2001:db8:aa:bb::/64');
  assert.equal(a, b);
  assert.notEqual(a, networkOf(req('172.20.0.5', '2001:db8:aa:bc::1')));
  assert.equal(networkOf(req('172.20.0.5', '2001:db8::1')), '2001:db8:0:0::/64');
});

test('with TRUSTED_PROXIES, a header from anywhere else is ignored (no spoofing from the LAN)', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '172.20.0.0/16, 192.168.1.10' });
  assert.equal(networkOf(req('172.20.0.5', '198.51.100.7')), '198.51.100.7');
  assert.equal(networkOf(req('192.168.1.10', '198.51.100.7')), '198.51.100.7');
  assert.equal(networkOf(req('192.168.1.40', '198.51.100.7')), '192.168.1.40');
  assert.throws(() => createNetworkResolver({ trustedProxies: 'my-proxy' }), /TRUSTED_PROXIES/);
});

// End to end, over real sockets from two different addresses on this machine: ::1 plays cloudflared, 127.0.0.1 a
// device on the LAN talking to port 3230 directly. Unknown codes are limited to 30 per network per 15 minutes.
async function lookupsFrom(base, from, n, fakeHeaders) {
  const host = from === '::1' ? `[::1]:${new URL(base).port}` : `127.0.0.1:${new URL(base).port}`;
  const statuses = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`http://${host}/api/boards/no-such-board-${i}`, {
      headers: fakeHeaders ? { 'cf-connecting-ip': `203.0.113.${i + 1}` } : {},
    });
    statuses.push(res.status);
    await res.arrayBuffer();
  }
  return statuses;
}

test('the LAN gap today: without TRUSTED_PROXIES a faked header buys a fresh bucket every request', async () => {
  const { startApp } = await import('./helpers.js');
  const app = await startApp({ host: '::', trustedProxies: '' });
  try {
    const lan = await lookupsFrom(app.base, '127.0.0.1', 31, true);
    assert.ok(lan.every((s) => s === 404), 'every faked address got its own 30');
  } finally {
    await app.close();
  }
});

test('with TRUSTED_PROXIES, a LAN request with a fake header counts against its own address; the tunnel still splits visitors', async () => {
  const { startApp } = await import('./helpers.js');
  const seen = [];
  const app = await startApp({ host: '::', trustedProxies: '::1', onHeader: (...a) => seen.push(a) });
  try {
    // The LAN device fakes a new visitor address on every request: all 31 land in ONE bucket, its own.
    const lan = await lookupsFrom(app.base, '127.0.0.1', 31, true);
    assert.deepEqual(lan.slice(0, 30), Array(30).fill(404));
    assert.equal(lan[30], 429);
    // cloudflared's visitors are still told apart by the header (31 different visitors, none limited)…
    const tunnel = await lookupsFrom(app.base, '::1', 31, true);
    assert.ok(tunnel.every((s) => s === 404));
    // …and the LAN device's own limit is unaffected by the header it sends.
    assert.deepEqual(await lookupsFrom(app.base, '127.0.0.1', 1, false), [429]);
    assert.deepEqual(seen.find(([socket]) => socket === '127.0.0.1'), ['127.0.0.1', false, true]);
    assert.deepEqual(seen.find(([socket]) => socket === '::1'), ['::1', true, true]);
  } finally {
    await app.close();
  }
});

test('the header-source log names each connection address once, and never the visitor address', async () => {
  const { logHeaderSources } = await import('../core/network.js');
  const lines = [];
  const onHeader = logHeaderSources({ log: { log: (l) => lines.push(l), warn: (l) => lines.push(l) } });
  const networkOf = createNetworkResolver({ trustedProxies: '172.16.0.0/12', onHeader });
  for (let i = 0; i < 3; i++) networkOf(req('172.18.0.1', `198.51.100.${i}`));
  networkOf(req('192.168.1.40', '198.51.100.9'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /from 172\.18\.0\.1: honoured \(in TRUSTED_PROXIES\)/);
  assert.match(lines[1], /from 192\.168\.1\.40: IGNORED/);
  assert.ok(lines.every((l) => !l.includes('198.51.100')));
});
