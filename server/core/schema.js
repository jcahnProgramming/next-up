import { randomBytes } from 'node:crypto';

/**
 * Core migrations, applied in order and recorded in `_migrations` (core/migrations.js).
 * Each is { id: '001_name', up(db) }. Never edit or reorder one that has shipped: add a new one.
 */
export const coreMigrations = [
  {
    // Boards, the append-only change log every board change writes to, and the key that signs access grants.
    id: '001_boards_events',
    up(db) {
      db.exec(`
        CREATE TABLE boards (
          id               INTEGER PRIMARY KEY,
          -- Normalised (lower case) at the edge, so PNC-Raids and pnc-raids are one board.
          code             TEXT NOT NULL UNIQUE CHECK (code = lower(code) AND length(code) BETWEEN 3 AND 32),
          -- argon2id (core/passwords.js). NULL: an open board, for life.
          password_hash    TEXT,
          -- 0 on an open board; 1 when created with a password; +1 on every change. Access grants carry it, so a
          -- change sends browsers holding the old one to "the board's password changed".
          password_version INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          -- Set when a board is retired; purged 24 h later (not built yet).
          deleted_at       TEXT,
          CHECK ((password_hash IS NULL AND password_version = 0) OR (password_hash IS NOT NULL AND password_version >= 1))
        ) STRICT;

        -- The access rules, held by the database as well as the app.
        CREATE TRIGGER boards_password_only_at_creation BEFORE UPDATE OF password_hash ON boards
          WHEN OLD.password_hash IS NULL AND NEW.password_hash IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'an open board can never gain a password'); END;
        CREATE TRIGGER boards_password_never_removed BEFORE UPDATE OF password_hash ON boards
          WHEN OLD.password_hash IS NOT NULL AND NEW.password_hash IS NULL
          BEGIN SELECT RAISE(ABORT, 'a board password can be changed but never removed'); END;
        CREATE TRIGGER boards_password_change_bumps_version BEFORE UPDATE OF password_hash ON boards
          WHEN OLD.password_hash IS NOT NULL AND NEW.password_hash IS NOT NULL
            AND OLD.password_hash IS NOT NEW.password_hash AND NEW.password_version <= OLD.password_version
          BEGIN SELECT RAISE(ABORT, 'a password change must raise password_version'); END;
        CREATE TRIGGER boards_purge_only_retired BEFORE DELETE ON boards
          WHEN OLD.deleted_at IS NULL
          BEGIN SELECT RAISE(ABORT, 'only a retired board is ever purged'); END;

        CREATE TABLE events (
          id         INTEGER PRIMARY KEY,
          board_id   INTEGER NOT NULL REFERENCES boards (id),
          type       TEXT NOT NULL,
          actor      TEXT NOT NULL,
          payload    TEXT NOT NULL CHECK (json_valid(payload)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ) STRICT;
        CREATE INDEX events_board_time ON events (board_id, created_at);

        -- Append-only: never changed; deleted only as part of purging a retired board.
        CREATE TRIGGER events_append_only BEFORE UPDATE ON events
          BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
        CREATE TRIGGER events_purge_only_retired BEFORE DELETE ON events
          WHEN (SELECT deleted_at FROM boards WHERE id = OLD.board_id) IS NULL
          BEGIN SELECT RAISE(ABORT, 'events are append-only; only a retired board''s history is purged'); END;

        -- Server-side keys. Never returned by any API or MCP tool.
        CREATE TABLE server_secrets (
          name  TEXT PRIMARY KEY,
          value BLOB NOT NULL
        ) STRICT;
      `);
      db.prepare('INSERT INTO server_secrets (name, value) VALUES (?, ?)').run('access_grant_key', randomBytes(32));
    },
  },
];
