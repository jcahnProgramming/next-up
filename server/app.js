import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { config } from './core/config.js';
import { createErrorHandler } from './core/errors.js';
import { APP_VERSION } from './core/version.js';

/**
 * The web app (API + built client), without listening. index.js starts it; tests build it in-process.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // The deploy probes this (and checks the version against CHANGELOG.json), as do the container healthcheck and
  // anyone curious. It says nothing but status and version: the app is public.
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'web', version: APP_VERSION }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built client (production / Docker). In dev, Vite serves it instead.
  if (existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get('/{*splat}', (req, res) => res.sendFile(join(config.clientDist, 'index.html')));
  }

  app.use(createErrorHandler('web'));
  return app;
}
