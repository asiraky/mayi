/*
 * Theme resolution, shared by the marketing site, the docs and the app.
 *
 * This file is loaded as a BLOCKING script in <head>, before any markup is parsed, so
 * the `dark` class is on <html> by the time the first pixel is painted. Deferring it
 * (or inlining it as a module) reintroduces the white flash on a dark-mode load.
 *
 * It is a separate file rather than an inline <script> because the deployed CSP is
 * `default-src 'self'` with no 'unsafe-inline' — an inline script is blocked outright.
 * See apps/site/public/_headers, and the assetsInlineLimit note in astro.config.mjs.
 *
 * Written as an IIFE in plain ES5 with no imports: it must run in one pass, with no
 * module graph to resolve first.
 */
(function () {
  var STORAGE_KEY = "mayi-theme";
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function stored() {
    // Private browsing and blocked-storage contexts throw on access rather than
    // returning null, so a failed read has to degrade to "no preference".
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return value === "dark" || value === "light" ? value : null;
    } catch {
      return null;
    }
  }

  function resolve() {
    return stored() || (media.matches ? "dark" : "light");
  }

  function apply(theme) {
    var root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;

    // Keeps the browser chrome (mobile address bar) in step with the page.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#121514" : "#ecedeb");

    // Lets the toggle render the correct icon without re-reading storage.
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(theme === "dark"));
    });
  }

  apply(resolve());

  // Only tracks the OS while the visitor has not made an explicit choice; once they
  // have, their choice outranks the system for good.
  media.addEventListener("change", function () {
    if (!stored()) apply(resolve());
  });

  // The toggle buttons do not exist yet at <head> time, so wiring waits for the DOM.
  // Delegated from the document so it survives any markup that swaps buttons later.
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-theme-toggle]");
    if (!button) return;
    var next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the toggle still works for this page view, it just
      // will not survive navigation. Better than throwing away the click.
    }
    apply(next);
  });
})();
