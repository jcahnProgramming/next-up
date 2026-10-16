import argon2 from 'argon2';

/**
 * Board passwords are stored only as argon2id hashes (salted; the salt and these settings are encoded in the hash, so
 * they can be raised later without breaking existing boards). Plain passwords are never stored, logged or returned.
 *
 * 64 MiB, 3 passes, 1 lane: RFC 9106's second recommended setting, with one lane so a single check costs the
 * server one thread. Measured on the dev machine: ~78 ms per check; <HOST> is slower.
 */
export const HASH_OPTIONS = Object.freeze({ type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });

// Longer input than any allowed password is refused before hashing, so nobody can make the server hash megabytes.
const MAX_INPUT = 1024;

export function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

/** True only for the right password. Anything that isn't a short string is simply wrong (and costs no hashing). */
export async function verifyPassword(hash, password) {
  if (typeof hash !== 'string' || typeof password !== 'string' || !password || password.length > MAX_INPUT) return false;
  return argon2.verify(hash, password);
}
