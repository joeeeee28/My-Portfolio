'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { audit } from '@/lib/logging';

async function ctx() {
  const orgId = boot();
  const session = await getSession();
  return { orgId, actor: session.name };
}

function refresh(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath('/');
}

export interface ActionResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

const ok = (message: string, data?: unknown): ActionResult => ({ ok: true, message, data });
const fail = (message: string): ActionResult => ({ ok: false, message });

// ── Discovery & automation ───────────────────────────────────
export async function runDiscoveryNow(formData?: FormData): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { runDiscovery } = await import('@/engine/discovery');
    const offline = formData?.get('offline') === 'on';
    const res = await runDiscovery(orgId, { kind: 'manual', trigger: 'user', offline });
    refresh('/discover', '/prospects', '/automation');
    return ok(
      `${res.stats.discovered} discovered · ${res.stats.qualified} qualified · ${res.stats.mockupsGenerated} concepts · ${res.stats.errors} error(s)`
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function runJobNowAction(jobKey: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { runJobNow } = await import('@/engine/scheduler');
    const res = await runJobNow(orgId, jobKey);
    refresh('/automation');
    return res.ok ? ok(res.detail) : fail(res.detail);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function updateJobAction(jobKey: string, patch: { enabled?: boolean; cron?: string; schedule?: string; timezone?: string }): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { updateJobSchedule } = await import('@/engine/scheduler');
    updateJobSchedule(orgId, jobKey, patch);
    audit(orgId, 'automation.job_updated', { actor, entityType: 'automation_job', entityId: jobKey, detail: patch });
    refresh('/automation', '/settings');
    return ok('Schedule updated.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function refreshBriefingAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { buildDailyBriefing } = await import('@/engine/briefing');
    buildDailyBriefing(orgId, { regenerate: true });
    refresh('/');
    return ok('Briefing refreshed.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Scoring & intelligence ───────────────────────────────────
export async function scoreBusinessAction(businessId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { scoreBusiness } = await import('@/engine/scoring');
    const res = scoreBusiness(orgId, businessId, { actor });
    refresh(`/prospects/${businessId}`, '/prospects');
    return res ? ok(`Scored ${res.total}/100 — ${res.priority}.`) : fail('Business not found.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function rescoreAllAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { rescoreAll } = await import('@/engine/scoring');
    const res = rescoreAll(orgId);
    refresh('/prospects', '/pipeline', '/settings');
    return ok(`Re-scored ${res.scored} prospect(s).`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function auditBusinessAction(businessId: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { getBusiness } = await import('@/repo/business');
    const { auditWebsite, probeSeoFiles } = await import('@/lib/audit/website');
    const { auditSocial } = await import('@/lib/audit/social');
    const { analyzeCompetitors } = await import('@/lib/audit/competitor');
    const { persistAuditResults } = await import('@/engine/auditStore');

    const business = getBusiness(orgId, businessId);
    if (!business) return fail('Business not found.');

    const website = await auditWebsite(business.website, { timeoutMs: 15_000 });
    if (business.website && website.verified) {
      const seo = await probeSeoFiles(business.website);
      website.hasSitemap = seo.sitemap;
      website.hasRobots = seo.robots;
    }
    const social = await auditSocial(business.social ?? {}, { businessName: business.name, industry: business.industry ?? undefined, live: true });
    persistAuditResults(orgId, businessId, website, social);
    const competitors = await analyzeCompetitors(orgId, businessId, { limit: 4 });

    const { scoreBusiness } = await import('@/engine/scoring');
    scoreBusiness(orgId, businessId, { actor: 'user' });

    refresh(`/prospects/${businessId}`, '/audits', '/prospects');
    return ok(
      website.verified
        ? `Audit complete — website ${website.scores.website}/100, social ${social.socialScore}/100, ${competitors.competitors.length} peer(s) compared.`
        : `No website to audit (${website.websiteStatus}). Social ${social.socialScore}/100 recorded.`
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function researchBusinessAction(businessId: string, questions?: string[]): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { researchBusiness } = await import('@/engine/research');
    const doc = await researchBusiness(orgId, businessId, { force: true, customQuestions: questions, actor });
    refresh(`/prospects/${businessId}`, '/research');
    return doc
      ? ok(`Intelligence brief updated${doc.unverified_claims.length ? ` — ${doc.unverified_claims.length} claim(s) left unverified rather than guessed` : ''}.`)
      : fail('Business not found.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function askQuestionAction(businessId: string, question: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { askCustomQuestion } = await import('@/engine/research');
    const res = await askCustomQuestion(orgId, businessId, question);
    refresh(`/prospects/${businessId}`, '/research');
    return ok(res.answer, res);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Outreach ─────────────────────────────────────────────────
export async function generateOutreachAction(businessId: string, opts: { tone?: string; purpose?: string; channel?: string } = {}): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { generateOutreach } = await import('@/engine/outreach');
    const res = await generateOutreach(orgId, businessId, {
      tone: (opts.tone as never) ?? 'professional',
      purpose: opts.purpose ?? 'intro',
      channel: (opts.channel as never) ?? 'email',
      actor,
    });
    refresh(`/prospects/${businessId}`, '/outreach');
    if (!res) return fail('Business not found.');
    return res.compliance.allowed
      ? ok('Draft created. Approve it to send.', res.message)
      : fail(`Draft held by compliance: ${res.compliance.reasons.join(' ')}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function approveSendAction(messageId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { approveAndSend } = await import('@/engine/outreach');
    const res = await approveAndSend(orgId, messageId, actor);
    refresh('/outreach');
    return res.ok ? ok(res.simulated ? 'Queued in the local outbox — no provider connected, so nothing was sent externally.' : 'Sent.') : fail(res.reason ?? 'Send failed.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function rejectDraftAction(messageId: string, reason?: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { rejectDraft } = await import('@/engine/outreach');
    rejectDraft(orgId, messageId, actor, reason);
    refresh('/outreach');
    return ok('Draft rejected.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function recordReplyAction(businessId: string, body: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { recordReply } = await import('@/engine/outreach');
    const res = recordReply(orgId, businessId, body);
    refresh(`/prospects/${businessId}`, '/outreach', '/prospects');
    return ok(`Reply recorded — ${res.sentiment.label}${res.sequenceStopped ? ', sequence stopped' : ''}.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function markNotInterestedAction(businessId: string, note?: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { markNotInterested } = await import('@/engine/outreach');
    markNotInterested(orgId, businessId, note);
    refresh(`/prospects/${businessId}`, '/prospects', '/outreach');
    return ok('Marked not interested — all outreach and follow-ups stopped.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Sequences ────────────────────────────────────────────────
export async function enrollAction(sequenceId: string, businessId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { enroll } = await import('@/engine/outreach');
    const res = enroll(orgId, sequenceId, businessId, { actor });
    refresh('/sequences', `/prospects/${businessId}`);
    return res.ok ? ok('Enrolled in the sequence.') : fail(res.reason ?? 'Could not enrol.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function dispatchSequencesAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { dispatchSequences } = await import('@/engine/outreach');
    const res = await dispatchSequences(orgId, { actor: 'user' });
    refresh('/sequences', '/outreach');
    return ok(`${res.dispatched} step(s) processed · ${res.stopped} sequence(s) stopped · ${res.blocked} blocked by compliance · ${res.errors} error(s).`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Concepts (mockups) ───────────────────────────────────────
export async function generateConceptAction(businessId: string, direction?: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { generateMockup } = await import('@/engine/mockup');
    const res = await generateMockup(orgId, businessId, { direction: direction as never, actor });
    refresh(`/prospects/${businessId}`, '/mockups');
    return ok(`${res.model.theme.label} direction, ${res.model.sections.length} sections${res.notes.length ? `, ${res.notes.length} content gap(s) flagged` : ''}.`, {
      mockupId: res.mockupId,
      version: res.version,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function editConceptAction(mockupId: string, command: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { addVersion } = await import('@/engine/mockup');
    const res = await addVersion(orgId, mockupId, { command, actor });
    refresh(`/mockups/${mockupId}`, '/mockups');
    return ok(`Version ${res.version} created from: "${command}".`, { version: res.version });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function shareConceptAction(mockupId: string, enabled = true): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { shareMockup } = await import('@/engine/mockup');
    const res = shareMockup(orgId, mockupId, { enabled, actor });
    refresh('/mockups');
    return ok(enabled ? 'Concept shared and view tracking is live.' : 'Sharing disabled.', res);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function rollbackConceptAction(mockupId: string, toVersion: number): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { rollback } = await import('@/engine/mockup');
    const v = rollback(orgId, mockupId, toVersion, actor);
    refresh(`/mockups/${mockupId}`, '/mockups');
    return ok(`Rolled back to v${toVersion} — now published as v${v}.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Calls ────────────────────────────────────────────────────
export async function scheduleCallAction(businessId: string, data: { scheduledAt: string; title?: string; durationMin?: number }): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { scheduleCall, generateCallBriefing } = await import('@/engine/crm');
    const call = scheduleCall(orgId, businessId, { ...data, actor });
    await generateCallBriefing(orgId, businessId, call.id);
    refresh(`/prospects/${businessId}`, '/calls');
    return ok(`Call scheduled and briefing generated.`, { callId: call.id });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function summarizeCallAction(callId: string, outcome?: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { summarizeCall } = await import('@/engine/crm');
    const res = await summarizeCall(orgId, callId, { outcome: outcome as never });
    refresh('/calls');
    return ok(
      `${res.requirements.length} requirement(s), ${res.scope.length} scope item(s), ${res.objections.length} objection(s) extracted from the notes.`
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function addCallNoteAction(callId: string, body: string, kind = 'note'): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { addCallNote } = await import('@/engine/crm');
    addCallNote(orgId, callId, body, kind, actor);
    refresh('/calls');
    return ok('Note added.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function generateBriefingAction(businessId: string, callId?: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { generateCallBriefing } = await import('@/engine/crm');
    await generateCallBriefing(orgId, businessId, callId);
    refresh(`/prospects/${businessId}`, '/calls');
    return ok('Call briefing generated.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Proposals ────────────────────────────────────────────────
export async function generateProposalAction(businessId: string, opts: { callId?: string; discountPct?: number } = {}): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { generateProposal } = await import('@/engine/crm');
    const proposal = await generateProposal(orgId, businessId, { ...opts, actor });
    refresh(`/prospects/${businessId}`, '/proposals');
    return ok(`Proposal ${proposal.number} drafted — $${proposal.total.toFixed(2)}${proposal.recurring_total ? ` + $${proposal.recurring_total}/mo` : ''}.`, {
      proposalId: proposal.id,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function sendProposalAction(proposalId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { sendProposal } = await import('@/engine/crm');
    const p = sendProposal(orgId, proposalId, actor);
    refresh('/proposals');
    return ok(`Proposal ${p.number} sent.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function respondProposalAction(proposalId: string, decision: 'accepted' | 'rejected', note?: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { respondToProposal, convertToClient } = await import('@/engine/crm');
    respondToProposal(orgId, proposalId, decision, { note });
    let extra = '';
    if (decision === 'accepted') {
      const proposal = (await import('@/db')).get<{ business_id: string }>('SELECT business_id FROM proposals WHERE id = ?', [proposalId]);
      if (proposal) {
        await convertToClient(orgId, proposal.business_id, { proposalId, actor: 'system' });
        extra = ' Client converted and project created.';
      }
    }
    refresh('/proposals', '/clients', '/projects', '/pipeline');
    return ok(`Proposal ${decision}.${extra}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function requestDepositAction(proposalId: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { requestDeposit } = await import('@/engine/crm');
    const res = await requestDeposit(orgId, proposalId);
    refresh('/proposals');
    return res.status === 'failed' ? fail(res.message) : ok(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Clients & delivery ───────────────────────────────────────
export async function convertToClientAction(businessId: string, proposalId?: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { convertToClient } = await import('@/engine/crm');
    const res = await convertToClient(orgId, businessId, { proposalId, actor });
    refresh('/clients', '/projects', '/pipeline', `/prospects/${businessId}`);
    return ok(
      res.created
        ? `Client created from the existing business record${res.project ? ` and project "${res.project.name}" opened` : ''}. No duplicate record.`
        : 'Existing client record reused — no duplicate created.'
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function advanceProjectAction(projectId: string, stage: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { advanceProject } = await import('@/engine/crm');
    const p = advanceProject(orgId, projectId, stage as never, actor);
    refresh('/projects', '/clients');
    return ok(`Moved to ${p.stage.replace(/_/g, ' ')}.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function updateTaskAction(taskId: string, patch: { status?: string; progress?: number }): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { updateTask } = await import('@/engine/crm');
    updateTask(orgId, taskId, patch);
    refresh('/projects');
    return ok('Task updated.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function deployWebsiteAction(websiteId: string, domain?: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { deployWebsite } = await import('@/engine/crm');
    const res = await deployWebsite(orgId, websiteId, { domain, actor });
    refresh('/websites');
    return res.ok ? ok(res.message) : fail(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function publishFromConceptAction(mockupId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { publishWebsiteFromMockup, deployWebsite } = await import('@/engine/crm');
    const site = publishWebsiteFromMockup(orgId, mockupId, { actor });
    const res = await deployWebsite(orgId, site.id, { actor });
    refresh('/websites', '/mockups');
    return ok(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Follow-ups ───────────────────────────────────────────────
export async function completeFollowUpAction(followUpId: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  const { run } = await import('@/db');
  const { nowIso } = await import('@/lib/id');
  run("UPDATE follow_ups SET status = 'done', completed_at = ? WHERE id = ? AND org_id = ?", [nowIso(), followUpId, orgId]);
  refresh('/action-queue', '/prospects');
  return ok('Follow-up completed.');
}

export async function snoozeFollowUpAction(followUpId: string, hours: number): Promise<ActionResult> {
  const { orgId } = await ctx();
  const { run } = await import('@/db');
  const { nowIso } = await import('@/lib/id');
  run("UPDATE follow_ups SET status = 'pending', snoozed_until = ?, due_at = ? WHERE id = ? AND org_id = ?", [
    nowIso(),
    new Date(Date.now() + hours * 3_600_000).toISOString(),
    followUpId,
    orgId,
  ]);
  refresh('/action-queue', '/prospects');
  return ok(`Snoozed for ${hours}h.`);
}

// ── Settings ─────────────────────────────────────────────────
export async function saveSettingsAction(patch: Record<string, unknown>): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { saveSettings } = await import('@/lib/settings');
    saveSettings(orgId, patch as never);
    audit(orgId, 'settings.updated', { actor, detail: { keys: Object.keys(patch) } });
    refresh('/settings', '/automation');
    return ok('Settings saved.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setSecretAction(providerKey: string, value: string, label: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { setSecret } = await import('@/lib/secrets');
    setSecret(orgId, providerKey, value, label);
    audit(orgId, 'secret.stored', { actor, entityType: 'provider', entityId: providerKey, severity: 'warn' });
    refresh('/settings');
    return ok('Credential stored encrypted. The plaintext is never returned to the browser.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function deleteSecretAction(providerKey: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { deleteSecret } = await import('@/lib/secrets');
    deleteSecret(orgId, providerKey);
    audit(orgId, 'secret.deleted', { actor, entityType: 'provider', entityId: providerKey, severity: 'warn' });
    refresh('/settings');
    return ok('Credential removed.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setSourceEnabledAction(providerKey: string, enabled: boolean): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { setSourceEnabled } = await import('@/lib/providers/registry');
    setSourceEnabled(orgId, providerKey, enabled);
    audit(orgId, 'source.toggled', { actor, entityType: 'discovery_source', entityId: providerKey, detail: { enabled } });
    refresh('/settings', '/discover');
    return ok(enabled ? 'Source enabled.' : 'Source disabled.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setSourceConfigAction(providerKey: string, config: Record<string, unknown>): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { setSourceConfig } = await import('@/lib/providers/registry');
    setSourceConfig(orgId, providerKey, config);
    refresh('/settings', '/discover');
    return ok('Source configuration saved.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function saveScoringProfileAction(patch: { weights?: Record<string, number>; rules?: unknown[]; thresholds?: Record<string, number> }): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { saveProfile } = await import('@/engine/scoring');
    saveProfile(orgId, patch as never);
    const { rescoreAll } = await import('@/engine/scoring');
    const res = rescoreAll(orgId);
    audit(orgId, 'scoring.profile_updated', { actor, detail: { keys: Object.keys(patch) } });
    refresh('/settings', '/prospects', '/pipeline');
    return ok(`Scoring model saved and ${res.scored} prospect(s) re-scored.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function saveIcpAction(patch: Record<string, unknown>): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { run } = await import('@/db');
    const { nowIso } = await import('@/lib/id');
    const { toJson } = await import('@/db');
    const { get } = await import('@/db');
    const icp = get<{ id: string }>('SELECT id FROM icp_profiles WHERE org_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1', [orgId]);
    if (!icp) return fail('No active ICP profile.');
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const column = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      sets.push(`${column} = ?`);
      params.push(typeof v === 'object' ? toJson(v) : v);
    }
    if (!sets.length) return fail('Nothing to save.');
    params.push(nowIso(), icp.id);
    run(`UPDATE icp_profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params);
    refresh('/settings');
    return ok('Ideal Customer Profile saved.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setTaskRouteAction(task: string, opts: { modelId?: string | null; priority?: string; override?: boolean }): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { setTaskRoute } = await import('@/lib/ai/router');
    setTaskRoute(orgId, task, { modelId: opts.modelId ?? null, priority: opts.priority as never, override: opts.override });
    audit(orgId, 'ai.route_updated', { actor, entityType: 'ai_task', entityId: task, detail: opts });
    refresh('/settings');
    return ok('Model routing updated.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function runEvaluationAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { runModelEvaluation } = await import('@/lib/ai/router');
    const results = await runModelEvaluation(orgId);
    refresh('/settings');
    return ok(`Benchmarked ${results.length} task/model combination(s).`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function resolveOptimizationAction(recommendationId: string, decision: 'accepted' | 'rejected'): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { resolveOptimization } = await import('@/engine/experiments');
    const res = resolveOptimization(orgId, recommendationId, decision, actor);
    refresh('/settings', '/analytics');
    return ok(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function generateOptimizationsAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { generateOptimizationRecommendations, learnIcp } = await import('@/engine/experiments');
    const recs = generateOptimizationRecommendations(orgId);
    learnIcp(orgId);
    refresh('/settings', '/analytics');
    return ok(recs.length ? `${recs.length} optimization proposal(s) generated from realised outcomes.` : 'No new optimization proposals — not enough outcome data yet.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Forge AI ─────────────────────────────────────────────────
export async function runForgeCommandAction(input: string, targetBusinessId?: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  const session = await getSession();
  try {
    const { runCommand } = await import('@/engine/command');
    const res = await runForge(orgId, input, session.userId, targetBusinessId);
    return ok(res.answer, res);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function runForge(orgId: string, input: string, userId: string, targetBusinessId?: string) {
  const { runCommand } = await import('@/engine/command');
  return runCommand(orgId, input, { userId, targetBusinessId });
}

export async function executeForgeActionAction(runId: string, action: { label: string; kind: string; payload: Record<string, unknown>; external: boolean; confirmation: string }): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { executeProposedAction } = await import('@/engine/command');
    const res = await executeProposedAction(orgId, runId, action as never, { actor });
    refresh('/forge-ai', '/prospects', '/mockups', '/proposals', '/calls');
    return res.ok ? ok(res.message) : fail(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Import / bulk ────────────────────────────────────────────
export async function importCsvAction(formData: FormData): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const file = formData.get('file') as File | null;
    const text = file ? await file.text() : String(formData.get('text') ?? '');
    if (!text.trim()) return fail('No CSV supplied.');
    const { parseCsv, csvToImportRows, importRows } = await import('@/engine/io');
    const records = parseCsv(text);
    const { rows, unmapped } = csvToImportRows(records);
    if (!rows.length) return fail('No valid rows found. A "name" column is required.');
    const res = importRows(orgId, rows, { filename: file?.name, actor });
    refresh('/prospects', '/settings');
    return ok(
      `${res.imported} imported, ${res.deduplicated} duplicates skipped, ${res.invalid} invalid.${unmapped.length ? ` Unmapped columns: ${unmapped.join(', ')}.` : ''}`,
      res
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function runBulkActionAction(
  action: string,
  businessIds: string[],
  opts: { confirmed?: boolean; sequenceId?: string; ownerId?: string; stage?: string } = {}
): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { runBulkAction } = await import('@/engine/io');
    const res = await runBulkAction(orgId, action as never, businessIds, { ...opts, actor });
    refresh('/prospects', '/pipeline', '/outreach', '/mockups');
    return res.requiresApproval ? fail(res.message) : ok(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function mergeDuplicateAction(keepId: string, dropId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { mergeDuplicate } = await import('@/engine/io');
    const res = mergeDuplicate(orgId, keepId, dropId, actor);
    refresh('/prospects', '/settings');
    return res.ok ? ok('Duplicate merged. Every related record was repointed.' , res.moved) : fail(res.reason ?? 'Merge failed.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function deleteBusinessAction(businessId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { deleteBusinessData } = await import('@/engine/compliance');
    const res = deleteBusinessData(orgId, businessId, actor);
    refresh('/prospects');
    return res.deleted ? ok('Business and all related data deleted.') : fail(res.reason ?? 'Not found.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Social ───────────────────────────────────────────────────
export async function generateContentPlanAction(clientId: string, opts: { posts?: number; platforms?: string[] } = {}): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { generateContentPlan } = await import('@/engine/social');
    const res = await generateContentPlan(orgId, clientId, { ...opts, actor });
    refresh('/social', '/clients');
    return ok(`${res.created} post(s) drafted and sent to client review.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function resolveApprovalAction(approvalId: string, decision: 'approved' | 'revision' | 'rejected', note?: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { resolveApproval } = await import('@/engine/social');
    resolveApproval(orgId, approvalId, decision, { note, by: 'client' });
    refresh('/social', '/clients');
    return ok(`Marked ${decision}.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function publishPostAction(postId: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { publishPost } = await import('@/engine/social');
    const res = await publishPost(orgId, postId, { actor });
    refresh('/social');
    return res.ok ? ok(res.message) : fail(res.message);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function scanUpsellsAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { scanUpsells } = await import('@/engine/crm');
    const res = scanUpsells(orgId);
    refresh('/clients', '/analytics');
    return ok(res.length ? `${res.length} growth opportunit${res.length === 1 ? 'y' : 'ies'} identified.` : 'No new growth opportunities right now.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Stage / pipeline ─────────────────────────────────────────
export async function changeStageAction(businessId: string, stage: string): Promise<ActionResult> {
  const { orgId, actor } = await ctx();
  try {
    const { changeStage } = await import('@/lib/activity');
    const res = changeStage(orgId, businessId, stage as never, { actor });
    refresh(`/prospects/${businessId}`, '/pipeline', '/prospects');
    return res.ok ? ok(`Moved to ${stage.replace(/_/g, ' ')}.`) : fail(res.reason ?? 'No change.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function archiveBusinessAction(businessId: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { archiveBusiness } = await import('@/repo/business');
    archiveBusiness(orgId, businessId, 'Archived by user');
    refresh('/prospects');
    return ok('Archived. Reversible from Settings → Data.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function addMemoryAction(businessId: string, kind: string, key: string, value: string): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { remember } = await import('@/lib/ai/memory');
    remember(orgId, businessId, kind as never, key, value, { source: 'user' });
    refresh(`/prospects/${businessId}`);
    return ok('Remembered.');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function seedDemoAction(): Promise<ActionResult> {
  const { orgId } = await ctx();
  try {
    const { seedDemoData } = await import('@/data/seed');
    const res = seedDemoData(orgId);
    refresh('/prospects', '/discover', '/pipeline', '/clients', '/projects');
    return ok(`${res.businesses} demo business(es) created, ${res.contacts} contacts, ${res.clients} client(s). Clearly marked as demo data.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
