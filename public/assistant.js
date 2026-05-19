// Delta FAB controller — Phase 0.
// Matches the dashboard's ka-fab pattern: button shows logo by default,
// flips to ✕ when panel is open. Body class hides the FAB while open.
// Phase 1+: wire chat to /api/assistant, voice mic to /api/transcribe.

(() => {
  const fab = document.getElementById("deltaFab");
  const panel = document.getElementById("deltaPanel");
  const closeBtn = panel?.querySelector(".delta-close");

  if (!fab || !panel) return;

  function openPanel() {
    panel.hidden = false;
    fab.classList.add("open");
    document.body.classList.add("delta-panel-open");
  }
  function closePanel() {
    panel.hidden = true;
    fab.classList.remove("open");
    document.body.classList.remove("delta-panel-open");
  }

  fab.addEventListener("click", () => {
    if (panel.hidden) openPanel(); else closePanel();
  });
  closeBtn?.addEventListener("click", closePanel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) closePanel();
  });

  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    closePanel();
  });
})();
