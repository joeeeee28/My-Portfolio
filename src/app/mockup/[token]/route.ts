import { NextResponse, type NextRequest } from 'next/server';
import { boot } from '@/lib/boot';
import { getMockupByToken, getVersionHtml } from '@/engine/mockup';

export const dynamic = 'force-dynamic';

/**
 * Public concept preview (§23). Serves the current version of the generated
 * site. View tracking is fired from inside the page itself.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const orgId = boot();
  const { token } = await params;
  const mockup = getMockupByToken(orgId, token);

  if (!mockup) {
    return new NextResponse(notFoundPage('This concept is no longer available.'), { status: 404, headers: htmlHeaders() });
  }
  if (mockup.share_enabled !== 1) {
    return new NextResponse(notFoundPage('Sharing has been disabled for this concept.'), { status: 403, headers: htmlHeaders() });
  }

  const html = getVersionHtml(mockup.id, mockup.current_version);
  if (!html) {
    return new NextResponse(notFoundPage('This concept has no rendered version yet.'), { status: 404, headers: htmlHeaders() });
  }

  return new NextResponse(html, {
    status: 200,
    headers: {
      ...htmlHeaders(),
      // Preview pages are intentionally embeddable so the workspace can frame them.
      'X-Frame-Options': 'ALLOWALL',
      'Cache-Control': 'no-store',
    },
  });
}

function htmlHeaders() {
  return { 'content-type': 'text/html; charset=utf-8' };
}

function notFoundPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ClientForge AI</title>
<style>
body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f8fa;color:#0e1116;
display:grid;place-items:center;min-height:100vh}
.box{max-width:440px;padding:32px;background:#fff;border:1px solid #d9dee6;border-radius:8px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#5b6473;margin:0}
.mark{width:36px;height:36px;border-radius:8px;background:linear-gradient(140deg,#c2410c,#7c2d12);margin:0 auto 14px;display:grid;place-items:center}
.mark span{color:#fff;font-weight:700;font-size:15px}
</style></head><body><div class="box">
<div class="mark"><span>C</span></div>
<h1>ClientForge AI</h1><p>${message}</p></div></body></html>`;
}
