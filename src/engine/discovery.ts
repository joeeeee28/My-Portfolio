/**
 * Continuous discovery engine (§4).
 *
 * Runs the 19-step pipeline in order, records per-step outcomes, and never
 * swallows an error: every failure becomes an `automation_logs` row with a
 * retry/skip/investigate state so the Automation Center can act on it.
 *
 * Caching (§64): expensive work is skipped when the cached result is still
 * inside its TTL, so a daily run does not re-audit sites it checked yesterday.
 */
import { all, get, json, run, scalar, toJson, tx } from '@/db';
import { id, normalizeDomain, nowIso, round } from '@/lib/id';
import { daysBetween } from '@/lib/time';
import { logActivity } from '@/lib/activity';
import { logAutomation } from '@/lib/logging';
import { getSettings } from '@/lib/settings';
import { createBusiness, getBusiness, listContacts, primaryContact, updateBusiness, upsertContact, type Business } from '@/repo/business';
import { enabledDiscoveryProviders, getEnrichmentProvider, listSources, providerReady, providers, recordSourceRun, type DiscoveryProvider } from '@/lib/providers/registry';
import { auditWebsite, probeSeoFiles, verifyWebsiteStatus } from '@/lib/audit/website';
import { auditSocial } from '@/lib/audit/social';
import { analyzeCompetitors } from '@/lib/audit/competitor';
import { scoreBusiness } from './scoring';
import { generateOutreach } from './outreach';
import { generateMockup } from './mockup';
import { computeNba } from './nba';
import { persistAudit, persistSocialAudit } from './auditStore';
import { buildGrowthSignals } from './signals';
import { refreshAnalyticsSnapshot } from './analytics';
import type { PipelineStage } from '@/lib/domain';

export interface RunStats {
  discovered: number;
  deduplicated: number;
  identityVerified: number;
  websiteVerified: number;
  enriched: number;
  auditsCompleted: number;
  socialAudits: number;
  competitorAnalyses: number;
  growthSignals: number;
  scored: number;
  qualified: number;
  highPriority: number;
  criticalPriority: number;
  actionsRecommended: number;
  outreachDrafts: number;
  mockupsGenerated: number;
  followUps: number;
  stageChanges: number;
  errors: number;
  cost: number;
  perStep: Record<string, { ok: number; skipped: number; error: number; ms: number }>;
  perSource: Record<string, { records: number; ok: boolean; note?: string }>;
}

const EMPTY_STEP = () => ({ ok: 0, skipped: 0, error: 0, ms: 0 });

export interface DiscoveryOptions {
  kind?: 'scheduled' | 'manual' | 'backfill';
  trigger?: string;
  limit?: number;
  /** Skip live network work — used by tests and by the demo seeder. */
  offline?: boolean;
  /** Restrict to a specific opportunity intent. */
  opportunity?: string;
  actor?: string;
  onStep?: (step: string, detail: string) => void;
}

export async function runDiscovery(orgId: string, opts: DiscoveryOptions = {}): Promise<{ runId: string; stats: RunStats }> {
  const settings = getSettings(orgId);
  const started = Date.now();
  const runId = id('run');
  const actor = opts.actor ?? 'system';

  const stats: RunStats = {
    discovered: 0, deduplicated: 0, identityVerified: 0, websiteVerified: 0, enriched: 0, auditsCompleted: 0,
    socialAudits: 0, competitorAnalyses: 0, growthSignals: 0, scored: 0, qualified: 0, highPriority: 0,
    criticalPriority: 0, actionsRecommended: 0, outreachDrafts: 0, mockupsGenerated: 0, followUps: 0,
    stageChanges: 0, errors: 0, cost: 0, perStep: {}, perSource: {},
  };
  const step = (name: string) => {
    stats.perStep[name] ||= EMPTY_STEP();
    return {
      ok: () => {
        stats.perStep[name].ok++;
      },
      skip: () => {
        stats.perStep[name].skipped++;
      },
      fail: (msg: string, detail?: unknown) => {
        stats.perStep[name].error++;
        stats.errors++;
        logAutomation(orgId, 'system', `Discovery step "${name}" failed: ${msg}`, {
          level: 'error',
          runId,
          detail,
          retryable: true,
        });
      },
      ms: (v: number) => {
        stats.perStep[name].ms += v;
      },
    };
  };
  const item = (stepName: string, businessId: string | null, outcome: 'ok' | 'skipped' | 'error', detail?: string, cost = 0) => {
    run(
      `INSERT INTO discovery_run_items (id, run_id, business_id, step, outcome, detail, cost, duration_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id('rit'), runId, businessId, stepName, outcome, detail ?? null, cost, 0, nowIso()]
    );
  };

  run(
    `INSERT INTO discovery_runs (id, org_id, kind, status, trigger, started_at, input_count, stats, cost, error_count, created_at)
     VALUES (?,?,?,?,?,?,0,'{}',0,0,?)`,
    [runId, orgId, opts.kind ?? 'manual', 'running', opts.trigger ?? 'manual', nowIso(), nowIso()]
  );
  opts.onStep?.('start', 'Discovery run started');

  try {
    // ── 1. Discover ──────────────────────────────────────────
    const s1 = step('1. Discover businesses');
    const t1 = Date.now();
    const activeSources = opts.offline ? [] : enabledDiscoveryProviders(orgId);
    if (!activeSources.length) {
      item('1. Discover businesses', null, 'skipped', 'No discovery sources are enabled and usable.');
      s1.skip();
    }
    const perSourceLimit = Math.max(5, Math.floor((opts.limit ?? settings.discovery.maxBusinessesPerRun) / Math.max(1, activeSources.length)));
    for (const source of activeSources) {
      await safeDiscover(orgId, source, {
        opportunity: opts.opportunity,
        limit: perSourceLimit,
        runId,
        stats,
        step: s1,
        item,
      });
    }
    s1.ms(Date.now() - t1);

    // Which businesses to process this run.
    const ttlHours = settings.discovery.cacheTtlHours;
    const reverifyDays = settings.discovery.reverifyIntervalDays;
    const targets = all<{ id: string; name: string; website: string | null; website_domain: string | null; website_status: string; website_checked_at: string | null; last_verified_at: string | null; stage: string; opportunity_score: number | null; consent_state: string; priority: string; social: string; rating: number | null; review_count: number | null; category: string | null; industry: string | null }>(
      `SELECT id, name, website, website_domain, website_status, website_checked_at, last_verified_at, stage,
              opportunity_score, consent_state, priority, social, rating, review_count, category, industry
         FROM businesses
        WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
        ORDER BY opportunity_score IS NULL DESC, opportunity_score DESC, created_at DESC
        LIMIT ?`,
      [orgId, opts.limit ?? 400]
    );

    // ── 2. Deduplicate ───────────────────────────────────────
    const s2 = step('2. Deduplicate');
    const t2 = Date.now();
    const dupeCount = scalar<number>(
      `SELECT COUNT(*) FROM duplicate_events WHERE org_id = ? AND created_at >= ?`,
      [orgId, new Date(started).toISOString()]
    ) ?? 0;
    stats.deduplicated = dupeCount;
    if (dupeCount) logActivity(orgId, 'discovery', `Deduplication resolved ${dupeCount} duplicate(s)`, { actor });
    s2.ok();
    s2.ms(Date.now() - t2);

    for (const t of targets) {
      const businessId = t.id;

      // ── 3. Verify business identity ────────────────────────
      const s3 = step('3. Verify business identity');
      const sources = all<{ provider_key: string; confidence: number; source_url: string | null }>(
        'SELECT provider_key, confidence, source_url FROM business_sources WHERE business_id = ? ORDER BY confidence DESC',
        [businessId]
      );
      const corroboration = new Set(sources.map((s) => s.provider_key)).size;
      const avgConfidence = sources.length ? sources.reduce((a, s) => a + s.confidence, 0) / sources.length : 0;
      const identityOk = corroboration >= 1 && avgConfidence >= 0.4;
      updateBusiness(orgId, businessId, { source_confidence: round(avgConfidence, 3) });
      if (identityOk) {
        stats.identityVerified++;
        s3.ok();
        item('3. Verify business identity', businessId, 'ok', `${corroboration} source(s), avg confidence ${round(avgConfidence, 2)}`);
      } else {
        s3.skip();
        item('3. Verify business identity', businessId, 'skipped', 'Insufficient corroboration — identity not confirmed');
      }

      // ── 4. Verify website status ───────────────────────────
      const s4 = step('4. Verify website status');
      const staleWebsite = !t.website_checked_at || daysBetween(t.website_checked_at) > reverifyDays;
      if (!t.website) {
        updateBusiness(orgId, businessId, { website_status: 'missing', website_checked_at: nowIso() });
        stats.websiteVerified++;
        s4.ok();
        item('4. Verify website status', businessId, 'ok', 'No website on record');
      } else if (opts.offline || !staleWebsite) {
        s4.skip();
        item('4. Verify website status', businessId, 'skipped', opts.offline ? 'Offline run — cached status retained' : `Checked ${round(daysBetween(t.website_checked_at!), 1)}d ago (TTL ${reverifyDays}d)`);
      } else {
        const t4 = Date.now();
        try {
          const v = await verifyWebsiteStatus(t.website);
          updateBusiness(orgId, businessId, { website_status: v.status, website_checked_at: nowIso() });
          stats.websiteVerified++;
          s4.ok();
          item('4. Verify website status', businessId, 'ok', `${v.status} (HTTP ${v.httpStatus}, ${v.responseMs}ms)`);
        } catch (e) {
          s4.fail(e instanceof Error ? e.message : String(e), { businessId });
          item('4. Verify website status', businessId, 'error', String(e));
        }
        s4.ms(Date.now() - t4);
      }

      // ── 5. Analyze digital presence ────────────────────────
      const s5 = step('5. Analyze digital presence');
      const currentWebsite = getBusiness(orgId, businessId)?.website ?? null;
      const lastAudit = get<{ created_at: string }>('SELECT created_at FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
      const auditStale = !lastAudit || daysBetween(lastAudit.created_at) * 24 > ttlHours;
      if (!opts.offline && auditStale) {
        const t5 = Date.now();
        try {
          const result = await auditWebsite(currentWebsite, { timeoutMs: 12_000 });
          if (currentWebsite && result.verified) {
            const seo = await probeSeoFiles(currentWebsite);
            result.hasSitemap = seo.sitemap;
            result.hasRobots = seo.robots;
          }
          persistAudit(orgId, businessId, result);
          stats.auditsCompleted++;
          s5.ok();
          item('5. Analyze digital presence', businessId, 'ok', `${result.websiteStatus} · score ${result.scores.website} · ${result.signals.length} signal(s)`);
        } catch (e) {
          s5.fail(e instanceof Error ? e.message : String(e), { businessId });
          item('5. Analyze digital presence', businessId, 'error', String(e));
          logAutomation(orgId, 'website_analysis', `Website audit failed for ${t.name}`, {
            level: 'error',
            runId,
            entityType: 'business',
            entityId: businessId,
            detail: { url: currentWebsite, error: String(e) },
            retryable: true,
          });
        }
        s5.ms(Date.now() - t5);
      } else {
        s5.skip();
        item('5. Analyze digital presence', businessId, 'skipped', opts.offline ? 'Offline run' : `Audit is ${round(daysBetween(lastAudit!.created_at) * 24, 0)}h old (TTL ${ttlHours}h)`);
      }

      // ── 6. Enrich ──────────────────────────────────────────
      const s6 = step('6. Enrich business information');
      if (!opts.offline) {
        const enriched = await runEnrichment(orgId, businessId, runId);
        if (enriched.attempted) {
          stats.enriched += enriched.fieldsUpdated;
          stats.cost += enriched.cost;
          s6.ok();
          item('6. Enrich business information', businessId, 'ok', `${enriched.fieldsUpdated} field(s) from ${enriched.providers.join(', ') || 'no providers'}`, enriched.cost);
        } else {
          s6.skip();
          item('6. Enrich business information', businessId, 'skipped', 'No enrichment providers configured');
        }
      } else {
        s6.skip();
        item('6. Enrich business information', businessId, 'skipped', 'Offline run');
      }

      // ── 7. Find contacts ───────────────────────────────────
      const s7 = step('7. Find relevant contacts');
      const contacts = listContacts(orgId, businessId);
      if (!contacts.length && !opts.offline) {
        const found = await findContacts(orgId, businessId, runId);
        if (found.attempted) {
          s7.ok();
          item('7. Find relevant contacts', businessId, found.count ? 'ok' : 'skipped', found.count ? `${found.count} contact(s) added` : 'No contacts available from configured providers');
        } else {
          s7.skip();
          item('7. Find relevant contacts', businessId, 'skipped', 'No contact providers configured; contact data was not invented');
        }
      } else {
        s7.ok();
        item('7. Find relevant contacts', businessId, 'ok', `${contacts.length} contact(s) on record`);
      }

      // ── 8. Analyze social presence ─────────────────────────
      const s8 = step('8. Analyze social presence');
      const lastSocial = get<{ created_at: string }>('SELECT created_at FROM social_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [businessId]);
      const socialStale = !lastSocial || daysBetween(lastSocial.created_at) * 24 > ttlHours;
      if (socialStale) {
        try {
          const biz = getBusiness(orgId, businessId);
          const result = await auditSocial(biz?.social ?? {}, {
            businessName: biz?.name,
            industry: biz?.industry ?? undefined,
            live: !opts.offline,
          });
          persistSocialAudit(orgId, businessId, result);
          stats.socialAudits++;
          s8.ok();
          item('8. Analyze social presence', businessId, 'ok', `score ${result.socialScore} · ${result.platformCount} channel(s) · ${result.postingFrequency}`);
        } catch (e) {
          s8.fail(e instanceof Error ? e.message : String(e), { businessId });
          item('8. Analyze social presence', businessId, 'error', String(e));
        }
      } else {
        s8.skip();
        item('8. Analyze social presence', businessId, 'skipped', `Social audit is ${round(daysBetween(lastSocial!.created_at) * 24, 0)}h old`);
      }

      // ── 9. Competitors ─────────────────────────────────────
      const s9 = step('9. Analyze competitors');
      const bizNow = getBusiness(orgId, businessId);
      const worthCompetitors = (bizNow?.opportunity_score ?? 0) >= 50 || (bizNow?.priority ?? 'low') === 'critical';
      const hasCompetitors = (scalar<number>('SELECT COUNT(*) FROM competitors WHERE business_id = ?', [businessId]) ?? 0) > 0;
      if (worthCompetitors && !hasCompetitors) {
        try {
          const res = await analyzeCompetitors(orgId, businessId, { limit: 4 });
          stats.competitorAnalyses++;
          s9.ok();
          item('9. Analyze competitors', businessId, 'ok', `${res.competitors.length} measured peer(s), gap ${res.gapScore}`);
        } catch (e) {
          s9.fail(e instanceof Error ? e.message : String(e), { businessId });
          item('9. Analyze competitors', businessId, 'error', String(e));
        }
      } else {
        s9.skip();
        item('9. Analyze competitors', businessId, 'skipped', hasCompetitors ? 'Already analysed' : 'Below the priority threshold for competitor analysis');
      }

      // ── 10. Growth signals ─────────────────────────────────
      const s10 = step('10. Identify growth signals');
      try {
        const growth = buildGrowthSignals(orgId, businessId);
        stats.growthSignals += growth.signals.length;
        s10.ok();
        item('10. Identify growth signals', businessId, 'ok', growth.signals.length ? growth.signals.join(', ') : 'No growth signals detected');
      } catch (e) {
        s10.fail(e instanceof Error ? e.message : String(e), { businessId });
        item('10. Identify growth signals', businessId, 'error', String(e));
      }

      // ── 11. Opportunity score ──────────────────────────────
      const s11 = step('11. Calculate opportunity scores');
      try {
        const scored = scoreBusiness(orgId, businessId, { actor, log: false });
        if (scored) {
          stats.scored++;
          if (scored.priority === 'high') stats.highPriority++;
          if (scored.priority === 'critical') stats.criticalPriority++;
          s11.ok();
          item('11. Calculate opportunity scores', businessId, 'ok', `${scored.total}/100 → ${scored.priority}`);
        } else {
          s11.skip();
        }
      } catch (e) {
        s11.fail(e instanceof Error ? e.message : String(e), { businessId });
        item('11. Calculate opportunity scores', businessId, 'error', String(e));
      }

      // ── 13. Recommended actions (needs the fresh score) ────
      const s13 = step('13. Generate recommended actions');
      try {
        const nba = computeNba(orgId, businessId);
        if (nba) {
          stats.actionsRecommended++;
          s13.ok();
          item('13. Generate recommended actions', businessId, 'ok', `${nba.action} — ${nba.reason}`);
        }
      } catch (e) {
        s13.fail(e instanceof Error ? e.message : String(e), { businessId });
      }
    }

    // ── 12. Rank ─────────────────────────────────────────────
    const s12 = step('12. Rank prospects');
    try {
      const qualified = scalar<number>(
        `SELECT COUNT(*) FROM businesses WHERE org_id = ? AND opportunity_score >= ? AND merged_into IS NULL AND is_archived = 0`,
        [orgId, settings.discovery.minScoreToQualify]
      ) ?? 0;
      stats.qualified = qualified;
      s12.ok();
      item('12. Rank prospects', null, 'ok', `${qualified} prospect(s) at or above the qualification threshold of ${settings.discovery.minScoreToQualify}`);
    } catch (e) {
      s12.fail(e instanceof Error ? e.message : String(e));
    }

    // ── 17. Update pipeline (qualification) ──────────────────
    const s17 = step('17. Update pipeline');
    try {
      const toQualify = all<{ id: string; name: string }>(
        `SELECT id, name FROM businesses WHERE org_id = ? AND stage = 'discovered' AND opportunity_score >= ?
            AND consent_state NOT IN ('opted_out','do_not_contact')`,
        [orgId, settings.discovery.minScoreToQualify]
      );
      for (const b of toQualify) {
        if (!settings.discovery.autoQualify) break;
        run("UPDATE businesses SET stage = 'qualified', updated_at = ? WHERE id = ?", [nowIso(), b.id]);
        logActivity(orgId, 'stage_change', `${b.name} → qualified`, {
          businessId: b.id,
          actor,
          detail: 'Met the qualification threshold during discovery.',
        });
        stats.stageChanges++;
      }
      s17.ok();
      item('17. Update pipeline', null, 'ok', `${toQualify.length} business(es) moved to Qualified`);
    } catch (e) {
      s17.fail(e instanceof Error ? e.message : String(e));
    }

    // Eligible set for the expensive steps.
    const eligible = all<{ id: string; name: string; stage: string; opportunity_score: number | null; consent_state: string }>(
      `SELECT id, name, stage, opportunity_score, consent_state FROM businesses
        WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
          AND opportunity_score >= ? AND consent_state NOT IN ('opted_out','do_not_contact')
          AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
        ORDER BY opportunity_score DESC LIMIT ?`,
      [orgId, settings.discovery.minScoreToQualify, opts.limit ?? 200]
    );

    // ── 14. Outreach drafts ──────────────────────────────────
    const s14 = step('14. Generate outreach drafts');
    if (settings.discovery.autoOutreachDrafts) {
      for (const b of eligible.slice(0, 25)) {
        const existing = scalar<number>(`SELECT COUNT(*) FROM outreach_messages WHERE business_id = ? AND direction = 'outbound'`, [b.id]) ?? 0;
        if (existing > 0) {
          s14.skip();
          continue;
        }
        try {
          const res = await generateOutreach(orgId, b.id, { channel: 'email', purpose: 'intro', actor: 'discovery' });
          if (res?.messageId) {
            stats.outreachDrafts++;
            stats.cost += res.message.cost;
            s14.ok();
            item('14. Generate outreach drafts', b.id, res.compliance.allowed ? 'ok' : 'skipped', res.compliance.allowed ? res.message.subject ?? 'draft created' : res.compliance.reasons[0], res.message.cost);
          }
        } catch (e) {
          s14.fail(e instanceof Error ? e.message : String(e), { businessId: b.id });
          logAutomation(orgId, 'outreach', `Outreach draft failed for ${b.name}`, { level: 'error', runId, retryable: true });
        }
      }
    } else {
      s14.skip();
      item('14. Generate outreach drafts', null, 'skipped', 'Automatic outreach drafting is disabled in settings');
    }

    // ── 15. Mockups ──────────────────────────────────────────
    const s15 = step('15. Generate mockups');
    if (settings.discovery.autoMockup) {
      const mockupCandidates = eligible.filter((b) => (b.opportunity_score ?? 0) >= settings.discovery.minScoreToMockup).slice(0, 10);
      for (const b of mockupCandidates) {
        const existing = scalar<number>('SELECT COUNT(*) FROM mockups WHERE business_id = ?', [b.id]) ?? 0;
        if (existing > 0) {
          s15.skip();
          continue;
        }
        try {
          await generateMockup(orgId, b.id, { actor: 'discovery' });
          stats.mockupsGenerated++;
          s15.ok();
          item('15. Generate mockups', b.id, 'ok', 'Concept website generated');
        } catch (e) {
          s15.fail(e instanceof Error ? e.message : String(e), { businessId: b.id });
          logAutomation(orgId, 'mockup', `Mockup generation failed for ${b.name}`, {
            level: 'error',
            runId,
            entityType: 'business',
            entityId: b.id,
            retryable: true,
          });
        }
      }
    } else {
      s15.skip();
      item('15. Generate mockups', null, 'skipped', 'Automatic mockup generation is disabled in settings');
    }

    // ── 16. Follow-ups ───────────────────────────────────────
    const s16 = step('16. Create follow-up tasks');
    try {
      const created = await sweepFollowUps(orgId);
      stats.followUps = created;
      s16.ok();
      item('16. Create follow-up tasks', null, 'ok', `${created} follow-up(s) created`);
    } catch (e) {
      s16.fail(e instanceof Error ? e.message : String(e));
    }

    // ── 18. Analytics ────────────────────────────────────────
    const s18 = step('18. Update analytics');
    try {
      refreshAnalyticsSnapshot(orgId);
      s18.ok();
      item('18. Update analytics', null, 'ok', 'Snapshot refreshed');
    } catch (e) {
      s18.fail(e instanceof Error ? e.message : String(e));
    }

    // ── 19. Log ──────────────────────────────────────────────
    const s19 = step('19. Log every action');
    s19.ok();
    logActivity(orgId, 'discovery', `Discovery run complete — ${stats.discovered} discovered, ${stats.qualified} qualified, ${stats.mockupsGenerated} mockups`, {
      actor,
      detail: `${stats.errors} error(s) · $${round(stats.cost, 4)} cost`,
      entityType: 'discovery_run',
      entityId: runId,
      importance: stats.errors > 0 ? 'high' : 'normal',
    });

    const duration = Date.now() - started;
    run(
      `UPDATE discovery_runs SET status = ?, finished_at = ?, duration_ms = ?, input_count = ?, stats = ?, cost = ?,
              error_count = ?, summary = ? WHERE id = ?`,
      [
        stats.errors > 0 ? 'partial' : 'completed',
        nowIso(),
        duration,
        targets.length,
        toJson(stats),
        round(stats.cost, 6),
        stats.errors,
        summarise(stats),
        runId,
      ]
    );
    run(
      `UPDATE automation_jobs SET last_run_at = ?, last_run_id = ?, last_status = ?, runs_total = runs_total + 1,
              runs_failed = runs_failed + ?, avg_duration_ms = ?, updated_at = ?
        WHERE org_id = ? AND key = 'daily_discovery'`,
      [nowIso(), runId, stats.errors > 0 ? 'partial' : 'completed', stats.errors > 0 ? 1 : 0, duration, nowIso(), orgId]
    );

    return { runId, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(`UPDATE discovery_runs SET status = 'failed', finished_at = ?, duration_ms = ?, error_count = error_count + 1, summary = ? WHERE id = ?`, [
      nowIso(),
      Date.now() - started,
      message,
      runId,
    ]);
    logAutomation(orgId, 'system', `Discovery run failed: ${message}`, { level: 'error', runId, detail: { stack: String(err) }, retryable: true });
    throw err;
  }
}

function summarise(s: RunStats): string {
  return `${s.discovered} discovered · ${s.deduplicated} deduped · ${s.auditsCompleted} audited · ${s.qualified} qualified · ${s.highPriority + s.criticalPriority} high priority · ${s.outreachDrafts} outreach drafts · ${s.mockupsGenerated} mockups · ${s.followUps} follow-ups · ${s.errors} errors`;
}

async function safeDiscover(
  orgId: string,
  source: DiscoveryProvider,
  ctx: {
    opportunity?: string;
    limit: number;
    runId: string;
    stats: RunStats;
    step: { ok: () => void; skip: () => void; fail: (m: string, d?: unknown) => void };
    item: (step: string, businessId: string | null, outcome: 'ok' | 'skipped' | 'error', detail?: string, cost?: number) => void;
  }
): Promise<void> {
  try {
    const res = await source.discover(orgId, { opportunity: ctx.opportunity, limit: ctx.limit });
    ctx.stats.perSource[source.key] = { records: res.records.length, ok: true, note: res.note };
    recordSourceRun(orgId, source.key, true, res.records.length);

    for (const record of res.records) {
      if (!record.name?.trim()) continue;
      const { created } = createBusiness(orgId, {
        name: record.name,
        website: record.website,
        phone: record.phone,
        email: record.email,
        industry: record.industry,
        category: record.category,
        subcategory: record.subcategory,
        description: record.description,
        addressLine: record.addressLine,
        locality: record.locality,
        region: record.region,
        country: record.country,
        postalCode: record.postalCode,
        social: record.social,
        rating: record.rating,
        reviewCount: record.reviewCount,
        priceLevel: record.priceLevel,
        employeeEstimate: record.employeeEstimate,
        foundedYear: record.foundedYear,
        isNewBusiness: record.isNewBusiness,
        hiringSignal: record.hiringSignal,
      }, {
        providerKey: source.key,
        sourceUrl: record.sourceUrl ?? null,
        externalId: record.externalId ?? null,
        confidence: record.confidence,
      });
      if (created) ctx.stats.discovered++;
      else ctx.stats.deduplicated++;
    }
    ctx.step.ok();
    ctx.item('1. Discover businesses', null, 'ok', `${source.label}: ${res.records.length} record(s)${res.note ? ` — ${res.note}` : ''}`, (source.costPerCall ?? 0) * res.records.length);
    ctx.stats.cost += (source.costPerCall ?? 0) * res.records.length;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.stats.perSource[source.key] = { records: 0, ok: false, note: message };
    recordSourceRun(orgId, source.key, false, 0, message);
    ctx.step.fail(message, { source: source.key });
    ctx.item('1. Discover businesses', null, 'error', `${source.label}: ${message}`);
    logAutomation(orgId, 'source_error', `Discovery source ${source.label} failed: ${message}`, {
      level: 'error',
      runId: ctx.runId,
      entityType: 'discovery_source',
      entityId: source.key,
      retryable: true,
    });
  }
}

async function runEnrichment(orgId: string, businessId: string, runId: string) {
  const business = getBusiness(orgId, businessId);
  if (!business) return { attempted: false, fieldsUpdated: 0, providers: [] as string[], cost: 0 };

  const configured = providers.enrichment.filter((p) => providerReady(orgId, p) && p.requiresCredentials);
  if (!configured.length) return { attempted: false, fieldsUpdated: 0, providers: [], cost: 0 };

  let fieldsUpdated = 0;
  let cost = 0;
  const usedProviders: string[] = [];

  for (const provider of configured) {
    try {
      const out = await provider.enrich(orgId, {
        name: business.name,
        website: business.website,
        domain: business.website_domain,
        email: business.email,
        phone: business.phone,
        locality: business.locality,
        country: business.country,
      });
      cost += out.cost ?? provider.costPerCall ?? 0;
      usedProviders.push(provider.key);
      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(out.fields)) {
        if (value === null || value === undefined || value === '') continue;
        const current = (business as unknown as Record<string, unknown>)[field];
        if (current !== null && current !== undefined && current !== '') continue;
        patch[field] = value;
        run(
          `INSERT INTO enrichment_records (id, org_id, business_id, provider_key, field, value, confidence, verified, verified_at, cost, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id('enr'), orgId, businessId, provider.key, field, typeof value === 'object' ? toJson(value) : String(value), out.confidence, out.verified ? 1 : 0, out.verified ? nowIso() : null, 0, nowIso()]
        );
        fieldsUpdated++;
      }
      if (Object.keys(patch).length) updateBusiness(orgId, businessId, patch);
      if (out.contacts?.length) {
        for (const c of out.contacts.slice(0, 3)) {
          upsertContact(orgId, businessId, {
            full_name: c.fullName,
            job_title: c.jobTitle ?? null,
            seniority: c.seniority ?? null,
            email: c.email ?? null,
            phone: null,
            linkedin_url: c.linkedinUrl ?? null,
            is_decision_maker: c.isDecisionMaker ? 1 : 0,
            confidence: c.confidence,
          } as never);
        }
      }
      // Recompute data confidence (§10).
      recomputeDataConfidence(orgId, businessId);
    } catch (e) {
      logAutomation(orgId, 'enrichment', `Enrichment failed for ${business.name} via ${provider.label}`, {
        level: 'error',
        runId,
        entityType: 'business',
        entityId: businessId,
        detail: { provider: provider.key, error: String(e) },
        retryable: true,
      });
    }
  }
  return { attempted: true, fieldsUpdated, providers: usedProviders, cost };
}

export function recomputeDataConfidence(orgId: string, businessId: string): number {
  const records = all<{ field: string; confidence: number; verified: number }>(
    'SELECT field, confidence, verified FROM enrichment_records WHERE business_id = ?',
    [businessId]
  );
  const sources = all<{ confidence: number }>('SELECT confidence FROM business_sources WHERE business_id = ?', [businessId]);
  const perField: Record<string, number> = {};
  for (const r of records) perField[r.field] = Math.max(perField[r.field] ?? 0, r.confidence * (r.verified ? 1 : 0.7));
  const sourceAvg = sources.length ? sources.reduce((a, s) => a + s.confidence, 0) / sources.length : 0;
  const fieldAvg = Object.values(perField).length ? Object.values(perField).reduce((a, b) => a + b, 0) / Object.values(perField).length : 0;
  const overall = round(Math.max(sourceAvg, fieldAvg) * 100, 1);
  const now = nowIso();
  const existing = get<{ business_id: string }>('SELECT business_id FROM data_confidence WHERE business_id = ?', [businessId]);
  if (existing) {
    run('UPDATE data_confidence SET overall = ?, per_field = ?, sources_used = ?, last_verified_at = ?, updated_at = ? WHERE business_id = ?', [
      overall,
      toJson(perField),
      sources.length,
      now,
      now,
      businessId,
    ]);
  } else {
    run(
      `INSERT INTO data_confidence (business_id, overall, per_field, sources_used, last_verified_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      [businessId, overall, toJson(perField), sources.length, now, now]
    );
  }
  run('UPDATE businesses SET source_confidence = ?, last_verified_at = ?, updated_at = ? WHERE id = ?', [
    round(overall / 100, 3),
    now,
    now,
    businessId,
  ]);
  void orgId;
  return overall;
}

async function findContacts(orgId: string, businessId: string, runId: string) {
  const business = getBusiness(orgId, businessId);
  if (!business) return { attempted: false, count: 0 };
  const configured = providers.enrichment.filter((p) => providerReady(orgId, p) && p.requiresCredentials);
  if (!configured.length) return { attempted: false, count: 0 };

  let count = 0;
  for (const provider of configured) {
    try {
      const out = await provider.enrich(orgId, {
        name: business.name,
        website: business.website,
        domain: business.website_domain,
        email: business.email,
      });
      for (const c of out.contacts ?? []) {
        upsertContact(orgId, businessId, {
          full_name: c.fullName,
          job_title: c.jobTitle ?? null,
          seniority: c.seniority ?? null,
          email: c.email ?? null,
          linkedin_url: c.linkedinUrl ?? null,
          is_decision_maker: c.isDecisionMaker ? 1 : 0,
          confidence: c.confidence,
        } as never);
        count++;
      }
    } catch (e) {
      logAutomation(orgId, 'enrichment', `Contact discovery failed for ${business.name}`, {
        level: 'warn',
        runId,
        entityType: 'business',
        entityId: businessId,
        detail: { provider: provider.key, error: String(e) },
        retryable: true,
      });
    }
  }
  return { attempted: true, count };
}

/**
 * Creates follow-ups that the current state implies (§4 step 16, §24).
 * Idempotent: an identical pending follow-up is never duplicated.
 */
export async function sweepFollowUps(orgId: string): Promise<number> {
  let created = 0;

  // Mockup viewed but not yet followed up.
  const viewed = all<{ id: string; name: string; last_viewed_at: string | null; view_count: number }>(
    `SELECT b.id, b.name, m.last_viewed_at, m.view_count FROM businesses b
       JOIN mockups m ON m.business_id = b.id
      WHERE b.org_id = ? AND m.status = 'viewed' AND b.merged_into IS NULL AND b.is_archived = 0
        AND b.stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.business_id = b.id AND f.kind = 'mockup' AND f.status = 'pending')`,
    [orgId]
  );
  for (const b of viewed) {
    const { createFollowUp } = await import('./mockup');
    createFollowUp(orgId, b.id, {
      kind: 'mockup',
      title: `Follow up — ${b.name} viewed the concept`,
      reason: b.view_count > 1
        ? `They have opened it ${b.view_count} times. Intent is rising.`
        : 'They opened the concept. A short follow-up now converts far better than waiting.',
      dueInHours: b.view_count > 1 ? 2 : 12,
      priority: b.view_count > 1 ? 'high' : 'medium',
    });
    created++;
  }

  // Sent but no reply in 5+ days.
  const silent = all<{ id: string; name: string }>(
    `SELECT b.id, b.name FROM businesses b
      WHERE b.org_id = ? AND b.stage IN ('outreach_sent','engaged') AND b.merged_into IS NULL AND b.is_archived = 0
        AND EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.direction = 'outbound' AND o.sent_at IS NOT NULL AND o.sent_at < ?)
        AND NOT EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = b.id AND o.direction = 'inbound')
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.business_id = b.id AND f.kind = 'outreach' AND f.status = 'pending')`,
    [orgId, new Date(Date.now() - 5 * 86_400_000).toISOString()]
  );
  for (const b of silent) {
    const { createFollowUp } = await import('./mockup');
    createFollowUp(orgId, b.id, {
      kind: 'outreach',
      title: `No reply from ${b.name} — decide next step`,
      reason: 'Outreach went out over five days ago with no response. Either send a value-first follow-up or close it out.',
      dueInHours: 24,
      priority: 'medium',
    });
    created++;
  }

  // Proposal sent, no answer in 4+ days.
  const proposals = all<{ id: string; name: string; number: string }>(
    `SELECT b.id, b.name, p.number FROM businesses b JOIN proposals p ON p.business_id = b.id
      WHERE b.org_id = ? AND p.status IN ('sent','viewed') AND p.sent_at < ?
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.business_id = b.id AND f.kind = 'proposal' AND f.status = 'pending')`,
    [orgId, new Date(Date.now() - 4 * 86_400_000).toISOString()]
  );
  for (const p of proposals) {
    const { createFollowUp } = await import('./mockup');
    createFollowUp(orgId, p.id, {
      kind: 'proposal',
      title: `Proposal ${p.number} for ${p.name} — awaiting response`,
      reason: 'The proposal has been open for over four days. A short check-in usually unblocks it.',
      dueInHours: 8,
      priority: 'high',
    });
    created++;
  }

  // Calls in the next 24 hours need preparation.
  const calls = all<{ business_id: string; title: string; scheduled_at: string; name: string }>(
    `SELECT c.business_id, c.title, c.scheduled_at, b.name FROM calls c JOIN businesses b ON b.id = c.business_id
      WHERE c.org_id = ? AND c.status = 'scheduled' AND c.scheduled_at BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.business_id = c.business_id AND f.kind = 'call' AND f.status = 'pending')`,
    [orgId, nowIso(), new Date(Date.now() + 86_400_000).toISOString()]
  );
  for (const c of calls) {
    const { createFollowUp } = await import('./mockup');
    createFollowUp(orgId, c.business_id, {
      kind: 'call',
      title: `Prepare for call with ${c.name}`,
      reason: `Scheduled call "${c.title}" is within 24 hours. Generate the briefing and review the audit first.`,
      dueInHours: 4,
      priority: 'high',
      suggestedAction: 'generate_briefing',
    });
    created++;
  }

  // Mark overdue follow-ups.
  run(`UPDATE follow_ups SET status = 'overdue' WHERE org_id = ? AND status = 'pending' AND due_at < ?`, [orgId, nowIso()]);

  return created;
}

export interface RunRow {
  id: string;
  org_id: string;
  kind: string;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  input_count: number;
  stats: RunStats;
  cost: number;
  error_count: number;
  summary: string | null;
  created_at: string;
}

export function listRuns(orgId: string, limit = 30): RunRow[] {
  return all<Omit<RunRow, 'stats'> & { stats: string }>(
    `SELECT * FROM discovery_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT ?`,
    [orgId, limit]
  ).map((r) => ({ ...r, stats: json<RunStats>(r.stats, {} as RunStats) }));
}

export function getRun(orgId: string, runId: string): (RunRow & { items: Record<string, unknown>[] }) | null {
  const row = get<Omit<RunRow, 'stats'> & { stats: string }>('SELECT * FROM discovery_runs WHERE org_id = ? AND id = ?', [orgId, runId]);
  if (!row) return null;
  return {
    ...row,
    stats: json<RunStats>(row.stats, {} as RunStats),
    items: all<Record<string, unknown>>('SELECT * FROM discovery_run_items WHERE run_id = ? ORDER BY created_at ASC', [runId]),
  };
}

export function runItemsByStep(runId: string) {
  const rows = all<{ step: string; outcome: string; c: number }>(
    'SELECT step, outcome, COUNT(*) c FROM discovery_run_items WHERE run_id = ? GROUP BY step, outcome ORDER BY step',
    [runId]
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.step] ||= {})[r.outcome] = r.c;
  return out;
}

export function sourceHealth(orgId: string) {
  return listSources(orgId);
}

export { tx, normalizeDomain, type PipelineStage };
