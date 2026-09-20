/**
 * Password hashing and verification (§35).
 *
 * scrypt from Node's crypto — memory-hard, no native dependency, no external
 * service. Parameters follow OWASP guidance for interactive login. The stored
 * format is self-describing so parameters can be upgraded later without
 * invalidating existing hashes.
 */
import crypto from 'crypto';
import { timingSafeEqual } from 'crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

export interface HashResult {
  hash: string;
}

/** Hashes a password. Never store the plaintext. */
export function hashPassword(password: string): HashResult {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2,
  });
  return {
    hash: `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`,
  };
}

/**
 * Verifies a password against a stored hash. Uses a constant-time comparison
 * so response timing cannot leak whether an account exists.
 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) {
    // Burn comparable time so a missing account is not distinguishable by latency.
    crypto.scryptSync(password, crypto.randomBytes(SALT_BYTES), SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
      maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2,
    });
    return false;
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than the current standard. */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_PARAMS.N || Number(parts[2]) < SCRYPT_PARAMS.r || Number(parts[3]) < SCRYPT_PARAMS.p;
}

export interface PasswordIssue {
  code: 'too_short' | 'too_long' | 'common' | 'no_variety';
  message: string;
}

const COMMON = new Set([
  'password', 'password1', '123456', '12345678', 'qwerty', 'letmein', 'welcome', 'admin',
  'clientforge', 'clientforge1', 'changeme', 'iloveyou', 'abc123', '111111', 'password123',
]);

/** Password policy. Returns every violation so the UI can show them all at once. */
export function validatePassword(password: string): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (!password || password.length < 10) issues.push({ code: 'too_short', message: 'Must be at least 10 characters.' });
  if (password && password.length > 200) issues.push({ code: 'too_long', message: 'Must be under 200 characters.' });
  if (password && COMMON.has(password.toLowerCase())) issues.push({ code: 'common', message: 'That password is too common.' });
  if (password && password.length >= 10 && password.length < 20 && !/[A-Z]/.test(password) && !/[0-9]/.test(password) && !/[^A-Za-z0-9]/.test(password)) {
    issues.push({ code: 'no_variety', message: 'Add an uppercase letter, a number or a symbol.' });
  }
  return issues;
}

export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join('');
}
