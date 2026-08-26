import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listMockups } from '@/engine/mockup';
import { relativeFromNow } from '@/lib/time';
import { BRAND } from '@/lib/brand';
import { Card, Badge, EmptyState, SectionHead, Stats, Table, Bar } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { LayoutTemplate } from 'lucide-react';

export const metadata = { title: 'Website Concepts' };
export const dynamic = 'force-dynamic';

export default async function MockupsPage() {
  const orgId = boot();
  await getSession();
  const mockups = listMockups(orgId, { limit: 100 });

  const viewed = mockups.filter((m) => m.view_count > 0);
  const drafts = mockups.filter((m) => m.status === 'draft');

  return (
    <>
      <div className="mb-2">
        <h1>Website Concepts</h1>
        <p className="small muted">
          Sales assets built from each prospect&apos;s real record. The design direction is derived from the business rather than picked from a template
          library, and anything the record cannot support is flagged for review rather than invented.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Concepts', value: mockups.length },
          { label: 'Shared', value: mockups.filter((m) => m.status === 'shared').length },
          { label: 'Viewed', value: viewed.length, tone: viewed.length > 0 ? 'success' : undefined },
          { label: 'Awaiting review', value: drafts.length, tone: drafts.length > 0 ? 'warning' : undefined },
          { label: 'Total views', value: mockups.reduce((a, m) => a + m.view_count, 0) },
        ]}
      />

      {mockups.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<LayoutTemplate size={17} />}
            title="No website concepts yet"
            body={`Concepts are generated for prospects above the threshold set in Settings, or on demand from any ${BRAND.workspaceLabel.toLowerCase()}.`}
            action={
              <Link href="/prospects" className="btn btn-primary">
                Go to Prospect Hub
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Concepts" hint="Viewed concepts are the warmest prospects you have" />
          <Card tight>
            <Table
              head={[
                { label: 'Concept' },
                { label: 'Direction' },
                { label: 'Version', align: 'right' },
                { label: 'Status' },
                { label: 'Views', align: 'right' },
                { label: 'Intent', width: '120px' },
                { label: 'Last viewed' },
                { label: '' },
              ]}
            >
              {mockups.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link href={`/mockups/${m.id}`} className="strong small" style={{ color: 'var(--accent)' }}>
                      {m.title}
                    </Link>
                    <div className="xsmall muted">
                      ClientForge Concept · {m.slug}
                    </div>
                  </td>
                  <td>
                    <Badge tone="outline">{m.design_direction}</Badge>
                  </td>
                  <td className="num small mono">v{m.current_version}</td>
                  <td>
                    <Badge tone={m.status === 'viewed' ? 'success' : m.status === 'shared' ? 'accent' : 'warning'} dot>
                      {m.status}
                    </Badge>
                  </td>
                  <td className="num small">
                    {m.view_count}
                    {m.unique_viewers > 0 && <span className="muted"> / {m.unique_viewers} unique</span>}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <Bar value={m.intent_score} tone={m.intent_score > 60 ? 'critical' : m.intent_score > 30 ? 'warning' : undefined} />
                      <span className="xsmall mono">{Math.round(m.intent_score)}</span>
                    </div>
                  </td>
                  <td className="xsmall muted">{m.last_viewed_at ? relativeFromNow(m.last_viewed_at) : 'never'}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <Link href={`/mockup/${m.share_token}`} target="_blank" className="btn btn-sm">
                        Preview
                      </Link>
                      <Link href={`/mockups/${m.id}`} className="btn btn-sm">
                        Edit
                      </Link>
                      <ActionButton action={A.publishFromConceptAction} args={[m.id]} label="Publish" />
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
