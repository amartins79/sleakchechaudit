  (function () {
    "use strict";

    /* ============================================================ */
    /* CONFIG — replace these with your live values                */
    /* ============================================================ */
    // ACTIVE payment method: redirect to this hosted Stripe Payment Link.
    var PAYMENT_LINK      = "https://buy.stripe.com/4gMdRa5sL8VUdfR5qefnO02";
    // Backend that stores the lead so the payment webhook can reconcile it.
    var LEAD_ENDPOINT     = "/lead";

    // (Kept for reference / the alternative backend-session flow below.)
    var STRIPE_PUBLIC_KEY = "pk_test_xxx";  // your Stripe publishable key
    var PRICE_ID          = "price_xxx";    // your $300 Price ID
    var CHECKOUT_ENDPOINT = "/create-checkout-session"; // backend (see server-mock.js)
    var SUCCESS_URL       = "success.html"; // page shown after payment

    /* ---- Footer year ---- */
    document.getElementById("year").textContent = new Date().getFullYear();

    /* ---- Sticky header shadow ---- */
    var header = document.getElementById("header");
    var onScroll = function () { header.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    /* ---- Mobile menu ---- */
    var toggle = document.getElementById("navToggle");
    var links  = document.getElementById("navLinks");
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") { links.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    });

    /* ---- FAQ accordion ---- */
    document.querySelectorAll(".faq__q").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var panel = btn.nextElementSibling;
        var isOpen = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", isOpen ? "false" : "true");
        panel.style.maxHeight = isOpen ? null : panel.scrollHeight + "px";
      });
    });

    /* ---- Scroll reveal (progressive enhancement) ----
       Content is visible by default (see CSS). We only switch on the
       fade-in animation once we're sure JS is running, and we guarantee
       everything ends up visible even if something goes wrong. */
    (function () {
      var revealEls = document.querySelectorAll(".reveal");
      if (!revealEls.length) return;
      function revealAll() { revealEls.forEach(function (el) { el.classList.add("in"); }); }
      try {
        if ("IntersectionObserver" in window) {
          document.documentElement.classList.add("js-anim"); // now CSS hides them to animate in
          var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
          }, { threshold: 0.08, rootMargin: "0px 0px -5% 0px" });
          revealEls.forEach(function (el) { io.observe(el); });
          // Failsafe: never leave anything hidden.
          setTimeout(revealAll, 2500);
          window.addEventListener("load", function () { setTimeout(revealAll, 400); });
        } else {
          revealAll();
        }
      } catch (err) {
        document.documentElement.classList.remove("js-anim");
        revealAll();
      }
    })();

    /* ---- Security score gauge (animated when scrolled into view) ---- */
    var SAMPLE_SCORE = 62;                 // example score on the sample report
    var R = 78, CIRC = 2 * Math.PI * R;    // matches r="78" in the SVG
    var gaugeFill = document.getElementById("gaugeFill");
    var gaugeNum  = document.getElementById("gaugeNum");
    gaugeFill.style.strokeDasharray  = CIRC.toFixed(1);
    gaugeFill.style.strokeDashoffset = CIRC.toFixed(1);

    function animateGauge() {
      gaugeFill.style.strokeDashoffset = (CIRC * (1 - SAMPLE_SCORE / 100)).toFixed(1);
      var start = null;
      function tick(t) {
        if (start === null) start = t;
        var p = Math.min((t - start) / 1200, 1);
        gaugeNum.textContent = Math.round(p * SAMPLE_SCORE);
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
    if ("IntersectionObserver" in window) {
      var gIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { animateGauge(); gIo.unobserve(e.target); } });
      }, { threshold: 0.4 });
      gIo.observe(document.querySelector(".score-card"));
    } else {
      gaugeNum.textContent = SAMPLE_SCORE;
      gaugeFill.style.strokeDashoffset = (CIRC * (1 - SAMPLE_SCORE / 100)).toFixed(1);
    }

    /* ============================================================ */
    /* LEAD CAPTURE + VALIDATION + STRIPE CHECKOUT                  */
    /* ============================================================ */
    var form     = document.getElementById("auditForm");
    var statusEl = document.getElementById("formStatus");
    var payBtn   = document.getElementById("payBtn");
    var emailRe  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function validate() {
      var ok = true, firstBad = null;
      var name = form.name, email = form.email, website = form.website;

      function mark(field, bad) {
        field.classList.toggle("invalid", bad);
        field.setAttribute("aria-invalid", bad ? "true" : "false");
        if (bad && !firstBad) firstBad = field;
        if (bad) ok = false;
      }

      mark(name, !name.value.trim());
      mark(email, !emailRe.test(email.value.trim()));
      // Accept a domain with or without protocol; we normalise it below
      mark(website, !/^([a-z]+:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(website.value.trim()));

      if (firstBad) firstBad.focus(); // move keyboard/screen-reader focus to the first error
      return ok;
    }

    function normaliseUrl(u) {
      u = u.trim();
      return /^https?:\/\//i.test(u) ? u : "https://" + u;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // Honeypot: if this hidden field has a value, it's almost certainly a bot.
      // Silently stop (don't tip the bot off that it was detected).
      var hp = document.getElementById("company_url");
      if (hp && hp.value) { return; }

      statusEl.style.color = "var(--red)";
      if (!validate()) { statusEl.textContent = "Please check the highlighted fields."; return; }

      var lead = {
        name:    form.name.value.trim(),
        email:   form.email.value.trim(),
        website: normaliseUrl(form.website.value),
        priceId: PRICE_ID,
        // Reconciliation ID passed to Stripe (alphanumeric/dash/underscore only).
        ref:     "sca_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
        ts:      new Date().toISOString()
      };

      /* 1) Store the lead (simulated CRM). Swap for a POST to your backend. */
      try {
        var leads = JSON.parse(localStorage.getItem("sca_leads") || "[]");
        leads.push(lead);
        localStorage.setItem("sca_leads", JSON.stringify(leads));
      } catch (err) { /* localStorage unavailable — ignore in demo */ }

      /* 2) Feedback + go to checkout */
      statusEl.style.color = "var(--navy)";
      statusEl.textContent = "Saved — taking you to secure checkout…";
      payBtn.disabled = true;
      payBtn.textContent = "Redirecting…";
      startCheckout(lead);
    });

    /* ---- Stripe Payment Link (ACTIVE method) --------------------
       Redirect the customer to the hosted Stripe Payment Link. We prefill
       their email and pass a client_reference_id so the payment can be
       reconciled back to the stored lead via the checkout.session.completed
       webhook. (Stripe silently drops a reference with invalid characters,
       so we use an alphanumeric/dash/underscore id.) */
    function startCheckout(lead) {
      /* Send the lead to the backend first, keyed by the same ref we pass to
         Stripe as client_reference_id. The payment webhook uses that ref to
         recover the name + website (which the Payment Link URL can't carry)
         and then fires the email flow. keepalive lets this request finish
         even as the browser navigates away to Stripe. If the backend isn't
         reachable, we still proceed to payment. */
      try {
        fetch(LEAD_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            name: lead.name, email: lead.email, website: lead.website, ref: lead.ref,
            company_url: (document.getElementById("company_url") || {}).value || ""
          })
        }).catch(function () { /* offline / no backend — continue to payment */ });
      } catch (e) { /* ignore */ }

      var url = PAYMENT_LINK
        + "?prefilled_email=" + encodeURIComponent(lead.email)
        + "&client_reference_id=" + encodeURIComponent(lead.ref);
      window.location.href = url;
    }

    /* ---- ALTERNATIVE: backend Checkout Session (not currently used) ----
       Creates a Session server-side so you can attach full metadata, then
       redirects to the hosted page it returns. See server-mock.js.

       function startCheckout(lead) {
         fetch(CHECKOUT_ENDPOINT, {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({
             priceId: lead.priceId,
             email:   lead.email,
             metadata: { name: lead.name, website: lead.website }
           })
         })
         .then(function (res) { if (!res.ok) throw new Error("backend"); return res.json(); })
         .then(function (data) {
           if (data.url) { window.location.href = data.url; return; }
           if (data.id)  { return Stripe(STRIPE_PUBLIC_KEY).redirectToCheckout({ sessionId: data.id }); }
           throw new Error("no session");
         })
         .catch(function (err) {
           console.warn("Checkout backend not reachable, running demo mode:", err);
           window.location.href = SUCCESS_URL + "?demo=1&email=" + encodeURIComponent(lead.email);
         });
       }
    ----------------------------------------------------------------- */
  })();
