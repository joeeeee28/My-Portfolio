/**
 * Authorization (§35, §36, §37).
 *
 * `requireSession` is the single gate every protected route calls. It resolves
 * the session, confirms it is live, and returns the caller's organisation — so
 * tenant scoping is never optional at a call site.
 *
 * `requireCapability` enforces role-based access. Roles are defined in
 * src/lib/domain.ts; a missing capability throws rather than silently allowing.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import crypto from 'crypto';
import { get, run } from '@/db';
import { nowIso } from '@/lib/id';
import { audit } from '@/lib/logging';
import { bootstrapOrg, type UserRow } from '@/lib/settings';
import { can, type Role } from '@/lib/domain';

const COOKIE = 'cf_session';

export interface AuthContext {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  initials: string;
  /** True when the workspace has no password set yet (first run). */
  needsSetup: boolean;
}

/**
 * True when the workspace has never had a password set (first run).
 * Lives here rather than in the 'use server' module because it is synchronous
 * and Next.js requires every server-action export to be async.
 */
export function workspaceNeedsSetup(): boolean {
  try {
    const { org } = bootstrapOrg();
    const owner = get<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT 1',
      [org.id]
    );
    return !owner?.password_hash;
  } catch {
    return true;
  }
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Resolves the live session, or null when the caller is unauthenticated. */
export async function resolveAuth(): Promise<AuthContext | null> {
  const { org, user: owner } = bootstrapOrg();
  const needsSetup = !owner.password_hash;

  const store = await cookies();
  const token = store.get(COOKIE)?.value;

  if (token) {
    const session = get<{ user_id: string; expires_at: string; revoked_at: string | null }>(
      'SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
      [sha(token)]
    );
    if (session && !session.revoked_at && new Date(session.expires_at).getTime() > Date.now()) {
      const u = get<UserRow>('SELECT * FROM users WHERE id = ? AND is_active = 1', [session.user_id]);
      if (u) {
        return {
          userId: u.id,
          orgId: u.org_id,
          email: u.email,
          name: u.name,
          role: u.role as Role,
          initials: u.avatar_initials ?? initialsOf(u.name),
          needsSetup,
        };
      }
    }
  }

  // First run: no password has been set yet. We deliberately do NOT hand back
  // the owner identity here — that would grant full access to anyone who can
  // reach the URL. Instead the caller is treated as unauthenticated and sent to
  // /login, which offers the setup form. Securing the workspace is the first
  // thing a user does, not something that can be skipped.
  return null;
}

/**
 * Gate for protected routes. Redirects to /login when unauthenticated.
 * Returns the auth context, which carries the caller's orgId — use it for
 * every query so tenant isolation cannot be forgotten.
 */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await resolveAuth();
  if (!auth) redirect('/login');
  return auth;
}

/** Enforces a capability. Throws on denial, and logs the attempt. */
export function requireCapability(auth: AuthContext, capability: string): void {
  if (can(auth.role, capability)) return;
  audit(auth.orgId, 'rbac.denied', {
    actor: 'user',
    userId: auth.userId,
    entityType: 'user',
    entityId: auth.userId,
    detail: { role: auth.role, capability },
    severity: 'warn',
  });
  throw new Error(`forbidden: ${auth.role} cannot ${capability}`);
}

/** True when the caller may perform the capability. */
export function may(auth: AuthContext, capability: string): boolean {
  return can(auth.role, capability);
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** Expires sessions that have lapsed, so the table does not grow unbounded. */
export function pruneSessions(): number {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const { changes } = run('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?', [cutoff, cutoff]);
  return changes;
}

export function sessionSummary(orgId: string) {
  const active = get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.org_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?",
    [orgId, nowIso()]
  );
  const logins24h = get<{ ok: number; failed: number }>(
    `SELECT SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
       FROM login_attempts WHERE org_id = ? AND created_at >= ?`,
    [orgId, new Date(Date.now() - 86_400_000).toISOString()]
  );
  return {
    activeSessions: active?.c ?? 0,
    logins24h: logins24h?.ok ?? 0,
    failedLogins24h: logins24h?.failed ?? 0,
  };
}
