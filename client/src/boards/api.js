import { readDisplayName } from '../prefs/displayName.js';

/**
 * The boards API (server/boards/routes.js). Every call resolves to one plain result, never throws:
 *
 *   { kind: 'open', board }             open board, or a password board this browser has unlocked
 *   { kind: 'locked', changed }         password board without access (changed: the password changed since)
 *   { kind: 'free', full }              nobody has this code (full: Next Up is at its board limit)
 *   { kind: 'limited', what, retryAfter }  what: 'lookups' | 'passwords'; retryAfter in seconds
 *   { kind: 'wrong' }                   wrong password
 *   { kind: 'exists' } | { kind: 'full' }  creation refused
 *   { kind: 'invalid', field, error }   the server refused an input
 *   { kind: 'error', offline }          couldn't reach Next Up, or it failed (never shown as "nothing here")
 *
 * Access is an httpOnly cookie the server sets; this code never sees or stores it.
 */
const TIMEOUT_MS = 10_000;

/**
 * One request to the API: { status, data } with the parsed JSON body, or { failed: true, offline } when Next Up
 * couldn't be reached or didn't answer in JSON. Never throws. Shared with cards/api.js.
 */
export async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { failed: true, offline: typeof navigator !== 'undefined' && navigator.onLine === false };
  }
  try {
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  } catch {
    return { failed: true, offline: false };
  }
}

async function call(path, opts) {
  const r = await request(path, opts);
  return r.failed ? { kind: 'error', offline: r.offline } : read(r.status, r.data);
}

function read(status, data) {
  if (status === 204) return { kind: 'done' };
  if (data?.status === 'open') return { kind: 'open', board: data.board };
  if (data?.status === 'locked') return { kind: 'locked', changed: data.reason === 'password_changed' };
  if (data?.status === 'free') return { kind: 'free', full: Boolean(data.full) };
  if (status === 429) {
    return { kind: 'limited', what: data?.code === 'too_many_passwords' ? 'passwords' : 'lookups', retryAfter: Number(data?.retryAfter) || 60 };
  }
  if (data?.code === 'wrong_password') return { kind: 'wrong' };
  if (data?.code === 'exists') return { kind: 'exists' };
  if (data?.code === 'board_limit') return { kind: 'full' };
  if (status === 400 && data?.field) return { kind: 'invalid', field: data.field, error: data.error };
  return { kind: 'error', offline: false };
}

export const lookupBoard = (code) => call(`/api/boards/${code}`);

export const createBoard = (code, password) =>
  call('/api/boards', { method: 'POST', body: { code, password: password || undefined, actor: readDisplayName() ?? undefined } });

export const unlockBoard = (code, password) => call(`/api/boards/${code}/unlock`, { method: 'POST', body: { password } });

export const lockBoard = (code) => call(`/api/boards/${code}/lock`, { method: 'POST' });
