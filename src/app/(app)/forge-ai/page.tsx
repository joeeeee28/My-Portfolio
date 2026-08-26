import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { SUGGESTED_COMMANDS, listCommandRuns } from '@/engine/command';
import { relativeFromNow } from '@/lib/time';
import { BRAND, PILLARS } from '@/lib/brand';
import { Card, Badge, SectionHead, EmptyState } from '@/components/ui';
import { ForgeCommandBar } from '@/components/actions-client';
import { Sparkles } from 'lucide-react';

export const metadata = { title: 'Forge AI' };
export const dynamic = 'force-dynamic';

export default async function ForgeAiPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const orgId = boot();
  await getSession();
  const sp = await searchParams;
  const history = listCommandRuns(orgId, 20);

  return (
    <>
      <div className="mb-2">
        <h1 className="row" style={{ gap: 8 }}>
          <Sparkles size={19} style={{ color: 'var(--ai)' }} />
          {BRAND.assistant}
        </h1>
        <p className="small muted">
          {BRAND.assistant} understands the whole lifecycle — prospects, audits, outreach, calls, proposals and delivery. Read-only questions are
          answered immediately. Anything with an external consequence is returned as a proposed action that you authorise.
        </p>
      </div>

      <Card>
        <ForgeCommandBar businessId={sp.business} suggestions={SUGGESTED_COMMANDS} />
      </Card>

      <div className="grid grid-2 mt-3">
        <Card title="What Forge AI knows" sub="Context available to every answer">
          <ul className="col" style={{ gap: 6 }}>
            {PILLARS.map((p) => (
              <li key={p.key} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Badge tone="accent">{p.label}</Badge>
                <span className="small muted-2">{p.summary}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Safety model" sub="How actions are gated">
          <ul className="col" style={{ gap: 6 }}>
            <li className="small">• Read-only questions execute immediately.</li>
            <li className="small">• Internal work (concepts, drafts, briefings, proposals) is proposed first, then run on your confirmation.</li>
            <li className="small">• Anything external — sending, publishing, deploying — is flagged and requires explicit authorisation.</li>
            <li className="small">• Outreach always passes the compliance gate: suppression list, consent, quiet hours and rate limits.</li>
            <li className="small">• Automation rules are never changed silently. Learning produces proposals you accept or reject.</li>
          </ul>
        </Card>
      </div>

      <SectionHead title="Recent commands" />
      {history.length === 0 ? (
        <EmptyState title="No commands yet" body="Ask Forge AI anything about your pipeline." />
      ) : (
        <Card tight>
          <div className="queue">
            {history.map((h) => (
              <div className="queue-item" key={h.id}>
                <div className="queue-main">
                  <div className="queue-title">{String(h.input)}</div>
                  <div className="queue-reason">
                    {(h.result as { answer?: string })?.answer?.slice(0, 220) ?? ''}
                  </div>
                </div>
                <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Badge tone="ai">{String(h.intent).replace(/_/g, ' ')}</Badge>
                  <span className="xsmall muted">{relativeFromNow(h.created_at)}</span>
                  {h.executed === 1 && <Badge tone="success">action executed</Badge>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
