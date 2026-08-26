-- ClientForge AI V2 — schema additions
-- Applied idempotently by src/db/migrations.ts. Every statement is additive:
-- existing tables and data are never dropped or rewritten.

-- ═══════════════════════════════════════════════════════════
-- 1. JOB ARCHITECTURE (§30, §31, §32)
--    Resumable runs, locking, retry, dead-letter, idempotency.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS job_runs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_key           TEXT NOT NULL,                   -- daily_discovery | sequence_dispatch | …
  run_group         TEXT NOT NULL,                   -- groups steps belonging to one logical run
  status            TEXT NOT NULL DEFAULT 'running', -- running|paused|completed|partial|failed|cancelled
  trigger           TEXT NOT NULL DEFAULT 'cron',    -- cron|manual|retry|api
  current_step      TEXT,
  last_successful_step TEXT,
  completed_steps   TEXT NOT NULL DEFAULT '[]',      -- JSON array, in order
  progress          INTEGER NOT NULL DEFAULT 0,      -- 0-100
  total_steps       INTEGER NOT NULL DEFAULT 0,
  input_count       INTEGER NOT NULL DEFAULT 0,
  stats             TEXT NOT NULL DEFAULT '{}',
  error             TEXT,
  error_step        TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 2,
  lock_token        TEXT,
  lock_expires_at   TEXT,
  started_at        TEXT NOT NULL,
  paused_at         TEXT,
  finished_at       TEXT,
  duration_ms       INTEGER,
  cost              REAL NOT NULL DEFAULT 0,
  idempotency_key   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobruns_org ON job_runs(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobruns_status ON job_runs(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobruns_idem ON job_runs(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step              TEXT NOT NULL,
  position          INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|skipped|failed
  attempts          INTEGER NOT NULL DEFAULT 0,
  processed         INTEGER NOT NULL DEFAULT 0,
  succeeded         INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  detail            TEXT,
  error             TEXT,
  duration_ms       INTEGER,
  started_at        TEXT,
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobsteps_run ON job_steps(run_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobsteps ON job_steps(run_id, step);

-- Dead-letter queue: work that exhausted retries and needs a human (§31, §42).
CREATE TABLE IF NOT EXISTS dead_letter (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id            TEXT,
  job_key           TEXT,
  step              TEXT,
  category          TEXT NOT NULL,                   -- discovery|audit|enrichment|outreach|mockup|deployment|ai
  entity_type       TEXT,
  entity_id         TEXT,
  payload           TEXT NOT NULL DEFAULT '{}',
  error             TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT,
  status            TEXT NOT NULL DEFAULT 'open',    -- open|resolved|discarded
  resolved_at       TEXT,
  resolved_by       TEXT,
  resolution        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dlq_org ON dead_letter(org_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dlq_idem ON dead_letter(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Idempotency ledger: makes retries safe (§32).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  operation         TEXT NOT NULL,
  result            TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  UNIQUE(org_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idem_org ON idempotency_keys(org_id, expires_at);

-- ═══════════════════════════════════════════════════════════
-- 2. MERGE REVIEW QUEUE (§5) — uncertain matches wait for a human
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS merge_reviews (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  keep_id           TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  candidate_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  match_method      TEXT NOT NULL,
  match_score       REAL NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|merged|rejected|deferred
  decided_by        TEXT,
  decided_at        TEXT,
  reason            TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merge_org ON merge_reviews(org_id, status, match_score DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_merge_pair ON merge_reviews(org_id, keep_id, candidate_id);

-- ═══════════════════════════════════════════════════════════
-- 3. SEQUENCE BRANCHING (§12)
-- ═══════════════════════════════════════════════════════════
ALTER TABLE sequence_steps ADD COLUMN branch_condition TEXT;   -- replied|not_replied|mockup_viewed|mockup_not_viewed|always
ALTER TABLE sequence_steps ADD COLUMN goto_position INTEGER;   -- jump target when the condition matches
ALTER TABLE sequence_steps ADD COLUMN is_terminal INTEGER NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════
-- 4. RESPONSE CLASSIFICATION (§14) — 9 categories, not just sentiment
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS response_classifications (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id        TEXT REFERENCES outreach_messages(id) ON DELETE SET NULL,
  classification    TEXT NOT NULL,                   -- interested|not_interested|maybe|pricing_question|info_request|wants_call|objection|opt_out|unknown
  confidence        REAL NOT NULL DEFAULT 0.5,
  signals           TEXT NOT NULL DEFAULT '[]',
  recommended_action TEXT,
  recommended_reason TEXT,
  model_used        TEXT,
  cost              REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resp_biz ON response_classifications(business_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- 5. AUTH + SECURITY (§35, §37, §38)
-- ═══════════════════════════════════════════════════════════
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN revoked_at TEXT;

CREATE TABLE IF NOT EXISTS login_attempts (
  id                TEXT PRIMARY KEY,
  org_id            TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  success           INTEGER NOT NULL DEFAULT 0,
  ip_hash           TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_email ON login_attempts(email, created_at DESC);

-- Request tracing + API rate limiting (§40, §43)
CREATE TABLE IF NOT EXISTS api_requests (
  id                TEXT PRIMARY KEY,
  org_id            TEXT,
  user_id           TEXT,
  trace_id          TEXT NOT NULL,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  status            INTEGER,
  duration_ms       INTEGER,
  ip_hash           TEXT,
  user_agent        TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apireq_time ON api_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_apireq_trace ON api_requests(trace_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,                   -- ip:<hash> | user:<id> | org:<id>
  bucket            TEXT NOT NULL,                   -- api | auth | ai
  count             INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  UNIQUE(scope, bucket)
);

-- ═══════════════════════════════════════════════════════════
-- 6. MONITORING + BACKUPS (§43, §44)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS health_checks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT,
  component         TEXT NOT NULL,                   -- app|database|scheduler|queue|ai|providers|email|hosting
  status            TEXT NOT NULL,                   -- healthy|degraded|unhealthy
  latency_ms        INTEGER,
  detail            TEXT,
  checked_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_time ON health_checks(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_comp ON health_checks(component, checked_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id                TEXT PRIMARY KEY,
  org_id            TEXT,
  kind              TEXT NOT NULL DEFAULT 'database',
  path              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  checksum          TEXT,
  verified          INTEGER NOT NULL DEFAULT 0,
  verified_at       TEXT,
  trigger           TEXT NOT NULL DEFAULT 'manual',  -- manual|scheduled|pre_migration
  status            TEXT NOT NULL DEFAULT 'ok',      -- ok|failed
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_time ON backups(created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- 7. PERFORMANCE — indexes for high-volume queries (§39, §41)
-- ═══════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_biz_org_score_stage ON businesses(org_id, stage, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_biz_org_ws ON businesses(org_id, website_status, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_biz_org_demo ON businesses(org_id, is_demo, merged_into, is_archived);
CREATE INDEX IF NOT EXISTS idx_out_biz_status ON outreach_messages(business_id, direction, status);
CREATE INDEX IF NOT EXISTS idx_out_org_created ON outreach_messages(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fu_org_status_due ON follow_ups(org_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_mock_org_status ON mockups(org_id, status, view_count DESC);
CREATE INDEX IF NOT EXISTS idx_mview_viewed ON mockup_views(viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_org_status_sched ON calls(org_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_prop_org_status ON proposals(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status_due ON tasks(org_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_projects_org_status ON projects(org_id, status, health);
CREATE INDEX IF NOT EXISTS idx_apreq_org_status ON approval_requests(org_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_org_status_sched ON social_posts(org_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_subs_org_status ON subscriptions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_pay_org_status_created ON payments(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_org_cat_created ON cost_ledger(org_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON digital_audits(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_socialaudit_org_created ON social_audits(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_org_biz ON research_docs(org_id, business_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrich_org_biz ON enrichment_records(org_id, business_id);
CREATE INDEX IF NOT EXISTS idx_confidence_verified ON data_confidence(last_verified_at);
CREATE INDEX IF NOT EXISTS idx_secrets_org ON secrets(org_id, provider_key);
CREATE INDEX IF NOT EXISTS idx_sources_org_enabled ON discovery_sources(org_id, enabled, credentials_ready);
CREATE INDEX IF NOT EXISTS idx_jobs_org_key ON automation_jobs(org_id, key);
CREATE INDEX IF NOT EXISTS idx_runs_org_started ON discovery_runs(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_autolog_org_res ON automation_logs(org_id, resolution, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_org_created ON ai_model_usage(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_org_kind ON outcome_events(org_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_websites_org_status ON websites(org_id, status);
CREATE INDEX IF NOT EXISTS idx_deploy_org_created ON deployments(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upsell_org_status ON upsell_opportunities(org_id, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_clients_org_status ON clients(org_id, status);
CREATE INDEX IF NOT EXISTS idx_bsrc_biz_field ON business_sources(business_id, field, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_memory_org_biz ON ai_memory(org_id, business_id, superseded_by);
CREATE INDEX IF NOT EXISTS idx_suppression_lookup ON suppression_list(org_id, kind, value);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_org_active ON users(org_id, is_active);
