// =============================================================
// CROSS-PAGE GLOBAL KEYBOARD SHORTCUTS
// Loaded on every authed page (inbox / calendar / tasks /
// contacts / settings) so the same nav hotkeys work everywhere.
// Per-page action shortcuts (j/k/r/e/etc.) stay in their own
// page script — this module only handles navigation, search,
// compose, and the help overlay.
//
// Sequence pattern: "g + X" — press G, then within 1.2 s press
// the second key. Matches Gmail / Linear convention. Single-key
// actions ("/", "?", "c") fire immediately.
//
// Per-user remapping: window.NexaShortcutOverride(label) returns
// the user's custom binding for an action, falling back to the
// default key here. Same contract as inbox.js installGlobalShortcuts.
// =============================================================
(function installCrossPageShortcuts() {
  if (window.__nexaCrossPageShortcutsInstalled) return;
  window.__nexaCrossPageShortcutsInstalled = true;

  // Single-key actions and the g-prefix navigation set.
  // Pages override default targets by populating window.NexaPageActions
  // before this script loads (e.g. inbox.html has its own "/" handler).
  const PAGE = (location.pathname.split("/").filter(Boolean)[0] || "inbox").toLowerCase();

  function go(path) {
    if (location.pathname.startsWith(path)) return;
    location.href = path;
  }
  function focusSearchOnPage() {
    // Each page exposes its search input via a stable selector.
    const sel = document.querySelector(
      ".search-input, #searchInput, #ct-search, #cal-search, #tasks-search"
    );
    if (sel) {
      sel.focus();
      try { sel.select?.(); } catch (_) {}
      return true;
    }
    return false;
  }
  function openComposeOrGoInbox() {
    // If the page has a compose button (inbox), click it. Otherwise,
    // navigate to inbox and trigger compose via hash.
    const btn = document.getElementById("composeBtn");
    if (btn) { btn.click(); return; }
    location.href = "/inbox#compose";
  }

  // Two-key (g-prefix) actions:
  const G_ACTIONS = {
    "Go to Inbox":    { key: "i", fn: () => go("/inbox") },
    "Go to Calendar": { key: "c", fn: () => go("/calendar") },
    "Go to Tasks":    { key: "t", fn: () => go("/tasks") },
    "Go to Contacts": { key: "n", fn: () => go("/contacts") },
    "Go to Settings": { key: "s", fn: () => go("/settings") },
  };
  // Single-key actions that work on every page (when not typing):
  const SINGLE_ACTIONS = {
    "Search":  { key: "/", fn: () => focusSearchOnPage() },
    "Compose": { key: "c", fn: () => openComposeOrGoInbox() },
    "Show shortcuts": { key: "?", fn: () => toggleCheatSheet() },
  };

  // -------- Cheat-sheet overlay (lazy DOM) -----------------
  let cheatSheetEl = null;
  function buildCheatSheet() {
    const el = document.createElement("div");
    el.id = "nexaShortcutCheatSheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Keyboard shortcuts");
    el.style.cssText = [
      "position:fixed", "inset:0",
      "background:rgba(15,18,26,.55)",
      "z-index:99999",
      "display:flex", "align-items:center", "justify-content:center",
      "font-family:inherit"
    ].join(";");
    const inner = document.createElement("div");
    inner.style.cssText = [
      "background:var(--paper, #fff)",
      "color:var(--ink, #222)",
      "border-radius:16px",
      "box-shadow:0 24px 80px rgba(0,0,0,.35)",
      "max-width:560px", "width:calc(100% - 40px)",
      "max-height:80vh", "overflow:auto",
      "padding:22px 24px"
    ].join(";");
    inner.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <h3 style="margin:0;font-size:16px;letter-spacing:.2px;">Keyboard shortcuts</h3>
        <button id="nexaCsClose" aria-label="Close" style="background:none;border:0;font-size:20px;line-height:1;cursor:pointer;color:var(--ink-soft,#666);">×</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px 28px;font-size:13px;">
        <div>
          <h4 style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--ink-soft,#777);">Navigate</h4>
          <ul id="nexaCsGroupNav" style="list-style:none;padding:0;margin:0;display:grid;gap:6px;"></ul>
        </div>
        <div>
          <h4 style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--ink-soft,#777);">Anywhere</h4>
          <ul id="nexaCsGroupAny" style="list-style:none;padding:0;margin:0;display:grid;gap:6px;"></ul>
        </div>
        <div id="nexaCsPageBlock" style="grid-column:1 / -1;display:none;">
          <h4 style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--ink-soft,#777);">This page</h4>
          <ul id="nexaCsGroupPage" style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:6px 28px;"></ul>
        </div>
      </div>
      <p style="margin:18px 0 0;font-size:11px;color:var(--ink-soft,#888);">
        Customize any of these in <a href="/settings#shortcuts" style="color:inherit;text-decoration:underline;">Settings → Shortcuts</a>.
      </p>
    `;
    el.appendChild(inner);
    el.addEventListener("click", (e) => { if (e.target === el) closeCheatSheet(); });
    inner.querySelector("#nexaCsClose").addEventListener("click", closeCheatSheet);
    return el;
  }
  function renderCheatSheetRows() {
    const navList = cheatSheetEl.querySelector("#nexaCsGroupNav");
    const anyList = cheatSheetEl.querySelector("#nexaCsGroupAny");
    const pageList = cheatSheetEl.querySelector("#nexaCsGroupPage");
    const pageBlock = cheatSheetEl.querySelector("#nexaCsPageBlock");
    function row(label, binding) {
      const li = document.createElement("li");
      li.style.cssText = "display:flex;justify-content:space-between;gap:14px;align-items:center;";
      const a = document.createElement("span"); a.textContent = label;
      const b = document.createElement("kbd");
      b.textContent = binding;
      b.style.cssText = "font-family:ui-monospace,Menlo,monospace;background:var(--cream,#f5efe1);color:var(--ink,#222);border:1px solid var(--line,#d8cda6);border-radius:6px;padding:2px 8px;font-size:11px;min-width:36px;text-align:center;";
      li.appendChild(a); li.appendChild(b);
      return li;
    }
    navList.innerHTML = "";
    for (const [label, def] of Object.entries(G_ACTIONS)) {
      const override = readOverride(label);
      navList.appendChild(row(label, "g " + (override || def.key)));
    }
    anyList.innerHTML = "";
    for (const [label, def] of Object.entries(SINGLE_ACTIONS)) {
      const override = readOverride(label);
      anyList.appendChild(row(label, override || def.key));
    }
    // Per-page actions from window.NexaPageActions (each entry: {label, key})
    pageList.innerHTML = "";
    const list = Array.isArray(window.NexaPageActions) ? window.NexaPageActions : [];
    if (list.length) {
      pageBlock.style.display = "block";
      list.forEach((a) => {
        pageList.appendChild(row(a.label, readOverride(a.label) || a.key));
      });
    } else {
      pageBlock.style.display = "none";
    }
  }
  function readOverride(label) {
    try {
      return (typeof window.NexaShortcutOverride === "function"
        ? window.NexaShortcutOverride(label) : null);
    } catch (_) { return null; }
  }
  function openCheatSheet() {
    if (!cheatSheetEl) cheatSheetEl = buildCheatSheet();
    if (!cheatSheetEl.isConnected) document.body.appendChild(cheatSheetEl);
    renderCheatSheetRows();
    cheatSheetEl.style.display = "flex";
  }
  function closeCheatSheet() {
    if (cheatSheetEl && cheatSheetEl.isConnected) cheatSheetEl.style.display = "none";
  }
  function toggleCheatSheet() {
    if (cheatSheetEl && cheatSheetEl.style.display === "flex") closeCheatSheet();
    else openCheatSheet();
  }

  // -------- G-prefix state machine -------------------------
  let gArmed = false;
  let gArmedTimer = null;
  function armG() {
    gArmed = true;
    if (gArmedTimer) clearTimeout(gArmedTimer);
    gArmedTimer = setTimeout(() => { gArmed = false; }, 1200);
  }
  function disarmG() {
    gArmed = false;
    if (gArmedTimer) { clearTimeout(gArmedTimer); gArmedTimer = null; }
  }

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (t.isContentEditable) return true;
    return false;
  }
  function isModalOpen() {
    if (document.getElementById("snoozePopover")) return true;
    if (document.getElementById("snoozeCustomModal")) return true;
    const att = document.getElementById("attachmentPreview");
    if (att && !att.hidden) return true;
    return false;
  }

  document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isModalOpen()) return;

    // Esc always closes the cheat sheet
    if (e.key === "Escape") {
      if (cheatSheetEl && cheatSheetEl.style.display === "flex") {
        e.preventDefault(); closeCheatSheet(); return;
      }
    }

    // "?" — shortcut cheat sheet (Shift+/)
    if (e.key === "?") {
      e.preventDefault(); toggleCheatSheet(); return;
    }

    // g-prefix sequence
    if (gArmed) {
      const k = e.key.toLowerCase();
      for (const [label, def] of Object.entries(G_ACTIONS)) {
        const want = (readOverride(label) || def.key).toLowerCase();
        if (k === want) {
          e.preventDefault();
          disarmG();
          try { def.fn(); } catch (_) {}
          return;
        }
      }
      // Any other key cancels the g-prefix.
      disarmG();
      return;
    }
    if (e.key.toLowerCase() === "g") {
      // Don't intercept g if the inbox page has its own j/k/r/etc handlers
      // that include a single-key "g" action. (None currently — safe.)
      armG();
      return;
    }

    // Single-key actions (skip "c" on inbox — page handles compose itself)
    for (const [label, def] of Object.entries(SINGLE_ACTIONS)) {
      const want = (readOverride(label) || def.key);
      // Compare with the same casing rules as inbox.js
      const evKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const wantKey = want.length === 1 ? want.toLowerCase() : want;
      if (evKey !== wantKey) continue;
      // If inbox already handles compose, let inbox.js own it.
      if (label === "Compose" && PAGE === "inbox") continue;
      if (label === "Search" && PAGE === "inbox") continue;
      e.preventDefault();
      try { def.fn(); } catch (_) {}
      return;
    }
  });

  // Expose for the Shortcuts settings page so it can list real,
  // wired actions (vs. doc-only) and let the user remap them.
  const allLabels = [
    ...Object.keys(G_ACTIONS).map(l => ({ label: l, scope: "navigate", default: "g " + G_ACTIONS[l].key })),
    ...Object.keys(SINGLE_ACTIONS).map(l => ({ label: l, scope: "anywhere", default: SINGLE_ACTIONS[l].key })),
  ];
  window.NexaCrossPageShortcuts = allLabels;
  window.NexaShowShortcutCheatSheet = openCheatSheet;
})();
