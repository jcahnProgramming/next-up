import { getDb } from './db.js';
import { runMigrations } from './migrations.js';
import { coreMigrations } from './schema.js';

/**
 * Boots the shared platform: opens the DB and runs core migrations.
 * Used by BOTH the web app and the MCP server entrypoints.
 *
 * readOnly (the MCP server): after migrating, the connection is switched to query_only, so SQLite itself refuses
 * every write from that process, whatever a resolver tries.
 */
export function initPlatform({ readOnly = false } = {}) {
  const db = getDb();
  runMigrations(db, 'core', coreMigrations);
  if (readOnly) db.pragma('query_only = ON');
  return { db };
}
