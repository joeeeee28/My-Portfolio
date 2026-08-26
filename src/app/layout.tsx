import type { Metadata, Viewport } from 'next';
import './globals.css';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: {
    default: `${BRAND.name} — ${BRAND.tagline}`,
    template: `%s · ${BRAND.name}`,
  },
  description: BRAND.description,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#c2410c',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  boot();
  const session = await getSession();

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <div className="shell">
          <Sidebar />
          <div className="main">
            <Topbar user={session} />
            <main className="content">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
