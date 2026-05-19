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

  async function onSelect(id, messages) {
    document
      .querySelectorAll(".mail-row.selected")
      .forEach((el) => el.classList.remove("selected"));
    const row = document.querySelector(`.mail-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add("selected");

    const stub = messages.find((m) => m.id === id);
    if (!stub) return;
    const f = parseFrom(stub.from);

    // Render head + skeleton body immediately, then fetch full body.
    readerEl.innerHTML = `
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

  // Phase 2b: Delta action buttons in the reader pre-fill the chat prompt
  // and open the panel. Phase 2b.2 will wire 'Draft a reply' to produce a
  // structured reply that lands in Gmail Drafts.
  function onDeltaAction(action, msg) {
    const fab = document.getElementById("deltaFab");
    const promptByAction = {
      "draft-reply": `Draft a reply to this email in my voice. Keep it warm but concise.`,
      summarize:   `Summarize this email in 3 bullets.`,
      translate:   `Translate this email into English (or to whichever language I usually reply in if it's already in English).`,
      explain:     `What is this email actually asking for? What should I do about it?`,
    };
    const prompt = promptByAction[action] || `Help me with this email.`;
    const input = document.getElementById("deltaInputWelcome")
              || document.getElementById("deltaInputChat");
    if (fab && fab.click) fab.click();   // open the panel
    setTimeout(() => {
      const target = document.getElementById("deltaInputChat")?.offsetParent !== null
                   ? document.getElementById("deltaInputChat")
                   : document.getElementById("deltaInputWelcome");
      if (target) {
        target.value = prompt;
        target.focus();
      }
    }, 60);
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
