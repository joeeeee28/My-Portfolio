import { NextResponse, type NextRequest } from 'next/server';
import { boot } from '@/lib/boot';
import { get } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * In-app hosting for published sites (§34).
 * This is a real, viewable URL served by the application. It is deliberately
 * reported as "preview" rather than "live" until an external host is configured,
 * because it is not a production CDN.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const orgId = boot();
  const { slug } = await params;

  const site = get<{ id: string; html: string | null; status: string; name: string }>(
    'SELECT id, html, status, name FROM websites WHERE org_id = ? AND (id = ? OR name = ?) ORDER BY created_at DESC LIMIT 1',
    [orgId, slug, slug.replace(/-/g, ' ')]
  );

  if (!site?.html) {
    return new NextResponse(notFound(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  return new NextResponse(site.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-ClientForge-Host': 'in-app-preview',
    },
  });
}

function notFound(): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Not found</title></head>
<body style="font-family:system-ui;padding:40px"><h1>Site not found</h1>
<p>This site is served by the ClientForge in-app preview host. Publish a Website Concept to make it available here.</p></body></html>`;
}
