/**
 * Experimentation (§48) and AI self-improvement (§67).
 *
 * Experiments record impressions and conversions per variant. Recommendations
 * are only emitted when the sample is large enough to mean something, and the
 * system never changes a critical automation rule on its own — it proposes,
 * shows the evidence, and waits for the user to accept.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { id, nowIso, round } from '@/lib/id';
import { logActivity } from '@/lib/activity';
import { recordOutcome } from './scoring';

export interface ExperimentRow {
  id: string;
  org_id: string;
  name: string;
  hypothesis: string | null;
  target: string;
  metric: string;
  status: string;
  split: string;
  winner: string | null;
  recommendation: string | null;
  started_at: string | null;
}

export interface VariantRow {
  id: string;
  experiment_id: string;
  variant_key: string;
  label: string;
  payload: string;
  impressions: number;
  conversions: number;
  secondary: number;
  revenue: number;
}

export function listExperiments(orgId: string): (ExperimentRow & { variants: (VariantRow & { rate: number })[]; leader: string | null; confidence: string })[] {
  const rows = all<ExperimentRow>('SELECT * FROM experiments WHERE org_id = ? ORDER BY status = \'running\' DESC, created_at DESC', [orgId]);
  return rows.map((e) => {
    const variants = all<VariantRow>('SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY variant_key', [e.id]).map((v) => ({
      ...v,
      rate: v.impressions ? round((v.conversions / v.impressions) * 100, 2) : 0,
    }));
    const analysis = analyseVariants(variants, e.metric);
    return { ...e, variants, leader: analysis.leader, confidence: analysis.confidence };
  });
}

/**
 * Two-proportion comparison. Reports "insufficient data" rather than declaring
 * a winner on noise — a false recommendation is worse than no recommendation.
 */
export function analyseVariants(variants: (VariantRow & { rate: number })[], metric: string): { leader: string | null; confidence: string; detail: string } {
  const withData = variants.filter((v) => v.impressions >= 20);
  if (withData.length < 2) {
    const total = variants.reduce((a, v) => a + v.impressions, 0);
    return {
      leader: null,
      confidence: 'insufficient',
      detail: `${total} impression(s) recorded. At least 20 per variant is needed before a comparison means anything.`,
    };
  }
  const sorted = [...withData].sort((a, b) => b.rate - a.rate);
  const best = sorted[0];
  const second = sorted[1];

  // Two-proportion z-test.
  const p1 = best.conversions / best.impressions;
  const p2 = second.conversions / second.impressions;
  const pooled = (best.conversions + second.conversions) / (best.impressions + second.impressions);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / best.impressions + 1 / second.impressions)) || 1e-9;
  const z = (p1 - p2) / se;
  const significant = Math.abs(z) >= 1.96;
  const lift = p2 > 0 ? round(((p1 - p2) / p2) * 100, 1) : null;

  return {
    leader: significant ? best.variant_key : null,
    confidence: significant ? 'significant' : 'inconclusive',
    detail: significant
      ? `${best.label} leads ${best.label && second.label ? 'over ' + second.label : ''} at ${best.rate}% vs ${second.rate}% (${lift !== null ? `${lift > 0 ? '+' : ''}${lift}%` : 'n/a'} lift, z=${round(z, 2)}).`
      : `Difference is not statistically meaningful yet (${best.rate}% vs ${second.rate}%, z=${round(z, 2)}). Keep running.`,
  };
}

export function recordImpression(orgId: string, experimentId: string, variantKey: string): void {
  run('UPDATE experiment_variants SET impressions = impressions + 1 WHERE experiment_id = ? AND variant_key = ?', [experimentId, variantKey]);
}

export function recordConversion(orgId: string, experimentId: string, variantKey: string, opts: { secondary?: boolean; revenue?: number; businessId?: string } = {}): void {
  run(
    `UPDATE experiment_variants SET conversions = conversions + ?, secondary = secondary + ?, revenue = revenue + ?
      WHERE experiment_id = ? AND variant_key = ?`,
    [1, opts.secondary ? 1 : 0, opts.revenue ?? 0, experimentId, variantKey]
  );
  if (opts.businessId) recordOutcome(orgId, 'outreach_variant', opts.businessId, { variantId: `${experimentId}:${variantKey}`, value: opts.revenue ?? 1 });
}

/** Assigns a variant deterministically per business so allocation stays stable. */
export function assignVariant(orgId: string, target: string, businessId: string): { experimentId: string; variantKey: string } | null {
  const experiment = get<{ id: string }>(
    "SELECT id FROM experiments WHERE org_id = ? AND target = ? AND status = 'running' ORDER BY created_at ASC LIMIT 1",
    [orgId, target]
  );
  if (!experiment) return null;
  const variants = all<{ variant_key: string }>('SELECT variant_key FROM experiment_variants WHERE experiment_id = ? ORDER BY variant_key', [experiment.id]);
  if (!variants.length) return null;
  let h = 0;
  for (let i = 0; i < businessId.length; i++) h = (h * 31 + businessId.charCodeAt(i)) >>> 0;
  const chosen = variants[h % variants.length].variant_key;
  recordImpression(orgId, experiment.id, chosen);
  return { experimentId: experiment.id, variantKey: chosen };
}

export function concludeExperiment(orgId: string, experimentId: string): { winner: string | null; recommendation: string } {
  const experiment = get<ExperimentRow>('SELECT * FROM experiments WHERE id = ? AND org_id = ?', [experimentId, orgId]);
  if (!experiment) throw new Error('experiment_not_found');
  const variants = all<VariantRow>('SELECT * FROM experiment_variants WHERE experiment_id = ?', [experimentId]).map((v) => ({
    ...v,
    rate: v.impressions ? round((v.conversions / v.impressions) * 100, 2) : 0,
  }));
  const analysis = analyseVariants(variants, experiment.metric);
  const now = nowIso();
  run("UPDATE experiments SET status = 'concluded', concluded_at = ?, winner = ?, recommendation = ?, updated_at = ? WHERE id = ?", [
    now,
    analysis.leader,
    analysis.detail,
    now,
    experimentId,
  ]);
  logActivity(orgId, 'outreach', `Experiment concluded — ${experiment.name}`, {
    actor: 'ai',
    detail: analysis.detail,
    entityType: 'experiment',
    entityId: experimentId,
  });
  return { winner: analysis.leader, recommendation: analysis.detail };
}

export function createExperiment(
  orgId: string,
  data: { name: string; hypothesis: string; target: string; metric: string; variants: { key: string; label: string; payload?: Record<string, unknown> }[] }
): string {
  const experimentId = id('exp');
  const now = nowIso();
  const split = Object.fromEntries(data.variants.map((v) => [v.key, Math.round(100 / data.variants.length)]));
  run(
    `INSERT INTO experiments (id, org_id, name, hypothesis, target, metric, status, split, started_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'running',?,?,?,?)`,
    [experimentId, orgId, data.name, data.hypothesis, data.target, data.metric, toJson(split), now, now, now]
  );
  for (const v of data.variants) {
    run(
      `INSERT INTO experiment_variants (id, experiment_id, variant_key, label, payload, impressions, conversions, secondary, revenue, created_at)
       VALUES (?,?,?,?,?,0,0,0,0,?)`,
      [id('var'), experimentId, v.key, v.label, toJson(v.payload ?? {}), now]
    );
  }
  return experimentId;
}

// ═════════════════════════════════════════════════════════════
// AI SELF-IMPROVEMENT (§67)
// ═════════════════════════════════════════════════════════════
export interface OptimizationRecommendation {
  id: string;
  area: string;
  title: string;
  rationale: string;
  evidence: Record<string, unknown>;
  proposedChange: Record<string, unknown>;
  status: string;
}

/**
 * Learns from realised outcomes and proposes changes. Proposals only — nothing
 * here mutates scoring weights or automation rules without the user accepting.
 */
export function generateOptimizationRecommendations(orgId: string): OptimizationRecommendation[] {
  const created: OptimizationRecommendation[] = [];
  const now = nowIso();

  const propose = (area: string, title: string, rationale: string, evidence: Record<string, unknown>, proposedChange: Record<string, unknown>) => {
    const existing = get<{ id: string }>(
      "SELECT id FROM optimization_recommendations WHERE org_id = ? AND area = ? AND title = ? AND status = 'suggested'",
      [orgId, area, title]
    );
    if (existing) return;
    const recId = id('opt');
    run(
      `INSERT INTO optimization_recommendations (id, org_id, area, title, rationale, evidence, proposed_change, status, created_at)
       VALUES (?,?,?,?,?,?,?,'suggested',?)`,
      [recId, orgId, area, title, rationale, toJson(evidence), toJson(proposedChange), now]
    );
    created.push({ id: recId, area, title, rationale, evidence, proposedChange, status: 'suggested' });
  };

  // ── 1. Feature → conversion lift ───────────────────────────
  const outcomes = all<{ kind: string; features: string }>(
    "SELECT kind, features FROM outcome_events WHERE org_id = ? AND kind IN ('won','lost','positive','response')",
    [orgId]
  );
  if (outcomes.length >= 12) {
    const won = outcomes.filter((o) => o.kind === 'won' || o.kind === 'positive');
    const lost = outcomes.filter((o) => o.kind === 'lost');
    const featureRates: Record<string, { won: number; total: number }> = {};
    for (const o of outcomes) {
      const feats = json<Record<string, number>>(o.features, {});
      for (const f of Object.keys(feats)) {
        featureRates[f] ||= { won: 0, total: 0 };
        featureRates[f].total++;
        if (o.kind === 'won' || o.kind === 'positive') featureRates[f].won++;
      }
    }
    const baseline = outcomes.length ? won.length / outcomes.length : 0;
    for (const [feature, r] of Object.entries(featureRates)) {
      if (r.total < 6) continue;
      const rate = r.won / r.total;
      const lift = rate - baseline;
      if (lift > 0.15) {
        propose(
          'scoring',
          `Prospects with "${feature}" convert better`,
          `${Math.round(rate * 100)}% of prospects with this feature produced a positive outcome, against a ${Math.round(baseline * 100)}% baseline across ${r.total} samples.`,
          { feature, rate: round(rate, 3), baseline: round(baseline, 3), samples: r.total },
          { addRuleBonus: round(lift * 30, 1), feature }
        );
      } else if (lift < -0.15) {
        propose(
          'scoring',
          `Prospects with "${feature}" convert worse`,
          `Only ${Math.round(rate * 100)}% converted against a ${Math.round(baseline * 100)}% baseline across ${r.total} samples.`,
          { feature, rate: round(rate, 3), baseline: round(baseline, 3), samples: r.total },
          { addRuleBonus: round(lift * 30, 1), feature }
        );
      }
    }
  }

  // ── 2. Outreach tone performance ───────────────────────────
  const tones = all<{ tone: string; sent: number; replies: number }>(
    `SELECT tone, COUNT(*) sent, SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) replies
       FROM outreach_messages WHERE org_id = ? AND direction = 'outbound' AND sent_at IS NOT NULL AND tone IS NOT NULL
      GROUP BY tone HAVING sent >= 8`,
    [orgId]
  );
  if (tones.length >= 2) {
    const ranked = [...tones].sort((a, b) => (b.replies / b.sent) - (a.replies / a.sent));
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const bestRate = best.replies / best.sent;
    const worstRate = worst.replies / worst.sent;
    if (bestRate - worstRate > 0.05) {
      propose(
        'outreach',
        `The "${best.tone.replace('_', ' ')}" tone outperforms "${worst.tone.replace('_', ' ')}"`,
        `${Math.round(bestRate * 100)}% reply rate (${best.replies}/${best.sent}) versus ${Math.round(worstRate * 100)}% (${worst.replies}/${worst.sent}).`,
        { best: { tone: best.tone, rate: round(bestRate, 3), n: best.sent }, worst: { tone: worst.tone, rate: round(worstRate, 3), n: worst.sent } },
        { defaultTone: best.tone, deprioritise: worst.tone }
      );
    }
  }

  // ── 3. Purpose / step performance ──────────────────────────
  const purposes = all<{ purpose: string; sent: number; replies: number }>(
    `SELECT purpose, COUNT(*) sent, SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) replies
       FROM outreach_messages WHERE org_id = ? AND direction = 'outbound' AND sent_at IS NOT NULL AND purpose IS NOT NULL
      GROUP BY purpose HAVING sent >= 8`,
    [orgId]
  );
  if (purposes.length >= 2) {
    const ranked = [...purposes].sort((a, b) => (b.replies / b.sent) - (a.replies / a.sent));
    const best = ranked[0];
    const rate = best.replies / best.sent;
    if (rate > 0.08) {
      propose(
        'sequencing',
        `"${best.purpose}" messages earn the most replies`,
        `${Math.round(rate * 100)}% reply rate across ${best.sent} sends. Consider leading the sequence with this style.`,
        { purpose: best.purpose, rate: round(rate, 3), n: best.sent },
        { reorderSequence: best.purpose }
      );
    }
  }

  // ── 4. Design direction performance ────────────────────────
  const directions = all<{ design_direction: string; concepts: number; viewed: number; calls: number }>(
    `SELECT m.design_direction, COUNT(*) concepts,
            SUM(CASE WHEN m.view_count > 0 THEN 1 ELSE 0 END) viewed,
            (SELECT COUNT(*) FROM calls c JOIN mockups m2 ON m2.business_id = c.business_id
              WHERE m2.design_direction = m.design_direction) calls
       FROM mockups m WHERE m.org_id = ? GROUP BY m.design_direction HAVING concepts >= 3`,
    [orgId]
  );
  if (directions.length >= 2) {
    const ranked = [...directions].sort((a, b) => b.viewed / b.concepts - a.viewed / a.concepts);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const bestRate = best.viewed / best.concepts;
    const worstRate = worst.viewed / worst.concepts;
    if (bestRate - worstRate > 0.2) {
      propose(
        'mockup',
        `The "${best.design_direction}" design direction gets viewed more often`,
        `${Math.round(bestRate * 100)}% of ${best.design_direction} concepts were opened, against ${Math.round(worstRate * 100)}% for ${worst.design_direction}.`,
        { best: { direction: best.design_direction, rate: round(bestRate, 3), n: best.concepts }, worst: { direction: worst.design_direction, rate: round(worstRate, 3), n: worst.concepts } },
        { preferDirection: best.design_direction }
      );
    }
  }

  // ── 5. Model cost efficiency ───────────────────────────────
  const models = all<{ task: string; model_label: string; calls: number; cost: number; errors: number; avg_ms: number }>(
    `SELECT task, model_label, COUNT(*) calls, COALESCE(SUM(cost),0) cost,
            SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) errors, COALESCE(AVG(latency_ms),0) avg_ms
       FROM ai_model_usage WHERE org_id = ? GROUP BY task, model_label HAVING calls >= 10`,
    [orgId]
  );
  const byTask = new Map<string, typeof models>();
  for (const m of models) {
    if (!byTask.has(m.task)) byTask.set(m.task, []);
    byTask.get(m.task)!.push(m);
  }
  for (const [task, list] of byTask) {
    if (list.length < 2) continue;
    const failures = list.find((m) => m.errors / m.calls > 0.2);
    if (failures) {
      propose(
        'ai',
        `"${failures.model_label}" is failing often on ${task}`,
        `${failures.errors} of ${failures.calls} calls failed (${Math.round((failures.errors / failures.calls) * 100)}%). Routing elsewhere would reduce retries and cost.`,
        { task, model: failures.model_label, failures: failures.errors, calls: failures.calls },
        { rerouteTask: task, awayFrom: failures.model_label }
      );
    }
  }

  if (created.length) {
    logActivity(orgId, 'score', `Forge AI proposed ${created.length} optimization${created.length === 1 ? '' : 's'}`, {
      actor: 'ai',
      detail: created.slice(0, 3).map((c) => c.title).join(' · '),
      importance: 'normal',
    });
  }
  return created;
}

export function listOptimizations(orgId: string, opts: { status?: string } = {}) {
  const where = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  type RawRec = {
    id: string; org_id: string; area: string; title: string; rationale: string;
    evidence: string; proposed_change: string; status: string; applied_at: string | null; created_at: string;
  };
  return all<RawRec>(
    `SELECT * FROM optimization_recommendations WHERE ${where.join(' AND ')} ORDER BY status = 'suggested' DESC, created_at DESC`,
    params
  ).map((r) => ({
    id: r.id, area: r.area, title: r.title, rationale: r.rationale, status: r.status,
    evidence: json<Record<string, unknown>>(r.evidence, {}),
    proposedChange: json<Record<string, unknown>>(r.proposed_change, {}),
  }));
}

/**
 * Accepting a recommendation applies the proposed change and records it.
 * Rejection is equally first-class — both are stored so the learning loop does
 * not keep proposing the same thing.
 */
export function resolveOptimization(orgId: string, recommendationId: string, decision: 'accepted' | 'rejected', actor = 'user'): { applied: boolean; message: string } {
  const rec = get<{ area: string; title: string; proposed_change: string }>(
    'SELECT area, title, proposed_change AS proposed_change FROM optimization_recommendations WHERE id = ? AND org_id = ?',
    [recommendationId, orgId]
  );
  if (!rec) throw new Error('not_found');
  const now = nowIso();

  if (decision === 'rejected') {
    run("UPDATE optimization_recommendations SET status = 'rejected', applied_at = ? WHERE id = ?", [now, recommendationId]);
    return { applied: false, message: 'Rejected. Forge AI will not propose this again.' };
  }

  const change = json<Record<string, unknown>>(rec.proposed_change, {});
  let applied = false;
  let message = 'Accepted.';

  if (rec.area === 'scoring' && typeof change.addRuleBonus === 'number') {
    const profile = get<{ custom_rules: string }>('SELECT custom_rules FROM scoring_profiles WHERE org_id = ? AND is_default = 1', [orgId]);
    if (profile) {
      const rules = json<{ id: string; text: string; when: Record<string, unknown>; bonus: number; enabled: boolean }[]>(profile.custom_rules, []);
      const ruleId = `learned_${String(change.feature).replace(/[^a-z0-9]/gi, '_')}`;
      if (!rules.some((r) => r.id === ruleId)) {
        rules.push({
          id: ruleId,
          text: `Learned from outcomes: prospects matching "${change.feature}" ${change.addRuleBonus > 0 ? 'convert better' : 'convert worse'}.`,
          when: { signals: [String(change.feature).replace('industry:', '')] },
          bonus: change.addRuleBonus as number,
          enabled: true,
        });
        run('UPDATE scoring_profiles SET custom_rules = ?, updated_at = ? WHERE org_id = ? AND is_default = 1', [toJson(rules), now, orgId]);
        applied = true;
        message = `Scoring rule added (${change.addRuleBonus > 0 ? '+' : ''}${change.addRuleBonus}). Re-run scoring to apply it.`;
      }
    }
  } else if (rec.area === 'outreach' && typeof change.defaultTone === 'string') {
    const sequences = all<{ id: string }>("SELECT id FROM sequences WHERE org_id = ? AND is_default = 1", [orgId]);
    for (const s of sequences) {
      run('UPDATE sequence_steps SET tone = ? WHERE sequence_id = ? AND position = 0', [change.defaultTone, s.id]);
    }
    applied = sequences.length > 0;
    message = applied ? `Default sequence opener switched to the "${change.defaultTone}" tone.` : 'No default sequence to update.';
  } else {
    message = 'Accepted and recorded. This change type needs to be applied manually from Settings.';
  }

  run("UPDATE optimization_recommendations SET status = 'accepted', applied_at = ? WHERE id = ?", [now, recommendationId]);
  logActivity(orgId, 'score', `Optimization accepted — ${rec.title}`, { actor, detail: message });
  return { applied, message };
}

/**
 * ICP learning (§14): folds realised outcomes back into the profile so future
 * prioritisation reflects what actually closes.
 */
export function learnIcp(orgId: string): { updated: boolean; signals: Record<string, number> } {
  const icp = get<{ id: string; learned_signals: string }>('SELECT id, learned_signals FROM icp_profiles WHERE org_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1', [orgId]);
  if (!icp) return { updated: false, signals: {} };

  const rows = all<{ features: string; kind: string }>(
    "SELECT features, kind FROM outcome_events WHERE org_id = ? AND kind IN ('won','lost','positive','response')",
    [orgId]
  );
  if (rows.length < 8) return { updated: false, signals: {} };

  const counts: Record<string, { positive: number; total: number }> = {};
  for (const r of rows) {
    const feats = json<Record<string, number>>(r.features, {});
    for (const f of Object.keys(feats)) {
      counts[f] ||= { positive: 0, total: 0 };
      counts[f].total++;
      if (r.kind === 'won' || r.kind === 'positive') counts[f].positive++;
    }
  }
  const signals: Record<string, number> = {};
  for (const [f, c] of Object.entries(counts)) {
    if (c.total < 5) continue;
    signals[f] = round(c.positive / c.total, 3);
  }
  run('UPDATE icp_profiles SET learned_signals = ?, updated_at = ? WHERE id = ?', [toJson(signals), nowIso(), icp.id]);
  return { updated: true, signals };
}

export function experimentSummary(orgId: string) {
  const experiments = listExperiments(orgId);
  return {
    total: experiments.length,
    running: experiments.filter((e) => e.status === 'running').length,
    concluded: experiments.filter((e) => e.status === 'concluded').length,
    withWinner: experiments.filter((e) => e.winner).length,
  };
}
