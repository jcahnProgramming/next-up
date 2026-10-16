import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNetworkResolver } from '../core/network.js';

const req = (socket, header) => ({ socket: { remoteAddress: socket }, headers: header ? { 'cf-connecting-ip': header } : {} });

test('behind the tunnel the visitor is CF-Connecting-IP, never the shared cloudflared socket', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '' });
  assert.equal(networkOf(req('<DOCKER_IP>', '198.51.100.7')), '198.51.100.7');
  assert.equal(networkOf(req('<DOCKER_IP>', '198.51.100.8')), '198.51.100.8');
});

test('without the header (LAN, local dev) the socket address is the network', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '' });
  assert.equal(networkOf(req('<LAN_DEVICE_IP>')), '<LAN_DEVICE_IP>');
  assert.equal(networkOf(req('::ffff:<LAN_DEVICE_IP>')), '<LAN_DEVICE_IP>');
  assert.equal(networkOf(req('<LAN_DEVICE_IP>', 'not-an-ip')), '<LAN_DEVICE_IP>');
  assert.equal(networkOf(req(undefined)), 'unknown');
});

test('IPv6 is grouped by /64, so rotating addresses inside one network gains nothing', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '' });
  const a = networkOf(req('<DOCKER_IP>', '2001:db8:aa:bb:1::1'));
  const b = networkOf(req('<DOCKER_IP>', '2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff'));
  assert.equal(a, '2001:db8:aa:bb::/64');
  assert.equal(a, b);
  assert.notEqual(a, networkOf(req('<DOCKER_IP>', '2001:db8:aa:bc::1')));
  assert.equal(networkOf(req('<DOCKER_IP>', '2001:db8::1')), '2001:db8:0:0::/64');
});

test('with TRUSTED_PROXIES, a header from anywhere else is ignored (no spoofing from the LAN)', () => {
  const networkOf = createNetworkResolver({ trustedProxies: '<DOCKER_IP>, <LAN_IP>' });
  assert.equal(networkOf(req('<DOCKER_IP>', '198.51.100.7')), '198.51.100.7');
  assert.equal(networkOf(req('<LAN_IP>', '198.51.100.7')), '198.51.100.7');
  assert.equal(networkOf(req('<LAN_DEVICE_IP>', '198.51.100.7')), '<LAN_DEVICE_IP>');
  assert.throws(() => createNetworkResolver({ trustedProxies: '<host>' }), /TRUSTED_PROXIES/);
});
