import { NextResponse, type NextRequest } from 'next/server';
import { boot } from '@/lib/boot';
import { getMockupByToken, recordMockupView } from '@/engine/mockup';
import { get, run } from '@/db';
import { stableHash, nowIso } from '@/lib/id';

export const dynamic = 'force-dynamic';

const VIEWER_COOKIE = 'cf_viewer';

/**
 * View-tracking beacon (§23, §24).
 * Accepts both POST (sendBeacon) and GET (tracking pixel) so opens are recorded
 * even in clients that block beacon payloads.
 */
export async function POST(req: NextRequest) {
  return handle(req, 'post');
}

export async function GET(req: NextRequest) {
  return handle(req, 'get');
}

async function handle(req: NextRequest, mode: 'post' | 'get') {
  const orgId = boot();
  let payload: Record<string, unknown> = {};

  if (mode === 'post') {
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      payload = Object.fromEntries(req.nextUrl.searchParams.entries());
    }
  } else {
    payload = Object.fromEntries(req.nextUrl.searchParams.entries());
  }

  const token = String(payload.token ?? '');
  if (!token) return NextResponse.json({ ok: false, error: 'missing token' }, { status: 400 });

  const mockup = getMockupByToken(orgId, token);
  if (!mockup || mockup.share_enabled !== 1) {
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  // Identify the visitor without storing an IP.
  const cookieToken = req.cookies.get(VIEWER_COOKIE)?.value;
  const visitorToken = cookieToken ?? stableHash(`${stableHash(req.headers.get('x-forwarded-for') ?? 'unknown', 'ip')}:${Date.now()}`, 'visitor');
  const isReturning = !!cookieToken;

  const durationMs = Math.max(0, Math.min(3_600_000, Number(payload.durationMs ?? 0)));
  const scrolledPct = Math.max(0, Math.min(100, Number(payload.scrolledPct ?? 0)));
  const sectionsSeen = Array.isArray(payload.sectionsSeen) ? (payload.sectionsSeen as unknown[]).map(String) : [];

  try {
    recordMockupView(orgId, mockup, {
      visitorToken,
      isReturning,
      device: String(payload.device ?? 'unknown'),
      viewport: payload.viewport ? String(payload.viewport) : null,
      userAgent: req.headers.get('user-agent'),
      referrer: req.headers.get('referer'),
      durationMs,
      scrolledPct,
      sectionsSeen,
      ctaClicked: payload.ctaClicked === true || payload.ctaClicked === '1',
    });
  } catch {
    // Tracking must never break the prospect's view of the page.
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
