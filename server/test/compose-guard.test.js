import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// docker-compose.yml: every published port binds to the host address in BIND_IP, never 0.0.0.0 (Docker's default
// when no address is given). The web app is public through a proxy or tunnel; nothing else may be.
const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

function publishedPorts() {
  const ports = [];
  let inPorts = false;
  let indent = 0;
  for (const line of compose.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const lead = line.match(/^\s*/)[0].length;
    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      indent = lead;
      continue;
    }
    if (inPorts && lead > indent && /^\s*-\s*/.test(line)) {
      ports.push(line.replace(/^\s*-\s*/, '').replace(/["']/g, '').trim());
      continue;
    }
    inPorts = false;
  }
  return ports;
}

// The address comes from BIND_IP, required (`:?`) with no default: an unset BIND_IP must stop compose, never fall
// back to 0.0.0.0 (Docker's default) or to any address written here.
const ON_BIND_IP = (port) => new RegExp(`^\\$\\{BIND_IP:\\?[^}]*\\}:${port}:${port}$`);

test('both containers publish exactly one port each, on BIND_IP, which is required and has no default', () => {
  const ports = publishedPorts();
  assert.equal(ports.length, 2, ports.join(', '));
  assert.match(ports[0], ON_BIND_IP(3230));
  assert.match(ports[1], ON_BIND_IP(3231));
  assert.doesNotMatch(compose, /BIND_IP:?-/);
});

test('no long-form port syntax, host networking or 0.0.0.0 anywhere', () => {
  const code = compose.replace(/#.*$/gm, '');
  assert.doesNotMatch(code, /host_ip|published:|network_mode:\s*host|0\.0\.0\.0/);
});
