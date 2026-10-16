/**
 * Board codes: 3–32 characters, letters (a–z), numbers and hyphens, case-insensitive. Stored and used in URLs in
 * lower case, so PNC-Raids and pnc-raids are the same board.
 *
 * Plain JS with no Node imports: the client imports this same file, so the browser and the server can never disagree
 * about what a code is.
 */
export const CODE_MIN = 3;
export const CODE_MAX = 32;

/** The code as stored: trimmed and lower-cased. Doesn't validate. */
export function normalizeCode(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * { ok: true, code } with the normalised code, or { ok: false, error } with a message for the person typing it.
 * The message never repeats the code.
 */
export function checkCode(value) {
  const code = normalizeCode(value);
  if (!code) return { ok: false, error: 'Type a board code.' };
  if (/[^a-z0-9-]/.test(code)) return { ok: false, error: 'Codes use only letters, numbers and hyphens.' };
  if (code.length < CODE_MIN) return { ok: false, error: `Codes are at least ${CODE_MIN} characters.` };
  if (code.length > CODE_MAX) return { ok: false, error: `Codes are at most ${CODE_MAX} characters.` };
  return { ok: true, code };
}

/** Board passwords: chosen once, at creation. Length counts characters, not bytes. Never trimmed. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function checkNewPassword(value) {
  if (typeof value !== 'string') return { ok: false, error: 'The password must be text.' };
  const length = [...value].length;
  if (length < PASSWORD_MIN) return { ok: false, error: `Passwords are at least ${PASSWORD_MIN} characters.` };
  if (length > PASSWORD_MAX) return { ok: false, error: `Passwords are at most ${PASSWORD_MAX} characters.` };
  if (!value.trim()) return { ok: false, error: "A password can't be only spaces." };
  return { ok: true };
}
