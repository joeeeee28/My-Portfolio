import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listPosts, contentCalendar, listApprovals, listAccounts, listCampaigns, socialAnalytics } from '@/engine/social';
import { listClients } from '@/engine/crm';
import { json } from '@/db';
import { relativeFromNow, formatDate } from '@/lib/time';
import { Card, Badge, EmptyState, SectionHead, Stats, Table, AiTag } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Share2 } from 'lucide-react';

export const metadata = { title: 'Social Workspace' };
export const dynamic = 'force-dynamic';

export default async function SocialPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const orgId = boot();
  await getSession();
  const sp = await searchParams;
  const clients = listClients(orgId, { limit: 50 });
  const selected = sp.client ? clients.find((c) => c.id === sp.client) : clients[0];

  const posts = listPosts(orgId, { clientId: selected?.id, limit: 200 });
  const calendar = selected ? contentCalendar(orgId, selected.id, 30) : null;
  const approvals = listApprovals(orgId, { clientId: selected?.id });
  const accounts = selected ? listAccounts(orgId, selected.id) : [];
  const campaigns = selected ? listCampaigns(orgId, selected.id) : [];
  const analytics = selected ? socialAnalytics(orgId, selected.id) : null;

  return (
    <>
      <div className="mb-2">
        <h1>Social Workspace</h1>
        <p className="small muted">
          Content generated from the client&apos;s real business record — their services, their reputation, their category. Nothing invented, and
          nothing publishes without an approval and a connected provider.
        </p>
      </div>

      {clients.length === 0 ? (
        <EmptyState
          icon={<Share2 size={17} />}
          title="No clients yet"
          body="The Social Workspace is for delivered clients. Convert a prospect first and the workspace appears here."
          action={
            <Link href="/pipeline" className="btn btn-primary">
              Go to Client Pipeline
            </Link>
          }
        />
      ) : (
        <>
          <div className="row-wrap mb-2">
            {clients.map((c) => (
              <Link key={c.id} href={`/social?client=${c.id}`} className={`chip${selected?.id === c.id ? ' active' : ''}`}>
                {c.business_name}
              </Link>
            ))}
          </div>

          {selected && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <h2>{selected.business_name}</h2>
                <div className="spacer" />
                <ActionButton action={A.generateContentPlanAction} args={[selected.id, { posts: 8 }]} label="Generate content plan" variant="primary" />
              </div>

              {analytics && (
                <Stats
                  items={[
                    { label: 'Posts', value: analytics.total },
                    { label: 'Channels', value: analytics.accounts },
                    { label: 'Awaiting approval', value: posts.filter((p) => p.status === 'client_review').length, tone: 'warning' },
                    { label: 'Scheduled', value: posts.filter((p) => p.status === 'scheduled' || p.status === 'approved').length },
                    { label: 'Published', value: posts.filter((p) => p.status === 'published').length, tone: 'success' },
                    { label: 'Impressions', value: analytics.totalImpressions },
                  ]}
                />
              )}

              <div className="grid grid-main mt-3">
                <div className="col">
                  <SectionHead title="Content calendar" hint="Next 30 days" />
                  {calendar && Object.keys(calendar.byDay).length > 0 ? (
                    <Card tight>
                      <Table
                        head={[{ label: 'Date' }, { label: 'Platform' }, { label: 'Format' }, { label: 'Caption' }, { label: 'Status' }, { label: '' }]}
                      >
                        {Object.entries(calendar.byDay)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .flatMap(([day, dayPosts]) =>
                            (dayPosts as typeof posts).map((p) => (
                              <tr key={p.id}>
                                <td className="small nowrap">{formatDate(`${day}T00:00:00Z`)}</td>
                                <td className="small">{p.platform}</td>
                                <td>
                                  <Badge tone="outline">{p.format}</Badge>
                                </td>
                                <td className="small" style={{ maxWidth: 380 }}>
                                  <div className="truncate">{p.caption}</div>
                                  {p.ai_generated === 1 && <AiTag />}
                                </td>
                                <td>
                                  <Badge
                                    tone={
                                      p.status === 'published'
                                        ? 'success'
                                        : p.status === 'client_review'
                                          ? 'warning'
                                          : p.status === 'rejected'
                                            ? 'critical'
                                            : 'accent'
                                    }
                                  >
                                    {p.status.replace(/_/g, ' ')}
                                  </Badge>
                                </td>
                                <td>
                                  {['approved', 'scheduled'].includes(p.status) && <ActionButton action={A.publishPostAction} args={[p.id]} label="Publish" />}
                                </td>
                              </tr>
                            ))
                          )}
                      </Table>
                    </Card>
                  ) : (
                    <EmptyState
                      title="No content scheduled"
                      body="Generate a content plan and ClientForge writes posts from the client's real record — services on file, reputation, category. Anything it cannot support is left as a marked placeholder."
                      action={<ActionButton action={A.generateContentPlanAction} args={[selected.id, { posts: 8 }]} label="Generate content plan" variant="primary" />}
                    />
                  )}

                  <SectionHead title="All posts" />
                  {posts.length === 0 ? (
                    <EmptyState title="No posts yet" />
                  ) : (
                    <div className="col">
                      {posts.slice(0, 12).map((p) => (
                        <Card
                          key={p.id}
                          title={`${p.platform} · ${p.format}`}
                          sub={`${p.scheduled_for ? formatDate(p.scheduled_for) : 'unscheduled'} · ${p.status.replace(/_/g, ' ')}`}
                          actions={p.ai_generated === 1 ? <AiTag /> : undefined}
                        >
                          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
                            {p.caption}
                          </p>
                          {p.hashtags.length > 0 && (
                            <div className="row-wrap mt-1">
                              {p.hashtags.map((h) => (
                                <span key={h} className="xsmall muted">
                                  #{h}
                                </span>
                              ))}
                            </div>
                          )}
                          {p.creative_brief && <p className="xsmall muted mt-1">Brief: {p.creative_brief}</p>}
                          {p.grounded_in.length > 0 && (
                            <div className="row-wrap mt-1">
                              <span className="xsmall muted">Grounded in:</span>
                              {p.grounded_in.map((g, i) => (
                                <span key={i} className="chip">
                                  {g}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="row-wrap mt-2">
                            <Badge
                              tone={
                                p.status === 'published'
                                  ? 'success'
                                  : p.status === 'client_review'
                                    ? 'warning'
                                    : p.status === 'rejected'
                                      ? 'critical'
                                      : 'accent'
                              }
                            >
                              {p.status.replace(/_/g, ' ')}
                            </Badge>
                            {p.simulated === 1 && <Badge tone="warning">outbox — no provider connected</Badge>}
                            <span className="spacer" />
                            <ActionButton action={A.resolveApprovalAction} args={[approvals.find((a) => a.ref_id === p.id)?.id ?? '', 'approved']} label="Approve" />
                            <ActionButton action={A.publishPostAction} args={[p.id]} label="Publish" variant="primary" />
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>

                <aside className="col">
                  <Card title="Connected channels">
                    {accounts.length === 0 ? (
                      <p className="small muted">No channels connected. Add them in Settings → Integrations, or record the handles manually.</p>
                    ) : (
                      <ul className="col" style={{ gap: 6 }}>
                        {accounts.map((a) => (
                          <li key={a.id} className="row" style={{ justifyContent: 'space-between' }}>
                            <span className="small">{a.platform}</span>
                            <span className="xsmall muted">@{a.handle}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card title="Approvals" sub="Draft → Client Review → Approved → Scheduled → Published">
                    {approvals.length === 0 ? (
                      <p className="small muted">Nothing awaiting approval.</p>
                    ) : (
                      <ul className="col" style={{ gap: 8 }}>
                        {approvals.map((a) => (
                          <li key={a.id}>
                            <div className="small strong">{String(a.title)}</div>
                            <div className="xsmall muted">{String(a.kind)} · {relativeFromNow(a.requested_at as string)}</div>
                            <div className="row-wrap mt-1">
                              <Badge tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'critical' : 'warning'}>{String(a.status)}</Badge>
                              {a.status === 'pending' && (
                                <>
                                  <ActionButton action={A.resolveApprovalAction} args={[a.id as string, 'approved']} label="Approve" />
                                  <ActionButton action={A.resolveApprovalAction} args={[a.id as string, 'revision']} label="Request revision" />
                                </>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  {campaigns.length > 0 && (
                    <Card title="Campaigns">
                      <ul className="col" style={{ gap: 6 }}>
                        {campaigns.map((c) => (
                          <li key={c.id} className="row" style={{ justifyContent: 'space-between' }}>
                            <span className="small">{String(c.name)}</span>
                            <Badge>{String(c.status)}</Badge>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                </aside>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
