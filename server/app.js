import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createBoardsRouter } from './boards/routes.js';
import { config } from './core/config.js';
import { getDb } from './core/db.js';
import { createErrorHandler } from './core/errors.js';
import { createNetworkResolver } from './core/network.js';
import { createLimits } from './core/rateLimit.js';
import { APP_VERSION } from './core/version.js';

/**
 * The web app (API + built client), without listening. index.js starts it; tests build it in-process with their own
 * database, clock, limits and board cap.
 *
 * @param {object} [opts]
 * @param {() => import('better-sqlite3').Database} [opts.db] the connection (default: the shared file, opened on first use)
 * @param {() => number} [opts.now] the clock the rate limits run on
 * @param {number} [opts.maxBoards]
 * @param {string} [opts.trustedProxies] see core/network.js (default: TRUSTED_PROXIES)
 */
export function createApp({ db = getDb, now = Date.now, maxBoards, trustedProxies } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // One set of limits per app: the password limiter is the single counter every password check shares.
  const limits = createLimits({ now });
  const networkOf = createNetworkResolver({ trustedProxies });

  // The deploy probes this (and checks the version against CHANGELOG.json), as do the container healthcheck and
  // anyone curious. It says nothing but status and version: the app is public.
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'web', version: APP_VERSION }));
  // Board answers are per browser and some depend on a cookie: never cached by a browser or anything in between.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/boards', createBoardsRouter({ db, limits, networkOf, maxBoards }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built client (production / Docker). In dev, Vite serves it instead.
  if (existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.get('/{*splat}', (req, res) => res.sendFile(join(config.clientDist, 'index.html')));
  }

  app.use(createErrorHandler('web'));
  return app;
}
