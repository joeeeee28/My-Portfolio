import { requireAuth } from '@/lib/auth';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';

export const dynamic = 'force-dynamic';

/**
 * Staff application shell.
 *
 * `requireAuth` is the single authentication gate for every staff route (§35).
 * It redirects unauthenticated callers to /login and returns the caller's
 * organisation, so tenant scoping is established once, here.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAuth();

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <Topbar user={session} />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
