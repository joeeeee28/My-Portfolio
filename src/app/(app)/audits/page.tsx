import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { all } from '@/db';
import { json } from '@/db';
import { relativeFromNow } from '@/lib/time';
import { Card, Badge, EmptyState, SectionHead, Stats, Table, Bar, Score } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { ClipboardList } from 'lucide-react';

export const metadata = { title: 'Digital Audits' };
export const dynamic = 'force-dynamic';

export default async function AuditsPage() {
  const orgId = boot();
  await getSession();

  const audits = all<{
    id: string;
    business_id: string;
    name: string;
    website: string | null;
    website_status: string;
    website_score: number | null;
    seo_score: number | null;
    conversion_score: number | null;
    performance_score: number | null;
    accessibility_score: number | null;
    trust_score: number | null;
    verified: number;
    signals: string;
    critical_issues: string;
    recommended_service: string | null;
    response_ms: number | null;
    mobile_responsive: number | null;
    has_booking: number;
    form_count: number | null;
    cta_count: number | null;
    created_at: string;
    is_demo: number;
  }>(
    `SELECT a.id, a.business_id, b.name, b.website, a.website_status, a.website_score, a.seo_score, a.conversion_score,
            a.performance_score, a.accessibility_score, a.trust_score, a.verified, a.signals, a.critical_issues,
            a.recommended_service, a.response_ms, a.mobile_responsive, a.has_booking, a.form_count, a.cta_count,
            a.created_at, b.is_demo
       FROM digital_audits a JOIN businesses b ON b.id = a.business_id
      WHERE a.org_id = ?
      GROUP BY a.business_id
      HAVING a.created_at = MAX(a.created_at)
      ORDER BY a.website_score ASC LIMIT 100`,
    [orgId]
  );

  const socials = all<{
    business_id: string;
    name: string;
    social_score: number | null;
    platform_count: number;
    posting_frequency: string | null;
    content_gaps: string;
  }>(
    `SELECT s.business_id, b.name, s.social_score, s.platform_count, s.posting_frequency, s.content_gaps
       FROM social_audits s JOIN businesses b ON b.id = s.business_id
      WHERE s.org_id = ?
      GROUP BY s.business_id
      HAVING s.created_at = MAX(s.created_at)
      ORDER BY s.social_score ASC LIMIT 100`,
    [orgId]
  );

  const verifiedCount = audits.filter((a) => a.verified === 1).length;
  const criticalCount = audits.filter((a) => json<string[]>(a.critical_issues, []).length > 0).length;

  return (
    <>
      <div className="mb-2">
        <h1>Digital Audits</h1>
        <p className="small muted">
          Every finding here was measured, not estimated. A website that could not be reached is recorded as unreachable rather than scored on
          assumption.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Audits on record', value: audits.length },
          { label: 'Verified by live fetch', value: verifiedCount, detail: `${audits.length - verifiedCount} not fetched` },
          { label: 'With critical issues', value: criticalCount, tone: criticalCount > 0 ? 'critical' : undefined },
          { label: 'Social audits', value: socials.length },
        ]}
      />

      {audits.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<ClipboardList size={17} />}
            title="No audits yet"
            body="Run discovery and every prospect is audited, or open a single prospect and run the audit from its workspace."
            action={
              <Link href="/discover" className="btn btn-primary">
                Run discovery
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Website audits" hint="Ordered by score — weakest first" />
          <Card tight>
            <Table
              head={[
                { label: 'Business' },
                { label: 'Site' },
                { label: 'Status' },
                { label: 'Website', align: 'right' },
                { label: 'SEO', align: 'right' },
                { label: 'Conversion', align: 'right' },
                { label: 'Speed', align: 'right' },
                { label: 'Critical', align: 'right' },
                { label: 'Findings' },
                { label: '' },
              ]}
            >
              {audits.map((a) => {
                const signals = json<{ key: string; label: string; severity: string }[]>(a.signals, []);
                const criticals = json<string[]>(a.critical_issues, []);
                return (
                  <tr key={a.id}>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <Link href={`/prospects/${a.business_id}?tab=audit`} className="strong small" style={{ color: 'var(--accent)' }}>
                          {a.name}
                        </Link>
                        {a.is_demo === 1 && <span className="demo-flag">Demo</span>}
                      </div>
                    </td>
                    <td className="xsmall muted truncate" style={{ maxWidth: 150 }}>
                      {a.website ?? 'none'}
                    </td>
                    <td>
                      <Badge tone={a.website_status === 'live' ? 'success' : 'critical'}>{a.website_status}</Badge>
                    </td>
                    <td className="num">
                      <Score value={a.website_score} />
                    </td>
                    <td className="num small">{a.seo_score ?? '—'}</td>
                    <td className="num small">{a.conversion_score ?? '—'}</td>
                    <td className="num small">{a.response_ms ? `${a.response_ms}ms` : '—'}</td>
                    <td className="num small" style={criticals.length ? { color: 'var(--critical)', fontWeight: 700 } : undefined}>
                      {criticals.length}
                    </td>
                    <td>
                      <div className="row-wrap" style={{ gap: 4 }}>
                        {signals.slice(0, 3).map((s) => (
                          <Badge key={s.key} tone={s.severity === 'critical' ? 'critical' : s.severity === 'high' ? 'warning' : ''}>
                            {s.label}
                          </Badge>
                        ))}
                        {signals.length > 3 && <span className="xsmall muted">+{signals.length - 3}</span>}
                      </div>
                    </td>
                    <td>
                      <ActionButton action={A.auditBusinessAction} args={[a.business_id]} label="Re-run" />
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>

          <SectionHead title="Social audits" />
          <Card tight>
            <Table head={[{ label: 'Business' }, { label: 'Score', align: 'right' }, { label: 'Channels', align: 'right' }, { label: 'Cadence' }, { label: 'Content gaps' }]}>
              {socials.map((s) => (
                <tr key={s.business_id}>
                  <td>
                    <Link href={`/prospects/${s.business_id}?tab=audit`} className="small strong" style={{ color: 'var(--accent)' }}>
                      {s.name}
                    </Link>
                  </td>
                  <td className="num">
                    <Score value={s.social_score} />
                  </td>
                  <td className="num small">{s.platform_count}</td>
                  <td className="small">{s.posting_frequency ?? 'unknown'}</td>
                  <td className="small muted" style={{ maxWidth: 420 }}>
                    {json<string[]>(s.content_gaps, []).join(' · ') || '—'}
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
