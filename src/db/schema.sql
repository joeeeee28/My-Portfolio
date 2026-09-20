-- Acquisition OS — relational schema
-- SQLite (node:sqlite). Executed idempotently by src/db/migrate.ts
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
-- TENANCY, IDENTITY, SECURITY  (§55, §68, §69)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  agency_mode       INTEGER NOT NULL DEFAULT 0,      -- white-label enabled
  brand_name        TEXT,
  brand_logo_url    TEXT,
  brand_primary     TEXT,
  brand_accent      TEXT,
  custom_domain     TEXT,
  portal_domain     TEXT,
  email_from_name   TEXT,
  email_from_addr   TEXT,
  email_footer      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  password_hash     TEXT,
  role              TEXT NOT NULL DEFAULT 'owner',   -- owner|admin|sales|designer|developer|social_manager|client
  permissions       TEXT NOT NULL DEFAULT '[]',      -- JSON array of capability keys
  is_active         INTEGER NOT NULL DEFAULT 1,
  avatar_initials   TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  expires_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor             TEXT NOT NULL DEFAULT 'user',    -- user|system|ai|client
  action            TEXT NOT NULL,
  entity_type       TEXT,
  entity_id         TEXT,
  detail            TEXT,                            -- JSON
  ip                TEXT,
  severity          TEXT NOT NULL DEFAULT 'info',    -- info|warn|critical
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_logs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);

-- Encrypted secret vault. Plaintext NEVER leaves the server; API returns masked only. (§55)
CREATE TABLE IF NOT EXISTS secrets (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,
  label             TEXT NOT NULL,
  cipher_blob       TEXT NOT NULL,                   -- AES-256-GCM payload
  last4             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  verified_at       TEXT,
  verify_error      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(org_id, provider_key)
);

-- External-action approvals (§18, §55). Nothing with an outside consequence ships without one
-- when approval mode requires it.
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,                   -- outreach_send|bulk_action|deploy|payment|publish
  subject           TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired
  requested_by      TEXT,
  decided_by        TEXT,
  decided_at        TEXT,
  reason            TEXT,
  expires_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(org_id, status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- DISCOVERY SOURCES & PROVIDERS  (§3, §54)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discovery_sources (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,                   -- registry key, e.g. 'directory.opendata'
  category          TEXT NOT NULL,                   -- directory|public_listing|search|maps|social|reviews|database|industry|import|connected
  label             TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  requires_credentials INTEGER NOT NULL DEFAULT 0,
  credentials_ready INTEGER NOT NULL DEFAULT 0,      -- derived, no plaintext
  config            TEXT NOT NULL DEFAULT '{}',
  rate_limit_per_min INTEGER,
  cost_per_call     REAL NOT NULL DEFAULT 0,
  last_run_at       TEXT,
  last_status       TEXT,
  last_error        TEXT,
  records_total     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(org_id, provider_key)
);

-- ─────────────────────────────────────────────────────────────
-- BUSINESSES  (§3, §11)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- identity
  name              TEXT NOT NULL,
  legal_name        TEXT,
  slug              TEXT NOT NULL,
  industry          TEXT,
  category          TEXT,
  subcategory       TEXT,
  description       TEXT,
  founded_year      INTEGER,

  -- location (optional metadata — never a discovery requirement, §2)
  address_line      TEXT,
  locality          TEXT,
  region            TEXT,
  country           TEXT,
  postal_code       TEXT,
  lat               REAL,
  lng               REAL,
  timezone          TEXT,

  -- digital footprint
  website           TEXT,
  website_domain    TEXT,
  website_status    TEXT NOT NULL DEFAULT 'unknown', -- live|unreachable|insecure|parked|missing|unknown
  website_checked_at TEXT,
  phone             TEXT,
  email             TEXT,
  social            TEXT NOT NULL DEFAULT '{}',      -- JSON {platform: url}

  -- commerce signals
  rating            REAL,
  review_count      INTEGER,
  price_level       TEXT,
  employee_estimate TEXT,
  is_new_business   INTEGER NOT NULL DEFAULT 0,
  hiring_signal     INTEGER NOT NULL DEFAULT 0,

  -- lifecycle
  stage             TEXT NOT NULL DEFAULT 'discovered',
  priority          TEXT NOT NULL DEFAULT 'low',     -- low|medium|high|critical
  opportunity_score REAL,
  intent_score      REAL NOT NULL DEFAULT 0,
  engagement_score  REAL NOT NULL DEFAULT 0,
  close_probability REAL NOT NULL DEFAULT 0,
  revenue_potential REAL NOT NULL DEFAULT 0,
  recommended_service TEXT,
  recommended_package_id TEXT REFERENCES service_packages(id) ON DELETE SET NULL,
  next_best_action  TEXT,
  next_best_action_reason TEXT,
  next_best_action_due TEXT,
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- consent / compliance (§56)
  consent_state     TEXT NOT NULL DEFAULT 'unknown', -- unknown|opted_in|opted_out|do_not_contact
  consent_source    TEXT,
  consent_at        TEXT,

  -- provenance (§3)
  first_discovered_at TEXT NOT NULL,
  last_verified_at  TEXT,
  source_confidence REAL,
  is_demo           INTEGER NOT NULL DEFAULT 0,      -- demo data flag (§73)

  -- dedupe
  merged_into       TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  is_archived       INTEGER NOT NULL DEFAULT 0,
  archived_reason   TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_biz_org_stage ON businesses(org_id, stage);
CREATE INDEX IF NOT EXISTS idx_biz_org_score ON businesses(org_id, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_biz_org_priority ON businesses(org_id, priority);
CREATE INDEX IF NOT EXISTS idx_biz_domain ON businesses(org_id, website_domain);
CREATE INDEX IF NOT EXISTS idx_biz_phone ON businesses(org_id, phone);
CREATE INDEX IF NOT EXISTS idx_biz_email ON businesses(org_id, email);
CREATE INDEX IF NOT EXISTS idx_biz_name ON businesses(org_id, name);
CREATE INDEX IF NOT EXISTS idx_biz_updated ON businesses(org_id, updated_at DESC);

-- Source attribution: every record stores source, url, timestamp, confidence (§3)
CREATE TABLE IF NOT EXISTS business_sources (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_id         TEXT REFERENCES discovery_sources(id) ON DELETE SET NULL,
  provider_key      TEXT NOT NULL,
  external_id       TEXT,
  source_url        TEXT,
  field             TEXT NOT NULL DEFAULT '*',       -- which fact this row evidences
  value             TEXT,
  confidence        REAL NOT NULL DEFAULT 0.5,
  discovered_at     TEXT NOT NULL,
  last_verified_at  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bizsrc_biz ON business_sources(business_id, field);

-- Duplicate resolution history (§11)
CREATE TABLE IF NOT EXISTS duplicate_events (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kept_id           TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  dropped_id        TEXT NOT NULL,
  dropped_name      TEXT,
  match_method      TEXT NOT NULL,                   -- domain|phone|email|name_address|source_id|social|fuzzy_name
  match_score       REAL NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '{}',
  resolution        TEXT NOT NULL DEFAULT 'merged',  -- merged|skipped|manual_review
  auto              INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dup_kept ON duplicate_events(kept_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  job_title         TEXT,
  seniority         TEXT,                            -- owner|decision_maker|manager|staff|unknown
  is_decision_maker INTEGER NOT NULL DEFAULT 0,
  email             TEXT,
  email_status      TEXT NOT NULL DEFAULT 'unknown', -- unknown|valid|risky|invalid
  phone             TEXT,
  linkedin_url      TEXT,
  preferred_channel TEXT,
  confidence        REAL NOT NULL DEFAULT 0.5,
  last_verified_at  TEXT,
  consent_state     TEXT NOT NULL DEFAULT 'unknown',
  consent_at        TEXT,
  notes             TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_biz ON contacts(business_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- ─────────────────────────────────────────────────────────────
-- ENRICHMENT  (§10)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enrichment_records (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,
  field             TEXT NOT NULL,
  value             TEXT,
  confidence        REAL NOT NULL DEFAULT 0.5,
  verified          INTEGER NOT NULL DEFAULT 0,
  verified_at       TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  raw               TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrich_biz ON enrichment_records(business_id, field);

-- Data confidence per business (§10)
CREATE TABLE IF NOT EXISTS data_confidence (
  business_id       TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  overall           REAL NOT NULL DEFAULT 0,
  per_field         TEXT NOT NULL DEFAULT '{}',
  sources_used      INTEGER NOT NULL DEFAULT 0,
  last_verified_at  TEXT,
  updated_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- DISCOVERY RUNS, AUTOMATION  (§4, §39–§42)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discovery_runs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|manual|backfill
  status            TEXT NOT NULL DEFAULT 'running',   -- running|completed|partial|failed|cancelled
  trigger           TEXT NOT NULL DEFAULT 'cron',
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  duration_ms       INTEGER,
  input_count       INTEGER NOT NULL DEFAULT 0,
  stats             TEXT NOT NULL DEFAULT '{}',        -- JSON step-by-step counters
  cost              REAL NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  summary           TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_org ON discovery_runs(org_id, started_at DESC);

CREATE TABLE IF NOT EXISTS discovery_run_items (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  step              TEXT NOT NULL,
  outcome           TEXT NOT NULL,                   -- ok|skipped|error
  detail            TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_items ON discovery_run_items(run_id, step);

CREATE TABLE IF NOT EXISTS automation_jobs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,                   -- daily_discovery|sequence_dispatch|followup_sweep|analytics_rollup|upsell_scan
  label             TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  schedule          TEXT NOT NULL DEFAULT 'daily',   -- daily|weekly|manual|custom
  cron              TEXT NOT NULL DEFAULT '0 2 * * *',
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  last_run_at       TEXT,
  last_run_id       TEXT,
  last_status       TEXT,
  next_run_at       TEXT,
  runs_total        INTEGER NOT NULL DEFAULT 0,
  runs_failed       INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms   INTEGER NOT NULL DEFAULT 0,
  config            TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(org_id, key)
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id            TEXT REFERENCES automation_jobs(id) ON DELETE SET NULL,
  run_id            TEXT,
  level             TEXT NOT NULL DEFAULT 'info',    -- debug|info|warn|error
  category          TEXT NOT NULL,                   -- source_error|api_error|website_analysis|enrichment|ai|outreach|mockup|deployment
  message           TEXT NOT NULL,
  entity_type       TEXT,
  entity_id         TEXT,
  detail            TEXT,
  retryable         INTEGER NOT NULL DEFAULT 0,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  resolution        TEXT,                            -- pending|retried|skipped|investigated|resolved
  resolved_at       TEXT,
  resolved_by       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autolog_org ON automation_logs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_autolog_cat ON automation_logs(org_id, category, resolution);

-- ─────────────────────────────────────────────────────────────
-- AUDITS  (§6, §7, §8, §9)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS digital_audits (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  website           TEXT,
  website_status    TEXT NOT NULL DEFAULT 'missing',
  website_score     REAL,
  digital_presence_score REAL,
  verified          INTEGER NOT NULL DEFAULT 0,      -- 1 = real HTTP check happened
  fetched_at        TEXT,
  http_status       INTEGER,
  response_ms       INTEGER,
  ssl_valid         INTEGER,
  ssl_issuer        TEXT,
  ssl_days_remaining INTEGER,
  mobile_responsive INTEGER,
  viewport_meta     INTEGER,
  page_count_est    INTEGER,
  internal_links    INTEGER,
  word_count        INTEGER,
  title             TEXT,
  meta_description  TEXT,
  meta_desc_length  INTEGER,
  h1_count          INTEGER,
  h2_count          INTEGER,
  image_count       INTEGER,
  images_missing_alt INTEGER,
  form_count        INTEGER,
  cta_count         INTEGER,
  has_booking       INTEGER NOT NULL DEFAULT 0,
  has_ecommerce     INTEGER NOT NULL DEFAULT 0,
  has_live_chat     INTEGER NOT NULL DEFAULT 0,
  has_schema_markup INTEGER NOT NULL DEFAULT 0,
  has_analytics     INTEGER NOT NULL DEFAULT 0,
  has_sitemap       INTEGER NOT NULL DEFAULT 0,
  has_robots        INTEGER NOT NULL DEFAULT 0,
  canonical_present INTEGER NOT NULL DEFAULT 0,
  og_tags           INTEGER NOT NULL DEFAULT 0,
  social_links_found TEXT NOT NULL DEFAULT '[]',
  testimonials_found INTEGER NOT NULL DEFAULT 0,
  service_pages     TEXT NOT NULL DEFAULT '[]',
  phone_found       TEXT,
  email_found       TEXT,
  accessibility_score REAL,
  seo_score         REAL,
  performance_score REAL,
  conversion_score  REAL,
  content_score     REAL,
  branding_score    REAL,
  trust_score       REAL,
  signals           TEXT NOT NULL DEFAULT '[]',      -- JSON opportunity signals with evidence
  critical_issues   TEXT NOT NULL DEFAULT '[]',
  high_impact       TEXT NOT NULL DEFAULT '[]',
  nice_to_have      TEXT NOT NULL DEFAULT '[]',
  recommended_service TEXT,
  improvement_report TEXT,                           -- rendered markdown
  raw_excerpt       TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_biz ON digital_audits(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS social_audits (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  social_score      REAL,
  platforms         TEXT NOT NULL DEFAULT '[]',      -- JSON [{platform,url,followers,last_post,posts,verified}]
  platform_count    INTEGER NOT NULL DEFAULT 0,
  active_platforms  INTEGER NOT NULL DEFAULT 0,
  last_activity_days INTEGER,
  posting_frequency TEXT,                            -- daily|weekly|monthly|dormant|none
  engagement_indicators TEXT NOT NULL DEFAULT '[]',
  profile_completeness REAL,
  visual_consistency REAL,
  has_cta           INTEGER NOT NULL DEFAULT 0,
  contact_in_bio    INTEGER NOT NULL DEFAULT 0,
  content_gaps      TEXT NOT NULL DEFAULT '[]',
  signals           TEXT NOT NULL DEFAULT '[]',
  growth_opportunity TEXT,
  recommended_service TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_socialaudit_biz ON social_audits(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS competitors (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  competitor_business_id TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  website           TEXT,
  how_identified    TEXT NOT NULL DEFAULT 'cohort',  -- cohort|search|user_added
  similarity        REAL NOT NULL DEFAULT 0.5,
  website_strength  TEXT,                            -- weak|medium|strong|unknown
  mobile_strength   TEXT,
  seo_strength      TEXT,
  social_strength   TEXT,
  branding_strength TEXT,
  cta_strength      TEXT,
  prospect_vs       TEXT NOT NULL DEFAULT '{}',      -- JSON category -> {prospect, competitor}
  gap_score         REAL NOT NULL DEFAULT 0,
  gap_summary       TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comp_biz ON competitors(business_id);

-- ─────────────────────────────────────────────────────────────
-- SCORING, ICP, LEARNING  (§13, §14, §67)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scoring_profiles (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  is_default        INTEGER NOT NULL DEFAULT 0,
  weights           TEXT NOT NULL,                   -- JSON factor -> weight (sums to 1)
  custom_rules      TEXT NOT NULL DEFAULT '[]',      -- JSON natural-language + encoded rules
  priority_thresholds TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_scores (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  profile_id        TEXT REFERENCES scoring_profiles(id) ON DELETE SET NULL,
  total             REAL NOT NULL,
  breakdown         TEXT NOT NULL DEFAULT '{}',      -- JSON factor -> {score,weight,contribution}
  reasons           TEXT NOT NULL DEFAULT '[]',
  priority          TEXT NOT NULL,
  service_fit       TEXT,
  computed_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_biz ON opportunity_scores(business_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS icp_profiles (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  preferred_industries TEXT NOT NULL DEFAULT '[]',
  excluded_industries  TEXT NOT NULL DEFAULT '[]',
  business_sizes    TEXT NOT NULL DEFAULT '[]',
  services          TEXT NOT NULL DEFAULT '[]',
  min_opportunity_score REAL NOT NULL DEFAULT 60,
  excluded_businesses TEXT NOT NULL DEFAULT '[]',
  preferred_packages TEXT NOT NULL DEFAULT '[]',
  price_range_min   REAL,
  price_range_max   REAL,
  digital_problems  TEXT NOT NULL DEFAULT '[]',
  contact_requirements TEXT NOT NULL DEFAULT '{}',
  learned_signals   TEXT NOT NULL DEFAULT '{}',      -- derived from outcomes (§14)
  updated_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- Outcome log powering self-improvement (§67)
CREATE TABLE IF NOT EXISTS outcome_events (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,                   -- won|lost|response|positive|mockup_view|call|proposal|revenue|outreach_variant
  weight            REAL NOT NULL DEFAULT 1,
  features          TEXT NOT NULL DEFAULT '{}',      -- JSON features present at decision time
  variant_id        TEXT,
  value             REAL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_org ON outcome_events(org_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS optimization_recommendations (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  area              TEXT NOT NULL,                   -- scoring|outreach|mockup|sequencing|packages
  title             TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '{}',
  proposed_change   TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'suggested', -- suggested|accepted|rejected|applied
  applied_at        TEXT,
  created_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- AI RESEARCH & MEMORY  (§12, §44)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research_docs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'complete',
  what_they_do      TEXT,
  customers         TEXT,
  services_offered  TEXT NOT NULL DEFAULT '[]',
  digital_weaknesses TEXT NOT NULL DEFAULT '[]',
  website_lacks     TEXT NOT NULL DEFAULT '[]',
  social_lacks      TEXT NOT NULL DEFAULT '[]',
  competitor_edges  TEXT NOT NULL DEFAULT '[]',
  opportunity       TEXT,
  what_to_sell      TEXT,
  outreach_angles   TEXT NOT NULL DEFAULT '[]',
  custom_answers    TEXT NOT NULL DEFAULT '[]',      -- JSON [{question, answer, sources}]
  citations         TEXT NOT NULL DEFAULT '[]',
  confidence        REAL NOT NULL DEFAULT 0.5,
  unverified_claims TEXT NOT NULL DEFAULT '[]',      -- explicitly flagged, never asserted
  model_used        TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  generated_at      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_biz ON research_docs(business_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS research_questions (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  question          TEXT NOT NULL,
  answer            TEXT,
  sources           TEXT NOT NULL DEFAULT '[]',
  answered_at       TEXT,
  created_at        TEXT NOT NULL
);

-- Business-level AI memory (§44)
CREATE TABLE IF NOT EXISTS ai_memory (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,                   -- fact|preference|objection|commitment|history
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.8,
  source            TEXT,
  pinned            INTEGER NOT NULL DEFAULT 0,
  superseded_by     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_biz ON ai_memory(business_id, kind);

-- ─────────────────────────────────────────────────────────────
-- AI ORCHESTRATION  (§43, §65, §66)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_models (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,                   -- local|openai|anthropic|google|custom
  model_id          TEXT NOT NULL,
  label             TEXT NOT NULL,
  tier              TEXT NOT NULL DEFAULT 'standard',-- nano|standard|strong|vision|image
  supports          TEXT NOT NULL DEFAULT '[]',      -- JSON capabilities
  quality_score     REAL NOT NULL DEFAULT 0.7,
  speed_ms          INTEGER NOT NULL DEFAULT 1500,
  cost_per_1k_in    REAL NOT NULL DEFAULT 0,
  cost_per_1k_out   REAL NOT NULL DEFAULT 0,
  context_window    INTEGER NOT NULL DEFAULT 32000,
  enabled           INTEGER NOT NULL DEFAULT 1,
  credentials_ready INTEGER NOT NULL DEFAULT 0,
  failure_rate      REAL NOT NULL DEFAULT 0,
  avg_latency_ms    INTEGER,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(org_id, provider_key, model_id)
);

CREATE TABLE IF NOT EXISTS ai_task_routes (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task              TEXT NOT NULL,                   -- web_research|classification|lead_scoring|summarization|outreach|website_copy|website_design|image_generation|call_summary|proposal
  label             TEXT NOT NULL,
  preferred_model_id TEXT REFERENCES ai_models(id) ON DELETE SET NULL,
  fallback_model_ids TEXT NOT NULL DEFAULT '[]',
  priority          TEXT NOT NULL DEFAULT 'balanced',-- quality|balanced|cost|speed
  override          INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE(org_id, task)
);

CREATE TABLE IF NOT EXISTS ai_model_usage (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task              TEXT NOT NULL,
  model_id          TEXT REFERENCES ai_models(id) ON DELETE SET NULL,
  provider_key      TEXT NOT NULL,
  model_label       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ok',      -- ok|error|fallback
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cost              REAL NOT NULL DEFAULT 0,
  error             TEXT,
  entity_type       TEXT,
  entity_id         TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_task ON ai_model_usage(org_id, task, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_time ON ai_model_usage(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_benchmarks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  task              TEXT NOT NULL,
  accuracy          REAL,
  quality           REAL,
  latency_ms        REAL,
  cost              REAL,
  failure_rate      REAL,
  samples           INTEGER NOT NULL DEFAULT 0,
  recommendation    TEXT,
  run_at            TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- OUTREACH  (§16–§19, §56)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_templates (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  channel           TEXT NOT NULL,                   -- email|sms|whatsapp|linkedin|phone|custom
  tone              TEXT NOT NULL DEFAULT 'professional',
  subject           TEXT,
  body              TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT 'intro',   -- intro|followup|value|mockup|final
  experiment_id     TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  variant_key       TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  stats             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL,
  direction         TEXT NOT NULL DEFAULT 'outbound',
  subject           TEXT,
  body              TEXT NOT NULL,
  tone              TEXT,
  purpose           TEXT NOT NULL DEFAULT 'intro',
  template_id       TEXT REFERENCES outreach_templates(id) ON DELETE SET NULL,
  experiment_id     TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  variant_key       TEXT,
  sequence_id       TEXT REFERENCES sequences(id) ON DELETE SET NULL,
  step_index        INTEGER,

  status            TEXT NOT NULL DEFAULT 'draft',   -- draft|queued|approved|sending|sent|delivered|opened|clicked|replied|bounced|failed|opted_out|skipped
  approval_mode     TEXT NOT NULL DEFAULT 'assisted',-- manual|assisted|autonomous
  approval_id       TEXT REFERENCES approvals(id) ON DELETE SET NULL,

  provider_key      TEXT,
  provider_status   TEXT,
  provider_message_id TEXT,
  provider_error    TEXT,
  simulated         INTEGER NOT NULL DEFAULT 1,      -- 1 when no real provider is configured (§54 honesty)

  sent_at           TEXT,
  delivered_at      TEXT,
  opened_at         TEXT,
  open_count        INTEGER NOT NULL DEFAULT 0,
  clicked_at        TEXT,
  click_count       INTEGER NOT NULL DEFAULT 0,
  replied_at        TEXT,
  bounced_at        TEXT,
  unsubscribe_at    TEXT,
  scheduled_at      TEXT,
  cost              REAL NOT NULL DEFAULT 0,

  grounding         TEXT NOT NULL DEFAULT '[]',      -- JSON: the real facts this message used
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_out_biz ON outreach_messages(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_out_status ON outreach_messages(org_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_out_exp ON outreach_messages(experiment_id, variant_key);

CREATE TABLE IF NOT EXISTS sequences (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  goal              TEXT,
  approval_mode     TEXT NOT NULL DEFAULT 'assisted',
  daily_send_limit  INTEGER NOT NULL DEFAULT 50,
  domain_daily_limit INTEGER NOT NULL DEFAULT 30,
  quiet_hours_start TEXT NOT NULL DEFAULT '20:00',
  quiet_hours_end   TEXT NOT NULL DEFAULT '08:00',
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  stop_on_response  INTEGER NOT NULL DEFAULT 1,
  stop_on_optout    INTEGER NOT NULL DEFAULT 1,
  stop_on_client    INTEGER NOT NULL DEFAULT 1,
  stop_on_not_interested INTEGER NOT NULL DEFAULT 1,
  max_touches       INTEGER NOT NULL DEFAULT 5,
  is_active         INTEGER NOT NULL DEFAULT 1,
  is_default        INTEGER NOT NULL DEFAULT 0,
  stats             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id                TEXT PRIMARY KEY,
  sequence_id       TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  day_offset        INTEGER NOT NULL,
  channel           TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT 'intro',
  tone              TEXT NOT NULL DEFAULT 'professional',
  subject           TEXT,
  body              TEXT,
  template_id       TEXT REFERENCES outreach_templates(id) ON DELETE SET NULL,
  include_mockup    INTEGER NOT NULL DEFAULT 0,
  include_value     TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seqsteps ON sequence_steps(sequence_id, position);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sequence_id       TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'active',  -- active|paused|completed|stopped_response|stopped_optout|stopped_client|stopped_not_interested|failed
  current_step      INTEGER NOT NULL DEFAULT 0,
  next_step_at      TEXT,
  enrolled_at       TEXT NOT NULL,
  started_at        TEXT,
  ended_at          TEXT,
  stop_reason       TEXT,
  touches_sent      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_enroll_active ON sequence_enrollments(org_id, status, next_step_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enroll_active ON sequence_enrollments(sequence_id, business_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS follow_ups (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL DEFAULT 'outreach',-- outreach|call|mockup|proposal|task|review
  title             TEXT NOT NULL,
  reason            TEXT NOT NULL,
  due_at            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|done|snoozed|cancelled|overdue
  priority          TEXT NOT NULL DEFAULT 'medium',
  suggested_action  TEXT,
  completed_at      TEXT,
  completed_by      TEXT,
  snoozed_until     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fu_due ON follow_ups(org_id, status, due_at);

-- Compliance registry (§56)
CREATE TABLE IF NOT EXISTS suppression_list (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,                   -- email|phone|domain|business
  value             TEXT NOT NULL,
  reason            TEXT NOT NULL,                   -- unsubscribe|opt_out|do_not_contact|bounce|complaint|manual
  source            TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(org_id, kind, value)
);

CREATE TABLE IF NOT EXISTS communication_consent (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'unknown',
  basis             TEXT,                            -- legitimate_interest|consent|contract|none
  region            TEXT,
  evidence          TEXT,
  recorded_at       TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- MOCKUPS / WEBSITE GENERATION  (§20–§25)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mockups (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  design_direction  TEXT NOT NULL,
  theme             TEXT NOT NULL DEFAULT '{}',      -- JSON palette/fonts/radius/shadow
  layout_variant    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft|ready|shared|viewed|stale
  share_token       TEXT NOT NULL UNIQUE,
  share_enabled     INTEGER NOT NULL DEFAULT 1,
  view_count        INTEGER NOT NULL DEFAULT 0,
  unique_viewers    INTEGER NOT NULL DEFAULT 0,
  first_viewed_at   TEXT,
  last_viewed_at    TEXT,
  total_view_ms     INTEGER NOT NULL DEFAULT 0,
  devices           TEXT NOT NULL DEFAULT '{}',
  returning_viewers INTEGER NOT NULL DEFAULT 0,
  intent_score      REAL NOT NULL DEFAULT 0,
  current_version   INTEGER NOT NULL DEFAULT 1,
  cost              REAL NOT NULL DEFAULT 0,
  pitch_kit         TEXT NOT NULL DEFAULT '{}',
  experiment_id     TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  variant_key       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mock_biz ON mockups(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mockup_versions (
  id                TEXT PRIMARY KEY,
  mockup_id         TEXT NOT NULL REFERENCES mockups(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  html              TEXT NOT NULL,
  theme             TEXT NOT NULL DEFAULT '{}',
  sections          TEXT NOT NULL DEFAULT '[]',
  change_summary    TEXT,
  change_command    TEXT,                            -- the conversational edit instruction (§21)
  parent_version    INTEGER,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cost              REAL NOT NULL DEFAULT 0,
  model_used        TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(mockup_id, version)
);

CREATE TABLE IF NOT EXISTS mockup_views (
  id                TEXT PRIMARY KEY,
  mockup_id         TEXT NOT NULL REFERENCES mockups(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version           INTEGER,
  visitor_token     TEXT NOT NULL,
  is_returning      INTEGER NOT NULL DEFAULT 0,
  device            TEXT,
  viewport          TEXT,
  user_agent        TEXT,
  referrer          TEXT,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  scrolled_pct      INTEGER NOT NULL DEFAULT 0,
  sections_seen     TEXT NOT NULL DEFAULT '[]',
  cta_clicked       INTEGER NOT NULL DEFAULT 0,
  ip_hash           TEXT,
  viewed_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mview_mock ON mockup_views(mockup_id, viewed_at DESC);

-- Asset library (§22)
CREATE TABLE IF NOT EXISTS assets (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,                   -- image|logo|icon|font|color
  origin            TEXT NOT NULL,                   -- ai_generated|stock|uploaded|extracted
  url               TEXT NOT NULL,
  alt               TEXT,
  license           TEXT,
  needs_review      INTEGER NOT NULL DEFAULT 0,
  meta              TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- CALLS  (§28, §29)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  scheduled_at      TEXT,
  duration_min      INTEGER NOT NULL DEFAULT 30,
  meeting_link      TEXT,
  location          TEXT,
  status            TEXT NOT NULL DEFAULT 'scheduled', -- proposed|scheduled|completed|no_show|cancelled
  attendees         TEXT NOT NULL DEFAULT '[]',
  agenda            TEXT NOT NULL DEFAULT '[]',
  raw_notes         TEXT,
  ai_summary        TEXT,
  requirements      TEXT NOT NULL DEFAULT '[]',
  scope             TEXT NOT NULL DEFAULT '[]',
  budget            TEXT,
  decision_maker    TEXT,
  objections        TEXT NOT NULL DEFAULT '[]',
  next_steps        TEXT NOT NULL DEFAULT '[]',
  outcome           TEXT,                            -- positive|neutral|negative|no_show
  briefing_id       TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_org ON calls(org_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_calls_biz ON calls(business_id);

CREATE TABLE IF NOT EXISTS call_notes (
  id                TEXT PRIMARY KEY,
  call_id           TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  author            TEXT NOT NULL DEFAULT 'user',
  body              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'note',    -- note|requirement|objection|decision|next_step
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_briefings (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id           TEXT REFERENCES calls(id) ON DELETE SET NULL,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  business_overview TEXT,
  digital_problems  TEXT NOT NULL DEFAULT '[]',
  opportunity       TEXT,
  likely_needs      TEXT NOT NULL DEFAULT '[]',
  opening           TEXT,
  questions         TEXT NOT NULL DEFAULT '[]',
  objections        TEXT NOT NULL DEFAULT '[]',
  recommended_package TEXT,
  price_range       TEXT,
  call_goal         TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- PROPOSALS  (§30, §31)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposals (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id           TEXT REFERENCES calls(id) ON DELETE SET NULL,
  number            TEXT NOT NULL,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft|sent|viewed|accepted|rejected|expired|withdrawn
  slug              TEXT NOT NULL UNIQUE,
  problem           TEXT,
  solution          TEXT,
  scope             TEXT NOT NULL DEFAULT '[]',
  deliverables      TEXT NOT NULL DEFAULT '[]',
  timeline          TEXT,
  timeline_weeks    INTEGER,
  subtotal          REAL NOT NULL DEFAULT 0,
  discount_pct      REAL NOT NULL DEFAULT 0,
  tax_pct           REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  optional_services TEXT NOT NULL DEFAULT '[]',
  recurring_total   REAL NOT NULL DEFAULT 0,
  terms             TEXT NOT NULL DEFAULT '[]',
  next_steps        TEXT NOT NULL DEFAULT '[]',
  validity_days     INTEGER NOT NULL DEFAULT 14,
  view_count        INTEGER NOT NULL DEFAULT 0,
  first_viewed_at   TEXT,
  last_viewed_at    TEXT,
  sent_at           TEXT,
  responded_at      TEXT,
  response_note     TEXT,
  -- e-signature / payment readiness (§31) — integration-ready, never faked
  signature_provider TEXT,
  signature_status  TEXT NOT NULL DEFAULT 'not_configured', -- not_configured|pending|signed|declined
  signature_payload TEXT,
  payment_provider  TEXT,
  payment_status    TEXT NOT NULL DEFAULT 'not_configured', -- not_configured|pending|paid|failed
  deposit_amount    REAL,
  deposit_status    TEXT NOT NULL DEFAULT 'not_configured',
  cost              REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prop_org ON proposals(org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS proposal_items (
  id                TEXT PRIMARY KEY,
  proposal_id       TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  package_id        TEXT REFERENCES service_packages(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  kind              TEXT NOT NULL DEFAULT 'one_time', -- one_time|recurring
  qty               REAL NOT NULL DEFAULT 1,
  unit_price        REAL NOT NULL DEFAULT 0,
  interval          TEXT,                            -- month|year|once
  total             REAL NOT NULL DEFAULT 0,
  optional          INTEGER NOT NULL DEFAULT 0,
  position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_propitems ON proposal_items(proposal_id, position);

-- ─────────────────────────────────────────────────────────────
-- CLIENTS, PROJECTS, DELIVERY  (§32, §33)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE, -- conversion, never duplication (§32)
  portal_token      TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'onboarding', -- onboarding|active|paused|churned
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  kickoff_at        TEXT,
  won_at            TEXT,
  lifetime_value    REAL NOT NULL DEFAULT 0,
  mrr               REAL NOT NULL DEFAULT 0,
  arr               REAL NOT NULL DEFAULT 0,
  health            TEXT NOT NULL DEFAULT 'good',    -- good|at_risk|critical
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  proposal_id       TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'website', -- website|social|seo|content|maintenance|retainer
  stage             TEXT NOT NULL DEFAULT 'onboarding', -- onboarding|requirements|design|development|content|testing|client_review|revisions|approval|deployment|handover|complete
  status            TEXT NOT NULL DEFAULT 'active',  -- active|blocked|on_hold|complete|cancelled
  progress          INTEGER NOT NULL DEFAULT 0,
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  starts_at         TEXT,
  due_at            TEXT,
  budget            REAL,
  health            TEXT NOT NULL DEFAULT 'on_track', -- on_track|at_risk|delayed
  health_reason     TEXT,
  requirements      TEXT NOT NULL DEFAULT '[]',
  deliverables      TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proj_org ON projects(org_id, status, stage);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  stage             TEXT,
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  assignee_role     TEXT,
  due_at            TEXT,
  priority          TEXT NOT NULL DEFAULT 'medium',  -- low|medium|high|critical
  status            TEXT NOT NULL DEFAULT 'todo',    -- todo|in_progress|blocked|review|done|cancelled
  depends_on        TEXT NOT NULL DEFAULT '[]',
  estimate_hours    REAL,
  progress          INTEGER NOT NULL DEFAULT 0,
  needs_client_input INTEGER NOT NULL DEFAULT 0,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_proj ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(org_id, status, due_at);

-- Client approvals (§37)
CREATE TABLE IF NOT EXISTS approval_requests (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,                   -- website_preview|content|mockup|proposal|deliverable
  ref_type          TEXT,
  ref_id            TEXT,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|approved|revision|rejected
  preview_url       TEXT,
  requested_at      TEXT NOT NULL,
  responded_at      TEXT,
  responded_by      TEXT,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_apreq ON approval_requests(client_id, status);

CREATE TABLE IF NOT EXISTS feedback_items (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  approval_id       TEXT REFERENCES approval_requests(id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  author            TEXT NOT NULL DEFAULT 'client',
  body              TEXT NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'normal',
  resolved          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_messages (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author            TEXT NOT NULL,                   -- user id or 'client'
  body              TEXT NOT NULL,
  read_at           TEXT,
  created_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- WEBSITES, HOSTING, DEPLOYMENT  (§34)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS websites (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  mockup_id         TEXT REFERENCES mockups(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft|preview|staging|live|archived
  html              TEXT,
  theme             TEXT NOT NULL DEFAULT '{}',
  current_version   INTEGER NOT NULL DEFAULT 1,
  preview_url       TEXT,
  live_url          TEXT,
  hosting_provider  TEXT,
  deployment_id     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON websites(org_id, status);

CREATE TABLE IF NOT EXISTS website_versions (
  id                TEXT PRIMARY KEY,
  website_id        TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  html              TEXT NOT NULL,
  theme             TEXT NOT NULL DEFAULT '{}',
  note              TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(website_id, version)
);

CREATE TABLE IF NOT EXISTS domains (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id        TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  hostname          TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'subdomain', -- subdomain|custom
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending|verifying|active|failed
  provider          TEXT,
  ssl_status        TEXT NOT NULL DEFAULT 'none',      -- none|pending|active|failed
  ssl_expires_at    TEXT,
  dns_records       TEXT NOT NULL DEFAULT '[]',
  verified_at       TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id        TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  website_version   INTEGER NOT NULL,
  provider_key      TEXT NOT NULL,
  target            TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',  -- queued|building|deployed|failed|rolled_back|simulated
  simulated         INTEGER NOT NULL DEFAULT 1,      -- 1 when no hosting provider configured (§34)
  url               TEXT,
  logs              TEXT,
  error             TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  duration_ms       INTEGER,
  cost              REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deploy_site ON deployments(website_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- REVENUE  (§35)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_packages (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  tier              TEXT NOT NULL DEFAULT 'standard',
  summary           TEXT,
  one_time_price    REAL NOT NULL DEFAULT 0,
  monthly_price     REAL NOT NULL DEFAULT 0,
  includes          TEXT NOT NULL DEFAULT '[]',
  deliverables      TEXT NOT NULL DEFAULT '[]',
  timeline_weeks    INTEGER,
  targets_signals   TEXT NOT NULL DEFAULT '[]',      -- audit signals this package addresses
  currency          TEXT NOT NULL DEFAULT 'USD',
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id        TEXT REFERENCES service_packages(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  amount            REAL NOT NULL,
  interval          TEXT NOT NULL DEFAULT 'month',   -- month|year
  currency          TEXT NOT NULL DEFAULT 'USD',
  status            TEXT NOT NULL DEFAULT 'active',  -- active|paused|cancelled|past_due
  provider          TEXT,
  provider_sub_id   TEXT,
  started_at        TEXT NOT NULL,
  current_period_end TEXT,
  cancelled_at      TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_client ON subscriptions(client_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  proposal_id       TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  subscription_id   TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL DEFAULT 'invoice', -- deposit|invoice|subscription|refund
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|paid|failed|refunded|not_configured
  provider          TEXT,
  provider_payment_id TEXT,
  simulated         INTEGER NOT NULL DEFAULT 1,      -- never fake a real payment (§31)
  invoice_number    TEXT,
  paid_at           TEXT,
  due_at            TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_org ON payments(org_id, status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- SOCIAL MANAGEMENT  (§36, §37)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_accounts (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  handle            TEXT NOT NULL,
  profile_url       TEXT,
  connected         INTEGER NOT NULL DEFAULT 0,
  provider_key      TEXT,
  followers         INTEGER,
  last_synced_at    TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  objective         TEXT,
  start_date        TEXT,
  end_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'planning', -- planning|active|paused|complete
  budget            REAL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_posts (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_id        TEXT REFERENCES social_accounts(id) ON DELETE SET NULL,
  campaign_id       TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  platform          TEXT NOT NULL,
  format            TEXT NOT NULL DEFAULT 'post',    -- post|reel|story|carousel
  caption           TEXT NOT NULL,
  hashtags          TEXT NOT NULL DEFAULT '[]',
  media             TEXT NOT NULL DEFAULT '[]',
  creative_brief    TEXT,
  scheduled_for     TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft|client_review|approved|scheduled|published|rejected
  approval_id       TEXT REFERENCES approval_requests(id) ON DELETE SET NULL,
  published_at      TEXT,
  provider_key      TEXT,
  simulated         INTEGER NOT NULL DEFAULT 1,
  metrics           TEXT NOT NULL DEFAULT '{}',
  ai_generated      INTEGER NOT NULL DEFAULT 0,
  grounded_in       TEXT NOT NULL DEFAULT '[]',
  cost              REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_client ON social_posts(client_id, status, scheduled_for);

-- ─────────────────────────────────────────────────────────────
-- EXPERIMENTATION  (§48)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS experiments (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  hypothesis        TEXT,
  target            TEXT NOT NULL,                   -- subject_line|message_style|cta|mockup_style|pricing|followup_timing
  metric            TEXT NOT NULL DEFAULT 'response_rate',
  status            TEXT NOT NULL DEFAULT 'running', -- running|paused|concluded
  split             TEXT NOT NULL DEFAULT '{}',
  started_at        TEXT,
  concluded_at      TEXT,
  winner            TEXT,
  recommendation    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id                TEXT PRIMARY KEY,
  experiment_id     TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_key       TEXT NOT NULL,
  label             TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  impressions       INTEGER NOT NULL DEFAULT 0,
  conversions       INTEGER NOT NULL DEFAULT 0,
  secondary         INTEGER NOT NULL DEFAULT 0,
  revenue           REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  UNIQUE(experiment_id, variant_key)
);

-- ─────────────────────────────────────────────────────────────
-- UPSELL  (§50)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upsell_opportunities (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service           TEXT NOT NULL,
  package_id        TEXT REFERENCES service_packages(id) ON DELETE SET NULL,
  score             REAL NOT NULL DEFAULT 0,
  rationale         TEXT NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '[]',
  est_mrr           REAL NOT NULL DEFAULT 0,
  est_one_time      REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'identified', -- identified|pitched|accepted|declined
  pitched_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upsell ON upsell_opportunities(org_id, status, score DESC);

-- ─────────────────────────────────────────────────────────────
-- ACTIVITY, BRIEFINGS, COMMAND CENTER  (§45, §46, §61)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor             TEXT NOT NULL DEFAULT 'system',  -- system|ai|user:<id>|client|provider:<key>
  kind              TEXT NOT NULL,                   -- discovery|audit|score|research|outreach|mockup|call|proposal|project|deployment|social|stage_change|note|error
  title             TEXT NOT NULL,
  detail            TEXT,
  entity_type       TEXT,
  entity_id         TEXT,
  icon              TEXT,
  importance        TEXT NOT NULL DEFAULT 'normal',  -- normal|high|critical
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_biz ON activities(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_act_org ON activities(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS briefings (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  for_date          TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  generated_at      TEXT NOT NULL,
  read_at           TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(org_id, for_date)
);

CREATE TABLE IF NOT EXISTS command_runs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  input             TEXT NOT NULL,
  intent            TEXT NOT NULL,
  parsed            TEXT NOT NULL DEFAULT '{}',
  result_kind       TEXT NOT NULL,                   -- list|summary|action_plan|chart
  result            TEXT NOT NULL DEFAULT '{}',
  proposed_actions  TEXT NOT NULL DEFAULT '[]',
  authorized        INTEGER NOT NULL DEFAULT 0,
  executed          INTEGER NOT NULL DEFAULT 0,
  execution_result  TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cmd_org ON command_runs(org_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- IMPORT / EXPORT  (§53)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_batches (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  filename          TEXT,
  format            TEXT NOT NULL DEFAULT 'csv',
  rows_total        INTEGER NOT NULL DEFAULT 0,
  rows_imported     INTEGER NOT NULL DEFAULT 0,
  rows_deduped      INTEGER NOT NULL DEFAULT 0,
  rows_invalid      INTEGER NOT NULL DEFAULT 0,
  errors            TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'complete',
  created_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- COST LEDGER  (§65)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_ledger (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,                   -- discovery|enrichment|ai_research|website_generation|image_generation|outreach|deployment|social
  provider_key      TEXT,
  business_id       TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  amount            REAL NOT NULL DEFAULT 0,
  units             INTEGER NOT NULL DEFAULT 1,
  note              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_org ON cost_ledger(org_id, category, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- SETTINGS  (§57)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  value             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(org_id, key)
);

-- Full-text search over businesses (§51)
CREATE VIRTUAL TABLE IF NOT EXISTS businesses_fts USING fts5(
  name, industry, category, description, locality, region, country,
  content='businesses', content_rowid='rowid'
);
