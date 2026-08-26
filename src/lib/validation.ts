/**
 * Input validation (§47).
 *
 * Every value that crosses a trust boundary is parsed and bounded here. The
 * public endpoints (concept tracking, opt-out) accept anonymous input, so they
 * are the highest-risk surface: unbounded strings and numbers there are a
 * storage-exhaustion and log-injection vector.
 *
 * Everything is clamped rather than rejected where a sane default exists, so a
 * malformed beacon degrades instead of failing the prospect's page view.
 */
import { z } from 'zod';

const boundedString = (max: number) => z.string().trim().max(max);

/** GET/POST body for the concept view beacon (§23). */
export const viewBeaconSchema = z.object({
  token: boundedString(64),
  durationMs: z.coerce.number().int().min(0).max(3_600_000).catch(0),
  scrolledPct: z.coerce.number().min(0).max(100).catch(0),
  sectionsSeen: z
    .array(boundedString(40))
    .max(40)
    .catch([])
    .transform((v) => v.slice(0, 40)),
  ctaClicked: z.union([z.boolean(), z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')]).catch(false),
  device: boundedString(20).catch('unknown'),
  viewport: boundedString(20).optional().catch(undefined),
});

export type ViewBeacon = z.infer<typeof viewBeaconSchema>;

/** Query parameters for the opt-out endpoint (§56). */
export const optOutSchema = z.object({
  business: boundedString(64),
  channel: z.enum(['email', 'sms', 'whatsapp', 'linkedin', 'phone', 'custom']).catch('email'),
  token: boundedString(64),
  reason: boundedString(200).optional().catch(undefined),
});

export type OptOutInput = z.infer<typeof optOutSchema>;

/** CSV import row (§53). */
export const importRowSchema = z.object({
  name: boundedString(200),
  website: boundedString(300).optional(),
  phone: boundedString(40).optional(),
  email: z.string().trim().email().max(200).optional().catch(undefined),
  industry: boundedString(120).optional(),
  category: boundedString(120).optional(),
  description: boundedString(2000).optional(),
  addressLine: boundedString(300).optional(),
  locality: boundedString(120).optional(),
  region: boundedString(120).optional(),
  country: boundedString(120).optional(),
  rating: z.coerce.number().min(0).max(5).optional().catch(undefined),
  reviewCount: z.coerce.number().int().min(0).max(1_000_000).optional().catch(undefined),
});

export type ImportRowInput = z.infer<typeof importRowSchema>;

/** Login form (§35). */
export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

/** Password setup (§35). */
export const setupPasswordSchema = z
  .object({
    email: z.string().trim().email().max(200),
    password: z.string().min(10).max(200),
    confirm: z.string().min(1).max(200),
  })
  .refine((d) => d.password === d.confirm, { message: 'Passwords do not match', path: ['confirm'] });

/** Forge AI command (§27). */
export const commandSchema = z.object({
  input: boundedString(2000),
  businessId: boundedString(64).optional(),
});

/** Concept edit instruction (§16). */
export const conceptEditSchema = z.object({
  command: boundedString(500),
});

/** Outreach send (§13). */
export const outreachSchema = z.object({
  businessId: boundedString(64),
  channel: z.enum(['email', 'sms', 'whatsapp', 'linkedin', 'phone', 'custom']).catch('email'),
  tone: z.enum(['friendly', 'professional', 'direct', 'value_first', 'consultative']).catch('professional'),
  purpose: boundedString(40).catch('intro'),
});

/**
 * Parses unknown input, returning a discriminated result rather than throwing,
 * so route handlers can respond with a useful 400 instead of a 500.
 */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown
): { ok: true; data: z.infer<S> } | { ok: false; errors: string[] } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`),
  };
}

/** Strips control characters that could be used for log or header injection. */
export function sanitize(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 2000);
}
