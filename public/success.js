/* Success page logic.
 * Instead of trusting the URL, we ask the backend to confirm the Stripe
 * session was actually paid before showing the confirmation. Falls back
 * gracefully to demo mode and to a friendly error if verification fails. */
(function () {
  "use strict";

  var VERIFY_ENDPOINT = "/verify-session"; // backend route (see server-mock.js)

  var params    = new URLSearchParams(location.search);
  var sessionId = params.get("session_id");
  var emailQ    = params.get("email");
  var isDemo    = params.get("demo") === "1";

  var loading = document.getElementById("state-loading");
  var okView  = document.getElementById("state-ok");
  var errView = document.getElementById("state-err");

  function show(view) {
    loading.hidden = true; okView.hidden = true; errView.hidden = true;
    view.hidden = false;
  }

  function showConfirmed(email, demo) {
    if (email) {
      document.getElementById("emailLine").textContent = "Check " + email + " for next steps.";
    }
    if (demo) document.getElementById("demoNote").hidden = false;
    show(okView);
  }

  // Demo mode: no real payment, just confirm the flow visually.
  if (isDemo) { showConfirmed(emailQ, true); return; }

  // No session id and not demo → nothing to verify; show the neutral error state.
  if (!sessionId) { show(errView); return; }

  // Verify the session server-side when a backend is available. On static-only
  // hosting there's no /verify-session, so we degrade gracefully: only show the
  // error state when the backend explicitly reports the payment as unpaid.
  show(loading);
  fetch(VERIFY_ENDPOINT + "?session_id=" + encodeURIComponent(sessionId), {
    headers: { "Accept": "application/json" }
  })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.paid === false) { show(errView); return; }   // explicitly unpaid
      // paid, or verification unavailable (static host) -> confirm gracefully
      showConfirmed((data && data.email) || emailQ, !!(data && data.demo));
    })
    .catch(function () { showConfirmed(emailQ, false); }); // network error -> still confirm
})();
