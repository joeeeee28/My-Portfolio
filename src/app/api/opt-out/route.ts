import { NextResponse, type NextRequest } from 'next/server';
import { boot } from '@/lib/boot';
import { handleOptOut } from '@/engine/compliance';
import { getBusiness } from '@/repo/business';

export const dynamic = 'force-dynamic';

/**
 * Opt-out / unsubscribe endpoint (§56).
 * Idempotent: hitting it twice records one suppression and stops everything.
 * The token is the business id — a real deployment would issue a signed,
 * single-purpose token instead.
 */
export async function GET(req: NextRequest) {
  const orgId = boot();
  const businessId = req.nextUrl.searchParams.get('business');
  const channel = req.nextUrl.searchParams.get('channel') ?? 'email';
  const token = req.nextUrl.searchParams.get('token');

  if (!businessId || token !== businessId) {
    return new NextResponse(page('Invalid link', 'This opt-out link is not valid.'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  const business = getBusiness(orgId, businessId);
  if (!business) {
    return new NextResponse(page('Not found', 'We could not find that record.'), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  handleOptOut(orgId, { businessId, channel, reason: 'unsubscribe link' });

  return new NextResponse(
    page(
      'You will not hear from us again',
      `${business.name} has been added to the do-not-contact list. All sequences, scheduled messages and follow-ups for this business have been stopped.`
    ),
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} · ClientForge AI</title>
<style>
body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f8fa;color:#0e1116;display:grid;place-items:center;min-height:100vh}
.box{max-width:460px;padding:32px;background:#fff;border:1px solid #d9dee6;border-radius:8px}
h1{font-size:19px;margin:0 0 10px}p{font-size:14px;color:#5b6473;line-height:1.6;margin:0}
.mark{width:36px;height:36px;border-radius:8px;background:linear-gradient(140deg,#c2410c,#7c2d12);margin-bottom:16px;display:grid;place-items:center}
.mark span{color:#fff;font-weight:700;font-size:15px}
</style></head><body><div class="box">
<div class="mark"><span>C</span></div>
<h1>${title}</h1><p>${body}</p></div></body></html>`;
}
