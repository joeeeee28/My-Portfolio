/**
 * Session + RBAC (§55, §69).
 *
 * The workspace bootstraps a single owner on first run so the product is usable
 * immediately. Every data-access path still filters by `org_id`, so multi-tenant
 * isolation is real rather than aspirational — adding real login means issuing
 * sessions against the same `users`/`sessions` tables without touching queries.
 *
 * NOTE: this is read-only during render. Next.js forbids mutating cookies
 * outside a Server Action or Route Handler, so session *issuance* lives in
 * `issueSession()` and is called from those contexts only.
 */
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { get, run } from '@/db';
import { id, nowIso, initials } from '@/lib/id';
import { bootstrapOrg, type UserRow } from '@/lib/settings';
import { can, type Role } from '@/lib/domain';
import { audit } from '@/lib/logging';

const COOKIE = 'cf_session';

export interface Session {
  userId: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  initials: string;
}

/**
 * Resolves the current session without side effects.
 * Falls back to the workspace owner for the single-user bootstrap.
 */
export async function getSession(): Promise<Session> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;

  if (token) {
    const session = get<{ user_id: string; expires_at: string }>(
      'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?',
      [sha(token)]
    );
    if (session && new Date(session.expires_at).getTime() > Date.now()) {
      const u = get<UserRow>('SELECT * FROM users WHERE id = ?', [session.user_id]);
      if (u) return toSession(u);
    }
  }

  // Single-user bootstrap: resolve the workspace owner directly.
  const { org, user } = bootstrapOrg();
  return { ...toSession(user), orgId: org.id };
}

function toSession(u: UserRow): Session {
  return {
    userId: u.id,
    orgId: u.org_id,
    name: u.name,
    email: u.email,
    role: u.role as Role,
    initials: u.avatar_initials ?? initials(u.name),
  };
}

/**
 * Issues a session cookie. Must be called from a Server Action or Route Handler
 * — never during page render.
 */
export async function issueSession(userId: string): Promise<string> {
  const store = await cookies();
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
  run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)', [
    id('ses'),
    userId,
    sha(token),
    expires,
    nowIso(),
  ]);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), userId]);
  store.set(COOKIE, token, { httpOnly: true, sameSite: 'lax', expires: new Date(expires), path: '/' });
  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
  store.delete(COOKIE);
}

export function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function requireCapability(role: Role, capability: string): void {
  if (!can(role, capability)) {
    audit('', 'rbac.denied', { actor: 'user', detail: { role, capability }, severity: 'warn' });
    throw new Error(`forbidden: ${role} cannot ${capability}`);
  }
}
