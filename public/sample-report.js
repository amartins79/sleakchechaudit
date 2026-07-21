// Wires the "Download / Print PDF" button without an inline handler,
// so a strict Content-Security-Policy doesn't block it.
document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("printBtn");
  if (btn) btn.addEventListener("click", function () { window.print(); });
});
