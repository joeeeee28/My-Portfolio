import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listSequences } from '@/engine/outreach';
import { all, json } from '@/db';
import { relativeFromNow } from '@/lib/time';
import { APPROVAL_MODE_LABELS } from '@/lib/domain';
import { Card, Badge, EmptyState, SectionHead, Stats, Table } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { ListOrdered } from 'lucide-react';

export const metadata = { title: 'Outreach Sequences' };
export const dynamic = 'force-dynamic';

export default async function SequencesPage() {
  const orgId = boot();
  await getSession();
  const sequences = listSequences(orgId);

  const enrollments = all<{
    id: string;
    sequence_id: string;
    seq_name: string;
    business_id: string;
    name: string;
    status: string;
    current_step: number;
    next_step_at: string | null;
    touches_sent: number;
    stop_reason: string | null;
    enrolled_at: string;
  }>(
    `SELECT e.id, e.sequence_id, s.name seq_name, e.business_id, b.name, e.status, e.current_step, e.next_step_at,
            e.touches_sent, e.stop_reason, e.enrolled_at
       FROM sequence_enrollments e
       JOIN sequences s ON s.id = e.sequence_id
       JOIN businesses b ON b.id = e.business_id
      WHERE e.org_id = ?
      ORDER BY e.status = 'active' DESC, e.next_step_at ASC LIMIT 80`,
    [orgId]
  );

  const activeCount = enrollments.filter((e) => e.status === 'active').length;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>Outreach Sequences</h1>
          <p className="small muted">
            Multichannel follow-up that stops itself. A sequence halts the moment a prospect replies, opts out, becomes a client, or is marked not
            interested.
          </p>
        </div>
        <div className="spacer" />
        <ActionButton action={A.dispatchSequencesAction} args={[]} label="Dispatch due steps" variant="primary" />
      </div>

      <Stats
        items={[
          { label: 'Sequences', value: sequences.length },
          { label: 'Active enrolments', value: activeCount },
          { label: 'Stopped', value: enrollments.filter((e) => e.status.startsWith('stopped')).length },
          { label: 'Completed', value: enrollments.filter((e) => e.status === 'completed').length },
        ]}
      />

      {sequences.length === 0 ? (
        <div className="mt-3">
          <EmptyState icon={<ListOrdered size={17} />} title="No sequences yet" body="Default sequences are created with the workspace." />
        </div>
      ) : (
        <>
          <SectionHead title="Sequences" />
          <div className="col">
            {sequences.map((s) => (
              <Card
                key={s.id}
                title={s.name}
                sub={s.description ?? undefined}
                actions={
                  <div className="row" style={{ gap: 6 }}>
                    <Badge tone={s.is_active === 1 ? 'success' : ''}>{s.is_active === 1 ? 'active' : 'paused'}</Badge>
                    {s.is_default === 1 && <Badge tone="accent">default</Badge>}
                  </div>
                }
              >
                <div className="grid grid-4 mb-2">
                  <div>
                    <div className="xsmall muted">Approval mode</div>
                    <div className="small strong">{APPROVAL_MODE_LABELS[s.approval_mode]}</div>
                  </div>
                  <div>
                    <div className="xsmall muted">Daily / domain limit</div>
                    <div className="small strong">
                      {s.daily_send_limit} / {s.domain_daily_limit}
                    </div>
                  </div>
                  <div>
                    <div className="xsmall muted">Enrolled</div>
                    <div className="small strong">
                      {s.enrolled} <span className="muted">({s.active} active)</span>
                    </div>
                  </div>
                  <div>
                    <div className="xsmall muted">Max touches</div>
                    <div className="small strong">{s.max_touches}</div>
                  </div>
                </div>

                <Table
                  compact
                  head={[
                    { label: 'Day', align: 'right' },
                    { label: 'Channel' },
                    { label: 'Purpose' },
                    { label: 'Tone' },
                    { label: 'Concept' },
                  ]}
                >
                  {(s.steps as { position: number; day_offset: number; channel: string; purpose: string; tone: string; include_mockup: number; enabled: number }[]).map(
                    (step) => (
                      <tr key={step.position}>
                        <td className="num small mono">D{step.day_offset}</td>
                        <td className="small">{step.channel}</td>
                        <td className="small">{step.purpose}</td>
                        <td className="small">{step.tone.replace('_', ' ')}</td>
                        <td className="small">{step.include_mockup === 1 ? <Badge tone="accent">includes concept</Badge> : '—'}</td>
                      </tr>
                    )
                  )}
                </Table>

                <div className="row-wrap mt-2">
                  <span className="xsmall muted">
                    Stops on: {[s.stop_on_response === 1 && 'response', s.stop_on_optout === 1 && 'opt-out', s.stop_on_client === 1 && 'client', s.stop_on_not_interested === 1 && 'not interested']
                      .filter(Boolean)
                      .join(', ')}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <SectionHead title="Enrolments" hint="Live status of every prospect in a sequence" />
      {enrollments.length === 0 ? (
        <EmptyState title="No enrolments yet" body="Enrol prospects from the Prospect Hub using a bulk action, or from a prospect's workspace." />
      ) : (
        <Card tight>
          <Table
            head={[
              { label: 'Prospect' },
              { label: 'Sequence' },
              { label: 'Status' },
              { label: 'Progress', align: 'right' },
              { label: 'Next step' },
              { label: 'Stop reason' },
            ]}
          >
            {enrollments.map((e) => {
              const seq = sequences.find((s) => s.id === e.sequence_id);
              const totalSteps = seq ? (seq.steps as unknown[]).length : 0;
              return (
                <tr key={e.id}>
                  <td>
                    <Link href={`/prospects/${e.business_id}`} className="small strong" style={{ color: 'var(--accent)' }}>
                      {e.name}
                    </Link>
                  </td>
                  <td className="small">{e.seq_name}</td>
                  <td>
                    <Badge
                      tone={
                        e.status === 'active'
                          ? 'accent'
                          : e.status === 'completed'
                            ? 'success'
                            : e.status === 'stopped_optout'
                              ? 'critical'
                              : e.status === 'stopped_response'
                                ? 'success'
                                : ''
                      }
                      dot
                    >
                      {e.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="num small mono">
                    {e.current_step}/{totalSteps} · {e.touches_sent} sent
                  </td>
                  <td className="small">{e.next_step_at && e.status === 'active' ? relativeFromNow(e.next_step_at) : '—'}</td>
                  <td className="small muted">{e.stop_reason?.replace(/_/g, ' ') ?? '—'}</td>
                </tr>
              );
            })}
          </Table>
        </Card>
      )}
    </>
  );
}
