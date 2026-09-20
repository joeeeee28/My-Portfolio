'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BulkBar } from './actions-client';

export interface ProspectRow {
  id: string;
  name: string;
  category: string | null;
  industry: string | null;
  locality: string | null;
  score: number | null;
  priority: string;
  stage: string;
  websiteStatus: string;
  rating: number | null;
  reviewCount: number | null;
  service: string;
  contacts: number;
  concept: string | null;
  nextAction: string | null;
  isDemo: boolean;
}

const WEBSITE_LABEL: Record<string, { label: string; tone?: string }> = {
  missing: { label: 'No site', tone: 'critical' },
  unreachable: { label: 'Broken', tone: 'critical' },
  parked: { label: 'Parked', tone: 'critical' },
  insecure: { label: 'No SSL', tone: 'warning' },
  live: { label: 'Live', tone: 'success' },
  unknown: { label: 'Unknown' },
};

export function ProspectsTable({ rows, sequences }: { rows: ProspectRow[]; sequences: { id: string; name: string }[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = selected.length === rows.length && rows.length > 0;

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? [] : rows.map((r) => r.id))}
                />
              </th>
              <th>Prospect</th>
              <th style={{ width: 64 }}>Score</th>
              <th style={{ width: 78 }}>Priority</th>
              <th style={{ width: 96 }}>Website</th>
              <th style={{ width: 96 }}>Reputation</th>
              <th style={{ width: 110 }}>Recommended</th>
              <th style={{ width: 88 }}>Stage</th>
              <th style={{ width: 76 }}>Concept</th>
              <th>Next best action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const w = WEBSITE_LABEL[r.websiteStatus] ?? WEBSITE_LABEL.unknown;
              return (
                <tr key={r.id}>
                  <td>
                    <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <Link href={`/prospects/${r.id}`} className="strong" style={{ color: 'var(--accent)' }}>
                        {r.name}
                      </Link>
                      {r.isDemo && <span className="demo-flag">Demo</span>}
                    </div>
                    <div className="xsmall muted truncate" style={{ maxWidth: 260 }}>
                      {[r.category, r.locality].filter(Boolean).join(' · ') || 'Category not established'}
                    </div>
                  </td>
                  <td className="num">
                    <span
                      className={`score ${r.score === null ? '' : r.score >= 88 ? 'critical' : r.score >= 70 ? 'high' : r.score >= 45 ? 'medium' : 'low'}`}
                    >
                      {r.score === null ? '—' : Math.round(r.score)}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${r.priority === 'critical' ? 'critical' : r.priority === 'high' ? 'accent' : ''}`}>{r.priority}</span>
                  </td>
                  <td>
                    <span className={`badge ${w.tone ?? ''}`}>{w.label}</span>
                  </td>
                  <td className="num small">
                    {r.rating ? (
                      <>
                        {r.rating.toFixed(1)}★
                        {r.reviewCount ? <span className="muted"> ({r.reviewCount})</span> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="small">{r.service}</td>
                  <td>
                    <span className="badge outline">{r.stage}</span>
                  </td>
                  <td>
                    {r.concept ? (
                      <span className={`badge ${r.concept === 'viewed' ? 'success' : r.concept === 'shared' ? 'accent' : ''}`}>{r.concept}</span>
                    ) : (
                      <span className="muted xsmall">—</span>
                    )}
                  </td>
                  <td className="small muted truncate" style={{ maxWidth: 300 }}>
                    {r.nextAction ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <BulkBar ids={selected} sequences={sequences} onClear={() => setSelected([])} />
    </>
  );
}
