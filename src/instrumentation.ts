/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * This is what makes Forge Automation actually autonomous (§4, §39): the cron
 * scheduler is registered against the long-lived server process, so Daily
 * Discovery fires at 02:00 without anyone running a command.
 *
 * Guarded to the Node.js runtime and to a single registration per process, so
 * hot reloads in development don't stack duplicate schedulers.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (globalThis.__clientforgeSchedulerStarted) return;
  globalThis.__clientforgeSchedulerStarted = true;

  try {
    const { boot } = await import('@/lib/boot');
    const { startScheduler, schedulerStatus } = await import('@/engine/scheduler');

    boot();
    const { started, jobs } = startScheduler();
    const status = schedulerStatus();

    // eslint-disable-next-line no-console
    console.log(
      `[Forge Automation] scheduler ${status.running ? 'running' : 'idle'} — ${started} job(s) registered`
    );
    for (const j of jobs) {
      // eslint-disable-next-line no-console
      console.log(`[Forge Automation]   ${j.key.padEnd(18)} cron="${j.cron}" next=${j.nextRunAt}`);
    }
  } catch (err) {
    // Never let scheduler startup take the app down with it.
    // eslint-disable-next-line no-console
    console.error('[Forge Automation] scheduler failed to start:', err);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __clientforgeSchedulerStarted: boolean | undefined;
}
