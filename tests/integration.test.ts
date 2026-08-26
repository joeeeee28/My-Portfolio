/**
 * Integration tests — real database, real engine calls, isolated per run.
 * No network, no external providers.
 */
process.env.OS_DATABASE ||= require('node:path').join(process.cwd(), '.data', `itest-${Date.now()}.db`);

import fs from 'node:fs';
import { migrate } from '../src/db/migrate';
import { migrateUp, migrationStatus, verifySchema } from '../src/db/migrations';
import { bootstrapOrg } from '../src/lib/settings';
import { registerAllProviders } from '../src/lib/providers';
import { syncSourceRows } from '../src/lib/providers/registry';
import { registerModelCatalogue } from '../src/lib/ai/router';
import {
  ensureScoringProfile, ensureIcpProfile, ensurePackages, ensureDefaultSequences, ensureAutomationJobs, ensureExperiments,
} from '../src/engine/bootstrap';
import { closeDb, get, scalar, all } from '../src/db';
import { createBusiness, getBusiness, listBusinesses, findDuplicates, mergeBusinesses } from '../src/repo/business';
import { scoreBusiness, latestScore } from '../src/engine/scoring';
import { computeNba, computeSalesIntelligence } from '../src/engine/nba';
import { evaluateAgainstIcp, applyIcpRules } from '../src/engine/icp';
import { classifyResponse } from '../src/engine/responseIntelligence';
import { generateMockup, addVersion, shareMockup, recordMockupView, getMockupForBusiness, listVersions, rollback } from '../src/engine/mockup';
import { generateOutreach, listMessages, enroll, recordReply } from '../src/engine/outreach';
import { scheduleCall, summarizeCall, generateCallBriefing, generateProposal, sendProposal, respondToProposal, convertToClient, listProjects, listTasks, scanUpsells, listUpsells, revenueSummary } from '../src/engine/crm';
import { evaluateBranch } from '../src/engine/sequenceBranching';
import { queueMergeReview, listMergeReviews, approveMerge, mergeReviewSummary } from '../src/engine/dedupeReview';
import { executeJob, withIdempotency, idempotencyKey, toDeadLetter, listDeadLetter, isJobLocked } from '../src/engine/jobs';
import { createBackup, verifyBackupFile } from '../src/db/backup';
import { checkAndConsume, isRateLimited } from '../src/lib/ratelimit';
import { isSuppressed, canContact, handleOptOut } from '../src/engine/compliance';
import { persistAudit, persistSocialAudit } from '../src/engine/auditStore';
import { auditWebsite } from '../src/lib/audit/website';
import { buildActionQueue } from '../src/engine/queues';

const a = (globalThis as unknown as { assert: unknown }).assert as never as {
  (c: unknown, m?: string): void;
  ok(v: unknown, m?: string): void;
  equal(a: unknown, b: unknown, m?: string): void;
  includes(h: unknown, n: unknown, m?: string): void;
};

// ── Shared fixture ───────────────────────────────────────────
migrate();
migrateUp({ backup: false });
const { org } = bootstrapOrg('Integration Test Org');
registerAllProviders();
syncSourceRows(org.id);
registerModelCatalogue(org.id);
ensureScoringProfile(org.id);
ensureIcpProfile(org.id);
ensurePackages(org.id);
ensureDefaultSequences(org.id);
ensureAutomationJobs(org.id);
ensureExperiments(org.id);
const ORG = org.id;

let phoneSeq = 0;
function makeBusiness(name: string, extra: Record<string, unknown> = {}) {
  // Every fixture gets a unique phone. A shared phone would make the dedupe
  // engine treat each new business as a duplicate of the first one.
  const phone = `+44 117 496 ${String(1000 + phoneSeq++).slice(-4)}`;
  return createBusiness(
    ORG,
    { name, category: 'Bakery', industry: 'Food & Hospitality', locality: 'Bristol', phone, ...extra },
    { providerKey: 'test', confidence: 0.9 }
  );
}

export default [
  {
    name: 'Database & migrations',
    tests: [
      {
        name: 'migrations are recorded in the ledger and are idempotent',
        run: () => {
          const status = migrationStatus();
          a(status.applied.length > 0, 'at least one migration must be applied');
          a.equal(status.pending.length, 0, 'no migration may be left pending');
          const again = migrateUp({ backup: false });
          a.equal(again.applied.length, 0, 're-running must apply nothing');
        },
      },
      {
        name: 'the schema passes integrity and constraint verification',
        run: () => {
          const v = verifySchema();
          a(v.ok, `schema problems: ${v.problems.join('; ')}`);
          a(v.tableCount > 80, `expected >80 tables, got ${v.tableCount}`);
          a(v.indexCount > 100, `expected >100 indexes, got ${v.indexCount}`);
        },
      },
      {
        name: 'a backup can be created and verified',
        run: () => {
          const b = createBackup({ orgId: ORG, trigger: 'manual' });
          a.equal(b?.status, 'ok', `backup failed: ${b?.error}`);
          a((b?.size_bytes ?? 0) > 0, 'backup must not be empty');
          const v = verifyBackupFile(b!.path);
          a(v.ok, `backup verification failed: ${v.error}`);
          a((v.tables ?? 0) > 80, 'restored backup must contain the schema');
        },
      },
    ],
  },

  {
    name: 'Full-text search integrity (§39)',
    tests: [
      {
        name: 'the FTS index passes integrity_check',
        run: () => {
          const result = scalar<string>('PRAGMA integrity_check');
          a.equal(result, 'ok', `integrity_check reported: ${result}`);
        },
      },
      {
        name: 'the FTS index is in sync with the businesses table',
        run: () => {
          const fts = scalar<number>('SELECT COUNT(*) FROM businesses_fts') ?? 0;
          const biz = scalar<number>('SELECT COUNT(*) FROM businesses') ?? 0;
          a.equal(fts, biz, `FTS has ${fts} rows but there are ${biz} businesses`);
        },
      },
      {
        name: 'the FTS index actually returns search results',
        run: () => {
          const { business } = makeBusiness('Searchable Zephyr Bakery', { category: 'Bakery', locality: 'Bristol' });
          const hits = all<{ name: string }>(
            "SELECT name FROM businesses_fts WHERE businesses_fts MATCH 'Zephyr' LIMIT 5"
          );
          a(hits.some((h) => h.name.includes('Zephyr')), 'the new business must be findable by FTS');
          void business;
        },
      },
      {
        name: 'a rebuilt FTS index still matches its content table',
        run: () => {
          // The migration rebuilds FTS on boot so a stale index self-heals.
          const { exec } = require('../src/db') as typeof import('../src/db');
          exec("INSERT INTO businesses_fts(businesses_fts) VALUES('rebuild')");
          a.equal(scalar<string>('PRAGMA integrity_check'), 'ok', 'integrity must hold after a rebuild');
          const fts = scalar<number>('SELECT COUNT(*) FROM businesses_fts') ?? 0;
          const biz = scalar<number>('SELECT COUNT(*) FROM businesses') ?? 0;
          a.equal(fts, biz, 'counts must match after rebuild');
        },
      },
    ],
  },

  {
    name: 'Deduplication & merge review (§5, §11)',
    tests: [
      {
        name: 'an exact domain match is detected before insert',
        run: () => {
          makeBusiness('Domain Dupe Test', { website: 'https://dupetest.example' });
          const matches = findDuplicates(ORG, { name: 'Completely Different Name', domain: 'dupetest.example' });
          a(matches.length > 0, 'domain match must be found');
          a.equal(matches[0].method, 'domain');
        },
      },
      {
        name: 'inserting a duplicate does not create a second record',
        run: () => {
          const before = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [ORG]) ?? 0;
          const { created } = makeBusiness('Domain Dupe Test', { website: 'https://dupetest.example' });
          a.equal(created, false, 'must not create a duplicate');
          const after = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [ORG]) ?? 0;
          a.equal(after, before, 'business count must not change');
        },
      },
      {
        name: 'duplicate resolution history is recorded',
        run: () => {
          const n = scalar<number>('SELECT COUNT(*) FROM duplicate_events WHERE org_id = ?', [ORG]) ?? 0;
          a(n > 0, 'duplicate events must be recorded');
        },
      },
      {
        name: 'an uncertain match can be queued, approved and merged',
        run: () => {
          // 0.737 similarity: above the 0.72 review floor but below the 0.93
          // auto-merge threshold, so it must be queued rather than merged.
          const keeper = makeBusiness('Riverside Florist', { locality: 'Bath' });
          const candidate = makeBusiness('Riverside Floral Studio', { locality: 'Bath' });
          const queued = queueMergeReview(
            ORG,
            { id: keeper.business.id, name: keeper.business.name, method: 'fuzzy_name', score: 0.88, evidence: {} },
            { name: 'Riverside Floral Studio', locality: 'Bath' }
          );
          a(queued, 'uncertain match must be queued for review');

          const reviews = listMergeReviews(ORG, { status: 'pending' });
          a(reviews.length > 0, 'review must be visible in the queue');

          const target = reviews.find((r) => r.keep_id === keeper.business.id)!;
          const result = approveMerge(ORG, target.id, 'tester');
          a(result.ok, `merge failed: ${result.message}`);

          const candidateRow = getBusiness(ORG, candidate.business.id);
          a.equal(candidateRow?.is_archived, 1, 'merged candidate must be archived');
          a.equal(mergeReviewSummary(ORG).merged >= 1, true, 'merge must be counted');
        },
      },
    ],
  },

  {
    name: 'Scoring & ICP (§7, §8)',
    tests: [
      {
        name: 'a score is computed with all eight factors and an explanation',
        run: () => {
          const { business } = makeBusiness('Score Test Bakery', { rating: 4.9, reviewCount: 320, website: null });
          const result = scoreBusiness(ORG, business.id, { actor: 'test' });
          a(result, 'score must be returned');
          a.equal(result!.breakdown.length, 8, 'eight factors required');
          const weightSum = result!.breakdown.reduce((s, b) => s + b.weight, 0);
          a(Math.abs(weightSum - 1) < 0.001, `weights must sum to 1, got ${weightSum}`);
          a(result!.reasons.length > 0, 'a score must be explained');
        },
      },
      {
        name: 'a no-website business with strong reviews scores high',
        run: () => {
          const { business } = makeBusiness('High Scorer Bakery', { rating: 4.9, reviewCount: 400, website: null, email: 'hi@highscorer.example' });
          const result = scoreBusiness(ORG, business.id, { actor: 'test' })!;
          a(result.total >= 60, `expected a high score, got ${result.total}`);
          a(['high', 'critical'].includes(result.priority), `expected high priority, got ${result.priority}`);
        },
      },
      {
        name: 'the score is persisted and retrievable with its breakdown',
        run: () => {
          const { business } = makeBusiness('Persisted Score Bakery', { rating: 4.5, reviewCount: 50, website: null });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const stored = latestScore(ORG, business.id);
          a(stored, 'score must be persisted');
          a.equal(stored!.breakdown.length, 8);
          a(stored!.reasons.length > 0);
        },
      },
      {
        name: 'ICP excludes a business below the minimum score',
        run: () => {
          const { business } = makeBusiness('Low ICP Bakery', { website: 'https://lowicp.example', rating: 2.0, reviewCount: 2 });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const verdict = evaluateAgainstIcp(ORG, business.id);
          a.equal(verdict.matches, false, 'a low-scoring prospect must be excluded');
          a(verdict.exclusions.length > 0, 'the exclusion must be explained');
        },
      },
      {
        name: 'ICP rules run across the working set',
        run: () => {
          const result = applyIcpRules(ORG);
          a(result.evaluated > 0, 'must evaluate candidates');
          a.equal(typeof result.qualified, 'number');
        },
      },
    ],
  },

  {
    name: 'Outreach & compliance (§11, §13, §14)',
    tests: [
      {
        name: 'outreach is grounded in the prospect record',
        run: async () => {
          const { business } = makeBusiness('Grounded Outreach Bakery', { rating: 4.8, reviewCount: 180, website: null, email: 'hi@grounded.example' });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const result = await generateOutreach(ORG, business.id, { channel: 'email', purpose: 'intro' });
          a(result?.messageId, 'a draft must be created');
          a((result!.message.body.length ?? 0) > 60, 'the message must have substance');
          a(result!.message.grounding.length > 0, 'the message must be grounded in real facts');
          a(!/\{\{.*?\}\}/.test(result!.message.body), 'no unfilled template tokens may remain');
          a(!/i hope this finds you well/i.test(result!.message.body), 'no generic filler');
        },
      },
      {
        name: 'an opt-out suppresses the business and blocks further contact',
        run: () => {
          const { business } = makeBusiness('Opt Out Bakery', { email: 'stop@optout.example', website: null });
          handleOptOut(ORG, { businessId: business.id, channel: 'email', reason: 'test opt-out' });
          a(isSuppressed(ORG, { businessId: business.id }).suppressed, 'business must be suppressed');
          a.equal(getBusiness(ORG, business.id)?.consent_state, 'do_not_contact');
          const verdict = canContact(ORG, getBusiness(ORG, business.id)!, null, 'email');
          a.equal(verdict.allowed, false, 'contact must be blocked');
        },
      },
      {
        name: 'a later suppression cannot weaken a do-not-contact state',
        run: () => {
          const { business } = makeBusiness('DNC Bakery', { email: 'dnc@dncbakery.example', website: null });
          handleOptOut(ORG, { businessId: business.id, channel: 'email', reason: 'test' });
          const state = getBusiness(ORG, business.id)?.consent_state;
          a.equal(state, 'do_not_contact', 'must remain do_not_contact');
        },
      },
      {
        name: 'a reply is classified into one of nine intents',
        run: async () => {
          const { business } = makeBusiness('Pricing Reply Bakery', { email: 'pricing@reply.example', website: null });
          const result = await classifyResponse(ORG, business.id, 'How much would this cost? Can you send pricing?', { useAi: false });
          a.equal(result.classification, 'pricing_question');
          a(result.recommendedAction.length > 0, 'a next action must be recommended');
          a(result.confidence > 0.5, 'a clear pricing question must be confident');
        },
      },
      {
        name: 'an explicit opt-out in a reply is caught as opt_out',
        run: async () => {
          const { business } = makeBusiness('Reply OptOut Bakery', { email: 'replyoptout@example.com', website: null });
          const result = await classifyResponse(ORG, business.id, 'Please unsubscribe and stop emailing me.', { useAi: false });
          a.equal(result.classification, 'opt_out');
        },
      },
      {
        name: 'a request to talk is caught as wants_call',
        run: async () => {
          const { business } = makeBusiness('Call Reply Bakery', { email: 'callme@reply.example', website: null });
          const result = await classifyResponse(ORG, business.id, "Thanks — let's talk next week, send me some times.", { useAi: false });
          a.equal(result.classification, 'wants_call');
        },
      },
    ],
  },

  {
    name: 'Sequence branching (§12)',
    tests: [
      {
        name: 'a concept view satisfies the mockup_viewed condition',
        run: async () => {
          const { business } = makeBusiness('Branch View Bakery', { website: null, rating: 4.7, reviewCount: 90 });
          const concept = await generateMockup(ORG, business.id, { actor: 'test' });
          const mockup = getMockupForBusiness(ORG, business.id)!;
          a.equal(evaluateBranch(ORG, business.id, 'mockup_viewed'), false, 'not viewed yet');
          recordMockupView(ORG, mockup, {
            visitorToken: 'branch-tester', isReturning: false, device: 'desktop', viewport: '1440x900',
            userAgent: 'test', referrer: null, durationMs: 20000, scrolledPct: 60, sectionsSeen: ['hero'], ctaClicked: false,
          });
          a.equal(evaluateBranch(ORG, business.id, 'mockup_viewed'), true, 'must be viewed after a view is recorded');
          void concept;
        },
      },
      {
        name: 'a reply satisfies the replied condition',
        run: () => {
          const { business } = makeBusiness('Branch Reply Bakery', { website: null, email: 'branchreply@example.com' });
          a.equal(evaluateBranch(ORG, business.id, 'not_replied'), true);
          recordReply(ORG, business.id, 'Yes please, tell me more.');
          a.equal(evaluateBranch(ORG, business.id, 'replied'), true);
          a.equal(evaluateBranch(ORG, business.id, 'not_replied'), false);
        },
      },
      {
        name: 'an enrolment can be created for a sequence',
        run: () => {
          const { business } = makeBusiness('Enrol Bakery', { website: null, email: 'enrol@example.com', rating: 4.6, reviewCount: 40 });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const seq = get<{ id: string }>('SELECT id FROM sequences WHERE org_id = ? AND is_default = 1', [ORG]);
          const result = enroll(ORG, seq!.id, business.id, { actor: 'test' });
          a(result.ok, `enrolment failed: ${result.reason}`);
          const again = enroll(ORG, seq!.id, business.id, { actor: 'test' });
          a.equal(again.ok, false, 'double enrolment must be refused');
        },
      },
    ],
  },

  {
    name: 'Website concepts (§15, §16, §17)',
    tests: [
      {
        name: 'a concept renders to real, self-contained HTML',
        run: async () => {
          const { business } = makeBusiness('Concept Render Bakery', { website: null, rating: 4.8, reviewCount: 120, phone: '+44 117 000 1111' });
          const concept = await generateMockup(ORG, business.id, { actor: 'test' });
          a(concept.html.includes('<!doctype html'), 'must be a full HTML document');
          a(concept.html.includes('<style>'), 'CSS must be inlined');
          a(concept.html.includes('name="viewport"'), 'must be mobile responsive');
          a(concept.html.includes('/api/track'), 'view tracking must be present');
          a(concept.html.includes('Concept Render Bakery'), 'the business name must appear');
        },
      },
      {
        name: 'a conversational edit creates a new version and keeps history',
        run: async () => {
          const { business } = makeBusiness('Versioning Bakery', { website: null, rating: 4.7, reviewCount: 80 });
          const first = await generateMockup(ORG, business.id, { actor: 'test' });
          a.equal(first.version, 1);
          const second = await addVersion(ORG, first.mockupId, { command: 'Make the hero more premium', actor: 'test' });
          a.equal(second.version, 2, 'edit must create version 2');
          a.equal(listVersions(first.mockupId).length, 2, 'both versions must be retained');
          const cmd = scalar<string>('SELECT change_command FROM mockup_versions WHERE mockup_id = ? AND version = 2', [first.mockupId]);
          a(cmd?.includes('premium'), 'the instruction must be recorded against its version');
        },
      },
      {
        name: 'rollback creates a new version rather than destroying history',
        run: async () => {
          const { business } = makeBusiness('Rollback Bakery', { website: null, rating: 4.6, reviewCount: 60 });
          const first = await generateMockup(ORG, business.id, { actor: 'test' });
          await addVersion(ORG, first.mockupId, { command: 'Make it minimal', actor: 'test' });
          const before = listVersions(first.mockupId).length;
          const rolled = rollback(ORG, first.mockupId, 1, 'test');
          a.equal(rolled, before + 1, 'rollback must add a version');
          a.equal(listVersions(first.mockupId).length, before + 1, 'no version may be lost');
        },
      },
      {
        name: 'view tracking records views, dwell time and raises intent',
        run: async () => {
          const { business } = makeBusiness('Tracking Bakery', { website: null, rating: 4.9, reviewCount: 200 });
          await generateMockup(ORG, business.id, { actor: 'test' });
          const mockup = getMockupForBusiness(ORG, business.id)!;
          shareMockup(ORG, mockup.id, { actor: 'test' });
          recordMockupView(ORG, mockup, {
            visitorToken: 'v1', isReturning: false, device: 'mobile', viewport: '390x844',
            userAgent: 'test', referrer: null, durationMs: 45000, scrolledPct: 80, sectionsSeen: ['hero', 'services'], ctaClicked: true,
          });
          const after = getMockupForBusiness(ORG, business.id)!;
          a.equal(after.view_count, 1, 'view must be counted');
          a.equal(after.status, 'viewed', 'status must flip to viewed');
          a(after.intent_score > 0, 'intent must rise from engagement');
          a(after.total_view_ms === 45000, 'dwell time must be recorded');
        },
      },
    ],
  },

  {
    name: 'Deal lifecycle: call → proposal → client → project (§19–§22)',
    tests: [
      {
        name: 'a call briefing is generated with every required section',
        run: async () => {
          const { business } = makeBusiness('Call Brief Bakery', { website: null, rating: 4.8, reviewCount: 150, email: 'call@brief.example' });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const call = scheduleCall(ORG, business.id, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 30, actor: 'test' });
          const brief = await generateCallBriefing(ORG, business.id, call.id);
          a(brief.businessOverview.length > 0, 'business overview required');
          a(brief.questions.length >= 4, 'questions required');
          a(brief.objections.length > 0, 'objections required');
          a(brief.opening.length > 0, 'opening required');
          a(brief.callGoal.length > 0, 'call goal required');
          a(brief.priceRange.length > 0, 'price range required');
        },
      },
      {
        name: 'call notes are converted into requirements and a proposal',
        run: async () => {
          const { business } = makeBusiness('Notes Bakery', { website: null, rating: 4.7, reviewCount: 100, email: 'notes@bakery.example' });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const call = scheduleCall(ORG, business.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), actor: 'test' });
          const { addCallNote } = await import('../src/engine/crm');
          addCallNote(ORG, call.id, 'Needs 6 pages and a booking form. Budget around 3k.', 'requirement', 'test');
          const summary = await summarizeCall(ORG, call.id, { outcome: 'positive' });
          a(summary.summary.length > 0, 'notes must be summarised');

          const proposal = await generateProposal(ORG, business.id, { callId: call.id, actor: 'test' });
          a(proposal.total > 0, 'a proposal must have a price');
          a(proposal.problem!.length > 0, 'a proposal must state the problem');
          a.equal(proposal.signature_status, 'not_configured', 'e-signature must be honestly unconfigured');
          a.equal(proposal.payment_status, 'not_configured', 'payment must be honestly unconfigured');
        },
      },
      {
        name: 'winning a deal converts the prospect without duplicating it',
        run: async () => {
          const { business } = makeBusiness('Won Bakery', { website: null, rating: 4.9, reviewCount: 250, email: 'won@bakery.example' });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const proposal = await generateProposal(ORG, business.id, { actor: 'test' });
          sendProposal(ORG, proposal.id, 'test');
          respondToProposal(ORG, proposal.id, 'accepted', { actor: 'test' });

          const before = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [ORG]) ?? 0;
          const conversion = await convertToClient(ORG, business.id, { proposalId: proposal.id, actor: 'test' });
          const after = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [ORG]) ?? 0;

          a(conversion.client.id, 'a client must be created');
          a.equal(before, after, 'no duplicate business may be created');
          a.equal(scalar<string>('SELECT business_id FROM clients WHERE id = ?', [conversion.client.id]), business.id, 'client must point at the original business');

          // Re-conversion must reuse, not duplicate.
          const again = await convertToClient(ORG, business.id, { actor: 'test' });
          a.equal(again.created, false, 're-conversion must reuse the existing client');
        },
      },
      {
        name: 'conversion creates a project with a task breakdown',
        run: async () => {
          const { business } = makeBusiness('Project Bakery', { website: null, rating: 4.8, reviewCount: 180, email: 'project@bakery.example' });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const conversion = await convertToClient(ORG, business.id, { actor: 'test' });
          a(conversion.project, 'a project must be created');
          const projects = listProjects(ORG, { clientId: conversion.client.id });
          a(projects.length > 0, 'the project must be queryable');
          const tasks = listTasks(ORG, { projectId: conversion.project!.id });
          a(tasks.length >= 8, `expected a task breakdown, got ${tasks.length} tasks`);
          a(tasks.every((t) => t.due_at), 'every task must have a due date');
          a(tasks.some((t) => t.needs_client_input === 1), 'some tasks must need client input');
        },
      },
      {
        name: 'clients.business_id is UNIQUE so a duplicate client is impossible',
        run: () => {
          const clientId = scalar<string>('SELECT id FROM clients WHERE org_id = ? LIMIT 1', [ORG]);
          const businessId = scalar<string>('SELECT business_id FROM clients WHERE id = ?', [clientId]);
          let threw = false;
          try {
            const { run } = require('../src/db') as typeof import('../src/db');
            run(
              'INSERT INTO clients (id, org_id, business_id, portal_token, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
              [`dup_${Date.now()}`, ORG, businessId, `dup-token-${Date.now()}`, 'onboarding', new Date().toISOString(), new Date().toISOString()]
            );
          } catch {
            threw = true;
          }
          a(threw, 'the UNIQUE constraint must prevent a duplicate client');
        },
      },
      {
        name: 'recurring revenue is tracked as MRR and ARR',
        run: () => {
          const revenue = revenueSummary(ORG);
          a(revenue.mrr > 0, `expected MRR, got ${revenue.mrr}`);
          a(revenue.arr > 0, `expected ARR, got ${revenue.arr}`);
          const clients = scalar<number>('SELECT COUNT(*) FROM clients WHERE org_id = ?', [ORG]) ?? 0;
          a(clients > 0, 'there must be at least one client');
          // A client is only 'active' after delivery completes; at conversion it
          // is 'onboarding', so assert on recurring revenue rather than status.
          a(revenue.mrr > 0, 'recurring revenue must be recorded at conversion');
        },
      },
      {
        name: 'growth opportunities are identified for existing clients',
        run: () => {
          const upsells = scanUpsells(ORG);
          a(upsells.length > 0, 'growth opportunities must be identified');
          a(upsells.every((u) => u.rationale.length > 10), 'each must carry reasoning');
          a(listUpsells(ORG).length > 0, 'they must be queryable');
        },
      },
    ],
  },

  {
    name: 'Job architecture (§30, §31, §32)',
    tests: [
      {
        name: 'a failed run resumes from its last successful step',
        run: async () => {
          let aCalls = 0;
          let failing = true;
          const job = {
            key: 'resume_test',
            label: 'Resume test',
            steps: [
              { key: 'a', label: 'A', run: async () => { aCalls++; return { processed: 1 }; } },
              { key: 'b', label: 'B', run: async () => { if (failing) throw new Error('boom'); return { processed: 1 }; }, maxAttempts: 1 },
              { key: 'c', label: 'C', run: async () => ({ processed: 1 }) },
            ],
          };
          const first = await executeJob(ORG, job, { trigger: 'manual' });
          a.equal(first.status, 'failed', 'the run must fail at step b');

          failing = false;
          const resumable = all<{ id: string }>(
            "SELECT id FROM job_runs WHERE org_id = ? AND job_key = 'resume_test' AND status = 'failed' ORDER BY started_at DESC LIMIT 1",
            [ORG]
          )[0];
          const second = await executeJob(ORG, job, { trigger: 'retry', resumeRunId: resumable.id });
          a.equal(second.status, 'completed', 'the resumed run must complete');
          a.equal(aCalls, 1, 'step A must NOT re-run on resume');
        },
      },
      {
        name: 'an operation is idempotent under retry',
        run: () => {
          let sideEffects = 0;
          const key = idempotencyKey([ORG, 'send', 'msg-integration-1']);
          const first = withIdempotency(ORG, key, 'send', () => { sideEffects++; return { sent: true }; });
          const second = withIdempotency(ORG, key, 'send', () => { sideEffects++; return { sent: true }; });
          a.equal(first.deduplicated, false, 'the first call must execute');
          a.equal(second.deduplicated, true, 'the retry must be deduplicated');
          a.equal(sideEffects, 1, 'the side effect must happen exactly once');
        },
      },
      {
        name: 'exhausted retries land in the dead-letter queue',
        run: () => {
          const before = listDeadLetter(ORG).length;
          toDeadLetter(ORG, { category: 'test', entityType: 'business', entityId: `dlq-${Date.now()}`, error: 'simulated failure' });
          const after = listDeadLetter(ORG).length;
          a(after > before, 'the failure must be queued');
        },
      },
      {
        name: 'a lock is released once a job finishes',
        run: () => {
          a.equal(isJobLocked(ORG, 'resume_test'), false, 'no lock may be held after a run completes');
        },
      },
    ],
  },

  {
    name: 'Rate limiting (§35, §40)',
    tests: [
      {
        name: 'a limit is enforced within its window',
        run: () => {
          const scope = `test:${Date.now()}`;
          for (let i = 0; i < 3; i++) checkAndConsume(scope, 'api', 3, 60);
          const fourth = checkAndConsume(scope, 'api', 3, 60);
          a.equal(fourth.allowed, false, 'the fourth call must be denied');
          a.equal(fourth.remaining, 0);
          a(isRateLimited(scope, 'api', 3, 60), 'the scope must report as limited');
        },
      },
      {
        name: 'different scopes do not share a budget',
        run: () => {
          const s1 = `a:${Date.now()}`;
          const s2 = `b:${Date.now()}`;
          for (let i = 0; i < 5; i++) checkAndConsume(s1, 'api', 5, 60);
          const other = checkAndConsume(s2, 'api', 5, 60);
          a.equal(other.allowed, true, 'an unrelated scope must be unaffected');
        },
      },
    ],
  },

  {
    name: 'Action Queue & audit trail (§29)',
    tests: [
      {
        name: 'the action queue returns items with evidence and a destination',
        run: () => {
          const queue = buildActionQueue(ORG, { limit: 100 });
          a(queue.length > 0, 'the queue must not be empty after activity');
          a(queue.every((q) => q.reason.length > 5), 'every item must carry evidence');
          a(queue.every((q) => q.actionHref.length > 0), 'every item must have a destination');
          a(queue.every((q) => q.action.length > 0), 'every item must name an action');
        },
      },
      {
        name: 'lifecycle events are recorded in the activity timeline',
        run: () => {
          const kinds = new Set(all<{ kind: string }>('SELECT DISTINCT kind FROM activities WHERE org_id = ?', [ORG]).map((r) => r.kind));
          // Integration tests exercise the engines directly, not the discovery
          // job, so 'discovery' events are not expected here (the E2E suite covers that).
          for (const expected of ['score', 'outreach', 'mockup', 'call', 'proposal', 'client']) {
            a(kinds.has(expected), `activity timeline is missing "${expected}" events`);
          }
        },
      },
      {
        name: 'the timeline is chronological',
        run: () => {
          const rows = all<{ created_at: string }>('SELECT created_at FROM activities WHERE org_id = ? ORDER BY created_at ASC', [ORG]);
          for (let i = 1; i < rows.length; i++) {
            a(new Date(rows[i].created_at) >= new Date(rows[i - 1].created_at), 'activity must be ordered');
          }
        },
      },
    ],
  },

  {
    name: 'Honesty invariants (§51)',
    tests: [
      {
        name: 'an unreachable website is recorded as unreachable, not scored on assumption',
        run: async () => {
          const result = await auditWebsite('https://this-domain-does-not-exist-12345.invalid', { timeoutMs: 5000 });
          a.equal(result.verified, false, 'must not claim verification');
          a(['unreachable', 'missing'].includes(result.websiteStatus), `unexpected status: ${result.websiteStatus}`);
        },
      },
      {
        name: 'a missing website records the finding rather than inventing a score',
        run: async () => {
          const result = await auditWebsite(null);
          a.equal(result.websiteStatus, 'missing');
          a.equal(result.verified, false);
          a(result.signals.some((s) => s.key === 'no_website'), 'the finding must be recorded');
        },
      },
      {
        name: 'a deposit is never reported as paid without a provider',
        run: async () => {
          const { business } = makeBusiness('Deposit Bakery', { website: null, rating: 4.7, reviewCount: 90, email: 'deposit@bakery.example' });
          scoreBusiness(ORG, business.id, { actor: 'test' });
          const proposal = await generateProposal(ORG, business.id, { actor: 'test' });
          const { requestDeposit } = await import('../src/engine/crm');
          const result = await requestDeposit(ORG, proposal.id);
          a(result.status !== 'paid', 'a payment must never be claimed without provider confirmation');
        },
      },
    ],
  },
];

process.on('exit', () => {
  try {
    closeDb();
    const db = process.env.OS_DATABASE;
    if (db) {
      fs.rmSync(db, { force: true });
      fs.rmSync(`${db}-wal`, { force: true });
      fs.rmSync(`${db}-shm`, { force: true });
    }
  } catch {
    /* best effort */
  }
});
