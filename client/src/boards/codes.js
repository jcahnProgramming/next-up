// The same rules the server enforces (server/core/codes.js, plain JS shared by both), so the two never disagree.
export { CODE_MAX, CODE_MIN, PASSWORD_MAX, PASSWORD_MIN, checkCode, checkNewPassword, normalizeCode } from '../../../server/core/codes.js';

// The address a board's link always uses, wherever Next Up was opened from (LAN, dev). Never carries a password.
export const PUBLIC_ORIGIN = 'https://nextup.postnerfclarity.com';
export const boardLink = (code) => `${PUBLIC_ORIGIN}/b/${code}`;
