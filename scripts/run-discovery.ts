/**
 * Runs the discovery pipeline once from the command line.
 *   npm run discovery            → live sources
 *   npm run discovery -- --offline → skip network work
 */
import { initDb } from './db-init';
import { runDiscovery } from '../src/engine/discovery';
import { startScheduler, stopScheduler, schedulerStatus } from '../src/engine/scheduler';
import { closeDb } from '../src/db';

async function main() {
  const offline = process.argv.includes('--offline');
  const withScheduler = process.argv.includes('--schedule');
  const { orgId } = initDb();

  const { runId, stats } = await runDiscovery(orgId, {
    kind: 'manual',
    trigger: 'cli',
    offline,
  });

  // eslint-disable-next-line no-console
  console.log(`\nDiscovery run ${runId}${offline ? ' (offline — network steps skipped)' : ''}\n`);
  const rows: [string, number | string][] = [
    ['Businesses discovered', stats.discovered],
    ['Duplicates resolved', stats.deduplicated],
    ['Identity verified', stats.identityVerified],
    ['Websites verified', stats.websiteVerified],
    ['Websites audited', stats.auditsCompleted],
    ['Social audits', stats.socialAudits],
    ['Competitor analyses', stats.competitorAnalyses],
    ['Growth signals', stats.growthSignals],
    ['Scored', stats.scored],
    ['Qualified', stats.qualified],
    ['High + critical priority', stats.highPriority + stats.criticalPriority],
    ['Actions recommended', stats.actionsRecommended],
    ['Outreach drafts', stats.outreachDrafts],
    ['Website concepts', stats.mockupsGenerated],
    ['Follow-ups created', stats.followUps],
    ['Errors', stats.errors],
    ['Cost', `$${stats.cost.toFixed(4)}`],
  ];
  for (const [label, value] of rows) {
    // eslint-disable-next-line no-console
    console.log(`  ${label.padEnd(26)} ${value}`);
  }

  // eslint-disable-next-line no-console
  console.log('\n  Per step:');
  for (const [step, s] of Object.entries(stats.perStep)) {
    // eslint-disable-next-line no-console
    console.log(`    ${step.padEnd(38)} ok=${s.ok} skipped=${s.skipped} errors=${s.error} ${(s.ms / 1000).toFixed(1)}s`);
  }

  if (withScheduler) {
    const started = startScheduler();
    // eslint-disable-next-line no-console
    console.log(`\nScheduler started — ${started.started} job(s) registered`);
    for (const j of started.jobs) {
      // eslint-disable-next-line no-console
      console.log(`  ${j.key.padEnd(20)} cron="${j.cron}" next=${j.nextRunAt}`);
    }
    // eslint-disable-next-line no-console
    console.log('Press Ctrl+C to stop.');
    process.on('SIGINT', () => {
      stopScheduler();
      closeDb();
      process.exit(0);
    });
  } else {
    closeDb();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Discovery failed:', err);
  closeDb();
  process.exit(1);
});
