import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { automationHealth, efficiencyAnalytics, costDashboard } from '@/engine/analytics';
import { listRuns, getRun, sourceHealth } from '@/engine/discovery';
import { listJobs } from '@/engine/scheduler';
import { listAutomationLogs, resolveLog } from '@/lib/logging';
import { relativeFromNow, relativeDateTime, formatDateTime, durationLabel } from '@/lib/time';
import { BRAND } from '@/lib/brand';
import { Card, Stats, Badge, EmptyState, Banner, SectionHead, Bar, Table } from '@/components/ui';
import { ActionButton, RunDiscoveryButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Cpu, AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Forge Automation' };
export const dynamic = 'force-dynamic';

export default async function AutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const orgId = boot();
  await getSession();
  const sp = await searchParams;

  const health = automationHealth(orgId);
  const jobs = listJobs(orgId);
  const runs = listRuns(orgId, 20);
  const sources = sourceHealth(orgId);
  const errors = listAutomationLogs(orgId, { resolution: 'pending', limit: 30 });
  const selectedRun = sp.run ? getRun(orgId, sp.run) : runs[0] ? getRun(orgId, runs[0].id as string) : null;
  const eff = efficiencyAnalytics(orgId);

  const dailyJob = jobs.find((j) => j.key === 'daily_discovery');

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>{BRAND.automation}</h1>
          <p className="small muted">Scheduled discovery, job history and provider health</p>
        </div>
        <div className="spacer" />
        <RunDiscoveryButton />
      </div>

      {/* ── Daily Discovery header (§39) ────────────────────── */}
      <Card>
        <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220 }}>
            <div className="row" style={{ gap: 8 }}>
              <h2>Daily Discovery</h2>
              <Badge tone={health.enabled ? 'success' : 'warning'} dot>
                {health.enabled ? 'Active' : 'Paused'}
              </Badge>
            </div>
            <div className="small muted mt-1">
              Last run: {health.lastRunAt ? relativeFromNow(health.lastRunAt) : 'never'}
              {health.lastStatus ? ` · ${health.lastStatus}` : ''}
            </div>
            <div className="small muted">Next run: {health.nextRunAt ? relativeFromNow(health.nextRunAt) : 'not scheduled'}</div>
            <div className="xsmall muted mt-1">
              Schedule {dailyJob?.schedule ?? 'daily'} · <code>{health.cron}</code> {health.timezone}
            </div>
          </div>
          <div className="spacer" />
          <div style={{ minWidth: 260 }}>
            <Stats
              items={[
                { label: 'Success rate', value: `${health.successRate}%`, detail: `${health.completed} of ${health.runs} runs` },
                { label: 'Avg runtime', value: durationLabel(health.avgRuntimeMs) },
                { label: 'Total cost', value: `$${health.totalCost}` },
                {
                  label: 'Unresolved errors',
                  value: health.errors.reduce((a, e) => a + e.unresolved, 0),
                  tone: health.errors.some((e) => e.unresolved > 0) ? 'critical' : undefined,
                },
              ]}
            />
          </div>
        </div>
      </Card>

      {errors.length > 0 && (
        <div className="mt-2">
          <Banner tone="critical" icon={<AlertTriangle size={15} />}>
            {errors.length} unresolved automation error{errors.length === 1 ? '' : 's'}. Automation never fails silently — each one is listed below with a
            retry / skip / investigate decision.
          </Banner>
        </div>
      )}

      {/* ── Jobs ────────────────────────────────────────────── */}
      <SectionHead title="Scheduled jobs" />
      <Card tight>
        <Table
          head={[
            { label: 'Job' },
            { label: 'Schedule' },
            { label: 'Last run' },
            { label: 'Status' },
            { label: 'Next run' },
            { label: 'Success', align: 'right' },
            { label: '' },
          ]}
        >
          {jobs.map((j) => (
            <tr key={j.key}>
              <td>
                <div className="strong small">{j.label}</div>
                <div className="xsmall muted mono">{j.cron}</div>
              </td>
              <td className="small">{j.schedule}</td>
              <td className="small">{j.last_run_at ? relativeFromNow(j.last_run_at) : 'never'}</td>
              <td>
                <Badge tone={j.last_status === 'completed' ? 'success' : j.last_status === 'failed' ? 'critical' : j.last_status ? 'warning' : ''}>
                  {j.last_status ?? 'not run'}
                </Badge>
              </td>
              <td className="small">{j.next_run_at ? relativeFromNow(j.next_run_at) : '—'}</td>
              <td className="num small">{j.successRate}%</td>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  <ActionButton action={A.runJobNowAction} args={[j.key]} label="Run now" />
                  <ActionButton action={A.updateJobAction} args={[j.key, { enabled: j.enabled !== 1 }]} label={j.enabled === 1 ? 'Pause' : 'Enable'} />
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid grid-main mt-3">
        <div className="col">
          {/* ── Run history (§40) ──────────────────────────── */}
          <div>
            <SectionHead title="Job history" hint="Every run is permanent" />
            {runs.length === 0 ? (
              <EmptyState title="No runs yet" body="Run discovery now, or wait for the scheduled job." action={<RunDiscoveryButton />} />
            ) : (
              <Card tight>
                <div className="queue">
                  {runs.map((r) => (
                    <Link key={r.id as string} href={`/automation?run=${r.id}`} className="queue-item">
                      <div className="queue-main">
                        <div className="queue-title">
                          {String(r.kind).charAt(0).toUpperCase() + String(r.kind).slice(1)} — {formatDateTime(r.started_at as string)}
                        </div>
                        <div className="queue-reason">{String(r.summary ?? '')}</div>
                      </div>
                      <Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'critical' : 'warning'}>{String(r.status)}</Badge>
                    </Link>
                  ))}
                </div>
              </Card>
            )}
          </div>

          {/* ── Selected run detail ────────────────────────── */}
          {selectedRun && (
            <div>
              <SectionHead title={`Run detail — ${formatDateTime(selectedRun.started_at as string)}`} hint={durationLabel((selectedRun.duration_ms as number) ?? 0)} />
              <Card>
                <Stats
                  items={[
                    { label: 'Input', value: selectedRun.input_count as number },
                    { label: 'Discovered', value: (selectedRun.stats as { discovered?: number })?.discovered ?? 0 },
                    { label: 'Deduplicated', value: (selectedRun.stats as { deduplicated?: number })?.deduplicated ?? 0 },
                    { label: 'Audits', value: (selectedRun.stats as { auditsCompleted?: number })?.auditsCompleted ?? 0 },
                    { label: 'Qualified', value: (selectedRun.stats as { qualified?: number })?.qualified ?? 0 },
                    { label: 'High priority', value: ((selectedRun.stats as { highPriority?: number })?.highPriority ?? 0) + ((selectedRun.stats as { criticalPriority?: number })?.criticalPriority ?? 0) },
                    { label: 'Outreach drafts', value: (selectedRun.stats as { outreachDrafts?: number })?.outreachDrafts ?? 0 },
                    { label: 'Concepts', value: (selectedRun.stats as { mockupsGenerated?: number })?.mockupsGenerated ?? 0 },
                    { label: 'Follow-ups', value: (selectedRun.stats as { followUps?: number })?.followUps ?? 0 },
                    { label: 'Errors', value: (selectedRun.stats as { errors?: number })?.errors ?? 0, tone: ((selectedRun.stats as { errors?: number })?.errors ?? 0) > 0 ? 'critical' : undefined },
                  ]}
                />

                <div className="mt-3">
                  <div className="xsmall muted mb-1">Step-by-step execution</div>
                  <Table
                    compact
                    head={[{ label: 'Step' }, { label: 'OK', align: 'right' }, { label: 'Skipped', align: 'right' }, { label: 'Errors', align: 'right' }, { label: 'Time', align: 'right' }]}
                  >
                    {Object.entries((selectedRun.stats as { perStep?: Record<string, { ok: number; skipped: number; error: number; ms: number }> })?.perStep ?? {}).map(
                      ([step, s]) => (
                        <tr key={step}>
                          <td className="small">{step}</td>
                          <td className="num small">{s.ok}</td>
                          <td className="num small muted">{s.skipped}</td>
                          <td className="num small" style={s.error ? { color: 'var(--critical)' } : undefined}>
                            {s.error}
                          </td>
                          <td className="num small muted">{durationLabel(s.ms)}</td>
                        </tr>
                      )
                    )}
                  </Table>
                </div>

                {Object.keys((selectedRun.stats as { perSource?: Record<string, { records: number; ok: boolean; note?: string }> })?.perSource ?? {}).length > 0 && (
                  <div className="mt-3">
                    <div className="xsmall muted mb-1">Per source</div>
                    <Table compact head={[{ label: 'Source' }, { label: 'Records', align: 'right' }, { label: 'Result' }]}>
                      {Object.entries((selectedRun.stats as { perSource: Record<string, { records: number; ok: boolean; note?: string }> }).perSource).map(([k, v]) => (
                        <tr key={k}>
                          <td className="small">{k}</td>
                          <td className="num small">{v.records}</td>
                          <td className="small muted">{v.ok ? 'ok' : v.note}</td>
                        </tr>
                      ))}
                    </Table>
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ── Errors (§41) ───────────────────────────────── */}
          <div>
            <SectionHead title="Errors" hint="Retry · Skip · Investigate" />
            {errors.length === 0 ? (
              <EmptyState title="No unresolved errors" body="Every automation failure is captured here with its category and payload." />
            ) : (
              <Card tight>
                <Table
                  compact
                  head={[{ label: 'Category' }, { label: 'Message' }, { label: 'When' }, { label: '' }]}
                >
                  {errors.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Badge tone={e.level === 'error' ? 'critical' : 'warning'}>{e.category}</Badge>
                      </td>
                      <td className="small">{e.message}</td>
                      <td className="xsmall muted nowrap">{relativeFromNow(e.created_at)}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <ActionButton action={resolveLogAction} args={[e.id, 'retried']} label="Retry" />
                          <ActionButton action={resolveLogAction} args={[e.id, 'skipped']} label="Skip" />
                          <ActionButton action={resolveLogAction} args={[e.id, 'investigated']} label="Investigate" />
                        </div>
                      </td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
        </div>

        <aside className="col">
          <Card title="Provider health" sub="Discovery sources">
            <ul className="col" style={{ gap: 7 }}>
              {sources.map((s) => (
                <li key={s.provider_key}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="small truncate">{s.label}</span>
                    <Badge
                      tone={!s.enabled ? '' : !s.credentials_ready ? 'warning' : s.last_status === 'error' ? 'critical' : 'success'}
                    >
                      {!s.enabled ? 'disabled' : !s.credentials_ready ? 'needs key' : s.last_status ?? 'not run'}
                    </Badge>
                  </div>
                  <div className="xsmall muted">
                    {s.records_total} record{s.records_total === 1 ? '' : 's'}
                    {s.last_run_at ? ` · ${relativeFromNow(s.last_run_at)}` : ''}
                  </div>
                  {s.last_error && <div className="xsmall" style={{ color: 'var(--critical)' }}>{String(s.last_error).slice(0, 80)}</div>}
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <Link href="/settings" className="btn btn-sm btn-block">
                Configure sources
              </Link>
            </div>
          </Card>

          <Card title="Unit economics" sub="Cost per outcome">
            <ul className="col" style={{ gap: 6 }}>
              {[
                ['Per prospect', eff.costPerProspect],
                ['Per qualified prospect', eff.costPerQualifiedProspect],
                ['Per high opportunity', eff.costPerOpportunity],
                ['Per concept', eff.costPerMockup],
                ['Per outreach', eff.costPerOutreach],
                ['Per customer', eff.costPerCustomer],
              ].map(([label, value]) => (
                <li key={String(label)} className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span className="muted-2">{label}</span>
                  <span className="mono">{value === null ? 'n/a' : `$${value}`}</span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}

async function resolveLogAction(logId: string, resolution: 'retried' | 'skipped' | 'investigated') {
  'use server';
  const { revalidatePath } = await import('next/cache');
  const { boot } = await import('@/lib/boot');
  const orgId = boot();
  resolveLog(orgId, resolution, 'user');
  revalidatePath('/automation');
  return { ok: true, message: `Marked ${resolution}.` };
}
