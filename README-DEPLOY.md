# Deploy the Sleak Check Audit backend to Railway

This package runs BOTH the API and the website from one origin (simplest setup —
no CORS, no code changes needed).

## 1. Deploy
Option A - GitHub: push these files to a repo, then in Railway:
  New Project -> Deploy from GitHub repo -> select it.
Option B - CLI:  npm i -g @railway/cli && railway login && railway up

Railway auto-detects Node and runs `npm start` (defined in package.json).

## 2. Add these variables in Railway (Project -> Variables)
NODE_ENV=production
SITE_URL=https://<your-railway-domain>       (change to https://sleakcheckaudit.co.uk once the domain points here)
STRIPE_SECRET_KEY=sk_test_...                (test keys while testing)
STRIPE_WEBHOOK_SECRET=whsec_...              (from step 3)
PRICE_ID=price_1ToMKfJ8EZNHEhcHHM0h7fYb
RESEND_API_KEY=re_...
FROM_EMAIL=support@sleakcheckaudit.co.uk
SUPPORT_EMAIL=support@sleakcheckaudit.co.uk

NOTE: do NOT set PORT - Railway provides it automatically.

## 3. Stripe webhook
Stripe -> Developers -> Webhooks -> Add endpoint
  URL:    https://<your-railway-domain>/webhook
  Event:  checkout.session.completed
Copy the signing secret into STRIPE_WEBHOOK_SECRET, then redeploy.

## 4. Test
Make a test-mode payment. You should see in Railway's logs:
  [lead stored] 1 you@example.com paid
  [email sent] to=support@sleakcheckaudit.co.uk ...
and a real email in your inbox.

## Known limitation
data/db.json is stored on Railway's ephemeral disk and is WIPED on each redeploy,
which loses stored leads and the scheduled 48h/5d emails. Fine for testing.
Before real customers: attach a Railway Volume or move to Postgres (see SCALING.md).
