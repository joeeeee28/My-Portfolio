'use server';

/**
 * Authentication actions (§35, §37).
 *
 * Login is rate-limited per email and per IP, every attempt is logged, and
 * sessions are opaque random tokens stored hashed — the cookie value is never
 * usable as a lookup key if the database leaks.
 */
import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import { redirect } from 'next/navigation';
import { all, get, run } from '@/db';
import { nowIso } from '@/lib/id';
import { hashPassword, needsRehash, validatePassword, verifyPassword } from '@/lib/password';
import { workspaceNeedsSetup } from '@/lib/auth';
import { audit } from '@/lib/logging';
import { bootstrapOrg, type UserRow } from '@/lib/settings';
import { consumeRateLimit, isRateLimited } from '@/lib/ratelimit';

const COOKIE = 'cf_session';
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MIN = 15;
const LOGIN_MAX_ATTEMPTS = 8;

export interface AuthResult {
  ok: boolean;
  message: string;
  needsSetup?: boolean;
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ipHash(headers?: Headers): string {
  const ip = headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return sha(ip).slice(0, 16);
}

export async function setupOwnerPassword(formData: FormData): Promise<AuthResult> {
  if (!workspaceNeedsSetup()) return { ok: false, message: 'A password is already set. Use the login form.' };
  const { org } = bootstrapOrg();
  const owner = get<UserRow>('SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT 1', [org.id]);
  if (!owner) return { ok: false, message: 'Workspace not initialised.' };
  if (owner.password_hash) return { ok: false, message: 'A password is already set. Use the login form.' };

  const email = String(formData.get('email') ?? owner.email).trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (password !== confirm) return { ok: false, message: 'Passwords do not match.' };
  const issues = validatePassword(password);
  if (issues.length) return { ok: false, message: issues.map((i) => i.message).join(' ') };

  run('UPDATE users SET email = ?, password_hash = ?, updated_at = ? WHERE id = ?', [
    email,
    hashPassword(password).hash,
    nowIso(),
    owner.id,
  ]);
  audit(org.id, 'auth.password_set', { actor: 'user', entityType: 'user', entityId: owner.id, severity: 'warn' });

  await issueSession(owner.id);
  redirect('/');
}

export async function login(formData: FormData): Promise<AuthResult> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const scope = `login:${sha(email).slice(0, 16)}`;

  // Rate limit before touching the database, so a brute-force attempt cannot
  // be used to enumerate accounts by response time.
  if (isRateLimited(scope, 'auth', LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MIN)) {
    audit('', 'auth.rate_limited', { actor: 'user', detail: { email }, severity: 'warn' });
    return { ok: false, message: `Too many attempts. Try again in ${LOGIN_WINDOW_MIN} minutes.` };
  }

  consumeRateLimit(scope, 'auth', LOGIN_WINDOW_MIN);

  if (!email || !password) {
    return { ok: false, message: 'Enter your email and password.' };
  }

  const { org } = bootstrapOrg();
  const user = get<UserRow>('SELECT * FROM users WHERE org_id = ? AND LOWER(email) = LOWER(?) AND is_active = 1', [org.id, email]);

  const valid = verifyPassword(password, user?.password_hash ?? null);
  const attemptId = `la_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  run(
    'INSERT INTO login_attempts (id, org_id, email, success, ip_hash, created_at) VALUES (?,?,?,?,?,?)',
    [attemptId, org.id, email, valid ? 1 : 0, null, nowIso()]
  );

  if (!user) {
    audit(org.id, 'auth.login_failed', { actor: 'user', detail: { email, reason: 'no such user' }, severity: 'warn' });
    // Same message as a bad password — do not reveal whether the account exists.
    return { ok: false, message: 'Email or password is incorrect.' };
  }

  if (!valid) {
    audit(org.id, 'auth.login_failed', { actor: 'user', entityType: 'user', entityId: user.id, detail: { email }, severity: 'warn' });
    return { ok: false, message: 'Email or password is incorrect.' };
  }

  // Transparently upgrade weak hashes on a successful login.
  if (needsRehash(user.password_hash)) {
    run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(password).hash, nowIso(), user.id]);
  }

  await issueSession(user.id);
  audit(org.id, 'auth.login', { actor: 'user', entityType: 'user', entityId: user.id, severity: 'info' });
  redirect('/');
}

async function issueSession(userId: string): Promise<void> {
  const store = await cookies();
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)', [
    `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    sha(token),
    expires.toISOString(),
    nowIso(),
  ]);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), userId]);
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires,
    path: '/',
  });
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) {
    run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [nowIso(), sha(token)]);
  }
  store.delete(COOKIE);
  redirect('/login');
}

export async function changePassword(formData: FormData): Promise<AuthResult> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return { ok: false, message: 'Not signed in.' };

  const session = get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL',
    [sha(token)]
  );
  if (!session || new Date(session.expires_at).getTime() < Date.now()) return { ok: false, message: 'Session expired.' };

  const user = get<UserRow>('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user) return { ok: false, message: 'User not found.' };

  const current = String(formData.get('current') ?? '');
  const next = String(formData.get('next') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (!verifyPassword(current, user.password_hash)) return { ok: false, message: 'Current password is incorrect.' };
  if (next !== confirm) return { ok: false, message: 'New passwords do not match.' };
  const issues = validatePassword(next);
  if (issues.length) return { ok: false, message: issues.map((i) => i.message).join(' ') };

  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(next).hash, nowIso(), user.id]);
  // Invalidate every other session.
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL', [
    nowIso(),
    user.id,
    sha(token),
  ]);
  audit(user.org_id, 'auth.password_changed', { actor: 'user', entityType: 'user', entityId: user.id, severity: 'warn' });
  return { ok: true, message: 'Password changed. Other sessions were signed out.' };
}

/** Sliding expiry: extend an active session so long sessions do not drop. */
export async function touchSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return;
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  run('UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [expires.toISOString(), sha(token)]);
}

/** Recent authentication events, for the Security section of Settings. */
export async function recentLoginAttempts(limit = 20) {
  return all<{ id: string; email: string; success: number; created_at: string }>(
    'SELECT id, email, success, created_at FROM login_attempts ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}
