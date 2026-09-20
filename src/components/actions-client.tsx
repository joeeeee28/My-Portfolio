'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as A from '@/app/actions';
import type { ActionItem } from '@/engine/queues';

function useAction() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();

  const run = (fn: () => Promise<A.ActionResult>) => {
    start(async () => {
      const res = await fn();
      setMessage({ ok: res.ok, text: res.message });
      router.refresh();
    });
  };
  return { pending, message, run, setMessage };
}

export function Flash({ message, onDismiss }: { message: { ok: boolean; text: string } | null; onDismiss?: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => onDismiss?.(), 9000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);
  if (!message) return null;
  return (
    <div
      className={`banner ${message.ok ? 'success' : 'critical'}`}
      style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 200, maxWidth: 440, boxShadow: 'var(--shadow-lg)' }}
      role="status"
    >
      <div>{message.text}</div>
      {onDismiss && (
        <button className="btn btn-ghost btn-sm" onClick={onDismiss} style={{ marginLeft: 'auto' }}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Wraps a subtree with a shared flash message. */
export function ActionSurface({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function RunDiscoveryButton({ label = 'Run Discovery Now', offline = false }: { label?: string; offline?: boolean }) {
  const { pending, message, run, setMessage } = useAction();
  return (
    <>
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const fd = new FormData();
            if (offline) fd.set('offline', 'on');
            return A.runDiscoveryNow(fd);
          })
        }
      >
        {pending ? 'Running…' : label}
      </button>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </>
  );
}

export function RefreshBriefingButton() {
  const { pending, run } = useAction();
  return (
    <button className="btn btn-sm btn-block" disabled={pending} onClick={() => run(() => A.refreshBriefingAction())}>
      {pending ? 'Refreshing…' : 'Regenerate briefing'}
    </button>
  );
}

export function QueueActionButton({ item }: { item: ActionItem }) {
  const { pending, message, run, setMessage } = useAction();
  const label = item.action === 'follow_up' ? 'Follow up' : item.action === 'share_mockup' ? 'Review' : item.action === 'generate_mockup' ? 'Generate' : item.action === 'schedule_call' ? 'Open briefing' : 'Open';
  return (
    <>
      <Link href={item.actionHref} className="btn btn-sm">
        {pending ? '…' : label}
      </Link>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </>
  );
}

/**
 * Server-action reference plus its arguments.
 *
 * A closure built in a Server Component cannot be handed to a Client Component
 * (Next.js rejects it), so the *reference* to the server action is passed
 * instead — that is explicitly supported — together with its args.
 */
export type ServerActionRef = (...args: never[]) => Promise<A.ActionResult>;

export function ActionButton({
  action,
  args = [],
  label,
  variant = 'default',
  size = 'sm',
  confirm,
}: {
  action: ServerActionRef;
  args?: unknown[];
  label: string;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  confirm?: string;
}) {
  const { pending, message, run, setMessage } = useAction();
  return (
    <>
      <button
        className={`btn btn-${variant === 'default' ? 'sm' : variant}${size === 'md' ? ' btn-lg' : ''}`}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          run(() => action(...(args as never[])));
        }}
      >
        {pending ? '…' : label}
      </button>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </>
  );
}

/** A server action that accepts FormData — pass the reference, not a closure. */
export type FormActionRef = (fd: FormData) => Promise<A.ActionResult>;

export function InlineForm({
  action,
  children,
  submitLabel,
  submitClass = 'btn btn-sm btn-primary',
}: {
  action: FormActionRef;
  children: React.ReactNode;
  submitLabel: string;
  submitClass?: string;
}) {
  const { pending, message, run, setMessage } = useAction();
  const ref = useRef<HTMLFormElement>(null);
  return (
    <>
      <form
        ref={ref}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(ref.current!);
          run(() => action(fd));
          ref.current?.reset();
        }}
        className="col"
        style={{ gap: 8 }}
      >
        {children}
        <button type="submit" className={submitClass} disabled={pending}>
          {pending ? 'Working…' : submitLabel}
        </button>
      </form>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </>
  );
}

/** Command bar for Forge AI. */
export function ForgeCommandBar({
  businessId,
  suggestions,
}: {
  businessId?: string;
  suggestions: string[];
}) {
  const { pending, message, run, setMessage } = useAction();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof parseResult>> | null>(null);

  async function parseResult(res: A.ActionResult) {
    return res.data as {
      runId: string;
      intent: string;
      answer: string;
      resultKind: string;
      rows: Record<string, unknown>[];
      metrics: { label: string; value: string | number }[];
      proposedActions: { label: string; kind: string; payload: Record<string, unknown>; external: boolean; confirmation: string }[];
    } | undefined;
  }

  const submit = (text: string) => {
    if (!text.trim()) return;
    setInput('');
    run(async () => {
      const res = await A.runForgeCommandAction(text, businessId);
      if (res.ok) setResult(await parseResult(res));
      return res;
    });
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="row"
        style={{ gap: 8 }}
      >
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Forge AI anything about your pipeline…"
          aria-label="Ask Forge AI"
        />
        <button className="btn btn-primary" type="submit" disabled={pending || !input.trim()}>
          {pending ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      <div className="row-wrap">
        {suggestions.map((s) => (
          <button key={s} className="chip" onClick={() => submit(s)} disabled={pending}>
            {s}
          </button>
        ))}
      </div>

      {result && (
        <div className="ai-panel" style={{ padding: 14 }}>
          <div className="ai-tag" style={{ marginBottom: 6 }}>
            Forge AI · {result.intent.replace(/_/g, ' ')}
          </div>
          <p style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{result.answer}</p>

          {result.metrics.length > 0 && (
            <div className="mt-2">
              <div className="stats">
                {result.metrics.slice(0, 8).map((m, i) => (
                  <div className="stat" key={i}>
                    <div className="stat-label">{m.label}</div>
                    <div className="stat-value" style={{ fontSize: 17 }}>
                      {m.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.rows.length > 0 && (
            <div className="mt-2 table-scroll">
              <table className="table table-compact">
                <thead>
                  <tr>
                    {Object.keys(result.rows[0])
                      .slice(0, 6)
                      .map((k) => (
                        <th key={k}>{k.replace(/([A-Z])/g, ' $1')}</th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 15).map((r, i) => (
                    <tr key={i}>
                      {Object.keys(r)
                        .slice(0, 6)
                        .map((k) => (
                          <td key={k}>
                            {k === 'id' && r.href ? (
                              <Link href={String(r.href)} style={{ color: 'var(--accent)' }}>
                                {String(r[k] ?? '')}
                              </Link>
                            ) : (
                              String(r[k] ?? '')
                            )}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.proposedActions.length > 0 && (
            <div className="mt-2 col" style={{ gap: 8 }}>
              <div className="small strong">Proposed actions — nothing runs until you authorise it</div>
              {result.proposedActions.map((a, i) => (
                <div key={i} className="row" style={{ gap: 8 }}>
                  <ActionButton
                    action={A.executeForgeActionAction} args={[result.runId, a]}
                    label={a.label}
                    variant={a.external ? 'danger' : 'primary'}
                    confirm={a.confirmation}
                  />
                  {a.external && <span className="xsmall" style={{ color: 'var(--critical)' }}>external action</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Flash message={message} onDismiss={() => setMessage(null)} />
    </div>
  );
}

/** Conversational editor for a Website Concept (§21). */
export function ConceptEditor({
  mockupId,
  versions,
  shareUrl,
}: {
  mockupId: string;
  versions: { version: number; change_summary: string | null; created_at: string }[];
  shareUrl: string;
}) {
  const { pending, message, run, setMessage } = useAction();
  const [command, setCommand] = useState('');
  const presets = [
    'Make the hero more premium',
    'Make it feel more modern',
    'Add a testimonials section',
    'Add a booking section',
    'Change the CTA to "Book a consultation"',
    'Use a blue accent colour',
    'Give it more whitespace',
    'Rewrite the services copy',
  ];

  return (
    <div className="col" style={{ gap: 10 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!command.trim()) return;
          const c = command;
          setCommand('');
          run(() => A.editConceptAction(mockupId, c));
        }}
        className="row"
        style={{ gap: 8 }}
      >
        <input
          className="input"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Describe the change — e.g. make the hero more premium"
          aria-label="Describe the change"
        />
        <button className="btn btn-primary" type="submit" disabled={pending || !command.trim()}>
          {pending ? 'Editing…' : 'Apply'}
        </button>
      </form>
      <div className="row-wrap">
        {presets.map((p) => (
          <button key={p} className="chip" disabled={pending} onClick={() => run(() => A.editConceptAction(mockupId, p))}>
            {p}
          </button>
        ))}
      </div>

      <div className="row-wrap mt-1">
        <Link href={shareUrl} target="_blank" className="btn btn-sm">
          Open preview
        </Link>
        <ActionButton action={A.shareConceptAction} args={[mockupId, true]} label="Enable sharing" />
        <ActionButton action={A.publishFromConceptAction} args={[mockupId]} label="Publish as website" variant="primary" />
      </div>

      {versions.length > 0 && (
        <div>
          <div className="small strong mb-1">Version history</div>
          <ul className="col" style={{ gap: 4 }}>
            {versions.map((v) => (
              <li key={v.version} className="row" style={{ gap: 8, fontSize: 12.5 }}>
                <span className="mono muted" style={{ minWidth: 26 }}>
                  v{v.version}
                </span>
                <span className="truncate" style={{ flex: 1 }}>
                  {v.change_summary ?? '—'}
                </span>
                <span className="xsmall muted nowrap">{v.created_at.slice(0, 16).replace('T', ' ')}</span>
                {v.version !== versions[0].version && (
                  <ActionButton action={A.rollbackConceptAction} args={[mockupId, v.version]} label="Rollback" confirm={`Roll back to v${v.version}? A new version is created; nothing is lost.`} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Flash message={message} onDismiss={() => setMessage(null)} />
    </div>
  );
}

export function CompleteFollowUpButton({ followUpId }: { followUpId: string }) {
  const { pending, message, run, setMessage } = useAction();
  return (
    <>
      <button className="btn btn-sm" disabled={pending} onClick={() => run(() => A.completeFollowUpAction(followUpId))}>
        {pending ? '…' : 'Done'}
      </button>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </>
  );
}

/** Bulk selection + action bar (§52). */
export function BulkBar({
  ids,
  sequences,
  onClear,
}: {
  ids: string[];
  sequences: { id: string; name: string }[];
  onClear: () => void;
}) {
  const { pending, message, run, setMessage } = useAction();
  const [sequenceId, setSequenceId] = useState(sequences[0]?.id ?? '');

  if (ids.length === 0) return null;

  const actions: { label: string; kind: string; confirm?: string }[] = [
    { label: 'Qualify', kind: 'qualify' },
    { label: 'Enrich', kind: 'enrich' },
    { label: 'Generate concepts', kind: 'generate_mockups', confirm: `Generate concepts for ${ids.length} prospect(s)? This is internal work and sends nothing.` },
    { label: 'Draft outreach', kind: 'generate_outreach', confirm: `Draft outreach for ${ids.length} prospect(s)? Drafts are created only — nothing is sent until you approve each one.` },
    { label: 'Archive', kind: 'archive', confirm: `Archive ${ids.length} record(s)? They will be hidden from every queue.` },
  ];

  return (
    <div className="card" style={{ padding: '9px 12px', position: 'sticky', bottom: 12, zIndex: 20, boxShadow: 'var(--shadow-lg)' }}>
      <div className="row-wrap">
        <strong className="small">{ids.length} selected</strong>
        {actions.map((a) => (
          <button
            key={a.kind}
            className="btn btn-sm"
            disabled={pending}
            onClick={() => {
              if (a.confirm && !window.confirm(a.confirm)) return;
              run(() => A.runBulkActionAction(a.kind, ids, { confirmed: true }));
            }}
          >
            {pending ? '…' : a.label}
          </button>
        ))}
        {sequenceId && (
          <button
            className="btn btn-sm"
            disabled={pending}
            onClick={() => {
              if (!window.confirm(`Enrol ${ids.length} prospect(s) in this sequence? First touches are scheduled outside quiet hours and each send still passes the compliance gate.`)) return;
              run(() => A.runBulkActionAction('add_to_sequence', ids, { confirmed: true, sequenceId }));
            }}
          >
            Add to sequence
          </button>
        )}
        {sequences.length > 1 && (
          <select className="select" style={{ width: 'auto' }} value={sequenceId} onChange={(e) => setSequenceId(e.target.value)}>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onClear} style={{ marginLeft: 'auto' }}>
          Clear
        </button>
      </div>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </div>
  );
}

export function CsvImporter() {
  const { pending, message, run, setMessage } = useAction();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="col" style={{ gap: 10 }}>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="input"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }}
      />
      <textarea
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Or paste CSV here. Required column: name\nname,website,phone,email,category,city,rating,review_count\nBella Crust,,+44 20 7946 0001,,Bakery,London,4.8,126'}
        style={{ minHeight: 110, fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
      <button
        className="btn btn-primary"
        disabled={pending || !text.trim()}
        onClick={() => {
          const fd = new FormData();
          fd.set('text', text);
          run(() => A.importCsvAction(fd));
        }}
      >
        {pending ? 'Importing…' : 'Validate & import'}
      </button>
      <p className="hint">
        Rows are validated and deduplicated against the Prospect Hub before anything is written. Duplicates are skipped and recorded in
        Duplicate Resolution History.
      </p>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </div>
  );
}

export { useAction };

export function ClientApprovalButtons({ approvalId }: { approvalId?: string }) {
  const { pending, message, run, setMessage } = useAction();
  if (!approvalId) return <span className="xsmall muted">No approval request linked to this item yet.</span>;
  return (
    <>
      <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(() => A.resolveApprovalAction(approvalId, 'approved'))}>
        {pending ? '…' : 'Approve'}
      </button>
      <button className="btn btn-sm" disabled={pending} onClick={() => run(() => A.resolveApprovalAction(approvalId, 'revision'))}>
        Request changes
      </button>
      <Flash message={message} onDismiss={() => setMessage(null)} />
    </>
  );
}
