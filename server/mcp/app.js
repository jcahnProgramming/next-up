import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createErrorHandler } from '../core/errors.js';
import { APP_VERSION } from '../core/version.js';
import { createMcpServer } from './server.js';

const MIN_TOKEN = 16;
// Hash both sides so timingSafeEqual always compares equal-length buffers.
const digest = (s) => createHash('sha256').update(s).digest();

/**
 * The MCP server's HTTP app, without listening.
 *
 *   GET  /health   open: status and version only (the deploy and the container healthcheck probe it)
 *   POST /mcp      MCP over Streamable HTTP, stateless; every tool comes from mcp/resolvers
 *
 * Everything except /health needs `Authorization: Bearer <MCP_BEARER_TOKEN>`. Without a usable token the server
 * never runs open: it answers 503.
 *
 * @param {{ token?: () => string }} [opts] where the token comes from (default: MCP_BEARER_TOKEN in the environment)
 */
export function createMcpApp({ token = () => process.env.MCP_BEARER_TOKEN?.trim() ?? '' } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'mcp', version: APP_VERSION }));

  app.use((req, res, next) => {
    const expected = token();
    if (expected.length < MIN_TOKEN) {
      return res.status(503).json({ error: 'No MCP bearer token is configured. Set MCP_BEARER_TOKEN in .env and restart.' });
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (match && timingSafeEqual(digest(match[1].trim()), digest(expected))) return next();
    res.set('WWW-Authenticate', 'Bearer realm="next-up-mcp"');
    res.status(401).json({ error: 'Unauthorized' });
  });

  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(createErrorHandler('mcp'));
  return app;
}
