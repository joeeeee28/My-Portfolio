import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listProposals } from '@/engine/crm';
import { all, json } from '@/db';
import { relativeFromNow, formatDateTime } from '@/lib/time';
import { round } from '@/lib/id';
import { Card, Badge, EmptyState, SectionHead, Stats, Table } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { FileText } from 'lucide-react';

export const metadata = { title: 'Proposals' };
export const dynamic = 'force-dynamic';

export default async function ProposalsPage() {
  const orgId = boot();
  await getSession();
  const proposals = listProposals(orgId, { limit: 100 });

  const awaiting = proposals.filter((p) => ['sent', 'viewed'].includes(p.status));
  const accepted = proposals.filter((p) => p.status === 'accepted');
  const wonValue = accepted.reduce((a, p) => a + Number(p.total), 0);
  const recurring = accepted.reduce((a, p) => a + Number(p.recurring_total ?? 0), 0);

  return (
    <>
      <div className="mb-2">
        <h1>Proposals</h1>
        <p className="small muted">
          Built from the audit and the call notes. Signature and payment are integration-ready — without a provider configured the status stays
          honestly at “not configured” rather than pretending something was signed or paid.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Drafts', value: proposals.filter((p) => p.status === 'draft').length },
          { label: 'Awaiting response', value: awaiting.length, tone: awaiting.length > 0 ? 'warning' : undefined },
          { label: 'Accepted', value: accepted.length, tone: 'success' },
          { label: 'Won value', value: `$${round(wonValue, 0).toLocaleString()}` },
          { label: 'Recurring', value: `$${round(recurring, 0)}/mo` },
        ]}
      />

      {proposals.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<FileText size={17} />}
            title="No proposals yet"
            body="Generate one from any prospect's workspace. If a call has been completed, the requirements from the notes are carried straight into the scope."
            action={
              <Link href="/prospects" className="btn btn-primary">
                Go to Prospect Hub
              </Link>
            }
          />
        </div>
      ) : (
        <div className="col">
          {proposals.map((p) => {
            const items = p.items as { id: string; name: string; description: string | null; kind: string; unit_price: number; interval: string | null; total: number }[];
            return (
              <Card
                key={p.id}
                title={`${p.number} — ${p.business_name}`}
                sub={`${formatDateTime(p.created_at)}${p.sent_at ? ` · sent ${relativeFromNow(p.sent_at)}` : ''}`}
                actions={
                  <Badge
                    tone={
                      p.status === 'accepted' ? 'success' : p.status === 'rejected' ? 'critical' : p.status === 'draft' ? '' : 'accent'
                    }
                    dot
                  >
                    {p.status}
                  </Badge>
                }
              >
                <div className="grid grid-2 mb-2">
                  <div>
                    <div className="xsmall muted">Problem</div>
                    <p className="small">{p.problem}</p>
                  </div>
                  <div>
                    <div className="xsmall muted">Solution</div>
                    <p className="small">{p.solution}</p>
                  </div>
                </div>

                <Table
                  compact
                  head={[{ label: 'Item' }, { label: 'Type' }, { label: 'Amount', align: 'right' }]}
                >
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="small">
                        {i.name}
                        {i.description && <div className="xsmall muted">{i.description}</div>}
                      </td>
                      <td>
                        <Badge tone={i.kind === 'recurring' ? 'accent' : ''}>{i.kind.replace('_', ' ')}</Badge>
                      </td>
                      <td className="num small">
                        ${Number(i.unit_price).toFixed(2)}
                        {i.interval ? `/${i.interval}` : ''}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="strong small">Total</td>
                    <td />
                    <td className="num strong">
                      ${Number(p.total).toFixed(2)}
                      {p.recurring_total ? ` + $${p.recurring_total}/mo` : ''}
                    </td>
                  </tr>
                </Table>

                <div className="grid grid-2 mt-2">
                  <div>
                    <div className="xsmall muted">Timeline</div>
                    <p className="small">{p.timeline}</p>
                  </div>
                  <div>
                    <div className="xsmall muted">Views</div>
                    <p className="small">
                      {p.view_count} {p.last_viewed_at ? `· last ${relativeFromNow(p.last_viewed_at)}` : ''}
                    </p>
                  </div>
                </div>

                <div className="row-wrap mt-2">
                  <Badge tone="outline">signature: {p.signature_status}</Badge>
                  <Badge tone="outline">payment: {p.payment_status}</Badge>
                  {p.deposit_amount ? <Badge tone="outline">deposit: ${Number(p.deposit_amount).toFixed(2)}</Badge> : null}
                  <span className="spacer" />
                  {p.status === 'draft' && (
                    <>
                      <Link href={`/proposals/${p.id}`} className="btn btn-sm">
                        Review
                      </Link>
                      <ActionButton action={A.sendProposalAction} args={[p.id]} label="Send proposal" variant="primary" />
                    </>
                  )}
                  {['sent', 'viewed'].includes(p.status) && (
                    <>
                      <ActionButton action={A.requestDepositAction} args={[p.id]} label="Request deposit" />
                      <ActionButton
                        action={A.respondProposalAction} args={[p.id, 'accepted']}
                        label="Mark accepted → convert"
                        variant="primary"
                        confirm="Mark accepted? This converts the prospect into a client and opens a delivery project, reusing the existing record."
                      />
                      <ActionButton action={A.respondProposalAction} args={[p.id, 'rejected']} label="Mark rejected" variant="danger" />
                    </>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
