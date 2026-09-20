import { NextResponse } from 'next/server';
import { boot } from '@/lib/boot';
import { handleOptOut } from '@/engine/compliance';
import { getBusiness } from '@/repo/business';
import { parse, optOutSchema } from '@/lib/validation';
import { checkAndConsume } from '@/lib/ratelimit';
import { stableHash } from '@/lib/id';

export const dynamic = 'force-dynamic';

/**
 * Opt-out endpoint (§56).
 *
 * Anonymous and public. Input is validated, the token must match the business
 * id, and the endpoint is rate limited so it cannot be used to mass-suppress
 * the prospect database.
 *
 * Idempotent: opting out twice suppresses once.
 */
export async function GET(req: Request) {
  const orgId = boot();
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());

  const parsed = parse(optOutSchema, params);
  if (!parsed.ok) {
    return page('Invalid request', 'This opt-out link is malformed.', 400);
  }
  const input = parsed.data;

  // Rate limit so the endpoint cannot be used to mass-suppress records.
  const hint = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = checkAndConsume(`optout:${stableHash(hint)}`, 'api', 20, 10);
  if (!limit.allowed) {
    return page('Too many requests', 'Please try again shortly.', 429);
  }

  // The token must match the business id, so one link cannot suppress another
  // prospect's record.
  if (!input.business || input.token !== input.business) {
    return page('Invalid link', 'This opt-out link is not valid.', 400);
  }

  const business = getBusiness(orgId, input.business);
  if (!business) {
    return page('Not found', 'We could not find that record.', 404);
  }

  handleOptOut(orgId, {
    businessId: input.business,
    channel: input.channel,
    reason: input.reason ?? 'unsubscribe link',
  });

  return page(
    'You will not hear from us again',
    `${escapeHtml(business.name)} has been added to the do-not-contact list. All sequences, scheduled messages and follow-ups for this business have been stopped, across every channel.`,
    200
  );
}

function page(title: string, body: string, status: number): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · ClientForge AI</title>
<style>
body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f8fa;color:#0e1116;display:grid;place-items:center;min-height:100vh}
.box{max-width:460px;padding:32px;background:#fff;border:1px solid #d9dee6;border-radius:8px}
h1{font-size:19px;margin:0 0 10px}p{font-size:14px;color:#5b6473;line-height:1.6;margin:0}
.mark{width:36px;height:36px;border-radius:8px;background:linear-gradient(140deg,#c2410c,#7c2d12);margin-bottom:16px;display:grid;place-items:center}
.mark span{color:#fff;font-weight:700;font-size:15px}
</style></head><body><div class="box">
<div class="mark"><span>C</span></div>
<h1>${escapeHtml(title)}</h1><p>${body}</p></div></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
