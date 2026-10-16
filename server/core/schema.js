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
  {
    // Cards: one game on a board, in a lane, at a position. Deleting one only tombstones it (deleted_at), so History
    // can restore it; only purging a retired board ever removes the row. Go-live date, server info and players come
    // in later migrations as columns and tables of their own.
    id: '002_cards',
    up(db) {
      db.exec(`
        CREATE TABLE cards (
          id         INTEGER PRIMARY KEY,
          board_id   INTEGER NOT NULL REFERENCES boards (id),
          lane       TEXT NOT NULL CHECK (lane IN ('up_next', 'now_playing', 'played')),
          -- A fractional key (core/positions.js): base-62 digits, never ending in 0, compared as plain strings.
          position   TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 64 AND position NOT GLOB '*[^0-9A-Za-z]*' AND position NOT GLOB '*0'),
          title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
          -- A file name in logos/ without its extension; never a URL. NULL: no logo.
          logo       TEXT CHECK (logo IS NULL OR (length(logo) BETWEEN 1 AND 64 AND logo NOT GLOB '*[^a-z0-9-]*')),
          -- Bumped on every change; an edit names the version it started from, so two people can't overwrite each
          -- other's change without seeing it.
          version    INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          deleted_at TEXT
        ) STRICT;
        CREATE INDEX cards_board_order ON cards (board_id, lane, position, id);
        CREATE INDEX cards_board_time ON cards (board_id, created_at);

        -- Deleting a card is a tombstone; the row goes only when its retired board is purged.
        CREATE TRIGGER cards_purge_only_retired BEFORE DELETE ON cards
          WHEN (SELECT deleted_at FROM boards WHERE id = OLD.board_id) IS NULL
          BEGIN SELECT RAISE(ABORT, 'cards are tombstoned, never deleted; only a retired board''s cards are purged'); END;
        CREATE TRIGGER cards_stay_on_their_board BEFORE UPDATE OF board_id ON cards
          BEGIN SELECT RAISE(ABORT, 'a card never moves to another board'); END;
      `);
    },
  },
  {
    // A card's details: its go-live date and server info (columns), and the players signed up to it (a table).
    // Removing a player only tombstones it (deleted_at), so History can put them back where they were; only purging
    // a retired board ever removes the row.
    id: '003_card_detail',
    up(db) {
      db.exec(`
        -- A calendar date, 'YYYY-MM-DD', no time or zone (core/cardDetail.js). NULL: not set.
        ALTER TABLE cards ADD COLUMN go_live TEXT
          CHECK (go_live IS NULL OR (go_live GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(go_live) = go_live));
        -- Free text, shown escaped with only http(s) links made clickable. '': not set.
        ALTER TABLE cards ADD COLUMN server_info TEXT NOT NULL DEFAULT '' CHECK (length(server_info) <= 2000);

        CREATE TABLE players (
          id         INTEGER PRIMARY KEY,
          board_id   INTEGER NOT NULL REFERENCES boards (id),
          card_id    INTEGER NOT NULL REFERENCES cards (id),
          name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
          -- playerKey(name): what two live players on one card may not share (case-insensitive).
          name_key   TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          deleted_at TEXT
        ) STRICT;
        -- Sign-up order is (created_at, id): a restored player keeps both, so goes back where they were.
        CREATE INDEX players_card_time ON players (card_id, created_at, id);
        CREATE UNIQUE INDEX players_live_name ON players (card_id, name_key) WHERE deleted_at IS NULL;

        CREATE TRIGGER players_on_their_cards_board BEFORE INSERT ON players
          WHEN (SELECT board_id FROM cards WHERE id = NEW.card_id) IS NOT NEW.board_id
          BEGIN SELECT RAISE(ABORT, 'a player belongs to a card on the same board'); END;
        CREATE TRIGGER players_stay_put BEFORE UPDATE OF board_id, card_id, name, name_key, created_at ON players
          BEGIN SELECT RAISE(ABORT, 'a player is never moved or renamed; remove them and add the new name'); END;
        CREATE TRIGGER players_purge_only_retired BEFORE DELETE ON players
          WHEN (SELECT deleted_at FROM boards WHERE id = OLD.board_id) IS NULL
          BEGIN SELECT RAISE(ABORT, 'players are tombstoned, never deleted; only a retired board''s players are purged'); END;
      `);
    },
  },
  {
    // History and restore. A restore never edits the event it undoes: it is a new event whose `restores` names that
    // one, so the log stays append-only and a restore can itself be restored. `card_id` is read from the payload (a
    // VIRTUAL column: no stored row changes, old events included) so one card's history is an index lookup.
    id: '004_history_restore',
    up(db) {
      db.exec(`
        -- Set only on the events a restore writes. NULL on every event that isn't a restore (all events before 0.7.0).
        ALTER TABLE events ADD COLUMN restores INTEGER REFERENCES events (id);
        ALTER TABLE events ADD COLUMN card_id INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.cardId')) VIRTUAL;

        -- An event is restored at most once: a second Restore of it is refused by the database too.
        CREATE UNIQUE INDEX events_restored_once ON events (restores) WHERE restores IS NOT NULL;
        CREATE INDEX events_board_card_time ON events (board_id, card_id, created_at);

        CREATE TRIGGER events_restore_same_board BEFORE INSERT ON events
          WHEN NEW.restores IS NOT NULL AND (SELECT board_id FROM events WHERE id = NEW.restores) IS NOT NEW.board_id
          BEGIN SELECT RAISE(ABORT, 'a restore undoes an event on its own board'); END;
      `);
    },
  },
  {
    // Live sync (live/hub.js) reads a board's events after the last one a browser saw, in id order: an index lookup.
    id: '005_live_sync',
    up(db) {
      db.exec('CREATE INDEX events_board_seq ON events (board_id, id);');
    },
  },
];
