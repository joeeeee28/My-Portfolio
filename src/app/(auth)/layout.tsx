export const dynamic = 'force-dynamic';

/**
 * Authentication screens. No shell, no auth gate — this group exists precisely
 * so /login cannot redirect to itself.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
