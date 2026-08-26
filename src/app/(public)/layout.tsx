export const dynamic = 'force-dynamic';

/**
 * Public surfaces: shared website concepts, published sites and the client
 * portal. These are reachable without staff credentials by design — the portal
 * authenticates by its own token, and concepts by their share token.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
