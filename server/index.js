// Web app entrypoint: REST API + built React client.
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { SWEEP_MS } from './boards/retire.js';
import { config } from './core/config.js';
import { closeDb } from './core/db.js';
import { describeTrust } from './core/network.js';
import { initPlatform } from './core/platform.js';
import { APP_VERSION } from './core/version.js';

initPlatform();

if (!existsSync(config.clientDist)) {
  console.warn(`[web] No built client at ${config.clientDist}: run \`npm run build\` (or use Vite in dev).`);
}

// config.listenHost: loopback locally, the container's own interfaces in Docker (published on <LAN_IP> only).
const app = createApp();
const httpServer = app.listen(config.port, config.listenHost, () => {
  console.log(`[web] Next Up ${APP_VERSION} listening on ${config.listenHost}:${config.port}`);
  console.log(`[web] Rate limits per network: ${describeTrust()}`);
});

// Deleted boards are purged 24 hours after deletion (boards/retire.js): once at start-up (a board may have come due
// while the app was down), then every SWEEP_MS. A failed sweep is logged and the next one tries again.
function sweep() {
  try {
    const purged = app.locals.sweep();
    if (purged.length) console.log(`[web] Purged ${purged.length} deleted board${purged.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error(`[web] Sweeping deleted boards failed: ${err?.name ?? 'Error'}${err?.code ? ` (${err.code})` : ''}`);
  }
}
sweep();
const sweeper = setInterval(sweep, SWEEP_MS);
sweeper.unref();

function shutdown() {
  clearInterval(sweeper);
  // Open live streams would hold the server open: end them, and browsers reconnect to the next process.
  app.locals.live.close();
  httpServer.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
