// Phase 1 inbox renderer — loads /api/me + /api/gmail/recent and paints the list.

(() => {

  // Inline SVG icons for the Outlook-style toolbar. No emoji per brand.
  const SVG = {
    reply:      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`,
    replyAll:   `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V5l-7 7 7 7v-3l-4-4 4-4zm6 1V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`,
    forward:    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>`,
    archive:    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.54 5.23l-1.39-1.68A1.45 1.45 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23A1.94 1.94 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.47-.17-.91-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>`,
    star:       `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    starFilled: `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    unread:     `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
    trash:      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
  };

  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#mailList");
  const readerEl = $("#reader");

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseFrom(raw) {
    // "Lana Silk <lana@transformiran.com>" → { name:"Lana Silk", email:"lana@…" }
    const m = String(raw || "").match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].replace(/^"|"$/g, "").trim(), email: m[2] };
    return { name: "", email: String(raw || "").trim() };
  }

  function initialOf({ name, email }) {
    const src = (name || email || "·").trim();
    return src.charAt(0).toUpperCase();
  }

  function timeAgo(internalDate) {
    const t = Number(internalDate);
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    const min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.round(hr / 24);
    if (day < 7) return `${day}d`;
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  async function loadMe() {
    const r = await fetch("/api/me");
    if (!r.ok) throw new Error("not_authed");
    return r.json();
  }

  // Folder + pagination state
  let _currentFolder = "inbox";
  let _currentQuery = "";
  let _nextPageToken = null;

  const FOLDER_TITLES = {
    inbox:   "Inbox",
    starred: "Starred",
    sent:    "Sent",
    drafts:  "Drafts",
    archive: "Archive",
    trash:   "Trash",
  };

  async function loadInbox(opts = {}) {
    const folder = opts.folder || _currentFolder;
    const q = opts.q !== undefined ? opts.q : _currentQuery;
    const pageToken = opts.pageToken || null;
    const params = new URLSearchParams({ folder, limit: "30" });
    if (q) params.set("q", q);
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch(`/api/messages?${params}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function renderUser(me) {
    const initial = $("#userInitial");
    const name = $("#userName");
    if (initial) initial.textContent = initialOf({ name: me.displayName, email: me.email });
    if (name) name.textContent = me.displayName || me.email;
  }

  function renderList(messages) {
    if (!messages.length) {
      listEl.innerHTML = `
        <div class="list-empty">
          <div class="empty-icon">📭</div>
          <div class="empty-title">Inbox zero</div>
          <div class="empty-sub">No messages to display right now.</div>
        </div>`;
      return;
    }
    listEl.innerHTML = messages
      .map((m) => {
        const f = parseFrom(m.from);
        const initial = initialOf(f);
        const senderLabel = escapeHtml(f.name || f.email);
        const subj = escapeHtml(m.subject);
        const snip = escapeHtml(m.snippet).slice(0, 140);
        const when = escapeHtml(timeAgo(m.internalDate));
        const unreadCls = m.unread ? "unread" : "";
        return `
          <div class="mail-row ${unreadCls}" data-id="${escapeHtml(m.id)}">
            <div class="mail-avatar">${escapeHtml(initial)}</div>
            <div class="mail-body">
              <div class="mail-row-top">
                <div class="mail-sender">${senderLabel}</div>
                <div class="mail-time">${when}</div>
              </div>
              <div class="mail-subject">${subj}</div>
              <div class="mail-row-meta">
                <span class="mail-tag-slot" data-tag-for="${escapeHtml(m.id)}"></span>
                <span class="mail-snippet">${snip}</span>
              </div>
            </div>
          </div>`;
      })
      .join("");

    listEl.querySelectorAll(".mail-row").forEach((row) => {
      row.addEventListener("click", () => onSelect(row.dataset.id, messages));
    });
  }

  // ----- Quick filter pills (Phase 2c.3) --------------------------------
  // Filters the visible inbox list by classification. 'All' shows everything.
  // Counts update as classifications arrive.
  let _allMessages = [];
  let _classificationMap = {};
  let _activeFilter = "all";

  function setFilter(filterKey) {
    _activeFilter = filterKey;
    document.querySelectorAll(".qf-pill").forEach((p) => {
      p.classList.toggle("active", p.dataset.filter === filterKey);
    });
    document.querySelectorAll(".mail-row").forEach((row) => {
      const id = row.dataset.id;
      if (filterKey === "all") {
        row.classList.remove("filtered-out");
        return;
      }
      const c = _classificationMap[id];
      const match = c && c.category === filterKey;
      row.classList.toggle("filtered-out", !match);
    });
    updateFilterCounts();
  }

  function updateFilterCounts() {
    const counts = { URGENT: 0, REPLY_NEEDED: 0, TASK: 0, INTERNAL: 0, RECEIPT: 0 };
    for (const id of Object.keys(_classificationMap)) {
      const cat = _classificationMap[id].category;
      if (counts[cat] !== undefined) counts[cat] += 1;
    }
    const total = _allMessages.length;
    const visibleCount = (cat) =>
      cat === "all"
        ? total
        : counts[cat] || 0;
    document.querySelectorAll(".qf-pill").forEach((p) => {
      const key = p.dataset.filter;
      const slot = p.querySelector(".qf-count");
      if (!slot) return;
      const n = visibleCount(key);
      slot.textContent = n > 0 ? n : "";
      slot.style.display = n > 0 ? "" : "none";
    });
  }

  function wireFilterPills() {
    document.querySelectorAll(".qf-pill").forEach((p) => {
      p.addEventListener("click", () => setFilter(p.dataset.filter));
    });

    // Smart-folder links in left rail map to category filters.
    document.querySelectorAll(".folder[data-smart]").forEach((f) => {
      f.addEventListener("click", (e) => {
        e.preventDefault();
        const key = f.dataset.smart;
        // Map smart folder → classification filter
        const filterMap = {
          marketing: "NEWSLETTER",
          done:      "DONE",
        };
        const cat = filterMap[key];
        if (cat) {
          setFilter(cat);
          document.querySelector(".folder.active")?.classList.remove("active");
          f.classList.add("active");
          f.classList.remove("muted");
        }
      });
    });

    // "Inbox" link in rail = clear filter
    document.querySelectorAll('.folder[href="#inbox"]').forEach((f) => {
      f.addEventListener("click", (e) => {
        e.preventDefault();
        setFilter("all");
        document.querySelector(".folder.active")?.classList.remove("active");
        f.classList.add("active");
      });
    });
  }

  // ----- AI classification overlay (Phase 2c.1) -------------------------
  const TAG_LABEL = {
    URGENT:       "Urgent",
    REPLY_NEEDED: "Reply",
    TASK:         "Task",
    FYI:          "FYI",
    RECEIPT:      "Receipt",
    NEWSLETTER:   "Newsletter",
    INTERNAL:     "Internal",
    AUTO:         "Auto",
    DONE:         "Done",
  };

  function paintClassifications(map) {
    if (!map) return;
    Object.assign(_classificationMap, map);
    for (const [id, c] of Object.entries(map)) {
      const slot = document.querySelector(`.mail-tag-slot[data-tag-for="${CSS.escape(id)}"]`);
      if (!slot) continue;
      const cls = "tag-" + c.category.toLowerCase().replace(/_/g, "-");
      const label = TAG_LABEL[c.category] || c.category;
      const reason = c.reason ? ` — ${c.reason}` : "";
      slot.innerHTML = `<span class="mail-tag ${cls}" title="${escapeHtml(reason.replace(/^ — /, ""))}">${escapeHtml(label)}</span>`;
    }
    updateFilterCounts();
    // Re-apply current filter so newly classified rows hide/show correctly.
    if (_activeFilter !== "all") setFilter(_activeFilter);
  }

  async function classifyVisible(messages) {
    const payload = messages.slice(0, 50).map((m) => ({
      id: m.id,
      threadId: m.threadId || "",
      from: m.from || "",
      subject: m.subject || "",
      snippet: m.snippet || "",
    }));
    try {
      const r = await fetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
      });
      if (!r.ok) return;
      const data = await r.json();
      paintClassifications(data.classifications || {});
      // After painting, drop replied threads out of the inbox view.
      if (data.liveSyncCount > 0) {
        autoArchiveDoneRows();
      }
    } catch (err) {
      console.warn("[classify] failed:", err);
    }
  }

  // Hide rows that just flipped to DONE — they don't belong in the inbox
  // (the user replied to them, knowingly or via the live sync). The actual
  // Gmail archive will follow if user wants to fully archive.
  function autoArchiveDoneRows() {
    let removed = 0;
    document.querySelectorAll(".mail-row").forEach((row) => {
      const id = row.dataset.id;
      const cls = _classificationMap[id];
      if (cls && cls.category === "DONE" && !row.classList.contains("filtered-out")) {
        row.style.transition = "opacity .3s, transform .3s";
        row.style.opacity = "0";
        row.style.transform = "translateX(40px)";
        setTimeout(() => row.remove(), 300);
        removed++;
      }
    });
    if (removed) {
      showToast(`${removed} ${removed === 1 ? "thread" : "threads"} marked done (replied)`, "ok");
    }
  }

  async function onSelect(id, messages) {
    document
      .querySelectorAll(".mail-row.selected")
      .forEach((el) => el.classList.remove("selected"));
    const row = document.querySelector(`.mail-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add("selected");

    const stub = messages.find((m) => m.id === id);
    if (!stub) return;
    const f = parseFrom(stub.from);

    const isStarred = (stub.labelIds || []).includes("STARRED");
    const isUnread = (stub.labelIds || []).includes("UNREAD") || stub.unread;

    // Render head + skeleton body immediately, then fetch full body.
    readerEl.innerHTML = `
      <div class="reader-toolbar">
        <button class="tb-btn" data-tb="reply" title="Reply (R)">
          ${SVG.reply} <span>Reply</span>
        </button>
        <button class="tb-btn" data-tb="reply-all" title="Reply All (Shift+R)">
          ${SVG.replyAll} <span>Reply All</span>
        </button>
        <button class="tb-btn" data-tb="forward" title="Forward (F)">
          ${SVG.forward} <span>Forward</span>
        </button>
        <span class="tb-divider"></span>
        <button class="tb-btn" data-tb="archive" title="Archive (E)">
          ${SVG.archive} <span>Archive</span>
        </button>
        <button class="tb-btn ${isStarred ? "active" : ""}" data-tb="star" title="${isStarred ? "Unstar" : "Star"} (S)">
          ${isStarred ? SVG.starFilled : SVG.star} <span>${isStarred ? "Starred" : "Star"}</span>
        </button>
        <button class="tb-btn" data-tb="unread" title="Mark ${isUnread ? "read" : "unread"} (U)">
          ${SVG.unread} <span>Mark ${isUnread ? "read" : "unread"}</span>
        </button>
        <button class="tb-btn tb-danger" data-tb="trash" title="Delete (Del)">
          ${SVG.trash} <span>Delete</span>
        </button>
      </div>

      <div class="reader-head">
        <div class="reader-subject">${escapeHtml(stub.subject)}</div>
        <div class="reader-from">
          <strong>${escapeHtml(f.name || f.email)}</strong>
          ${f.name ? `<span class="reader-email">&lt;${escapeHtml(f.email)}&gt;</span>` : ""}
        </div>
        <div class="reader-meta">
          ${escapeHtml(stub.date || "")}
        </div>
        <div class="reader-actions">
          <button class="btn delta-btn primary" data-action="draft-reply">
            <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Draft a reply
          </button>
          <button class="btn delta-btn" data-action="summarize">
            <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Summarize
          </button>
          <button class="btn delta-btn" data-action="translate">
            <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Translate
          </button>
          <button class="btn delta-btn" data-action="explain">
            <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Ask about this
          </button>
        </div>
      </div>
      <div class="reader-body" id="readerBody">
        <div class="reader-loading">Loading message…</div>
      </div>`;

    // Wire the Delta action buttons (Phase 2b — they nudge Delta into the
    // appropriate prompt, then open the panel).
    readerEl.querySelectorAll(".reader-actions [data-action]").forEach((btn) => {
      btn.addEventListener("click", () => onDeltaAction(btn.dataset.action, stub));
    });

    // Wire the Outlook-style toolbar buttons.
    readerEl.querySelectorAll(".reader-toolbar [data-tb]").forEach((btn) => {
      btn.addEventListener("click", () => onToolbarAction(btn.dataset.tb, stub, btn));
    });

    // Fetch full body.
    const bodyEl = document.getElementById("readerBody");
    try {
      const r = await fetch(`/api/gmail/message/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderBody(bodyEl, data);
    } catch (err) {
      bodyEl.innerHTML = `
        <div class="reader-error">
          Couldn't load this message: ${escapeHtml(err.message)}<br>
          <span class="reader-snippet">${escapeHtml(stub.snippet)}</span>
        </div>`;
    }
  }

  function renderBody(bodyEl, data) {
    const hasHtml = data.body && data.body.html && data.body.html.trim().length > 0;
    const text = (data.body && data.body.text) || "";
    if (hasHtml) {
      // Render HTML in a sandboxed iframe to neutralize scripts.
      const iframe = document.createElement("iframe");
      iframe.className = "reader-iframe";
      iframe.sandbox = "allow-same-origin";
      iframe.srcdoc = wrapHtmlBody(data.body.html);
      bodyEl.innerHTML = "";
      bodyEl.appendChild(iframe);
      // Auto-size iframe to its content
      iframe.addEventListener("load", () => {
        try {
          const h = iframe.contentDocument.documentElement.scrollHeight;
          iframe.style.height = Math.min(h + 40, 4000) + "px";
        } catch (_) {
          iframe.style.height = "600px";
        }
      });
    } else if (text) {
      bodyEl.innerHTML = `<pre class="reader-text">${escapeHtml(text)}</pre>`;
    } else {
      bodyEl.innerHTML = `<div class="reader-empty-body">No body content.</div>`;
    }

    // Attachments tray
    if (data.attachments && data.attachments.length) {
      const tray = document.createElement("div");
      tray.className = "reader-attachments";
      tray.innerHTML =
        `<div class="reader-attachments-label">${data.attachments.length} attachment${data.attachments.length > 1 ? "s" : ""}</div>` +
        data.attachments
          .map(
            (a) => `
              <div class="reader-attachment">
                <span class="ra-icon">📎</span>
                <span class="ra-name">${escapeHtml(a.filename || "(unnamed)")}</span>
                <span class="ra-meta">${fmtSize(a.size)} · ${escapeHtml(a.mimeType || "")}</span>
              </div>`
          )
          .join("");
      bodyEl.appendChild(tray);
    }
  }

  function wrapHtmlBody(html) {
    // Minimal wrapper so links open in the parent window (target=_top) and
    // styling matches our reader. Sandbox blocks scripts even if anything
    // sneaks past the server-side sanitizer.
    return `<!doctype html><html><head><base target="_blank">
<style>
  body { margin: 0; padding: 0; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #282F39; }
  img { max-width: 100%; height: auto; }
  a { color: #8E6F35; }
  blockquote { border-left: 3px solid #E2DBC8; margin: 8px 0; padding: 4px 12px; color: #4A5260; }
  pre { white-space: pre-wrap; word-wrap: break-word; background: #F7F3E9; padding: 10px; border-radius: 6px; }
  table { border-collapse: collapse; max-width: 100%; }
</style>
</head><body>${html}</body></html>`;
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // Delta action buttons in the reader. 'Draft a reply' has its own
  // inline workflow (compose card with editable body + save-to-drafts).
  // The other actions pre-fill the Delta chat input and open the panel.
  function onDeltaAction(action, msg) {
    if (action === "draft-reply") {
      return openDraftComposer(msg);
    }
    const fab = document.getElementById("deltaFab");
    const promptByAction = {
      summarize: `Summarize this email in 3 bullets.`,
      translate: `Translate this email into English (or to whichever language I usually reply in if it's already in English).`,
      explain:   `What is this email actually asking for? What should I do about it?`,
    };
    const prompt = promptByAction[action] || `Help me with this email.`;
    if (fab && fab.click) fab.click();
    setTimeout(() => {
      const target = document.getElementById("deltaInputChat")?.offsetParent !== null
                   ? document.getElementById("deltaInputChat")
                   : document.getElementById("deltaInputWelcome");
      if (target) { target.value = prompt; target.focus(); }
    }, 60);
  }

  // ---------- OUTLOOK-STYLE TOOLBAR ------------------------------------
  // Wires the Reply/Forward/Archive/Star/Unread/Delete buttons at the top
  // of the open email to real Gmail API actions.
  async function onToolbarAction(action, msg, btn) {
    if (action === "reply" || action === "reply-all") {
      // Use the existing draft composer — Delta will draft, user edits.
      return openDraftComposer(msg);
    }
    if (action === "forward") {
      // Forward — open composer with empty 'To' and original quoted (Phase 2c.3)
      // For v1 just open the composer with no extra instructions.
      return openDraftComposer(msg);
    }
    if (action === "star") {
      const isStarred = btn.classList.contains("active");
      return modifyLabels(msg.id, btn, {
        add: isStarred ? [] : ["STARRED"],
        remove: isStarred ? ["STARRED"] : [],
        onSuccess: () => {
          btn.classList.toggle("active");
          // Swap icon between outline and filled.
          const icon = btn.querySelector("svg");
          if (icon) icon.outerHTML = isStarred ? SVG.star : SVG.starFilled;
          const lbl = btn.querySelector("span");
          if (lbl) lbl.textContent = isStarred ? "Star" : "Starred";
        },
      });
    }
    if (action === "unread") {
      // Toggle UNREAD label
      const lbl = btn.querySelector("span");
      const willMarkUnread = lbl && lbl.textContent.toLowerCase().includes("unread");
      return modifyLabels(msg.id, btn, {
        add: willMarkUnread ? ["UNREAD"] : [],
        remove: willMarkUnread ? [] : ["UNREAD"],
        onSuccess: () => {
          if (lbl) lbl.textContent = willMarkUnread ? "Mark read" : "Mark unread";
          // Update the list row's unread visual state
          const row = document.querySelector(`.mail-row[data-id="${CSS.escape(msg.id)}"]`);
          if (row) {
            if (willMarkUnread) row.classList.add("unread");
            else row.classList.remove("unread");
          }
        },
      });
    }
    if (action === "archive") {
      return modifyLabels(msg.id, btn, {
        add: [],
        remove: ["INBOX"],
        onSuccess: () => removeFromList(msg.id, "Archived"),
      });
    }
    if (action === "trash") {
      btn.disabled = true;
      try {
        const r = await fetch(`/api/gmail/message/${encodeURIComponent(msg.id)}/trash`, { method: "POST" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${r.status}`);
        }
        removeFromList(msg.id, "Moved to Trash");
      } catch (err) {
        showToast("Couldn't delete: " + (err.message || err), "error");
        btn.disabled = false;
      }
    }
  }

  async function modifyLabels(id, btn, { add, remove, onSuccess }) {
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/gmail/message/${encodeURIComponent(id)}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add, remove }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${r.status}`);
      }
      if (onSuccess) onSuccess();
    } catch (err) {
      showToast("Couldn't update: " + (err.message || err), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function removeFromList(id, reason) {
    const row = document.querySelector(`.mail-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.remove();
    readerEl.innerHTML = `<div class="reader-empty"><div class="empty-sub">${escapeHtml(reason)}. Select another email.</div></div>`;
    showToast(reason, "ok");
  }

  function showToast(text, kind = "ok") {
    let toast = document.getElementById("delta-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "delta-toast";
      toast.className = "delta-toast";
      document.body.appendChild(toast);
    }
    toast.className = "delta-toast show " + kind;
    toast.textContent = text;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.classList.remove("show"); }, 2400);
  }

  // ---------- DRAFT COMPOSER -------------------------------------------
  // Inserts a compose card at the top of the reader body, shows a loading
  // spinner while Delta drafts, then lets the user edit and save to Gmail
  // Drafts. The user always sends from Gmail itself.
  async function openDraftComposer(msg) {
    const bodyEl = document.getElementById("readerBody");
    if (!bodyEl) return;

    // If a composer is already open for this message, just focus it.
    if (document.getElementById("draftComposer")) {
      document.querySelector("#draftComposer textarea")?.focus();
      return;
    }

    const composer = document.createElement("div");
    composer.id = "draftComposer";
    composer.className = "draft-composer";
    composer.innerHTML = `
      <div class="draft-head">
        <div class="draft-title">
          <img class="k-logo" src="/delta-logo.png" alt="Delta" />
          <span>Delta is drafting a reply…</span>
        </div>
        <button class="draft-close" aria-label="Discard draft" title="Discard">×</button>
      </div>
      <div class="draft-confidence" style="display:none"></div>
      <div class="draft-fields">
        <div class="draft-field"><label>To</label><input class="draft-to" type="text" disabled></div>
        <div class="draft-field"><label>Subject</label><input class="draft-subject" type="text" disabled></div>
      </div>
      <div class="draft-tones">
        <span class="draft-tones-label">Tone:</span>
        <button class="tone-chip" data-tone="match">Match my style</button>
        <button class="tone-chip" data-tone="shorter">Shorter</button>
        <button class="tone-chip" data-tone="warmer">Warmer</button>
        <button class="tone-chip" data-tone="formal">More formal</button>
        <button class="tone-chip" data-tone="firm">Firmer / push back</button>
        <button class="tone-chip" data-tone="apologetic">Apologetic</button>
        <button class="tone-chip" data-tone="farsi">In Farsi</button>
        <button class="tone-chip" data-tone="dutch">In Dutch</button>
      </div>
      <div class="draft-instructions">
        <input class="draft-extra-instructions" type="text" placeholder="Or type your own instruction: 'mention the flight is at 4:55 PM'…">
        <button class="draft-regen btn delta-btn" disabled>
          <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Re-draft
        </button>
      </div>
      <div class="draft-body-wrap">
        <textarea class="draft-body" placeholder="Delta's draft will appear here…" disabled></textarea>
      </div>
      <div class="draft-actions">
        <button class="draft-send btn primary draft-btn-send" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          Send
        </button>
        <button class="draft-save btn" disabled>Save as draft</button>
        <button class="draft-cancel btn">Cancel</button>
        <span class="draft-sig-hint" style="display:none">+ your Transform Iran signature</span>
        <span class="draft-status"></span>
      </div>
    `;
    bodyEl.prepend(composer);

    const toInput = composer.querySelector(".draft-to");
    const subjInput = composer.querySelector(".draft-subject");
    const bodyTa = composer.querySelector(".draft-body");
    const instr = composer.querySelector(".draft-extra-instructions");
    const regenBtn = composer.querySelector(".draft-regen");
    const sendBtn = composer.querySelector(".draft-send");
    const saveBtn = composer.querySelector(".draft-save");
    const cancelBtn = composer.querySelector(".draft-cancel");
    const closeBtn = composer.querySelector(".draft-close");
    const titleEl = composer.querySelector(".draft-title span");
    const statusEl = composer.querySelector(".draft-status");

    function discardComposer() { composer.remove(); }
    closeBtn.addEventListener("click", discardComposer);
    cancelBtn.addEventListener("click", discardComposer);

    let currentDraft = null;

    async function generate(extraInstructions) {
      titleEl.textContent = "Delta is drafting a reply…";
      regenBtn.disabled = true;
      saveBtn.disabled = true;
      bodyTa.disabled = true;
      statusEl.textContent = "";
      bodyTa.value = "";

      try {
        const r = await fetch("/api/assistant/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            openMessageId: msg.id,
            instructions: extraInstructions || "",
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error || "draft failed");
        currentDraft = data;
        toInput.value = data.to || "";
        subjInput.value = data.subject || "";
        bodyTa.value = data.body || "";
        titleEl.textContent = "Draft ready — edit before saving";

        // Signature availability indicator
        const sigHintEl = composer.querySelector(".draft-sig-hint");
        if (sigHintEl && data.signatureAvailable) {
          sigHintEl.style.display = "";
        }

        // Style confidence banner — "Found N writing examples to <recipient>"
        const conf = data.styleExamples;
        const confEl = composer.querySelector(".draft-confidence");
        if (confEl && conf) {
          const cls =
            conf.confidence === "high"   ? "conf-high"   :
            conf.confidence === "medium" ? "conf-medium" : "conf-low";
          const recipient = conf.recipient || "this recipient";
          let label;
          if (conf.count >= 1) {
            label = `Matched your style with <strong>${conf.count}</strong> past email${conf.count === 1 ? "" : "s"} to ${escapeHtml(recipient)}`;
          } else {
            label = `First email to <strong>${escapeHtml(recipient)}</strong> — using your general tone`;
          }
          confEl.className = "draft-confidence " + cls;
          confEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg><span>${label}</span>`;
          confEl.style.display = "flex";
        }
      } catch (err) {
        titleEl.textContent = "Couldn't generate a draft";
        statusEl.textContent = err.message || String(err);
        statusEl.className = "draft-status error";
      } finally {
        regenBtn.disabled = false;
        saveBtn.disabled = false;
        sendBtn.disabled = false;
        bodyTa.disabled = false;
        instr.value = "";
      }
    }

    regenBtn.addEventListener("click", () => generate(instr.value.trim()));
    instr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); regenBtn.click(); }
    });

    // Tone preset chips — re-draft with that instruction
    composer.querySelectorAll(".tone-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const tone = chip.dataset.tone;
        const phrasing = {
          match:      "Match my style as closely as you can to my past emails with this person.",
          shorter:    "Make it shorter — same meaning, fewer words.",
          warmer:     "Warmer tone — more personal, less transactional.",
          formal:     "More formal tone — appropriate for first contact or sensitive matters.",
          firm:       "Firmer — push back politely on the request or hold a clear position.",
          apologetic: "Apologize for the delay (or lack of response) up front, then address the substance.",
          farsi:      "Write the reply in Farsi instead of the current language.",
          dutch:      "Write the reply in Dutch instead of the current language.",
        };
        generate(phrasing[tone] || tone);
      });
    });

    sendBtn.addEventListener("click", async () => {
      if (!currentDraft) return;
      const to = toInput.value.trim();
      if (!to) {
        statusEl.className = "draft-status error";
        statusEl.textContent = "Add a recipient first.";
        return;
      }
      if (!confirm(`Send this reply to ${to}?`)) return;
      sendBtn.disabled = true;
      saveBtn.disabled = true;
      statusEl.className = "draft-status";
      statusEl.textContent = "Sending…";
      try {
        const r = await fetch("/api/gmail/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to,
            subject: subjInput.value,
            body: bodyTa.value,
            threadId: currentDraft.threadId,
            inReplyTo: currentDraft.inReplyTo,
          }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "send failed");
        statusEl.className = "draft-status ok";
        statusEl.textContent = data.archived ? "Sent + archived ✓" : "Sent ✓";
        sendBtn.textContent = "Sent";
        toInput.disabled = true; subjInput.disabled = true; bodyTa.disabled = true;
        regenBtn.disabled = true;
        showToast(data.archived ? `Sent to ${to} · archived` : `Sent to ${to}`, "ok");
        if (data.archived) {
          // The original thread is gone from inbox now. Remove the row + clear reader.
          setTimeout(() => removeFromList(msg.id, "Replied + archived"), 1200);
        } else {
          setTimeout(() => composer.remove(), 1500);
        }
      } catch (err) {
        statusEl.className = "draft-status error";
        statusEl.textContent = err.message || String(err);
        sendBtn.disabled = false;
        saveBtn.disabled = false;
      }
    });

    saveBtn.addEventListener("click", async () => {
      if (!currentDraft) return;
      saveBtn.disabled = true;
      statusEl.className = "draft-status";
      statusEl.textContent = "Saving to Gmail Drafts…";
      try {
        const r = await fetch("/api/gmail/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: toInput.value,
            subject: subjInput.value,
            body: bodyTa.value,
            threadId: currentDraft.threadId,
            inReplyTo: currentDraft.inReplyTo,
          }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "save failed");
        statusEl.className = "draft-status ok";
        statusEl.innerHTML = `Saved! <a href="${data.gmailUrl}" target="_blank" rel="noopener">Open in Gmail Drafts ↗</a>`;
        titleEl.textContent = "Draft saved";
        bodyTa.disabled = true;
        toInput.disabled = true;
        subjInput.disabled = true;
        regenBtn.disabled = true;
        saveBtn.textContent = "Saved";
      } catch (err) {
        statusEl.className = "draft-status error";
        statusEl.textContent = err.message || String(err);
        saveBtn.disabled = false;
      }
    });

    // Kick off the initial draft.
    generate("");
  }

  // ---------- COMPOSE MODAL (rich-text new email) ----------------------
  const composeBtn = document.getElementById("composeBtn");
  const composeModal = document.getElementById("composeModal");
  const cmpFrom = document.getElementById("cmpFrom");
  const cmpTo = document.getElementById("cmpTo");
  const cmpCc = document.getElementById("cmpCc");
  const cmpBcc = document.getElementById("cmpBcc");
  const cmpCcRow = document.getElementById("cmpCcRow");
  const cmpBccRow = document.getElementById("cmpBccRow");
  const cmpCcToggle = document.getElementById("cmpCcToggle");
  const cmpSubject = document.getElementById("cmpSubject");
  const cmpBodyRich = document.getElementById("cmpBodyRich");
  const cmpSend = document.getElementById("cmpSend");
  const cmpSave = document.getElementById("cmpSave");
  const cmpDiscard = document.getElementById("cmpDiscard");
  const cmpAttach = document.getElementById("cmpAttach");
  const cmpInsertSig = document.getElementById("cmpInsertSig");
  const cmpClose = document.getElementById("composeClose");
  const cmpStatus = document.getElementById("cmpStatus");
  const cmpSigHint = document.getElementById("cmpSigHint");
  const composeToolbar = document.getElementById("composeToolbar");
  const cmpBackdrop = composeModal?.querySelector(".compose-backdrop");

  let cmpSignatureHtml = "";

  function openCompose() {
    if (!composeModal) return;
    composeModal.hidden = false;
    cmpStatus.className = "compose-status";
    cmpStatus.textContent = "";
    setTimeout(() => cmpTo.focus(), 50);
    // Pull settings — populates From, signature hint, and caches signature HTML.
    fetch("/api/compose/settings").then((r) => r.ok ? r.json() : null).then((s) => {
      if (!s) return;
      const primary = (s.aliases || []).find((a) => a.isDefault) || (s.aliases || [])[0];
      if (cmpFrom && primary) cmpFrom.value = primary.displayName
        ? `${primary.displayName} <${primary.sendAsEmail}>`
        : primary.sendAsEmail;
      cmpSignatureHtml = s.primarySignature?.html || "";
      if (s.primarySignature && (s.signatureMode || "always") !== "never") {
        cmpSigHint.style.display = "";
      } else {
        cmpSigHint.style.display = "none";
      }
    }).catch(() => {});
  }
  function closeCompose(force = false) {
    if (!composeModal) return;
    const dirty = cmpTo.value || cmpSubject.value || (cmpBodyRich.textContent || "").trim() || cmpCc.value || cmpBcc.value;
    if (dirty && !force && !confirm("Discard this draft?")) return;
    composeModal.hidden = true;
    cmpTo.value = ""; cmpCc.value = ""; cmpBcc.value = "";
    cmpSubject.value = ""; cmpBodyRich.innerHTML = "";
    cmpCcRow.hidden = true; cmpBccRow.hidden = true;
    cmpStatus.textContent = "";
    cmpSend.disabled = false; cmpSave.disabled = false;
  }

  composeBtn?.addEventListener("click", openCompose);
  cmpClose?.addEventListener("click", () => closeCompose());
  cmpDiscard?.addEventListener("click", () => closeCompose(true));
  cmpBackdrop?.addEventListener("click", () => closeCompose());

  // Cc / Bcc toggle
  cmpCcToggle?.addEventListener("click", () => {
    cmpCcRow.hidden = false;
    cmpBccRow.hidden = false;
    cmpCcToggle.style.display = "none";
    cmpCc.focus();
  });

  // Insert signature inline (appends HTML signature at the end of the body)
  cmpInsertSig?.addEventListener("click", () => {
    if (!cmpSignatureHtml) {
      cmpStatus.className = "compose-status error";
      cmpStatus.textContent = "No signature configured. Set one in Gmail → Settings.";
      return;
    }
    cmpBodyRich.focus();
    // Move caret to end + insert
    const range = document.createRange();
    range.selectNodeContents(cmpBodyRich);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertHTML", false,
      "<br><br>" + cmpSignatureHtml);
  });

  // Rich-text toolbar
  composeToolbar?.querySelectorAll("[data-cmd]").forEach((el) => {
    el.addEventListener("change", (e) => fireCmd(el));
    el.addEventListener("click", (e) => {
      if (el.tagName === "BUTTON") { e.preventDefault(); fireCmd(el); }
    });
  });
  function fireCmd(el) {
    const cmd = el.dataset.cmd;
    let value = el.dataset.value || null;
    if (el.tagName === "SELECT") value = el.value || null;
    if (el.type === "color") value = el.value;
    if (cmd === "createLink") {
      value = prompt("Enter URL:", "https://");
      if (!value) return;
    }
    cmpBodyRich.focus();
    try {
      document.execCommand(cmd, false, value);
    } catch (err) {
      console.warn("execCommand failed:", cmd, err);
    }
  }

  async function postCompose(endpoint) {
    const to = cmpTo.value.trim();
    if (!to) { cmpStatus.className = "compose-status error"; cmpStatus.textContent = "Add a recipient first."; return false; }
    const bodyHtml = cmpBodyRich.innerHTML.trim();
    if (!bodyHtml || bodyHtml === "<br>" || bodyHtml === "<p></p>") {
      cmpStatus.className = "compose-status error";
      cmpStatus.textContent = "Write something first.";
      return false;
    }
    const payload = {
      to,
      subject: cmpSubject.value,
      bodyHtml,
    };
    if (cmpCc.value.trim()) payload.cc = cmpCc.value.trim();
    if (cmpBcc.value.trim()) payload.bcc = cmpBcc.value.trim();
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.message || data.error || "request failed");
    return data;
  }

  cmpSend?.addEventListener("click", async () => {
    const to = cmpTo.value.trim();
    if (!to) { cmpStatus.className = "compose-status error"; cmpStatus.textContent = "Add a recipient first."; return; }
    if (!confirm(`Send this email to ${to}?`)) return;
    cmpSend.disabled = true; cmpSave.disabled = true;
    cmpStatus.className = "compose-status";
    cmpStatus.textContent = "Sending…";
    try {
      const data = await postCompose("/api/gmail/send");
      if (data === false) { cmpSend.disabled = false; cmpSave.disabled = false; return; }
      cmpStatus.className = "compose-status ok";
      cmpStatus.textContent = `Sent ✓`;
      showToast(`Sent to ${to}`, "ok");
      setTimeout(() => closeCompose(true), 1200);
    } catch (err) {
      cmpStatus.className = "compose-status error";
      cmpStatus.textContent = err.message || String(err);
      cmpSend.disabled = false; cmpSave.disabled = false;
    }
  });

  cmpSave?.addEventListener("click", async () => {
    cmpSend.disabled = true; cmpSave.disabled = true;
    cmpStatus.className = "compose-status"; cmpStatus.textContent = "Saving…";
    try {
      const data = await postCompose("/api/gmail/draft");
      if (data === false) { cmpSend.disabled = false; cmpSave.disabled = false; return; }
      cmpStatus.className = "compose-status ok";
      cmpStatus.innerHTML = `Saved! <a href="${data.gmailUrl}" target="_blank" rel="noopener">Open in Gmail ↗</a>`;
      showToast("Saved as draft", "ok");
      cmpSave.disabled = false; cmpSend.disabled = false;
    } catch (err) {
      cmpStatus.className = "compose-status error";
      cmpStatus.textContent = err.message || String(err);
      cmpSend.disabled = false; cmpSave.disabled = false;
    }
  });

  // Esc to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && composeModal && !composeModal.hidden) closeCompose();
  });

  // ---------- BACKFILL BANNER -----------------------------------------
  const banner = document.getElementById("backfillBanner");
  const bfbMeta = document.getElementById("bfbMeta");
  const bfbBar = document.getElementById("bfbBarFill");
  const bfbDismiss = document.getElementById("bfbDismiss");
  let backfillTimer = null;
  let bannerSticky = false;  // user dismissed the "complete" state

  let backfillAutoStarted = false;
  async function pollBackfill() {
    try {
      const r = await fetch("/api/backfill/status");
      if (!r.ok) return;
      const data = await r.json();

      // First-time entry: no job exists → kick it off automatically.
      // (This handles existing users who already passed the welcome flow
      // before backfill was a feature.)
      if (data.status === "none" && !backfillAutoStarted) {
        backfillAutoStarted = true;
        try {
          await fetch("/api/backfill/start", { method: "POST" });
          // Re-poll immediately to show the new state
          setTimeout(pollBackfill, 500);
        } catch (_) {}
        return;
      }

      renderBackfill(data);
      if (data.status === "completed" || data.status === "failed") {
        // Stop polling but leave the banner visible briefly for completed state.
        if (backfillTimer) { clearInterval(backfillTimer); backfillTimer = null; }
      }
    } catch (_) {}
  }

  function fmt(n) {
    if (!Number.isFinite(n)) return "?";
    return n.toLocaleString("en-US");
  }

  function renderBackfill(s) {
    if (!banner || bannerSticky) return;
    if (!s || s.status === "none" || !s.status) {
      banner.hidden = true;
      return;
    }
    if (s.status === "failed") {
      banner.hidden = false;
      banner.classList.remove("complete");
      bfbMeta.textContent = "Backfill paused — " + (s.error || "unknown error");
      bfbBar.style.width = (s.percent || 0) + "%";
      bfbDismiss.hidden = false;
      return;
    }
    if (s.status === "completed") {
      banner.hidden = false;
      banner.classList.add("complete");
      bfbMeta.textContent = `Indexed ${fmt(s.total_indexed)} messages — Delta can now search your full history.`;
      bfbBar.style.width = "100%";
      bfbDismiss.hidden = false;
      return;
    }
    // running / pending
    banner.hidden = false;
    banner.classList.remove("complete");
    const phase = s.phase === "list" ? "Listing messages" :
                  s.phase === "meta" ? "Reading details" :
                  "Indexing";
    const total = s.total_estimated || 0;
    const done = s.total_indexed || 0;
    if (total > 0) {
      bfbMeta.textContent = `${phase} — ${fmt(done)} of ${fmt(total)} (${s.percent}%)`;
      bfbBar.style.width = (s.percent || 0) + "%";
    } else {
      bfbMeta.textContent = `${phase}…`;
      bfbBar.style.width = "5%";
    }
    bfbDismiss.hidden = true;
  }

  bfbDismiss?.addEventListener("click", () => {
    banner.hidden = true;
    bannerSticky = true;
  });

  // Re-fetch inbox + re-classify (picks up new mail + DONE status from
  // Gmail-side replies). Called by the refresh button + tab focus.
  let refreshing = false;
  async function refreshInbox() {
    if (refreshing) return;
    refreshing = true;
    const btn = document.getElementById("refreshInboxBtn");
    btn?.classList.add("spinning");
    try {
      const result = await loadInbox();
      _allMessages = result.messages || [];
      _nextPageToken = result.nextPageToken;
      _classificationMap = {};   // wipe stale state
      renderList(_allMessages);
      wireFilterPills();
      updateFilterCounts();
      updateLoadMoreButton();
      // Only classify the inbox folder — Sent/Drafts/etc. don't need it.
      if (_currentFolder === "inbox" && !_currentQuery) {
        await classifyVisible(_allMessages);
      }
    } catch (err) {
      console.warn("[refresh] failed:", err);
    } finally {
      setTimeout(() => btn?.classList.remove("spinning"), 850);
      refreshing = false;
    }
  }

  // ---------- FOLDER NAVIGATION --------------------------------------
  function setFolder(folder, opts = {}) {
    _currentFolder = folder;
    _currentQuery = opts.query || "";
    _nextPageToken = null;
    _classificationMap = {};

    // Update title
    const title = opts.title || FOLDER_TITLES[folder] || folder;
    const titleEl = document.getElementById("listTitle");
    if (titleEl) titleEl.textContent = _currentQuery
      ? `Search: "${_currentQuery}"`
      : title;

    // Update active state in rail
    document.querySelectorAll(".folder.active").forEach((f) => f.classList.remove("active"));
    document.querySelector(`.folder[data-folder="${folder}"]`)?.classList.add("active");

    // Clear smart-folder filter pill state (don't carry across folders)
    _activeFilter = "all";
    document.querySelectorAll(".qf-pill").forEach((p) =>
      p.classList.toggle("active", p.dataset.filter === "all")
    );

    // Clear current view and reload
    const listEl2 = document.getElementById("mailList");
    if (listEl2) listEl2.innerHTML = `<div class="list-empty"><div class="empty-icon">✉︎</div><div class="empty-title">Loading ${title}…</div></div>`;
    refreshInbox();
  }

  function wireFolderLinks() {
    document.querySelectorAll(".folder[data-folder]").forEach((f) => {
      f.addEventListener("click", (e) => {
        e.preventDefault();
        setFolder(f.dataset.folder);
      });
    });
  }

  // ---------- SEARCH -------------------------------------------------
  function wireSearch() {
    const input = document.getElementById("searchInput");
    if (!input) return;
    input.disabled = false;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const q = input.value.trim();
        if (q) {
          setFolder("inbox", { query: q, title: `Search: "${q}"` });
        } else {
          setFolder("inbox");
        }
      } else if (e.key === "Escape") {
        input.value = "";
        if (_currentQuery) setFolder("inbox");
      }
    });
  }

  // ---------- PAGINATION (Load more) --------------------------------
  function updateLoadMoreButton() {
    const row = document.getElementById("loadMoreRow");
    if (!row) return;
    row.hidden = !_nextPageToken;
  }
  async function loadMore() {
    if (!_nextPageToken) return;
    const btn = document.getElementById("loadMoreBtn");
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const result = await loadInbox({ pageToken: _nextPageToken });
      const newMessages = result.messages || [];
      _allMessages = _allMessages.concat(newMessages);
      _nextPageToken = result.nextPageToken;
      appendList(newMessages);
      updateLoadMoreButton();
      if (_currentFolder === "inbox" && !_currentQuery) {
        classifyVisible(newMessages);
      }
    } catch (err) {
      btn.textContent = "Load failed — retry";
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (!btn.textContent.includes("failed")) btn.textContent = "Load more";
      }, 400);
    }
  }
  function appendList(messages) {
    const listEl2 = document.getElementById("mailList");
    if (!listEl2 || !messages.length) return;
    // Reuse renderList but only add new rows
    const html = messages
      .map((m) => {
        const f = parseFrom(m.from);
        const initial = initialOf(f);
        const senderLabel = escapeHtml(f.name || f.email);
        const subj = escapeHtml(m.subject);
        const snip = escapeHtml(m.snippet).slice(0, 140);
        const when = escapeHtml(timeAgo(m.internalDate));
        const unreadCls = m.unread ? "unread" : "";
        return `
          <div class="mail-row ${unreadCls}" data-id="${escapeHtml(m.id)}">
            <div class="mail-avatar">${escapeHtml(initial)}</div>
            <div class="mail-body">
              <div class="mail-row-top">
                <div class="mail-sender">${senderLabel}</div>
                <div class="mail-time">${when}</div>
              </div>
              <div class="mail-subject">${subj}</div>
              <div class="mail-row-meta">
                <span class="mail-tag-slot" data-tag-for="${escapeHtml(m.id)}"></span>
                <span class="mail-snippet">${snip}</span>
              </div>
            </div>
          </div>`;
      })
      .join("");
    listEl2.insertAdjacentHTML("beforeend", html);
    // Re-wire click handlers for the new rows
    listEl2.querySelectorAll(".mail-row").forEach((row) => {
      if (row._wired) return;
      row._wired = true;
      row.addEventListener("click", () => onSelect(row.dataset.id, _allMessages));
    });
  }

  // ---------- COUNTS -------------------------------------------------
  async function loadCounts() {
    try {
      const r = await fetch("/api/counts");
      if (!r.ok) return;
      const data = await r.json();
      const inboxCount = document.getElementById("count-inbox");
      const draftsCount = document.getElementById("count-drafts");
      if (inboxCount) {
        if (data.inboxUnread > 0) {
          inboxCount.textContent = data.inboxUnread;
          inboxCount.classList.add("has-unread");
        } else {
          inboxCount.textContent = "";
          inboxCount.classList.remove("has-unread");
        }
      }
      if (draftsCount) {
        draftsCount.textContent = data.drafts > 0 ? data.drafts : "";
      }
    } catch (_) {}
  }

  // Wire the manual refresh button + auto-refresh on tab focus.
  document.getElementById("refreshInboxBtn")?.addEventListener("click", refreshInbox);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // Tab came back into focus — re-sync silently.
      refreshInbox();
      loadCounts();
    }
  });

  // Folder links + search + load more
  wireFolderLinks();
  wireSearch();
  document.getElementById("loadMoreBtn")?.addEventListener("click", loadMore);

  async function main() {
    try {
      const me = await loadMe();
      renderUser(me);
    } catch (err) {
      // Not signed in — bounce to landing.
      window.location.href = "/";
      return;
    }
    // Start backfill polling immediately
    pollBackfill();
    backfillTimer = setInterval(pollBackfill, 5000);

    try {
      const result = await loadInbox();
      _allMessages = result.messages || [];
      _nextPageToken = result.nextPageToken;
      renderList(_allMessages);
      wireFilterPills();
      updateFilterCounts();
      updateLoadMoreButton();
      loadCounts();
      // Kick off classification in the background — tags fill in as they arrive.
      classifyVisible(_allMessages);
    } catch (err) {
      listEl.innerHTML = `
        <div class="list-empty">
          <div class="empty-icon">⚠︎</div>
          <div class="empty-title">Couldn't load Gmail</div>
          <div class="empty-sub">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    }
  }

  main();
})();
