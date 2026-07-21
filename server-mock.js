/* ============================================================================
 * Sleak Check Audit — Backend  (Node.js + Express + Stripe)
 * ----------------------------------------------------------------------------
 * Hardened starting point. Implements:
 *   • Verified Stripe webhooks (raw body + signature) with idempotency
 *   • Server-authoritative pricing (client price is ignored)
 *   • Input validation, sanitisation, body-size limits and rate limiting
 *   • File-backed persistence + a durable job runner (survives restarts)
 *   • helmet security headers, locked-down CORS, HTTPS redirect (prod)
 *   • Static files served from ./public only (server source is never exposed)
 *
 * Install:
 *   npm install            # uses package.json
 *
 * Run (demo — no Stripe needed):
 *   node server-mock.js
 *
 * Run (live):
 *   export NODE_ENV=production
 *   export SITE_URL=https://sleakcheckaudit.co.uk
 *   export ALLOWED_ORIGIN=https://sleakcheckaudit.co.uk
 *   export STRIPE_SECRET_KEY=sk_live_xxx
 *   export STRIPE_WEBHOOK_SECRET=whsec_xxx
 *   export PRICE_ID=price_xxx              # your $300 price, set server-side
 *   export RESEND_API_KEY=...              # real emails; omit to simulate to console
 *   node server-mock.js
 *
 * Replace sendEmail() with a real provider and (ideally) the file store with a
 * proper database (Postgres/Supabase) and the job runner with a real queue.
 * ==========================================================================*/

"use strict";

const fs      = require("fs");
const path    = require("path");
const express = require("express");
const helmet  = require("helmet");
const cors    = require("cors");
const rateLimit = require("express-rate-limit");

/* ----------------------------------------------------------------------------
 * CONFIG (all overridable via environment variables)
 * --------------------------------------------------------------------------*/
const NODE_ENV     = process.env.NODE_ENV || "development";
const IS_PROD      = NODE_ENV === "production";
const PORT         = process.env.PORT || 4242;
const SITE_URL     = process.env.SITE_URL || ("http://localhost:" + PORT);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;

const FROM_EMAIL    = process.env.FROM_EMAIL    || "support@sleakcheckaudit.co.uk";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@sleakcheckaudit.co.uk";

// (2) Price is fixed SERVER-SIDE. Whatever the browser sends is ignored.
const PRICE_ID = process.env.PRICE_ID || "price_xxx";

const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe is optional in demo mode; only initialised when a key is present.
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;
const DEMO = !stripe; // true when no Stripe key → safe local demo behaviour

// Fail fast in production if critical secrets are missing.
if (IS_PROD) {
  var missing = [];
  if (!STRIPE_SECRET_KEY)     missing.push("STRIPE_SECRET_KEY");
  if (!STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!PRICE_ID || PRICE_ID === "price_xxx") missing.push("PRICE_ID");
  if (missing.length) {
    console.error("Refusing to start in production. Missing config:", missing.join(", "));
    process.exit(1);
  }
}

/* ----------------------------------------------------------------------------
 * (4) PERSISTENCE — small file-backed store so leads and scheduled emails
 *     survive a restart. Swap for Postgres/Supabase as you grow.
 * --------------------------------------------------------------------------*/
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE  = path.join(DATA_DIR, "db.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { leads: [], jobs: [], processedEvents: [] };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
catch (e) { console.error("Could not read db.json, starting fresh:", e.message); }

// SCALABILITY GUARD: the JSON file store, in-memory rate limiter and in-process
// job runner are single-instance only. Running more than one copy will corrupt
// data and double-send emails. See SCALING.md for the migration path
// (Postgres + a shared rate-limit store + a hosted queue).
if (IS_PROD && Number(process.env.WEB_CONCURRENCY || 1) > 1 && !process.env.DATABASE_URL) {
  console.warn("[scale] WARNING: multiple instances with the file store is unsafe. See SCALING.md.");
}

function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error("Failed to persist db.json:", e.message); }
}

/* ----------------------------------------------------------------------------
 * APP + SECURITY MIDDLEWARE  (5)
 * --------------------------------------------------------------------------*/
const app = express();
app.set("trust proxy", 1); // behind a load balancer / proxy (Heroku, Render, etc.)

// Force HTTPS in production.
if (IS_PROD) {
  app.use(function (req, res, next) {
    if (req.secure || req.headers["x-forwarded-proto"] === "https") return next();
    return res.redirect(308, "https://" + req.headers.host + req.originalUrl);
  });
}

// Security headers, including a CSP scoped to exactly what the pages need
// (Google Fonts + Stripe.js). Note: the audit you sell checks for these —
// now your own server sets them too.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src":  ["'self'", "https://www.googletagmanager.com", "'sha256-elPTm4AShjfxSu1BPbC3GMm2FGHhFfhZF2/1By+TOTQ='"],
      "style-src":   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src":    ["'self'", "https://fonts.gstatic.com"],
      "img-src":     ["'self'", "data:", "https://www.googletagmanager.com", "https://www.google-analytics.com"],
      "connect-src": ["'self'", "https://www.google-analytics.com", "https://www.googletagmanager.com", "https://region1.google-analytics.com"],
      "frame-src":   ["'none'"],
      "object-src":  ["'none'"],
      "base-uri":    ["'self'"],
      "form-action": ["'self'"]
    }
  },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

// Lock API access to your own origin.
app.use(cors({ origin: ALLOWED_ORIGIN }));

/* ----------------------------------------------------------------------------
 * (1) STRIPE WEBHOOK — must come BEFORE express.json and use the RAW body so
 *     the signature can be verified. Unverified events are rejected.
 * --------------------------------------------------------------------------*/
app.post("/webhook", express.raw({ type: "application/json" }), function (req, res) {
  let event;

  if (stripe && STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers["stripe-signature"];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn("Rejected webhook (bad signature):", err.message);
      return res.status(400).send("Webhook signature verification failed.");
    }
  } else {
    // Demo only: no signing secret configured.
    try { event = JSON.parse(req.body.toString("utf8")); }
    catch (e) { return res.status(400).send("Bad payload."); }
  }

  // Idempotency: Stripe retries events; never process the same one twice.
  if (event.id && db.processedEvents.includes(event.id)) {
    return res.json({ received: true, duplicate: true });
  }
  if (event.id) { db.processedEvents.push(event.id); saveDb(); }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object || {};
    const md = session.metadata || {};

    // Payment Links can't carry name/website in the URL — only the email and
    // the client_reference_id. So we look up the lead the browser stored just
    // before redirecting (keyed by that same reference) and merge the two.
    const ref = session.client_reference_id || md.ref || null;
    const prior = ref ? db.leads.find(function (l) { return l.ref === ref; }) : null;

    const lead = {
      ref:     ref,
      name:    (prior && prior.name)    || md.name,
      email:   session.customer_email ||
               (session.customer_details && session.customer_details.email) ||
               (prior && prior.email)   || md.email,
      website: (prior && prior.website) || md.website,
      status:  "paid",
      sessionId: session.id
    };

    const record = storeLead(lead); // upserts onto the prior lead via ref
    notifySupport(record);          // tell support we have a paying customer
    runEmailFlow(record);           // confirmation + delivery + upsell
  }

  res.json({ received: true });
});

// JSON parser (size-limited) for the remaining routes.
app.use(express.json({ limit: "10kb" }));

/* ----------------------------------------------------------------------------
 * (3) VALIDATION + SANITISATION HELPERS
 * --------------------------------------------------------------------------*/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Strip control chars / newlines and cap length — prevents header & content
// injection when these values are placed into emails.
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, max || 200);
}
function isEmail(v) { return typeof v === "string" && EMAIL_RE.test(v.trim()) && v.length <= 254; }
function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; }
  catch (e) { return false; }
}

// Rate limit the public endpoints (per IP).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                  // 20 requests / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." }
});

/* ----------------------------------------------------------------------------
 * CREATE CHECKOUT SESSION  (server-authoritative price)
 * --------------------------------------------------------------------------*/
app.post("/create-checkout-session", apiLimiter, async function (req, res) {
  try {
    const email   = clean(req.body && req.body.email, 254);
    const md      = (req.body && req.body.metadata) || {};
    const name    = clean(md.name, 120);
    const website = clean(md.website, 300);

    if (!isEmail(email))       return res.status(400).json({ error: "A valid email is required." });
    if (website && !isHttpUrl(website))
      return res.status(400).json({ error: "Website must be a valid http(s) URL." });

    if (DEMO) {
      // No Stripe configured → record the lead and send to the demo success page.
      storeLead({ name, email, website, status: "checkout_started" });
      return res.json({ url: SITE_URL + "/success.html?demo=1&email=" + encodeURIComponent(email) });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: PRICE_ID, quantity: 1 }], // ← fixed server-side
      customer_email: email,
      metadata: { name: name, website: website },
      success_url: SITE_URL + "/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:  SITE_URL + "/index.html#pricing"
    });

    storeLead({ name, email, website, status: "checkout_started", sessionId: session.id });
    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err.message);
    return res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
});

/* ----------------------------------------------------------------------------
 * VERIFY SESSION — used by success.html so the confirmation can't be spoofed
 * by simply visiting the URL. Confirms payment_status with Stripe.
 * --------------------------------------------------------------------------*/
app.get("/verify-session", apiLimiter, async function (req, res) {
  const sessionId = clean(req.query && req.query.session_id, 120);
  if (!sessionId) return res.status(400).json({ error: "Missing session_id." });

  if (DEMO) return res.json({ paid: true, demo: true });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session && session.payment_status === "paid";
    return res.json({
      paid: paid,
      email: paid ? (session.customer_email || (session.customer_details && session.customer_details.email)) : null
    });
  } catch (err) {
    console.warn("verify-session error:", err.message);
    return res.status(404).json({ paid: false });
  }
});

/* ----------------------------------------------------------------------------
 * STORE A LEAD — the page calls this just before redirecting to the Payment
 * Link, so the webhook can later match the payment (by ref) and recover the
 * name + website. No emails are sent here; the support notification and the
 * customer email flow fire on payment, in the webhook above.
 * --------------------------------------------------------------------------*/
app.post("/lead", apiLimiter, function (req, res) {
  // Honeypot: bots fill this hidden field. Pretend success, store nothing.
  if (req.body && req.body.company_url) { return res.json({ ok: true }); }

  const name    = clean(req.body && req.body.name, 120);
  const email   = clean(req.body && req.body.email, 254);
  const website = clean(req.body && req.body.website, 300);
  const ref     = clean(req.body && req.body.ref, 200);

  if (!name)               return res.status(400).json({ error: "Name is required." });
  if (!isEmail(email))     return res.status(400).json({ error: "A valid email is required." });
  if (!isHttpUrl(website)) return res.status(400).json({ error: "A valid website URL is required." });
  // Stripe requires client_reference_id to be alphanumeric/dash/underscore.
  if (ref && !/^[A-Za-z0-9_-]+$/.test(ref))
    return res.status(400).json({ error: "Invalid reference." });

  storeLead({ name, email, website, ref, status: "checkout_started" });
  res.json({ ok: true });
});

function storeLead(lead) {
  // Upsert: if a lead with this ref already exists (stored pre-payment),
  // merge onto it instead of creating a duplicate.
  let record = lead.ref ? db.leads.find(function (l) { return l.ref === lead.ref; }) : null;
  if (record) {
    Object.assign(record, lead);
    record.updatedAt = new Date().toISOString();
  } else {
    record = Object.assign({ id: db.leads.length + 1, createdAt: new Date().toISOString() }, lead);
    db.leads.push(record);
  }
  saveDb();
  console.log("[lead stored]", record.id, record.email, record.status);
  return record;
}

// Forward a paying client's request to your inbox.
function notifySupport(record) {
  sendEmail(SUPPORT_EMAIL, "New audit request — " + (record.website || record.email), [
    "A new client request just came in:",
    "",
    "  Name:    " + (record.name || "(not provided)"),
    "  Email:   " + record.email,
    "  Website: " + (record.website || "(not provided)"),
    "  Status:  " + record.status,
    "  Ref:     " + (record.ref || "(none)"),
    "  Time:    " + (record.updatedAt || record.createdAt)
  ].join("\n"));
}

/* ----------------------------------------------------------------------------
 * EMAIL AUTOMATION FLOW
 *   Email 1 → now (confirmation)
 *   Email 2 → +48h (delivery)     persisted job, survives restart
 *   Email 3 → +5d  (upsell)       persisted job, survives restart
 * --------------------------------------------------------------------------*/
function runEmailFlow(lead) {
  const first = (lead.name || "there").split(" ")[0];
  const website = lead.website || "your website";

  // Email 1 — Confirmation (immediate)
  sendEmail(lead.email, "We've received your audit request \u2705",
"Hi " + first + ",\n\n" +
"Thanks for ordering your Website Security & Privacy Audit for " + website + ".\n" +
"Payment received \u2014 nothing more is needed from you right now.\n\n" +
"What happens next:\n" +
"\u2022 Our team begins your audit straight away.\n" +
"\u2022 You'll receive your full report within 24\u201348 hours.\n" +
"\u2022 It includes a plain-English summary, a security score, and a developer fix checklist.\n\n" +
"If you have any questions, just reply to this email.\n\n" +
"\u2014 The Sleak Check Audit team");

  // Email 2 — Delivery (+48h)
  scheduleJob(48 * 60 * 60 * 1000, "delivery", { email: lead.email, first: first, website: website });

  // Email 3 — Upsell (+5 days)
  scheduleJob(5 * 24 * 60 * 60 * 1000, "upsell", { email: lead.email, first: first, website: website });
}

// Job handlers, keyed by type, called by the runner below.
const JOB_HANDLERS = {
  delivery: function (p) {
    sendEmail(p.email, "Your security audit for " + p.website + " is ready \uD83D\uDCC4",
"Hi " + p.first + ",\n\n" +
"Your Website Security & Privacy Audit is complete. Your report is attached as a PDF.\n\n" +
"Inside you'll find:\n" +
"\u2022 Your overall security score (0\u2013100)\n" +
"\u2022 Each issue explained in plain English, with severity\n" +
"\u2022 A privacy & GDPR risk check\n" +
"\u2022 A prioritised fix checklist to hand to your developer\n\n" +
"Start with the items marked \"High\" \u2014 they give you the biggest risk reduction fastest.\n" +
"Happy to walk you through anything; just reply.\n\n" +
"\u2014 The Sleak Check Audit team");
  },
  upsell: function (p) {
    sendEmail(p.email, "Want to stay protected after the fixes?",
"Hi " + p.first + ",\n\n" +
"Hope the audit was useful. Security isn't a one-off \u2014 sites drift back into risk as\n" +
"plugins, scripts and code change.\n\n" +
"Two ways we can help keep " + p.website + " safe:\n" +
"\u2022 Monthly Monitoring (\u00A319/mo): we re-scan monthly and alert you to new issues.\n" +
"\u2022 Premium Audit (\u00A3199): deeper testing, a re-scan after your fixes, and a 30-min call.\n\n" +
"Reply \"monitoring\" or \"premium\" and we'll set you up. No pressure either way.\n\n" +
"\u2014 The Sleak Check Audit team");
  }
};

/* ----------------------------------------------------------------------------
 * (4) DURABLE JOB RUNNER — jobs are persisted and a sweeper runs due ones.
 *     Unlike setTimeout, pending jobs survive a server restart.
 *     For real scale, replace with BullMQ / Cloud Tasks / Supabase cron.
 * --------------------------------------------------------------------------*/
function scheduleJob(delayMs, type, payload) {
  db.jobs.push({
    id: "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    type: type, payload: payload,
    runAt: Date.now() + delayMs, done: false
  });
  saveDb();
}

function runDueJobs() {
  const now = Date.now();
  let changed = false;
  db.jobs.forEach(function (job) {
    if (job.done || job.runAt > now) return;
    try {
      const handler = JOB_HANDLERS[job.type];
      if (handler) handler(job.payload);
      job.done = true; changed = true;
    } catch (e) {
      console.error("Job failed (" + job.type + "):", e.message);
    }
  });
  // Drop completed jobs older than 7 days to keep the file small.
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const before = db.jobs.length;
  db.jobs = db.jobs.filter(function (j) { return !(j.done && j.runAt < cutoff); });
  if (changed || db.jobs.length !== before) saveDb();
}
setInterval(runDueJobs, 30 * 1000); // sweep every 30s
runDueJobs();                        // catch up on overdue jobs at boot

/* ----------------------------------------------------------------------------
 * EMAIL SENDER
 * Sends for real via Resend when RESEND_API_KEY is set; otherwise logs to the
 * console exactly as before (so local testing needs no account or keys).
 * Uses the built-in fetch (Node 18+), so no extra dependency is required.
 * --------------------------------------------------------------------------*/
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function sendEmail(to, subject, body) {
  // No key configured -> simulate (previous behaviour, useful for local tests).
  if (!RESEND_API_KEY) {
    console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u2709\uFE0F  EMAIL (simulated) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    console.log("From:    ", FROM_EMAIL);
    console.log("To:      ", to);
    console.log("Subject: ", subject);
    console.log(String(body).trim());
    console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
    return Promise.resolve({ simulated: true });
  }

  // Real send via the Resend HTTP API.
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: subject,
      text: String(body).trim()
    })
  })
    .then(function (res) {
      return res.text().then(function (t) {
        if (!res.ok) throw new Error("Resend " + res.status + ": " + t);
        console.log("[email sent] to=" + to + " subject=" + JSON.stringify(subject));
        return { sent: true };
      });
    })
    .catch(function (err) {
      // Never let an email failure crash a webhook or checkout response.
      console.error("[email FAILED] to=" + to + " -> " + err.message);
      return { error: err.message };
    });
}

/* ----------------------------------------------------------------------------
 * STATIC SITE — serve ONLY ./public. The server source and ./data are never
 * exposed. (Previously serving "." leaked server-mock.js and any .env.)
 * --------------------------------------------------------------------------*/
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.listen(PORT, function () {
  console.log("Sleak Check Audit server \u2192 " + SITE_URL + (DEMO ? "  (DEMO mode: no Stripe key)" : ""));
});
