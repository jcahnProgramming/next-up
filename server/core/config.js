import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

// Relative DATA_DIR values resolve against the repo root so `npm start`
// from any workspace points at the same database file.
const dataDir = process.env.DATA_DIR || './data';

export const config = {
  // Where both processes listen. Loopback by default, so `npm run dev` is never on the LAN. The Docker image sets
  // 0.0.0.0: every interface of the CONTAINER, which only the port Docker publishes on <LAN_IP> reaches.
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 3230,
  mcpPort: Number(process.env.MCP_PORT) || 3231,
  dataDir: resolve(REPO_ROOT, dataDir),
  dbFile: process.env.DB_FILE || 'next-up.db',
  clientDist: resolve(REPO_ROOT, 'client', 'dist'),
};
