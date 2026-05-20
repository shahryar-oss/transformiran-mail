// Contacts page — list + search + detail + edit + delete + create.
// Backed by /api/contacts which mixes manual entries with senders
// auto-extracted from inbox_cache.

(() => {
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const state = {
    contacts: [],
    selectedId: null,
    search: "",
    sort: "name",      // name | recent | frequent
    recent: [],        // recent emails for the selected contact
  };

  // ---------- helpers ----------
  function initials(name, email) {
    const src = (name || email || "?").trim();
    if (!src) return "?";
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src[0].toUpperCase();
  }
  function fmtDateShort(d) {
    if (!d) return "";
    const dt = new Date(d);
    const now = new Date();
    const sameYear = dt.getFullYear() === now.getFullYear();
    return dt.toLocaleDateString(undefined, sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" });
  }
  function fmtRelative(d) {
    if (!d) return "—";
    const ms = Date.now() - new Date(d).getTime();
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    if (days < 1) return "today";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  // ---------- data ----------
  async function loadContacts() {
    $("ctCount").textContent = "Loading…";
    const params = new URLSearchParams({ sort: state.sort });
    if (state.search) params.set("search", state.search);
    try {
      const r = await fetch(`/api/contacts?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.contacts = data.contacts || [];
      renderList();
    } catch (err) {
      $("ctRows").innerHTML = `<div class="ct-empty">Couldn't load contacts: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadRecent(contactId) {
    state.recent = [];
    try {
      const r = await fetch(`/api/contacts/${contactId}/messages`);
      if (!r.ok) return;
      const data = await r.json();
      state.recent = data.messages || [];
    } catch (_) {}
    if (state.selectedId === contactId) renderDetail();   // re-render if still selected
  }

  // ---------- render ----------
  function renderList() {
    const rows = $("ctRows");
    const count = state.contacts.length;
    $("ctCount").textContent = count
      ? `${count} contact${count === 1 ? "" : "s"}`
      : (state.search ? "No matches" : "No contacts yet");

    if (!count) {
      rows.innerHTML = `<div class="ct-empty">
        ${state.search
          ? "No matches for that search."
          : "Click <strong>Refresh from inbox</strong> in the left rail to populate from your email senders, or <strong>+ New contact</strong> to add manually."}
      </div>`;
      return;
    }
    rows.innerHTML = state.contacts.map((c) => `
      <div class="ct-row ${c.id === state.selectedId ? "selected" : ""}" data-id="${c.id}">
        <div class="ct-avatar">${escapeHtml(initials(c.name, c.email))}</div>
        <div class="ct-row-body">
          <div class="ct-row-name">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.name)}</span>
            ${c.is_important ? `<span class="ct-star" title="In your Important list"><svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></span>` : ""}
          </div>
          <div class="ct-row-email">${escapeHtml(c.email)}</div>
        </div>
        <div class="ct-row-meta" title="Last seen">${fmtRelative(c.last_seen_at)}</div>
      </div>
    `).join("");
    rows.querySelectorAll(".ct-row").forEach((row) => {
      row.addEventListener("click", () => selectContact(Number(row.dataset.id)));
    });
  }

  async function selectContact(id) {
    state.selectedId = id;
    renderList();
    renderDetail();        // immediate paint
    loadRecent(id);        // async — re-renders detail when done
  }

  function renderDetail() {
    const wrap = $("ctDetail");
    const c = state.contacts.find((x) => x.id === state.selectedId);
    if (!c) {
      wrap.innerHTML = `<div class="ct-detail-empty">Select a contact on the left to see their details.</div>`;
      return;
    }
    const sourceLabel = {
      "manual": "Manual",
      "auto-inbox": "From inbox",
      "google": "Google",
    }[c.source] || c.source;

    wrap.innerHTML = `
      <div class="ct-detail-head">
        <div class="ct-detail-avatar">${escapeHtml(initials(c.name, c.email))}</div>
        <div class="ct-detail-headinfo">
          <input class="ct-detail-name-input" id="ctName" value="${escapeHtml(c.name)}" placeholder="Name">
          <div class="ct-detail-sub">${escapeHtml(c.email)}<span class="ct-source-pill ${escapeHtml(c.source)}">${escapeHtml(sourceLabel)}</span></div>
        </div>
        <div class="ct-detail-actions">
          <button class="ct-action ${c.is_important ? "important" : ""}" id="ctImpBtn" type="button" title="${c.is_important ? "Remove from Important" : "Add to Important"}">
            <svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
            ${c.is_important ? "Important" : "Add to Important"}
          </button>
          <button class="ct-action" id="ctEmailBtn" type="button" title="Email this contact">
            <svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
            Email
          </button>
          <button class="ct-action delete" id="ctDelBtn" type="button" title="Delete contact">
            <svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            Delete
          </button>
        </div>
      </div>

      <div class="ct-detail-body">
        <div class="ct-field">
          <span class="ct-field-icon"><svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg></span>
          <div class="ct-field-content">
            <div class="ct-field-label">Email</div>
            <div class="ct-field-value">${escapeHtml(c.email)}</div>
          </div>
        </div>
        <div class="ct-field">
          <span class="ct-field-icon"><svg viewBox="0 0 24 24"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/></svg></span>
          <div class="ct-field-content">
            <div class="ct-field-label">Phone</div>
            <input class="ct-field-input" id="ctPhone" value="${escapeHtml(c.phone)}" placeholder="Add phone number">
          </div>
        </div>
        <div class="ct-field">
          <span class="ct-field-icon"><svg viewBox="0 0 24 24"><path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/></svg></span>
          <div class="ct-field-content">
            <div class="ct-field-label">Organization</div>
            <input class="ct-field-input" id="ctOrg" value="${escapeHtml(c.organization)}" placeholder="Add organization">
          </div>
        </div>
        <div class="ct-field">
          <span class="ct-field-icon"><svg viewBox="0 0 24 24"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zM14 6h-4V4h4v2z"/></svg></span>
          <div class="ct-field-content">
            <div class="ct-field-label">Job title</div>
            <input class="ct-field-input" id="ctTitle" value="${escapeHtml(c.job_title)}" placeholder="Add job title">
          </div>
        </div>
        <div class="ct-field">
          <span class="ct-field-icon"><svg viewBox="0 0 24 24"><path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h12v2H3z"/></svg></span>
          <div class="ct-field-content">
            <div class="ct-field-label">Notes</div>
            <textarea class="ct-field-textarea" id="ctNotes" placeholder="Add notes">${escapeHtml(c.notes)}</textarea>
          </div>
        </div>
        <div class="ct-field">
          <span class="ct-field-icon"><svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg></span>
          <div class="ct-field-content">
            <div class="ct-field-label">Activity</div>
            <div class="ct-field-value">${c.email_count} email${c.email_count === 1 ? "" : "s"} · last ${escapeHtml(fmtRelative(c.last_seen_at))}</div>
          </div>
        </div>
        <div class="ct-status" id="ctSaveStatus" style="padding-left:30px"></div>
      </div>

      <div class="ct-section-title">Recent emails</div>
      <div class="ct-recent" id="ctRecent">
        ${state.recent.length
          ? state.recent.map((m) => `
            <a class="ct-recent-item" href="/?msg=${encodeURIComponent(m.id)}">
              <div style="flex:1;min-width:0">
                <div class="ct-recent-subject">${escapeHtml(m.subject)}</div>
                <div class="ct-recent-snippet">${escapeHtml(m.snippet)}</div>
                <div class="ct-recent-date">${escapeHtml(m.date)}</div>
              </div>
            </a>`).join("")
          : `<div class="ct-row-email" style="padding: 4px 0">No recent emails in cache.</div>`}
      </div>
    `;

    // Wire editing — save on blur.
    $("ctName").addEventListener("blur", () => saveField(c.id, { name: $("ctName").value.trim() }));
    $("ctPhone").addEventListener("blur", () => saveField(c.id, { phone: $("ctPhone").value.trim() }));
    $("ctOrg").addEventListener("blur", () => saveField(c.id, { organization: $("ctOrg").value.trim() }));
    $("ctTitle").addEventListener("blur", () => saveField(c.id, { job_title: $("ctTitle").value.trim() }));
    $("ctNotes").addEventListener("blur", () => saveField(c.id, { notes: $("ctNotes").value.trim() }));

    // Important toggle
    $("ctImpBtn").addEventListener("click", () => toggleImportant(c));
    // Email link → opens compose with To: contact pre-filled (we don't have
    // compose-with-prefill yet, so just bring them to the inbox for now).
    $("ctEmailBtn").addEventListener("click", () => {
      window.location.href = `/?compose=${encodeURIComponent(c.email)}`;
    });
    // Delete
    $("ctDelBtn").addEventListener("click", () => deleteContact(c));
  }

  async function saveField(id, patch) {
    const c = state.contacts.find((x) => x.id === id);
    if (!c) return;
    // Skip if no actual change
    const key = Object.keys(patch)[0];
    if ((c[key] || "") === (patch[key] || "")) return;
    const statusEl = $("ctSaveStatus");
    if (statusEl) { statusEl.textContent = "Saving…"; statusEl.className = "ct-status"; }
    try {
      const r = await fetch(`/api/contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const updated = await r.json();
      // Update in our local list + re-paint list (so name change shows up).
      const idx = state.contacts.findIndex((x) => x.id === id);
      if (idx >= 0) state.contacts[idx] = updated;
      renderList();
      if (statusEl) { statusEl.textContent = "Saved ✓"; statusEl.className = "ct-status ok"; }
    } catch (err) {
      if (statusEl) { statusEl.textContent = `Save failed: ${err.message}`; statusEl.className = "ct-status error"; }
    }
  }

  async function toggleImportant(c) {
    try {
      if (c.is_important) {
        // Need the important_contacts row id to delete. The /api/important-contacts
        // list returns it; fetch + find by email match.
        const r = await fetch("/api/important-contacts");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const match = (data.contacts || []).find((x) => x.email.toLowerCase() === c.email.toLowerCase());
        if (match) {
          await fetch(`/api/important-contacts/${match.id}`, { method: "DELETE" });
        }
      } else {
        await fetch("/api/important-contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: c.email, name: c.name }),
        });
      }
      // Refresh contact's is_important state by reloading list.
      await loadContacts();
      // Keep selection.
      selectContact(c.id);
    } catch (err) {
      alert(`Couldn't update Important list: ${err.message}`);
    }
  }

  async function deleteContact(c) {
    if (!confirm(`Delete ${c.name}? This only removes them from your contacts list — the email history stays.`)) return;
    try {
      const r = await fetch(`/api/contacts/${c.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.contacts = state.contacts.filter((x) => x.id !== c.id);
      state.selectedId = null;
      renderList();
      renderDetail();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  // ---------- search + sort ----------
  let searchDebounce;
  $("ctSearch").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadContacts, 200);
  });
  document.querySelectorAll(".ct-sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll(".ct-sort-btn").forEach((x) => x.classList.toggle("active", x === btn));
      loadContacts();
    });
  });

  // ---------- extract from inbox ----------
  $("ctExtractBtn").addEventListener("click", async () => {
    const btn = $("ctExtractBtn");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = `<span>Scanning…</span>`;
    try {
      const r = await fetch("/api/contacts/extract-from-inbox", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      await loadContacts();
      alert(`Refresh complete — ${data.added} new contact${data.added === 1 ? "" : "s"} added, ${data.refreshed} updated.`);
    } catch (err) {
      alert(`Refresh failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  // ---------- create modal ----------
  $("ctNewBtn").addEventListener("click", openCreateModal);
  $("ctModalClose").addEventListener("click", closeCreateModal);
  $("ctModalBackdrop").addEventListener("click", closeCreateModal);
  $("ctModalCancel").addEventListener("click", closeCreateModal);
  $("ctModalSave").addEventListener("click", saveNewContact);

  function openCreateModal() {
    $("newCtName").value = "";
    $("newCtEmail").value = "";
    $("newCtPhone").value = "";
    $("newCtOrg").value = "";
    $("newCtTitle").value = "";
    $("newCtNotes").value = "";
    $("ctModalStatus").textContent = "";
    $("ctModalStatus").className = "ct-status";
    $("ctModal").classList.add("open");
    $("ctModalBackdrop").classList.add("open");
    setTimeout(() => $("newCtName").focus(), 40);
  }
  function closeCreateModal() {
    $("ctModal").classList.remove("open");
    $("ctModalBackdrop").classList.remove("open");
  }
  async function saveNewContact() {
    const name = $("newCtName").value.trim();
    const email = $("newCtEmail").value.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      $("ctModalStatus").textContent = "A valid email is required.";
      $("ctModalStatus").className = "ct-status error";
      return;
    }
    const btn = $("ctModalSave");
    btn.disabled = true;
    $("ctModalStatus").textContent = "Saving…";
    $("ctModalStatus").className = "ct-status";
    try {
      const r = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || email.split("@")[0],
          email,
          phone: $("newCtPhone").value.trim(),
          organization: $("newCtOrg").value.trim(),
          job_title: $("newCtTitle").value.trim(),
          notes: $("newCtNotes").value.trim(),
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${r.status}`);
      }
      const created = await r.json();
      closeCreateModal();
      await loadContacts();
      selectContact(created.id);
    } catch (err) {
      $("ctModalStatus").textContent = `Save failed: ${err.message}`;
      $("ctModalStatus").className = "ct-status error";
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- boot ----------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCreateModal();
  });
  (async function init() {
    // On first load, auto-extract from inbox so the user sees contacts
    // immediately instead of an empty page. Fire-and-forget — list reload
    // covers the result.
    fetch("/api/contacts/extract-from-inbox", { method: "POST" })
      .then(() => loadContacts())
      .catch(() => loadContacts());
  })();
})();
