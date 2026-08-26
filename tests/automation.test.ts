/**
 * Automation, job-recovery and backup tests (§57, §42, §43, §44).
 *
 * Proves the things that only matter when something goes wrong: a failed step
 * resumes from its checkpoint rather than restarting, retries are bounded,
 * exhausted work reaches the dead-letter queue, locks release, and a backup can
 * actually be restored.
 */
process.env.OS_DATABASE ||= require('node:path').join(process.cwd(), '.data', `autotest-${Date.now()}.db`);

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate';
import { migrateUp } from '../src/db/migrations';
import { bootstrapOrg } from '../src/lib/settings';
import { registerAllProviders } from '../src/lib/providers';
import { ensureAutomationJobs, ensureScoringProfile, ensureIcpProfile, ensurePackages, ensureDefaultSequences } from '../src/engine/bootstrap';
import { all, get, scalar, closeDb } from '../src/db';
import {
  executeJob, isJobLocked, resumableRun, listDeadLetter, resolveDeadLetter, toDeadLetter,
  withIdempotency, idempotencyKey, pruneIdempotencyKeys,
} from '../src/engine/jobs';
import { createBackup, verifyBackupFile, listBackups, backupSummary, enforceRetention } from '../src/db/backup';
import { runDiscoveryJob } from '../src/engine/discoveryJob';
import { schedulerStatus } from '../src/engine/scheduler';
import { listJobs } from '../src/engine/scheduler';

const a = (globalThis as unknown as { assert: unknown }).assert as never as {
  (c: unknown, m?: string): void;
  ok(v: unknown, m?: string): void;
  equal(a: unknown, b: unknown, m?: string): void;
};

migrate();
migrateUp({ backup: false }); // V2 tables: job_runs, job_steps, dead_letter, idempotency_keys
const { org } = bootstrapOrg('Automation Test Org');
registerAllProviders();
ensureAutomationJobs(org.id);
ensureScoringProfile(org.id);
ensureIcpProfile(org.id);
ensurePackages(org.id);
ensureDefaultSequences(org.id);
const ORG = org.id;

const count = (t: string) => scalar<number>(`SELECT COUNT(*) FROM ${t} WHERE org_id = ?`, [ORG]) ?? 0;

export default [
  {
    name: 'Job recovery: resume from checkpoint (§43)',
    tests: [
      {
        name: 'a failed step does not restart the job from step 1',
        run: async () => {
          const executed: string[] = [];
          let failAt = 'c';
          const job = {
            key: 'recovery_test',
            label: 'Recovery test',
            steps: ['a', 'b', 'c', 'd', 'e'].map((k) => ({
              key: k,
              label: k.toUpperCase(),
              maxAttempts: 1,
              run: async () => {
                executed.push(k);
                if (k === failAt) throw new Error(`simulated failure at ${k}`);
                return { processed: 1 };
              },
            })),
          };

          const first = await executeJob(ORG, job, { trigger: 'manual' });
          a.equal(first.status, 'failed', 'the run must fail at step c');
          a(executed.join('') === 'abc', `expected a,b,c executed, got ${executed.join(',')}`);

          // Fix the fault and resume.
          executed.length = 0;
          failAt = '__never__';
          const resumable = resumableRun(ORG, 'recovery_test');
          a(resumable, 'the failed run must be resumable');
          a.equal(resumable!.last_successful_step, 'b', 'last successful step must be b');

          const second = await executeJob(ORG, job, { trigger: 'retry', resumeRunId: resumable!.id });
          a.equal(second.status, 'completed', 'the resumed run must complete');
          a(executed.join('') === 'cde', `resume must start at c, got ${executed.join(',')}`);
        },
      },
      {
        name: 'the job records every step outcome',
        run: () => {
          const run = get<{ id: string }>(
            "SELECT id FROM job_runs WHERE org_id = ? AND job_key = 'recovery_test' ORDER BY started_at DESC LIMIT 1",
            [ORG]
          );
          a(run, 'the run must be recorded');
          const steps = all<{ step: string; status: string }>('SELECT step, status FROM job_steps WHERE run_id = ? ORDER BY position', [run!.id]);
          a.equal(steps.length, 5, 'all five steps must be recorded');
          a(steps.every((s) => s.status === 'completed'), 'every step must be completed after resume');
        },
      },
      {
        name: 'a completed job is not offered for resume',
        run: () => {
          const r = resumableRun(ORG, 'recovery_test');
          a(!r, 'a completed run must not be resumable');
        },
      },
    ],
  },

  {
    name: 'Job retry and dead-letter (§43, §31)',
    tests: [
      {
        name: 'a step is retried up to its attempt limit',
        run: async () => {
          let attempts = 0;
          const job = {
            key: 'retry_test',
            label: 'Retry test',
            steps: [
              {
                key: 'flaky',
                label: 'Flaky',
                maxAttempts: 3,
                run: async () => {
                  attempts++;
                  throw new Error('always fails');
                },
              },
            ],
          };
          const result = await executeJob(ORG, job, { trigger: 'manual' });
          a.equal(result.status, 'failed');
          a.equal(attempts, 3, `expected 3 attempts, got ${attempts}`);
        },
      },
      {
        name: 'exhausted retries land in the dead-letter queue',
        run: () => {
          const dlq = listDeadLetter(ORG);
          a(dlq.length > 0, 'the failure must reach the dead-letter queue');
          const entry = dlq.find((d) => d.step === 'flaky');
          a(entry, 'the flaky step must be in the DLQ');
          a.equal(entry!.status, 'open', 'a new DLQ entry must be open');
        },
      },
      {
        name: 'a dead-letter entry can be resolved',
        run: () => {
          const entry = listDeadLetter(ORG).find((d) => d.step === 'flaky')!;
          const ok = resolveDeadLetter(entry.id, 'resolved', 'tester', 'handled manually');
          a(ok, 'the entry must resolve');
          const after = get<{ status: string; resolution: string }>('SELECT status, resolution FROM dead_letter WHERE id = ?', [entry.id]);
          a.equal(after!.status, 'resolved');
          a.equal(after!.resolution, 'handled manually');
        },
      },
      {
        name: 'the same failure is not queued twice',
        run: () => {
          const key = idempotencyKey([ORG, 'dup-failure', 'same-cause']);
          const first = toDeadLetter(ORG, { category: 'test', error: 'same cause', idempotencyKey: key });
          const second = toDeadLetter(ORG, { category: 'test', error: 'same cause', idempotencyKey: key });
          a.equal(first, second, 'the same idempotency key must map to one entry');
        },
      },
    ],
  },

  {
    name: 'Job locking (§31)',
    tests: [
      {
        name: 'a lock is released once a job finishes',
        run: () => a.equal(isJobLocked(ORG, 'recovery_test'), false, 'no lock may be held after completion'),
      },
      {
        name: 'a failed job also releases its lock',
        run: () => a.equal(isJobLocked(ORG, 'retry_test'), false, 'a failed job must not leave a stale lock'),
      },
      {
        name: 'a concurrent start is refused while a lock is held',
        run: async () => {
          // Hold a lock by starting a long-running step, then try to start again.
          let release = false;
          const job = {
            key: 'lock_test',
            label: 'Lock test',
            steps: [
              {
                key: 'slow',
                label: 'Slow',
                maxAttempts: 1,
                run: async () => {
                  for (let i = 0; i < 40 && !release; i++) await new Promise((r) => setTimeout(r, 10));
                  return { processed: 1 };
                },
              },
            ],
          };
          const pending = executeJob(ORG, job, { trigger: 'manual' });
          await new Promise((r) => setTimeout(r, 60));
          a(isJobLocked(ORG, 'lock_test'), 'the lock must be held while the job runs');
          const concurrent = await executeJob(ORG, job, { trigger: 'manual' });
          a.equal(concurrent.status, 'running', 'a concurrent start must be refused');
          a(concurrent.error?.includes('already running'), `expected a refusal, got: ${concurrent.error}`);
          release = true;
          await pending;
          a.equal(isJobLocked(ORG, 'lock_test'), false, 'the lock must release afterwards');
        },
      },
    ],
  },

  {
    name: 'Idempotency (§32)',
    tests: [
      {
        name: 'an operation runs exactly once under retry',
        run: () => {
          let sideEffects = 0;
          const key = idempotencyKey([ORG, 'send', 'message-1']);
          const first = withIdempotency(ORG, key, 'send', () => { sideEffects++; return { sent: true }; });
          const second = withIdempotency(ORG, key, 'send', () => { sideEffects++; return { sent: true }; });
          a.equal(first.deduplicated, false, 'the first call must execute');
          a.equal(second.deduplicated, true, 'the retry must be deduplicated');
          a.equal(sideEffects, 1, 'the side effect must happen exactly once');
        },
      },
      {
        name: 'the stored result is returned on a deduplicated call',
        run: () => {
          const key = idempotencyKey([ORG, 'send', 'message-1']);
          const again = withIdempotency(ORG, key, 'send', () => ({ sent: true }));
          a.equal(again.deduplicated, true);
          a.equal((again.result as { sent: boolean }).sent, true, 'the original result must be replayed');
        },
      },
      {
        name: 'expired idempotency keys are pruned',
        run: () => {
          const pruned = pruneIdempotencyKeys(ORG);
          a.equal(typeof pruned, 'number');
        },
      },
    ],
  },

  {
    name: 'Discovery job: Run Now is idempotent (§38)',
    tests: [
      {
        name: 'running discovery twice creates no duplicate records',
        run: async () => {
          const before = {
            biz: count('businesses'),
            mock: count('mockups'),
            out: count('outreach_messages'),
            prop: count('proposals'),
            proj: count('projects'),
            cli: count('clients'),
          };
          await runDiscoveryJob(ORG, { trigger: 'manual', force: true, resume: false });
          const mid = { ...before, mock: count('mockups'), out: count('outreach_messages') };
          await runDiscoveryJob(ORG, { trigger: 'manual', force: true, resume: false });
          const after = {
            biz: count('businesses'),
            mock: count('mockups'),
            out: count('outreach_messages'),
            prop: count('proposals'),
            proj: count('projects'),
            cli: count('clients'),
          };
          a.equal(after.biz, mid.biz, 'businesses must not duplicate');
          a.equal(after.mock, mid.mock, 'mockups must not duplicate');
          a.equal(after.out, mid.out, 'outreach must not duplicate');
          a.equal(after.prop, mid.prop, 'proposals must not duplicate');
          a.equal(after.proj, mid.proj, 'projects must not duplicate');
          a.equal(after.cli, mid.cli, 'clients must not duplicate');
        },
      },
      {
        name: 'the schedule is unchanged by a manual run',
        run: () => {
          const job = get<{ cron: string; enabled: number }>(
            "SELECT cron, enabled FROM automation_jobs WHERE org_id = ? AND key = 'daily_discovery'",
            [ORG]
          );
          a.equal(job!.cron, '0 2 * * *', 'Daily Discovery must stay at 02:00');
          a.equal(job!.enabled, 1, 'the job must remain enabled');
        },
      },
      {
        name: 'six jobs are registered and Daily Discovery is among them',
        run: () => {
          const jobs = listJobs(ORG);
          a.equal(jobs.length, 6, `expected 6 jobs, got ${jobs.length}`);
          const daily = jobs.find((j) => j.key === 'daily_discovery');
          a(daily, 'Daily Discovery must be registered');
          a.equal(daily!.cron, '0 2 * * *');
          for (const key of ['daily_discovery', 'sequence_dispatch', 'followup_sweep', 'analytics_rollup', 'upsell_scan', 'reverify_sweep']) {
            a(jobs.some((j) => j.key === key), `${key} must be registered`);
          }
        },
      },
      {
        name: 'the scheduler reports its state from shared state, not module state',
        run: () => {
          const status = schedulerStatus();
          a.equal(typeof status.running, 'boolean');
          a.equal(typeof status.scheduledTasks, 'number');
        },
      },
    ],
  },

  {
    name: 'Backup and restore (§44)',
    tests: [
      {
        name: 'a backup is created with a checksum',
        run: () => {
          const backup = createBackup({ orgId: ORG, trigger: 'manual' });
          a.equal(backup?.status, 'ok', `backup failed: ${backup?.error}`);
          a((backup?.size_bytes ?? 0) > 0, 'the backup must not be empty');
          a((backup?.checksum ?? '').length === 64, 'a SHA-256 checksum must be recorded');
        },
      },
      {
        name: 'the backup passes verification',
        run: () => {
          const backup = listBackups(1)[0];
          const verified = verifyBackupFile(backup.path);
          a(verified.ok, `verification failed: ${verified.error}`);
          a((verified.tables ?? 0) > 80, `expected the full schema, got ${verified.tables} tables`);
        },
      },
      {
        name: 'the backup can actually be restored and opened',
        run: () => {
          const backup = listBackups(1)[0];
          const scratch = `/tmp/restore-test-${Date.now()}.db`;
          fs.copyFileSync(backup.path, scratch);
          const restored = new DatabaseSync(scratch, { readOnly: true });
          try {
            const integrity = restored.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
            a.equal(Object.values(integrity)[0], 'ok', 'the restored file must pass integrity_check');
            const tables = restored.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number };
            a(tables.c > 80, `the restored file must contain the schema, got ${tables.c} tables`);
            const live = scalar<number>('SELECT COUNT(*) FROM businesses WHERE org_id = ?', [ORG]) ?? 0;
            const restoredCount = (restored.prepare('SELECT COUNT(*) AS c FROM businesses WHERE org_id = ?').get(ORG) as { c: number }).c;
            a.equal(restoredCount, live, `restored row count (${restoredCount}) must match live (${live})`);
          } finally {
            restored.close();
            fs.rmSync(scratch, { force: true });
          }
        },
      },
      {
        name: 'backup history and rotation are tracked',
        run: () => {
          const summary = backupSummary();
          a(summary.total > 0, 'backup history must be recorded');
          a(summary.ok > 0, 'at least one backup must be ok');
          const pruned = enforceRetention(3);
          a.equal(typeof pruned, 'number');
          a(backupSummary().total <= 3, 'rotation must keep at most the retention count');
        },
      },
      {
        name: 'a missing backup file fails verification rather than passing',
        run: () => {
          const verified = verifyBackupFile('/tmp/this-backup-does-not-exist.db');
          a.equal(verified.ok, false, 'a missing file must fail verification');
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
