/**
 * Migration runner.
 *
 * Migrations are tracked per scope (e.g. "core") in `_migrations`.
 * Each migration runs inside an IMMEDIATE transaction, so the web app and the
 * MCP server can both start at the same time without racing each other.
 */
export function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      scope      TEXT NOT NULL,
      id         TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (scope, id)
    )
  `);
}

export function runMigrations(db, scope, migrations, ctx = {}) {
  ensureMigrationsTable(db);
  // A large migration can hold the write lock for a long time. The other process (web or MCP)
  // booting at the same time must WAIT for it, not fail with SQLITE_BUSY after the normal 5 s:
  // raise the busy timeout while migrating, then restore it.
  const previousTimeout = db.pragma('busy_timeout', { simple: true });
  db.pragma('busy_timeout = 600000');
  try {
    applyAll(db, scope, migrations, ctx);
  } finally {
    db.pragma(`busy_timeout = ${previousTimeout}`);
  }
}

function applyAll(db, scope, migrations, ctx) {
  const isApplied = db.prepare('SELECT 1 FROM _migrations WHERE scope = ? AND id = ?');
  const record = db.prepare('INSERT INTO _migrations (scope, id) VALUES (?, ?)');

  for (const migration of migrations) {
    if (!migration?.id || typeof migration.up !== 'function') {
      throw new Error(`[${scope}] invalid migration: each needs { id, up(db, ctx) }`);
    }
    const apply = db.transaction(() => {
      if (isApplied.get(scope, migration.id)) return false;
      migration.up(db, ctx);
      record.run(scope, migration.id);
      return true;
    });
    if (apply.immediate()) console.log(`[migrate] ${scope}: applied ${migration.id}`);
  }
}
