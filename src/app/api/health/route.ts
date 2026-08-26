import { NextResponse } from 'next/server';
import { boot } from '@/lib/boot';
import { liveness, readiness } from '@/lib/health';

export const dynamic = 'force-dynamic';

/**
 * Health endpoint (§43).
 *
 *   GET /api/health          → full readiness report (database, migrations,
 *                              scheduler, queue, disk, providers)
 *   GET /api/health?live=1   → cheap liveness only, no database access
 *
 * Responds 503 when any component is unhealthy so an orchestrator can pull the
 * instance out of rotation. Never exposes credentials or internal paths.
 */
export async function GET(request: Request) {
  const live = new URL(request.url).searchParams.get('live') === '1';

  if (live) {
    return NextResponse.json(liveness(), { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  try {
    const orgId = boot();
    const report = await readiness(orgId);
    return NextResponse.json(report, {
      status: report.status === 'unhealthy' ? 503 : 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    // A health check that throws must still answer — an unreachable health
    // endpoint is indistinguishable from a dead process to a load balancer.
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        components: [
          {
            component: 'application',
            status: 'unhealthy',
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
      },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }
}
