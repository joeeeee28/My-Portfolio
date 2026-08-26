/**
 * Daily autonomous discovery expressed as a resumable job (§2, §30, §31).
 *
 * V1 ran the 19 steps inside one function, so a failure restarted everything.
 * This wraps the same underlying engines as discrete, checkpointed steps: if the
 * run dies at step 12 it resumes at step 12, not step 1.
 *
 * Every step is idempotent — re-running it cannot create duplicate businesses,
 * audits or messages.
 */
import { all, get, run, scalar, toJson } from '@/db';
import { nowIso } from '@/lib/id';
import { getSettings } from '@/lib/settings';
import { logAutomation } from '@/lib/logging';
import { executeJob, idempotencyKey, isJobLocked, resumableRun, toDeadLetter, withIdempotency, type JobDef, type StepContext } from './jobs';
import { enabledDiscoveryProviders, recordSourceRun } from '@/lib/providers/registry';
import { createBusiness, getBusiness, listContacts, upsertContact } from '@/repo/business';
import { scoreBusiness } from './scoring';
import { computeNba, persistSalesIntelligence } from './nba';
import { auditSocial } from '@/lib/audit/social';
import { auditWebsite, probeSeoFiles, verifyWebsiteStatus } from '@/lib/audit/website';
import { analyzeCompetitors } from '@/lib/audit/competitor';
import { persistAudit, persistSocialAudit } from './auditStore';
import { researchBusiness } from './research';
import { generateOutreach } from './outreach';
import { generateMockup } from './mockup';
import { sweepFollowUps } from './discovery';
import { refreshAnalyticsSnapshot } from './analytics';
import { buildDailyBriefing } from './briefing';
import { applyIcpRules } from './icp';
import { daysBetween } from '@/lib/time';

export const DISCOVERY_JOB_KEY = 'daily_discovery';

interface RunState {
  stats: Record<string, number>;
}

function stats(ctx: StepContext): RunState {
  const row = get<{ stats: string }>('SELECT stats FROM job_runs WHERE id = ?', [ctx.runId]);
  let parsed: Record<string, number> = {};
  try {
    parsed = JSON.parse(row?.stats ?? '{}') as Record<string, number>;
  } catch {
    parsed = {};
  }
  return { stats: parsed };
}

function bump(ctx: StepContext, key: string, by = 1): void {
  const { stats: s } = stats(ctx);
  s[key] = (s[key] ?? 0) + by;
  run('UPDATE job_runs SET stats = ?, updated_at = ? WHERE id = ?', [toJson(s), nowIso(), ctx.runId]);
}

/** Businesses this run should process — the working set, resolved once. */
function targetIds(orgId: string, limit: number): string[] {
  return all<{ id: string }>(
    `SELECT id FROM businesses
      WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
      ORDER BY opportunity_score IS NULL DESC, opportunity_score DESC, created_at DESC
      LIMIT ?`,
    [orgId, limit]
  ).map((r) => r.id);
}

export function buildDiscoveryJob(orgId: string): JobDef {
  const settings = getSettings(orgId);
  const limit = settings.discovery.maxBusinessesPerRun;

  return {
    key: DISCOVERY_JOB_KEY,
    label: 'Daily Discovery',
    maxRetries: 2,
    steps: [
      // 1. Discover from every enabled source
      {
        key: 'discover',
        label: 'Discover businesses',
        run: async (ctx) => {
          const sources = enabledDiscoveryProviders(orgId);
          if (!sources.length) {
            ctx.report(0, 0, 0, 'No discovery source is enabled and usable');
            return { processed: 0, detail: 'no usable source' };
          }
          let created = 0;
          let dupes = 0;
          const perSource = Math.max(5, Math.floor(limit / sources.length));
          for (const source of sources) {
            if (ctx.shouldStop()) break;
            try {
              const res = await source.discover(orgId, { limit: perSource });
              for (const record of res.records) {
                if (!record.name?.trim()) continue;
                // Idempotent per source+external id, so a retry cannot duplicate.
                const key = idempotencyKey([orgId, source.key, record.externalId ?? record.name]);
                const { deduplicated } = withIdempotency(orgId, key, 'discover', () => {
                  const { created: isNew } = createBusiness(
                    orgId,
                    {
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
                      foundedYear: record.foundedYear,
                      employeeEstimate: record.employeeEstimate,
                      isNewBusiness: record.isNewBusiness,
                      hiringSignal: record.hiringSignal,
                    },
                    {
                      providerKey: source.key,
                      sourceUrl: record.sourceUrl ?? null,
                      externalId: record.externalId ?? null,
                      confidence: record.confidence,
                    }
                  );
                  return { isNew };
                });
                if (deduplicated) dupes++;
                else created++;
              }
              recordSourceRun(orgId, source.key, true, res.records.length);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              recordSourceRun(orgId, source.key, false, 0, message);
              toDeadLetter(orgId, {
                runId: ctx.runId,
                jobKey: DISCOVERY_JOB_KEY,
                step: 'discover',
                category: 'discovery',
                entityType: 'discovery_source',
                entityId: source.key,
                error: message,
              });
            }
          }
          bump(ctx, 'discovered', created);
          bump(ctx, 'deduplicated', dupes);
          ctx.report(created + dupes, created, 0, `${sources.length} source(s)`);
          return { processed: created + dupes, succeeded: created, detail: `${created} new, ${dupes} duplicates` };
        },
      },

      // 2. Verify website status
      {
        key: 'verify_websites',
        label: 'Verify websites',
        optional: true,
        run: async (ctx) => {
          const ids = targetIds(orgId, limit);
          let checked = 0;
          const reverifyDays = settings.discovery.reverifyIntervalDays;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            const b = getBusiness(orgId, id);
            if (!b?.website) {
              run(`UPDATE businesses SET website_status = 'missing', website_checked_at = ? WHERE id = ?`, [nowIso(), id]);
              continue;
            }
            if (b.website_checked_at && daysBetween(b.website_checked_at) < reverifyDays) continue;
            try {
              const v = await verifyWebsiteStatus(b.website);
              run(`UPDATE businesses SET website_status = ?, website_checked_at = ? WHERE id = ?`, [v.status, nowIso(), id]);
              checked++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'verify_websites', category: 'website_analysis',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'websitesVerified', checked);
          ctx.report(ids.length, checked, 0);
          return { processed: ids.length, succeeded: checked };
        },
      },

      // 3. Website audit
      {
        key: 'audit_websites',
        label: 'Audit websites',
        optional: true,
        run: async (ctx) => {
          const ids = targetIds(orgId, limit);
          let audited = 0;
          const ttl = settings.discovery.cacheTtlHours;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            const b = getBusiness(orgId, id);
            if (!b) continue;
            const last = get<{ created_at: string }>('SELECT created_at FROM digital_audits WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [id]);
            if (last && daysBetween(last.created_at) * 24 < ttl) continue; // cached (§64)
            try {
              const result = await auditWebsite(b.website, { timeoutMs: 12_000 });
              if (b.website && result.verified) {
                const seo = await probeSeoFiles(b.website);
                result.hasSitemap = seo.sitemap;
                result.hasRobots = seo.robots;
              }
              persistAudit(orgId, id, result);
              audited++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'audit_websites', category: 'website_analysis',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'auditsCompleted', audited);
          ctx.report(ids.length, audited, 0);
          return { processed: ids.length, succeeded: audited };
        },
      },

      // 4. Social audit
      {
        key: 'audit_social',
        label: 'Audit social presence',
        optional: true,
        run: async (ctx) => {
          const ids = targetIds(orgId, limit);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            const b = getBusiness(orgId, id);
            if (!b) continue;
            try {
              const result = await auditSocial(b.social ?? {}, { businessName: b.name, industry: b.industry ?? undefined, live: false });
              persistSocialAudit(orgId, id, result);
              done++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'audit_social', category: 'audit',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'socialAudits', done);
          ctx.report(ids.length, done, 0);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 5. Competitors
      {
        key: 'competitors',
        label: 'Identify competitors',
        optional: true,
        run: async (ctx) => {
          const ids = targetIds(orgId, limit);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            const score = scalar<number>('SELECT opportunity_score FROM businesses WHERE id = ?', [id]) ?? 0;
            if (score < 50) continue;
            const has = (scalar<number>('SELECT COUNT(*) FROM competitors WHERE business_id = ?', [id]) ?? 0) > 0;
            if (has) continue;
            try {
              await analyzeCompetitors(orgId, id, { limit: 4 });
              done++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'competitors', category: 'ai',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'competitorAnalyses', done);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 6. Research high-value prospects
      {
        key: 'research',
        label: 'Research businesses',
        optional: true,
        run: async (ctx) => {
          const ids = all<{ id: string }>(
            `SELECT id FROM businesses WHERE org_id = ? AND merged_into IS NULL AND opportunity_score >= ?
               AND NOT EXISTS (SELECT 1 FROM research_docs r WHERE r.business_id = businesses.id)
             ORDER BY opportunity_score DESC LIMIT 20`,
            [orgId, settings.discovery.minScoreToMockup]
          ).map((r) => r.id);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            try {
              await researchBusiness(orgId, id, { actor: 'daily_discovery' });
              done++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'research', category: 'ai',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'researched', done);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 7. Enrich contacts
      {
        key: 'enrich',
        label: 'Enrich contacts',
        optional: true,
        run: async (ctx) => {
          if (!settings.discovery.autoEnrichment) {
            ctx.report(0, 0, 0, 'auto-enrichment disabled');
            return { processed: 0, detail: 'disabled' };
          }
          const { recomputeDataConfidence } = await import('./discovery');
          const ids = targetIds(orgId, limit);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            recomputeDataConfidence(orgId, id);
            done++;
          }
          bump(ctx, 'enriched', done);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 8. Score + rank
      {
        key: 'score',
        label: 'Score and rank prospects',
        run: async (ctx) => {
          const ids = targetIds(orgId, limit);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            try {
              scoreBusiness(orgId, id, { actor: 'daily_discovery', log: false });
              done++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'score', category: 'scoring',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'scored', done);
          ctx.report(ids.length, done, 0);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 9. Apply ICP rules + qualify
      {
        key: 'qualify',
        label: 'Apply ICP rules and qualify',
        run: async (ctx) => {
          const result = applyIcpRules(orgId);
          bump(ctx, 'qualified', result.qualified);
          bump(ctx, 'icpRejected', result.rejected);
          ctx.report(result.evaluated, result.qualified, 0, `${result.rejected} excluded by ICP`);
          return { processed: result.evaluated, succeeded: result.qualified, detail: `${result.rejected} excluded` };
        },
      },

      // 10. Recommended actions + sales intelligence
      {
        key: 'recommend',
        label: 'Generate recommended actions',
        run: async (ctx) => {
          const ids = targetIds(orgId, limit);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            computeNba(orgId, id);
            persistSalesIntelligence(orgId, id);
            done++;
          }
          bump(ctx, 'actionsRecommended', done);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 11. Outreach drafts
      {
        key: 'outreach',
        label: 'Generate outreach',
        optional: true,
        run: async (ctx) => {
          if (!settings.discovery.autoOutreachDrafts) {
            ctx.report(0, 0, 0, 'auto-outreach disabled');
            return { processed: 0, detail: 'disabled' };
          }
          const ids = all<{ id: string }>(
            `SELECT id FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
                AND opportunity_score >= ? AND consent_state NOT IN ('opted_out','do_not_contact')
                AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
                AND NOT EXISTS (SELECT 1 FROM outreach_messages o WHERE o.business_id = businesses.id AND o.direction = 'outbound')
              ORDER BY opportunity_score DESC LIMIT 40`,
            [orgId, settings.discovery.minScoreToQualify]
          ).map((r) => r.id);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            // Idempotent: one intro draft per business.
            const key = idempotencyKey([orgId, 'outreach', 'intro', id]);
            const { deduplicated } = withIdempotency(orgId, key, 'outreach_draft', async () => {
              await generateOutreach(orgId, id, { channel: 'email', purpose: 'intro', actor: 'daily_discovery' });
              return { ok: true };
            });
            if (!deduplicated) done++;
          }
          bump(ctx, 'outreachDrafts', done);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 12. Concepts
      {
        key: 'mockups',
        label: 'Generate website concepts',
        optional: true,
        run: async (ctx) => {
          if (!settings.discovery.autoMockup) {
            ctx.report(0, 0, 0, 'auto-mockup disabled');
            return { processed: 0, detail: 'disabled' };
          }
          const ids = all<{ id: string }>(
            `SELECT id FROM businesses WHERE org_id = ? AND merged_into IS NULL AND is_archived = 0
                AND opportunity_score >= ? AND consent_state NOT IN ('opted_out','do_not_contact')
                AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
                AND NOT EXISTS (SELECT 1 FROM mockups m WHERE m.business_id = businesses.id)
              ORDER BY opportunity_score DESC LIMIT 15`,
            [orgId, settings.discovery.minScoreToMockup]
          ).map((r) => r.id);
          let done = 0;
          for (const id of ids) {
            if (ctx.shouldStop()) break;
            try {
              await generateMockup(orgId, id, { actor: 'daily_discovery' });
              done++;
            } catch (err) {
              toDeadLetter(orgId, {
                runId: ctx.runId, jobKey: DISCOVERY_JOB_KEY, step: 'mockups', category: 'mockup',
                entityType: 'business', entityId: id, error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          bump(ctx, 'mockupsGenerated', done);
          return { processed: ids.length, succeeded: done };
        },
      },

      // 13. Follow-ups
      {
        key: 'followups',
        label: 'Create follow-up tasks',
        run: async (ctx) => {
          const created = await sweepFollowUps(orgId);
          bump(ctx, 'followUps', created);
          return { processed: created, succeeded: created };
        },
      },

      // 14. Analytics
      {
        key: 'analytics',
        label: 'Update analytics',
        run: async (ctx) => {
          refreshAnalyticsSnapshot(orgId);
          bump(ctx, 'analyticsRefreshed', 1);
          return { processed: 1, succeeded: 1 };
        },
      },

      // 15. Daily briefing
      {
        key: 'briefing',
        label: 'Generate daily briefing',
        run: async (ctx) => {
          buildDailyBriefing(orgId, { regenerate: true });
          bump(ctx, 'briefingGenerated', 1);
          return { processed: 1, succeeded: 1 };
        },
      },
    ],
  };
}

/**
 * Runs the daily discovery job. Resumes automatically when a previous run for
 * this job failed or was paused, so a crash at step 8 does not repeat steps 1-7.
 */
export async function runDiscoveryJob(
  orgId: string,
  opts: { trigger?: string; force?: boolean; resume?: boolean } = {}
): Promise<{ runId: string; status: string; resumed: boolean; error?: string }> {
  if (!opts.force && isJobLocked(orgId, DISCOVERY_JOB_KEY)) {
    const active = get<{ id: string }>(
      `SELECT id FROM job_runs WHERE org_id = ? AND job_key = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
      [orgId, DISCOVERY_JOB_KEY]
    );
    return { runId: active?.id ?? '', status: 'running', resumed: false, error: 'already running' };
  }

  const job = buildDiscoveryJob(orgId);

  // Resume a failed/paused run unless told to start fresh.
  let resumeRunId: string | undefined;
  if (opts.resume !== false) {
    const resumable = resumableRun(orgId, DISCOVERY_JOB_KEY);
    if (resumable) {
      resumeRunId = resumable.id;
      logAutomation(orgId, 'system', `Resuming ${DISCOVERY_JOB_KEY} from step "${resumable.last_successful_step ?? 'start'}"`, {
        level: 'info',
        runId: resumable.id,
      });
    }
  }

  // One run per calendar day per trigger, so a double-fired cron cannot run twice.
  const dayKey = idempotencyKey([orgId, DISCOVERY_JOB_KEY, new Date().toISOString().slice(0, 10), opts.trigger ?? 'cron']);

  const result = await executeJob(orgId, job, {
    trigger: opts.trigger ?? 'cron',
    resumeRunId,
    idempotencyKey: resumeRunId ? undefined : dayKey,
  });

  // Mirror into the legacy discovery_runs table so existing UI keeps working.
  mirrorToDiscoveryRuns(orgId, result.runId, result.status);

  return { runId: result.runId, status: result.status, resumed: !!resumeRunId, error: result.error };
}

function mirrorToDiscoveryRuns(orgId: string, runId: string, status: string): void {
  if (!runId) return;
  const jobRun = get<{ stats: string; started_at: string; finished_at: string | null; duration_ms: number | null; error: string | null; input_count: number }>(
    'SELECT stats, started_at, finished_at, duration_ms, error, input_count FROM job_runs WHERE id = ?',
    [runId]
  );
  if (!jobRun) return;
  let s: Record<string, number> = {};
  try {
    s = JSON.parse(jobRun.stats) as Record<string, number>;
  } catch {
    s = {};
  }
  const existing = get<{ id: string }>('SELECT id FROM discovery_runs WHERE id = ?', [runId]);
  const summary = `${s.discovered ?? 0} discovered · ${s.qualified ?? 0} qualified · ${s.mockupsGenerated ?? 0} concepts · ${s.outreachDrafts ?? 0} drafts`;
  if (existing) {
    run(`UPDATE discovery_runs SET status = ?, finished_at = ?, duration_ms = ?, stats = ?, summary = ? WHERE id = ?`, [
      status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'partial',
      jobRun.finished_at,
      jobRun.duration_ms,
      jobRun.stats,
      summary,
      runId,
    ]);
  } else {
    run(
      `INSERT INTO discovery_runs (id, org_id, kind, status, trigger, started_at, finished_at, duration_ms, input_count,
          stats, cost, error_count, summary, created_at)
       VALUES (?,?,?,?,'job',?,?,?,?, '{}',0,0,?,?)`,
      [
        runId,
        orgId,
        'scheduled',
        status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'partial',
        jobRun.started_at,
        jobRun.finished_at,
        jobRun.duration_ms,
        jobRun.input_count,
        summary,
        jobRun.started_at,
      ]
    );
  }
  run(
    `UPDATE automation_jobs SET last_run_at = ?, last_run_id = ?, last_status = ?, runs_total = runs_total + 1,
            runs_failed = runs_failed + ?, updated_at = ? WHERE org_id = ? AND key = ?`,
    [
      jobRun.started_at, runId, status, status === 'failed' ? 1 : 0, nowIso(), orgId, DISCOVERY_JOB_KEY,
    ]
  );
}
