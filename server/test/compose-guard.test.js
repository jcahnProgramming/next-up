import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// docker-compose.yml: every published port binds to <HOST>'s LAN address, never 0.0.0.0 (Docker's default when no
// address is given). The app is public through the Cloudflare tunnel; nothing else may be.
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

test('both containers publish exactly one port each, on <LAN_IP>', () => {
  assert.deepEqual(publishedPorts(), ['<LAN_IP>:3230:3230', '<LAN_IP>:3231:3231']);
});

test('no long-form port syntax, host networking or 0.0.0.0 anywhere', () => {
  const code = compose.replace(/#.*$/gm, '');
  assert.doesNotMatch(code, /host_ip|published:|network_mode:\s*host|0\.0\.0\.0/);
});
