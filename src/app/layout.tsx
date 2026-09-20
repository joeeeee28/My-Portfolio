import type { Metadata, Viewport } from 'next';
import './globals.css';
import { boot } from '@/lib/boot';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: {
    default: `${BRAND.name} — ${BRAND.tagline}`,
    template: `%s · ${BRAND.name}`,
  },
  description: BRAND.description,
  // Client concepts are deliberately shareable; nothing else is embeddable.
  referrer: 'strict-origin-when-cross-origin',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#c2410c',
};

export const dynamic = 'force-dynamic';

/**
 * Root layout is deliberately bare. The staff shell and its auth gate live in
 * (app)/layout.tsx so that /login, the client portal and public concept
 * previews are not caught by the staff authentication redirect.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  boot();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
