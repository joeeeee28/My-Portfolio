'use server';

/**
 * Form-based server actions.
 *
 * These accept FormData directly so a Server Component can hand a Client
 * Component a *reference* to the action rather than a closure — Next.js rejects
 * closures at that boundary. Identifiers travel as hidden inputs.
 */
import { revalidatePath } from 'next/cache';
import { boot } from '@/lib/boot';
import type { ActionResult } from './actions';

const ok = (message: string, data?: unknown): ActionResult => ({ ok: true, message, data });
const fail = (message: string): ActionResult => ({ ok: false, message });
const str = (fd: FormData, key: string) => String(fd.get(key) ?? '');
const num = (fd: FormData, key: string, fallback = 0) => {
  const n = Number(fd.get(key));
  return Number.isFinite(n) ? n : fallback;
};
const bool = (fd: FormData, key: string) => fd.get(key) === 'on';
const list = (fd: FormData, key: string) =>
  str(fd, key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function refresh(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath('/');
}

export async function formChangeStage(fd: FormData): Promise<ActionResult> {
  const { changeStageAction } = await import('./actions');
  const res = await changeStageAction(str(fd, 'id'), str(fd, 'stage'));
  refresh(`/prospects/${str(fd, 'id')}`, '/pipeline');
  return res;
}

export async function formAskQuestion(fd: FormData): Promise<ActionResult> {
  const { askQuestionAction } = await import('./actions');
  const res = await askQuestionAction(str(fd, 'id'), str(fd, 'q'));
  refresh(`/prospects/${str(fd, 'id')}`, '/research');
  return res;
}

export async function formRecordReply(fd: FormData): Promise<ActionResult> {
  const { recordReplyAction } = await import('./actions');
  const res = await recordReplyAction(str(fd, 'id'), str(fd, 'body'));
  refresh(`/prospects/${str(fd, 'id')}`, '/outreach');
  return res;
}

export async function formScheduleCall(fd: FormData): Promise<ActionResult> {
  const { scheduleCallAction } = await import('./actions');
  const when = str(fd, 'when');
  if (!when) return fail('Pick a date and time for the call.');
  const res = await scheduleCallAction(str(fd, 'id'), {
    scheduledAt: new Date(when).toISOString(),
    title: str(fd, 'title') || undefined,
    durationMin: num(fd, 'duration', 30),
  });
  refresh(`/prospects/${str(fd, 'id')}`, '/calls');
  return res;
}

export async function formAddMemory(fd: FormData): Promise<ActionResult> {
  const { addMemoryAction } = await import('./actions');
  const res = await addMemoryAction(str(fd, 'id'), str(fd, 'kind'), str(fd, 'key'), str(fd, 'value'));
  refresh(`/prospects/${str(fd, 'id')}`);
  return res;
}

export async function formAddCallNote(fd: FormData): Promise<ActionResult> {
  const { addCallNoteAction } = await import('./actions');
  const res = await addCallNoteAction(str(fd, 'callId'), str(fd, 'note'), str(fd, 'kind'));
  refresh('/calls');
  return res;
}

export async function formSetSecret(fd: FormData): Promise<ActionResult> {
  const { setSecretAction } = await import('./actions');
  const res = await setSecretAction(str(fd, 'providerKey'), str(fd, 'value'), str(fd, 'label'));
  refresh('/settings');
  return res;
}

export async function formSetTaskRoute(fd: FormData): Promise<ActionResult> {
  const { setTaskRouteAction } = await import('./actions');
  const model = str(fd, 'model');
  const res = await setTaskRouteAction(str(fd, 'task'), {
    modelId: model || null,
    priority: (str(fd, 'priority') || undefined) as never,
    override: true,
  });
  refresh('/settings');
  return res;
}

export async function formSaveScoring(fd: FormData): Promise<ActionResult> {
  const { saveScoringProfileAction } = await import('./actions');
  const factors = str(fd, 'factors').split(',');
  const weights: Record<string, number> = {};
  for (const f of factors) weights[f] = num(fd, f);
  const res = await saveScoringProfileAction({ weights });
  refresh('/settings', '/prospects', '/pipeline');
  return res;
}

export async function formSaveIcp(fd: FormData): Promise<ActionResult> {
  const { saveIcpAction } = await import('./actions');
  const res = await saveIcpAction({
    preferredIndustries: list(fd, 'industries'),
    minOpportunityScore: num(fd, 'minScore', 55),
    services: list(fd, 'services'),
  });
  refresh('/settings');
  return res;
}

export async function formSaveDiscovery(fd: FormData): Promise<ActionResult> {
  const { saveSettingsAction } = await import('./actions');
  const res = await saveSettingsAction({
    discovery: {
      schedule: str(fd, 'schedule') as never,
      cron: str(fd, 'cron'),
      minScoreToQualify: num(fd, 'minQualify', 55),
      minScoreToMockup: num(fd, 'minMockup', 82),
      cacheTtlHours: num(fd, 'ttl', 72),
      autoQualify: bool(fd, 'autoQualify'),
      autoMockup: bool(fd, 'autoMockup'),
      autoOutreachDrafts: bool(fd, 'autoDrafts'),
    },
  });
  refresh('/settings', '/automation');
  return res;
}

export async function formSaveOutreach(fd: FormData): Promise<ActionResult> {
  const { saveSettingsAction } = await import('./actions');
  const res = await saveSettingsAction({
    outreach: {
      approvalMode: str(fd, 'approvalMode') as never,
      dailySendLimit: num(fd, 'dailyLimit', 50),
      domainDailyLimit: num(fd, 'domainLimit', 30),
      quietHoursStart: str(fd, 'quietStart'),
      quietHoursEnd: str(fd, 'quietEnd'),
      requireConsent: bool(fd, 'requireConsent'),
      duplicateProtection: bool(fd, 'dupeProtect'),
    },
    compliance: {
      includeUnsubscribe: bool(fd, 'includeUnsub'),
      honourDoNotContact: bool(fd, 'honourDnc'),
      retentionDays: num(fd, 'retention', 730),
    },
  });
  refresh('/settings');
  return res;
}
