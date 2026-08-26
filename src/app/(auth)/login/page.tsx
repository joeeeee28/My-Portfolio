import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { boot } from '@/lib/boot';
import { resolveAuth, workspaceNeedsSetup } from '@/lib/auth';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  boot();
  const setup = workspaceNeedsSetup();
  // Already signed in and the workspace is secured — nothing to do here.
  const auth = await resolveAuth();
  if (auth && !setup) redirect('/');

  return <LoginForm needsSetup={setup} />;
}
