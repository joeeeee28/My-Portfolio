import Link from 'next/link';
import { notFound } from 'next/navigation';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { getMockup, listVersions, listViews } from '@/engine/mockup';
import { getBusiness } from '@/repo/business';
import { relativeFromNow, formatDateTime } from '@/lib/time';
import { BRAND } from '@/lib/brand';
import { Card, Badge, Stats, Bar, SectionHead, Table, EmptyState } from '@/components/ui';
import { ConceptEditor, ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { json } from '@/db';

export const dynamic = 'force-dynamic';

export default async function MockupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const orgId = boot();
  await getSession();
  const { id } = await params;
  const mockup = getMockup(orgId, id);
  if (!mockup) notFound();

  const business = getBusiness(orgId, mockup.business_id);
  const versions = listVersions(id);
  const views = listViews(id, 50);
  const theme = json<Record<string, unknown>>(mockup.theme, {});
  const palette = ((theme.palette as Record<string, string>) ?? {});
  const kit = json<Record<string, unknown>>(mockup.pitch_kit, {});
  const devices = json<Record<string, number>>(mockup.devices, {});

  return (
    <>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1>{mockup.title}</h1>
          <p className="small muted">
            ClientForge Concept · {mockup.design_direction} direction · v{mockup.current_version}
            {business ? (
              <>
                {' · '}
                <Link href={`/prospects/${business.id}`} style={{ color: 'var(--accent)' }}>
                  {business.name}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="spacer" />
        <Link href={`/mockup/${mockup.share_token}`} target="_blank" className="btn">
          Open preview
        </Link>
        <ActionButton action={A.shareConceptAction} args={[id, true]} label="Enable sharing" />
        <ActionButton action={A.publishFromConceptAction} args={[id]} label="Publish as website" variant="primary" />
      </div>

      <Stats
        items={[
          { label: 'Total views', value: mockup.view_count },
          { label: 'Unique viewers', value: mockup.unique_viewers },
          { label: 'Returning viewers', value: mockup.returning_viewers },
          { label: 'Time on page', value: `${Math.round(mockup.total_view_ms / 1000)}s` },
          { label: 'Intent score', value: Math.round(mockup.intent_score), tone: mockup.intent_score > 60 ? 'critical' : mockup.intent_score > 30 ? 'warning' : undefined },
          { label: 'First viewed', value: mockup.first_viewed_at ? relativeFromNow(mockup.first_viewed_at) : 'never' },
        ]}
      />

      <div className="grid grid-main mt-3">
        <div className="col">
          <Card title="Live preview" sub="The exact page a prospect sees, tracking enabled">
            <iframe
              src={`/mockup/${mockup.share_token}`}
              title="Concept preview"
              style={{ width: '100%', height: 720, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
            />
          </Card>

          <Card title="Edit the concept" sub="Describe the change — every edit creates a new version">
            <ConceptEditor mockupId={id} versions={versions} shareUrl={`/mockup/${mockup.share_token}`} />
          </Card>

          {Object.keys(kit).length > 0 && (
            <Card title="Pitch kit" sub="Generated from this concept and the prospect's audit">
              <div className="col" style={{ gap: 12 }}>
                <div>
                  <div className="xsmall muted">Value proposition</div>
                  <p className="small">{String(kit.valueProposition ?? '')}</p>
                </div>
                <div>
                  <div className="xsmall muted">Suggested subject lines</div>
                  <ul className="col" style={{ gap: 3 }}>
                    {((kit.email as { subjectLines?: string[] })?.subjectLines ?? []).map((s, i) => (
                      <li key={i} className="small">
                        • {s}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="xsmall muted">Email</div>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, background: 'var(--surface-2)', padding: 10, borderRadius: 4, margin: '4px 0 0' }}>
                    {(kit.email as { body?: string })?.body ?? ''}
                  </pre>
                </div>
                <div className="grid grid-2">
                  <div>
                    <div className="xsmall muted">SMS</div>
                    <p className="small">{String(kit.sms ?? '')}</p>
                  </div>
                  <div>
                    <div className="xsmall muted">WhatsApp</div>
                    <p className="small">{String(kit.whatsapp ?? '')}</p>
                  </div>
                </div>
                <div>
                  <div className="xsmall muted">Call briefing</div>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, background: 'var(--surface-2)', padding: 10, borderRadius: 4, margin: '4px 0 0' }}>
                    {String(kit.callBriefing ?? '')}
                  </pre>
                </div>
                {Array.isArray(kit.groundedIn) && (
                  <div>
                    <div className="xsmall muted">Grounded in</div>
                    <div className="row-wrap mt-1">
                      {(kit.groundedIn as string[]).map((g, i) => (
                        <span key={i} className="chip">
                          {g}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        <aside className="col">
          <Card title="Design direction" sub={String(theme.label ?? mockup.design_direction)}>
            <div className="row-wrap mb-2">
              {Object.entries(palette).map(([k, v]) =>
                typeof v === 'string' ? (
                  <div key={k} className="row" style={{ gap: 5 }}>
                    <span style={{ width: 16, height: 16, borderRadius: 3, background: v, border: '1px solid var(--border)', display: 'inline-block' }} />
                    <span className="xsmall muted">
                      {k} {v}
                    </span>
                  </div>
                ) : null
              )}
            </div>
            <div className="xsmall muted">
              Layout variant {mockup.layout_variant} · seed <code>{mockup.slug}</code>
            </div>
            <p className="xsmall muted mt-2">
              Direction is chosen from the business category and a deterministic seed, so two bakeries do not get the same site.
            </p>
          </Card>

          <Card title="View tracking" sub="Who opened it, and how deeply">
            {views.length === 0 ? (
              <p className="small muted">No views recorded yet. Share the concept and views appear here automatically.</p>
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {Object.entries(devices).length > 0 && (
                  <div>
                    <div className="xsmall muted mb-1">Devices</div>
                    <div className="row-wrap">
                      {Object.entries(devices).map(([d, c]) => (
                        <Badge key={d} tone="outline">
                          {d}: {c}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <ul className="col" style={{ gap: 5 }}>
                  {views.slice(0, 12).map((v) => (
                    <li key={v.id} className="small">
                      <div className="row" style={{ gap: 6 }}>
                        <Badge tone={v.is_returning === 1 ? 'success' : ''}>{v.is_returning === 1 ? 'returning' : 'new'}</Badge>
                        <span className="xsmall muted">{String(v.device ?? 'unknown')}</span>
                        <span className="xsmall muted">{formatDateTime(v.viewed_at as string)}</span>
                      </div>
                      <div className="xsmall muted">
                        {Math.round(Number(v.duration_ms) / 1000)}s · {v.scrolled_pct}% scrolled
                        {v.cta_clicked === 1 ? ' · CTA clicked' : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="Version history" sub={`${versions.length} version(s)`}>
            {versions.length === 0 ? (
              <p className="small muted">No versions yet.</p>
            ) : (
              <ul className="col" style={{ gap: 6 }}>
                {versions.map((v) => (
                  <li key={v.version}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mono small">v{v.version}</span>
                      <Badge tone={v.version === mockup.current_version ? 'accent' : ''}>{v.version === mockup.current_version ? 'current' : ''}</Badge>
                    </div>
                    <div className="xsmall muted">{v.change_summary ?? '—'}</div>
                    {v.change_command && <div className="xsmall muted">“{v.change_command}”</div>}
                    <div className="xsmall muted">{formatDateTime(v.created_at)}</div>
                    {v.version !== mockup.current_version && (
                      <div className="mt-1">
                        <ActionButton
                          action={A.rollbackConceptAction} args={[id, v.version]}
                          label="Roll back"
                          confirm={`Roll back to v${v.version}? A new version is created — nothing is lost.`}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
