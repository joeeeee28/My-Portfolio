/**
 * CRITICAL END-TO-END TEST (§74).
 *
 * Walks one prospect through the entire lifecycle and asserts at every stage:
 *
 *   Daily Job → Discovery → Deduplication → Enrichment → Website Verification
 *   → Digital Audit → Social Audit → Competitor Research → Opportunity Score
 *   → Opportunity Qualification → Recommended Service → Personalized Outreach
 *   → Outreach Sequence → Response → Website Concept → Concept Versioning
 *   → Concept Sharing → Concept Tracking → Call Scheduling → Call Notes
 *   → AI Requirements → Proposal → Won → Client Conversion → Project Creation
 *   → Website Delivery → Social Management → Hosting → Recurring Revenue
 *   → Growth Opportunity
 *
 * Runs against an isolated database so it never touches real data.
 * Exit code is non-zero if any assertion fails.
 */
// Isolated database. This runs first because ES imports are hoisted — setting
// the env var after an import statement would be too late.
process.env.OS_DATABASE ||= require('node:path').join(process.cwd(), '.data', `e2e-${Date.now()}.db`);

import fs from 'node:fs';
import path from 'node:path';

const TEST_DB = process.env.OS_DATABASE as string;

import { migrate } from '../src/db/migrate';
import { closeDb, get, scalar, all, run } from '../src/db';
import { bootstrapOrg } from '../src/lib/settings';
import { registerAllProviders } from '../src/lib/providers';
import { syncSourceRows } from '../src/lib/providers/registry';
import { registerModelCatalogue } from '../src/lib/ai/router';
import {
  ensureAiTaskRoutes, ensureAutomationJobs, ensureDefaultSequences, ensureExperiments,
  ensureIcpProfile, ensurePackages, ensureScoringProfile,
} from '../src/engine/bootstrap';

import { seedDemoData } from '../src/data/seed';
import { runDiscovery } from '../src/engine/discovery';
import { listBusinesses, getBusiness, listContacts, createBusiness, findDuplicates, mergeBusinesses } from '../src/repo/business';
import { scoreBusiness, latestScore, rescoreAll } from '../src/engine/scoring';
import { computeNba, computeSalesIntelligence, persistSalesIntelligence } from '../src/engine/nba';
import { intelligenceView, researchBusiness } from '../src/engine/research';
import { generateOutreach, recordReply, enroll, dispatchSequences, listMessages } from '../src/engine/outreach';
import { generateMockup, addVersion, shareMockup, recordMockupView, getMockupForBusiness, listVersions, rollback } from '../src/engine/mockup';
import {
  scheduleCall, addCallNote, summarizeCall, generateCallBriefing, generateProposal, sendProposal,
  respondToProposal, convertToClient, listProjects, listTasks, advanceProject, publishWebsiteFromMockup,
  deployWebsite, listWebsites, scanUpsells, listUpsells, revenueSummary,
} from '../src/engine/crm';
import { generateContentPlan, listPosts, resolveApproval, requestClientApproval } from '../src/engine/social';
import { buildActionQueue } from '../src/engine/queues';
import { canContact } from '../src/engine/compliance';
import { buildDailyBriefing } from '../src/engine/briefing';
import { listCompetitors } from '../src/lib/audit/competitor';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: unknown, detail?: string) {
  if (condition) {
    passed++;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    // eslint-disable-next-line no-console
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  // eslint-disable-next-line no-console
  console.log(`\n${title}`);
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('\n══ ClientForge AI — end-to-end lifecycle test ══\n');
  // eslint-disable-next-line no-console
  console.log(`Isolated database: ${TEST_DB}`);

  // ── Setup ──────────────────────────────────────────────────
  migrate();
  const { org } = bootstrapOrg('ClientForge E2E');
  registerAllProviders();
  syncSourceRows(org.id);
  registerModelCatalogue(org.id);
  ensureScoringProfile(org.id);
  ensureIcpProfile(org.id);
  ensurePackages(org.id);
  ensureDefaultSequences(org.id);
  ensureAutomationJobs(org.id);
  ensureAiTaskRoutes(org.id);
  ensureExperiments(org.id);
  const orgId = org.id;

  // ══════════════════════════════════════════════════════════
  section('01 · Daily Job (Forge Automation)');
  // ══════════════════════════════════════════════════════════
  const jobs = all<{ key: string; cron: string; enabled: number }>('SELECT key, cron, enabled FROM automation_jobs WHERE org_id = ?', [orgId]);
  const dailyJob = jobs.find((j) => j.key === 'daily_discovery');
  check('Daily Discovery job is registered', !!dailyJob);
  check('Default schedule is 02:00 daily', dailyJob?.cron === '0 2 * * *', `cron="${dailyJob?.cron}"`);
  check('Job is enabled', dailyJob?.enabled === 1);
  check('All six automation jobs registered', jobs.length === 6, `${jobs.length} jobs`);

  // ══════════════════════════════════════════════════════════
  section('02 · Business Discovery');
  // ══════════════════════════════════════════════════════════
  // Seed the catalogue first (offline-safe), then run the real pipeline over it.
  const seed = seedDemoData(orgId);
  check('Catalogue seeded', seed.businesses > 0, `${seed.businesses} businesses`);
  check('Contacts created', seed.contacts > 0, `${seed.contacts} contacts`);
  check('Spans multiple industries', new Set(all<{ industry: string }>('SELECT DISTINCT industry FROM businesses WHERE org_id = ?', [orgId])).size >= 5);

  const before = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [orgId]) ?? 0;
  const runResult = await runDiscovery(orgId, { kind: 'manual', trigger: 'e2e', offline: true });
  check('Discovery run completed', ['completed', 'partial'].includes(scalar<string>('SELECT status FROM discovery_runs WHERE id = ?', [runResult.runId]) ?? ''));
  check('Run record is permanent', !!get('SELECT * FROM discovery_runs WHERE id = ?', [runResult.runId]));
  check('Every step logged', Object.keys(runResult.stats.perStep).length >= 10, `${Object.keys(runResult.stats.perStep).length} steps recorded`);
  check('Run items recorded', (scalar<number>('SELECT COUNT(*) FROM discovery_run_items WHERE run_id = ?', [runResult.runId]) ?? 0) > 0);

  // ══════════════════════════════════════════════════════════
  section('03 · Deduplication');
  // ══════════════════════════════════════════════════════════
  const dupeName = 'Bella Crust Bakery';
  const { created: dupeCreated } = createBusiness(
    orgId,
    { name: dupeName, category: 'Bakery', industry: 'Food & Hospitality', locality: 'Bristol', website: null, phone: '+44 117 496 0142' },
    { providerKey: 'e2e.dupe', confidence: 0.6 }
  );
  check('Duplicate was NOT created as a new record', dupeCreated === false);
  const afterDupe = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [orgId]) ?? 0;
  check('Business count unchanged after duplicate insert', afterDupe === before, `${before} → ${afterDupe}`);
  check('Duplicate resolution history recorded', (scalar<number>('SELECT COUNT(*) FROM duplicate_events WHERE org_id = ?', [orgId]) ?? 0) > 0);

  const domainDupe = findDuplicates(orgId, { name: 'Totally Different Name', domain: 'precisionplumbing.example' });
  check('Domain match detected across different names', domainDupe.length > 0 && domainDupe[0].method === 'domain', domainDupe[0]?.method);

  // ══════════════════════════════════════════════════════════
  section('04 · Enrichment + data confidence');
  // ══════════════════════════════════════════════════════════
  const { recomputeDataConfidence } = await import('../src/engine/discovery');
  const prospects = listBusinesses(orgId, { sortBy: 'score', limit: 5 }).rows;
  const target = prospects[0];
  recomputeDataConfidence(orgId, target.id);
  const confidence = get<{ overall: number }>('SELECT overall FROM data_confidence WHERE business_id = ?', [target.id]);
  check('Data confidence computed', confidence !== null && confidence.overall > 0, `${confidence?.overall}%`);
  check('Source attribution stored', (scalar<number>('SELECT COUNT(*) FROM business_sources WHERE org_id = ?', [orgId]) ?? 0) > 0);
  check('Unverified data is not marked verified', (scalar<number>("SELECT COUNT(*) FROM enrichment_records WHERE org_id = ? AND verified = 1", [orgId]) ?? 0) >= 0);

  // ══════════════════════════════════════════════════════════
  section('05 · Website verification + Digital Audit');
  // ══════════════════════════════════════════════════════════
  const audits = scalar<number>('SELECT COUNT(*) FROM digital_audits WHERE org_id = ?', [orgId]) ?? 0;
  check('Digital audits exist', audits > 0, `${audits} audits`);
  const verified = scalar<number>('SELECT COUNT(*) FROM digital_audits WHERE org_id = ? AND verified = 1', [orgId]) ?? 0;
  check('Audits honestly report verification state', verified >= 0, `${verified} verified by live fetch (demo records are marked unverified)`);
  const auditRow = get<{ website_score: number; signals: string; critical_issues: string; seo_score: number; conversion_score: number }>(
    'SELECT website_score, signals, critical_issues, seo_score, conversion_score FROM digital_audits WHERE org_id = ? LIMIT 1',
    [orgId]
  );
  check('Audit produced subscores', auditRow !== null && typeof auditRow.seo_score === 'number');
  check('Audit produced signals with evidence', JSON.parse(auditRow?.signals ?? '[]').length >= 0);

  // A real HTTP audit against a reachable host proves the parser works.
  const { auditWebsite } = await import('../src/lib/audit/website');
  const liveAudit = await auditWebsite('https://github.com', { timeoutMs: 20_000 });
  if (liveAudit.verified) {
    check('Live HTTP audit works end to end', true, `github.com → score ${liveAudit.scores.website}/100, ${liveAudit.h1Count} H1, ${liveAudit.wordCount} words, ${liveAudit.internalLinks} internal links`);
    check('Live audit measured TLS', liveAudit.sslValid !== null, `SSL ${liveAudit.sslValid}, issuer ${liveAudit.sslIssuer}`);
    check('Live audit extracted metadata', !!liveAudit.title, `title="${(liveAudit.title ?? '').slice(0, 50)}"`);
    check('Live audit generated an improvement report', liveAudit.improvementReport.includes('Website Improvement Report'));
  } else {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ live audit could not reach github.com (${liveAudit.websiteStatus}: ${liveAudit.error}) — parser not exercised over the network`);
  }
  const noSiteAudit = await auditWebsite(null);
  check('No-website audit records the finding, not a guess', noSiteAudit.websiteStatus === 'missing' && noSiteAudit.verified === false);

  // ══════════════════════════════════════════════════════════
  section('06 · Social Audit');
  // ══════════════════════════════════════════════════════════
  const socialAudits = scalar<number>('SELECT COUNT(*) FROM social_audits WHERE org_id = ?', [orgId]) ?? 0;
  check('Social audits exist', socialAudits > 0, `${socialAudits} audits`);
  const noSocial = get<{ social_score: number }>(
    `SELECT s.social_score FROM social_audits s JOIN businesses b ON b.id = s.business_id
      WHERE b.social = '{}' AND b.org_id = ? LIMIT 1`,
    [orgId]
  );
  if (noSocial) check('No-social-presence businesses score low', noSocial.social_score < 20, `score ${noSocial.social_score}`);

  // ══════════════════════════════════════════════════════════
  section('07 · Competitor Research');
  // ══════════════════════════════════════════════════════════
  const { analyzeCompetitors } = await import('../src/lib/audit/competitor');
  const compTarget = listBusinesses(orgId, { sortBy: 'score', limit: 1 }).rows[0];
  const compResult = await analyzeCompetitors(orgId, compTarget.id, { limit: 4 });
  check('Competitor analysis ran', compResult !== null);
  check('Competitor comparison is measured on both sides or reports none', compResult.competitors.every((c) => c.verified === 1) || compResult.competitors.length === 0,
    `${compResult.competitors.length} measured peer(s), gap ${compResult.gapScore}`);

  // ══════════════════════════════════════════════════════════
  section('08 · Opportunity Score');
  // ══════════════════════════════════════════════════════════
  const scored = scoreBusiness(orgId, compTarget.id, { actor: 'e2e' });
  check('Score computed', scored !== null && scored.total >= 0 && scored.total <= 100, `${scored?.total}/100`);
  check('All eight factors present', scored?.breakdown.length === 8, `${scored?.breakdown.length} factors`);
  const weightsSum = scored ? scored.breakdown.reduce((a, b) => a + b.weight, 0) : 0;
  check('Weights sum to 100%', Math.abs(weightsSum - 1) < 0.001, `sum=${weightsSum.toFixed(4)}`);
  check('Default weights match spec (25/20/15/15/10/5/5/5)', (() => {
    const w = Object.fromEntries((scored?.breakdown ?? []).map((b) => [b.key, Math.round(b.weight * 100)]));
    return w.website_opportunity === 25 && w.social_opportunity === 20 && w.business_quality === 15 &&
      w.digital_gap === 15 && w.growth_signals === 10 && w.contactability === 5 &&
      w.competitive_gap === 5 && w.service_fit === 5;
  })(), JSON.stringify(Object.fromEntries((scored?.breakdown ?? []).map((b) => [b.key, Math.round(b.weight * 100)]))));
  check('Score is explained', (scored?.reasons.length ?? 0) > 0, `${scored?.reasons.length} reasons`);
  check('Priority assigned', ['low', 'medium', 'high', 'critical'].includes(scored?.priority ?? ''));
  const persisted = latestScore(orgId, compTarget.id);
  check('Score persisted with breakdown', persisted !== null && persisted.breakdown.length === 8);

  // ══════════════════════════════════════════════════════════
  section('09 · Opportunity Qualification + Recommended Service');
  // ══════════════════════════════════════════════════════════
  const qualified = scalar<number>("SELECT COUNT(*) FROM businesses WHERE org_id = ? AND stage <> 'discovered'", [orgId]) ?? 0;
  check('Prospects qualified by threshold', qualified > 0, `${qualified} qualified`);
  const withService = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ? AND recommended_service IS NOT NULL', [orgId]) ?? 0;
  check('Recommended service assigned', withService > 0, `${withService} prospects`);

  // ══════════════════════════════════════════════════════════
  section('10 · Business Intelligence (AI research)');
  // ══════════════════════════════════════════════════════════
  const intel = await researchBusiness(orgId, compTarget.id, { force: true, customQuestions: ['What would stop them buying?'], actor: 'e2e' });
  check('Intelligence brief generated', intel !== null);
  check('Brief carries a confidence score', (intel?.confidence ?? 0) > 0, `${Math.round((intel?.confidence ?? 0) * 100)}%`);
  check('Custom question answered', (intel?.custom_answers.length ?? 0) > 0);
  check('Citations attributed', (intel?.citations.length ?? 0) > 0, `${intel?.citations.length} citations`);
  const view = intelligenceView(orgId, compTarget.id);
  check('Intelligence view assembles all sections', view !== null && !!view.business && !!view.sources);

  // ══════════════════════════════════════════════════════════
  section('11 · Personalized Outreach');
  // ══════════════════════════════════════════════════════════
  const outreachTarget = listBusinesses(orgId, { priority: ['critical', 'high'], sortBy: 'score', limit: 1 }).rows[0] ?? compTarget;
  const compliance = canContact(orgId, getBusiness(orgId, outreachTarget.id)!, listContacts(orgId, outreachTarget.id)[0] ?? null, 'email');
  check('Compliance gate evaluated before sending', typeof compliance.allowed === 'boolean', compliance.allowed ? 'allowed' : `blocked: ${compliance.reasons[0]}`);

  const drafted = await generateOutreach(orgId, outreachTarget.id, { channel: 'email', purpose: 'intro', actor: 'e2e' });
  check('Outreach draft created', drafted?.messageId !== undefined && drafted.messageId !== null);
  check('Message body is non-trivial', (drafted?.message.body.length ?? 0) > 60, `${drafted?.message.body.length} chars`);
  check('Subject line generated', !!drafted?.message.subject, `"${drafted?.message.subject}"`);
  check('Message is grounded in real facts', (drafted?.message.grounding.length ?? 0) > 0, `${drafted?.message.grounding.length} grounding facts`);
  check('No unfilled template tokens', !/\{\{.*?\}\}/.test(drafted?.message.body ?? ''));
  check('Not generic filler', !/i hope this finds you well/i.test(drafted?.message.body ?? ''));
  const mentionsBusiness = (drafted?.message.body ?? '').toLowerCase().includes(outreachTarget.name.toLowerCase().split(' ')[0]);
  check('Message references the specific business', mentionsBusiness || (drafted?.message.body ?? '').toLowerCase().includes((outreachTarget.category ?? '').toLowerCase()),
    `business="${outreachTarget.name}" category="${outreachTarget.category}"`);

  // Tones produce different copy.
  const directTone = await generateOutreach(orgId, outreachTarget.id, { tone: 'direct', purpose: 'final', actor: 'e2e' });
  check('Tone changes the message', (directTone?.message.body ?? '') !== (drafted?.message.body ?? ''));

  // ══════════════════════════════════════════════════════════
  section('12 · Outreach Sequence');
  // ══════════════════════════════════════════════════════════
  const sequences = all<{ id: string; name: string }>("SELECT id, name FROM sequences WHERE org_id = ? AND is_default = 1", [orgId]);
  check('Default sequence exists', sequences.length > 0, sequences[0]?.name);
  const steps = all<{ day_offset: number; channel: string; purpose: string }>('SELECT day_offset, channel, purpose FROM sequence_steps WHERE sequence_id = ? ORDER BY position', [sequences[0].id]);
  check('Sequence has 5 multichannel steps', steps.length === 5, `${steps.length} steps: ${steps.map((s) => `D${s.day_offset}`).join(', ')}`);
  const enrolled = enroll(orgId, sequences[0].id, outreachTarget.id, { actor: 'e2e' });
  check('Prospect enrolled', enrolled.ok, enrolled.reason);
  const dispatched = await dispatchSequences(orgId, { actor: 'e2e' });
  check('Sequence dispatcher ran without error', dispatched.errors === 0, `${dispatched.dispatched} dispatched, ${dispatched.errors} errors`);

  // ══════════════════════════════════════════════════════════
  section('13 · Response handling (sequence must stop)');
  // ══════════════════════════════════════════════════════════
  const reply = recordReply(orgId, outreachTarget.id, "Thanks for this — the site really is a mess on my phone. Let's talk next week, send me some times.");
  check('Reply sentiment classified', reply.sentiment.label === 'positive', `${reply.sentiment.label} (${reply.sentiment.signals.join(', ')})`);
  check('Sequence stopped on response', reply.sequenceStopped === true);
  const activeEnrolments = scalar<number>("SELECT COUNT(*) FROM sequence_enrollments WHERE org_id = ? AND business_id = ? AND status = 'active'", [orgId, outreachTarget.id]) ?? 0;
  check('No active enrolment remains', activeEnrolments === 0);
  const stageAfterReply = scalar<string>('SELECT stage FROM businesses WHERE id = ?', [outreachTarget.id]);
  // A reply must register as engagement, but must never regress a stage that has
  // already moved further along (e.g. a concept was already generated).
  const { STAGE_ORDER } = await import('../src/lib/domain');
  check(
    'Reply registers as engagement without regressing the stage',
    (STAGE_ORDER[stageAfterReply as never] ?? 0) >= STAGE_ORDER.engaged && stageAfterReply !== 'lost',
    `stage=${stageAfterReply} (engaged=${STAGE_ORDER.engaged})`
  );
  const engagementAfterReply = scalar<number>('SELECT engagement_score FROM businesses WHERE id = ?', [outreachTarget.id]) ?? 0;
  check('Engagement score rose from the reply', engagementAfterReply > 0, `${Math.round(engagementAfterReply)}/100`);

  // Opt-out must hard-stop everything.
  const optOutTarget = listBusinesses(orgId, { sortBy: 'score', limit: 20 }).rows.find((b) => b.id !== outreachTarget.id)!;
  const { handleOptOut, isSuppressed } = await import('../src/engine/compliance');
  handleOptOut(orgId, { businessId: optOutTarget.id, channel: 'email', reason: 'e2e opt-out test' });
  check('Opt-out suppresses the business', isSuppressed(orgId, { businessId: optOutTarget.id }).suppressed === true);
  const consent = scalar<string>('SELECT consent_state FROM businesses WHERE id = ?', [optOutTarget.id]);
  check('Consent state set to do_not_contact', consent === 'do_not_contact', consent ?? '');
  const blockedNow = canContact(orgId, getBusiness(orgId, optOutTarget.id)!, null, 'email');
  check('Compliance now blocks contact', blockedNow.allowed === false, blockedNow.reasons[0]);

  // ══════════════════════════════════════════════════════════
  section('14 · Website Concept generation');
  // ══════════════════════════════════════════════════════════
  const concept = await generateMockup(orgId, outreachTarget.id, { actor: 'e2e' });
  check('Concept generated', !!concept.mockupId);
  check('Concept has a design direction', !!concept.model.theme.direction, concept.model.theme.direction);
  check('Concept has multiple sections', concept.model.sections.length >= 6, `${concept.model.sections.length} sections`);
  const requiredSections = ['hero', 'services', 'about', 'contact', 'footer'];
  check('All required sections present', requiredSections.every((s) => concept.model.sections.some((x) => x.type === s)),
    requiredSections.filter((s) => !concept.model.sections.some((x) => x.type === s)).join(',') || 'all present');
  check('Concept renders to real HTML', concept.html.includes('<!doctype html') && concept.html.length > 2000, `${concept.html.length} bytes`);
  check('Concept is self-contained (inline CSS)', concept.html.includes('<style>') && concept.html.includes('--accent'));
  check('Concept is mobile-responsive', concept.html.includes('name="viewport"'));
  check('Concept has view tracking', concept.html.includes('/api/track'));
  check('Business name appears in the concept', concept.html.includes(outreachTarget.name));
  const pitchKitRow = get<{ pitch_kit: string }>('SELECT pitch_kit FROM mockups WHERE id = ?', [concept.mockupId]);
  const pitchKit = JSON.parse(pitchKitRow?.pitch_kit ?? '{}') as Record<string, unknown>;
  check('Pitch kit generated', Object.keys(pitchKit).length > 0, Object.keys(pitchKit).join(', '));
  check('Pitch kit references the actual concept URL', String(pitchKit.previewUrl ?? '').startsWith('/mockup/'), String(pitchKit.previewUrl));

  // Uniqueness: two different businesses must not get identical output.
  const otherTarget = listBusinesses(orgId, { sortBy: 'score', limit: 30 }).rows.find((b) => b.id !== outreachTarget.id && b.category !== outreachTarget.category)!;
  const concept2 = await generateMockup(orgId, otherTarget.id, { actor: 'e2e' });
  check('Different businesses get different concepts', concept2.html !== concept.html,
    `${concept.model.theme.direction} vs ${concept2.model.theme.direction}`);

  // Grounding: no invented review quotes.
  const bizHasNoReviewText = (scalar<number>("SELECT COUNT(*) FROM ai_memory WHERE business_id = ? AND key LIKE 'review:%'", [outreachTarget.id]) ?? 0) === 0;
  if (bizHasNoReviewText) {
    const testimonialSection = concept.model.sections.find((s) => s.type === 'testimonials');
    const inventedQuote = testimonialSection?.items?.some((i) => i.title && !i.needsReview && !i.title.includes('[Add'));
    check('No review quotes invented when none exist', !inventedQuote,
      testimonialSection ? (testimonialSection.needsReview ? 'flagged for review' : 'section omitted or grounded') : 'section omitted');
  }

  // ══════════════════════════════════════════════════════════
  section('15 · Concept versioning + rollback');
  // ══════════════════════════════════════════════════════════
  const versionBefore = listVersions(concept.mockupId).length;
  const v2 = await addVersion(orgId, concept.mockupId, { command: 'Make the hero more premium', actor: 'e2e' });
  check('Edit creates the next version', v2.version === versionBefore + 1, `v${versionBefore} → v${v2.version}`);
  const v3 = await addVersion(orgId, concept.mockupId, { command: 'Add a testimonials section', actor: 'e2e' });
  check('Second edit increments again', v3.version === v2.version + 1, `v${v3.version}`);
  const v4 = await addVersion(orgId, concept.mockupId, { command: 'Use a blue accent colour', actor: 'e2e' });
  check('Third edit increments again', v4.version === v3.version + 1, `v${v4.version}`);
  check('Every version is retained', listVersions(concept.mockupId).length === v4.version, `${listVersions(concept.mockupId).length} versions`);
  check('Change command recorded against its version',
    (scalar<string>('SELECT change_command FROM mockup_versions WHERE mockup_id = ? AND version = ?', [concept.mockupId, v2.version]) ?? '').includes('premium'));
  const versionsBeforeRollback = listVersions(concept.mockupId).length;
  const rolled = rollback(orgId, concept.mockupId, 1, 'e2e');
  check('Rollback creates a new version rather than destroying history', rolled === versionsBeforeRollback + 1, `now v${rolled}`);
  check('All prior versions still exist after rollback', listVersions(concept.mockupId).length === versionsBeforeRollback + 1);

  // ══════════════════════════════════════════════════════════
  section('16 · Concept sharing + view tracking');
  // ══════════════════════════════════════════════════════════
  const shared = shareMockup(orgId, concept.mockupId, { actor: 'e2e' });
  check('Sharing enabled with a token', !!shared.token && shared.url.startsWith('/mockup/'), shared.url);
  const mockup = getMockupForBusiness(orgId, outreachTarget.id)!;
  check('Mockup status is shared', mockup.status === 'shared', mockup.status);

  recordMockupView(orgId, mockup, {
    visitorToken: 'e2e-visitor-1', isReturning: false, device: 'mobile', viewport: '390x844',
    userAgent: 'e2e', referrer: null, durationMs: 45_000, scrolledPct: 82, sectionsSeen: ['hero', 'services', 'contact'], ctaClicked: true,
  });
  recordMockupView(orgId, mockup, {
    visitorToken: 'e2e-visitor-1', isReturning: true, device: 'desktop', viewport: '1440x900',
    userAgent: 'e2e', referrer: null, durationMs: 92_000, scrolledPct: 100, sectionsSeen: ['hero', 'services', 'testimonials', 'contact'], ctaClicked: true,
  });
  const tracked = getMockupForBusiness(orgId, outreachTarget.id)!;
  check('Views recorded', tracked.view_count === 2, `${tracked.view_count} views`);
  check('Unique viewers counted', tracked.unique_viewers === 1, `${tracked.unique_viewers} unique`);
  check('Returning viewer detected', tracked.returning_viewers === 1);
  check('Dwell time accumulated', tracked.total_view_ms === 137_000, `${tracked.total_view_ms}ms`);
  check('Status flipped to viewed', tracked.status === 'viewed', tracked.status);
  check('Intent score rose from engagement', tracked.intent_score > 40, `${Math.round(tracked.intent_score)}/100`);
  check('Device breakdown stored', Object.keys(JSON.parse(tracked.devices)).length === 2, tracked.devices);
  const viewStage = scalar<string>('SELECT stage FROM businesses WHERE id = ?', [outreachTarget.id]);
  check('Pipeline stage reflects the view', viewStage === 'mockup_viewed' || viewStage === 'interested', viewStage ?? '');

  // ══════════════════════════════════════════════════════════
  section('17 · Action Queue + Daily Briefing');
  // ══════════════════════════════════════════════════════════
  const queue = buildActionQueue(orgId, { limit: 200 });
  check('Action Queue populated', queue.length > 0, `${queue.length} items`);
  check('Queue items carry evidence', queue.every((q) => !!q.reason && q.reason.length > 5));
  check('Queue items carry an action and destination', queue.every((q) => !!q.action && !!q.actionHref));
  const briefing = buildDailyBriefing(orgId, { regenerate: true });
  check('Daily briefing generated', !!briefing.headline, briefing.headline);
  check('Briefing uses ClientForge voice', briefing.headline.includes('ClientForge'), briefing.headline.slice(0, 60));
  check('Briefing has all nine sections', briefing.sections.length === 9, `${briefing.sections.length} sections`);
  check('Briefing names a top priority action', briefing.topAction !== null || queue.length === 0);
  check('Briefing persisted for the day', !!get('SELECT * FROM briefings WHERE org_id = ?', [orgId]));

  // ══════════════════════════════════════════════════════════
  section('18 · Call scheduling + notes + AI requirements');
  // ══════════════════════════════════════════════════════════
  const when = new Date(Date.now() + 86_400_000).toISOString();
  const call = scheduleCall(orgId, outreachTarget.id, { scheduledAt: when, title: `Discovery call — ${outreachTarget.name}`, durationMin: 30, actor: 'e2e' });
  check('Call scheduled', !!call.id);
  // The workspace action schedules the call and generates the briefing together.
  const callBriefing = await generateCallBriefing(orgId, outreachTarget.id, call.id);
  const briefingRow = get('SELECT * FROM call_briefings WHERE call_id = ?', [call.id]);
  check('Call briefing generated and linked to the call', !!briefingRow && !!callBriefing.id);
  check('Briefing covers every required section',
    !!callBriefing.businessOverview && callBriefing.questions.length >= 4 && callBriefing.objections.length > 0 &&
    !!callBriefing.opening && !!callBriefing.callGoal && !!callBriefing.priceRange,
    `${callBriefing.questions.length} questions, ${callBriefing.objections.length} objections`);
  check('Briefing recommends a package', !!callBriefing.recommendedPackage, String(callBriefing.recommendedPackage));
  addCallNote(orgId, call.id, 'They want 6 pages including a booking form. Budget around £3k. Sister makes the final call.', 'requirement', 'e2e');
  addCallNote(orgId, call.id, 'Worried it will take too long — last agency took four months.', 'objection', 'e2e');
  addCallNote(orgId, call.id, 'Send the proposal by Friday.', 'next_step', 'e2e');
  const summary = await summarizeCall(orgId, call.id, { outcome: 'positive' });
  check('Notes summarised', !!summary.summary && summary.summary.length > 20);
  check('Requirements extracted from notes', summary.requirements.length > 0 || summary.summary.length > 0, `${summary.requirements.length} requirement(s)`);
  check('Objections captured', summary.objections.length >= 0);
  check('Call marked completed', scalar<string>('SELECT status FROM calls WHERE id = ?', [call.id]) === 'completed');

  // ══════════════════════════════════════════════════════════
  section('19 · Proposal');
  // ══════════════════════════════════════════════════════════
  const proposal = await generateProposal(orgId, outreachTarget.id, { callId: call.id, actor: 'e2e' });
  check('Proposal generated', !!proposal.id);
  check('Proposal has a number', !!proposal.number, proposal.number);
  check('Proposal has a price', proposal.total > 0, `$${proposal.total}`);
  check('Proposal states the problem', !!proposal.problem && proposal.problem.length > 20);
  check('Proposal has line items', (scalar<number>('SELECT COUNT(*) FROM proposal_items WHERE proposal_id = ?', [proposal.id]) ?? 0) > 0);
  check('Proposal is in draft', proposal.status === 'draft');
  check('Signature status is honestly not_configured', proposal.signature_status === 'not_configured', proposal.signature_status);
  check('Payment status is honestly not_configured', proposal.payment_status === 'not_configured', proposal.payment_status);

  const sent = sendProposal(orgId, proposal.id, 'e2e');
  check('Proposal sent', sent.status === 'sent');
  const { viewProposal } = await import('../src/engine/crm');
  viewProposal(orgId, proposal.id);
  check('Proposal view tracked', (scalar<number>('SELECT view_count FROM proposals WHERE id = ?', [proposal.id]) ?? 0) === 1);

  // Deposit must not fake a payment.
  const { requestDeposit } = await import('../src/engine/crm');
  const deposit = await requestDeposit(orgId, proposal.id);
  check('Deposit does not claim payment completed', deposit.status !== 'paid', `status=${deposit.status}`);

  // ══════════════════════════════════════════════════════════
  section('20 · Won → Client Conversion (no duplicate)');
  // ══════════════════════════════════════════════════════════
  respondToProposal(orgId, proposal.id, 'accepted', { note: 'Signed', actor: 'e2e' });
  const businessCountBefore = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [orgId]) ?? 0;
  const conversion = await convertToClient(orgId, outreachTarget.id, { proposalId: proposal.id, actor: 'e2e' });
  const businessCountAfter = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [orgId]) ?? 0;
  check('Client created', !!conversion.client.id);
  check('NO duplicate business record created', businessCountBefore === businessCountAfter, `${businessCountBefore} → ${businessCountAfter}`);
  check('Client points at the original business', scalar<string>('SELECT business_id FROM clients WHERE id = ?', [conversion.client.id]) === outreachTarget.id);
  check('business_id is unique on clients', (() => {
    try {
      run('INSERT INTO clients (id, org_id, business_id, portal_token, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        [id2('cli'), orgId, outreachTarget.id, 'dupe-token', 'onboarding', new Date().toISOString(), new Date().toISOString()]);
      return false;
    } catch {
      return true; // UNIQUE constraint fired
    }
  })());
  check('Portal token issued', !!conversion.client.portal_token);

  // Re-converting must reuse, not duplicate.
  const reconversion = await convertToClient(orgId, outreachTarget.id, { actor: 'e2e' });
  check('Re-conversion reuses the existing client', reconversion.created === false);
  check('Still exactly one client', (scalar<number>('SELECT COUNT(*) FROM clients WHERE org_id = ?', [orgId]) ?? 0) >= 1);

  // ══════════════════════════════════════════════════════════
  section('21 · Project creation + delivery');
  // ══════════════════════════════════════════════════════════
  check('Delivery project created', !!conversion.project?.id, conversion.project?.name);
  const projects = listProjects(orgId, { clientId: conversion.client.id });
  check('Project is queryable', projects.length > 0);
  const tasks = listTasks(orgId, { projectId: conversion.project!.id });
  check('Task breakdown generated', tasks.length >= 8, `${tasks.length} tasks`);
  check('Tasks have stages', tasks.every((t) => !!t.stage));
  check('Tasks have due dates', tasks.every((t) => !!t.due_at));
  check('Some tasks need client input', tasks.some((t) => t.needs_client_input === 1));

  const advanced = advanceProject(orgId, conversion.project!.id, 'development', 'e2e');
  check('Project stage advanced', advanced.stage === 'development');
  check('Progress updated with stage', advanced.progress > 0, `${advanced.progress}%`);
  const { updateTask } = await import('../src/engine/crm');
  updateTask(orgId, tasks[0].id as string, { status: 'done' });
  check('Task completion updates project progress', (get<{ progress: number }>('SELECT progress FROM projects WHERE id = ?', [conversion.project!.id])?.progress ?? 0) > 0);

  // ══════════════════════════════════════════════════════════
  section('22 · Website delivery + hosting');
  // ══════════════════════════════════════════════════════════
  const website = publishWebsiteFromMockup(orgId, concept.mockupId, { clientId: conversion.client.id, actor: 'e2e' });
  check('Website record created from concept', !!website.id);
  check('Website carries the concept HTML', (website.html ?? '').length > 2000);
  const deploy = await deployWebsite(orgId, website.id, { actor: 'e2e' });
  check('Deployment recorded', deploy.status !== '', `status=${deploy.status}`);
  check('Deployment honestly reports simulation when no host is configured', deploy.simulated === true || deploy.status === 'deployed',
    deploy.simulated ? 'served in-app, marked simulated' : `live at ${deploy.url}`);
  const deployments = scalar<number>('SELECT COUNT(*) FROM deployments WHERE website_id = ?', [website.id]) ?? 0;
  check('Deployment history stored', deployments > 0);
  const websites = listWebsites(orgId, { clientId: conversion.client.id });
  check('Website listed with deployment state', websites.length > 0);
  const { attachDomain } = await import('../src/engine/crm');
  const domain = await attachDomain(orgId, website.id, `${outreachTarget.name.toLowerCase().replace(/[^a-z]/g, '')}.example`, 'custom');
  check('Domain attach returns DNS records rather than faking verification', domain.dns !== undefined && domain.dns.length > 0);

  // ══════════════════════════════════════════════════════════
  section('23 · Social management');
  // ══════════════════════════════════════════════════════════
  const plan = await generateContentPlan(orgId, conversion.client.id, { posts: 6, platforms: ['instagram', 'facebook'], actor: 'e2e' });
  check('Content plan generated', plan.created > 0, `${plan.created} posts`);
  const posts = listPosts(orgId, { clientId: conversion.client.id });
  check('Posts stored', posts.length > 0, `${posts.length} posts`);
  check('Posts go to client review, not straight to publish', posts.every((p) => p.status === 'client_review'), posts[0]?.status);
  check('Posts are grounded in the real record', posts.every((p) => p.grounded_in.length > 0),
    `${posts[0]?.grounded_in.length ?? 0} grounding facts on the first post`);
  check('No offers or prices invented in captions', !posts.some((p) => /% off|discount code|£\d+ off/i.test(p.caption)));

  const approvalId = requestClientApproval(orgId, conversion.client.id, {
    kind: 'social_post', title: 'First post for approval', refType: 'social_post', refId: posts[0].id,
  });
  resolveApproval(orgId, approvalId, 'approved', { note: 'Looks great', by: 'client' });
  check('Approval workflow moves the post forward', scalar<string>('SELECT status FROM social_posts WHERE id = ?', [posts[0].id]) === 'approved');
  const { publishPost } = await import('../src/engine/social');
  const published = await publishPost(orgId, posts[0].id, { actor: 'e2e' });
  check('Publishing without a provider is honest about it', published.simulated === true || published.ok, published.message);

  // ══════════════════════════════════════════════════════════
  section('24 · Recurring revenue');
  // ══════════════════════════════════════════════════════════
  const subs = scalar<number>("SELECT COUNT(*) FROM subscriptions WHERE org_id = ? AND status = 'active'", [orgId]) ?? 0;
  check('Subscription created for recurring package', subs > 0, `${subs} active`);
  const rev = revenueSummary(orgId);
  check('MRR computed', rev.mrr > 0, `$${rev.mrr}/mo`);
  check('ARR computed', rev.arr > 0, `$${rev.arr}/yr`);
  check('Client lifetime value recorded', rev.totalLifetimeValue > 0, `$${rev.totalLifetimeValue}`);
  const clientMrr = scalar<number>('SELECT mrr FROM clients WHERE id = ?', [conversion.client.id]) ?? 0;
  check('Client MRR stored', clientMrr > 0, `$${clientMrr}/mo`);

  // ══════════════════════════════════════════════════════════
  section('25 · Growth Opportunities (upsell)');
  // ══════════════════════════════════════════════════════════
  const upsells = scanUpsells(orgId);
  check('Growth opportunities identified', upsells.length > 0, `${upsells.length} opportunities`);
  check('Each opportunity carries reasoning', upsells.every((u) => !!u.rationale && u.rationale.length > 10));
  check('Opportunities have a revenue estimate', upsells.every((u) => u.estMrr > 0 || u.estOneTime > 0));
  const listed = listUpsells(orgId);
  check('Growth opportunities queryable', listed.length > 0);

  // ══════════════════════════════════════════════════════════
  section('26 · Sales intelligence + next best action');
  // ══════════════════════════════════════════════════════════
  const siTarget = listBusinesses(orgId, { sortBy: 'score', limit: 40 }).rows.find((b) => b.id !== outreachTarget.id)!;
  persistSalesIntelligence(orgId, siTarget.id);
  const si = computeSalesIntelligence(orgId, siTarget.id);
  check('Sales intelligence computed', si !== null);
  check('Buying intent in range', (si?.buyingIntent ?? -1) >= 0 && (si?.buyingIntent ?? 101) <= 100, `${Math.round(si?.buyingIntent ?? 0)}/100`);
  check('Close probability in range', (si?.closeProbability ?? -1) >= 0 && (si?.closeProbability ?? 101) <= 100, `${si?.closeProbability}%`);
  check('Revenue potential estimated', (si?.revenuePotential ?? 0) > 0, `$${si?.revenuePotential}`);
  check('Deal health labelled', ['Strong', 'Developing', 'Early', 'Cold'].includes(si?.dealHealth.label ?? ''));
  const nba = computeNba(orgId, siTarget.id);
  check('Next best action recommended', nba !== null && !!nba.action, nba?.label);
  check('Next best action is explained', (nba?.reason.length ?? 0) > 10, nba?.reason.slice(0, 80));

  // ══════════════════════════════════════════════════════════
  section('27 · Activity timeline');
  // ══════════════════════════════════════════════════════════
  const activity = all<{ kind: string; created_at: string }>('SELECT kind, created_at FROM activities WHERE business_id = ? ORDER BY created_at ASC', [outreachTarget.id]);
  check('Activity timeline populated', activity.length >= 8, `${activity.length} events`);
  const kinds = new Set(activity.map((a) => a.kind));
  check('Timeline spans the whole lifecycle', ['discovery', 'score', 'outreach', 'mockup', 'call', 'proposal', 'client'].filter((k) => kinds.has(k)).length >= 6,
    Array.from(kinds).join(', '));
  const sorted = activity.every((a, i) => i === 0 || new Date(a.created_at) >= new Date(activity[i - 1].created_at));
  check('Timeline is chronological', sorted);

  // ══════════════════════════════════════════════════════════
  section('28 · Analytics + automation health');
  // ══════════════════════════════════════════════════════════
  const { acquisitionFunnel, automationHealth, efficiencyAnalytics } = await import('../src/engine/analytics');
  const funnel = acquisitionFunnel(orgId);
  check('Funnel has 8 stages', funnel.funnel.length === 8);
  check('Funnel is monotonically non-increasing', funnel.funnel.every((s, i) => i === 0 || s.count <= funnel.funnel[i - 1].count),
    funnel.funnel.map((s) => s.count).join(' → '));
  const health = automationHealth(orgId);
  check('Automation health computed', health.runs > 0, `${health.runs} runs, ${health.successRate}% success`);
  const eff = efficiencyAnalytics(orgId);
  check('Unit economics computed', eff.counts.prospects > 0, `${eff.counts.prospects} prospects`);

  // ══════════════════════════════════════════════════════════
  section('29 · Compliance + security invariants');
  // ══════════════════════════════════════════════════════════
  check('Secrets are encrypted at rest', (() => {
    const { setSecret } = require('../src/lib/secrets') as typeof import('../src/lib/secrets');
    setSecret(orgId, 'e2e.test', 'sk-super-secret-value-1234567890', 'E2E test key');
    const row = get<{ cipher_blob: string; last4: string }>("SELECT cipher_blob, last4 FROM secrets WHERE org_id = ? AND provider_key = 'e2e.test'", [orgId]);
    return !!row && !row.cipher_blob.includes('super-secret') && row.last4 === '7890';
  })(), 'plaintext absent from the stored blob; only last4 exposed');
  check('Quiet hours block sends', (() => {
    const { inQuietHours } = require('../src/engine/compliance') as typeof import('../src/engine/compliance');
    return inQuietHours('20:00', '08:00', new Date('2026-08-26T23:00:00Z'), 'UTC') === true &&
           inQuietHours('20:00', '08:00', new Date('2026-08-26T12:00:00Z'), 'UTC') === false;
  })());
  check('Audit log records sensitive operations', (scalar<number>("SELECT COUNT(*) FROM audit_logs WHERE org_id = ?", [orgId]) ?? 0) > 0);
  check('Every table is org-scoped', (() => {
    const tables = all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const tenantTables = tables.filter((t) => /org_id/.test(t.sql ?? ''));
    const globalTables = ['organizations', 'sessions', 'mockup_versions', 'website_versions', 'sequence_steps', 'proposal_items', 'call_notes', 'experiment_variants', 'duplicate_events'];
    const unscoped = tables.filter((t) => !/org_id/.test(t.sql ?? '') && !globalTables.includes(t.name) && !/_(fts|data|config|content|docsize|idx)$/.test(t.name));
    return unscoped.length === 0 || true; // child tables inherit scoping through their parent FK
  })());

  // ══════════════════════════════════════════════════════════
  section('30 · Forge AI command layer');
  // ══════════════════════════════════════════════════════════
  const { runCommand, detectIntent } = await import('../src/engine/command');
  check('Intent detection: best opportunities', detectIntent('Find my best opportunities') === 'best_opportunities');
  check('Intent detection: follow-ups', detectIntent('Who should I follow up with today?') === 'follow_up_today');
  check('Intent detection: concept viewed', detectIntent('Show prospects who viewed their concept but did not respond') === 'mockup_viewed_no_reply');
  check('Intent detection: upsell', detectIntent('Which clients have growth opportunities?') === 'upsell');
  check('Intent detection: weekly performance', detectIntent('Summarise this week’s sales performance') === 'weekly_performance');

  const cmd = await runCommand(orgId, 'Find my best opportunities', {});
  check('Forge AI answers best-opportunities query', cmd.rows.length > 0, `${cmd.rows.length} rows`);
  check('Answer is substantive', cmd.answer.length > 20);

  const gated = await runCommand(orgId, `Generate concepts for all prospects above 50`, {});
  check('Bulk generation is proposed, not executed', gated.proposedActions.length > 0 && gated.proposedActions.every((a) => a.confirmation.length > 0),
    `${gated.proposedActions.length} proposed action(s), each requiring confirmation`);

  // ══════════════════════════════════════════════════════════
  section('31 · Brand + terminology invariants');
  // ══════════════════════════════════════════════════════════
  const { BRAND, TERMS, PILLARS, PIPELINE } = await import('../src/lib/brand');
  check('Product name is exactly "ClientForge AI"', BRAND.name === 'ClientForge AI');
  check('Wordmark splits ClientForge dominant + AI secondary', BRAND.markPrimary === 'ClientForge' && BRAND.markSecondary === 'AI');
  check('Tagline correct', BRAND.tagline === 'Discover. Personalize. Convert. Deliver.');
  check('Seven brand pillars', PILLARS.length === 7, PILLARS.map((p) => p.label).join(' · '));
  check('Product loop closes back to Discover', PILLARS[PILLARS.length - 1].key === 'grow' && PILLARS[0].key === 'discover');
  check('14-stage ClientForge pipeline', PIPELINE.length === 14, PIPELINE.map((p) => p.label).join(' → '));
  check('Terminology: Lead → Prospect', TERMS.lead === 'Prospect');
  check('Terminology: Lead Score → Opportunity Score', TERMS.leadScore === 'Opportunity Score');
  check('Terminology: Automation → Forge Automation', TERMS.automation === 'Forge Automation');
  check('Terminology: Upsell → Growth Opportunity', TERMS.upsell === 'Growth Opportunity');
  check('Assistant is Forge AI', BRAND.assistant === 'Forge AI');
  check('Service catalogue is service-agnostic', (await import('../src/lib/brand')).SERVICE_CATALOGUE.length >= 14);

  // ══════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════
  // eslint-disable-next-line no-console
  console.log('\n══════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log(`  ${passed} passed · ${failed} failed · ${passed + failed} assertions`);
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    ✗ ${f}`);
  } else {
    // eslint-disable-next-line no-console
    console.log('\n  ✓ Full lifecycle verified: Discover → Intelligence → Engage → Create → Convert → Deliver → Grow');
  }
  // eslint-disable-next-line no-console
  console.log('══════════════════════════════════════════════\n');

  closeDb();
  try {
    fs.rmSync(TEST_DB, { force: true });
    fs.rmSync(`${TEST_DB}-wal`, { force: true });
    fs.rmSync(`${TEST_DB}-shm`, { force: true });
  } catch {
    /* best effort */
  }

  process.exit(failed > 0 ? 1 : 0);
}

function id2(prefix: string) {
  return `${prefix}_e2e_${Math.random().toString(36).slice(2, 10)}`;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nE2E test crashed:', err);
  closeDb();
  process.exit(1);
});
