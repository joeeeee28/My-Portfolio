/**
 * AI model router (§43) with usage + cost accounting (§65) and evaluation (§66).
 *
 * Selection order for a task:
 *   1. an explicit per-task override, if usable
 *   2. the best-scoring *available* model for the task's priority
 *      (quality | balanced | cost | speed)
 *   3. the local grounded engine, which is always available
 *
 * A model is only "available" when its provider is configured — the local
 * provider needs no credentials, so routing always resolves.
 */
import { all, get, run, scalar, toJson } from '@/db';
import { id, nowIso } from '@/lib/id';
import { AI_TASKS, type AiTaskKey } from '@/lib/domain';
import { MODEL_CATALOGUE, localProvider, specFor, type ModelSpec } from './catalogue';
import { providerCredential, providers } from '@/lib/providers/registry';
import type { AiRequest, AiResponse } from '@/lib/providers/registry';
import { getSettings } from '@/lib/settings';
import { logAutomation } from '@/lib/logging';

const TIER_RANK: Record<string, number> = { nano: 1, standard: 2, strong: 3, vision: 3, image: 4 };

export interface RouteDecision {
  task: string;
  providerKey: string;
  modelId: string;
  modelLabel: string;
  reason: string;
  live: boolean;
  score: number;
}

export function registerModelCatalogue(orgId: string): void {
  for (const m of MODEL_CATALOGUE) {
    const ready = isProviderReady(orgId, m.providerKey) ? 1 : 0;
    const existing = get<{ id: string }>('SELECT id FROM ai_models WHERE org_id = ? AND provider_key = ? AND model_id = ?', [
      orgId,
      m.providerKey,
      m.modelId,
    ]);
    if (existing) {
      run(
        `UPDATE ai_models SET label = ?, tier = ?, supports = ?, quality_score = ?, speed_ms = ?,
                cost_per_1k_in = ?, cost_per_1k_out = ?, context_window = ?, credentials_ready = ?, updated_at = ?
          WHERE id = ?`,
        [
          m.label, m.tier, toJson(m.capabilities), m.quality, m.speedMs, m.costPer1kIn, m.costPer1kOut,
          m.contextWindow, ready, nowIso(), existing.id,
        ]
      );
    } else {
      run(
        `INSERT INTO ai_models (id, org_id, provider_key, model_id, label, tier, supports, quality_score, speed_ms,
            cost_per_1k_in, cost_per_1k_out, context_window, enabled, credentials_ready, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
        [
          id('mdl'), orgId, m.providerKey, m.modelId, m.label, m.tier, toJson(m.capabilities), m.quality, m.speedMs,
          m.costPer1kIn, m.costPer1kOut, m.contextWindow, ready, m.notes ?? null, nowIso(), nowIso(),
        ]
      );
    }
  }
  ensureTaskRoutes(orgId);
}

function isProviderReady(orgId: string, providerKey: string): boolean {
  if (providerKey === 'local') return true;
  const p = providers.ai.find((x) => x.key === providerKey);
  if (!p) return false;
  return p.requiresCredentials ? !!providerCredential(orgId, providerKey) : true;
}

export function ensureTaskRoutes(orgId: string): void {
  for (const task of AI_TASKS) {
    const existing = get<{ id: string }>('SELECT id FROM ai_task_routes WHERE org_id = ? AND task = ?', [orgId, task.key]);
    if (!existing) {
      run(
        `INSERT INTO ai_task_routes (id, org_id, task, label, preferred_model_id, fallback_model_ids, priority, override, created_at, updated_at)
         VALUES (?,?,?,?,?,'[]',?,0,?,?)`,
        [id('rte'), orgId, task.key, task.label, null, task.priority, nowIso(), nowIso()]
      );
    }
  }
}

export interface ModelRow {
  id: string;
  org_id: string;
  provider_key: string;
  model_id: string;
  label: string;
  tier: string;
  supports: string;
  quality_score: number;
  speed_ms: number;
  cost_per_1k_in: number;
  cost_per_1k_out: number;
  context_window: number;
  enabled: number;
  credentials_ready: number;
  failure_rate: number;
  avg_latency_ms: number | null;
  notes: string | null;
}

export function listModels(orgId: string): (ModelRow & { usable: boolean; supportsList: string[] })[] {
  registerModelCatalogue(orgId);
  return all<ModelRow>('SELECT * FROM ai_models WHERE org_id = ? ORDER BY provider_key, tier DESC, model_id', [orgId]).map(
    (m) => ({
      ...m,
      usable: m.enabled === 1 && m.credentials_ready === 1,
      supportsList: safeJson<string[]>(m.supports, []),
    })
  );
}

export function listTaskRoutes(orgId: string) {
  ensureTaskRoutes(orgId);
  const models = listModels(orgId);
  return all<{
    id: string;
    task: string;
    label: string;
    preferred_model_id: string | null;
    priority: string;
    override: number;
  }>('SELECT * FROM ai_task_routes WHERE org_id = ? ORDER BY task', [orgId]).map((r) => {
    const decision = resolveRoute(orgId, r.task as AiTaskKey);
    return {
      ...r,
      selected: decision,
      candidates: rankCandidates(models, r.task as AiTaskKey, r.priority as Priority).slice(0, 4),
    };
  });
}

export type Priority = 'quality' | 'balanced' | 'cost' | 'speed';

export function setTaskRoute(
  orgId: string,
  task: string,
  opts: { modelId?: string | null; priority?: Priority; override?: boolean }
): void {
  ensureTaskRoutes(orgId);
  const model = opts.modelId
    ? get<{ id: string }>('SELECT id FROM ai_models WHERE org_id = ? AND model_id = ?', [orgId, opts.modelId])
    : null;
  run(
    `UPDATE ai_task_routes SET preferred_model_id = ?, priority = COALESCE(?, priority),
            override = ?, updated_at = ? WHERE org_id = ? AND task = ?`,
    [model?.id ?? null, opts.priority ?? null, opts.override ? 1 : 0, nowIso(), orgId, task]
  );
}

function safeJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Scores a model for a task under a priority. Returns null when the model
 * cannot serve the task (missing capability, too small a context, unusable).
 */
function scoreModel(
  m: ModelRow & { usable: boolean; supportsList: string[] },
  task: AiTaskKey,
  priority: Priority,
  needsTokens: number
): { score: number; reason: string } | null {
  if (!m.usable) return null;
  if (m.context_window && needsTokens > m.context_window) return null;

  const spec = AI_TASKS.find((t) => t.key === task);
  const minTier = spec?.minTier ?? 'standard';
  const capable =
    m.supportsList.includes('text') ||
    m.supportsList.includes(task) ||
    m.tier === minTier ||
    TIER_RANK[m.tier] >= TIER_RANK[minTier];
  if (!capable && m.provider_key !== 'local') return null;

  const quality = m.quality_score;
  const speed = 1 - Math.min(1, m.speed_ms / 5000);
  const cost = 1 - Math.min(1, (m.cost_per_1k_in + m.cost_per_1k_out) / 0.09);
  const reliability = 1 - Math.min(1, m.failure_rate * 5);

  const weights: Record<Priority, [number, number, number, number]> = {
    quality: [0.62, 0.1, 0.13, 0.15],
    balanced: [0.4, 0.22, 0.23, 0.15],
    cost: [0.18, 0.17, 0.5, 0.15],
    speed: [0.18, 0.5, 0.17, 0.15],
  };
  const [wq, ws, wc, wr] = weights[priority];
  const score = quality * wq + speed * ws + cost * wc + reliability * wr;
  return { score, reason: `${priority} weighting — q${quality.toFixed(2)}/s${m.speed_ms}ms/$${(m.cost_per_1k_in + m.cost_per_1k_out).toFixed(4)}per1k` };
}

function rankCandidates(
  models: (ModelRow & { usable: boolean; supportsList: string[] })[],
  task: AiTaskKey,
  priority: Priority,
  needsTokens = 4000
) {
  return models
    .map((m) => ({ model: m, scored: scoreModel(m, task, priority, needsTokens) }))
    .filter((x): x is { model: typeof x.model; scored: { score: number; reason: string } } => x.scored !== null)
    .sort((a, b) => b.scored.score - a.scored.score);
}

export function resolveRoute(orgId: string, task: AiTaskKey, needsTokens = 4000): RouteDecision {
  const models = listModels(orgId);
  const route = get<{ preferred_model_id: string | null; priority: string }>(
    'SELECT preferred_model_id, priority FROM ai_task_routes WHERE org_id = ? AND task = ?',
    [orgId, task]
  );
  const spec = AI_TASKS.find((t) => t.key === task);
  const settings = getSettings(orgId);
  let priority = (route?.priority ?? spec?.priority ?? settings.ai.defaultPriority) as Priority;

  // Budget guard (§65): if spend is near the monthly budget, prefer cheap models.
  if (settings.ai.autoDowngradeOnBudget) {
    const spent = monthlySpend(orgId);
    if (settings.ai.monthlyBudgetUsd > 0 && spent >= settings.ai.monthlyBudgetUsd * (settings.ai.costAlertPct / 100)) {
      priority = 'cost';
    }
  }

  if (route?.preferred_model_id) {
    const m = models.find((x) => x.id === route.preferred_model_id);
    if (m) {
      const scored = scoreModel(m, task, priority, needsTokens);
      if (scored) {
        return {
          task,
          providerKey: m.provider_key,
          modelId: m.model_id,
          modelLabel: m.label,
          reason: `Explicit route for ${spec?.label ?? task} (${scored.reason})`,
          live: m.provider_key !== 'local',
          score: scored.score,
        };
      }
    }
  }

  const ranked = rankCandidates(models, task, priority, needsTokens);
  if (ranked.length) {
    const best = ranked[0];
    return {
      task,
      providerKey: best.model.provider_key,
      modelId: best.model.model_id,
      modelLabel: best.model.label,
      reason: `Best ${priority} match for ${spec?.label ?? task} — ${best.scored.reason}`,
      live: best.model.provider_key !== 'local',
      score: best.scored.score,
    };
  }

  return {
    task,
    providerKey: 'local',
    modelId: 'local-grounded-v1',
    modelLabel: 'Local grounded engine',
    reason: 'No hosted model available for this task — using the offline grounded engine.',
    live: false,
    score: 0.3,
  };
}

export interface AiOutcome extends AiResponse {
  route: RouteDecision;
  fellBack: boolean;
}

/**
 * Runs a task through the router with automatic fallback.
 * Every attempt is written to `ai_model_usage` and `cost_ledger`.
 */
export async function runAiTask(
  orgId: string,
  task: AiTaskKey,
  request: AiRequest,
  opts: { entityType?: string; entityId?: string; needsTokens?: number } = {}
): Promise<AiOutcome> {
  const needsTokens = opts.needsTokens ?? Math.ceil(((request.prompt?.length ?? 0) + (request.system?.length ?? 0)) / 4) + 800;
  const route = resolveRoute(orgId, task, needsTokens);
  const tried: string[] = [];

  const attempt = async (r: RouteDecision): Promise<AiOutcome | null> => {
    if (tried.includes(`${r.providerKey}:${r.modelId}`)) return null;
    tried.push(`${r.providerKey}:${r.modelId}`);
    const provider = providers.ai.find((p) => p.key === r.providerKey) ?? (r.providerKey === 'local' ? localProvider : undefined);
    if (!provider) return null;
    const started = Date.now();
    let res: AiResponse;
    try {
      res = await provider.complete(orgId, r.modelId, { ...request, task });
    } catch (err) {
      res = {
        text: '',
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: Date.now() - started,
        model: r.modelId,
        live: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const status = res.error ? 'error' : 'ok';
    recordUsage(orgId, task, r, res, status, opts.entityType, opts.entityId);
    if (res.error || (!res.text && !res.json)) {
      logAutomation(orgId, 'ai', `AI task ${task} failed on ${r.modelLabel}: ${res.error ?? 'empty response'}`, {
        level: 'warn',
        entityType: opts.entityType,
        entityId: opts.entityId,
        detail: { task, model: r.modelId, error: res.error },
        retryable: true,
      });
      return null;
    }
    return { ...res, route: r, fellBack: tried.length > 1 };
  };

  const first = await attempt(route);
  if (first) return first;

  // Provider fallbacks (§64) — walk the ranked candidate list.
  const models = listModels(orgId);
  const spec = AI_TASKS.find((t) => t.key === task);
  const ranked = rankCandidates(models, task, (spec?.priority ?? 'balanced') as Priority, needsTokens);
  for (const candidate of ranked) {
    const next: RouteDecision = {
      task,
      providerKey: candidate.model.provider_key,
      modelId: candidate.model.model_id,
      modelLabel: candidate.model.label,
      reason: `Fallback after ${route.modelLabel} failed`,
      live: candidate.model.provider_key !== 'local',
      score: candidate.scored.score,
    };
    const out = await attempt(next);
    if (out) return out;
  }

  // The local engine is the final guarantee — it never errors.
  const local: RouteDecision = {
    task,
    providerKey: 'local',
    modelId: 'local-grounded-v1',
    modelLabel: 'Local grounded engine',
    reason: 'All hosted attempts failed; grounded local engine used.',
    live: false,
    score: 0.3,
  };
  const provider = localProvider;
  const started = Date.now();
  const res = await provider.complete(orgId, 'local-grounded-v1', { ...request, task });
  recordUsage(orgId, task, local, res, 'fallback', opts.entityType, opts.entityId);
  return { ...res, route: local, fellBack: true };
}

function recordUsage(
  orgId: string,
  task: string,
  route: RouteDecision,
  res: AiResponse,
  status: string,
  entityType?: string,
  entityId?: string
): void {
  const model = get<{ id: string }>('SELECT id FROM ai_models WHERE org_id = ? AND provider_key = ? AND model_id = ?', [
    orgId,
    route.providerKey,
    route.modelId,
  ]);
  const now = nowIso();
  run(
    `INSERT INTO ai_model_usage
       (id, org_id, task, model_id, provider_key, model_label, status, latency_ms, tokens_in, tokens_out, cost, error, entity_type, entity_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('aiu'), orgId, task, model?.id ?? null, route.providerKey, route.modelLabel, status,
      res.latencyMs, res.tokensIn, res.tokensOut, res.cost, res.error ?? null,
      entityType ?? null, entityId ?? null, now,
    ]
  );
  if (res.cost > 0) {
    run(
      `INSERT INTO cost_ledger (id, org_id, category, provider_key, business_id, amount, units, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id('cst'), orgId, 'ai_research', route.providerKey, entityId ?? null, res.cost, 1, `${task} · ${route.modelLabel}`, now]
    );
  }
  // Rolling reliability + latency, feeding the next routing decision (§66).
  if (model) {
    const stats = get<{ c: number; f: number; avg: number }>(
      `SELECT COUNT(*) c, SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) f, AVG(latency_ms) avg
         FROM ai_model_usage WHERE model_id = ?`,
      [model.id]
    );
    if (stats?.c) {
      run('UPDATE ai_models SET failure_rate = ?, avg_latency_ms = ?, updated_at = ? WHERE id = ?', [
        Math.min(1, (stats.f ?? 0) / stats.c),
        Math.round(stats.avg ?? 0),
        now,
        model.id,
      ]);
    }
  }
}

// ── Cost reporting (§65) ─────────────────────────────────────
export function monthlySpend(orgId: string): number {
  const month = nowIso().slice(0, 7);
  return scalar<number>(
    `SELECT COALESCE(SUM(cost),0) FROM ai_model_usage WHERE org_id = ? AND substr(created_at,1,7) = ?`,
    [orgId, month]
  ) ?? 0;
}

export function usageSummary(orgId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const totals = get<{ calls: number; cost: number; tokensIn: number; tokensOut: number; errors: number; avgLatency: number }>(
    `SELECT COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(SUM(tokens_in),0) tokensIn,
            COALESCE(SUM(tokens_out),0) tokensOut,
            COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END),0) errors,
            COALESCE(AVG(latency_ms),0) avgLatency
       FROM ai_model_usage WHERE org_id = ? AND created_at >= ?`,
    [orgId, since]
  );
  const byTask = all<{ task: string; calls: number; cost: number; avg_ms: number }>(
    `SELECT task, COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(AVG(latency_ms),0) avg_ms
       FROM ai_model_usage WHERE org_id = ? AND created_at >= ? GROUP BY task ORDER BY cost DESC, calls DESC`,
    [orgId, since]
  );
  const byModel = all<{ model_label: string; provider_key: string; calls: number; cost: number; errors: number; avg_ms: number }>(
    `SELECT model_label, provider_key, COUNT(*) calls, COALESCE(SUM(cost),0) cost,
            COALESCE(SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END),0) errors, COALESCE(AVG(latency_ms),0) avg_ms
       FROM ai_model_usage WHERE org_id = ? AND created_at >= ? GROUP BY model_label, provider_key ORDER BY calls DESC`,
    [orgId, since]
  );
  return { since, ...(totals ?? { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0, errors: 0, avgLatency: 0 }), byTask, byModel };
}

// ── Model evaluation (§66) ───────────────────────────────────
export const BENCHMARK_TASKS: { task: AiTaskKey; label: string; prompt: string; expect: string[] }[] = [
  {
    task: 'classification',
    label: 'Business classification',
    prompt: 'Classify this business into one primary industry. Input: "Bella Crust — wood-fired sourdough, croissants and celebration cakes, open since 2019."',
    expect: ['food', 'bakery', 'hospitality'],
  },
  {
    task: 'lead_scoring',
    label: 'Lead scoring rationale',
    prompt: 'Explain in two sentences why a bakery with 4.9 stars from 210 reviews and no website is a high-priority prospect.',
    expect: ['review', 'website'],
  },
  {
    task: 'outreach',
    label: 'Outreach personalization',
    prompt: 'Write a two-sentence cold email opener for a dental clinic whose site has no booking system and is not mobile friendly.',
    expect: ['booking', 'mobile'],
  },
  {
    task: 'website_copy',
    label: 'Website copy',
    prompt: 'Write a homepage hero headline and subheadline for a family-run plumbing company serving emergency callouts.',
    expect: ['plumb', 'emergency'],
  },
  {
    task: 'summarization',
    label: 'Summarization',
    prompt: 'Summarize: The client wants five pages, a booking form, and Google Business Profile optimization. Budget is tight. Timeline six weeks.',
    expect: ['booking', 'page'],
  },
  {
    task: 'proposal',
    label: 'Proposal generation',
    prompt: 'Draft a three-line problem statement for a proposal to a gym whose website cannot be reached on mobile devices.',
    expect: ['mobile', 'website'],
  },
];

export interface BenchmarkResult {
  modelId: string;
  modelLabel: string;
  task: string;
  accuracy: number;
  quality: number;
  latencyMs: number;
  cost: number;
  failureRate: number;
  recommendation: string;
}

/**
 * Runs the internal benchmark suite against every usable model.
 * Accuracy here is keyword-recall against the benchmark's expected terms —
 * a cheap, honest proxy, not a claim of human evaluation.
 */
export async function runModelEvaluation(orgId: string, tasks?: AiTaskKey[]): Promise<BenchmarkResult[]> {
  const models = listModels(orgId).filter((m) => m.usable);
  const results: BenchmarkResult[] = [];
  const suite = BENCHMARK_TASKS.filter((b) => !tasks?.length || tasks.includes(b.task));

  for (const model of models) {
    for (const bench of suite) {
      const spec = AI_TASKS.find((t) => t.key === bench.task);
      const capable =
        model.supportsList.includes('text') ||
        model.supportsList.includes(bench.task) ||
        TIER_RANK[model.tier] >= TIER_RANK[spec?.minTier ?? 'standard'];
      if (!capable && model.provider_key !== 'local') continue;

      const provider = providers.ai.find((p) => p.key === model.provider_key) ?? (model.provider_key === 'local' ? localProvider : undefined);
      if (!provider) continue;

      const started = Date.now();
      let text = '';
      let failed = false;
      try {
        const res = await provider.complete(orgId, model.model_id, { task: bench.task, prompt: bench.prompt, maxTokens: 400 });
        text = res.error ? '' : res.text;
        failed = !!res.error;
      } catch {
        failed = true;
      }
      const latency = Date.now() - started;
      const lower = text.toLowerCase();
      const hits = bench.expect.filter((e) => lower.includes(e)).length;
      const accuracy = failed ? 0 : hits / bench.expect.length;
      const quality = failed ? 0 : Math.min(1, 0.35 + accuracy * 0.45 + Math.min(0.2, text.length / 1200));
      const cost = ((specFor(model.provider_key, model.model_id)?.costPer1kIn ?? 0) * estimate(bench.prompt)) / 1000 +
        ((specFor(model.provider_key, model.model_id)?.costPer1kOut ?? 0) * 200) / 1000;

      results.push({
        modelId: model.model_id,
        modelLabel: model.label,
        task: bench.task,
        accuracy: Number(accuracy.toFixed(3)),
        quality: Number(quality.toFixed(3)),
        latencyMs: latency,
        cost: Number(cost.toFixed(6)),
        failureRate: failed ? 1 : 0,
        recommendation: '',
      });

      run(
        `INSERT INTO model_benchmarks
           (id, org_id, model_id, task, accuracy, quality, latency_ms, cost, failure_rate, samples, recommendation, run_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`,
        [
          id('bmk'), orgId, model.id, bench.task, accuracy, quality, latency, cost, failed ? 1 : 0,
          '', nowIso(), nowIso(),
        ]
      );
    }
  }

  // Recommend the best model per task on a quality-per-dollar basis.
  const bestByTask: Record<string, BenchmarkResult> = {};
  for (const r of results) {
    const value = (r.quality + r.accuracy) / 2 - Math.min(0.3, r.cost * 8) - Math.min(0.2, r.latencyMs / 20_000);
    const current = bestByTask[r.task];
    if (!current) {
      bestByTask[r.task] = { ...r, recommendation: `Best for ${r.task}` };
      r.recommendation = `Best for ${r.task}`;
    } else {
      const currentValue = (current.quality + current.accuracy) / 2 - Math.min(0.3, current.cost * 8) - Math.min(0.2, current.latencyMs / 20_000);
      if (value > currentValue) {
        bestByTask[current.task].recommendation = '';
        bestByTask[r.task] = { ...r, recommendation: `Best for ${r.task}` };
        r.recommendation = `Best for ${r.task}`;
      }
    }
  }
  return results;
}

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export function listBenchmarks(orgId: string, limit = 200) {
  return all(
    `SELECT b.*, m.label model_label, m.provider_key FROM model_benchmarks b
       LEFT JOIN ai_models m ON m.id = b.model_id
      WHERE b.org_id = ? ORDER BY b.run_at DESC, b.task LIMIT ?`,
    [orgId, limit]
  );
}

/** Quality / cost / speed comparison table for the Settings → AI screen. */
export function modelComparison(orgId: string) {
  const models = listModels(orgId);
  const benchmarks = all<{ model_id: string; accuracy: number; quality: number; latency_ms: number; cost: number; failure_rate: number }>(
    'SELECT model_id, accuracy, quality, latency_ms, cost, failure_rate FROM model_benchmarks WHERE org_id = ?',
    [orgId]
  );
  return models.map((m) => {
    const own = benchmarks.filter((b) => b.model_id === m.id);
    const avgOf = (f: (b: (typeof own)[number]) => number) =>
      own.length ? own.reduce((a, b) => a + f(b), 0) / own.length : null;
    return {
      id: m.id,
      provider: m.provider_key,
      modelId: m.model_id,
      label: m.label,
      tier: m.tier,
      usable: m.usable,
      quality: avgOf((b) => b.quality) ?? m.quality_score,
      accuracy: avgOf((b) => b.accuracy),
      speedMs: avgOf((b) => b.latency_ms) ?? m.speed_ms,
      costPer1k: m.cost_per_1k_in + m.cost_per_1k_out,
      failureRate: avgOf((b) => b.failure_rate) ?? m.failure_rate,
      contextWindow: m.context_window,
      samples: own.length,
    };
  });
}
