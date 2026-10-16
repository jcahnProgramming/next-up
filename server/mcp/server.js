import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../core/db.js';
import { APP_VERSION } from '../core/version.js';
import { resolvers as declared } from './resolvers/index.js';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** Checks the declarations once, at start-up: a malformed or duplicate resolver stops the process. */
export function checkResolvers(list) {
  const seen = new Set();
  for (const r of list) {
    const where = `MCP resolver ${JSON.stringify(r?.name)}`;
    if (!NAME.test(r?.name ?? '')) throw new Error(`${where}: name must be snake_case`);
    if (seen.has(r.name)) throw new Error(`${where}: declared twice`);
    if (typeof r.description !== 'string' || !r.description.trim()) throw new Error(`${where}: needs a description`);
    if (typeof r.input !== 'object' || r.input === null) throw new Error(`${where}: input must be a zod shape ({} for none)`);
    if (typeof r.resolve !== 'function') throw new Error(`${where}: resolve must be a function`);
    seen.add(r.name);
  }
  return list;
}

const resolvers = checkResolvers(declared);

// Resolvers get the database lazily, so a tool that doesn't need it never opens it.
const context = {
  get db() {
    return getDb();
  },
};

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

/** A fresh McpServer per request (the transport is stateless), registering every declared resolver. */
export function createMcpServer() {
  const server = new McpServer({ name: 'next-up', version: APP_VERSION });
  for (const r of resolvers) {
    server.registerTool(
      r.name,
      { title: r.title, description: r.description, inputSchema: r.input, annotations: READ_ONLY },
      async (args) => {
        try {
          return json(await r.resolve(args ?? {}, context));
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
        }
      },
    );
  }
  return server;
}
