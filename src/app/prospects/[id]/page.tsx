import Link from 'next/link';
import { notFound } from 'next/navigation';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { getBusiness, listContacts, listSources } from '@/repo/business';
import { intelligenceView } from '@/engine/research';
import { latestScore } from '@/engine/scoring';
import { computeSalesIntelligence, computeNba } from '@/engine/nba';
import { listBusinessActivity } from '@/lib/activity';
import { listMessages } from '@/engine/outreach';
import { getMockupForBusiness, listVersions } from '@/engine/mockup';
import { listCalls, listProposals, listProjects, listTasks, listUpsells } from '@/engine/crm';
import { listCompetitors } from '@/lib/audit/competitor';
import { buildGrowthSignals } from '@/engine/signals';
import { recall } from '@/lib/ai/memory';
import { relativeDateTime, relativeFromNow } from '@/lib/time';
import { serviceLabel, scoreBand, PIPELINE, STAGE_TO_PIPELINE } from '@/lib/brand';
import { Card, Score, Badge, EmptyState, KeyValue, Bar, AiTag, DemoFlag, SectionHead, StrengthBadge, Stats } from '@/components/ui';
import { WorkspaceTabs } from '@/components/WorkspaceTabs';
import { ActionButton, ConceptEditor, InlineForm } from '@/components/actions-client';
import * as A from '@/app/actions';
import * as F from '@/app/form-actions';
import { PIPELINE_STAGES } from '@/lib/domain';
import { formatDateTime } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function BusinessWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const orgId = boot();
  await getSession();
  const { id } = await params;
  const business = getBusiness(orgId, id);
  if (!business) notFound();

  const intel = intelligenceView(orgId, id);
  const score = latestScore(orgId, id);
  const si = computeSalesIntelligence(orgId, id);
  const nba = computeNba(orgId, id);
  const contacts = listContacts(orgId, id);
  const sources = listSources(orgId, id);
  const activity = listBusinessActivity(orgId, id, 60);
  const messages = listMessages(orgId, { businessId: id, limit: 30 });
  const mockup = getMockupForBusiness(orgId, id);
  const versions = mockup ? listVersions(mockup.id) : [];
  const calls = listCalls(orgId, { businessId: id });
  const proposals = listProposals(orgId, { businessId: id });
  const projects = listProjects(orgId).filter((p) => p.business_id === id);
  const tasks = projects.length ? listTasks(orgId, { projectId: projects[0].id }) : [];
  const competitors = listCompetitors(orgId, id);
  const growth = buildGrowthSignals(orgId, id);
  const memories = recall(orgId, id);
  // The audit row is a wide, sparsely-typed record; narrow it once here.
  const audit = intel?.audit as (Record<string, number | string | null> & {
    website_score?: number | null; seo_score?: number | null; conversion_score?: number | null;
    performance_score?: number | null; accessibility_score?: number | null; trust_score?: number | null;
    content_score?: number | null; branding_score?: number | null; verified?: number | null;
    http_status?: number | null; response_ms?: number | null; ssl_valid?: number | null; ssl_issuer?: string | null;
    mobile_responsive?: number | null; title?: string | null; meta_description?: string | null;
    h1_count?: number | null; h2_count?: number | null; word_count?: number | null; page_count_est?: number | null;
    form_count?: number | null; cta_count?: number | null; has_booking?: number | null; has_schema_markup?: number | null;
    images_missing_alt?: number | null; image_count?: number | null;
    critical_issues?: string; high_impact?: string; nice_to_have?: string;
  }) | null | undefined;
  const socialAudit = intel?.socialAudit as (Record<string, number | string | null> & {
    social_score?: number | null; platform_count?: number | null; active_platforms?: number | null;
    posting_frequency?: string | null; profile_completeness?: number | null;
    growth_opportunity?: string | null; content_gaps?: string;
  }) | null | undefined;
  const band = scoreBand(business.opportunity_score ?? 0);
  const pipelineKey = STAGE_TO_PIPELINE[business.stage] ?? 'discovered';

  return (
    <>
      {/* ── Header (§60) ─────────────────────────────────────── */}
      <Card>
        <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <h1>{business.name}</h1>
              {business.is_demo === 1 && <DemoFlag />}
              <Badge tone={business.priority === 'critical' ? 'critical' : business.priority === 'high' ? 'accent' : ''} dot>
                {business.priority}
              </Badge>
              <Badge tone="outline">{business.stage.replace(/_/g, ' ')}</Badge>
            </div>
            <div className="small muted mt-1">
              {[business.category, business.industry, [business.locality, business.region].filter(Boolean).join(' ')].filter(Boolean).join(' · ') ||
                'Category not established from available data'}
            </div>
            {business.description && <p className="small mt-1" style={{ maxWidth: '80ch' }}>{business.description}</p>}
          </div>

          <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div>
              <div className="xsmall muted" style={{ marginBottom: 4 }}>
                ClientForge Opportunity Score
              </div>
              <Score value={business.opportunity_score} size="lg" />
            </div>
            {si && (
              <div>
                <div className="xsmall muted" style={{ marginBottom: 4 }}>
                  Deal health
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Badge tone={si.dealHealth.tone === 'risk' ? 'critical' : si.dealHealth.tone === 'watch' ? 'warning' : 'success'}>
                    {si.dealHealth.label}
                  </Badge>
                  <span className="small">{Math.round(si.closeProbability)}% close</span>
                </div>
                <div className="xsmall muted mt-1">${Math.round(si.revenuePotential).toLocaleString()} potential</div>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-4 mt-3">
          <div>
            <div className="xsmall muted">Recommended service</div>
            <div className="small strong">{serviceLabel(business.recommended_service)}</div>
          </div>
          <div>
            <div className="xsmall muted">Next best action</div>
            <div className="small strong">{nba?.label ?? '—'}</div>
            {nba && <div className="xsmall muted">{nba.reason}</div>}
          </div>
          <div>
            <div className="xsmall muted">Website status</div>
            <div className="small strong">{business.website ?? 'None on record'}</div>
            <Badge tone={business.website_status === 'live' ? 'success' : 'critical'}>{business.website_status}</Badge>
          </div>
          <div>
            <div className="xsmall muted">Data confidence</div>
            <div className="small strong">{intel?.dataConfidence ? `${intel.dataConfidence.overall}%` : 'Not computed'}</div>
            {intel?.dataConfidence?.last_verified_at && <div className="xsmall muted">Verified {relativeFromNow(intel.dataConfidence.last_verified_at)}</div>}
          </div>
        </div>

        <div className="row-wrap mt-3">
          <ActionButton action={A.auditBusinessAction} args={[id]} label="Run audit" />
          <ActionButton action={A.researchBusinessAction} args={[id]} label="Refresh intelligence" />
          <ActionButton action={A.scoreBusinessAction} args={[id]} label="Re-score" />
          {mockup ? (
            <Link href={`/mockups/${mockup.id}`} className="btn btn-sm">
              Open concept
            </Link>
          ) : (
            <ActionButton action={A.generateConceptAction} args={[id]} label="Generate website concept" variant="primary" />
          )}
          <ActionButton action={A.generateOutreachAction} args={[id]} label="Draft outreach" />
          <ActionButton action={A.generateProposalAction} args={[id]} label="Draft proposal" />
          <ActionButton action={A.convertToClientAction} args={[id, proposals[0]?.id]} label="Convert to client" variant="primary" confirm={`Convert ${business.name} into a client and open a delivery project? The existing record is reused — no duplicate is created.`} />
          <ActionButton action={A.markNotInterestedAction} args={[id]} label="Not interested" variant="danger" confirm="Stop all outreach, sequences and follow-ups for this business?" />
        </div>
      </Card>

      <div className="grid grid-main mt-3">
        <div>
          <WorkspaceTabs
            panels={[
              {
                key: 'overview',
                label: 'Overview',
                content: (
                  <>
                    <SectionHead title="Client Pipeline position" />
                    <div className="row-wrap">
                      {PIPELINE.map((p) => (
                        <span
                          key={p.key}
                          className={`chip${p.key === pipelineKey ? ' active' : ''}`}
                          style={p.key === pipelineKey ? undefined : { opacity: 0.6 }}
                        >
                          {p.label}
                        </span>
                      ))}
                    </div>

                    <SectionHead title="Move stage" />
                    <InlineForm
                      action={F.formChangeStage}
                      submitLabel="Move"
                    >
                      <input type="hidden" name="id" value={id} />
                      <select className="select" name="stage" defaultValue={business.stage}>
                        {PIPELINE_STAGES.map((s) => (
                          <option key={s} value={s}>
                            {s.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                    </InlineForm>

                    <SectionHead title="Business record" />
                    <Card>
                      <KeyValue
                        items={[
                          { label: 'Category', value: business.category },
                          { label: 'Industry', value: business.industry },
                          { label: 'Location', value: [business.address_line, business.locality, business.region, business.country].filter(Boolean).join(', ') },
                          { label: 'Website', value: business.website ? <a href={business.website} target="_blank" rel="noreferrer">{business.website}</a> : null },
                          { label: 'Phone', value: business.phone },
                          { label: 'Email', value: business.email },
                          { label: 'Rating', value: business.rating ? `${business.rating}★${business.review_count ? ` from ${business.review_count} reviews` : ''}` : null },
                          { label: 'Founded', value: business.founded_year },
                          { label: 'Social', value: Object.entries(business.social ?? {}).map(([k, v]) => <a key={k} href={v} target="_blank" rel="noreferrer" className="chip" style={{ marginRight: 4 }}>{k}</a>) },
                          { label: 'Consent', value: business.consent_state },
                          { label: 'Discovered', value: relativeDateTime(business.first_discovered_at) },
                        ]}
                      />
                    </Card>

                    {contacts.length > 0 && (
                      <>
                        <SectionHead title="Contacts" />
                        <Card tight>
                          <table className="table table-compact">
                            <thead>
                              <tr>
                                <th>Name</th>
                                <th>Title</th>
                                <th>Email</th>
                                <th>Confidence</th>
                              </tr>
                            </thead>
                            <tbody>
                              {contacts.map((c) => (
                                <tr key={c.id}>
                                  <td>
                                    {c.full_name}
                                    {c.is_decision_maker === 1 && <Badge tone="accent">decision maker</Badge>}
                                  </td>
                                  <td className="small">{c.job_title ?? '—'}</td>
                                  <td className="small">{c.email ?? '—'}</td>
                                  <td className="num small">{Math.round(c.confidence * 100)}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </Card>
                      </>
                    )}

                    <SectionHead title="Sales intelligence" hint="Computed from observed behaviour, not guessed" />
                    {si ? (
                      <Stats
                        items={[
                          { label: 'Buying intent', value: Math.round(si.buyingIntent), detail: '/100' },
                          { label: 'Engagement', value: Math.round(si.engagementScore), detail: '/100' },
                          { label: 'Response probability', value: `${si.responseProbability}%` },
                          { label: 'Close probability', value: `${si.closeProbability}%` },
                          { label: 'Revenue potential', value: `$${Math.round(si.revenuePotential).toLocaleString()}` },
                          { label: 'Sales risk', value: si.salesRisk, tone: si.salesRisk === 'critical' ? 'critical' : si.salesRisk === 'high' ? 'warning' : 'success' },
                        ]}
                      />
                    ) : null}
                  </>
                ),
              },
              {
                key: 'intelligence',
                label: 'Intelligence',
                content: (
                  <>
                    {intel?.research ? (
                      <>
                        <SectionHead
                          title="Business Intelligence"
                          hint={intel.researchAgeHours !== null ? `Updated ${intel.researchAgeHours}h ago` : undefined}
                          right={<ActionButton action={A.researchBusinessAction} args={[id]} label="Refresh" />}
                        />
                        <Card>
                          <KeyValue
                            items={[
                              { label: 'What they do', value: intel.research.what_they_do },
                              { label: 'Customers', value: intel.research.customers },
                              { label: 'Opportunity', value: intel.research.opportunity },
                              { label: 'What to sell', value: serviceLabel(intel.research.what_to_sell) },
                              { label: 'Confidence', value: `${Math.round((intel.research.confidence ?? 0) * 100)}%` },
                            ]}
                          />
                        </Card>

                        {intel.research.services_offered.length > 0 && (
                          <>
                            <SectionHead title="Services offered" />
                            <div className="row-wrap">
                              {intel.research.services_offered.map((s) => (
                                <span key={s} className="chip">
                                  {s}
                                </span>
                              ))}
                            </div>
                          </>
                        )}

                        {intel.research.digital_weaknesses.length > 0 && (
                          <>
                            <SectionHead title="Digital weaknesses" />
                            <Card>
                              <ul className="col" style={{ gap: 5 }}>
                                {intel.research.digital_weaknesses.map((w, i) => (
                                  <li key={i} className="small">
                                    • {w}
                                  </li>
                                ))}
                              </ul>
                            </Card>
                          </>
                        )}

                        {intel.research.outreach_angles.length > 0 && (
                          <>
                            <SectionHead title="Outreach angles" hint="Grounded in the evidence above" />
                            <div className="ai-panel" style={{ padding: 12 }}>
                              <AiTag />
                              <ul className="col mt-1" style={{ gap: 5 }}>
                                {intel.research.outreach_angles.map((a, i) => (
                                  <li key={i} className="small">
                                    • {a}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <EmptyState
                        title="No intelligence brief yet"
                        body="Forge AI assembles a brief strictly from evidence ClientForge holds — the record, measured audits and competitor comparisons. Anything it cannot support is listed as unverified rather than guessed."
                        action={<ActionButton action={A.researchBusinessAction} args={[id]} label="Generate intelligence brief" variant="primary" size="md" />}
                      />
                    )}

                    <SectionHead title="Growth signals" hint={`${growth.score}/100`} />
                    {growth.signals.length ? (
                      <Card tight>
                        <table className="table table-compact">
                          <thead>
                            <tr>
                              <th>Signal</th>
                              <th>Evidence</th>
                            </tr>
                          </thead>
                          <tbody>
                            {growth.signals.map((s) => (
                              <tr key={s.key}>
                                <td className="strong small">{s.label}</td>
                                <td className="small muted">{s.evidence}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                    ) : (
                      <p className="small muted">No growth signals detected from the data on record.</p>
                    )}

                    <SectionHead title="Competitor comparison" hint="Both sides measured by us — never asserted" />
                    {competitors.length ? (
                      <Card tight>
                        <table className="table table-compact">
                          <thead>
                            <tr>
                              <th>Peer</th>
                              <th>Website</th>
                              <th>Mobile</th>
                              <th>SEO</th>
                              <th>Social</th>
                              <th>Branding</th>
                              <th>CTA</th>
                              <th className="num">Gap</th>
                            </tr>
                          </thead>
                          <tbody>
                            {competitors.map((c) => (
                              <tr key={c.id}>
                                <td className="strong small">{c.name}</td>
                                <td><StrengthBadge value={c.website_strength} /></td>
                                <td><StrengthBadge value={c.mobile_strength} /></td>
                                <td><StrengthBadge value={c.seo_strength} /></td>
                                <td><StrengthBadge value={c.social_strength} /></td>
                                <td><StrengthBadge value={c.branding_strength} /></td>
                                <td><StrengthBadge value={c.cta_strength} /></td>
                                <td className="num">{c.gap_score}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                    ) : (
                      <p className="small muted">
                        No audited peers in the same category yet. Competitor analysis runs for prospects scoring 50+, comparing against other businesses
                        we have audited ourselves.
                      </p>
                    )}

                    <SectionHead title="Sources" hint="Every factual claim, attributed" />
                    <Card tight>
                      {sources.length ? (
                        <table className="table table-compact">
                          <thead>
                            <tr>
                              <th>Claim</th>
                              <th>Source</th>
                              <th className="num">Confidence</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sources.slice(0, 20).map((s) => (
                              <tr key={s.id}>
                                <td className="small">{s.field === '*' ? `Business record (${s.value ?? business.name})` : `${s.field}: ${s.value ?? ''}`}</td>
                                <td className="small muted">
                                  {s.source_url ? (
                                    <a href={s.source_url} target="_blank" rel="noreferrer">
                                      {s.provider_key}
                                    </a>
                                  ) : (
                                    s.provider_key
                                  )}
                                </td>
                                <td className="num small">{Math.round(s.confidence * 100)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="small muted" style={{ padding: 12 }}>
                          No source attribution yet.
                        </p>
                      )}
                    </Card>

                    {intel?.unverifiedClaims && intel.unverifiedClaims.length > 0 && (
                      <div className="mt-2">
                        <Card title="Not established from available data" sub="Listed rather than guessed">
                          <ul className="col" style={{ gap: 4 }}>
                            {intel.unverifiedClaims.map((c, i) => (
                              <li key={i} className="small muted">
                                • {c}
                              </li>
                            ))}
                          </ul>
                        </Card>
                      </div>
                    )}

                    <SectionHead title="Ask Forge AI about this business" />
                    <Card>
                      <InlineForm action={F.formAskQuestion} submitLabel="Ask">
                        <input type="hidden" name="id" value={id} />
                        <input className="input" name="q" placeholder="e.g. What would stop them buying?" required />
                      </InlineForm>
                    </Card>
                  </>
                ),
              },
              {
                key: 'audit',
                label: 'Audit',
                content: (
                  <>
                    {audit ? (
                      <>
                        <SectionHead
                          title="Website audit"
                          hint={audit.verified === 1 ? 'Verified by live fetch' : 'No live fetch — simulated or no website'}
                          right={<ActionButton action={A.auditBusinessAction} args={[id]} label="Re-run" />}
                        />
                        <Stats
                          items={[
                            { label: 'Website', value: audit.website_score ?? '—' },
                            { label: 'SEO', value: audit.seo_score ?? '—' },
                            { label: 'Conversion', value: audit.conversion_score ?? '—' },
                            { label: 'Performance', value: audit.performance_score ?? '—' },
                            { label: 'Accessibility', value: audit.accessibility_score ?? '—' },
                            { label: 'Trust', value: audit.trust_score ?? '—' },
                          ]}
                        />

                        {intel && (intel.signals.length > 0 || growth.signals.length > 0) && (
                          <>
                            <SectionHead title="Measured signals" />
                            <Card tight>
                              <table className="table table-compact">
                                <thead>
                                  <tr>
                                    <th>Severity</th>
                                    <th>Finding</th>
                                    <th>Evidence</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {intel.website.map((s) => (
                                    <tr key={s.key}>
                                      <td>
                                        <Badge tone={s.severity === 'critical' ? 'critical' : s.severity === 'high' ? 'warning' : ''}>{s.severity}</Badge>
                                      </td>
                                      <td className="small strong">{s.label}</td>
                                      <td className="small muted">{s.evidence}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </Card>
                          </>
                        )}

                        <SectionHead title="Improvement report" />
                        <div className="grid grid-3">
                          <Card title="Critical issues">
                            <ImprovementList items={JSON.parse(String(audit.critical_issues ?? '[]')) as string[]} empty="None detected." />
                          </Card>
                          <Card title="High-impact improvements">
                            <ImprovementList items={JSON.parse(String(audit.high_impact ?? '[]')) as string[]} empty="None detected." />
                          </Card>
                          <Card title="Nice to have">
                            <ImprovementList items={JSON.parse(String(audit.nice_to_have ?? '[]')) as string[]} empty="None detected." />
                          </Card>
                        </div>

                        <SectionHead title="Measured details" />
                        <Card>
                          <KeyValue
                            items={[
                              { label: 'HTTP status', value: audit.http_status },
                              { label: 'Response time', value: audit.response_ms ? `${audit.response_ms}ms` : null },
                              { label: 'SSL', value: audit.ssl_valid === 1 ? `Valid${audit.ssl_issuer ? ` (${audit.ssl_issuer})` : ''}` : audit.ssl_valid === 0 ? 'Invalid or missing' : 'Unknown' },
                              { label: 'Mobile responsive', value: audit.mobile_responsive === 1 ? 'Yes' : audit.mobile_responsive === 0 ? 'No — no viewport meta' : 'Unknown' },
                              { label: 'Title', value: audit.title },
                              { label: 'Meta description', value: audit.meta_description },
                              { label: 'Headings', value: `${audit.h1_count ?? 0} H1, ${audit.h2_count ?? 0} H2` },
                              { label: 'Words', value: audit.word_count },
                              { label: 'Pages linked', value: audit.page_count_est },
                              { label: 'Forms / CTAs', value: `${audit.form_count ?? 0} form(s), ${audit.cta_count ?? 0} CTA(s)` },
                              { label: 'Booking', value: audit.has_booking === 1 ? 'Detected' : 'Not detected' },
                              { label: 'Schema markup', value: audit.has_schema_markup === 1 ? 'Present' : 'Missing' },
                              { label: 'Images missing alt', value: audit.images_missing_alt !== null ? `${audit.images_missing_alt} of ${audit.image_count}` : null },
                            ]}
                          />
                        </Card>
                      </>
                    ) : (
                      <EmptyState
                        title="No audit yet"
                        body="The audit fetches the site and measures it: TLS, response time, metadata, heading structure, forms, CTAs, accessibility and trust signals. Without a website the audit records that as the finding."
                        action={<ActionButton action={A.auditBusinessAction} args={[id]} label="Run audit" variant="primary" size="md" />}
                      />
                    )}

                    {socialAudit && (
                      <>
                        <SectionHead title="Social audit" hint={`Score ${socialAudit.social_score}/100`} />
                        <Card>
                          <KeyValue
                            items={[
                              { label: 'Channels', value: `${socialAudit.platform_count} (${socialAudit.active_platforms} active)` },
                              { label: 'Cadence', value: socialAudit.posting_frequency },
                              { label: 'Profile completeness', value: `${socialAudit.profile_completeness}%` },
                              { label: 'Growth opportunity', value: socialAudit.growth_opportunity },
                            ]}
                          />
                          <div className="mt-2">
                            <div className="xsmall muted mb-1">Content gaps</div>
                            <ul className="col" style={{ gap: 4 }}>
                              {(JSON.parse(String(socialAudit.content_gaps ?? '[]')) as string[]).map((g, i) => (
                                <li key={i} className="small">
                                  • {g}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </Card>
                      </>
                    )}
                  </>
                ),
              },
              {
                key: 'outreach',
                label: 'Outreach',
                content: (
                  <>
                    <SectionHead title="Engagement" right={<ActionButton action={A.generateOutreachAction} args={[id]} label="Draft new message" variant="primary" />} />
                    {messages.length === 0 ? (
                      <EmptyState title="No outreach yet" body="Drafts are generated from this business's real audit findings — never generic filler." action={<ActionButton action={A.generateOutreachAction} args={[id]} label="Draft first message" variant="primary" />} />
                    ) : (
                      <div className="col">
                        {messages.map((m) => (
                          <Card key={m.id} title={`${m.direction === 'inbound' ? 'Reply' : 'Outbound'} · ${m.channel}`} sub={relativeDateTime(m.created_at as string)}>
                            {m.subject && <div className="small strong mb-1">{String(m.subject)}</div>}
                            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: 0 }}>{String(m.body)}</pre>
                            <div className="row-wrap mt-2">
                              <Badge tone={m.status === 'replied' ? 'success' : m.status === 'draft' ? '' : 'accent'}>{String(m.status)}</Badge>
                              {m.simulated === 1 && <Badge tone="warning">simulated — no provider connected</Badge>}
                              {String(m.tone) && <Badge tone="outline">{String(m.tone).replace('_', ' ')}</Badge>}
                              {m.status === 'draft' && (
                                <>
                                  <ActionButton action={A.approveSendAction} args={[m.id as string]} label="Approve & send" variant="primary" />
                                  <ActionButton action={A.rejectDraftAction} args={[m.id as string]} label="Reject" variant="danger" />
                                </>
                              )}
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}

                    <SectionHead title="Record a reply" hint="Stops the sequence automatically" />
                    <Card>
                      <InlineForm action={F.formRecordReply} submitLabel="Record reply">
                        <input type="hidden" name="id" value={id} />
                        <textarea className="textarea" name="body" placeholder="Paste their reply…" required />
                      </InlineForm>
                    </Card>
                  </>
                ),
              },
              {
                key: 'concept',
                label: 'Concept',
                content: mockup ? (
                  <>
                    <SectionHead
                      title={`ClientForge Concept — ${mockup.title}`}
                      hint={`${mockup.design_direction} direction · v${mockup.current_version}`}
                      right={<Badge tone={mockup.status === 'viewed' ? 'success' : 'accent'}>{mockup.status}</Badge>}
                    />
                    <Stats
                      items={[
                        { label: 'Views', value: mockup.view_count },
                        { label: 'Unique viewers', value: mockup.unique_viewers },
                        { label: 'Returning', value: mockup.returning_viewers },
                        { label: 'Intent', value: Math.round(mockup.intent_score), tone: mockup.intent_score > 60 ? 'critical' : undefined },
                        { label: 'First viewed', value: mockup.first_viewed_at ? relativeFromNow(mockup.first_viewed_at) : '—' },
                      ]}
                    />
                    <div className="mt-2">
                      <Card title="Edit the concept" sub="Describe the change — every edit creates a new version">
                        <ConceptEditor mockupId={mockup.id} versions={versions} shareUrl={`/mockup/${mockup.share_token}`} />
                      </Card>
                    </div>
                    <div className="mt-2">
                      <Card title="Pitch kit" sub="Generated from the concept and the audit">
                        <PitchKit kit={JSON.parse(mockup.pitch_kit || '{}')} />
                      </Card>
                    </div>
                    <div className="mt-2">
                      <iframe
                        src={`/mockup/${mockup.share_token}`}
                        title="Concept preview"
                        style={{ width: '100%', height: 640, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
                      />
                    </div>
                  </>
                ) : (
                  <EmptyState
                    title="No website concept yet"
                    body="ClientForge builds a full concept from this business's real record — services, reputation, contact routes. Missing facts are flagged for review rather than invented, and the design direction is derived from the business rather than picked from a template library."
                    action={<ActionButton action={A.generateConceptAction} args={[id]} label="Generate website concept" variant="primary" size="md" />}
                  />
                ),
              },
              {
                key: 'calls',
                label: 'Calls',
                content: (
                  <>
                    <SectionHead title="Calls" />
                    {calls.length === 0 ? (
                      <EmptyState title="No calls scheduled" body="Schedule a call and ClientForge generates the briefing automatically." />
                    ) : (
                      <div className="col">
                        {calls.map((c) => (
                          <Card key={c.id} title={c.title} sub={`${formatDateTime(c.scheduled_at)} · ${c.duration_min} min`} actions={<Badge tone={c.status === 'completed' ? 'success' : 'accent'}>{c.status}</Badge>}>
                            {c.ai_summary && (
                              <div className="ai-panel mb-2" style={{ padding: 10 }}>
                                <AiTag />
                                <p className="small mt-1">{c.ai_summary}</p>
                              </div>
                            )}
                            <KeyValue
                              items={[
                                { label: 'Budget', value: c.budget },
                                { label: 'Decision maker', value: c.decision_maker },
                                { label: 'Outcome', value: c.outcome },
                                { label: 'Requirements', value: JSON.parse(c.requirements || '[]').length ? JSON.parse(c.requirements || '[]').join('; ') : null },
                                { label: 'Objections', value: JSON.parse(c.objections || '[]').length ? JSON.parse(c.objections || '[]').join('; ') : null },
                              ]}
                            />
                            <div className="row-wrap mt-2">
                              <ActionButton action={A.summarizeCallAction} args={[c.id]} label="Summarise notes" />
                              <ActionButton action={A.generateBriefingAction} args={[id, c.id]} label="Generate briefing" />
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}
                    <SectionHead title="Schedule a call" />
                    <Card>
                      <InlineForm
                        action={F.formScheduleCall}
                        submitLabel="Schedule & generate briefing"
                      >
                        <input type="hidden" name="id" value={id} />
                        <input className="input" type="datetime-local" name="when" required />
                        <input className="input" name="title" placeholder="Call title (optional)" />
                        <select className="select" name="duration" defaultValue="30">
                          {[15, 30, 45, 60].map((d) => (
                            <option key={d} value={d}>
                              {d} minutes
                            </option>
                          ))}
                        </select>
                      </InlineForm>
                    </Card>
                  </>
                ),
              },
              {
                key: 'proposal',
                label: 'Proposal',
                content: (
                  <>
                    <SectionHead title="Proposals" right={<ActionButton action={A.generateProposalAction} args={[id, { callId: calls.find((c) => c.status === 'completed')?.id }]} label="Draft proposal" variant="primary" />} />
                    {proposals.length === 0 ? (
                      <EmptyState title="No proposal yet" body="Proposals are built from the audit and the call notes — problem, scope, deliverables, timeline and pricing." />
                    ) : (
                      <div className="col">
                        {proposals.map((p) => (
                          <Card key={p.id} title={`${p.number} — ${p.title}`} sub={`$${Number(p.total).toFixed(2)}${p.recurring_total ? ` + $${p.recurring_total}/mo` : ''}`} actions={<Badge tone={p.status === 'accepted' ? 'success' : p.status === 'rejected' ? 'critical' : 'accent'}>{p.status}</Badge>}>
                            <div className="grid grid-2">
                              <div>
                                <div className="xsmall muted">Problem</div>
                                <p className="small">{p.problem}</p>
                              </div>
                              <div>
                                <div className="xsmall muted">Solution</div>
                                <p className="small">{p.solution}</p>
                              </div>
                            </div>
                            <div className="row-wrap mt-2">
                              {p.status === 'draft' && <ActionButton action={A.sendProposalAction} args={[p.id]} label="Send proposal" variant="primary" />}
                              {['sent', 'viewed'].includes(p.status) && (
                                <>
                                  <ActionButton action={A.respondProposalAction} args={[p.id, 'accepted']} label="Mark accepted" variant="primary" />
                                  <ActionButton action={A.respondProposalAction} args={[p.id, 'rejected']} label="Mark rejected" variant="danger" />
                                  <ActionButton action={A.requestDepositAction} args={[p.id]} label="Request deposit" />
                                </>
                              )}
                              <Badge tone="outline">signature: {p.signature_status}</Badge>
                              <Badge tone="outline">payment: {p.payment_status}</Badge>
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: 'project',
                label: 'Project',
                content: projects.length ? (
                  <div className="col">
                    {projects.map((p) => (
                      <Card key={p.id} title={p.name} sub={`${p.stage.replace(/_/g, ' ')} · ${p.progress}%`} actions={<Badge tone={p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : 'success'}>{p.health}</Badge>}>
                        <Bar value={p.progress} tone={p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : undefined} />
                        <div className="mt-2">
                          <Link href={`/projects/${p.id}`} className="btn btn-sm">
                            Open project
                          </Link>
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No delivery project"
                    body="Projects are created automatically when a prospect converts to a client — with tasks, owners, due dates and dependencies already laid out."
                    action={<ActionButton action={A.convertToClientAction} args={[id, proposals[0]?.id]} label="Convert to client" variant="primary" />}
                  />
                ),
              },
              {
                key: 'activity',
                label: 'Activity',
                content: (
                  <>
                    <SectionHead title="Activity" hint="Everything, in order" />
                    {activity.length === 0 ? (
                      <EmptyState title="No activity yet" />
                    ) : (
                      <Card>
                        <div className="timeline">
                          {activity.map((a) => (
                            <div className="timeline-item" key={a.id}>
                              <span className={`timeline-dot ${a.importance === 'critical' ? 'critical' : a.actor === 'ai' ? 'ai' : a.actor === 'client' ? 'success' : ''}`}>
                                ●
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div className="timeline-when">{relativeDateTime(a.created_at)}</div>
                                <div className="timeline-what">{a.title}</div>
                                {a.detail && <div className="timeline-detail">{a.detail}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </Card>
                    )}
                  </>
                ),
              },
            ]}
          />
        </div>

        {/* ── Right rail: AI recommendations (§60) ───────────── */}
        <aside className="col">
          <Card title={<span className="row"><AiTag /></span>} sub="Recommended next actions">
            {nba ? (
              <div className="col" style={{ gap: 10 }}>
                <div className="ai-panel" style={{ padding: 10 }}>
                  <div className="small strong">{nba.label}</div>
                  <div className="xsmall muted mt-1">{nba.reason}</div>
                  <div className="xsmall muted mt-1">By {relativeFromNow(nba.dueAt)}</div>
                </div>
                {nba.alternatives.map((alt, i) => (
                  <div key={i} className="small">
                    <div className="strong">{alt.label}</div>
                    <div className="xsmall muted">{alt.reason}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">No recommendation yet.</p>
            )}
          </Card>

          {score && (
            <Card title="Score breakdown" sub="Weighted factors">
              <ul className="col" style={{ gap: 8 }}>
                {score.breakdown.map((b) => (
                  <li key={b.key}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                      <span>{b.label}</span>
                      <span className="mono">
                        {b.score} × {Math.round(b.weight * 100)}%
                      </span>
                    </div>
                    <Bar value={b.score} />
                    {b.evidence.length > 0 && <div className="xsmall muted mt-1">{b.evidence[0]}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {memories.length > 0 && (
            <Card title="What ClientForge remembers" sub="Business-level memory">
              <ul className="col" style={{ gap: 5 }}>
                {memories.slice(0, 12).map((m) => (
                  <li key={m.id} className="xsmall">
                    <span className="badge outline">{m.kind}</span> <span className="muted-2">{m.key}:</span> {m.value}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Add a memory" sub="Facts Forge AI must not contradict">
            <InlineForm action={F.formAddMemory} submitLabel="Remember">
              <input type="hidden" name="id" value={id} />
              <select className="select" name="kind" defaultValue="fact">
                {['fact', 'preference', 'objection', 'commitment'].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input className="input" name="key" placeholder="key, e.g. budget" required />
              <input className="input" name="value" placeholder="value" required />
            </InlineForm>
          </Card>
        </aside>
      </div>
    </>
  );
}

function ImprovementList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="small muted">{empty}</p>;
  return (
    <ul className="col" style={{ gap: 5 }}>
      {items.map((i, idx) => (
        <li key={idx} className="small">
          • {i}
        </li>
      ))}
    </ul>
  );
}

function PitchKit({ kit }: { kit: Record<string, unknown> }) {
  if (!kit || !kit.email) return <p className="small muted">Pitch kit not generated yet.</p>;
  const email = kit.email as { subjectLines: string[]; body: string };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div>
        <div className="xsmall muted">Value proposition</div>
        <p className="small">{String(kit.valueProposition ?? '')}</p>
      </div>
      <div>
        <div className="xsmall muted">Suggested subject lines</div>
        <ul className="col" style={{ gap: 3 }}>
          {(email.subjectLines ?? []).map((s, i) => (
            <li key={i} className="small">
              • {s}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="xsmall muted">Email</div>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, background: 'var(--surface-2)', padding: 10, borderRadius: 4, margin: '4px 0 0' }}>
          {email.body}
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
  );
}
