import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listBusinesses } from '@/repo/business';
import { pipelineSnapshot } from '@/engine/analytics';
import { PIPELINE } from '@/lib/brand';
import { STAGE_TO_PIPELINE } from '@/lib/brand';
import { Card, Badge, EmptyState, Score, Stats, SectionHead, Table } from '@/components/ui';
import { GitBranch } from 'lucide-react';

export const metadata = { title: 'Client Pipeline' };
export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const orgId = boot();
  await getSession();
  const snapshot = pipelineSnapshot(orgId);

  const openColumns = snapshot.columns.filter((c) => !['won', 'onboarding', 'delivery', 'active_client'].includes(c.key));
  const { rows } = listBusinesses(orgId, {
    stages: openColumns.flatMap((c) => c.stages),
    sortBy: 'score',
    limit: 400,
  });

  const byColumn = new Map<string, typeof rows>();
  for (const r of rows) {
    const col = STAGE_TO_PIPELINE[r.stage] ?? 'discovered';
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)!.push(r);
  }

  const totalValue = rows.reduce((a, r) => a + (r.revenue_potential ?? 0), 0);

  return (
    <>
      <div className="mb-2">
        <h1>Client Pipeline</h1>
        <p className="small muted">Discovery through to growth. Every stage below maps to a ClientForge pillar.</p>
      </div>

      <Stats
        items={[
          { label: 'Open pipeline value', value: `$${Math.round(totalValue).toLocaleString()}` },
          { label: 'Open prospects', value: rows.length },
          { label: 'Lost', value: snapshot.lost },
          ...snapshot.columns
            .filter((c) => ['call', 'proposal', 'won'].includes(c.key))
            .map((c) => ({ label: c.label, value: c.count, detail: `$${Math.round(c.value).toLocaleString()}` })),
        ]}
      />

      {rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<GitBranch size={17} />}
            title="Pipeline is empty"
            body="Prospects appear here as discovery scores and qualifies them."
            action={
              <Link href="/discover" className="btn btn-primary">
                Run discovery
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Board" hint="Ordered by ClientForge pipeline stage" />
          <div className="board">
            {PIPELINE.map((col) => {
              const items = byColumn.get(col.key) ?? [];
              return (
                <div className="board-col" key={col.key}>
                  <div className="board-col-head">
                    <span className="board-col-title">{col.label}</span>
                    <span className="board-col-count">{items.length}</span>
                  </div>
                  <div className="board-col-body">
                    {items.length === 0 && <div className="xsmall muted" style={{ padding: '6px 2px' }}>Empty</div>}
                    {items.map((b) => (
                      <Link href={`/prospects/${b.id}`} className="board-card" key={b.id}>
                        <div className="row" style={{ gap: 5 }}>
                          <Score value={b.opportunity_score} />
                          <span className="board-card-name truncate">{b.name}</span>
                        </div>
                        <div className="board-card-meta truncate">
                          {[b.category, b.locality].filter(Boolean).join(' · ') || '—'}
                        </div>
                        {b.next_best_action_reason && <div className="board-card-meta truncate">{b.next_best_action_reason}</div>}
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <SectionHead title="Stage detail" />
          <Card tight>
            <Table head={[{ label: 'Stage' }, { label: 'Pillar' }, { label: 'Prospects', align: 'right' }, { label: 'Value', align: 'right' }]}>
              {snapshot.columns.map((c) => (
                <tr key={c.key}>
                  <td className="small strong">{c.label}</td>
                  <td>
                    <Badge tone="outline">{c.pillar}</Badge>
                  </td>
                  <td className="num small">{c.count}</td>
                  <td className="num small">${Math.round(c.value).toLocaleString()}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
