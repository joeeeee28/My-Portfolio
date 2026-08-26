import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { acquisitionFunnel, revenueAnalytics, efficiencyAnalytics, automationHealth, costDashboard, engagementSummary } from '@/engine/analytics';
import { usageSummary, modelComparison, listBenchmarks } from '@/lib/ai/router';
import { listExperiments, analyseVariants, listOptimizations } from '@/engine/experiments';
import { round } from '@/lib/id';
import { Card, Badge, EmptyState, SectionHead, Stats, Funnel, Bar, Table } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';

export const metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const orgId = boot();
  await getSession();

  const funnel = acquisitionFunnel(orgId);
  const revenue = revenueAnalytics(orgId);
  const eff = efficiencyAnalytics(orgId);
  const automation = automationHealth(orgId);
  const cost = costDashboard(orgId);
  const engagement = engagementSummary(orgId);
  const ai = usageSummary(orgId, 30);
  const models = modelComparison(orgId);
  const benchmarks = listBenchmarks(orgId, 40);
  const experiments = listExperiments(orgId);
  const optimizations = listOptimizations(orgId, { status: 'suggested' });

  return (
    <>
      <div className="mb-2">
        <h1>Analytics</h1>
        <p className="small muted">Acquisition, revenue, unit economics and model performance — every figure computed from stored records.</p>
      </div>

      <SectionHead title="Acquisition" />
      <Stats
        items={[
          { label: 'Discovered', value: funnel.discovered },
          { label: 'Qualified', value: funnel.qualified, detail: funnel.funnel[1].conversionFromPrev !== null ? `${funnel.funnel[1].conversionFromPrev}% of discovered` : undefined },
          { label: 'Contacted', value: funnel.contacted },
          { label: 'Replies', value: funnel.responded },
          { label: 'Positive replies', value: funnel.positive },
          { label: 'Concepts', value: funnel.mockups },
          { label: 'Calls', value: funnel.calls },
          { label: 'Proposals', value: funnel.proposals },
          { label: 'Won', value: funnel.won, tone: funnel.won > 0 ? 'success' : undefined },
        ]}
      />

      <div className="grid grid-2 mt-3">
        <Card title="Conversion funnel" sub="Discovery → Won">
          <Funnel steps={funnel.funnel} />
          <div className="card-foot">
            End-to-end: {funnel.funnel[funnel.funnel.length - 1].conversionFromTop}%
          </div>
        </Card>

        <Card title="Engagement (last 7 days)" sub="Observed behaviour only">
          <Stats
            items={[
              { label: 'Opens', value: engagement.opens },
              { label: 'Clicks', value: engagement.clicks },
              { label: 'Replies', value: engagement.replies },
              { label: 'Concept views', value: engagement.conceptViews },
              { label: 'Proposal views', value: engagement.proposalViews },
            ]}
          />
        </Card>
      </div>

      <SectionHead title="Revenue" />
      <Stats
        items={[
          { label: 'Pipeline value', value: `$${round(revenue.pipelineValue, 0).toLocaleString()}` },
          { label: 'Won revenue', value: `$${round(revenue.wonRevenue, 0).toLocaleString()}` },
          { label: 'Paid', value: `$${round(revenue.paidRevenue, 0).toLocaleString()}` },
          { label: 'MRR', value: `$${round(revenue.mrr, 0)}`, tone: revenue.mrr > 0 ? 'success' : undefined },
          { label: 'ARR', value: `$${round(revenue.arr, 0).toLocaleString()}` },
          { label: 'Avg deal value', value: `$${round(revenue.averageDealValue, 0).toLocaleString()}` },
          { label: 'Avg days to close', value: revenue.averageDaysToClose ?? 'n/a' },
        ]}
      />

      {revenue.revenueByService.length > 0 && (
        <div className="mt-2">
          <Card title="Revenue by service" tight>
            <Table head={[{ label: 'Service' }, { label: 'Deals', align: 'right' }, { label: 'Total', align: 'right' }]}>
              {revenue.revenueByService.map((r) => (
                <tr key={r.service}>
                  <td className="small">{r.service}</td>
                  <td className="num small">{r.count}</td>
                  <td className="num small">${round(r.total, 0).toLocaleString()}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}

      <SectionHead title="Unit economics" hint="Cost per outcome" />
      <Card>
        <div className="grid grid-2">
          <div>
            <Stats
              items={[
                { label: 'Total cost', value: `$${cost.totalCost}` },
                { label: 'AI cost (30d)', value: `$${cost.aiCost}` },
                { label: 'Monthly budget', value: `$${cost.monthlyBudget}` },
                { label: 'Budget used', value: `${cost.budgetUsedPct}%`, tone: cost.budgetUsedPct > 80 ? 'critical' : undefined },
              ]}
            />
          </div>
          <div>
            <ul className="col" style={{ gap: 6 }}>
              {[
                ['Cost per prospect', eff.costPerProspect],
                ['Cost per qualified prospect', eff.costPerQualifiedProspect],
                ['Cost per high opportunity', eff.costPerOpportunity],
                ['Cost per concept', eff.costPerMockup],
                ['Cost per outreach', eff.costPerOutreach],
                ['Cost per customer', eff.costPerCustomer],
                ['Cost per discovery run', eff.costPerDiscoveryRun],
              ].map(([label, value]) => (
                <li key={String(label)} className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                  <span className="muted-2">{label}</span>
                  <span className="mono">{value === null ? 'n/a — no denominator yet' : `$${value}`}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {cost.byCategory.length > 0 && (
          <div className="mt-3">
            <div className="xsmall muted mb-1">Cost by category</div>
            <Table compact head={[{ label: 'Category' }, { label: 'Units', align: 'right' }, { label: 'Cost', align: 'right' }]}>
              {cost.byCategory.map((c) => (
                <tr key={c.category}>
                  <td className="small">{c.category}</td>
                  <td className="num small">{c.units}</td>
                  <td className="num small">${round(c.amount, 4)}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      <SectionHead title="Forge Automation health" />
      <Card>
        <Stats
          items={[
            { label: 'Runs', value: automation.runs },
            { label: 'Success rate', value: `${automation.successRate}%`, tone: automation.successRate >= 80 ? 'success' : 'warning' },
            { label: 'Failure rate', value: `${automation.failureRate}%`, tone: automation.failureRate > 10 ? 'critical' : undefined },
            { label: 'Avg runtime', value: `${round(automation.avgRuntimeMs / 1000, 1)}s` },
            { label: 'Unresolved errors', value: automation.errors.reduce((a, e) => a + e.unresolved, 0), tone: automation.errors.some((e) => e.unresolved > 0) ? 'critical' : undefined },
          ]}
        />
        {automation.providerHealth.length > 0 && (
          <div className="mt-2">
            <Table compact head={[{ label: 'Provider' }, { label: 'State' }, { label: 'Records', align: 'right' }]}>
              {automation.providerHealth.map((p) => (
                <tr key={p.key}>
                  <td className="small">{p.label}</td>
                  <td>
                    <Badge tone={p.status === 'ok' ? 'success' : p.status === 'error' ? 'critical' : ''}>{p.status}</Badge>
                  </td>
                  <td className="num small">{p.records}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      <SectionHead title="AI model usage" hint="Last 30 days" />
      <Card>
        <Stats
          items={[
            { label: 'Calls', value: ai.calls },
            { label: 'Cost', value: `$${round(ai.cost, 4)}` },
            { label: 'Tokens in', value: ai.tokensIn.toLocaleString() },
            { label: 'Tokens out', value: ai.tokensOut.toLocaleString() },
            { label: 'Errors', value: ai.errors, tone: ai.errors > 0 ? 'critical' : undefined },
            { label: 'Avg latency', value: `${round(ai.avgLatency, 0)}ms` },
          ]}
        />
        {ai.byTask.length > 0 && (
          <div className="mt-2">
            <Table compact head={[{ label: 'Task' }, { label: 'Calls', align: 'right' }, { label: 'Cost', align: 'right' }]}>
              {ai.byTask.map((t) => (
                <tr key={t.task}>
                  <td className="small">{t.task.replace(/_/g, ' ')}</td>
                  <td className="num small">{t.calls}</td>
                  <td className="num small">${round(t.cost, 5)}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      <SectionHead title="Model comparison" hint="Quality / cost / speed — measured, not claimed" />
      <Card tight>
        <Table
          head={[
            { label: 'Model' },
            { label: 'Tier' },
            { label: 'Quality', align: 'right' },
            { label: 'Accuracy', align: 'right' },
            { label: 'Latency', align: 'right' },
            { label: 'Cost /1k', align: 'right' },
            { label: 'Fail rate', align: 'right' },
            { label: 'Samples', align: 'right' },
          ]}
        >
          {models.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="small strong">{m.label}</div>
                <div className="xsmall muted">{m.provider}</div>
              </td>
              <td>
                <Badge tone="outline">{m.tier}</Badge>
              </td>
              <td className="num small">{round(m.quality * 100, 0)}</td>
              <td className="num small">{m.accuracy === null ? '—' : round(m.accuracy * 100, 0)}</td>
              <td className="num small">{round(m.speedMs, 0)}ms</td>
              <td className="num small">${round(m.costPer1k, 5)}</td>
              <td className="num small">{round(m.failureRate * 100, 1)}%</td>
              <td className="num small">{m.samples}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <SectionHead
        title="Experiments"
        hint="Recommendations only appear with enough sample size"
        right={<Link href="/settings" className="btn btn-sm">Configure models</Link>}
      />
      {experiments.length === 0 ? (
        <EmptyState title="No experiments" body="Default experiments are created with the workspace." />
      ) : (
        <div className="col">
          {experiments.map((e) => {
            const analysis = analyseVariants(e.variants, e.metric);
            return (
              <Card
                key={e.id}
                title={e.name}
                sub={e.hypothesis ?? undefined}
                actions={
                  <Badge tone={e.status === 'running' ? 'accent' : 'success'} dot>
                    {e.status}
                  </Badge>
                }
              >
                <Table compact head={[{ label: 'Variant' }, { label: 'Impressions', align: 'right' }, { label: 'Conversions', align: 'right' }, { label: 'Rate', align: 'right' }]}>
                  {e.variants.map((v) => (
                    <tr key={v.id}>
                      <td className="small">
                        {v.label} <span className="xsmall muted">({v.variant_key})</span>
                        {analysis.leader === v.variant_key && <Badge tone="success">leading</Badge>}
                      </td>
                      <td className="num small">{v.impressions}</td>
                      <td className="num small">{v.conversions}</td>
                      <td className="num small">{v.rate}%</td>
                    </tr>
                  ))}
                </Table>
                <p className="small muted mt-2">
                  <strong>Verdict:</strong> {analysis.detail}
                </p>
              </Card>
            );
          })}
        </div>
      )}

      <SectionHead title="AI optimization proposals" hint="Proposed, never applied automatically" />
      {optimizations.length === 0 ? (
        <EmptyState
          title="No optimization proposals"
          body="Forge AI learns from realised outcomes — which features convert, which tone gets replies, which design direction gets viewed. Proposals appear once there is enough outcome data. Nothing is applied without your approval."
          action={<ActionButton action={A.generateOptimizationsAction} args={[]} label="Scan outcomes now" />}
        />
      ) : (
        <div className="col">
          {optimizations.map((o) => (
            <Card key={o.id} title={o.title} sub={o.area} actions={<Badge tone="ai">Forge AI</Badge>}>
              <p className="small">{o.rationale}</p>
              <div className="row-wrap mt-2">
                <ActionButton action={A.resolveOptimizationAction} args={[o.id, 'accepted']} label="Accept & apply" variant="primary" confirm="Apply this change? It is recorded and reversible." />
                <ActionButton action={A.resolveOptimizationAction} args={[o.id, 'rejected']} label="Reject" variant="danger" />
                <code className="xsmall muted">{JSON.stringify(o.proposedChange)}</code>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

import Link from 'next/link';
