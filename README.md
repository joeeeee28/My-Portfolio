# ClientForge AI

**Discover. Personalize. Convert. Deliver.**

ClientForge AI is an autonomous client acquisition and digital agency operating system. It discovers
high-opportunity businesses, understands their digital gaps, creates personalized sales assets, manages
outreach and follow-ups, converts prospects into clients, and manages delivery and growth — from one
platform.

It is not a lead generator, a CRM, a website builder, or an outreach tool. It is the connective layer
between all of them.

---

## The product loop

```
DISCOVER → INTELLIGENCE → ENGAGE → CREATE → CONVERT → DELIVER → GROW → discover more
```

Every screen, every score and every automation step maps to one of these seven pillars.

| Pillar | What happens |
| --- | --- |
| **Discover** | Multi-source business discovery, deduplicated against the Prospect Hub |
| **Intelligence** | Measured website + social audits, competitor comparison, AI research brief |
| **Engage** | Outreach grounded in real findings, multichannel sequences that stop themselves |
| **Create** | Website Concepts built from the prospect's actual record, versioned and tracked |
| **Convert** | Calls, AI briefings, proposals, negotiation |
| **Deliver** | Client conversion, projects, tasks, deployment, client portal |
| **Grow** | Recurring revenue, retention, AI Growth Opportunities |

---

## Running it

```bash
npm install
npm run db:init     # apply schema, register providers, seed defaults
npm run seed        # optional: demo data (clearly flagged, never presented as real)
npm run dev         # http://localhost:3000
```

Other commands:

```bash
npm run discovery             # run the discovery pipeline once
npm run discovery -- --offline  # skip network steps
npm run e2e                   # the 200-assertion lifecycle test
npm run typecheck
npm run build && npm start
```

Stack: Next.js 15 (App Router, Server Components + Server Actions), TypeScript, SQLite via Node's
built-in `node:sqlite` (no native build step), no CSS framework — a hand-written design system.

---

## Architecture

```
src/
  db/            schema.sql (79 relations) + connection layer
  lib/
    providers/   provider abstraction: discovery, enrichment, comms, hosting,
                 payments, social, AI — plug in a new source without touching app code
    ai/          model catalogue, router, local grounded engine, business memory
    audit/       website, social and competitor audits
  engine/        discovery, scoring, nba, outreach, mockup, crm, social,
                 analytics, briefing, queues, command, experiments, compliance
  repo/          business repository + deduplication
  app/           20 pages + public concept preview, client portal, tracking API
```

### Provider abstraction

Every external capability is an interface resolved at runtime. A provider that needs credentials and
has none reports `configured: false` and returns **nothing** — it never fabricates data. OpenStreetMap
Overpass works with no credentials at all; Google Places, SerpApi, OpenCorporates, Yelp, Hunter,
Clearbit, Apollo, Resend, SendGrid, Twilio, Vercel, Netlify, GitHub Pages, Stripe, Buffer and Meta are
implemented against their real APIs and activate the moment a key is stored.

### AI model routing

No task is hard-coded to a model. Each of the 12 task categories (research, scoring, outreach, website
copy, proposals, call summaries, image generation…) is routed at runtime on quality, cost, latency and
measured reliability, with automatic fallback. A local grounded engine is always available so nothing
hard-fails without a key — and it can only work from facts handed to it.

### Honesty rules the code enforces

These are not aspirations; they are asserted by the test suite:

- A website that could not be reached is recorded as `unreachable`, not scored on assumption.
  `verified = 1` only ever means a real HTTP response was inspected.
- An unconfigured hosting provider reports the deployment as `simulated`, never as live.
- An unconfigured payment provider records the invoice as `pending` or `not_configured` — never `paid`.
- Signature and payment status stay `not_configured` until a provider confirms otherwise.
- A business with no review text on record gets a **flagged placeholder**, not an invented quote.
- Missing facts are listed under "Not established from available data" rather than guessed.
- A competitor comparison requires both sides to have been measured by us.

---

## What the test suite proves

`npm run e2e` walks one prospect through the entire lifecycle against an isolated database and asserts
at every stage — **200 assertions**:

```
Daily Job → Discovery → Deduplication → Enrichment → Website Verification → Digital Audit
→ Social Audit → Competitor Research → Opportunity Score → Qualification → Recommended Service
→ Business Intelligence → Personalized Outreach → Sequence → Response → Website Concept
→ Concept Versioning → Sharing → View Tracking → Call Scheduling → Call Notes → AI Requirements
→ Proposal → Won → Client Conversion → Project Creation → Website Delivery → Social Management
→ Hosting → Recurring Revenue → Growth Opportunity
```

It also verifies the invariants that matter most:

- **No duplicate client on conversion** — `clients.business_id` is UNIQUE, and the test attempts a
  second insert to prove the constraint fires.
- **Sequences stop themselves** on reply, opt-out, conversion, and explicit disinterest.
- **Opt-out cannot be weakened** — a later address-level suppression can't downgrade a business-level
  do-not-contact.
- **Secrets are encrypted at rest** — the test asserts the plaintext is absent from the stored blob and
  only `last4` is exposed.
- **Quiet hours defer sends** without blocking drafts or enrolment.
- **Concept versioning never destroys history** — rollback creates a new version.
- **The funnel is monotonic** — it counts cumulative pipeline reach, so it can't claim more concepts
  than replies.
- **Bulk generation is proposed, not executed** — every externally-consequential action requires
  explicit authorisation.

---

## Terminology

| Generic | ClientForge |
| --- | --- |
| Lead | Prospect |
| Lead Score | Opportunity Score |
| Lead Database | Prospect Hub |
| Lead Research | Business Intelligence |
| CRM Record | Business Workspace |
| Email Campaign | Outreach Sequence |
| Website Demo | Website Concept |
| CRM Pipeline | Client Pipeline |
| Automation | Forge Automation |
| AI Assistant | Forge AI |
| Task Queue | Action Queue |
| Upsell | Growth Opportunity |

---

## The Opportunity Score

Eight weighted factors, configurable in Settings, always explained:

```
Website Opportunity  25%   Social Opportunity  20%   Business Quality  15%
Digital Gap          15%   Growth Signals      10%   Contactability     5%
Competitive Gap       5%   Service Fit          5%
```

Every score ships with its arithmetic and the evidence behind each factor. Custom rules can be added in
plain language, and Forge AI proposes weight changes from realised outcomes — but never applies them
without your approval.

---

## Forge AI

The global assistant understands the whole lifecycle. Read-only questions answer immediately. Anything
with an external consequence comes back as a **proposed action** with a confirmation prompt.

> "Find my best opportunities." · "What should I work on today?" · "Who viewed their concept?"
> "Which prospects should I follow up with?" · "Prepare me for today's calls."
> "Which clients have growth opportunities?"

---

## Compliance

Built in, not bolted on: suppression list (email, phone, domain, business), consent records, quiet
hours, daily and per-domain send limits, duplicate protection, unsubscribe links, opt-out handling that
hard-stops every sequence and follow-up, configurable retention, data deletion, and an audit log over
sensitive operations.

The system is designed so it *cannot* be used for indiscriminate mass outreach.

---

## Notes

- Demo data is flagged `is_demo = 1` and labelled in the UI. It is never presented as real discovery.
- Multi-tenant isolation is real: every query filters by `org_id`. The single-owner bootstrap exists so
  the product is usable immediately; adding login means issuing sessions against the same tables.
- The service catalogue is deliberately service-agnostic. Website Development and Social Media
  Management are the current focus; SEO, ads, branding, automation, custom software and more can be
  added without architectural change.
