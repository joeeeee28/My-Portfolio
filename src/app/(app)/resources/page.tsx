import { boot } from '@/lib/boot';
import { requireAuth } from '@/lib/auth';
import { buildResourceCenter, requiredUserActions, freeTierAlerts } from '@/engine/resources';
import { Card, Badge, SectionHead, Stats, Banner, Table, EmptyState } from '@/components/ui';
import { CheckCircle2, AlertTriangle, Circle, Info } from 'lucide-react';

export const metadata = { title: 'Resource Center' };
export const dynamic = 'force-dynamic';

const STATE_TONE: Record<string, string> = {
  configured: 'success',
  fallback: 'warning',
  not_configured: '',
  native: 'success',
};

const STATE_ICON: Record<string, string> = {
  configured: '●',
  fallback: '◐',
  not_configured: '○',
  native: '●',
};

export default async function ResourceCenterPage() {
  const orgId = boot();
  await requireAuth();

  const center = buildResourceCenter(orgId);
  const actions = requiredUserActions(orgId);
  const alerts = freeTierAlerts(orgId);

  return (
    <>
      <div className="mb-2">
        <h1>Resource Center</h1>
        <p className="small muted">
          Every external dependency, its cost, and what happens when it is absent. ClientForge is fully operational with zero external accounts —
          each capability has a working fallback.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Resources', value: center.summary.total },
          { label: 'Configured', value: center.summary.configured, tone: 'success' },
          { label: 'On fallback', value: center.summary.fallback, tone: center.summary.fallback > 0 ? 'warning' : undefined },
          { label: 'Not configured', value: center.summary.notConfigured },
          { label: 'Zero-cost', value: center.summary.native, tone: 'success' },
          { label: 'Need your action', value: center.summary.requiringUserAction, tone: center.summary.requiringUserAction > 0 ? 'warning' : undefined },
        ]}
      />

      {center.operationalWithoutCredentials && (
        <div className="mt-2">
          <Banner tone="success" icon={<CheckCircle2 size={15} />}>
            <strong>Fully operational with no external accounts.</strong> Every capability has a working fallback. Nothing here blocks you from
            discovering prospects, generating concepts, managing the pipeline or delivering work.
          </Banner>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="mt-2">
          <Banner tone={alerts.some((a) => a.level === 'critical') ? 'critical' : 'warning'} icon={<AlertTriangle size={15} />}>
            {alerts.map((a) => `${a.capability}: ${a.used}/${a.limit} (${a.pct}%)`).join(' · ')}
          </Banner>
        </div>
      )}

      <SectionHead title="Resources" hint="Implemented ≠ configured ≠ tested — these are never conflated" />
      <Card tight>
        <Table
          head={[
            { label: 'Capability' },
            { label: 'Provider' },
            { label: 'Cost' },
            { label: 'Status' },
            { label: 'Tested' },
            { label: 'Fallback' },
          ]}
        >
          {center.resources.map((r) => (
            <tr key={r.capability}>
              <td>
                <div className="small strong">{r.capability}</div>
                <div className="xsmall muted">{r.freeTierDetail}</div>
              </td>
              <td className="small">{r.provider}</td>
              <td>
                <Badge tone={r.cost === 'free' ? 'success' : r.cost === 'free-tier' ? 'accent' : r.cost === 'paid' ? 'warning' : ''}>
                  {r.cost}
                </Badge>
              </td>
              <td>
                <div className="row" style={{ gap: 5 }}>
                  <span style={{ color: r.state === 'configured' ? 'var(--success)' : r.state === 'fallback' ? 'var(--warning)' : 'var(--text-3)' }}>
                    {STATE_ICON[r.state]}
                  </span>
                  <span className="small">{r.stateLabel}</span>
                </div>
                {r.usage && r.usage.limit !== null && (
                  <div className="xsmall muted">
                    {r.usage.used}/{r.usage.limit}
                    {r.usage.pct !== null ? ` (${r.usage.pct}%)` : ''}
                  </div>
                )}
              </td>
              <td className="xsmall muted">{r.testedLabel}</td>
              <td className="xsmall muted" style={{ maxWidth: 260 }}>
                {r.fallback}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <SectionHead title="Only these actions need you" hint="Everything else is already configured" />
      {actions.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={17} />}
          title="Nothing is blocking you"
          body="Every capability has a working fallback. Add credentials only when you want to upgrade a specific provider."
        />
      ) : (
        <Card>
          <ol className="col" style={{ gap: 12 }}>
            {actions.map((a, i) => (
              <li key={a.provider}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="badge accent">{i + 1}</span>
                  <span className="small strong">{a.provider}</span>
                  <Badge tone="warning">{a.why}</Badge>
                </div>
                <p className="small muted mt-1">{a.setting}</p>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <SectionHead title="No-credential mode" hint="What happens when a provider is absent (§52)" />
      <Card tight>
        <Table head={[{ label: 'Missing' }, { label: 'ClientForge does' }, { label: 'Never' }]}>
          {[
            ['Hosted AI key', 'Runs the local grounded engine on supplied facts', 'Fabricates AI output or business facts'],
            ['Email provider', 'Drafts outreach into the local outbox for manual sending', 'Claims a message was sent'],
            ['Enrichment provider', 'Uses public business data, marked Unverified', 'Presents an unverified contact as verified'],
            ['Calendar', 'Schedules calls manually with a meeting link', 'Requires a paid meeting service'],
            ['Social API', 'Produces Ready-to-publish content with captions and hashtags', 'Claims a post was published'],
            ['Payment provider', 'Runs Proposal accepted → payment pending', 'Marks a payment as paid'],
            ['Hosting provider', 'Serves sites in-app and marks deployments simulated', 'Claims a site is live'],
            ['Custom domain', 'Uses the ClientForge preview domain', 'Purchases a domain'],
          ].map(([missing, does, never]) => (
            <tr key={missing}>
              <td className="small strong">{missing}</td>
              <td className="small">{does}</td>
              <td className="small" style={{ color: 'var(--critical)' }}>
                {never}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="mt-2">
        <Banner tone="accent" icon={<Info size={15} />}>
          States are distinct by design: <strong>Implemented</strong> means the code exists, <strong>Configured</strong> means credentials are present,{' '}
          <strong>Tested</strong> means a real call succeeded. A provider is never marked live merely because its code exists.
        </Banner>
      </div>
    </>
  );
}
