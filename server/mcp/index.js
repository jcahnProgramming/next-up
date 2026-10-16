// MCP server entrypoint (read-only AI access). Separate process and container from the web app, sharing the same
// core modules and SQLite database file. See mcp/app.js for the token gate and mcp/resolvers for the tools.
import { config } from '../core/config.js';
import { closeDb } from '../core/db.js';
import { initPlatform } from '../core/platform.js';
import { APP_VERSION } from '../core/version.js';
import { createMcpApp } from './app.js';
import { resolvers } from './resolvers/index.js';

initPlatform({ readOnly: true });

if ((process.env.MCP_BEARER_TOKEN?.trim() ?? '').length < 16) {
  console.warn('[mcp] No MCP bearer token (min 16 chars): every route except /health answers 503. Add MCP_BEARER_TOKEN to .env (`npm run gen-token`) and restart this container.');
}

const httpServer = createMcpApp().listen(config.mcpPort, config.listenHost, () => {
  console.log(`[mcp] Next Up MCP ${APP_VERSION} listening on ${config.listenHost}:${config.mcpPort} (POST /mcp; tools: ${resolvers.map((r) => r.name).join(', ')})`);
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
