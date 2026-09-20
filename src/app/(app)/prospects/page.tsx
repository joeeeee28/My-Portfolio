import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listBusinesses, distinctValues, stageCounts } from '@/repo/business';
import { smartQueues, queueFilter } from '@/engine/queues';
import { listSequences } from '@/engine/outreach';
import { serviceLabel, STAGE_TO_PIPELINE, PIPELINE_LABELS } from '@/lib/brand';
import { scoreBand } from '@/lib/brand';
import { Card, Score, Badge, EmptyState, DemoFlag, Stats } from '@/components/ui';
import { BulkBar, CsvImporter, RunDiscoveryButton } from '@/components/actions-client';
import { ProspectsTable } from '@/components/ProspectsTable';
import { Radar } from 'lucide-react';

export const metadata = { title: 'Prospect Hub' };
export const dynamic = 'force-dynamic';

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const orgId = boot();
  await getSession();
  const sp = await searchParams;
  const queues = smartQueues(orgId);
  const sequences = listSequences(orgId).map((s) => ({ id: s.id, name: s.name }));

  const queueKey = sp.queue;
  const base = queueKey ? queueFilter(queueKey) : {};

  const filters = {
    ...base,
    q: sp.q,
    priority: sp.priority ? sp.priority.split(',') : undefined,
    websiteStatus: sp.website ? sp.website.split(',') : undefined,
    industry: sp.industry,
    minScore: sp.minScore ? Number(sp.minScore) : undefined,
    mockupStatus: sp.concept as never,
    outreachStatus: sp.outreach,
    sortBy: (sp.sort as never) ?? 'score',
    limit: 200,
  };

  const { rows, total } = listBusinesses(orgId, filters);
  const industries = distinctValues(orgId, 'industry');
  const stages = stageCounts(orgId);
  const activeQueue = queues.find((q) => q.key === queueKey);

  return (
    <>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h1>Prospect Hub</h1>
          <p className="small muted">
            {total} prospect{total === 1 ? '' : 's'}
            {activeQueue ? ` · ${activeQueue.label}: ${activeQueue.description}` : ''}
          </p>
        </div>
        <div className="spacer" />
        <RunDiscoveryButton />
      </div>

      {total === 0 ? (
        <EmptyState
          icon={<Radar size={17} />}
          title={queueKey ? `Nothing in the ${activeQueue?.label ?? 'selected'} queue` : 'No prospects yet'}
          body={
            queueKey
              ? 'Nothing currently matches this queue. It fills automatically as discovery, audits and engagement run.'
              : 'ClientForge discovers businesses from the sources enabled in Settings. OpenStreetMap needs no credentials at all — enable it and run discovery.'
          }
          action={
            <div className="row">
              <RunDiscoveryButton />
              <Link href="/settings" className="btn">
                Configure sources
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <ProspectFilters industries={industries} current={sp} />

          <div className="mt-2">
            <Card tight>
              <ProspectsTable
                rows={rows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  category: r.category,
                  industry: r.industry,
                  locality: r.locality,
                  score: r.opportunity_score,
                  priority: r.priority,
                  stage: PIPELINE_LABELS[STAGE_TO_PIPELINE[r.stage] ?? 'discovered'] ?? r.stage,
                  websiteStatus: r.website_status,
                  rating: r.rating,
                  reviewCount: r.review_count,
                  service: serviceLabel(r.recommended_service),
                  contacts: r.contact_count ?? 0,
                  concept: r.mockup_status ?? null,
                  nextAction: r.next_best_action_reason,
                  isDemo: r.is_demo === 1,
                }))}
                sequences={sequences}
              />
            </Card>
          </div>
        </>
      )}

      <div className="mt-3">
        <h2 className="mb-2">Import prospects</h2>
        <Card title="CSV import" sub="Validated and deduplicated against the Prospect Hub before anything is written">
          <CsvImporter />
        </Card>
      </div>
    </>
  );
}

function ProspectFilters({ industries, current }: { industries: string[]; current: Record<string, string | undefined> }) {
  const set = (key: string, value: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) if (v && k !== key) params.set(k, v);
    if (value) params.set(key, value);
    return `/prospects?${params.toString()}`;
  };

  return (
    <Card>
      <div className="row-wrap">
        <form action="/prospects" className="row" style={{ gap: 6 }}>
          {Object.entries(current)
            .filter(([k, v]) => v && k !== 'q')
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <input className="input" name="q" defaultValue={current.q ?? ''} placeholder="Search name, industry, city…" style={{ width: 240 }} />
          <button className="btn btn-sm" type="submit">
            Search
          </button>
        </form>

        <span className="xsmall muted">Priority:</span>
        {['critical', 'high', 'medium', 'low'].map((p) => (
          <Link key={p} href={set('priority', current.priority === p ? '' : p)} className={`chip${current.priority === p ? ' active' : ''}`}>
            {p}
          </Link>
        ))}

        <span className="xsmall muted">Website:</span>
        {['missing', 'unreachable', 'live'].map((w) => (
          <Link key={w} href={set('website', current.website === w ? '' : w)} className={`chip${current.website === w ? ' active' : ''}`}>
            {w === 'missing' ? 'no site' : w === 'unreachable' ? 'broken' : 'has site'}
          </Link>
        ))}

        {industries.length > 0 && (
          <select className="select" style={{ width: 'auto' }} value={current.industry ?? ''} onChange={undefined}>
            <option value="">All industries</option>
            {industries.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        )}

        <Link href="/prospects" className="btn btn-ghost btn-sm">
          Clear filters
        </Link>
      </div>
    </Card>
  );
}
