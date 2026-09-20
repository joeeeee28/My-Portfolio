import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listClients, listUpsells, listProjects, revenueSummary } from '@/engine/crm';
import { listAccounts, socialAnalytics } from '@/engine/social';
import { relativeFromNow } from '@/lib/time';
import { round } from '@/lib/id';
import { Card, Badge, EmptyState, SectionHead, Stats, Bar, KeyValue } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { UserCheck, Sparkles } from 'lucide-react';

export const metadata = { title: 'Clients' };
export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  const orgId = boot();
  await getSession();
  const clients = listClients(orgId, { limit: 100 });
  const revenue = revenueSummary(orgId);
  const upsells = listUpsells(orgId, { limit: 60 });
  const projects = listProjects(orgId);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>Clients</h1>
          <p className="small muted">
            Client Conversion reuses the existing prospect record — <code>clients.business_id</code> is unique, so a duplicate client is structurally
            impossible.
          </p>
        </div>
        <div className="spacer" />
        <ActionButton action={A.scanUpsellsAction} args={[]} label="Scan for growth opportunities" variant="primary" />
      </div>

      <Stats
        items={[
          { label: 'Active clients', value: revenue.activeClients },
          { label: 'MRR', value: `$${round(revenue.mrr, 0)}`, tone: revenue.mrr > 0 ? 'success' : undefined },
          { label: 'ARR', value: `$${round(revenue.arr, 0)}` },
          { label: 'Average deal value', value: `$${round(revenue.averageDealValue, 0).toLocaleString()}` },
          { label: 'Growth opportunities', value: upsells.filter((u) => u.status === 'identified').length, tone: upsells.length > 0 ? 'warning' : undefined },
        ]}
      />

      {clients.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<UserCheck size={17} />}
            title="No clients yet"
            body="Convert a prospect from any Business Workspace. The client record, delivery project, tasks and timeline are created together from the same record — nothing is duplicated."
            action={
              <Link href="/pipeline" className="btn btn-primary">
                Go to Client Pipeline
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Clients" />
          <div className="grid grid-2">
            {clients.map((c) => {
              const clientProjects = projects.filter((p) => p.client_id === c.id);
              const clientUpsells = upsells.filter((u) => u.client_id === c.id);
              const social = socialAnalytics(orgId, c.id);
              return (
                <Card
                  key={c.id}
                  title={
                    <span className="row" style={{ gap: 6 }}>
                      <Link href={`/prospects/${c.business_id}`} style={{ color: 'var(--accent)' }}>
                        {c.business_name}
                      </Link>
                    </span>
                  }
                  sub={`${c.category ?? 'Category not established'} · client since ${relativeFromNow(c.created_at)}`}
                  actions={
                    <Badge tone={c.status === 'active' ? 'success' : c.status === 'churned' ? 'critical' : 'accent'} dot>
                      {c.status}
                    </Badge>
                  }
                >
                  <div className="grid grid-3 mb-2">
                    <div>
                      <div className="xsmall muted">MRR</div>
                      <div className="small strong">${round(c.mrr, 0)}</div>
                    </div>
                    <div>
                      <div className="xsmall muted">Lifetime value</div>
                      <div className="small strong">${round(c.lifetime_value, 0).toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="xsmall muted">Health</div>
                      <Badge tone={c.health === 'good' ? 'success' : c.health === 'at_risk' ? 'warning' : 'critical'}>{c.health.replace(/_/g, ' ')}</Badge>
                    </div>
                  </div>

                  <div className="row-wrap mb-2">
                    <Badge tone="outline">{clientProjects.length} project(s)</Badge>
                    <Badge tone="outline">{c.open_tasks} open task(s)</Badge>
                    <Badge tone="outline">{social.accounts} social channel(s)</Badge>
                    {social.total > 0 && <Badge tone="outline">{social.total} post(s)</Badge>}
                  </div>

                  {clientProjects.length > 0 && (
                    <div className="mb-2">
                      {clientProjects.map((p) => (
                        <div key={p.id} className="row" style={{ gap: 8, marginBottom: 4 }}>
                          <Link href={`/projects/${p.id}`} className="small" style={{ color: 'var(--accent)', minWidth: 0 }}>
                            <span className="truncate" style={{ display: 'block' }}>
                              {p.name}
                            </span>
                          </Link>
                          <div style={{ width: 90 }}>
                            <Bar value={p.progress} tone={p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : undefined} />
                          </div>
                          <span className="xsmall muted nowrap">{p.stage.replace(/_/g, ' ')}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="row-wrap">
                    <Link href={`/portal/${c.portal_token}`} target="_blank" className="btn btn-sm">
                      Client portal
                    </Link>
                    <ActionButton action={A.generateContentPlanAction} args={[c.id]} label="Generate social content" />
                    <ActionButton action={A.convertToClientAction} args={[c.business_id]} label="Re-sync" />
                  </div>

                  {clientUpsells.length > 0 && (
                    <div className="mt-2">
                      <div className="xsmall muted mb-1">Growth opportunities</div>
                      <ul className="col" style={{ gap: 5 }}>
                        {clientUpsells.map((u) => (
                          <li key={u.id} className="ai-panel" style={{ padding: 8 }}>
                            <div className="row" style={{ gap: 6 }}>
                              <Sparkles size={11} style={{ color: 'var(--ai)' }} />
                              <span className="small strong">{u.service}</span>
                              <Badge tone="ai">score {Math.round(u.score)}</Badge>
                              <span className="xsmall muted">${u.estMrr}/mo</span>
                            </div>
                            <div className="xsmall muted">{u.rationale}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      {upsells.length > 0 && (
        <>
          <SectionHead title="Growth Opportunities" hint="Identified from delivered work and client state — never generic" />
          <Card tight>
            <div className="queue">
              {upsells.map((u) => (
                <div className="queue-item" key={u.id}>
                  <div className="queue-main">
                    <div className="row" style={{ gap: 6 }}>
                      <span className="queue-title">{u.business_name}</span>
                      <Badge tone="ai">
                        <Sparkles size={10} /> AI Growth Opportunity
                      </Badge>
                    </div>
                    <div className="queue-reason">
                      <strong>{u.service}</strong> — {u.rationale}
                    </div>
                  </div>
                  <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Badge tone="accent">{Math.round(u.score)}</Badge>
                    <span className="xsmall muted">${u.estMrr}/mo</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
