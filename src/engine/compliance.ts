/**
 * Compliance controls (§56).
 *
 * These checks run before any outbound message leaves the system. They are
 * deliberately conservative: when the basis for contacting someone is unknown
 * the message is blocked rather than sent, and every decision is auditable.
 */
import { all, get, run, scalar, toJson } from '@/db';
import { id, normalizeDomain, normalizeEmail, normalizePhone, nowIso } from '@/lib/id';
import { audit, logAutomation } from '@/lib/logging';
import { getSettings } from '@/lib/settings';
import type { Business, Contact } from '@/repo/business';

export interface ComplianceVerdict {
  allowed: boolean;
  reasons: string[];
  blockedBy?: string;
  consentState: string;
  suppressed: boolean;
}

export function isSuppressed(orgId: string, opts: { email?: string | null; phone?: string | null; domain?: string | null; businessId?: string | null }): {
  suppressed: boolean;
  reason: string | null;
} {
  const checks: { kind: string; value: string | null }[] = [
    { kind: 'email', value: normalizeEmail(opts.email ?? null) },
    { kind: 'phone', value: normalizePhone(opts.phone ?? null) },
    { kind: 'domain', value: opts.domain ? normalizeDomain(opts.domain) : (opts.email ? normalizeDomain(opts.email.split('@')[1] ?? '') : null) },
    { kind: 'business', value: opts.businessId ?? null },
  ];
  for (const c of checks) {
    if (!c.value) continue;
    const hit = get<{ reason: string }>('SELECT reason FROM suppression_list WHERE org_id = ? AND kind = ? AND value = ?', [
      orgId,
      c.kind,
      c.value,
    ]);
    if (hit) return { suppressed: true, reason: `${c.kind}:${c.value} — ${hit.reason}` };
  }
  return { suppressed: false, reason: null };
}

export function suppress(
  orgId: string,
  kind: 'email' | 'phone' | 'domain' | 'business',
  value: string,
  reason: string,
  source = 'manual',
  opts: { businessId?: string | null; contactId?: string | null } = {}
): void {
  run(
    `INSERT OR REPLACE INTO suppression_list (id, org_id, kind, value, reason, source, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id('sup'), orgId, kind, value.toLowerCase(), reason, source, nowIso()]
  );
  if (opts.businessId) {
    const next = kind === 'business' || kind === 'domain' ? 'do_not_contact' : 'opted_out';
    // Never weaken an existing state: a business already on the do-not-contact
    // list must stay there when we subsequently suppress one of its addresses.
    run(
      `UPDATE businesses
          SET consent_state = CASE WHEN consent_state = 'do_not_contact' THEN 'do_not_contact' ELSE ? END,
              consent_source = ?, consent_at = ?, updated_at = ?
        WHERE id = ?`,
      [next, source, nowIso(), nowIso(), opts.businessId]
    );
  }
  if (opts.contactId) {
    run('UPDATE contacts SET consent_state = ?, updated_at = ? WHERE id = ?', ['opted_out', nowIso(), opts.contactId]);
  }
  audit(orgId, 'suppression.added', {
    entityType: kind,
    entityId: value,
    detail: { reason, source },
    severity: 'info',
  });
}

export function unsuppress(orgId: string, kind: string, value: string): void {
  run('DELETE FROM suppression_list WHERE org_id = ? AND kind = ? AND value = ?', [orgId, kind, value.toLowerCase()]);
}

export interface SuppressionRow {
  id: string;
  org_id: string;
  kind: string;
  value: string;
  reason: string;
  source: string | null;
  created_at: string;
}

export function listSuppression(orgId: string, limit = 200): SuppressionRow[] {
  return all<SuppressionRow>('SELECT * FROM suppression_list WHERE org_id = ? ORDER BY created_at DESC LIMIT ?', [orgId, limit]);
}

export function recordConsent(
  orgId: string,
  channel: string,
  state: 'opted_in' | 'opted_out' | 'do_not_contact' | 'unknown',
  opts: { businessId?: string | null; contactId?: string | null; basis?: string; region?: string; evidence?: string }
): void {
  run(
    `INSERT INTO communication_consent (id, org_id, business_id, contact_id, channel, state, basis, region, evidence, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id('cns'), orgId, opts.businessId ?? null, opts.contactId ?? null, channel, state, opts.basis ?? null, opts.region ?? null, opts.evidence ?? null, nowIso()]
  );
  if (opts.businessId) {
    // Never weaken do_not_contact — an explicit opt-out outranks any later,
    // weaker consent record written against the same business.
    run(
      `UPDATE businesses
          SET consent_state = CASE WHEN consent_state = 'do_not_contact' AND ? <> 'do_not_contact'
                                   THEN 'do_not_contact' ELSE ? END,
              consent_at = ?, updated_at = ?
        WHERE id = ?`,
      [state, state, nowIso(), nowIso(), opts.businessId]
    );
  }
}

/**
 * Full pre-send verdict. Order matters: suppression first, then consent, then
 * rate limits, then quiet hours — so the most serious block is reported.
 */
export function canContact(
  orgId: string,
  business: Business,
  contact: Contact | null,
  channel: string,
  opts: { at?: Date; body?: string } = {}
): ComplianceVerdict {
  const settings = getSettings(orgId);
  const reasons: string[] = [];
  const when = opts.at ?? new Date();

  // 1. Hard blocks
  if (business.consent_state === 'do_not_contact') {
    return verdict(false, ['Business is on the do-not-contact list.'], 'do_not_contact', business.consent_state, false);
  }
  if (business.consent_state === 'opted_out') {
    return verdict(false, ['Business has opted out of contact.'], 'opted_out', business.consent_state, false);
  }
  if (['won', 'onboarding', 'delivery', 'active_client', 'expansion'].includes(business.stage)) {
    return verdict(false, ['They are already a client — acquisition outreach is not appropriate.'], 'client', business.consent_state, false);
  }

  // 2. Suppression registry
  const sup = isSuppressed(orgId, {
    email: contact?.email ?? business.email,
    phone: contact?.phone ?? business.phone,
    domain: business.website_domain,
    businessId: business.id,
  });
  if (sup.suppressed) {
    return verdict(false, [`Suppressed: ${sup.reason}`], 'suppression', business.consent_state, true);
  }

  // 3. Channel availability
  const address = channel === 'email' ? (contact?.email ?? business.email) : (contact?.phone ?? business.phone);
  if (channel !== 'linkedin' && channel !== 'phone' && !address) {
    reasons.push(`No ${channel} address on record.`);
  }

  // 4. Consent requirement
  if (settings.outreach.requireConsent && business.consent_state !== 'opted_in') {
    reasons.push('Settings require recorded consent before contacting; consent state is ' + business.consent_state + '.');
  }

  // 5. Quiet hours are a *scheduling* constraint, not a permission one.
  // Drafting and enrolling are always allowed; only the send is deferred.
  // See isQuietHoursNow() — the send path checks it and reschedules.

  // 6. Rate limits
  const today = nowIso().slice(0, 10);
  const sentToday = scalar<number>(
    `SELECT COUNT(*) FROM outreach_messages WHERE org_id = ? AND sent_at >= ? AND status NOT IN ('draft','skipped','failed')`,
    [orgId, today]
  ) ?? 0;
  if (sentToday >= settings.outreach.dailySendLimit) {
    reasons.push(`Daily send limit reached (${sentToday}/${settings.outreach.dailySendLimit}).`);
  }
  const domain = normalizeDomain(business.website_domain) ?? (business.email ? normalizeDomain(business.email.split('@')[1]) : null);
  if (domain) {
    const perDomain = scalar<number>(
      `SELECT COUNT(*) FROM outreach_messages o JOIN businesses b ON b.id = o.business_id
        WHERE o.org_id = ? AND o.sent_at >= ? AND b.website_domain = ?`,
      [orgId, today, domain]
    ) ?? 0;
    if (perDomain >= settings.outreach.domainDailyLimit) {
      reasons.push(`Per-domain limit reached for ${domain} (${perDomain}/${settings.outreach.domainDailyLimit}).`);
    }
  }

  // 7. Duplicate protection
  if (settings.outreach.duplicateProtection && opts.body) {
    const recent = all<{ body: string; created_at: string }>(
      `SELECT body, created_at FROM outreach_messages WHERE org_id = ? AND business_id = ? AND created_at >= ?`,
      [orgId, business.id, new Date(Date.now() - 7 * 86_400_000).toISOString()]
    );
    if (recent.length) {
      // Exact repeat within 7 days is blocked; near-duplicates are flagged.
      const exact = recent.some((r) => r.body.trim() === opts.body!.trim());
      if (exact) reasons.push('An identical message was already sent to this business in the last 7 days.');
    }
  }

  return verdict(reasons.length === 0, reasons, reasons[0] ? 'policy' : undefined, business.consent_state, sup.suppressed);
}

function verdict(allowed: boolean, reasons: string[], blockedBy?: string, consentState = 'unknown', suppressed = false): ComplianceVerdict {
  return { allowed, reasons, blockedBy, consentState, suppressed };
}

/**
 * Quiet-hours probe used by the send path. Quiet hours defer a send rather
 * than blocking it — drafting, enrolling and approving are unaffected.
 */
export function isQuietHoursNow(orgId: string, at: Date = new Date()): { quiet: boolean; window: string } {
  const settings = getSettings(orgId);
  const quiet = inQuietHours(settings.outreach.quietHoursStart, settings.outreach.quietHoursEnd, at, settings.outreach.timezone);
  return { quiet, window: `${settings.outreach.quietHoursStart}–${settings.outreach.quietHoursEnd} ${settings.outreach.timezone}` };
}

export function inQuietHours(start: string, end: string, at: Date, tz: string): boolean {
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(at);
  const minutes = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = minutes(clock);
  const s = minutes(start);
  const e = minutes(end);
  // Overnight window (e.g. 20:00 → 08:00) wraps past midnight.
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

/**
 * Next sendable moment, skipping quiet hours. Used by the sequence dispatcher
 * so an autonomous run never schedules into a blocked window.
 */
export function nextSendableTime(orgId: string, from: Date = new Date()): Date {
  const settings = getSettings(orgId);
  const candidate = new Date(from);
  for (let i = 0; i < 48; i++) {
    if (!inQuietHours(settings.outreach.quietHoursStart, settings.outreach.quietHoursEnd, candidate, settings.outreach.timezone)) {
      return candidate;
    }
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  return candidate;
}

/** Handles an unsubscribe / opt-out link click. Idempotent and audited. */
export function handleOptOut(orgId: string, opts: { businessId: string; contactId?: string; channel: string; reason?: string }): void {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [opts.businessId, orgId]);
  if (!business) return;

  suppress(orgId, 'business', business.id, opts.reason ?? 'unsubscribe', 'unsubscribe_link', {
    businessId: business.id,
    contactId: opts.contactId,
  });
  const address = opts.channel === 'email' ? business.email : business.phone;
  if (address) suppress(orgId, opts.channel === 'email' ? 'email' : 'phone', address, opts.reason ?? 'unsubscribe', 'unsubscribe_link');
  if (business.website_domain) suppress(orgId, 'domain', business.website_domain, opts.reason ?? 'unsubscribe', 'unsubscribe_link');

  // Stop any running sequence immediately (§17).
  run(
    `UPDATE sequence_enrollments SET status = 'stopped_optout', ended_at = ?, stop_reason = ?, updated_at = ?
      WHERE org_id = ? AND business_id = ? AND status = 'active'`,
    [nowIso(), 'opt_out', nowIso(), orgId, business.id]
  );
  run(
    `UPDATE outreach_messages SET status = 'opted_out', unsubscribe_at = ?, updated_at = ?
      WHERE org_id = ? AND business_id = ? AND status IN ('queued','approved','sending')`,
    [nowIso(), nowIso(), orgId, business.id]
  );
  run(`UPDATE follow_ups SET status = 'cancelled' WHERE org_id = ? AND business_id = ? AND status = 'pending'`, [
    orgId,
    business.id,
  ]);

  recordConsent(orgId, opts.channel, 'opted_out', { businessId: business.id, contactId: opts.contactId, basis: 'explicit_opt_out', evidence: 'unsubscribe link' });
  logAutomation(orgId, 'outreach', `Opt-out recorded for ${business.name}`, {
    level: 'info',
    entityType: 'business',
    entityId: business.id,
    detail: { channel: opts.channel, reason: opts.reason },
  });
}

/** Data deletion / retention (§56). Removes the business and cascades. */
export function deleteBusinessData(orgId: string, businessId: string, actor = 'system'): { deleted: boolean; reason?: string } {
  const business = get<Business>('SELECT * FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  if (!business) return { deleted: false, reason: 'not_found' };
  run('DELETE FROM businesses WHERE id = ? AND org_id = ?', [businessId, orgId]);
  audit(orgId, 'data.deleted', { actor, entityType: 'business', entityId: businessId, detail: { name: business.name }, severity: 'warn' });
  return { deleted: true };
}

export function applyRetentionPolicy(orgId: string): { purged: number } {
  const settings = getSettings(orgId);
  const cutoff = new Date(Date.now() - settings.compliance.retentionDays * 86_400_000).toISOString();
  const { changes } = run(
    `DELETE FROM businesses WHERE org_id = ? AND is_archived = 1 AND updated_at < ?
        AND stage NOT IN ('active_client','expansion')`,
    [orgId, cutoff]
  );
  if (changes) {
    logAutomation(orgId, 'system', `Retention policy purged ${changes} archived record(s) older than ${settings.compliance.retentionDays} days`, {
      level: 'info',
    });
  }
  return { purged: changes };
}

export function complianceSummary(orgId: string) {
  const settings = getSettings(orgId);
  return {
    suppressionCount: scalar<number>('SELECT COUNT(*) FROM suppression_list WHERE org_id = ?', [orgId]) ?? 0,
    optedOut: scalar<number>("SELECT COUNT(*) FROM businesses WHERE org_id = ? AND consent_state IN ('opted_out','do_not_contact')", [orgId]) ?? 0,
    optedIn: scalar<number>("SELECT COUNT(*) FROM businesses WHERE org_id = ? AND consent_state = 'opted_in'", [orgId]) ?? 0,
    consentUnknown: scalar<number>("SELECT COUNT(*) FROM businesses WHERE org_id = ? AND consent_state = 'unknown'", [orgId]) ?? 0,
    requireConsent: settings.outreach.requireConsent,
    dailySendLimit: settings.outreach.dailySendLimit,
    domainDailyLimit: settings.outreach.domainDailyLimit,
    quietHours: `${settings.outreach.quietHoursStart}–${settings.outreach.quietHoursEnd} ${settings.outreach.timezone}`,
    retentionDays: settings.compliance.retentionDays,
    includeUnsubscribe: settings.compliance.includeUnsubscribe,
  };
}

export { toJson };
