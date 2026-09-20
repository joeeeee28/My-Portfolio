/**
 * Social workspace (§36) and client approval workflow (§37).
 *
 * Content is generated from the client's real business record — their services,
 * their reviews, their category. Publishing is provider-gated: without a
 * connected provider a post stays in the outbox and is marked simulated.
 */
import { all, get, json, run, scalar, toJson } from '@/db';
import { id, nowIso, truncate } from '@/lib/id';
import { addDays } from '@/lib/time';
import { logActivity } from '@/lib/activity';
import { logAutomation } from '@/lib/logging';
import { businessContext, contextPrompt } from '@/lib/ai/memory';
import { runAiTask } from '@/lib/ai/router';
import { getSocialProvider } from '@/lib/providers/registry';
import { getBusiness } from '@/repo/business';

export interface SocialPost {
  id: string;
  org_id: string;
  client_id: string;
  account_id: string | null;
  campaign_id: string | null;
  platform: string;
  format: string;
  caption: string;
  hashtags: string[];
  media: string[];
  creative_brief: string | null;
  scheduled_for: string | null;
  status: string;
  published_at: string | null;
  simulated: number;
  metrics: string;
  ai_generated: number;
  grounded_in: string[];
  cost: number;
  created_at: string;
  updated_at: string;
  business_name?: string;
}

const PLATFORM_TAGS: Record<string, string[]> = {
  instagram: ['behindthescenes', 'smallbusiness', 'supportlocal'],
  facebook: ['community', 'localbusiness'],
  linkedin: ['business', 'growth', 'entrepreneurship'],
  tiktok: ['fyp', 'smallbusiness', 'dayinthelife'],
  twitter: ['smallbusiness'],
  pinterest: ['ideas', 'inspiration'],
};

const CONTENT_PILLARS = [
  { key: 'service', label: 'Service spotlight', prompt: 'Explain one specific service and who it is for.' },
  { key: 'proof', label: 'Social proof', prompt: 'Highlight customer satisfaction without inventing quotes.' },
  { key: 'process', label: 'Behind the scenes', prompt: 'Show how the work actually gets done.' },
  { key: 'education', label: 'Useful tip', prompt: 'Give one genuinely useful tip related to the service.' },
  { key: 'offer', label: 'Offer / call to action', prompt: 'Invite people to enquire, with a clear next step.' },
  { key: 'story', label: 'Business story', prompt: 'Share something true about the business from the record.' },
];

export interface GeneratedPost {
  platform: string;
  format: string;
  caption: string;
  hashtags: string[];
  pillar: string;
  creativeBrief: string;
  groundedIn: string[];
}

/**
 * Generates a content calendar grounded in the client's real record.
 * Anything the record cannot support is flagged rather than fabricated.
 */
export async function generateContentPlan(
  orgId: string,
  clientId: string,
  opts: { posts?: number; platforms?: string[]; startAt?: Date; actor?: string } = {}
): Promise<{ created: number; posts: GeneratedPost[] }> {
  const client = get<{ id: string; business_id: string; status: string }>('SELECT * FROM clients WHERE id = ? AND org_id = ?', [clientId, orgId]);
  if (!client) throw new Error('client_not_found');
  const business = getBusiness(orgId, client.business_id);
  if (!business) throw new Error('business_not_found');
  const ctx = businessContext(orgId, client.business_id);
  if (!ctx) throw new Error('context_unavailable');

  const count = opts.posts ?? 8;
  const platforms = opts.platforms?.length
    ? opts.platforms
    : (all<{ platform: string }>('SELECT platform FROM social_accounts WHERE client_id = ? ORDER BY created_at', [clientId]).map((a) => a.platform));
  const activePlatforms = platforms.length ? platforms : ['instagram'];

  const services = ctx.memories.filter((m) => m.key.startsWith('service:')).map((m) => m.value);
  const research = ctx.research;
  const reviewCount = business.review_count;
  const rating = business.rating;

  const groundedIn: string[] = [];
  if (business.category) groundedIn.push(`Category: ${business.category}`);
  if (services.length) groundedIn.push(`Services on record: ${services.slice(0, 4).join(', ')}`);
  if (rating && reviewCount) groundedIn.push(`${rating.toFixed(1)}★ from ${reviewCount} reviews`);
  if (business.description) groundedIn.push('Business description');

  const promptLines = [
    `Business: ${business.name}`,
    business.category ? `Category: ${business.category}` : '',
    business.description ? `Description: ${business.description}` : '',
    services.length ? `Services: ${services.join(', ')}` : '',
    rating && reviewCount ? `Reputation: ${rating.toFixed(1)}★ from ${reviewCount} reviews` : '',
    business.locality ? `Location: ${business.locality}` : '',
    '',
    `Write ${count} social posts. Rotate through these pillars: ${CONTENT_PILLARS.map((p) => p.label).join(', ')}.`,
    'Hard rules:',
    '- Use ONLY the facts above. Do not invent offers, prices, discounts, events, staff names or customer quotes.',
    '- If you want to reference a customer review, refer to the rating generally, never quote a specific person.',
    '- Each post: 40-90 words, one clear idea, one call to action.',
    'Return JSON: {"posts":[{"pillar":string,"platform":string,"format":"post|reel|carousel","caption":string,"hashtags":string[],"creativeBrief":string}]}',
  ].filter(Boolean);

  const res = await runAiTask(
    orgId,
    'social_content',
    {
      task: 'social_content',
      system: 'You write social media content for a specific business using only supplied facts. Output strict JSON.',
      prompt: `${ctx ? contextPrompt(ctx) : ''}\n\n${promptLines.join('\n')}`,
      json: true,
      maxTokens: 1800,
    },
    { entityType: 'client', entityId: clientId }
  );

  const parsed = (res.json ?? {}) as { posts?: GeneratedPost[] };
  const generated = parsed.posts?.length ? parsed.posts.slice(0, count) : localContentPlan(business, services, activePlatforms, count, groundedIn);

  const now = nowIso();
  const start = opts.startAt ?? addDays(new Date(), 1);
  let created = 0;

  for (let i = 0; i < generated.length; i++) {
    const post = generated[i];
    const platform = activePlatforms.includes(post.platform) ? post.platform : activePlatforms[i % activePlatforms.length];
    const account = get<{ id: string }>('SELECT id FROM social_accounts WHERE client_id = ? AND platform = ? LIMIT 1', [clientId, platform]);
    const scheduledFor = addDays(start, Math.floor(i / Math.max(1, activePlatforms.length)) * 3 + (i % activePlatforms.length));

    run(
      `INSERT INTO social_posts (id, org_id, client_id, account_id, campaign_id, platform, format, caption, hashtags,
          media, creative_brief, scheduled_for, status, approval_id, published_at, provider_key, simulated, metrics,
          ai_generated, grounded_in, cost, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'client_review',NULL,NULL,NULL,1,'{}',1,?,?,?,?)`,
      [
        id('sp'), orgId, clientId, account?.id ?? null, null, platform, post.format ?? 'post', post.caption,
        toJson(post.hashtags ?? []), toJson([]), post.creativeBrief ?? null, scheduledFor.toISOString(),
        toJson(groundedIn), res.cost / Math.max(1, generated.length), now, now,
      ]
    );
    created++;
  }

  logActivity(orgId, 'social', `${created} social post${created === 1 ? '' : 's'} drafted for ${business.name}`, {
    clientId,
    businessId: client.business_id,
    actor: opts.actor ?? 'ai',
    detail: `${activePlatforms.join(', ')} · grounded in ${groundedIn.length} verified fact(s)`,
  });

  return { created, posts: generated };
}

/** Deterministic fallback — still grounded, never invents offers or quotes. */
function localContentPlan(
  business: { name: string; category: string | null; description: string | null; locality: string | null; rating: number | null; review_count: number | null },
  services: string[],
  platforms: string[],
  count: number,
  groundedIn: string[]
): GeneratedPost[] {
  const what = business.category ? business.category.toLowerCase() : 'what we do';
  const where = business.locality ? ` in ${business.locality}` : '';
  const posts: GeneratedPost[] = [];

  for (let i = 0; i < count; i++) {
    const pillar = CONTENT_PILLARS[i % CONTENT_PILLARS.length];
    const platform = platforms[i % platforms.length];
    const service = services[i % Math.max(1, services.length)] ?? null;
    let caption: string;

    switch (pillar.key) {
      case 'service':
        caption = service
          ? `One of the things we are asked for most: ${service}. If that is what you need${where}, send us a message and we will talk it through.`
          : `[Add a post about a specific service — no services are on record yet, so nothing has been invented here.]`;
        break;
      case 'proof':
        caption = business.rating && business.review_count
          ? `${business.rating.toFixed(1)}★ from ${business.review_count} reviews. That number is the reason we keep showing up the way we do. Thank you to everyone who took the time to leave one.`
          : `[Add a social-proof post once you have reviews to reference — none are on record.]`;
        break;
      case 'process':
        caption = `People rarely see the part before the result. Here is how a job with ${business.name} actually starts: you tell us what you need, we ask the questions that matter, then we get to work.`;
        break;
      case 'education':
        caption = `A quick one worth knowing about ${what}: the biggest mistake is usually not the work itself, it is waiting until something breaks. A short conversation early saves a lot later.`;
        break;
      case 'offer':
        caption = `If you have been putting this off, this is the sign. Tell us what you need${where} and we will come back to you with a clear answer — no obligation.`;
        break;
      default:
        caption = business.description
          ? truncate(business.description, 220)
          : `[Add a story post about ${business.name} — the record does not have one yet.]`;
    }

    const tags = [...(PLATFORM_TAGS[platform] ?? []), ...(business.category ? [business.category.toLowerCase().replace(/[^a-z0-9]/g, '')] : [])].filter(Boolean);
    posts.push({
      platform,
      format: pillar.key === 'process' ? 'reel' : pillar.key === 'service' ? 'carousel' : 'post',
      caption,
      hashtags: Array.from(new Set(tags)).slice(0, 5),
      pillar: pillar.label,
      creativeBrief: pillar.prompt,
      groundedIn,
    });
  }
  return posts;
}

export function listPosts(orgId: string, opts: { clientId?: string; status?: string; from?: string; to?: string; limit?: number } = {}) {
  const where = ['p.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.clientId) {
    where.push('p.client_id = ?');
    params.push(opts.clientId);
  }
  if (opts.status) {
    where.push('p.status = ?');
    params.push(opts.status);
  }
  if (opts.from) {
    where.push('p.scheduled_for >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    where.push('p.scheduled_for <= ?');
    params.push(opts.to);
  }
  params.push(opts.limit ?? 200);
  return all<Omit<SocialPost, 'hashtags' | 'media' | 'grounded_in'> & { hashtags: string; media: string; grounded_in: string }>(
    `SELECT p.*, b.name business_name FROM social_posts p
       JOIN clients c ON c.id = p.client_id JOIN businesses b ON b.id = c.business_id
      WHERE ${where.join(' AND ')} ORDER BY p.scheduled_for ASC LIMIT ?`,
    params
  ).map((p) => ({
    ...p,
    hashtags: json<string[]>(p.hashtags, []),
    media: json<string[]>(p.media, []),
    grounded_in: json<string[]>(p.grounded_in, []),
  }));
}

/** Content calendar grouped by day (§36). */
export function contentCalendar(orgId: string, clientId: string, days = 30) {
  const from = nowIso();
  const to = addDays(new Date(), days).toISOString();
  const posts = listPosts(orgId, { clientId, from, to, limit: 300 });
  const byDay: Record<string, typeof posts> = {};
  for (const p of posts) {
    const day = (p.scheduled_for ?? p.created_at).slice(0, 10);
    (byDay[day] ||= []).push(p);
  }
  return { from, to, byDay, total: posts.length };
}

// ── Approval workflow (§37) ──────────────────────────────────
export function requestClientApproval(
  orgId: string,
  clientId: string,
  opts: { kind: string; title: string; refType?: string; refId?: string; projectId?: string; previewUrl?: string }
): string {
  const approvalId = id('apr');
  run(
    `INSERT INTO approval_requests (id, org_id, client_id, project_id, kind, ref_type, ref_id, title, status, preview_url, requested_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
    [approvalId, orgId, clientId, opts.projectId ?? null, opts.kind, opts.refType ?? null, opts.refId ?? null, opts.title, opts.previewUrl ?? null, nowIso()]
  );
  if (opts.refType === 'social_post' && opts.refId) {
    run("UPDATE social_posts SET status = 'client_review', approval_id = ?, updated_at = ? WHERE id = ?", [approvalId, nowIso(), opts.refId]);
  }
  logActivity(orgId, 'social', `Approval requested — ${opts.title}`, { clientId, projectId: opts.projectId ?? null, entityType: 'approval_request', entityId: approvalId });
  return approvalId;
}

export function resolveApproval(
  orgId: string,
  approvalId: string,
  decision: 'approved' | 'revision' | 'rejected',
  opts: { note?: string; by?: string } = {}
): void {
  const approval = get<{ client_id: string; kind: string; ref_type: string | null; ref_id: string | null; title: string }>(
    'SELECT * FROM approval_requests WHERE id = ? AND org_id = ?',
    [approvalId, orgId]
  );
  if (!approval) throw new Error('approval_not_found');
  const now = nowIso();

  run('UPDATE approval_requests SET status = ?, responded_at = ?, responded_by = ?, note = ? WHERE id = ?', [
    decision,
    now,
    opts.by ?? 'client',
    opts.note ?? null,
    approvalId,
  ]);

  if (opts.note) {
    run(
      `INSERT INTO feedback_items (id, org_id, client_id, approval_id, project_id, author, body, severity, resolved, created_at)
       VALUES (?,?,?,?,?,?,?, 'normal', ?, ?)`,
      [id('fb'), orgId, approval.client_id, approvalId, null, opts.by ?? 'client', opts.note, decision === 'approved' ? 1 : 0, now]
    );
  }

  if (approval.ref_type === 'social_post' && approval.ref_id) {
    const next = decision === 'approved' ? 'approved' : decision === 'revision' ? 'draft' : 'rejected';
    run('UPDATE social_posts SET status = ?, updated_at = ? WHERE id = ?', [next, now, approval.ref_id]);
  }

  logActivity(orgId, 'social', `${approval.title} — ${decision}`, {
    clientId: approval.client_id,
    actor: opts.by ?? 'client',
    detail: opts.note,
    entityType: 'approval_request',
    entityId: approvalId,
    importance: decision === 'rejected' ? 'high' : 'normal',
  });
}

export interface ApprovalRow {
  id: string;
  org_id: string;
  client_id: string;
  project_id: string | null;
  kind: string;
  ref_type: string | null;
  ref_id: string | null;
  title: string;
  status: string;
  preview_url: string | null;
  requested_at: string;
  responded_at: string | null;
  responded_by: string | null;
  note: string | null;
  business_name: string;
}

export function listApprovals(orgId: string, opts: { clientId?: string; status?: string } = {}): ApprovalRow[] {
  const where = ['a.org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.clientId) {
    where.push('a.client_id = ?');
    params.push(opts.clientId);
  }
  if (opts.status) {
    where.push('a.status = ?');
    params.push(opts.status);
  }
  return all<ApprovalRow>(
    `SELECT a.*, b.name business_name FROM approval_requests a
       JOIN clients c ON c.id = a.client_id JOIN businesses b ON b.id = c.business_id
      WHERE ${where.join(' AND ')} ORDER BY a.status = 'pending' DESC, a.requested_at DESC`,
    params
  );
}

export function listFeedback(orgId: string, clientId?: string) {
  return clientId
    ? all('SELECT * FROM feedback_items WHERE org_id = ? AND client_id = ? ORDER BY created_at DESC', [orgId, clientId])
    : all('SELECT * FROM feedback_items WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', [orgId]);
}

// ── Publishing (§36) ─────────────────────────────────────────
export async function publishPost(orgId: string, postId: string, opts: { actor?: string } = {}): Promise<{ ok: boolean; status: string; simulated: boolean; message: string }> {
  const post = get<SocialPost>('SELECT * FROM social_posts WHERE id = ? AND org_id = ?', [postId, orgId]);
  if (!post) throw new Error('post_not_found');
  if (post.status !== 'approved' && post.status !== 'scheduled') {
    return { ok: false, status: post.status, simulated: false, message: `Post is "${post.status}" — it must be approved before publishing.` };
  }

  const provider = getSocialProvider(orgId);
  if (!provider) return { ok: false, status: 'not_configured', simulated: false, message: 'No social provider registered.' };

  const result = await provider.publish(orgId, {
    platform: post.platform,
    accountId: post.account_id ?? post.platform,
    caption: post.caption,
    media: post.media,
    scheduledFor: post.scheduled_for ?? undefined,
  });

  const now = nowIso();
  if (result.ok) {
    run(
      `UPDATE social_posts SET status = ?, published_at = ?, provider_key = ?, simulated = ?, updated_at = ? WHERE id = ?`,
      [result.status, result.status === 'published' ? now : null, provider.key, result.live ? 0 : 1, now, postId]
    );
    logActivity(orgId, 'social', `Post ${result.live ? 'published' : 'queued (simulated)'} on ${post.platform}`, {
      clientId: post.client_id,
      actor: opts.actor ?? 'system',
      detail: result.live ? `Via ${provider.label}` : `${provider.label} — no external publish occurred`,
      entityType: 'social_post',
      entityId: postId,
    });
    return {
      ok: true,
      status: result.status,
      simulated: !result.live,
      message: result.live ? 'Published.' : `Held in the ${provider.label} outbox. Connect a publishing provider in Settings → Integrations to publish for real.`,
    };
  }

  run("UPDATE social_posts SET status = 'rejected', updated_at = ? WHERE id = ?", [now, postId]);
  logAutomation(orgId, 'api_error', `Social publish failed: ${result.error}`, { level: 'error', entityType: 'social_post', entityId: postId, retryable: true });
  return { ok: false, status: 'failed', simulated: false, message: result.error ?? 'Publish failed' };
}

// ── Accounts & campaigns ─────────────────────────────────────
export function connectAccount(orgId: string, clientId: string, data: { platform: string; handle: string; profileUrl?: string; followers?: number }): string {
  const accountId = id('sac');
  run(
    `INSERT INTO social_accounts (id, org_id, client_id, platform, handle, profile_url, connected, provider_key, followers, created_at)
     VALUES (?,?,?,?,?,?,0,NULL,?,?)`,
    [accountId, orgId, clientId, data.platform, data.handle, data.profileUrl ?? null, data.followers ?? null, nowIso()]
  );
  return accountId;
}

export interface SocialAccountRow {
  id: string; platform: string; handle: string; profile_url: string | null;
  connected: number; followers: number | null; created_at: string;
}

export function listAccounts(orgId: string, clientId?: string): SocialAccountRow[] {
  return clientId
    ? all<SocialAccountRow>('SELECT * FROM social_accounts WHERE org_id = ? AND client_id = ? ORDER BY platform', [orgId, clientId])
    : all<SocialAccountRow>('SELECT * FROM social_accounts WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
}

export function createCampaign(orgId: string, clientId: string, data: { name: string; objective?: string; startDate?: string; endDate?: string; budget?: number }): string {
  const campaignId = id('cmp');
  const now = nowIso();
  run(
    `INSERT INTO campaigns (id, org_id, client_id, name, objective, start_date, end_date, status, budget, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'planning',?,?,?)`,
    [campaignId, orgId, clientId, data.name, data.objective ?? null, data.startDate ?? null, data.endDate ?? null, data.budget ?? null, now, now]
  );
  return campaignId;
}

export interface CampaignRow { id: string; name: string; objective: string | null; status: string; budget: number | null; created_at: string; }

export function listCampaigns(orgId: string, clientId?: string): CampaignRow[] {
  return clientId
    ? all<CampaignRow>('SELECT * FROM campaigns WHERE org_id = ? AND client_id = ? ORDER BY created_at DESC', [orgId, clientId])
    : all<CampaignRow>('SELECT * FROM campaigns WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', [orgId]);
}

export function socialAnalytics(orgId: string, clientId: string) {
  const posts = all<{ status: string; platform: string; metrics: string }>('SELECT status, platform, metrics FROM social_posts WHERE org_id = ? AND client_id = ?', [orgId, clientId]);
  const byStatus: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  let totalImpressions = 0;
  let totalEngagement = 0;
  for (const p of posts) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    byPlatform[p.platform] = (byPlatform[p.platform] ?? 0) + 1;
    const m = json<{ impressions?: number; engagement?: number }>(p.metrics, {});
    totalImpressions += m.impressions ?? 0;
    totalEngagement += m.engagement ?? 0;
  }
  return {
    total: posts.length,
    byStatus,
    byPlatform,
    totalImpressions,
    totalEngagement,
    engagementRate: totalImpressions ? Number(((totalEngagement / totalImpressions) * 100).toFixed(2)) : 0,
    accounts: scalar<number>('SELECT COUNT(*) FROM social_accounts WHERE org_id = ? AND client_id = ?', [orgId, clientId]) ?? 0,
  };
}
