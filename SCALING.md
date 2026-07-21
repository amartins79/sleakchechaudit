# Scaling Sleak Check Audit

The current `server-mock.js` is correct and safe to run as a **single instance**. It
uses a JSON file for storage, an in-memory rate limiter, and an in-process
job runner (`setInterval`). That's deliberately simple — but it's also the
ceiling. This document is the concrete path to a horizontally-scalable setup.

## The three things that block scaling today

1. **Storage** — `data/db.json` written with `fs.writeFileSync`. Not
   concurrency-safe; two instances would overwrite each other. Leads, jobs
   and processed webhook IDs all live here.
2. **Rate limiting** — `express-rate-limit` defaults to in-memory counters, so
   each instance counts separately (attackers get N× the limit with N instances).
3. **Background jobs** — the delivery/upsell emails run on a per-process
   `setInterval`. With multiple instances every job fires multiple times; with
   zero running instances they don't fire at all.

## Target architecture

```
              ┌─────────────┐
  Browser ──▶ │ Load balancer│──▶ N stateless app instances
              └─────────────┘         │
                     ┌────────────────┼────────────────┐
                     ▼                ▼                ▼
                 Postgres         Redis           Job queue / cron
              (leads, events)  (rate limits)   (scheduled emails)
```

## Migration steps (in priority order)

### 1. Move storage to a database
Replace the `db` object + `saveDb()` with a real database (Postgres via
Supabase/Neon/RDS, or similar). Suggested tables:

- `leads(id, ref UNIQUE, name, email, website, status, session_id, created_at, updated_at)`
- `processed_events(event_id PRIMARY KEY, created_at)` — webhook idempotency
- `jobs(id, type, payload JSONB, run_at, done, created_at)` — or replace with a real queue (below)

Keep the existing function boundaries (`storeLead`, the webhook handler,
`runDueJobs`) and swap their bodies to SQL. The rest of the app won't change.
Set `DATABASE_URL` and the scalability guard in `server-mock.js` goes quiet.

### 2. Shared rate-limit store
Point `express-rate-limit` at a shared store (e.g. `rate-limit-redis`) so the
limit is enforced across all instances.

### 3. Durable background jobs
Replace the `setInterval` runner with one of:
- a hosted queue (BullMQ on Redis, AWS SQS, Cloud Tasks), or
- a scheduled function / cron (Supabase cron, Vercel/Cloud scheduler) that
  polls the `jobs` table for due rows.
This survives restarts and never double-sends.

### 4. Make instances stateless
Once storage, rate limiting and jobs are external, the app holds no local
state and can scale horizontally behind a load balancer. Run the job
worker as its own single process (or a locked cron) so schedules fire once.

### 5. Front it with a CDN
Serve `/public` static assets from a CDN (Cloudflare, CloudFront) so the app
instances only handle the API routes (`/create-checkout-session`, `/lead`,
`/verify-session`, `/webhook`).

## What does NOT need to change
The frontend, the Payment Link flow, webhook signature verification, the CSP
and the email templates are all unaffected — this is purely an
infrastructure/persistence swap behind stable function boundaries.
