import { NextResponse } from 'next/server';
import { boot } from '@/lib/boot';
import { getMockupByToken, recordMockupView } from '@/engine/mockup';
import { stableHash } from '@/lib/id';
import { parse, viewBeaconSchema } from '@/lib/validation';
import { checkAndConsume } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const VIEWER_COOKIE = 'cf_viewer';
const RATE_LIMIT_PER_MIN = 30;

/**
 * View-tracking beacon (§23, §24).
 *
 * Anonymous and public, so every field is parsed and bounded before it is used
 * or stored. Rate limited per visitor so a hostile client cannot fill the
 * mockup_views table.
 */
export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const orgId = boot();

  let raw: unknown;
  if (req.method === 'POST') {
    try {
      raw = await req.json();
    } catch {
      raw = Object.fromEntries(new URL(req.url).searchParams.entries());
    }
  } else {
    raw = Object.fromEntries(new URL(req.url).searchParams.entries());
  }

  const parsed = parse(viewBeaconSchema, raw);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, errors: parsed.errors }, { status: 400 });
  }
  const payload = parsed.data;
  if (!payload.token) {
    return NextResponse.json({ ok: false, error: 'missing token' }, { status: 400 });
  }

  const mockup = getMockupByToken(orgId, payload.token);
  if (!mockup || mockup.share_enabled !== 1) {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  // Rate limit per visitor so a hostile client cannot inflate view counts.
  const visitorHint = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = checkAndConsume(`track:${stableHash(visitorHint)}`, 'api', RATE_LIMIT_PER_MIN, 1);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate limited' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } }
    );
  }

  const cookieToken = cookieValue(req, VIEWER_COOKIE);
  const visitorToken = cookieToken ?? stableHash(`${stableHash(visitorHint)}:${Date.now()}`, 'visitor');
  const isReturning = !!cookieToken;

  try {
    recordMockupView(orgId, mockup, {
      visitorToken,
      isReturning,
      device: payload.device || 'unknown',
      viewport: payload.viewport ?? null,
      userAgent: bounded(req.headers.get('user-agent'), 300),
      referrer: bounded(req.headers.get('referer'), 300),
      durationMs: payload.durationMs,
      scrolledPct: Math.round(payload.scrolledPct),
      sectionsSeen: payload.sectionsSeen,
      ctaClicked: payload.ctaClicked === true || payload.ctaClicked === '1' || payload.ctaClicked === 'true',
    });
  } catch {
    // Tracking must never break the prospect's view of the concept.
  }

  const res = NextResponse.json({ ok: true });
  if (!cookieToken) {
    res.cookies.set(VIEWER_COOKIE, visitorToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
  }
  return res;
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.split('=');
    if (k.trim() === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function bounded(value: string | null, max: number): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
