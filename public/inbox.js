// Phase 1 inbox renderer — loads /api/me + /api/gmail/recent and paints the list.

(() => {
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

  async function loadInbox() {
    const r = await fetch("/api/gmail/recent?limit=30");
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
              <div class="mail-snippet">${snip}</div>
            </div>
          </div>`;
      })
      .join("");

    listEl.querySelectorAll(".mail-row").forEach((row) => {
      row.addEventListener("click", () => onSelect(row.dataset.id, messages));
    });
  }

  function onSelect(id, messages) {
    document
      .querySelectorAll(".mail-row.selected")
      .forEach((el) => el.classList.remove("selected"));
    const row = document.querySelector(`.mail-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add("selected");
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    const f = parseFrom(msg.from);
    readerEl.innerHTML = `
      <div class="reader-head">
        <div class="reader-subject">${escapeHtml(msg.subject)}</div>
        <div class="reader-from">
          <strong>${escapeHtml(f.name || f.email)}</strong>
          ${f.name ? `<span class="reader-email">&lt;${escapeHtml(f.email)}&gt;</span>` : ""}
        </div>
        <div class="reader-meta">
          ${escapeHtml(msg.date || "")}
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
      <div class="reader-body">
        <p class="reader-snippet">${escapeHtml(msg.snippet)}</p>
        <p class="reader-note">
          Full message bodies arrive in Phase 2 (we fetch only metadata
          right now — instant, no quota burn).
        </p>
      </div>`;

    // Placeholder handlers — wire to /api/assistant in Phase 2.
    readerEl.querySelectorAll(".reader-actions [data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fab = document.getElementById("deltaFab");
        if (fab) fab.click();
      });
    });
  }

  async function main() {
    try {
      const me = await loadMe();
      renderUser(me);
    } catch (err) {
      // Not signed in — bounce to landing.
      window.location.href = "/";
      return;
    }
    try {
      const { messages } = await loadInbox();
      renderList(messages);
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
