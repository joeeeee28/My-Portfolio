import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listMessages, outreachStats } from '@/engine/outreach';
import { relativeFromNow, relativeDateTime } from '@/lib/time';
import { round } from '@/lib/id';
import { Card, Badge, EmptyState, SectionHead, Stats, Table } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Outreach' };
export const dynamic = 'force-dynamic';

export default async function OutreachPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const orgId = boot();
  await getSession();
  const sp = await searchParams;
  const status = sp.status;

  const stats = outreachStats(orgId);
  const messages = listMessages(orgId, { status, limit: 120 });
  const drafts = messages.filter((m) => ['draft', 'queued', 'approved'].includes(String(m.status)));

  return (
    <>
      <div className="mb-2">
        <h1>Outreach</h1>
        <p className="small muted">
          Every message is generated from this prospect&apos;s own audit findings. Nothing here is generic filler, and nothing sends without passing
          the compliance gate.
        </p>
      </div>

      {stats.simulated > 0 && (
        <div className="mb-2">
          <div className="banner warning">
            <span className="banner-icon">
              <AlertTriangle size={15} />
            </span>
            <div>
              <strong>{stats.simulated} message(s) were queued in the local outbox.</strong> No email provider is connected, so nothing was actually
              sent. Add Resend or SendGrid in Settings → Integrations to send for real.
            </div>
          </div>
        </div>
      )}

      <Stats
        items={[
          { label: 'Sent', value: stats.sent, href: '/outreach?status=sent' },
          { label: 'Drafts awaiting approval', value: stats.drafts, href: '/outreach?status=draft', tone: stats.drafts > 0 ? 'warning' : undefined },
          { label: 'Opened', value: stats.opened, detail: `${stats.openRate}% open rate` },
          { label: 'Replies', value: stats.replied, detail: `${stats.replyRate}% reply rate`, tone: stats.replied > 0 ? 'success' : undefined },
          { label: 'Bounced', value: stats.bounced, tone: stats.bounced > 0 ? 'critical' : undefined },
          { label: 'Cost', value: `$${round(stats.cost, 4)}` },
        ]}
      />

      <SectionHead
        title="Messages"
        right={
          <div className="row-wrap" style={{ gap: 6 }}>
            {['draft', 'sent', 'opened', 'replied', 'bounced'].map((s) => (
              <Link key={s} href={status === s ? '/outreach' : `/outreach?status=${s}`} className={`chip${status === s ? ' active' : ''}`}>
                {s}
              </Link>
            ))}
          </div>
        }
      />

      {messages.length === 0 ? (
        <EmptyState
          title={status ? `No ${status} messages` : 'No outreach yet'}
          body="Generate a draft from any prospect's workspace. ClientForge writes it from their measured findings — the specific problem, the evidence, and a single clear ask."
          action={
            <Link href="/prospects" className="btn btn-primary">
              Go to Prospect Hub
            </Link>
          }
        />
      ) : (
        <div className="col">
          {messages.map((m) => (
            <Card
              key={m.id as string}
              title={
                <span className="row" style={{ gap: 8 }}>
                  <Link href={`/prospects/${m.business_id}?tab=outreach`} style={{ color: 'var(--accent)' }}>
                    {String(m.business_name)}
                  </Link>
                  <Badge tone="outline">{String(m.channel)}</Badge>
                  <Badge tone={m.direction === 'inbound' ? 'success' : ''}>{String(m.direction)}</Badge>
                </span>
              }
              sub={`${relativeDateTime(m.created_at as string)} · ${String(m.tone ?? '').replace('_', ' ')} · ${String(m.purpose ?? '')}`}
              actions={
                <Badge
                  tone={
                    m.status === 'replied'
                      ? 'success'
                      : m.status === 'bounced' || m.status === 'failed'
                        ? 'critical'
                        : m.status === 'draft'
                          ? 'warning'
                          : 'accent'
                  }
                  dot
                >
                  {String(m.status)}
                </Badge>
              }
            >
              {m.subject && <div className="small strong mb-1">{String(m.subject)}</div>}
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: 0 }}>{String(m.body)}</pre>

              <div className="row-wrap mt-2">
                {m.simulated === 1 && <Badge tone="warning">simulated</Badge>}
                {m.provider_key && <Badge tone="outline">{String(m.provider_key)}</Badge>}
                {Number(m.open_count) > 0 && <span className="xsmall muted">opened {Number(m.open_count)}×</span>}
                {Number(m.click_count) > 0 && <span className="xsmall muted">clicked {Number(m.click_count)}×</span>}
                {m.provider_error && <span className="xsmall" style={{ color: 'var(--critical)' }}>{String(m.provider_error)}</span>}
                <span className="spacer" />
                {m.status === 'draft' && (
                  <>
                    <ActionButton action={A.approveSendAction} args={[m.id as string]} label="Approve & send" variant="primary" />
                    <ActionButton action={A.rejectDraftAction} args={[m.id as string]} label="Reject" variant="danger" />
                  </>
                )}
                {m.direction === 'outbound' && (
                  <ActionButton action={A.generateOutreachAction} args={[m.business_id as string]} label="Draft another" />
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
