// Prints a new MCP_BEARER_TOKEN line (32 random bytes, base64url). It never writes .env: add the line yourself,
// then restart the MCP container. Anyone holding the token can read everything the MCP tools expose.
import { randomBytes } from 'node:crypto';

console.log(`MCP_BEARER_TOKEN=${randomBytes(32).toString('base64url')}`);
