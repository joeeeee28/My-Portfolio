import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { buildActionQueue, actionQueueCounts, smartQueues } from '@/engine/queues';
import { relativeFromNow } from '@/lib/time';
import { BRAND } from '@/lib/brand';
import { Card, Badge, EmptyState, SectionHead, Stats, Score } from '@/components/ui';
import { ActionButton, CompleteFollowUpButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Flame } from 'lucide-react';

export const metadata = { title: 'Action Queue' };
export const dynamic = 'force-dynamic';

const KIND_TONE: Record<string, string> = {
  'Follow up': 'critical',
  'Book the call': 'critical',
  'Review concept': 'warning',
  'Prepare call': 'warning',
  'Proposal': 'success',
  'Generate concept': 'accent',
  'Approve outreach': 'accent',
  'Delivery risk': 'critical',
};

export default async function ActionQueuePage() {
  const orgId = boot();
  await getSession();
  const queue = buildActionQueue(orgId, { limit: 200 });
  const counts = actionQueueCounts(orgId);
  const queues = smartQueues(orgId);

  const grouped = queue.reduce<Record<string, typeof queue>>((acc, item) => {
    (acc[item.kind] ||= []).push(item);
    return acc;
  }, {});

  return (
    <>
      <div className="mb-2">
        <h1 className="row" style={{ gap: 8 }}>
          <Flame size={19} style={{ color: 'var(--accent)' }} />
          {BRAND.queueLabel}
        </h1>
        <p className="small muted">
          Everything waiting on a decision, ordered by urgency. Each item carries the evidence that put it here and the single action that resolves
          it.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Total items', value: counts.total },
          { label: 'Critical', value: counts.byTone.critical ?? 0, tone: (counts.byTone.critical ?? 0) > 0 ? 'critical' : undefined },
          { label: 'High', value: counts.byTone.high ?? 0, tone: (counts.byTone.high ?? 0) > 0 ? 'warning' : undefined },
          { label: 'Medium', value: counts.byTone.medium ?? 0 },
          ...Object.entries(counts.byKind)
            .slice(0, 4)
            .map(([kind, n]) => ({ label: kind, value: n })),
        ]}
      />

      {queue.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="The Action Queue is clear"
            body="Nothing needs a decision right now. New items appear as discovery, audits and engagement run — or when a prospect views their concept."
            action={
              <Link href="/discover" className="btn btn-primary">
                Run discovery
              </Link>
            }
          />
        </div>
      ) : (
        <div className="col">
          {Object.entries(grouped).map(([kind, items]) => (
            <div key={kind}>
              <SectionHead title={kind} hint={`${items.length} item${items.length === 1 ? '' : 's'}`} />
              <div className="queue">
                {items.map((item) => (
                  <div className="queue-item" key={item.id}>
                    <span className={`queue-stripe ${item.tone}`} />
                    <div className="queue-main">
                      <div className="row" style={{ gap: 6 }}>
                        <Link href={item.actionHref} className="queue-title">
                          {item.title}
                        </Link>
                        {item.score !== null && <Score value={item.score} />}
                        {item.priority && <Badge tone={item.priority === 'critical' ? 'critical' : item.priority === 'high' ? 'accent' : ''}>{item.priority}</Badge>}
                      </div>
                      <div className="queue-reason">{item.reason}</div>
                      {item.dueAt && <div className="xsmall muted">{relativeFromNow(item.dueAt)}</div>}
                    </div>
                    <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                      <Link href={item.actionHref} className="btn btn-sm btn-primary">
                        {item.actionLabel}
                      </Link>
                      {item.kind === 'Follow up' && <CompleteFollowUpButton followUpId={item.id} />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionHead title="Smart queues" hint="Every queue is a saved filter into the Prospect Hub" />
      <div className="grid grid-3">
        {queues.map((q) => (
          <Link key={q.key} href={`/prospects?queue=${q.key}`} className="card" style={{ padding: '11px 13px', display: 'block' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small strong">{q.label}</span>
              <span className="score" style={q.count > 0 ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}>
                {q.count}
              </span>
            </div>
            <div className="xsmall muted mt-1">{q.description}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
