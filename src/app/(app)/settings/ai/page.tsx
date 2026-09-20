import { boot } from '@/lib/boot';
import { requireAuth } from '@/lib/auth';
import { listModels, listTaskRoutes, modelComparison, usageSummary, listBenchmarks } from '@/lib/ai/router';
import { providers } from '@/lib/providers/registry';
import { getSecret } from '@/lib/secrets';
import { Card, Badge, SectionHead, Stats, Table, Banner, EmptyState } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Sparkles, CheckCircle2, Circle, AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Forge AI' };
export const dynamic = 'force-dynamic';

export default async function ForgeAiSettingsPage() {
  const orgId = boot();
  await requireAuth();

  const models = listModels(orgId);
  const routes = listTaskRoutes(orgId);
  const comparison = modelComparison(orgId);
  const usage = usageSummary(orgId, 30);
  const benchmarks = listBenchmarks(orgId, 20);

  const hostedConfigured = ['openai', 'anthropic', 'google'].filter((k) => !!getSecret(orgId, k));
  const ollamaModels = models.filter((m) => m.provider_key === 'ollama');
  const localActive = models.some((m) => m.provider_key === 'local' && m.usable);

  const primary = routes.length ? routes[0].selected : null;

  return (
    <>
      <div className="mb-2">
        <h1 className="row" style={{ gap: 8 }}>
          <Sparkles size={19} style={{ color: 'var(--ai)' }} />
          Forge AI
        </h1>
        <p className="small muted">
          Task-specific model routing with automatic fallback. No model is hard-coded to a task — each is chosen on quality, cost, latency and
          measured reliability.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Requests (30d)', value: usage.calls },
          { label: 'Errors', value: usage.errors, tone: usage.errors > 0 ? 'critical' : undefined },
          { label: 'Estimated cost', value: `$${usage.cost.toFixed(4)}` },
          { label: 'Tokens in', value: usage.tokensIn.toLocaleString() },
          { label: 'Tokens out', value: usage.tokensOut.toLocaleString() },
          { label: 'Avg latency', value: `${Math.round(usage.avgLatency)}ms` },
        ]}
      />

      {/* ── Provider status ─────────────────────────────────── */}
      <SectionHead title="Providers" hint="Implemented ≠ configured ≠ tested" />
      <Card tight>
        <Table head={[{ label: 'Provider' }, { label: 'Cost' }, { label: 'Status' }, { label: 'Models' }, { label: 'Fallback' }]}>
          <tr>
            <td>
              <div className="small strong">Local grounded engine</div>
              <div className="xsmall muted">Deterministic. Grounded only in supplied facts. No network egress.</div>
            </td>
            <td>
              <Badge tone="success">free</Badge>
            </td>
            <td>
              <div className="row" style={{ gap: 5 }}>
                <span style={{ color: localActive ? 'var(--success)' : 'var(--text-3)' }}>{localActive ? '●' : '○'}</span>
                <span className="small">{localActive ? 'Active (always available)' : 'Unavailable'}</span>
              </div>
            </td>
            <td className="small">{models.filter((m) => m.provider_key === 'local').length}</td>
            <td className="xsmall muted">Terminal fallback — never fails</td>
          </tr>
          <tr>
            <td>
              <div className="small strong">Ollama (local, open-weight)</div>
              <div className="xsmall muted">Free, private, no rate limits, no data egress. Needs an Ollama server.</div>
            </td>
            <td>
              <Badge tone="success">free</Badge>
            </td>
            <td>
              <div className="row" style={{ gap: 5 }}>
                <span style={{ color: ollamaModels.some((m) => m.usable) ? 'var(--success)' : 'var(--text-3)' }}>
                  {ollamaModels.some((m) => m.usable) ? '●' : '○'}
                </span>
                <span className="small">{ollamaModels.some((m) => m.usable) ? 'Server reachable' : 'Not detected'}</span>
              </div>
              <div className="xsmall muted">OLLAMA_HOST or http://localhost:11434</div>
            </td>
            <td className="small">{ollamaModels.length}</td>
            <td className="xsmall muted">Falls through to local engine</td>
          </tr>
          {[
            { key: 'openai', label: 'OpenAI', cost: 'paid', detail: 'GPT-4o / GPT-4.1 / o-series' },
            { key: 'anthropic', label: 'Anthropic', cost: 'paid', detail: 'Claude Haiku / Sonnet / Opus' },
            { key: 'google', label: 'Google', cost: 'free-tier', detail: 'Gemini Flash / Pro — free tier available' },
          ].map((p) => {
            const configured = !!getSecret(orgId, p.key);
            return (
              <tr key={p.key}>
                <td>
                  <div className="small strong">{p.label}</div>
                  <div className="xsmall muted">{p.detail}</div>
                </td>
                <td>
                  <Badge tone={p.cost === 'free-tier' ? 'accent' : 'warning'}>{p.cost}</Badge>
                </td>
                <td>
                  <div className="row" style={{ gap: 5 }}>
                    <span style={{ color: configured ? 'var(--success)' : 'var(--text-3)' }}>{configured ? '●' : '○'}</span>
                    <span className="small">{configured ? 'Configured' : 'Not configured'}</span>
                  </div>
                </td>
                <td className="small">{models.filter((m) => m.provider_key === p.key).length}</td>
                <td className="xsmall muted">Falls through to Ollama, then local</td>
              </tr>
            );
          })}
        </Table>
      </Card>

      {hostedConfigured.length === 0 && (
        <div className="mt-2">
          <Banner tone="accent" icon={<CheckCircle2 size={15} />}>
            <strong>No hosted AI is configured, and that is fully supported.</strong> ClientForge runs on the local grounded engine, which produces
            output grounded only in supplied facts and never fabricates business information. Add a key to upgrade reasoning quality —{' '}
            <strong>Ollama gives you that for free with no data leaving the machine.</strong>
          </Banner>
        </div>
      )}

      {/* ── Task routing ────────────────────────────────────── */}
      <SectionHead title="Task routing" hint="Each task picks its own model; nothing is hard-coded" />
      <Card tight>
        <Table head={[{ label: 'Task' }, { label: 'Priority' }, { label: 'Selected model' }, { label: 'Why' }, { label: 'Route' }]}>
          {routes.map((r) => (
            <tr key={r.id}>
              <td className="small strong">{r.label}</td>
              <td>
                <Badge tone="accent">{r.priority}</Badge>
              </td>
              <td>
                <div className="small">{r.selected.modelLabel}</div>
                <Badge tone={r.selected.live ? 'success' : ''}>{r.selected.live ? 'hosted' : 'local'}</Badge>
              </td>
              <td className="xsmall muted" style={{ maxWidth: 300 }}>
                {r.selected.reason}
              </td>
              <td>
                <form>
                  <select
                    className="select"
                    name="model"
                    defaultValue=""
                    onChange={undefined}
                    style={{ minWidth: 150 }}
                  >
                    <option value="">Auto (best match)</option>
                    {models
                      .filter((m) => m.usable)
                      .map((m) => (
                        <option key={m.id} value={m.model_id}>
                          {m.label}
                        </option>
                      ))}
                  </select>
                </form>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {/* ── Model comparison ────────────────────────────────── */}
      <SectionHead title="Model comparison" hint="Quality / cost / speed" />
      <Card tight>
        <Table
          head={[
            { label: 'Model' },
            { label: 'Tier' },
            { label: 'Quality', align: 'right' },
            { label: 'Accuracy', align: 'right' },
            { label: 'Latency', align: 'right' },
            { label: 'Cost /1k', align: 'right' },
            { label: 'Usable' },
          ]}
        >
          {comparison.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="small strong">{m.label}</div>
                <div className="xsmall muted">{m.provider}</div>
              </td>
              <td>
                <Badge>{m.tier}</Badge>
              </td>
              <td className="num small">{Math.round(m.quality * 100)}</td>
              <td className="num small">{m.accuracy === null ? '—' : Math.round(m.accuracy * 100)}</td>
              <td className="num small">{Math.round(m.speedMs)}ms</td>
              <td className="num small">{m.costPer1k === 0 ? 'free' : `$${m.costPer1k.toFixed(5)}`}</td>
              <td>{m.usable ? <Badge tone="success">yes</Badge> : <Badge>no</Badge>}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <SectionHead
        title="Benchmarks"
        hint="Measured, not assumed"
        right={<ActionButton action={A.runEvaluationAction} label="Run benchmark" variant="primary" />}
      />
      {benchmarks.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={17} />}
          title="No benchmarks yet"
          body="Run a benchmark to measure accuracy, latency and failure rate per model per task. Results feed the router, so routing improves from evidence rather than assumption."
          action={<ActionButton action={A.runEvaluationAction} label="Run benchmark" variant="primary" />}
        />
      ) : (
        <Card tight>
          <Table head={[{ label: 'Model' }, { label: 'Task' }, { label: 'Accuracy', align: 'right' }, { label: 'Latency', align: 'right' }, { label: 'Cost', align: 'right' }]}>
            {benchmarks.map((b, i) => (
              <tr key={String(b.id ?? i)}>
                <td className="small">{String(b.model_label ?? b.model_id)}</td>
                <td className="small">{String(b.task).replace(/_/g, ' ')}</td>
                <td className="num small">{Math.round(Number(b.accuracy ?? 0) * 100)}</td>
                <td className="num small">{Math.round(Number(b.latency_ms ?? 0))}ms</td>
                <td className="num small">{Number(b.cost ?? 0) === 0 ? 'free' : `$${Number(b.cost).toFixed(5)}`}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <div className="mt-2">
        <Banner tone="warning" icon={<AlertTriangle size={15} />}>
          <strong>Honesty rule:</strong> output produced by the local grounded engine is never labelled &ldquo;AI generated&rdquo;. Only a real hosted
          or Ollama response is reported as model-generated. Where a model could not be reached, the fallback is recorded as a fallback.
        </Banner>
      </div>
    </>
  );
}
