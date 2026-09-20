import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listCalls, listBriefings } from '@/engine/crm';
import { all, json } from '@/db';
import { formatDateTime, relativeFromNow } from '@/lib/time';
import { Card, Badge, EmptyState, SectionHead, Stats, KeyValue, AiTag } from '@/components/ui';
import { ActionButton, InlineForm } from '@/components/actions-client';
import * as A from '@/app/actions';
import * as F from '@/app/form-actions';
import { Phone } from 'lucide-react';

export const metadata = { title: 'Calls' };
export const dynamic = 'force-dynamic';

export default async function CallsPage() {
  const orgId = boot();
  await getSession();
  const upcoming = listCalls(orgId, { upcoming: true, limit: 30 });
  const past = listCalls(orgId, { limit: 60 }).filter((c) => c.status !== 'scheduled' || new Date(c.scheduled_at ?? 0).getTime() < Date.now());
  const briefings = listBriefings(orgId);

  const todayCount = upcoming.filter((c) => (c.scheduled_at ?? '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length;

  return (
    <>
      <div className="mb-2">
        <h1>Calls</h1>
        <p className="small muted">Scheduling, notes, AI briefing and requirements extraction. Requirements flow straight into the proposal.</p>
      </div>

      <Stats
        items={[
          { label: 'Upcoming', value: upcoming.length },
          { label: 'Today', value: todayCount, tone: todayCount > 0 ? 'warning' : undefined },
          { label: 'Completed', value: past.filter((c) => c.status === 'completed').length },
          { label: 'Briefings', value: briefings.length },
        ]}
      />

      <SectionHead title="Upcoming" hint="Briefings are generated automatically when a call is scheduled" />
      {upcoming.length === 0 ? (
        <EmptyState icon={<Phone size={17} />} title="No calls scheduled" body="Schedule a call from any prospect's workspace and the briefing is generated immediately." />
      ) : (
        <div className="col">
          {upcoming.map((c) => {
            const briefing = briefings.find((b) => b.business_id === c.business_id);
            return (
              <Card
                key={c.id}
                title={c.title}
                sub={`${formatDateTime(c.scheduled_at)} · ${c.duration_min} min`}
                actions={
                  <Link href={`/prospects/${c.business_id}`} className="btn btn-sm">
                    {c.business_name}
                  </Link>
                }
              >
                <div className="row-wrap mb-2">
                  <Badge tone="accent">{c.status}</Badge>
                  <Badge>{relativeFromNow(c.scheduled_at ?? '')}</Badge>
                  {c.meeting_link && (
                    <a href={c.meeting_link} target="_blank" rel="noreferrer" className="chip">
                      Meeting link
                    </a>
                  )}
                </div>

                {briefing ? (
                  <div className="ai-panel" style={{ padding: 12 }}>
                    <AiTag label="Forge AI call briefing" />
                    <div className="grid grid-2 mt-2">
                      <div>
                        <div className="xsmall muted">Business overview</div>
                        <p className="small">{String(briefing.business_overview ?? '')}</p>
                        <div className="xsmall muted mt-2">Opening</div>
                        <p className="small">{String(briefing.opening ?? '')}</p>
                        <div className="xsmall muted mt-2">Call goal</div>
                        <p className="small">{String(briefing.call_goal ?? '')}</p>
                      </div>
                      <div>
                        <div className="xsmall muted">Questions to ask</div>
                        <ul className="col" style={{ gap: 3 }}>
                          {json<string[]>(briefing.questions as string, []).map((q, i) => (
                            <li key={i} className="small">
                              {i + 1}. {q}
                            </li>
                          ))}
                        </ul>
                        <div className="xsmall muted mt-2">Objections to expect</div>
                        <ul className="col" style={{ gap: 3 }}>
                          {json<string[]>(briefing.objections as string, []).map((o, i) => (
                            <li key={i} className="small">
                              • {o}
                            </li>
                          ))}
                        </ul>
                        <div className="xsmall muted mt-2">Recommended package</div>
                        <p className="small strong">{String(briefing.recommended_package ?? '—')}</p>
                        <div className="xsmall muted mt-1">Suggested range</div>
                        <p className="small">{String(briefing.price_range ?? '—')}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <ActionButton action={A.generateBriefingAction} args={[c.business_id, c.id]} label="Generate briefing" />
                )}

                <div className="mt-2">
                  <InlineForm action={F.formAddCallNote} submitLabel="Add note">
                    <input type="hidden" name="callId" value={c.id} />
                    <div className="row" style={{ gap: 6 }}>
                      <select className="select" name="kind" defaultValue="note" style={{ width: 'auto' }}>
                        {['note', 'requirement', 'objection', 'decision', 'next_step'].map((k) => (
                          <option key={k} value={k}>
                            {k.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                      <input className="input" name="note" placeholder="What was discussed…" required />
                    </div>
                  </InlineForm>
                </div>

                <div className="row-wrap mt-2">
                  <ActionButton action={A.summarizeCallAction} args={[c.id, 'positive']} label="Complete as positive" variant="primary" />
                  <ActionButton action={A.summarizeCallAction} args={[c.id, 'neutral']} label="Complete as neutral" />
                  <ActionButton action={A.summarizeCallAction} args={[c.id, 'negative']} label="Complete as negative" variant="danger" />
                  <ActionButton action={A.generateProposalAction} args={[c.business_id, { callId: c.id }]} label="Draft proposal from notes" />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {past.length > 0 && (
        <>
          <SectionHead title="Past calls" />
          <Card tight>
            <div className="queue">
              {past.slice(0, 20).map((c) => (
                <div className="queue-item" key={c.id}>
                  <div className="queue-main">
                    <Link href={`/prospects/${c.business_id}?tab=calls`} className="queue-title">
                      {c.business_name}
                    </Link>
                    <div className="queue-reason">
                      {c.title} · {formatDateTime(c.scheduled_at)}
                    </div>
                    {c.ai_summary && <div className="queue-reason muted">{String(c.ai_summary).slice(0, 220)}</div>}
                  </div>
                  <Badge tone={c.status === 'completed' ? 'success' : c.status === 'no_show' ? 'critical' : ''}>{c.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
