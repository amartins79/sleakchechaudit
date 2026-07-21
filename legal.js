// Sets the current year in the footer. External file so a strict
// Content-Security-Policy (script-src 'self') doesn't block it.
document.addEventListener("DOMContentLoaded", function () {
  var y = document.getElementById("y");
  if (y) y.textContent = new Date().getFullYear();
});
