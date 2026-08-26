import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { actionCenter } from '@/engine/briefing';
import { smartQueues } from '@/engine/queues';
import { PILLARS, BRAND, serviceLabel } from '@/lib/brand';
import { relativeFromNow } from '@/lib/time';
import { Card, Stats, Score, Badge, EmptyState, Funnel, Pillars, SectionHead, AiTag, Banner, DemoFlag } from '@/components/ui';
import { RunDiscoveryButton, QueueActionButton, RefreshBriefingButton } from '@/components/actions-client';
import { Flame, Radar, AlertTriangle, Sparkles } from 'lucide-react';

export const metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const orgId = boot();
  await getSession();
  const center = actionCenter(orgId);
  const queues = smartQueues(orgId);
  const { briefing, queue, funnel, automation, opportunities, projects, recommendations } = center;

  const queueCount = (key: string) => queues.find((q) => q.key === key)?.count ?? 0;
  const isEmpty = funnel.discovered === 0;

  return (
    <>
      {/* ── Briefing ─────────────────────────────────────── */}
      <section className="briefing">
        <h1>{briefing.headline}</h1>
        <p className="briefing-sub">{briefing.subheadline}</p>

        {briefing.topAction && (
          <div className="briefing-top">
            <Flame size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <div className="briefing-top-label">Your highest-priority action</div>
              <div className="briefing-top-title">{briefing.topAction.title}</div>
              <div className="briefing-top-detail">{briefing.topAction.detail}</div>
              <div className="mt-1">
                <Link href={briefing.topAction.href} className="btn btn-sm btn-primary">
                  Open
                </Link>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Pillar strip ─────────────────────────────────── */}
      <div className="mt-3">
        <Pillars
          items={[
            { label: 'Discover', value: funnel.discovered, active: funnel.discovered > 0 },
            { label: 'Intelligence', value: queueCount('no_website') + queueCount('website_needs_work'), active: queueCount('no_website') > 0 },
            { label: 'Engage', value: funnel.contacted, active: funnel.contacted > 0 },
            { label: 'Create', value: funnel.mockups, active: funnel.mockups > 0 },
            { label: 'Convert', value: funnel.won, active: funnel.won > 0 },
            { label: 'Deliver', value: projects.length, active: projects.length > 0 },
            { label: 'Grow', value: queueCount('growth_opportunities'), active: queueCount('growth_opportunities') > 0 },
          ]}
        />
      </div>

      {isEmpty ? (
        <div className="mt-3">
          <EmptyState
            icon={<Radar size={17} />}
            title="No prospects in the hub yet"
            body={`ClientForge discovers businesses from the sources you enable in Settings → Sources. OpenStreetMap works with no credentials at all. Run discovery now to populate every screen.`}
            action={<RunDiscoveryButton />}
          />
        </div>
      ) : (
        <div className="grid grid-main mt-3">
          <div className="col">
            {/* ── Priority actions ─────────────────────────── */}
            <div>
              <SectionHead
                title="Priority Actions"
                hint={`${queue.length} item${queue.length === 1 ? '' : 's'} waiting on you`}
                right={
                  <Link href="/action-queue" className="btn btn-sm">
                    Full queue
                  </Link>
                }
              />
              {queue.length === 0 ? (
                <EmptyState title="Action Queue is clear" body="Nothing needs a decision right now. New items appear as discovery and engagement run." />
              ) : (
                <div className="queue">
                  {queue.slice(0, 8).map((item) => (
                    <div className="queue-item" key={item.id}>
                      <span className={`queue-stripe ${item.tone}`} />
                      <div className="queue-main">
                        <div className="queue-kind">{item.kind}</div>
                        <Link href={item.actionHref} className="queue-title">
                          {item.title}
                        </Link>
                        <div className="queue-reason">{item.reason}</div>
                      </div>
                      <div className="row" style={{ flexShrink: 0 }}>
                        {item.score !== null && <Score value={item.score} />}
                        <QueueActionButton item={item} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Acquisition funnel ───────────────────────── */}
            <div>
              <SectionHead title="Acquisition Funnel" hint="Discovery → Won" />
              <Card tight>
                <div style={{ padding: 14 }}>
                  <Funnel steps={funnel.funnel} />
                </div>
                <div className="card-foot">
                  End-to-end conversion {funnel.funnel[funnel.funnel.length - 1].conversionFromTop}% ·{' '}
                  <Link href="/analytics" style={{ color: 'var(--accent)' }}>
                    full analytics
                  </Link>
                </div>
              </Card>
            </div>

            {/* ── New opportunities ────────────────────────── */}
            <div>
              <SectionHead
                title="New Opportunities"
                hint="Highest-scoring prospects in the hub"
                right={
                  <Link href="/prospects" className="btn btn-sm">
                    Prospect Hub
                  </Link>
                }
              />
              {opportunities.length === 0 ? (
                <EmptyState title="No opportunities yet" body="Run discovery to find businesses with a measurable digital gap." action={<RunDiscoveryButton />} />
              ) : (
                <Card tight>
                  <div className="queue">
                    {opportunities.map((b) => (
                      <div className="queue-item" key={b.id}>
                        <div className="queue-main">
                          <div className="row" style={{ gap: 6 }}>
                            <Link href={`/prospects/${b.id}`} className="queue-title">
                              {b.name}
                            </Link>
                            {b.is_demo === 1 && <DemoFlag />}
                          </div>
                          <div className="queue-reason">
                            {[b.category, b.locality].filter(Boolean).join(' · ') || 'Category not established'}
                            {b.rating ? ` · ${b.rating}★${b.review_count ? ` (${b.review_count})` : ''}` : ''}
                          </div>
                          {b.next_best_action_reason && <div className="queue-reason muted">{b.next_best_action_reason}</div>}
                        </div>
                        <div className="col" style={{ alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                          <Score value={b.opportunity_score} />
                          <Badge tone={b.priority === 'critical' ? 'critical' : b.priority === 'high' ? 'accent' : ''}>{b.priority}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            {/* ── Active projects ──────────────────────────── */}
            {projects.length > 0 && (
              <div>
                <SectionHead
                  title="Active Projects"
                  right={
                    <Link href="/projects" className="btn btn-sm">
                      All projects
                    </Link>
                  }
                />
                <Card tight>
                  <div className="queue">
                    {projects.map((p) => (
                      <div className="queue-item" key={p.id}>
                        <div className="queue-main">
                          <Link href={`/projects/${p.id}`} className="queue-title">
                            {p.name}
                          </Link>
                          <div className="queue-reason">
                            {p.stage.replace(/_/g, ' ')}
                            {p.due_at ? ` · due ${relativeFromNow(p.due_at)}` : ''}
                          </div>
                          <div className="mt-1">
                            <div className="bar" style={{ maxWidth: 220 }}>
                              <div
                                className={`bar-fill ${p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : ''}`}
                                style={{ width: `${p.progress}%` }}
                              />
                            </div>
                          </div>
                        </div>
                        <Badge tone={p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : 'success'}>{p.health.replace(/_/g, ' ')}</Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            )}
          </div>

          {/* ── Right rail ─────────────────────────────────── */}
          <aside className="col">
            <Card
              title={<span className="row"><Sparkles size={14} style={{ color: 'var(--ai)' }} /> {BRAND.assistant} Recommendations</span>}
              sub="Reasoning behind each recommended action"
            >
              {recommendations.length === 0 ? (
                <p className="small muted">No recommendations yet. They appear once prospects are scored.</p>
              ) : (
                <ul className="col" style={{ gap: 12 }}>
                  {recommendations.map((r, i) => (
                    <li key={i} className="ai-panel" style={{ padding: '9px 11px' }}>
                      <div className="row" style={{ gap: 6 }}>
                        <Link href={r.href} className="strong small" style={{ color: 'var(--accent)' }}>
                          {r.action}
                        </Link>
                        {r.closeProbability !== null && <Badge>{Math.round(r.closeProbability)}% close</Badge>}
                      </div>
                      <div className="small strong mt-1">{r.businessName}</div>
                      <div className="xsmall muted">{r.reason}</div>
                      {r.service && <div className="xsmall muted mt-1">Recommended: {r.service}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title={`${BRAND.automation}`}
              sub={automation.enabled ? `Next run ${automation.nextRunAt ? relativeFromNow(automation.nextRunAt) : 'unscheduled'}` : 'Paused'}
              actions={<Badge tone={automation.enabled ? 'success' : 'warning'} dot>{automation.enabled ? 'Active' : 'Paused'}</Badge>}
            >
              <Stats
                items={[
                  { label: 'Success', value: `${automation.successRate}%`, detail: `${automation.runs} runs` },
                  { label: 'Errors', value: automation.errors.reduce((a, e) => a + e.unresolved, 0), detail: 'unresolved', tone: automation.errors.some((e) => e.unresolved > 0) ? 'critical' : undefined },
                ]}
              />
              {automation.errors.filter((e) => e.unresolved > 0).length > 0 && (
                <div className="mt-2">
                  <Banner tone="critical" icon={<AlertTriangle size={15} />}>
                    {automation.errors
                      .filter((e) => e.unresolved > 0)
                      .slice(0, 3)
                      .map((e) => `${e.category}: ${e.unresolved}`)
                      .join(' · ')}
                  </Banner>
                </div>
              )}
              <div className="mt-2 row">
                <Link href="/automation" className="btn btn-sm btn-block">
                  Automation Center
                </Link>
              </div>
            </Card>

            <Card title="AI Insights" sub="What the numbers actually mean">
              <ul className="col" style={{ gap: 9 }}>
                {briefing.aiInsights.map((insight, i) => (
                  <li key={i} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                    <AiTag label="" />
                    <span className="small">{insight}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2">
                <RefreshBriefingButton />
              </div>
            </Card>

            <Card title="Smart Queues">
              <ul className="col" style={{ gap: 5 }}>
                {queues
                  .filter((q) => q.count > 0)
                  .slice(0, 9)
                  .map((q) => (
                    <li key={q.key}>
                      <Link
                        href={`/prospects?queue=${q.key}`}
                        className="row"
                        style={{ justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0' }}
                      >
                        <span className="muted-2 truncate">{q.label}</span>
                        <strong>{q.count}</strong>
                      </Link>
                    </li>
                  ))}
                {queues.every((q) => q.count === 0) && <li className="small muted">All queues empty.</li>}
              </ul>
            </Card>
          </aside>
        </div>
      )}

      {/* ── Daily briefing detail ──────────────────────────── */}
      <div className="mt-3">
        <SectionHead title="Daily Briefing" hint={briefing.generatedAt.slice(0, 16).replace('T', ' ')} />
        <Stats
          items={briefing.sections.map((s) => ({
            label: s.label,
            value: s.value,
            detail: s.detail,
            tone: s.tone === 'critical' ? 'critical' : s.tone === 'high' ? 'warning' : s.tone === 'good' ? 'success' : undefined,
            href: s.href,
          }))}
        />
      </div>

      {briefing.priorityList.length > 0 && (
        <div className="mt-3">
          <SectionHead title="Recommended Priority" hint="In the order Forge AI would work them" />
          <Card tight>
            <div className="queue">
              {briefing.priorityList.map((p) => (
                <div className="queue-item" key={p.rank}>
                  <div
                    style={{
                      width: 20, height: 20, borderRadius: '50%', background: 'var(--surface-2)',
                      display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0,
                    }}
                  >
                    {p.rank}
                  </div>
                  <div className="queue-main">
                    <Link href={p.href} className="queue-title">
                      {p.label}
                    </Link>
                    <div className="queue-reason">{p.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
