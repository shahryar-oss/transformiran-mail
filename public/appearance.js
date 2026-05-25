// Appearance boot — every page loads this and immediately applies the
// user's saved theme / accent / density / font-size preferences by
// flipping data-attributes on <body>. The CSS in styles.css then
// re-paints with the matching tokens.
//
// Defaults in CSS already match Sunset / Comfortable / Default so the
// page renders sanely BEFORE the API responds — meaning there's no
// blank flash. Switching themes mid-render causes one quick repaint;
// that's acceptable for a settings change.
//
// Other pages can call window.applyAppearance(prefs) directly when
// the user picks a setting (e.g. clicking a theme chip on the
// settings page applies live, then saves on click of "Save").
//
// Adaptive accent — when localStorage.nexaMail.adaptiveAccent === "1",
// the accent shifts through the day:
//   06:00–11:00 → Sunset (warm morning)
//   11:00–18:00 → user's saved accent
//   18:00–06:00 → Glacier (cool evening/night)
// Theme + density + font size are NOT shifted — only the accent.
(function () {
  const ADAPTIVE_KEY = "nexaMail.adaptiveAccent";

  function isAdaptiveOn() {
    try { return localStorage.getItem(ADAPTIVE_KEY) === "1"; } catch (_) { return false; }
  }

  function timeWindowAccent(savedAccent) {
    const h = new Date().getHours();
    if (h >= 6 && h < 11) return "sunset";
    if (h >= 18 || h < 6) return "glacier";
    return savedAccent || "sunset";
  }

  function apply(prefs) {
    if (!prefs) return;
    const b = document.body;
    if (prefs.theme)        b.setAttribute("data-theme",        prefs.theme);
    if (prefs.density)      b.setAttribute("data-density",      prefs.density);
    if (prefs.bodyFontSize) b.setAttribute("data-body-font-size", prefs.bodyFontSize);
    // Accent — adaptive override or the saved value.
    if (prefs.accent) {
      const accent = isAdaptiveOn() ? timeWindowAccent(prefs.accent) : prefs.accent;
      b.setAttribute("data-accent", accent);
    }
  }
  window.applyAppearance = apply;

  let _lastPrefs = null;
  fetch("/api/me/appearance-prefs", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { _lastPrefs = d && d.settings; apply(_lastPrefs); })
    .catch(() => {});

  // Re-evaluate adaptive accent every 15 min so the shift happens
  // without a page reload.
  setInterval(() => { if (isAdaptiveOn() && _lastPrefs) apply(_lastPrefs); }, 15 * 60 * 1000);
})();
