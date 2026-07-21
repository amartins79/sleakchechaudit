// Guide pages: footer year, reading-progress bar, and TOC scroll-spy.
// External + data-cfasync so a strict CSP / Cloudflare Rocket Loader won't block it.
(function () {
  "use strict";
  var y = document.getElementById("y");
  if (y) y.textContent = new Date().getFullYear();

  var bar = document.getElementById("progressBar");
  var links = [].slice.call(document.querySelectorAll(".toc a"));
  var sections = links.map(function (a) {
    return { link: a, el: document.getElementById(a.getAttribute("href").slice(1)) };
  }).filter(function (s) { return s.el; });

  function onScroll() {
    var top = window.pageYOffset || document.documentElement.scrollTop;
    if (bar) {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? Math.min(100, (top / h) * 100) : 0) + "%";
    }
    var current = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].el.getBoundingClientRect().top <= 130) current = sections[i];
    }
    sections.forEach(function (s) { s.link.classList.toggle("active", s === current); });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScroll();
})();
