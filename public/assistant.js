// Delta FAB + panel controller — Phase 0/1.
// Mirrors the dashboard's ka-fab pattern:
//   - FAB always visible in bottom-right when panel is closed
//   - Click FAB → panel slides in from the RIGHT (full height)
//   - FAB hides via body.delta-panel-open while panel is open
//   - Esc or click outside closes the panel
// Phase 2+: wire chat to /api/assistant, voice mic, etc.

(() => {
  const fab = document.getElementById("deltaFab");
  const panel = document.getElementById("deltaPanel");
  const closeBtn = panel?.querySelector(".delta-close");

  if (!fab || !panel) return;

  function isOpen() {
    return panel.classList.contains("open");
  }
  function openPanel() {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    fab.classList.add("open");
    document.body.classList.add("delta-panel-open");
    // Move focus into the input for immediate typing.
    const input = panel.querySelector(".delta-input");
    if (input && !input.disabled) setTimeout(() => input.focus(), 80);
  }
  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    fab.classList.remove("open");
    document.body.classList.remove("delta-panel-open");
  }

  fab.addEventListener("click", () => {
    if (isOpen()) closePanel(); else openPanel();
  });
  closeBtn?.addEventListener("click", closePanel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) closePanel();
  });

  // Click outside the panel (but anywhere else on the page) to dismiss.
  document.addEventListener("click", (e) => {
    if (!isOpen()) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    closePanel();
  });
})();
