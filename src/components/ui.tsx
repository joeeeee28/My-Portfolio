import Link from 'next/link';
import { Sparkles, Inbox, AlertTriangle } from 'lucide-react';
import { scoreBand } from '@/lib/brand';

export function Card({
  title,
  sub,
  actions,
  children,
  tight,
  footer,
  className,
}: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  tight?: boolean;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <div className="card-title truncate">{title}</div>}
            {sub && <div className="card-sub truncate">{sub}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={`card-body${tight ? ' tight' : ''}`}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Stats({ items }: { items: { label: string; value: React.ReactNode; detail?: React.ReactNode; tone?: string; href?: string }[] }) {
  return (
    <div className="stats">
      {items.map((s, i) => {
        const inner = (
          <>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            {s.detail !== undefined && s.detail !== null && <div className="stat-detail">{s.detail}</div>}
          </>
        );
        return s.href ? (
          <Link key={i} href={s.href} className={`stat${s.tone ? ` ${s.tone}` : ''}${i === 0 ? ' accent' : ''}`} style={{ display: 'block' }}>
            {inner}
          </Link>
        ) : (
          <div key={i} className={`stat${s.tone ? ` ${s.tone}` : ''}${i === 0 ? ' accent' : ''}`}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

export function Score({ value, size }: { value: number | null | undefined; size?: 'sm' | 'lg' }) {
  if (value === null || value === undefined) return <span className="score">—</span>;
  const band = scoreBand(value);
  if (size === 'lg') {
    return (
      <div className={`score-big ${band.tone}`}>
        <span className="value">{Math.round(value)}</span>
        <span className="badge" style={{ alignSelf: 'center' }}>{band.label}</span>
      </div>
    );
  }
  return <span className={`score ${band.tone}`}>{Math.round(value)}</span>;
}

export function Badge({ tone, children, dot }: { tone?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ''}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

export function AiTag({ label = 'Forge AI' }: { label?: string }) {
  return (
    <span className="ai-tag">
      <Sparkles size={11} />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Inbox size={17} />}</div>
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Banner({ tone = 'accent', icon, children }: { tone?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`banner ${tone}`}>
      <span className="banner-icon">{icon ?? <AlertTriangle size={15} />}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function Bar({ value, max = 100, tone }: { value: number; max?: number; tone?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="bar">
      <div className={`bar-fill${tone ? ` ${tone}` : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Pillars({ items }: { items: { label: string; value: React.ReactNode; active?: boolean }[] }) {
  return (
    <div className="pillars">
      {items.map((p, i) => (
        <div key={i} className={`pillar${p.active ? ' has-value' : ''}`}>
          <div className="pillar-label">{p.label}</div>
          <div className="pillar-value">{p.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Funnel({ steps }: { steps: { label: string; count: number; conversionFromPrev: number | null; conversionFromTop: number }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div className="funnel-row" key={s.label}>
          <div className="truncate" title={s.label}>{s.label}</div>
          <div className="funnel-bar">
            <div className="funnel-fill" style={{ width: `${(s.count / max) * 100}%`, opacity: 0.9 - i * 0.06 }} />
          </div>
          <div className="funnel-meta">
            {s.count}
            {s.conversionFromPrev !== null && <span style={{ marginLeft: 6 }}>{s.conversionFromPrev}%</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Table({
  head,
  children,
  compact,
}: {
  head: { label: string; align?: 'right' | 'center'; width?: string }[];
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className={`table${compact ? ' table-compact' : ''}`}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={h.align === 'right' ? 'num' : ''} style={h.width ? { width: h.width } : undefined}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function DemoFlag() {
  return <span className="demo-flag" title="Demo data — not a real discovered business">Demo</span>;
}

export function StrengthBadge({ value }: { value: string | null | undefined }) {
  const map: Record<string, string> = { strong: 'success', medium: 'warning', weak: 'critical', unknown: '' };
  const label = value === 'unknown' || !value ? 'unknown' : value;
  return <Badge tone={map[label] ?? ''}>{label}</Badge>;
}

export function KeyValue({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: 0, fontSize: 13 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt className="muted small nowrap">{it.label}</dt>
          <dd style={{ margin: 0 }}>{it.value ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionHead({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
      {right && <div className="right">{right}</div>}
    </div>
  );
}
