import { BlockList, isIP } from 'node:net';

/**
 * The visitor's network, the key every rate limit counts against.
 *
 * Behind the Cloudflare tunnel every request's socket comes from cloudflared, so the socket address is the same for
 * everyone; the visitor's address is the CF-Connecting-IP header, which Cloudflare's edge sets on every request it
 * proxies (overwriting any value the visitor sent). Requests that don't come through the tunnel (the LAN port, local
 * dev) don't have a trustworthy one, so:
 *
 *   - TRUSTED_PROXIES set (IPs or CIDRs, comma-separated: where cloudflared's connections come from as the container
 *     sees them): the header is honoured only on connections from those addresses. Everything else is keyed by its
 *     own socket address, header or not.
 *   - TRUSTED_PROXIES unset: the header is honoured from any connection. Safe from the internet (port 3230 is reachable
 *     only through the tunnel), but a device on the LAN could send its own header to dodge a limit.
 *   - No usable header: the socket address. Never one shared bucket for the tunnel: tunnel traffic always has it.
 *
 * IPv6 addresses are grouped by /64 (one home or one server gets at least that many), IPv4 per address.
 */
export function createNetworkResolver({ trustedProxies = process.env.TRUSTED_PROXIES } = {}) {
  const trusted = parseTrusted(trustedProxies);
  return function networkOf(req) {
    const socket = cleanIp(req.socket?.remoteAddress);
    const header = req.headers['cf-connecting-ip'];
    const fromHeader = typeof header === 'string' ? cleanIp(header.trim()) : null;
    const honour = fromHeader && (!trusted || (socket && trusted.check(socket, isIP(socket) === 6 ? 'ipv6' : 'ipv4')));
    return groupOf(honour ? fromHeader : socket) ?? 'unknown';
  };
}

/** Describes the mode for the start-up log (no addresses). */
export function describeTrust(trustedProxies = process.env.TRUSTED_PROXIES) {
  return parseTrusted(trustedProxies)
    ? 'CF-Connecting-IP honoured only from TRUSTED_PROXIES'
    : 'CF-Connecting-IP honoured from any connection (TRUSTED_PROXIES not set)';
}

function parseTrusted(value) {
  const entries = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, bits] = entry.split('/');
    const ip = cleanIp(address);
    if (!ip) throw new Error('TRUSTED_PROXIES has an entry that is not an IP address or CIDR');
    const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(ip, family);
    else list.addSubnet(ip, Number(bits), family);
  }
  return list;
}

// "::ffff:1.2.3.4" (IPv4 on a dual-stack socket) → "1.2.3.4". Anything that isn't an IP → null.
function cleanIp(value) {
  if (typeof value !== 'string') return null;
  const v = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(v) ? v.toLowerCase() : null;
}

function groupOf(ip) {
  if (!ip) return null;
  if (isIP(ip) === 4) return ip;
  return `${expandV6(ip).slice(0, 4).join(':')}::/64`;
}

function expandV6(ip) {
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  // An embedded IPv4 tail ("::1.2.3.4") counts as two groups; only the first four groups matter here.
  const fill = Array(Math.max(0, 8 - a.length - b.length)).fill('0');
  return [...a, ...fill, ...b].map((g) => (g.includes('.') ? g : g.replace(/^0+(?=.)/, '')));
}
