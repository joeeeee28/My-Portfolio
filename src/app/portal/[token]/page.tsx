import { notFound } from 'next/navigation';
import { boot } from '@/lib/boot';
import { getClientByToken, listProjects, listTasks, listProposals } from '@/engine/crm';
import { listPosts, listApprovals } from '@/engine/social';
import { getMockupForBusiness } from '@/engine/mockup';
import { all } from '@/db';
import { getBusiness } from '@/repo/business';
import { relativeFromNow, formatDate } from '@/lib/time';
import { PROJECT_STAGE_LABELS, type ProjectStage } from '@/lib/domain';
import { Card, Badge, Stats, Bar, SectionHead, EmptyState, KeyValue, Table } from '@/components/ui';
import { ClientApprovalButtons } from '@/components/actions-client';

export const metadata = { title: 'Client Portal' };
export const dynamic = 'force-dynamic';

/**
 * Client-facing portal (§38). Deliberately separate from the internal CRM: no
 * scores, no pipeline, no internal notes — only what the client needs to act on.
 */
export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const orgId = boot();
  const { token } = await params;
  const client = getClientByToken(orgId, token);
  if (!client) notFound();

  const business = getBusiness(orgId, client.business_id);
  const projects = listProjects(orgId, { clientId: client.id });
  const tasks = projects.length ? listTasks(orgId, { projectId: projects[0].id }) : [];
  const awaitingInput = tasks.filter((t) => t.needs_client_input === 1 && t.status !== 'done');
  const approvals = listApprovals(orgId, { clientId: client.id, status: 'pending' });
  const posts = listPosts(orgId, { clientId: client.id, status: 'client_review', limit: 30 });
  const proposals = listProposals(orgId, { businessId: client.business_id });
  const mockup = getMockupForBusiness(orgId, client.business_id);
  const meetings = all<{ id: string; title: string; scheduled_at: string; status: string }>(
    "SELECT id, title, scheduled_at, status FROM calls WHERE business_id = ? AND status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 5",
    [client.business_id]
  );
  const invoices = all<{ id: string; kind: string; amount: number; currency: string; status: string; due_at: string | null }>(
    'SELECT id, kind, amount, currency, status, due_at FROM payments WHERE org_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 10',
    [orgId, client.id]
  );
  const deliverables = projects.length
    ? (projects[0].deliverables as unknown as string)
    : null;

  return (
    <div style={{ maxWidth: 1080 }}>
      <div className="mb-2">
        <h1>{business?.name ?? 'Your project'}</h1>
        <p className="small muted">
          Welcome to your portal. Everything that needs your input is at the top — the rest is here so you can see progress whenever you like.
        </p>
      </div>

      {/* ── Needs your input ───────────────────────────────── */}
      {awaitingInput.length > 0 || approvals.length > 0 || posts.length > 0 ? (
        <>
          <SectionHead title="Needs your input" hint={`${awaitingInput.length + approvals.length + posts.length} item(s)`} />
          <div className="col">
            {awaitingInput.map((t) => (
              <Card key={t.id as string} title={String(t.title)} sub={`Task · ${String(t.stage ?? '').replace(/_/g, ' ')}`} actions={<Badge tone="warning">waiting on you</Badge>}>
                {t.description && <p className="small">{String(t.description)}</p>}
                <p className="small muted mt-1">Due {t.due_at ? relativeFromNow(t.due_at as string) : '—'}</p>
              </Card>
            ))}

            {posts.map((p) => (
              <Card key={p.id} title="Content for your approval" sub={`${p.platform} · ${p.format} · ${p.scheduled_for ? formatDate(p.scheduled_for) : 'unscheduled'}`}>
                <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {p.caption}
                </p>
                <div className="row-wrap mt-2">
                  <ClientApprovalButtons approvalId={approvals.find((a) => a.ref_id === p.id)?.id as string | undefined} />
                </div>
              </Card>
            ))}

            {approvals
              .filter((a) => !posts.some((p) => p.id === a.ref_id))
              .map((a) => (
                <Card key={a.id as string} title={String(a.title)} sub={`${String(a.kind).replace(/_/g, ' ')} · requested ${relativeFromNow(a.requested_at as string)}`}>
                  {a.preview_url && (
                    <a href={String(a.preview_url)} target="_blank" rel="noreferrer" className="btn btn-sm mb-2">
                      Open preview
                    </a>
                  )}
                  <ClientApprovalButtons approvalId={a.id as string} />
                </Card>
              ))}
          </div>
        </>
      ) : (
        <EmptyState title="Nothing needs your input right now" body="We will let you know here as soon as something does." />
      )}

      {/* ── Project progress ───────────────────────────────── */}
      {projects.length > 0 && (
        <>
          <SectionHead title="Project progress" />
          {projects.map((p) => {
            const projectTasks = tasks.filter((t) => t.project_id === p.id);
            const done = projectTasks.filter((t) => t.status === 'done').length;
            return (
              <Card key={p.id} title={p.name} sub={`${PROJECT_STAGE_LABELS[p.stage as ProjectStage] ?? p.stage} · due ${p.due_at ? formatDate(p.due_at) : '—'}`}>
                <div className="row" style={{ gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <Bar value={p.progress} />
                  </div>
                  <span className="small mono">{p.progress}%</span>
                  <span className="xsmall muted">
                    {done}/{projectTasks.length} tasks complete
                  </span>
                </div>

                <div className="row-wrap mt-2">
                  {(Object.keys(PROJECT_STAGE_LABELS) as ProjectStage[]).map((stage) => {
                    const order = Object.keys(PROJECT_STAGE_LABELS);
                    const currentIdx = order.indexOf(p.stage as string);
                    const stageIdx = order.indexOf(stage);
                    return (
                      <span
                        key={stage}
                        className="chip"
                        style={stageIdx <= currentIdx ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' } : { opacity: 0.55 }}
                      >
                        {PROJECT_STAGE_LABELS[stage]}
                      </span>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </>
      )}

      {/* ── Website / concept ──────────────────────────────── */}
      {mockup && (
        <>
          <SectionHead title="Your website" />
          <Card title="Website preview" sub="The current version of your site">
            <iframe
              src={`/mockup/${mockup.share_token}`}
              title="Website preview"
              style={{ width: '100%', height: 620, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
            />
            <div className="row-wrap mt-2">
              <a href={`/mockup/${mockup.share_token}`} target="_blank" rel="noreferrer" className="btn btn-sm">
                Open in a new tab
              </a>
            </div>
          </Card>
        </>
      )}

      {/* ── Meetings ───────────────────────────────────────── */}
      {meetings.length > 0 && (
        <>
          <SectionHead title="Upcoming meetings" />
          <Card tight>
            <Table head={[{ label: 'Meeting' }, { label: 'When' }, { label: 'Status' }]}>
              {meetings.map((m) => (
                <tr key={m.id}>
                  <td className="small">{m.title}</td>
                  <td className="small">{formatDate(m.scheduled_at)}</td>
                  <td>
                    <Badge tone="accent">{m.status}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}

      {/* ── Proposals & invoices ───────────────────────────── */}
      {(proposals.length > 0 || invoices.length > 0) && (
        <>
          <SectionHead title="Proposals & payments" />
          <div className="grid grid-2">
            {proposals.length > 0 && (
              <Card title="Proposals" tight>
                <Table compact head={[{ label: 'Reference' }, { label: 'Total', align: 'right' }, { label: 'Status' }]}>
                  {proposals.map((p) => (
                    <tr key={p.id}>
                      <td className="small">{p.number}</td>
                      <td className="num small">${Number(p.total).toFixed(2)}</td>
                      <td>
                        <Badge tone={p.status === 'accepted' ? 'success' : p.status === 'rejected' ? 'critical' : 'accent'}>{p.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
            {invoices.length > 0 && (
              <Card title="Invoices" tight>
                <Table compact head={[{ label: 'Type' }, { label: 'Amount', align: 'right' }, { label: 'Status' }, { label: 'Due' }]}>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td className="small">{i.kind}</td>
                      <td className="num small">
                        {i.currency} {Number(i.amount).toFixed(2)}
                      </td>
                      <td>
                        <Badge tone={i.status === 'paid' ? 'success' : i.status === 'failed' ? 'critical' : 'warning'}>{i.status}</Badge>
                      </td>
                      <td className="xsmall muted">{i.due_at ? formatDate(i.due_at) : '—'}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
          <p className="xsmall muted mt-1">
            Payment status is shown only where a payment provider is connected. Nothing is marked paid unless a provider has confirmed it.
          </p>
        </>
      )}
    </div>
  );
}
