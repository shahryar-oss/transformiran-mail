// Delta FAB controller — phase 0.
// Matches the dashboard's deltaFab/deltaToggle pattern so shared modules
// (e.g. cmdk.js) can find the same IDs in both products.
//
// Phase 1+: wire chat to /api/assistant, voice mic to /api/transcribe, etc.

(() => {
  const fab = document.getElementById("deltaFab");
  const panel = document.getElementById("deltaPanel");
  const closeBtn = panel?.querySelector(".delta-close");

  if (!fab || !panel) return;

  function openPanel() {
    panel.hidden = false;
    fab.style.display = "none";
  }
  function closePanel() {
    panel.hidden = true;
    fab.style.display = "grid";
  }

  fab.addEventListener("click", openPanel);
  closeBtn?.addEventListener("click", closePanel);

  // Esc to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) closePanel();
  });

  // Click outside the panel to close
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    closePanel();
  });
})();
