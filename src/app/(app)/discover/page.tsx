import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listSources } from '@/lib/providers/registry';
import { listRuns } from '@/engine/discovery';
import { listImportBatches } from '@/engine/io';
import { automationHealth } from '@/engine/analytics';
import { relativeFromNow, formatDateTime } from '@/lib/time';
import { BRAND } from '@/lib/brand';
import { Card, Badge, EmptyState, Banner, SectionHead, Stats, Table } from '@/components/ui';
import { RunDiscoveryButton, CsvImporter, ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Radar, AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Business Discovery' };
export const dynamic = 'force-dynamic';

export default async function DiscoverPage() {
  const orgId = boot();
  await getSession();
  const sources = listSources(orgId);
  const runs = listRuns(orgId, 10);
  const imports = listImportBatches(orgId, 10);
  const health = automationHealth(orgId);

  const usable = sources.filter((s) => s.usable);
  const enabledNoKey = sources.filter((s) => s.enabled === 1 && !s.credentials_ready);
  const readyNoKey = sources.filter((s) => s.enabled === 0 && s.credentials_ready === 1 && !s.requires_credentials);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>Business Discovery</h1>
          <p className="small muted">
            Discovery is business-first: ClientForge searches by opportunity and category, not by postcode. Location is metadata, never a requirement.
          </p>
        </div>
        <div className="spacer" />
        <RunDiscoveryButton />
      </div>

      {usable.length === 0 && (
        <div className="mb-2">
          <Banner tone="warning" icon={<AlertTriangle size={15} />}>
            No discovery source is enabled and usable yet. OpenStreetMap needs no credentials — enable it below and discovery works immediately.
          </Banner>
        </div>
      )}

      {enabledNoKey.length > 0 && (
        <div className="mb-2">
          <Banner tone="warning">
            {enabledNoKey.map((s) => s.label).join(', ')} {enabledNoKey.length === 1 ? 'is' : 'are'} enabled but missing credentials. They will be
            skipped rather than returning invented data.
          </Banner>
        </div>
      )}

      <Stats
        items={[
          { label: 'Sources ready', value: `${usable.length}/${sources.length}` },
          { label: 'Runs', value: health.runs, detail: `${health.successRate}% successful` },
          { label: 'Last run', value: health.lastRunAt ? relativeFromNow(health.lastRunAt) : 'never' },
          { label: 'Next run', value: health.nextRunAt ? relativeFromNow(health.nextRunAt) : 'not scheduled' },
          { label: 'Import batches', value: imports.length },
        ]}
      />

      <SectionHead
        title="Discovery sources"
        hint="Provider abstraction — new sources plug in without application changes"
        right={<Link href="/settings" className="btn btn-sm">Configure credentials</Link>}
      />
      <Card tight>
        <Table
          head={[
            { label: 'Source' },
            { label: 'Category' },
            { label: 'Credentials' },
            { label: 'State' },
            { label: 'Records', align: 'right' },
            { label: 'Last run' },
            { label: '' },
          ]}
        >
          {sources.map((s) => (
            <tr key={s.provider_key}>
              <td>
                <div className="strong small">{s.label}</div>
                <div className="xsmall muted" style={{ maxWidth: 380 }}>
                  {categoryDescription(s.provider_key)}
                </div>
              </td>
              <td>
                <Badge tone="outline">{s.category}</Badge>
              </td>
              <td className="small">
                {s.requires_credentials === 0 ? (
                  <Badge tone="success">none needed</Badge>
                ) : s.credentials_ready === 1 ? (
                  <Badge tone="success">stored</Badge>
                ) : (
                  <Badge tone="warning">required</Badge>
                )}
              </td>
              <td>
                <Badge tone={s.usable ? 'success' : s.enabled === 1 ? 'critical' : ''} dot>
                  {s.usable ? 'ready' : s.enabled === 1 ? 'blocked' : 'disabled'}
                </Badge>
              </td>
              <td className="num small">{s.records_total}</td>
              <td className="xsmall muted">{s.last_run_at ? relativeFromNow(s.last_run_at) : 'never'}</td>
              <td>
                <ActionButton action={A.setSourceEnabledAction} args={[s.provider_key, s.enabled !== 1]} label={s.enabled === 1 ? 'Disable' : 'Enable'} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid grid-2 mt-3">
        <div>
          <SectionHead title="Recent discovery runs" />
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" body="Discovery records every step so you can see exactly what happened and what failed." action={<RunDiscoveryButton />} />
          ) : (
            <Card tight>
              <div className="queue">
                {runs.map((r) => (
                  <Link key={r.id as string} href={`/automation?run=${r.id}`} className="queue-item">
                    <div className="queue-main">
                      <div className="queue-title">{formatDateTime(r.started_at as string)}</div>
                      <div className="queue-reason">{String(r.summary ?? '')}</div>
                    </div>
                    <Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'critical' : 'warning'}>{String(r.status)}</Badge>
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div>
          <SectionHead title="Import" hint="Validated and deduplicated before writing" />
          <Card>
            <CsvImporter />
          </Card>
          {imports.length > 0 && (
            <div className="mt-2">
              <Card title="Import history" tight>
                <Table compact head={[{ label: 'File' }, { label: 'Rows', align: 'right' }, { label: 'Added', align: 'right' }, { label: 'Dupes', align: 'right' }, { label: 'When' }]}>
                  {imports.map((b) => (
                    <tr key={b.id}>
                      <td className="small truncate" style={{ maxWidth: 160 }}>
                        {String(b.filename ?? 'import')}
                      </td>
                      <td className="num small">{b.rows_total}</td>
                      <td className="num small">{b.rows_imported}</td>
                      <td className="num small">{b.rows_deduped}</td>
                      <td className="xsmall muted">{relativeFromNow(b.created_at)}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3">
        <Card title="How discovery works" sub="The 19-step pipeline, in order">
          <ol className="col" style={{ gap: 4, counterReset: 'step' }}>
            {[
              'Discover businesses from every enabled source',
              'Deduplicate against the Prospect Hub',
              'Verify business identity from corroborating sources',
              'Verify website status',
              'Analyse digital presence (website audit)',
              'Enrich business information',
              'Find relevant contacts where available',
              'Analyse social presence',
              'Analyse competitors from our own audited cohort',
              'Identify growth signals',
              'Calculate Opportunity Scores',
              'Rank prospects',
              'Generate recommended actions',
              'Generate outreach drafts',
              'Generate website concepts for eligible prospects',
              'Create follow-up tasks',
              'Update the pipeline',
              'Update analytics',
              'Log every action',
            ].map((step, i) => (
              <li key={i} className="small">
                <span className="mono muted" style={{ marginRight: 8 }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}

function categoryDescription(key: string): string {
  const map: Record<string, string> = {
    'overpass.osm': 'Live public business records from OpenStreetMap — name, website, phone, address, accessibility tags. No credentials.',
    'places.google': 'Text Search + Place Details with ratings and review counts.',
    'serpapi.search': 'Search-engine discovery by opportunity phrasing.',
    'opencorporates.company': 'Public registered-company records.',
    'yelp.reviews': 'Ratings and review counts — the reputation signal behind "strong reviews, weak website".',
    'import.csv': 'Your own lists, validated and deduplicated.',
    'import.crm': 'Pull accounts and contacts from a connected CRM.',
    'social.profiles': 'Public business profile lookup.',
  };
  return map[key] ?? '';
}
