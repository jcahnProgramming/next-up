import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

let db;

/**
 * Shared SQLite connection. Both the web app and the MCP server import this
 * module, so each process opens the same database file with identical pragmas.
 */
export function getDb() {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true });
  db = new Database(join(config.dataDir, config.dbFile));
  // WAL + synchronous=NORMAL: frequent writes don't block readers.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Two processes (web + MCP) share the file; wait rather than fail on a brief lock.
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
