#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# ClientForge AI — deployment script (§50)
#
#   ./scripts/deploy.sh staging     deploy to staging
#   ./scripts/deploy.sh production  deploy to production (takes a backup first)
#   ./scripts/deploy.sh verify      post-deploy health check
#   ./scripts/deploy.sh rollback    restore the most recent verified backup
#
# Fails closed: any failed gate aborts the deploy rather than continuing.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

ENVIRONMENT="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
step()  { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
die()   { red "✗ $1"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 {staging|production|verify|rollback}

  staging     Build, verify and deploy to staging
  production  Backup, build, verify and deploy to production
  verify      Run health and smoke checks against a running instance
  rollback    Restore the most recent verified backup
EOF
  exit 1
}

[ -z "$ENVIRONMENT" ] && usage

# ── Environment configuration (§48, §49) ─────────────────────
require_env() {
  local missing=()
  # OS_MASTER_KEY is mandatory outside local development: without it the
  # encryption key is generated per-instance and credentials cannot be shared.
  if [ "$ENVIRONMENT" != "development" ] && [ -z "${OS_MASTER_KEY:-}" ]; then
    missing+=("OS_MASTER_KEY")
  fi
  if [ "$ENVIRONMENT" = "production" ] && [ -z "${NODE_ENV:-}" ]; then
    missing+=("NODE_ENV")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    die "Missing required environment variable(s): ${missing[*]}. See .env.example."
  fi
}

# ── Pre-flight gates ─────────────────────────────────────────
preflight() {
  step "Pre-flight checks"

  command -v node >/dev/null 2>&1 || die "node is not installed"
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] || die "Node 22+ is required (node:sqlite). Found $(node -v)"
  green "  node $(node -v)"

  [ -f .env.example ] || die ".env.example is missing"
  if [ -f .env ]; then
    git check-ignore -q .env || die ".env is present but NOT gitignored"
    green "  .env present and gitignored"
  fi

  if [ -f .data/master.key ] && [ "$ENVIRONMENT" != "development" ]; then
    [ -n "${OS_MASTER_KEY:-}" ] || die "A file-based master key exists but OS_MASTER_KEY is unset. Set OS_MASTER_KEY so credentials survive redeploy."
  fi

  require_env
  green "  environment variables present"
}

# ── Quality gates ────────────────────────────────────────────
quality_gates() {
  step "Quality gates"

  npm run typecheck >/dev/null 2>&1 || die "Type check failed"
  green "  type check passed"

  node scripts/check-sql.mjs >/dev/null 2>&1 || die "SQL integrity check failed"
  green "  SQL integrity passed"

  npm run db:verify >/dev/null 2>&1 || die "Database verification failed"
  green "  database verification passed"

  node scripts/check-secrets.mjs >/dev/null 2>&1 || die "Secret scan failed"
  green "  secret scan passed"

  npm run test:unit >/dev/null 2>&1 || die "Unit tests failed"
  green "  unit tests passed"

  npm run test:integration >/dev/null 2>&1 || die "Integration tests failed"
  green "  integration tests passed"

  npm run test:security >/dev/null 2>&1 || die "Security tests failed"
  green "  security tests passed"

  npm run e2e >/dev/null 2>&1 || die "End-to-end lifecycle test failed"
  green "  end-to-end lifecycle passed"
}

# ── Backup (§44) ─────────────────────────────────────────────
take_backup() {
  step "Backup"
  if [ -f .data/acquisition.db ]; then
    npm run --silent db:backup 2>/dev/null || node -e "
      const { migrate } = require('./src/db/migrate');
      migrate();
      const { createBackup } = require('./src/db/backup');
      const b = createBackup({ trigger: 'pre_deploy' });
      if (!b || b.status !== 'ok') { console.error('backup failed:', b && b.error); process.exit(1); }
      console.log('  backup taken:', b.path, b.size_bytes, 'bytes');
    " || die "Backup failed — refusing to deploy without a restore point"
    green "  backup verified"
  else
    green "  no database yet — nothing to back up"
  fi
}

# ── Build ────────────────────────────────────────────────────
build() {
  step "Build"
  NODE_ENV=production npm run build || die "Production build failed"
  green "  build complete"
}

# ── Migrate ──────────────────────────────────────────────────
apply_migrations() {
  step "Migrations"
  node -e "
    const { migrate } = require('./src/db/migrate');
    const { migrateUp } = require('./src/db/migrations');
    migrate();
    const r = migrateUp({ backup: true });
    console.log('  applied:', r.applied.length ? r.applied.join(', ') : 'nothing pending');
    if (r.errors.length) { console.error('  errors:', r.errors.join('; ')); process.exit(1); }
  " || die "Migration failed"
  green "  migrations applied"
}

# ── Verify (§43) ─────────────────────────────────────────────
verify() {
  step "Verification"
  local base="${SMOKE_BASE_URL:-http://localhost:${PORT:-3000}}"

  local health
  health="$(curl -s -o /dev/null -w '%{http_code}' "$base/api/health?live=1" || echo 000)"
  [ "$health" = "200" ] || die "Liveness check failed (HTTP $health) at $base"
  green "  liveness OK"

  local ready
  ready="$(curl -s -o /dev/null -w '%{http_code}' "$base/api/health" || echo 000)"
  if [ "$ready" = "503" ]; then
    curl -s "$base/api/health" | head -c 800
    die "Readiness check reports unhealthy (HTTP 503)"
  fi
  [ "$ready" = "200" ] || die "Readiness check failed (HTTP $ready)"
  green "  readiness OK"

  SMOKE_BASE_URL="$base" node scripts/smoke.mjs || die "Smoke tests failed"
  green "  smoke tests passed"
}

# ── Rollback (§44) ───────────────────────────────────────────
rollback() {
  step "Rollback"
  node -e "
    const { migrate } = require('./src/db/migrate');
    migrate();
    const { listBackups, restoreBackup } = require('./src/db/backup');
    const backups = listBackups(10).filter(b => b.status === 'ok');
    if (!backups.length) { console.error('no verified backup available'); process.exit(1); }
    const latest = backups[0];
    const r = restoreBackup(latest.id, { force: process.env.FORCE_RESTORE === '1' });
    console.log(r.ok ? '  ' + r.message : '  refused: ' + r.message);
    process.exit(r.ok ? 0 : 1);
  " || die "Rollback failed. Stop the application and retry with FORCE_RESTORE=1."
  green "  rollback complete — restart the application"
}

# ── Main ─────────────────────────────────────────────────────
case "$ENVIRONMENT" in
  staging)
    preflight
    quality_gates
    take_backup
    build
    apply_migrations
    green "\n✓ Staging build ready. Start it with: npm run start"
    ;;
  production)
    preflight
    quality_gates
    take_backup
    build
    apply_migrations
    green "\n✓ Production build ready. Start it with: NODE_ENV=production npm run start"
    green "  then run: $0 verify"
    ;;
  verify)
    verify
    green "\n✓ Deployment verified"
    ;;
  rollback)
    rollback
    ;;
  *)
    usage
    ;;
esac
