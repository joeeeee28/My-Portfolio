import { boot } from '@/lib/boot';
import { requireAuth } from '@/lib/auth';
import { usageSummary } from '@/lib/ai/router';
import { efficiencyAnalytics } from '@/engine/analytics';
import { getSettings } from '@/lib/settings';
import { buildResourceCenter, freeTierAlerts } from '@/engine/resources';
import { all, scalar } from '@/db';
import { Card, Badge, SectionHead, Stats, Table, Banner, EmptyState } from '@/components/ui';
import { AlertTriangle, Info } from 'lucide-react';

export const metadata = { title: 'Cost Monitor' };
export const dynamic = 'force-dynamic';

export default async function CostMonitorPage() {
  const orgId = boot();
  await requireAuth();

  const settings = getSettings(orgId);
  const aiUsage = usageSummary(orgId, 30);
  const eff = efficiencyAnalytics(orgId);
  const alerts = freeTierAlerts(orgId);
  const center = buildResourceCenter(orgId);

  const byCategory = all<{ category: string; amount: number; units: number }>(
    `SELECT category, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(units),0) AS units
       FROM cost_ledger WHERE org_id = ? GROUP BY category ORDER BY amount DESC`,
    [orgId]
  );

  const daily = all<{ day: string; amount: number }>(
    `SELECT substr(created_at,1,10) AS day, COALESCE(SUM(amount),0) AS amount
       FROM cost_ledger WHERE org_id = ? AND created_at >= date('now','-30 day')
      GROUP BY day ORDER BY day DESC LIMIT 30`,
    [orgId]
  );

  const totalSpend = byCategory.reduce((a, r) => a + Number(r.amount), 0);
  const budget = settings.ai.monthlyBudgetUsd;
  const budgetPct = budget > 0 ? Math.round((aiUsage.cost / budget) * 1000) / 10 : null;

  return (
    <>
      <div className="mb-2">
        <h1>Cost Monitor</h1>
        <p className="small muted">
          Every cost ClientForge incurs, by category. Where a provider does not expose cost, it says so rather than inventing a number.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Total spend', value: `$${totalSpend.toFixed(4)}` },
          { label: 'AI spend (30d)', value: `$${aiUsage.cost.toFixed(4)}` },
          { label: 'Monthly budget', value: `$${budget}` },
          {
            label: 'Budget used',
            value: budgetPct === null ? 'n/a' : `${budgetPct}%`,
            tone: budgetPct !== null && budgetPct >= 85 ? 'critical' : budgetPct !== null && budgetPct >= 70 ? 'warning' : undefined,
          },
          { label: 'AI requests', value: aiUsage.calls },
          { label: 'AI errors', value: aiUsage.errors, tone: aiUsage.errors > 0 ? 'critical' : undefined },
        ]}
      />

      {budgetPct !== null && budgetPct >= 70 && (
        <div className="mt-2">
          <Banner tone={budgetPct >= 85 ? 'critical' : 'warning'} icon={<AlertTriangle size={15} />}>
            AI spend is at {budgetPct}% of the ${budget} monthly budget. The router automatically downgrades to cheaper models at{' '}
            {settings.ai.costAlertPct}% when auto-downgrade is enabled.
          </Banner>
        </div>
      )}

      <SectionHead title="Cost by category" />
      {byCategory.length === 0 ? (
        <EmptyState
          title="No cost recorded yet"
          body="Cost accrues as discovery, enrichment, AI and outreach run. With no hosted provider configured, AI cost stays at zero."
        />
      ) : (
        <Card tight>
          <Table head={[{ label: 'Category' }, { label: 'Units', align: 'right' }, { label: 'Cost', align: 'right' }, { label: 'Share', align: 'right' }]}>
            {byCategory.map((r) => (
              <tr key={r.category}>
                <td className="small strong">{r.category.replace(/_/g, ' ')}</td>
                <td className="num small">{r.units}</td>
                <td className="num small">${Number(r.amount).toFixed(4)}</td>
                <td className="num small">{totalSpend > 0 ? `${Math.round((Number(r.amount) / totalSpend) * 100)}%` : '—'}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <SectionHead title="Unit economics" hint="Cost per outcome" />
      <Card tight>
        <Table head={[{ label: 'Metric' }, { label: 'Value', align: 'right' }, { label: 'Denominator', align: 'right' }]}>
          {[
            ['Cost per prospect', eff.costPerProspect, eff.counts.prospects],
            ['Cost per qualified prospect', eff.costPerQualifiedProspect, eff.counts.qualified],
            ['Cost per high opportunity', eff.costPerOpportunity, eff.counts.opportunities],
            ['Cost per website concept', eff.costPerMockup, eff.counts.mockups],
            ['Cost per outreach', eff.costPerOutreach, eff.counts.messages],
            ['Cost per customer', eff.costPerCustomer, eff.counts.customers],
            ['Cost per discovery run', eff.costPerDiscoveryRun, eff.counts.discoveries],
          ].map(([label, value, denom]) => (
            <tr key={String(label)}>
              <td className="small">{String(label)}</td>
              <td className="num small">{value === null ? 'insufficient data' : `$${Number(value).toFixed(4)}`}</td>
              <td className="num small">{String(denom)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {daily.length > 0 && (
        <>
          <SectionHead title="Daily spend" hint="Last 30 days" />
          <Card tight>
            <Table head={[{ label: 'Day' }, { label: 'Spend', align: 'right' }]}>
              {daily.map((d) => (
                <tr key={d.day}>
                  <td className="small mono">{d.day}</td>
                  <td className="num small">${Number(d.amount).toFixed(4)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}

      <SectionHead title="AI usage by task" hint="Which tasks cost what" />
      {aiUsage.byTask.length === 0 ? (
        <EmptyState title="No AI usage recorded" body="Requests are logged per task so routing and cost can be reasoned about from evidence." />
      ) : (
        <Card tight>
          <Table head={[{ label: 'Task' }, { label: 'Requests', align: 'right' }, { label: 'Cost', align: 'right' }]}>
            {aiUsage.byTask.map((t) => (
              <tr key={t.task}>
                <td className="small">{String(t.task).replace(/_/g, ' ')}</td>
                <td className="num small">{t.calls}</td>
                <td className="num small">{Number(t.cost) === 0 ? 'free' : `$${Number(t.cost).toFixed(5)}`}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <SectionHead title="Free-tier alerts" hint="Warnings at 70% / 85% / 95%" />
      {alerts.length === 0 ? (
        <EmptyState
          title="Quota unavailable"
          body="No configured provider exposes quota information, so no usage percentages can be shown. ClientForge does not invent quota numbers."
        />
      ) : (
        <Card>
          {alerts.map((al) => (
            <div key={al.capability} className="mb-2">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small strong">{al.capability}</span>
                <span className="small mono">
                  {al.used}/{al.limit} ({al.pct}%)
                </span>
              </div>
              <div className="bar mt-1">
                <div
                  className={`bar-fill ${al.level === 'critical' ? 'critical' : al.level === 'warn' ? 'warning' : ''}`}
                  style={{ width: `${Math.min(100, al.pct)}%` }}
                />
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="mt-2">
        <Banner tone="accent" icon={<Info size={15} />}>
          With no hosted AI provider configured, AI cost is genuinely <strong>$0</strong> — the local grounded engine runs on your own machine. Adding
          Ollama keeps it at $0 while giving you real model inference.
        </Banner>
      </div>
    </>
  );
}
