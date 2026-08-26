/**
 * Sequence branching (§12).
 *
 * V1 sequences were strictly linear: step 1, then 2, then 3. That cannot express
 * "if they viewed the concept, escalate; otherwise send the normal follow-up".
 *
 * A step now carries an optional `branch_condition`. After a step runs, the
 * condition is evaluated against the prospect's live state; if it matches, the
 * sequence jumps to `goto_position` instead of advancing by one. A step marked
 * `is_terminal` ends the sequence.
 */
import { all, get, run, scalar, toJson } from '@/db';
import { nowIso } from '@/lib/id';
import { logActivity } from '@/lib/activity';
import { addDays } from '@/lib/time';
import { nextSendableTime } from './compliance';

export type BranchCondition =
  | 'always'
  | 'replied'
  | 'not_replied'
  | 'mockup_viewed'
  | 'mockup_not_viewed'
  | 'opened'
  | 'not_opened'
  | 'clicked'
  | 'has_call'
  | 'high_intent'
  | 'low_intent';

export const BRANCH_CONDITIONS: { value: BranchCondition; label: string; description: string }[] = [
  { value: 'always', label: 'Always', description: 'Continue to the next step unconditionally.' },
  { value: 'replied', label: 'Replied', description: 'The prospect has sent any inbound message.' },
  { value: 'not_replied', label: 'Has not replied', description: 'No inbound message yet.' },
  { value: 'mockup_viewed', label: 'Concept viewed', description: 'The prospect opened their website concept.' },
  { value: 'mockup_not_viewed', label: 'Concept not viewed', description: 'A concept was shared but never opened.' },
  { value: 'opened', label: 'Opened an email', description: 'At least one message was opened.' },
  { value: 'not_opened', label: 'Never opened', description: 'No message has been opened.' },
  { value: 'clicked', label: 'Clicked a link', description: 'At least one link was clicked.' },
  { value: 'has_call', label: 'Call scheduled', description: 'A call exists on the record.' },
  { value: 'high_intent', label: 'High intent', description: 'Intent score is 60 or above.' },
  { value: 'low_intent', label: 'Low intent', description: 'Intent score is below 30.' },
];

/** Evaluates a branch condition against the prospect's current state. */
export function evaluateBranch(orgId: string, businessId: string, condition: BranchCondition): boolean {
  switch (condition) {
    case 'always':
      return true;

    case 'replied':
      return (scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE business_id = ? AND direction = 'inbound'", [businessId]) ?? 0) > 0;

    case 'not_replied':
      return (scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE business_id = ? AND direction = 'inbound'", [businessId]) ?? 0) === 0;

    case 'mockup_viewed':
      return (scalar<number>('SELECT COUNT(*) FROM mockups WHERE business_id = ? AND view_count > 0', [businessId]) ?? 0) > 0;

    case 'mockup_not_viewed': {
      const shared = scalar<number>('SELECT COUNT(*) FROM mockups WHERE business_id = ? AND share_enabled = 1', [businessId]) ?? 0;
      const viewed = scalar<number>('SELECT COUNT(*) FROM mockups WHERE business_id = ? AND view_count > 0', [businessId]) ?? 0;
      return shared > 0 && viewed === 0;
    }

    case 'opened':
      return (scalar<number>('SELECT COALESCE(SUM(open_count),0) FROM outreach_messages WHERE business_id = ?', [businessId]) ?? 0) > 0;

    case 'not_opened':
      return (scalar<number>('SELECT COALESCE(SUM(open_count),0) FROM outreach_messages WHERE business_id = ?', [businessId]) ?? 0) === 0;

    case 'clicked':
      return (scalar<number>('SELECT COALESCE(SUM(click_count),0) FROM outreach_messages WHERE business_id = ?', [businessId]) ?? 0) > 0;

    case 'has_call':
      return (scalar<number>("SELECT COUNT(*) FROM calls WHERE business_id = ? AND status IN ('scheduled','proposed','completed')", [businessId]) ?? 0) > 0;

    case 'high_intent':
      return (scalar<number>('SELECT intent_score FROM businesses WHERE id = ?', [businessId]) ?? 0) >= 60;

    case 'low_intent':
      return (scalar<number>('SELECT intent_score FROM businesses WHERE id = ?', [businessId]) ?? 0) < 30;

    default:
      return false;
  }
}

export interface SequenceStepRow {
  id: string;
  sequence_id: string;
  position: number;
  day_offset: number;
  channel: string;
  purpose: string;
  tone: string;
  subject: string | null;
  body: string | null;
  include_mockup: number;
  include_value: string | null;
  enabled: number;
  branch_condition: string | null;
  goto_position: number | null;
  is_terminal: number;
}

export function listSteps(sequenceId: string): SequenceStepRow[] {
  return all<SequenceStepRow>('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position', [sequenceId]);
}

export interface AddStepInput {
  position?: number;
  dayOffset: number;
  channel: string;
  purpose: string;
  tone?: string;
  subject?: string | null;
  body?: string | null;
  includeMockup?: boolean;
  includeValue?: string | null;
  branchCondition?: BranchCondition | null;
  gotoPosition?: number | null;
  isTerminal?: boolean;
}

export function addStep(orgId: string, sequenceId: string, input: AddStepInput): { ok: boolean; stepId?: string; message: string } {
  const seq = get<{ id: string }>('SELECT id FROM sequences WHERE id = ? AND org_id = ?', [sequenceId, orgId]);
  if (!seq) return { ok: false, message: 'Sequence not found' };

  const position =
    input.position ??
    ((scalar<number>('SELECT COALESCE(MAX(position), -1) + 1 FROM sequence_steps WHERE sequence_id = ?', [sequenceId]) as number) ?? 0);

  const stepId = `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  run(
    `INSERT INTO sequence_steps (id, sequence_id, position, day_offset, channel, purpose, tone, subject, body,
        template_id, include_mockup, include_value, enabled, branch_condition, goto_position, is_terminal, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,1,?,?,?,?)`,
    [
      stepId, sequenceId, position, input.dayOffset, input.channel, input.purpose, input.tone ?? 'professional',
      input.subject ?? null, input.body ?? null, input.includeMockup ? 1 : 0, input.includeValue ?? null,
      input.branchCondition ?? null, input.gotoPosition ?? null, input.isTerminal ? 1 : 0, nowIso(),
    ]
  );
  return { ok: true, stepId, message: 'Step added.' };
}

export function updateStep(
  orgId: string,
  stepId: string,
  patch: Partial<Omit<AddStepInput, 'position'>> & { enabled?: boolean; position?: number }
): { ok: boolean; message: string } {
  const step = get<{ id: string; sequence_id: string }>(
    `SELECT s.id, s.sequence_id FROM sequence_steps s JOIN sequences q ON q.id = s.sequence_id
      WHERE s.id = ? AND q.org_id = ?`,
    [stepId, orgId]
  );
  if (!step) return { ok: false, message: 'Step not found' };

  const map: Record<string, string> = {
    dayOffset: 'day_offset',
    channel: 'channel',
    purpose: 'purpose',
    tone: 'tone',
    subject: 'subject',
    body: 'body',
    includeMockup: 'include_mockup',
    includeValue: 'include_value',
    branchCondition: 'branch_condition',
    gotoPosition: 'goto_position',
    isTerminal: 'is_terminal',
    enabled: 'enabled',
    position: 'position',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return { ok: false, message: 'Nothing to update' };
  params.push(stepId);
  run(`UPDATE sequence_steps SET ${sets.join(', ')} WHERE id = ?`, params);
  return { ok: true, message: 'Step updated.' };
}

export function deleteStep(orgId: string, stepId: string): { ok: boolean; message: string } {
  const { changes } = run(
    `DELETE FROM sequence_steps WHERE id = ? AND sequence_id IN (SELECT id FROM sequences WHERE org_id = ?)`,
    [stepId, orgId]
  );
  return changes ? { ok: true, message: 'Step removed.' } : { ok: false, message: 'Step not found' };
}

/**
 * Resolves the next step for an enrolment, honouring branch conditions.
 * Returns null when the sequence should stop.
 */
export function resolveNextStep(
  orgId: string,
  enrolment: { id: string; sequence_id: string; business_id: string; current_step: number },
  steps: SequenceStepRow[]
): { step: SequenceStepRow; reason: string } | null {
  const current = steps.find((s) => s.position === enrolment.current_step);

  // A terminal step ends the sequence.
  if (current?.is_terminal === 1) return null;

  // Evaluate the current step's branch, if it has one.
  if (current?.branch_condition && current.branch_condition !== 'always') {
    const matched = evaluateBranch(orgId, enrolment.business_id, current.branch_condition as BranchCondition);
    if (matched && current.goto_position !== null && current.goto_position !== undefined) {
      const target = steps.find((s) => s.position === current.goto_position && s.enabled === 1);
      if (target) {
        return { step: target, reason: `branch "${current.branch_condition}" matched → step ${target.position}` };
      }
    }
  }

  // Otherwise advance to the next enabled step.
  const next = steps
    .filter((s) => s.enabled === 1 && s.position > enrolment.current_step)
    .sort((a, b) => a.position - b.position)[0];

  return next ? { step: next, reason: 'linear advance' } : null;
}

/**
 * Dispatches due enrolments with branching. Mirrors the linear dispatcher's
 * safety guarantees: stop conditions are re-checked immediately before each
 * touch, and sends still pass through the compliance gate.
 */
export async function dispatchWithBranching(
  orgId: string,
  opts: { actor?: string; limit?: number } = {}
): Promise<{ dispatched: number; stopped: number; blocked: number; branched: number; completed: number; errors: number }> {
  const result = { dispatched: 0, stopped: 0, blocked: 0, branched: 0, completed: 0, errors: 0 };

  const due = all<{
    id: string; sequence_id: string; business_id: string; contact_id: string | null;
    current_step: number; touches_sent: number; max_touches: number; approval_mode: string;
    stop_on_response: number; stop_on_optout: number; stop_on_client: number; stop_on_not_interested: number;
  }>(
    `SELECT e.id, e.sequence_id, e.business_id, e.contact_id, e.current_step, e.touches_sent,
            s.max_touches, s.approval_mode, s.stop_on_response, s.stop_on_optout, s.stop_on_client, s.stop_on_not_interested
       FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
      WHERE e.org_id = ? AND e.status = 'active' AND e.next_step_at <= ? AND s.is_active = 1
      ORDER BY e.next_step_at ASC LIMIT ?`,
    [orgId, nowIso(), opts.limit ?? 200]
  );

  for (const e of due) {
    const business = get<{ id: string; name: string; stage: string; consent_state: string }>(
      'SELECT id, name, stage, consent_state FROM businesses WHERE id = ?',
      [e.business_id]
    );
    if (!business) continue;

    // Stop conditions, re-checked at dispatch time.
    if (e.stop_on_client === 1 && ['won', 'onboarding', 'delivery', 'active_client', 'expansion'].includes(business.stage)) {
      stop(orgId, e.id, 'stopped_client', 'Prospect became a client');
      result.stopped++;
      continue;
    }
    if (e.stop_on_optout === 1 && ['opted_out', 'do_not_contact'].includes(business.consent_state)) {
      stop(orgId, e.id, 'stopped_optout', 'Prospect opted out');
      result.stopped++;
      continue;
    }
    if (e.stop_on_response === 1) {
      const replied = (scalar<number>("SELECT COUNT(*) FROM outreach_messages WHERE business_id = ? AND direction = 'inbound'", [e.business_id]) ?? 0) > 0;
      if (replied) {
        stop(orgId, e.id, 'stopped_response', 'Prospect responded');
        result.stopped++;
        continue;
      }
    }
    if (e.stop_on_not_interested === 1) {
      const ni = (scalar<number>("SELECT COUNT(*) FROM ai_memory WHERE business_id = ? AND kind = 'objection' AND key LIKE 'not_interested%'", [e.business_id]) ?? 0) > 0;
      if (ni) {
        stop(orgId, e.id, 'stopped_not_interested', 'Marked not interested');
        result.stopped++;
        continue;
      }
    }

    if (e.touches_sent >= e.max_touches) {
      stop(orgId, e.id, 'completed', 'Reached maximum touches');
      result.completed++;
      continue;
    }

    const steps = listSteps(e.sequence_id);
    const next = resolveNextStep(orgId, e, steps);
    if (!next) {
      stop(orgId, e.id, 'completed', 'Sequence finished');
      result.completed++;
      continue;
    }
    if (next.reason.startsWith('branch')) result.branched++;

    try {
      const { generateOutreach } = await import('./outreach');
      const mockup = next.step.include_mockup === 1
        ? get<{ share_token: string; status: string }>('SELECT share_token, status FROM mockups WHERE business_id = ? ORDER BY created_at DESC LIMIT 1', [e.business_id])
        : null;

      const drafted = await generateOutreach(orgId, e.business_id, {
        channel: next.step.channel as never,
        tone: next.step.tone as never,
        purpose: next.step.purpose,
        contactId: e.contact_id ?? undefined,
        includeMockupUrl: mockup ? `/mockup/${mockup.share_token}` : undefined,
        actor: opts.actor ?? 'sequence',
      });

      if (!drafted || !drafted.compliance.allowed) {
        result.blocked++;
      } else if (e.approval_mode === 'autonomous' && drafted.messageId) {
        const { sendMessage } = await import('./outreach');
        await sendMessage(orgId, drafted.messageId, { actor: opts.actor ?? 'sequence' });
        result.dispatched++;
      } else {
        result.dispatched++; // queued for approval
      }

      if (mockup && mockup.status === 'draft') {
        run("UPDATE mockups SET status = 'shared', updated_at = ? WHERE business_id = ?", [nowIso(), e.business_id]);
      }

      // Advance to the resolved step and schedule the following one.
      const following = steps
        .filter((s) => s.enabled === 1 && s.position > next.step.position)
        .sort((a, b) => a.position - b.position)[0];

      const nextAt = following
        ? nextSendableTime(orgId, addDays(new Date(), following.day_offset - next.step.day_offset))
        : null;

      run(
        `UPDATE sequence_enrollments SET current_step = ?, touches_sent = touches_sent + 1,
                next_step_at = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END,
                ended_at = CASE WHEN ? IS NULL THEN ? ELSE ended_at END, updated_at = ?
          WHERE id = ?`,
        [next.step.position, nextAt?.toISOString() ?? null, nextAt?.toISOString() ?? null, nextAt?.toISOString() ?? null, nowIso(), nowIso(), e.id]
      );
      if (!nextAt) result.completed++;
    } catch (err) {
      result.errors++;
      const { toDeadLetter } = await import('./jobs');
      toDeadLetter(orgId, {
        jobKey: 'sequence_dispatch',
        step: 'dispatch',
        category: 'outreach',
        entityType: 'sequence_enrollment',
        entityId: e.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

function stop(orgId: string, enrolmentId: string, status: string, reason: string): void {
  run(`UPDATE sequence_enrollments SET status = ?, ended_at = ?, stop_reason = ?, updated_at = ? WHERE id = ?`, [
    status,
    nowIso(),
    reason,
    nowIso(),
    enrolmentId,
  ]);
}

/** A human-readable map of the sequence flow, for the UI. */
export function describeSequence(sequenceId: string): { position: number; label: string; branch?: string; terminal?: boolean }[] {
  const steps = listSteps(sequenceId);
  return steps.map((s) => ({
    position: s.position,
    label: `D${s.day_offset} · ${s.channel} · ${s.purpose}`,
    branch: s.branch_condition && s.branch_condition !== 'always'
      ? `if ${s.branch_condition.replace(/_/g, ' ')} → step ${s.goto_position ?? '?'}`
      : undefined,
    terminal: s.is_terminal === 1,
  }));
}

export { toJson };
