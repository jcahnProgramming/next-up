// Web app entrypoint: REST API + built React client.
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
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
const httpServer = createApp().listen(config.port, config.listenHost, () => {
  console.log(`[web] Next Up ${APP_VERSION} listening on ${config.listenHost}:${config.port}`);
  console.log(`[web] Rate limits per network: ${describeTrust()}`);
});

function shutdown() {
  httpServer.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
