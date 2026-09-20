import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listBusinesses } from '@/repo/business';
import { researchStats } from '@/engine/research';
import { relativeFromNow } from '@/lib/time';
import { all } from '@/db';
import { json } from '@/db';
import { serviceLabel } from '@/lib/brand';
import { Card, Badge, EmptyState, SectionHead, Stats, Table, Score } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Search } from 'lucide-react';

export const metadata = { title: 'Business Intelligence' };
export const dynamic = 'force-dynamic';

export default async function ResearchPage() {
  const orgId = boot();
  await getSession();
  const stats = researchStats(orgId);
  const { rows } = listBusinesses(orgId, { sortBy: 'score', limit: 60 });

  const docs = all<{
    id: string;
    business_id: string;
    name: string;
    opportunity_score: number | null;
    confidence: number;
    unverified_claims: string;
    digital_weaknesses: string;
    outreach_angles: string;
    what_to_sell: string | null;
    generated_at: string;
    is_demo: number;
  }>(
    `SELECT r.id, r.business_id, b.name, b.opportunity_score, r.confidence, r.unverified_claims, r.digital_weaknesses,
            r.outreach_angles, r.what_to_sell, r.generated_at, b.is_demo
       FROM research_docs r JOIN businesses b ON b.id = r.business_id
      WHERE r.org_id = ?
      GROUP BY r.business_id
      HAVING r.generated_at = MAX(r.generated_at)
      ORDER BY b.opportunity_score DESC LIMIT 60`,
    [orgId]
  );

  const questions = all<{ id: string; business_id: string; name: string; question: string; answer: string; created_at: string }>(
    `SELECT q.id, q.business_id, b.name, q.question, q.answer, q.created_at
       FROM research_questions q JOIN businesses b ON b.id = q.business_id
      WHERE q.org_id = ? ORDER BY q.created_at DESC LIMIT 20`,
    [orgId]
  );

  return (
    <>
      <div className="mb-2">
        <h1>Business Intelligence</h1>
        <p className="small muted">
          Forge AI answers only from evidence ClientForge holds. Where the evidence does not support an answer it says so and records the claim as
          unverified — it never invents a review, a revenue figure or a competitor claim.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Briefs generated', value: stats.total },
          { label: 'Custom questions', value: stats.questions },
          { label: 'Avg confidence', value: `${Math.round(stats.avgConfidence * 100)}%` },
          { label: 'Research cost', value: `$${stats.cost}` },
        ]}
      />

      {docs.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<Search size={17} />}
            title="No intelligence briefs yet"
            body="Open any prospect in the Prospect Hub and generate a brief. Each one carries its own confidence score and an explicit list of claims that could not be verified."
            action={
              <Link href="/prospects" className="btn btn-primary">
                Go to Prospect Hub
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Intelligence briefs" hint={`${docs.length} businesses`} />
          <div className="grid grid-2">
            {docs.map((d) => {
              const weaknesses = json<string[]>(d.digital_weaknesses, []);
              const angles = json<string[]>(d.outreach_angles, []);
              const unverified = json<string[]>(d.unverified_claims, []);
              return (
                <Card
                  key={d.id}
                  title={
                    <span className="row" style={{ gap: 6 }}>
                      <Link href={`/prospects/${d.business_id}?tab=intelligence`} style={{ color: 'var(--accent)' }}>
                        {d.name}
                      </Link>
                      {d.is_demo === 1 && <span className="demo-flag">Demo</span>}
                    </span>
                  }
                  sub={`${relativeFromNow(d.generated_at)} · confidence ${Math.round(d.confidence * 100)}%`}
                  actions={<Score value={d.opportunity_score} />}
                >
                  {weaknesses.length > 0 && (
                    <>
                      <div className="xsmall muted mb-1">Digital weaknesses</div>
                      <ul className="col mb-2" style={{ gap: 3 }}>
                        {weaknesses.slice(0, 4).map((w, i) => (
                          <li key={i} className="small">
                            • {w}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {angles.length > 0 && (
                    <>
                      <div className="xsmall muted mb-1">Outreach angles</div>
                      <ul className="col" style={{ gap: 3 }}>
                        {angles.slice(0, 3).map((a, i) => (
                          <li key={i} className="small">
                            • {a}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <div className="row-wrap mt-2">
                    <Badge tone="outline">{serviceLabel(d.what_to_sell)}</Badge>
                    {unverified.length > 0 && <Badge tone="warning">{unverified.length} unverified</Badge>}
                    <ActionButton action={A.researchBusinessAction} args={[d.business_id]} label="Refresh" />
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {questions.length > 0 && (
        <>
          <SectionHead title="Custom questions asked" />
          <Card tight>
            <Table compact head={[{ label: 'Business' }, { label: 'Question' }, { label: 'Answer' }, { label: 'When' }]}>
              {questions.map((q) => (
                <tr key={q.id}>
                  <td className="small">
                    <Link href={`/prospects/${q.business_id}?tab=intelligence`} style={{ color: 'var(--accent)' }}>
                      {q.name}
                    </Link>
                  </td>
                  <td className="small">{q.question}</td>
                  <td className="small muted" style={{ maxWidth: 420 }}>
                    {q.answer}
                  </td>
                  <td className="xsmall muted nowrap">{relativeFromNow(q.created_at)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
