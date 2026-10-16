import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Access grants: how a browser remembers it has opened a board.
 *
 * One httpOnly cookie per board, scoped by Path to that board's API (/api/boards/<code>), so it is only ever sent to
 * that board and page script can't read it. Its value is `<boardId>.<passwordVersion>.<mac>`, signed with a key kept
 * in the database (server_secrets.access_grant_key). It holds nothing secret: no password, no hash.
 *
 *   valid   signed for this board (by id, so a later board on the same code inherits nothing) at its current version
 *   stale   genuinely ours, for this board, but an older password version: "the board's password changed"
 *   none    absent, tampered with, or for another board
 *
 * Open boards get one too (version 0). It grants nothing they don't already allow; it is how a board you've opened
 * before still opens by its link while your network is rate-limited for unknown codes.
 */
export const GRANT_COOKIE = 'nu_access';
const MAX_AGE_S = 400 * 24 * 60 * 60; // the longest browsers keep a cookie; re-locking removes it sooner

export function createGrants(db) { // db: () => the connection, opened on first use
  let key = null;
  const getKey = () => {
    key ??= db().prepare("SELECT value FROM server_secrets WHERE name = 'access_grant_key'").pluck().get();
    if (!key) throw new Error('access grant key missing');
    return key;
  };
  const mac = (boardId, version) =>
    createHmac('sha256', getKey()).update(`grant|${boardId}|${version}`).digest('base64url');

  return {
    /** 'valid' | 'stale' | 'none' for this board row. */
    read(req, board) {
      const value = readCookie(req, GRANT_COOKIE);
      if (!value || !board) return 'none';
      const m = /^(\d{1,15})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (!m || Number(m[1]) !== board.id) return 'none';
      const version = Number(m[2]);
      const expected = Buffer.from(mac(board.id, version));
      const given = Buffer.from(m[3]);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'none';
      return version === board.password_version ? 'valid' : 'stale';
    },
    set(req, res, board) {
      const value = `${board.id}.${board.password_version}.${mac(board.id, board.password_version)}`;
      res.append('Set-Cookie', cookie(req, board.code, value, MAX_AGE_S));
    },
    clear(req, res, code) {
      res.append('Set-Cookie', cookie(req, code, '', 0));
    },
  };
}

// Secure whenever the visitor's connection was HTTPS (the tunnel says so in X-Forwarded-Proto). Over plain HTTP (the
// LAN port, local dev) a Secure cookie would be dropped, so it is left off there.
function cookie(req, code, value, maxAge) {
  const https = req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  return [
    `${GRANT_COOKIE}=${value}`,
    `Path=/api/boards/${code}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(https ? ['Secure'] : []),
  ].join('; ');
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
