# ClientForge AI — Production Deployment

## Architecture

```
ClientForge AI
│
├── Web Application      Next.js 15 (App Router, server components + server actions)
├── Database             SQLite via node:sqlite — built into the Node runtime
├── Worker               In-process; job_runs / job_steps / dead_letter tables
├── Scheduler            node-cron, registered via src/instrumentation.ts
├── Forge AI             Router → hosted provider → Ollama → local grounded engine
├── Discovery            OpenStreetMap Overpass (no key) + optional providers
├── Outreach             Local outbox by default; Resend/SendGrid when configured
├── Storage              Local filesystem; concept assets inlined into HTML
├── Website hosting      In-app preview; Cloudflare Pages / Netlify / Vercel when configured
└── Monitoring           /api/health (liveness + readiness) + automation log
```

| Component | Cost | Notes |
|---|---|---|
| Web application | Free tier | Requires a host that keeps a process alive |
| Database | Free | SQLite, no external service |
| Worker + scheduler | Free | In-process |
| Forge AI | Free | Local grounded engine, or Ollama for real inference |
| Discovery | Free | OpenStreetMap Overpass needs no API key |
| Website preview | Free | Served in-app |
| Monitoring | Free | Built-in health endpoints |

**The application runs at zero recurring cost with zero external accounts.**

---

## The one hosting constraint that matters

ClientForge needs a **persistent process** and a **persistent disk**. That rules
out pure serverless:

- SQLite needs a writable filesystem that survives restarts.
- The scheduler is in-process. A host that sleeps between requests will not fire
  the 02:00 job.

**Use a host that keeps a process alive:**

| Host | Free tier | SQLite | Scheduler |
|---|---|---|---|
| Render | Yes (spins down when idle) | Persistent disk on paid; ephemeral on free | Add an external cron |
| Railway | Trial credit | Persistent volume | Native cron |
| Fly.io | Free allowance | Persistent volume | Native cron |
| A small VPS | ~$5/mo | Yes | Native cron |

**If you must use serverless**, separate the two:

```
Web app   → serverless (Vercel / Netlify)
Worker    → a small always-on process running the scheduler
Database  → a hosted SQLite-compatible service (Turso) or PostgreSQL
```

Do not deploy Next.js + SQLite to serverless and assume the scheduler runs. It
will not.

---

## Deploy

```bash
npm ci
npm run typecheck
npm run build
NODE_ENV=production npm run start
```

Or use the gated script, which runs every quality gate first:

```bash
./scripts/deploy.sh staging       # build + verify, no deploy
./scripts/deploy.sh production    # backup + build + verify
./scripts/deploy.sh verify        # post-deploy health + smoke tests
./scripts/deploy.sh rollback      # restore the most recent verified backup
```

`deploy.sh` fails closed: a failed type check, test, secret scan or database
verification aborts the deploy rather than continuing.

---

## Required environment

```bash
OS_MASTER_KEY=$(openssl rand -hex 32)   # REQUIRED in production
NODE_ENV=production
```

`OS_MASTER_KEY` encrypts stored provider credentials at rest. Without it a key
file is generated at `.data/master.key`, which cannot be shared across
instances or restored portably from backup. **Set it before the first deploy.**

Everything else is optional. See `.env.example` for the full list.

---

## Staging

```bash
cp .env.staging.example .env.staging
# fill in, then:
APP_ENV=staging ./scripts/deploy.sh staging
./scripts/deploy.sh verify
```

Staging runs migration, build, authentication, scheduler, discovery, audit,
mockup, tracking, client conversion, project creation, backup and health
checks. Never point staging at production credentials.

---

## Verification before production

```bash
npm run typecheck          # strict TypeScript
npm run build              # production build
node scripts/check-sql.mjs # every INSERT column/value matches
node scripts/check-secrets.mjs
npm run test:unit
npm run test:integration
npm run test:security
npm run test:ssrf
npm run test:tenant
npm run test:automation
npm run e2e                # 200-assertion lifecycle
npm run db:verify          # integrity, constraints, indexes, backup
SMOKE_BASE_URL=https://your-host npm run test:smoke
```

Then confirm manually:

```bash
curl https://your-host/api/health          # must be 200 and "healthy"
curl https://your-host/api/health?live=1   # liveness, no DB access
```

---

## Backups and disaster recovery

Backups are checksummed snapshots written to `.data/backups` with rotation.

```bash
npm run db:backup             # create a verified backup
npm run db:backup -- --list   # list backups
./scripts/deploy.sh rollback  # restore the most recent verified backup
```

To restore manually:

1. Stop the application.
2. Copy the backup over the database file.
3. Confirm `PRAGMA integrity_check` returns `ok`.
4. Restart. The migration rebuilds the FTS index automatically.

**Full recovery requires:** the database backup, your environment variables
(especially `OS_MASTER_KEY` — without it stored credentials cannot be
decrypted), and any external storage.

---

## Scheduler verification

Do not wait until 02:00 to discover a scheduler problem.

```bash
npm run discovery              # run the real production job immediately
npm run discovery -- --offline # skip network steps
```

The startup log confirms registration:

```
[Forge Automation] scheduler running — 6 job(s) registered
[Forge Automation]   daily_discovery    cron="0 2 * * *" next=...
```

Run Now is idempotent: repeated runs create no duplicate businesses, concepts,
outreach, proposals, projects or clients. The schedule stays at 02:00.

---

## Honest status reporting

ClientForge never overclaims. These states are distinct throughout:

| State | Meaning |
|---|---|
| **Simulated** | No provider configured; nothing was actually sent/deployed/paid |
| **Pending** | Awaiting real provider confirmation |
| **Not configured** | No credentials present |
| **Unreachable** | The target could not be reached; no result was fabricated |
| **Unverified** | No verification evidence exists |
| **Live** | A real provider confirmed it |

A deployment is never reported live unless a hosting provider confirmed it. A
payment is never marked paid unless a payment provider confirmed it. A message
is never marked sent unless an email provider confirmed it.
