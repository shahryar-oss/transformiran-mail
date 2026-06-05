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

  // ===== Phase 5.AP — Recipient autocomplete + @mention =================
  // Shared in-flight cache so a single keystroke doesn't fire ten requests.
  let _suggestAbort = null;
  let _suggestCache = new Map(); // q.toLowerCase() → suggestions[]

  async function fetchSuggestions(query, limit = 8) {
    const key = `${query.toLowerCase()}|${limit}`;
    if (_suggestCache.has(key)) return _suggestCache.get(key);
    // Cancel any in-flight earlier request so we don't race.
    try { _suggestAbort?.abort(); } catch (_) {}
    _suggestAbort = new AbortController();
    try {
      const r = await fetch(
        `/api/contacts/suggest?q=${encodeURIComponent(query)}&limit=${limit}`,
        { signal: _suggestAbort.signal }
      );
      if (!r.ok) return [];
      const data = await r.json();
      const sug = data.suggestions || [];
      _suggestCache.set(key, sug);
      // Bound the cache so it doesn't grow forever.
      if (_suggestCache.size > 60) {
        const firstKey = _suggestCache.keys().next().value;
        _suggestCache.delete(firstKey);
      }
      return sug;
    } catch (err) {
      if (err.name === "AbortError") return [];
      console.warn("[suggest] fetch failed:", err);
      return [];
    }
  }

  // Returns the prefix the user is currently typing (the substring
  // after the last "," in the field, trimmed). Empty string when
  // they're at the start of a new chip.
  function currentTokenInRecipientField(input) {
    const v = input.value;
    const lastComma = v.lastIndexOf(",");
    return v.slice(lastComma + 1).trim();
  }

  // Replace the currently-typed token in a recipient field with the
  // chosen "Name <email>" string, then add a trailing ", " so the
  // user can keep adding more without retyping.
  function applyRecipientChoice(input, choice) {
    const v = input.value;
    const lastComma = v.lastIndexOf(",");
    const before = lastComma >= 0 ? v.slice(0, lastComma + 1) + " " : "";
    const chip = choice.name && choice.name !== choice.email
      ? `"${choice.name}" <${choice.email}>`
      : choice.email;
    input.value = `${before}${chip}, `;
    input.focus();
    // Move caret to end so next keystroke appends.
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function buildSuggestDropdown(input) {
    let dropdown = input._suggestEl;
    if (dropdown) return dropdown;
    dropdown = document.createElement("div");
    dropdown.className = "rcpt-suggest";
    dropdown.hidden = true;
    document.body.appendChild(dropdown);
    input._suggestEl = dropdown;

    function position() {
      const rect = input.getBoundingClientRect();
      dropdown.style.left = rect.left + window.scrollX + "px";
      dropdown.style.top  = rect.bottom + window.scrollY + 2 + "px";
      dropdown.style.minWidth = rect.width + "px";
    }
    input.addEventListener("focus", position);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    dropdown.position = position;
    return dropdown;
  }

  function renderSuggestDropdown(dropdown, suggestions, selectedIdx) {
    if (!suggestions.length) {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      return;
    }
    dropdown.hidden = false;
    dropdown.innerHTML = suggestions.map((s, i) => `
      <div class="rcpt-suggest-item ${i === selectedIdx ? "active" : ""}" data-i="${i}">
        <span class="rs-name">${escapeHtml(s.name || s.email)}</span>
        ${s.name && s.name !== s.email ? `<span class="rs-email">${escapeHtml(s.email)}</span>` : ""}
        ${s.organization ? `<span class="rs-org">${escapeHtml(s.organization)}</span>` : ""}
        ${s.emailCount ? `<span class="rs-count">${s.emailCount}×</span>` : ""}
      </div>
    `).join("");
  }

  function attachRecipientAutocomplete(input) {
    if (!input || input._autocompleteAttached) return;
    input._autocompleteAttached = true;

    const dropdown = buildSuggestDropdown(input);
    let suggestions = [];
    let selectedIdx = 0;
    let debounceTimer = null;

    async function refresh() {
      const token = currentTokenInRecipientField(input);
      // Skip if the user already typed a full "Name <email>" — they're done.
      if (/<[^>]+>/.test(token)) {
        suggestions = [];
        renderSuggestDropdown(dropdown, [], 0);
        return;
      }
      suggestions = await fetchSuggestions(token, 8);
      selectedIdx = 0;
      dropdown.position?.();
      renderSuggestDropdown(dropdown, suggestions, selectedIdx);
    }

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 120);
    });
    input.addEventListener("focus", () => {
      // Show recents on first focus when field is empty.
      if (!currentTokenInRecipientField(input)) refresh();
    });
    input.addEventListener("blur", () => {
      // Delay hide so click on a row registers first.
      setTimeout(() => { dropdown.hidden = true; }, 150);
    });
    input.addEventListener("keydown", (e) => {
      if (dropdown.hidden || !suggestions.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % suggestions.length;
        renderSuggestDropdown(dropdown, suggestions, selectedIdx);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIdx = (selectedIdx - 1 + suggestions.length) % suggestions.length;
        renderSuggestDropdown(dropdown, suggestions, selectedIdx);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyRecipientChoice(input, suggestions[selectedIdx]);
        suggestions = [];
        dropdown.hidden = true;
      } else if (e.key === "Escape") {
        dropdown.hidden = true;
      }
    });
    dropdown.addEventListener("mousedown", (e) => {
      // mousedown fires before blur — pick the item BEFORE the input
      // hides the dropdown.
      const row = e.target.closest("[data-i]");
      if (!row) return;
      e.preventDefault();
      const idx = Number(row.dataset.i);
      const choice = suggestions[idx];
      if (choice) {
        applyRecipientChoice(input, choice);
        suggestions = [];
        dropdown.hidden = true;
      }
    });
  }

  // ---------- @mention promotion in body textarea -------------------
  // Typing "@" in the body opens a contact menu near the caret. On
  // select:
  //   - If the chosen contact's email is in Cc, move them to To.
  //   - Otherwise if they're not in To either, add them to To.
  //   - The "@Name" trigger in the textarea is replaced with the
  //     person's display name (without email), so the body reads
  //     naturally.
  // ---------- Language-mismatch chip (Phase 5.AT) ------------------
  // Watches the draft body for English (or any-other-Latin) text
  // when the parent message was in Farsi / Armenian / Russian / etc.
  // After ~80 chars of mismatched prose, shows a chip in the
  // composer asking if the user wants Delta to translate the reply
  // back into the parent's language. One click → Delta translates
  // the prose section of the body (preserving the quoted history) +
  // replaces it.
  function attachLanguageMismatchChip(composer, bodyEditable, parentLang) {
    if (!composer || !bodyEditable || !parentLang) return;
    if (composer._langChipAttached) return;
    composer._langChipAttached = true;

    let dismissed = false;
    let chip = null;

    const removeChip = () => {
      if (chip) { chip.remove(); chip = null; }
    };

    const showChip = () => {
      if (chip || dismissed) return;
      chip = document.createElement("div");
      chip.className = "lang-mismatch-chip";
      chip.innerHTML = `
        <span class="lmc-text">
          <img class="k-logo-inline" src="/delta-logo.png" alt="Delta">
          The original was in <strong>${escapeHtml(parentLang.name)}</strong>. Send your reply in ${escapeHtml(parentLang.name)}?
        </span>
        <button class="lmc-yes" type="button">Yes — translate</button>
        <button class="lmc-no" type="button" title="Dismiss">×</button>
      `;
      // Insert above the body editor, below the To/Cc fields.
      const fieldsEl = composer.querySelector(".draft-fields") || bodyEditable;
      fieldsEl.insertAdjacentElement("afterend", chip);

      chip.querySelector(".lmc-no").addEventListener("click", () => {
        dismissed = true;
        removeChip();
      });
      chip.querySelector(".lmc-yes").addEventListener("click", () => {
        translateProseToParentLang(chip, bodyEditable, parentLang);
      });
    };

    // Extract just the user's prose (before the quoted-history block)
    // and check if it looks like a different script than parentLang.
    const checkProse = () => {
      const fullText = bodyEditable.innerText || "";
      // Split off the Outlook-style separator if present.
      const sepIdx = fullText.search(/_{20,}/);
      const prose = sepIdx > 0 ? fullText.slice(0, sepIdx) : fullText;
      if (prose.trim().length < 80) { removeChip(); return; }
      const proseLang = detectScriptLanguage(prose);
      // If user's prose is in the same language as parent (or both
      // Latin scripts), no mismatch.
      if (proseLang && proseLang.code === parentLang.code) {
        removeChip();
        return;
      }
      // Prose looks Latin / English — parent was non-Latin. Mismatch.
      if (!proseLang) {
        showChip();
      } else {
        // Prose is some OTHER non-Latin (e.g. user typed Russian, parent
        // was Farsi) — also a mismatch but uncommon; show chip too.
        showChip();
      }
    };

    let debounceTimer = null;
    bodyEditable.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkProse, 700);
    });
  }

  // Call Delta to translate the prose portion of the draft body into
  // parentLang. Preserves the quoted history (everything from the
  // _______ separator onwards stays as-is).
  async function translateProseToParentLang(chip, bodyEditable, parentLang) {
    const yesBtn = chip.querySelector(".lmc-yes");
    yesBtn.disabled = true;
    yesBtn.textContent = "Translating…";

    const fullHtml = bodyEditable.innerHTML || "";
    const fullText = bodyEditable.innerText || "";
    const sepIdx = fullText.search(/_{20,}/);
    const proseText = sepIdx > 0 ? fullText.slice(0, sepIdx).trim() : fullText.trim();
    if (!proseText) {
      chip.remove();
      return;
    }

    try {
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Translate the following text into natural ${parentLang.name}. Match the tone (warm, professional) and preserve any names / amounts / dates verbatim. Output ONLY the translation, no preamble.\n\nText:\n${proseText}`,
          history: [],
        }),
      });
      if (!r.ok) throw new Error("translate failed");
      const data = await r.json();
      const translated = (data.reply || "").trim();
      if (!translated) throw new Error("empty translation");

      // Rebuild the body: translated prose + quoted history (if any).
      // We re-render prose as HTML <div>s + preserve everything from
      // the separator onwards.
      const escHtml = (s) => String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const proseHtml = escHtml(translated)
        .split(/\n{2,}/)
        .map((p) => `<div>${p.replace(/\n/g, "<br>")}</div>`)
        .join(`<div><br></div>`);

      // Extract the quoted-history HTML by finding the separator div
      // in the original innerHTML and keeping everything from it on.
      let quotedHtml = "";
      const sepHtmlIdx = fullHtml.indexOf("_______");
      if (sepHtmlIdx >= 0) {
        // Walk back to the nearest <div> start to keep DOM intact.
        const before = fullHtml.slice(0, sepHtmlIdx);
        const divStart = before.lastIndexOf("<div");
        if (divStart >= 0) {
          quotedHtml = fullHtml.slice(divStart);
        }
      }

      bodyEditable.innerHTML = `${proseHtml}${quotedHtml ? `<div><br></div>${quotedHtml}` : ""}`;
      chip.remove();
    } catch (err) {
      yesBtn.disabled = false;
      yesBtn.textContent = "Yes — translate";
      const note = document.createElement("span");
      note.style.cssText = "color: var(--red); font-size: 12px; margin-left: 8px;";
      note.textContent = "Translate failed";
      chip.appendChild(note);
      setTimeout(() => note.remove(), 3000);
      console.warn("[lang-mismatch] translate failed:", err);
    }
  }

  function attachMentionMenu(textarea, toInput, ccInput) {
    if (!textarea || textarea._mentionAttached) return;
    textarea._mentionAttached = true;

    const menu = document.createElement("div");
    menu.className = "mention-menu";
    menu.hidden = true;
    document.body.appendChild(menu);

    let triggerStart = -1; // index of "@" in textarea.value
    let suggestions = [];
    let selectedIdx = 0;

    function close() {
      menu.hidden = true;
      menu.innerHTML = "";
      triggerStart = -1;
      suggestions = [];
    }

    function position() {
      // Best-effort: place menu below the textarea, aligned to its
      // left edge. Could compute per-caret pixel position but
      // bottom-of-field is fine for now.
      const rect = textarea.getBoundingClientRect();
      menu.style.left = rect.left + window.scrollX + "px";
      menu.style.top  = rect.bottom + window.scrollY - 200 + "px"; // float over bottom of textarea
      menu.style.minWidth = Math.min(rect.width, 360) + "px";
    }

    function render() {
      if (!suggestions.length) {
        menu.hidden = true;
        return;
      }
      menu.hidden = false;
      position();
      menu.innerHTML = suggestions.map((s, i) => `
        <div class="mention-item ${i === selectedIdx ? "active" : ""}" data-i="${i}">
          <span class="mm-name">${escapeHtml(s.name || s.email)}</span>
          ${s.name && s.name !== s.email ? `<span class="mm-email">${escapeHtml(s.email)}</span>` : ""}
        </div>
      `).join("");
    }

    function promote(choice) {
      // Remove "@<token>" from textarea where the trigger started.
      const v = textarea.value;
      const before = v.slice(0, triggerStart);
      // find next whitespace or end
      const after = v.slice(triggerStart);
      const endMatch = after.match(/^@\S*/);
      const end = endMatch ? triggerStart + endMatch[0].length : triggerStart + 1;
      const tail = v.slice(end);
      // Replace with the display name (just name, not email).
      const displayName = choice.name || choice.email;
      textarea.value = `${before}${displayName}${tail}`;
      textarea.setSelectionRange(before.length + displayName.length, before.length + displayName.length);
      textarea.focus();

      // Promote into recipient fields.
      const email = (choice.email || "").toLowerCase();
      if (!email) return;
      const ccVal = (ccInput?.value || "").toLowerCase();
      if (ccVal.includes(email)) {
        // Remove from Cc.
        ccInput.value = ccInput.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && !s.toLowerCase().includes(email))
          .join(", ");
        if (ccInput.value && !ccInput.value.endsWith(", ")) ccInput.value += ", ";
      }
      // Add to To if not already there.
      const toVal = (toInput?.value || "").toLowerCase();
      if (!toVal.includes(email)) {
        const chip = choice.name && choice.name !== choice.email
          ? `"${choice.name}" <${choice.email}>`
          : choice.email;
        const sep = toInput.value.trim() && !toInput.value.trim().endsWith(",") ? ", " : "";
        toInput.value = (toInput.value.trim() ? toInput.value.trim() + sep : "") + chip + ", ";
      }
    }

    textarea.addEventListener("keydown", (e) => {
      if (!menu.hidden && suggestions.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          selectedIdx = (selectedIdx + 1) % suggestions.length;
          render();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          selectedIdx = (selectedIdx - 1 + suggestions.length) % suggestions.length;
          render();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          promote(suggestions[selectedIdx]);
          close();
          return;
        }
        if (e.key === "Escape") {
          close();
          return;
        }
      }
    });

    textarea.addEventListener("input", async () => {
      const pos = textarea.selectionStart;
      const before = textarea.value.slice(0, pos);
      // Find the most recent "@" not preceded by a non-space character.
      const atMatch = before.match(/(^|\s)@(\S*)$/);
      if (!atMatch) {
        if (!menu.hidden) close();
        return;
      }
      triggerStart = before.length - atMatch[0].length + (atMatch[1] === "" ? 0 : 1); // skip preceding ws
      const token = atMatch[2];
      if (token.length === 0) {
        // Just typed "@" — show top recents.
        suggestions = await fetchSuggestions("", 6);
      } else if (token.length >= 1) {
        suggestions = await fetchSuggestions(token, 6);
      }
      selectedIdx = 0;
      render();
    });

    textarea.addEventListener("blur", () => {
      setTimeout(close, 150);
    });

    menu.addEventListener("mousedown", (e) => {
      const row = e.target.closest("[data-i]");
      if (!row) return;
      e.preventDefault();
      const idx = Number(row.dataset.i);
      const choice = suggestions[idx];
      if (choice) {
        promote(choice);
        close();
      }
    });
  }

  // Format a comma-separated recipient string (To: or Cc:) into pretty
  // "Name <email>" chips. Truncates after 3 names with a "+N more" link.
  function formatRecipients(raw) {
    if (!raw) return "";
    const parts = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseFrom);
    if (!parts.length) return escapeHtml(raw);
    const visible = parts.slice(0, 3);
    const overflow = parts.length - visible.length;
    return visible
      .map((p) =>
        p.name
          ? `<strong>${escapeHtml(p.name)}</strong> <span class="rh-email">&lt;${escapeHtml(p.email)}&gt;</span>`
          : `<strong>${escapeHtml(p.email)}</strong>`
      )
      .join(", ") + (overflow > 0 ? ` <span class="rh-more">+${overflow} more</span>` : "");
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

  // Phase 5.AK — pulse a red badge on the Promises rail item whenever
  // any commitment is overdue. Cheap fetch, runs on inbox open + every
  // 2 min while the tab is active.
  async function refreshPromisesBadge() {
    try {
      const r = await fetch("/api/commitments/stats");
      if (!r.ok) return;
      const s = await r.json();
      const badge = document.getElementById("promisesBadge");
      if (!badge) return;
      const overdue = s.overdue_count || 0;
      if (overdue > 0) {
        badge.textContent = String(overdue);
        badge.hidden = false;
        badge.className = "folder-badge folder-badge-red";
      } else if (s.open_count > 0) {
        badge.textContent = String(s.open_count);
        badge.hidden = false;
        badge.className = "folder-badge";
      } else {
        badge.hidden = true;
      }
    } catch (_) {}
  }
  refreshPromisesBadge();
  setInterval(refreshPromisesBadge, 120_000);

  // Folder + pagination state
  let _currentFolder = "inbox";
  let _currentQuery = "";
  let _currentLabelId = null;   // set when viewing a Gmail-label folder
  let _nextPageToken = null;
  // When editing an existing Gmail draft in the composer: { draftId,
  // threadId, inReplyTo, rowId }. Lets Send thread correctly + remove the
  // old draft. Null = composing a brand-new email.
  let _editingDraft = null;

  // Attachment-chip helpers (shared by reply + new-email composers).
  function fmtBytes(b) {
    b = Number(b) || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return Math.round(b / 1024) + " KB";
    return b + " B";
  }
  function iconForName(name) {
    const n = String(name || "").toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(n)) return "🖼️";
    if (/\.pdf$/.test(n)) return "📕";
    if (/\.(docx?|rtf|odt)$/.test(n)) return "📄";
    if (/\.(xlsx?|csv|ods)$/.test(n)) return "📊";
    if (/\.(pptx?|key|odp)$/.test(n)) return "📑";
    if (/\.(zip|rar|7z|gz|tar)$/.test(n)) return "🗜️";
    return "📎";
  }
  // Build one attachment card's HTML (status: uploading|ready|error).
  function attachChipHtml(a) {
    const ic = a.status === "uploading" ? "⏳" : a.status === "error" ? "⚠️" : iconForName(a.name);
    const cls = "draft-attach-chip" + (a.status === "error" ? " err" : "");
    const title = a.status === "error" ? (a.error || "Couldn't attach") : a.name;
    const sub = a.status === "error" ? (a.error || "failed")
      : a.status === "uploading" ? "uploading…"
      : a.inherited ? (a.size ? fmtBytes(a.size) + " · attached" : "attached")
      : (a.size ? fmtBytes(a.size) : "");
    // Inherited = the draft's existing attachments (re-sent server-side);
    // shown read-only (no × — they always travel with the edited draft).
    const xBtn = a.inherited ? ""
      : `<button class="dac-x" type="button" data-lid="${a.localId}" aria-label="Remove">×</button>`;
    return `<span class="${cls}" data-lid="${a.localId}" title="${escapeHtml(title)}">`
      + `<span class="dac-ic">${ic}</span>`
      + `<span class="dac-meta"><span class="dac-nm">${escapeHtml(a.name)}</span>`
      + (sub ? `<span class="dac-sz">${escapeHtml(sub)}</span>` : "")
      + `</span>`
      + xBtn + `</span>`;
  }

  const FOLDER_TITLES = {
    inbox:   "Inbox",
    starred: "Starred",
    sent:    "Sent",
    drafts:  "Drafts",
    archive: "Archive",
    trash:   "Trash",
  };

  // Phase 5.BN — voice.js calls this after email_action so the inbox
  // list reflects archived / trashed / read-state changes immediately.
  window.__refreshInboxList = () => loadInbox({ forceFresh: true }).catch(() => {});

  async function loadInbox(opts = {}) {
    const folder = opts.folder || _currentFolder;
    const q = opts.q !== undefined ? opts.q : _currentQuery;
    const labelId = opts.labelId !== undefined ? opts.labelId : _currentLabelId;
    const pageToken = opts.pageToken || null;
    const params = new URLSearchParams({ folder, limit: "30" });
    if (q) params.set("q", q);
    if (labelId) params.set("labelId", labelId);
    if (pageToken) params.set("pageToken", pageToken);
    if (opts.forceFresh) params.set("forceFresh", "1");
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
        const isStarred = Array.isArray(m.labelIds) && m.labelIds.includes("STARRED");
        const clip = m.hasAttachments ? `<span class="mail-attach-icon" title="Has attachment"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6h-1.5v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg></span>` : "";
        return `
          <div class="mail-row ${unreadCls}" data-id="${escapeHtml(m.id)}" data-thread-id="${escapeHtml(m.threadId || "")}">
            <div class="mail-avatar">${escapeHtml(initial)}</div>
            <div class="mail-body">
              <div class="mail-row-top">
                <div class="mail-sender" dir="auto">${senderLabel}</div>
                <div class="mail-row-top-right">${clip}<div class="mail-time">${when}</div></div>
              </div>
              <div class="mail-subject" dir="auto">${subj}</div>
              <div class="mail-row-meta">
                <span class="mail-tag-slot" data-tag-for="${escapeHtml(m.id)}"></span>
                <span class="mail-snippet" dir="auto">${snip}</span>
              </div>
            </div>
            <div class="mail-row-actions" data-actions-for="${escapeHtml(m.id)}">
              <button class="mra-btn" data-action="toggle-read" title="${m.unread ? "Mark read" : "Mark unread"}">
                <svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
              </button>
              <button class="mra-btn ${isStarred ? "starred" : ""}" data-action="toggle-star" title="${isStarred ? "Unstar" : "Star"}">
                <svg viewBox="0 0 24 24" ${isStarred ? "" : 'fill="none" stroke="currentColor" stroke-width="2"'}>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
              <button class="mra-btn" data-action="archive" title="Archive">
                <svg viewBox="0 0 24 24"><path d="M20.54 5.23l-1.39-1.68A1.45 1.45 0 0 0 18 3H6a1.45 1.45 0 0 0-1.15.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
              </button>
              <button class="mra-btn delete" data-action="trash" title="Delete">
                <svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>
            </div>
          </div>`;
      })
      .join("");

    listEl.querySelectorAll(".mail-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        // Don't open the email when clicking a quick-action button.
        if (e.target.closest(".mail-row-actions")) return;
        // In the Drafts folder, open the draft in the editable composer
        // (full editing tools) instead of the read-only reader.
        if (_currentFolder === "drafts") {
          openDraftForEdit(row.dataset.id, messages);
          return;
        }
        onSelect(row.dataset.id, messages);
      });
    });
    wireRowQuickActions(messages);
  }

  // Quick-actions that appear on .mail-row hover (Outlook-style).
  // Mark read/unread, star, archive, delete. Click stops propagation so the
  // row's own click handler doesn't open the email.
  function wireRowQuickActions(messages) {
    listEl.querySelectorAll(".mail-row-actions .mra-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (btn.disabled) return;
        const row = btn.closest(".mail-row");
        const id = row?.dataset.id;
        if (!id) return;
        const action = btn.dataset.action;
        btn.disabled = true;
        try {
          if (action === "toggle-read") {
            const isUnread = row.classList.contains("unread");
            await fetch(`/api/gmail/message/${encodeURIComponent(id)}/labels`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                isUnread ? { remove: ["UNREAD"] } : { add: ["UNREAD"] }
              ),
            });
            row.classList.toggle("unread");
            btn.title = isUnread ? "Mark unread" : "Mark read";
          } else if (action === "toggle-star") {
            const wasStarred = btn.classList.contains("starred");
            await fetch(`/api/gmail/message/${encodeURIComponent(id)}/labels`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                wasStarred ? { remove: ["STARRED"] } : { add: ["STARRED"] }
              ),
            });
            btn.classList.toggle("starred");
            // Repaint star icon (filled vs outline)
            btn.querySelector("svg")?.setAttribute("fill", btn.classList.contains("starred") ? "currentColor" : "none");
            if (btn.classList.contains("starred")) {
              btn.querySelector("svg")?.removeAttribute("stroke");
              btn.querySelector("svg")?.removeAttribute("stroke-width");
            } else {
              btn.querySelector("svg")?.setAttribute("stroke", "currentColor");
              btn.querySelector("svg")?.setAttribute("stroke-width", "2");
            }
            btn.title = btn.classList.contains("starred") ? "Unstar" : "Star";
          } else if (action === "archive") {
            await fetch(`/api/gmail/message/${encodeURIComponent(id)}/labels`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ remove: ["INBOX"] }),
            });
            removeFromList(id, "Archived");
          } else if (action === "trash") {
            await fetch(`/api/gmail/message/${encodeURIComponent(id)}/trash`, { method: "POST" });
            removeFromList(id, "Deleted");
          }
        } catch (err) {
          console.warn(`[mail-row-action ${action}]`, err);
          showToast(`${action} failed: ${err.message || err}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // ----- Quick filter pills (Phase 2c.3) --------------------------------
  // Filters the visible inbox list by classification. 'All' shows everything.
  // Counts update as classifications arrive.
  let _allMessages = [];
  let _classificationMap = {};
  let _autoReadTimer = null;   // dwell timer for auto-mark-read on open
  let _activeFilter = "all";

  // Delta-search filter mode — when the user clicks an email reference
  // from a Delta search_inbox result, the inbox temporarily shows ONLY
  // those results (with a banner offering "Clear" to restore).
  let _deltaSearchActive = false;
  let _deltaSearchSnapshot = null;   // saved _allMessages from before
  let _deltaSearchQuery = "";

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
        // Snoozed is its own data source — load via /api/inbox/snoozed
        // rather than filtering classifications.
        if (key === "snoozed") {
          loadSnoozedFolder(f);
          return;
        }
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

    // Snoozed folder loader — pulls from /api/inbox/snoozed (our DB) and
    // renders into the list. Each row gets an extra "wakes …" badge.
    async function loadSnoozedFolder(folderEl) {
      try {
        const r = await fetch("/api/inbox/snoozed");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        _allMessages = (data.messages || []).map((m) => ({
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          to: "",
          cc: "",
          subject: m.subject,
          snippet: m.snippet,
          date: m.date,
          internalDate: m.internalDate || null,
          labelIds: [],
          unread: false,
          _snoozeUntil: m.snoozeUntil,
        }));
        _currentFolder = "snoozed";
        _currentQuery = "";
        _nextPageToken = null;
        _classificationMap = {};
        document.querySelector(".folder.active")?.classList.remove("active");
        folderEl.classList.add("active");
        const titleEl = document.getElementById("listTitle");
        if (titleEl) titleEl.textContent = "Snoozed";
        renderList(_allMessages);
        // Update the rail count badge.
        const badge = document.getElementById("count-snoozed");
        if (badge) badge.textContent = _allMessages.length > 0 ? _allMessages.length : "";
      } catch (err) {
        showToast("Couldn't load snoozed: " + (err.message || err), "error");
      }
    }

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

  async function classifyVisible(messages, opts = {}) {
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
        body: JSON.stringify({ messages: payload, force: !!opts.force }),
      });
      if (!r.ok) return;
      const data = await r.json();
      paintClassifications(data.classifications || {});
      // After painting, drop replied threads out of the inbox view.
      if (data.liveSyncCount > 0) {
        autoArchiveDoneRows();
      }
      return data;
    } catch (err) {
      console.warn("[classify] failed:", err);
    }
  }

  // Re-classify button — force re-evaluation of all visible tags using the
  // latest classifier logic (helpful after we upgrade the prompt rules so
  // existing tags catch up without waiting for natural refresh).
  document.getElementById("reclassifyBtn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains("spinning")) return;
    btn.classList.add("spinning");
    btn.disabled = true;
    showToast("Re-classifying visible emails…", "ok");
    try {
      const data = await classifyVisible(_allMessages, { force: true });
      const n = data?.count || 0;
      showToast(`Re-classified ${n} email${n === 1 ? "" : "s"}`, "ok");
    } catch (err) {
      showToast("Re-classify failed: " + (err.message || err), "error");
    } finally {
      btn.classList.remove("spinning");
      btn.disabled = false;
    }
  });

  // Hide rows that just flipped to DONE via a Gmail-side reply (live sync
  // detected a SENT label). Threads marked Done because the user added the
  // email to To Do stay visible in inbox — they wanted to track it, not
  // hide it. We differentiate by the reason text stamped on the
  // classification row.
  function autoArchiveDoneRows() {
    let removed = 0;
    document.querySelectorAll(".mail-row").forEach((row) => {
      const id = row.dataset.id;
      const cls = _classificationMap[id];
      if (!cls || cls.category !== "DONE") return;
      if (row.classList.contains("filtered-out")) return;
      const reason = String(cls.reason || "").toLowerCase();
      // Only auto-archive when this DONE came from a real reply / live-sync.
      // Task-completion DONEs stay visible.
      if (!reason.includes("repl") && !reason.includes("live sync")) return;
      row.style.transition = "opacity .3s, transform .3s";
      row.style.opacity = "0";
      row.style.transform = "translateX(40px)";
      setTimeout(() => row.remove(), 300);
      removed++;
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

    // Phase 5.BK — surface the open message id so voice mode can pass
    // it to draft_reply / read_attachments without the user having to
    // dictate a Gmail message id out loud.
    window.__deltaOpenMessageId = id;
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
        <button class="tb-btn" data-tb="snooze" title="Snooze">
          <svg viewBox="0 0 24 24"><path d="M22 5.72l-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72zM7.88 3.39L6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37V8zM12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg> <span>Snooze</span>
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
        <div class="reader-subject" dir="auto">${escapeHtml(stub.subject)}</div>
        <div class="reader-headers">
          <div class="rh-row">
            <span class="rh-label">From</span>
            <span class="rh-value">
              <strong>${escapeHtml(f.name || f.email)}</strong>${f.name ? ` <span class="rh-email">&lt;${escapeHtml(f.email)}&gt;</span>` : ""}
              ${f.email && !isAlreadyImportant(f.email) ? `
                <button class="rh-add-important" id="rhAddImportant" data-email="${escapeHtml(f.email)}" data-name="${escapeHtml(f.name || f.email)}" title="Pin this sender as an Important folder">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                  Important
                </button>` : f.email && isAlreadyImportant(f.email) ? `
                <span class="rh-is-important" title="Already in your Important folders">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                  Important
                </span>` : ""}
            </span>
          </div>
          ${stub.to ? `
          <div class="rh-row">
            <span class="rh-label">To</span>
            <span class="rh-value" id="readerToValue">${formatRecipients(stub.to)}</span>
          </div>` : ""}
          <div class="rh-row" id="readerCcRow" hidden>
            <span class="rh-label">Cc</span>
            <span class="rh-value" id="readerCcValue"></span>
          </div>
          <div class="rh-row rh-date">
            <span class="rh-label">Date</span>
            <span class="rh-value">${escapeHtml(stub.date || "")}</span>
          </div>
        </div>
        <!-- Attachment chips render here once /api/gmail/message/:id resolves. -->
        <div class="reader-attachments-bar" id="readerAttachmentsBar" hidden></div>
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
          <button class="btn delta-btn" data-action="add-todo" title="Extract action items into your To Do">
            <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Add to To Do
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

    // Auto-mark-read on open. After a short dwell (so rapid j/k navigation
    // doesn't clear every message you pass), tell Gmail to drop the UNREAD
    // label. This hits Gmail's REAL modify, so the unread state also clears
    // in the Gmail app and in Outlook — the whole mailbox is one source of
    // truth. Cancelled if the user opens a different message first.
    clearTimeout(_autoReadTimer);
    if (isUnread) {
      _autoReadTimer = setTimeout(() => {
        if (window.__deltaOpenMessageId !== id) return; // moved on — skip
        modifyLabels(id, null, {
          remove: ["UNREAD"],
          onSuccess: () => {
            const r2 = document.querySelector(`.mail-row[data-id="${CSS.escape(id)}"]`);
            if (r2) r2.classList.remove("unread");
            if (stub) {
              stub.unread = false;
              if (Array.isArray(stub.labelIds)) stub.labelIds = stub.labelIds.filter((l) => l !== "UNREAD");
            }
            // Flip the reader's toggle so it now offers "Mark unread".
            const ub = readerEl.querySelector('[data-tb="unread"] span');
            if (ub) ub.textContent = "Mark unread";
            updateFilterCounts();
            loadCounts();
          },
        });
      }, 1200);
    }

    // "+ Important" — one-click promote the sender into the user's
    // Important folders list. Re-renders the rail + the reader header.
    const addImportantBtn = readerEl.querySelector("#rhAddImportant");
    addImportantBtn?.addEventListener("click", async () => {
      addImportantBtn.disabled = true;
      await addSenderToImportant(addImportantBtn.dataset.email, addImportantBtn.dataset.name);
      // Re-render the reader head so the chip flips to the "already" state.
      onSelect(id, messages);
    });

    // Fetch full body.
    const bodyEl = document.getElementById("readerBody");
    try {
      // Phase 5.AL — kick off body + extract IN PARALLEL. Body usually
      // resolves first (Gmail fetch is fast); extract takes a Claude
      // hop. Renders independently so the user sees the body
      // immediately and the action items / smart replies fade in.
      const bodyPromise    = fetch(`/api/gmail/message/${encodeURIComponent(id)}`);
      const extractPromise = fetch(`/api/messages/${encodeURIComponent(id)}/extract`);

      const r = await bodyPromise;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      // Update To with full data (more accurate than the stub).
      const toValue = document.getElementById("readerToValue");
      if (toValue && data.headers?.to) {
        toValue.innerHTML = formatRecipients(data.headers.to);
      }
      // Show Cc row if present.
      const ccRow = document.getElementById("readerCcRow");
      const ccValue = document.getElementById("readerCcValue");
      if (data.headers?.cc && ccRow && ccValue) {
        ccValue.innerHTML = formatRecipients(data.headers.cc);
        ccRow.hidden = false;
      }

      renderBody(bodyEl, data);

      // Phase 5.AL — when extract resolves, render action item card
      // + smart reply chips. Best-effort: failures hide silently.
      extractPromise
        .then((er) => er.ok ? er.json() : null)
        .then((ed) => {
          if (!ed) return;
          if (ed.action_items?.length) renderActionItemsCard(id, ed.action_items, stub);
          if (ed.smart_replies?.length) renderSmartReplyChips(id, ed.smart_replies, stub, data);
        })
        .catch(() => {});
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
      // Phase 5.BO — allow-popups lets links inside the email body open
      // in a new tab when clicked (`<base target="_blank">` in
      // wrapHtmlBody routes them there). allow-popups-to-escape-sandbox
      // means the popup tab is a normal browser tab, not stuck in the
      // sandbox. Scripts are still blocked (no allow-scripts).
      iframe.sandbox = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";
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

    // Attachments now render in the header bar (above the body) — Outlook-style.
    // Populate that bar from data.attachments. Each chip is clickable to
    // download via the new /api/gmail/message/:id/attachment/:aId endpoint.
    renderAttachmentsBar(data);

    // Phase 5.AT — inline translate chip for non-English emails.
    // Detect script of the body. If Farsi / Arabic / Armenian /
    // Cyrillic / Chinese / Hebrew, append a small "Translate" pill
    // under the body so the user can flip to English in one click
    // without going through the toolbar.
    renderInlineTranslateChip(bodyEl, data, text);
  }

  // ---------- LANGUAGE DETECTION (Phase 5.AT) ----------------------
  // Quick script-based language detect — looks for distinctive
  // Unicode ranges that signal a non-Latin language. Returns a
  // language code + display name, or null when text looks Latin/EN.
  function detectScriptLanguage(text) {
    if (!text) return null;
    const sample = String(text).slice(0, 2000);
    // Count distinctive characters per script.
    const counts = {
      fa: (sample.match(/[؀-ۿݐ-ݿࢠ-ࣿ]/g) || []).length,
      hy: (sample.match(/[԰-֏]/g) || []).length,
      ru: (sample.match(/[Ѐ-ӿ]/g) || []).length,
      zh: (sample.match(/[一-鿿㐀-䶿]/g) || []).length,
      he: (sample.match(/[֐-׿יִ-ﭏ]/g) || []).length,
    };
    // Need at least 20 chars of a non-Latin script to flag.
    let best = null;
    let bestCount = 19;
    for (const code of Object.keys(counts)) {
      if (counts[code] > bestCount) {
        best = code;
        bestCount = counts[code];
      }
    }
    if (!best) return null;
    const names = { fa: "Farsi", hy: "Armenian", ru: "Russian", zh: "Chinese", he: "Hebrew" };
    return { code: best, name: names[best] };
  }

  // Renders a small "Translate from X" chip under the body when the
  // email isn't in English / Latin script. Clicking the chip pops a
  // delta-action-card with the translation.
  function renderInlineTranslateChip(bodyEl, data, plainText) {
    if (!bodyEl) return;
    // Avoid duplicates on re-render.
    bodyEl.querySelector(".inline-translate-chip")?.remove();
    // Sample both plain text and (stripped) HTML.
    const sample = plainText
      || (data?.body?.html ? data.body.html.replace(/<[^>]+>/g, " ") : "")
      || data?.snippet || "";
    const lang = detectScriptLanguage(sample);
    if (!lang) return;

    const wrap = document.createElement("div");
    wrap.className = "inline-translate-chip";
    wrap.innerHTML = `
      <button class="itc-btn" type="button" title="Translate to English">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>
        Translate from ${escapeHtml(lang.name)}
      </button>
    `;
    bodyEl.appendChild(wrap);
    wrap.querySelector(".itc-btn").addEventListener("click", () => {
      const stub = _allMessages.find((m) => m.id === data.id) || { id: data.id, threadId: data.threadId, subject: data.headers?.subject || "", from: data.headers?.from || "" };
      // Reuse the standard Delta action card.
      openDeltaActionCard("translate", stub);
    });
  }

  // ---------- Action items card (Phase 5.AL) -----------------------
  // Renders at the top of the reader body when Delta extracts asks
  // the sender made of the user. Each item has Add-to-tasks + dismiss.
  function renderActionItemsCard(messageId, items, stub) {
    const bodyEl = document.getElementById("readerBody");
    if (!bodyEl || !items.length) return;
    // Don't double-render if user re-opened the same email.
    if (bodyEl.querySelector(".ai-card")) return;

    const card = document.createElement("div");
    card.className = "ai-card";
    card.innerHTML = `
      <div class="ai-card-head">
        <span class="ai-card-title">
          <img class="k-logo-inline" src="/delta-logo.png" alt="Delta">
          What they're asking you to do
        </span>
        <button class="ai-card-dismiss" title="Dismiss all">×</button>
      </div>
      <ul class="ai-card-list">
        ${items.map((it, i) => `
          <li class="ai-item ai-item-${escapeHtml(it.urgency || "low")}" data-i="${i}">
            <div class="ai-item-row">
              <div class="ai-item-text">
                <span class="ai-item-bullet"></span>
                <span class="ai-item-label" dir="auto">${escapeHtml(it.text)}</span>
                ${it.due_text ? `<span class="ai-item-due">${escapeHtml(it.due_text)}</span>` : ""}
              </div>
              <div class="ai-item-actions">
                <button class="ai-item-reply" data-i="${i}" title="Draft a reply">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
                  Reply
                </button>
                <button class="ai-item-add" data-i="${i}" title="Add to To Do">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>
                  Add
                </button>
              </div>
            </div>
            <div class="ai-item-picker" data-picker="${i}" hidden>
              <div class="ai-picker-label">Pick a response — Delta will draft it:</div>
              <div class="ai-picker-options">
                <button class="ai-picker-opt" data-intent="confirm">
                  <span class="ai-picker-opt-icon">✓</span>
                  <span>Confirm — agree</span>
                </button>
                <button class="ai-picker-opt" data-intent="push-back">
                  <span class="ai-picker-opt-icon">↺</span>
                  <span>Push back politely</span>
                </button>
                <button class="ai-picker-opt" data-intent="more-info">
                  <span class="ai-picker-opt-icon">?</span>
                  <span>Need more info</span>
                </button>
                <button class="ai-picker-opt" data-intent="delay">
                  <span class="ai-picker-opt-icon">⏱</span>
                  <span>Defer — get back later</span>
                </button>
                <button class="ai-picker-opt ai-picker-opt-other" data-intent="other">
                  <span class="ai-picker-opt-icon">✎</span>
                  <span>Other — type your own</span>
                </button>
              </div>
              <div class="ai-picker-custom" hidden>
                <input type="text" class="ai-picker-custom-input" placeholder="e.g. 'Yes but only after Friday, and add Pia to Cc'">
                <button class="ai-picker-custom-go btn primary">Draft</button>
              </div>
            </div>
          </li>
        `).join("")}
      </ul>
    `;
    // Insert AT TOP of the reader body.
    bodyEl.insertBefore(card, bodyEl.firstChild);

    // Wire dismiss-all.
    card.querySelector(".ai-card-dismiss").addEventListener("click", async () => {
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 240);
      // Persist dismissal so it doesn't come back on re-open.
      fetch(`/api/messages/${encodeURIComponent(messageId)}/extract/dismiss`, { method: "POST" }).catch(() => {});
    });

    // Phase 5.CB — Reply button reveals the response picker inline.
    card.querySelectorAll(".ai-item-reply").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = btn.dataset.i;
        const picker = card.querySelector(`.ai-item-picker[data-picker="${i}"]`);
        if (!picker) return;
        const isOpen = !picker.hasAttribute("hidden");
        // Close any other open pickers first (only one at a time).
        card.querySelectorAll(".ai-item-picker").forEach((p) => p.setAttribute("hidden", ""));
        if (!isOpen) picker.removeAttribute("hidden");
      });
    });

    // Wire each picker option → triggers the reply composer with a
    // tailored instruction for Delta.
    card.querySelectorAll(".ai-picker-opt").forEach((opt) => {
      opt.addEventListener("click", () => {
        const intent = opt.dataset.intent;
        const picker = opt.closest(".ai-item-picker");
        const i = Number(picker.dataset.picker);
        const item = items[i];
        if (!item) return;
        if (intent === "other") {
          // Show the custom input row, focus it.
          const custom = picker.querySelector(".ai-picker-custom");
          custom.removeAttribute("hidden");
          custom.querySelector(".ai-picker-custom-input").focus();
          return;
        }
        triggerReplyForIntent(messageId, stub, item, intent);
        picker.setAttribute("hidden", "");
      });
    });

    // Custom-text "Draft" button + Enter key.
    card.querySelectorAll(".ai-picker-custom").forEach((custom) => {
      const input = custom.querySelector(".ai-picker-custom-input");
      const go = custom.querySelector(".ai-picker-custom-go");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        const picker = custom.closest(".ai-item-picker");
        const i = Number(picker.dataset.picker);
        const item = items[i];
        if (!item) return;
        triggerReplyForIntent(messageId, stub, item, "other", text);
        picker.setAttribute("hidden", "");
        input.value = "";
        custom.setAttribute("hidden", "");
      };
      go.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    });

    // Phase 5.CB — fixed Add. The previous client called
    // /api/inbox/add-to-todo with the wrong shape (single-task fields
    // instead of items[] bulk shape), which is why every Add returned
    // "x failed". Now uses POST /api/tasks directly with the action
    // text as the task title + the open email as source link, so
    // 5.CA's auto-complete kicks in when the user replies.
    card.querySelectorAll(".ai-item-add").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const i = Number(btn.dataset.i);
        const item = items[i];
        if (!item) return;
        btn.disabled = true;
        btn.innerHTML = `<span class="ai-spinner"></span>`;
        try {
          const r = await fetch(`/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: item.text,
              due_at: item.due_at_iso || null,
              important: item.urgency === "high",
              in_my_day: item.urgency === "high",
              source_message_id: messageId,
              source_thread_id: stub?.threadId || null,
              notes: stub?.subject ? `From email: ${stub.subject}` : null,
            }),
          });
          if (!r.ok) throw new Error("HTTP " + r.status);
          btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;vertical-align:text-bottom"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg> Added`;
          btn.classList.add("ai-item-added");
          if (typeof showToast === "function") showToast("Added to To Do", "ok");
        } catch (err) {
          btn.innerHTML = "× failed";
          btn.disabled = false;
          console.warn("[ai-item add] failed:", err);
        }
      });
    });
  }

  // Phase 5.CB — open the reply composer for the current email, with
  // an `intent` instruction injected so Delta drafts the right tone.
  // Used by the action-item picker's preset options + Other custom path.
  function triggerReplyForIntent(messageId, stub, item, intent, customText) {
    // Map intent to an instruction Delta understands. The strings are
    // human-readable so the model can interpret them naturally.
    const intents = {
      "confirm":    `Confirm and agree with what they're asking: "${item.text}". Reply warmly and concisely.`,
      "push-back":  `Politely push back / decline on what they're asking: "${item.text}". Stay diplomatic but firm; offer a brief reason.`,
      "more-info":  `Reply asking for the specific information needed before answering "${item.text}". List what details I need.`,
      "delay":      `Acknowledge "${item.text}" and tell them I'll get back to them with a proper answer by a specific date. Suggest a reasonable timeframe.`,
      "other":      customText || "",
    };
    const instruction = intents[intent] || customText || "";
    if (!instruction) return;

    // Stash so openDraftComposer picks it up as the instruction seed
    // (instead of the user manually typing in the "extra instructions"
    // field after the composer opens).
    window._smartReplyPrefill = {
      messageId,
      intent: `action-item-${intent}`,
      instructions: instruction,
    };

    // Find the existing message stub in the inbox cache so the toolbar
    // Reply action wires up correctly; if it's not in the cache yet,
    // fall back to a synthetic stub with at least the messageId.
    const existing = _allMessages.find((m) => m.id === messageId) || {
      ...stub,
      id: messageId,
      threadId: stub?.threadId,
    };
    onToolbarAction("reply", existing);
  }

  // ---------- Sources Delta consulted (Phase 5.AO) -----------------
  // Renders inside the draft composer just under the confidence
  // banner. Collapsible. Shows the related threads + attachments
  // Delta read before generating the draft so the user can verify
  // that any claims in the draft are grounded.
  function renderGroundingPanel(composer, g) {
    if (!composer || !g) return;
    // Remove any prior panel before re-rendering (e.g. on Re-draft).
    composer.querySelector(".draft-grounding")?.remove();

    const totalSources = (g.relatedThreads?.length || 0) + (g.attachments?.length || 0);
    if (totalSources === 0) {
      // Still show a small "no sources found" note so user knows
      // Delta tried. Placed at the BOTTOM of the composer frame.
      const note = document.createElement("div");
      note.className = "draft-grounding empty";
      note.innerHTML = `
        <span class="dg-mini">
          <img class="k-logo-inline" src="/delta-logo.png" alt="Delta">
          No prior threads found on "<em>${escapeHtml(g.normalizedSubject || "this subject")}</em>" — draft based on the open email only.
        </span>`;
      // Append at the very bottom of the composer.
      composer.appendChild(note);
      return;
    }

    const panel = document.createElement("details");
    panel.className = "draft-grounding";
    panel.open = false;

    const threadsHtml = (g.relatedThreads || []).map((t) => {
      const date = t.date ? new Date(t.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
      return `
        <li class="dg-source">
          <button class="dg-open-link" type="button" data-msg-id="${escapeHtml(t.message_id)}" title="Open this thread">
            <span class="dg-meta">${escapeHtml(date)}</span>
            <span class="dg-from">${escapeHtml(parseFrom(t.from).name || parseFrom(t.from).email || t.from)}</span>
            <span class="dg-subject">${escapeHtml(t.subject || "(no subject)")}</span>
          </button>
        </li>
      `;
    }).join("");

    const attachmentsHtml = (g.attachments || []).map((a) => `
      <li class="dg-source dg-attachment">
        <span class="dg-att-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true" style="width:13px;height:13px;fill:currentColor;vertical-align:text-bottom"><path d="M16.5 6.5L9 14a2.5 2.5 0 0 0 3.5 3.5l8-8a4 4 0 0 0-5.7-5.7l-8.8 8.9a5.5 5.5 0 0 0 7.8 7.8l7.3-7.3 1.4 1.4-7.3 7.3a7.5 7.5 0 1 1-10.6-10.6l8.8-8.9a6 6 0 1 1 8.5 8.5l-8 8a4.5 4.5 0 0 1-6.4-6.4L15 5l1.5 1.5z"/></svg>
        </span>
        <span class="dg-filename">${escapeHtml(a.filename)}</span>
        <span class="dg-att-meta">${a.parsed ? "read" : (a.mime || "binary")} · ${a.sizeBytes ? Math.round(a.sizeBytes / 1024) + " KB" : "?"}</span>
      </li>
    `).join("");

    panel.innerHTML = `
      <summary class="dg-summary">
        <img class="k-logo-inline" src="/delta-logo.png" alt="Delta">
        <strong>Delta consulted ${totalSources} source${totalSources === 1 ? "" : "s"}</strong>
        <span class="dg-counts">${g.relatedThreads?.length || 0} thread${g.relatedThreads?.length === 1 ? "" : "s"}${g.attachments?.length ? `, ${g.attachments.length} attachment${g.attachments.length === 1 ? "" : "s"}` : ""}</span>
      </summary>
      <div class="dg-body">
        ${g.relatedThreads?.length ? `
          <div class="dg-section-label">Related threads (used for grounding)</div>
          <ul class="dg-list">${threadsHtml}</ul>
        ` : ""}
        ${g.attachments?.length ? `
          <div class="dg-section-label">Attachments</div>
          <ul class="dg-list">${attachmentsHtml}</ul>
        ` : ""}
        <div class="dg-foot">
          Delta is required to base every factual claim on these sources.
          If something in the draft isn't traceable here, treat it as a
          guess — Delta should have written "I'll check and revert" instead.
        </div>
      </div>
    `;

    // Wire click-through on related-thread links.
    panel.querySelectorAll(".dg-open-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.msgId;
        if (id && typeof window.openMailById === "function") {
          window.openMailById(id);
        }
      });
    });

    // Place at the BOTTOM of the composer frame, just under the
    // action row — small font, outside the email body itself,
    // visible whenever the draft is on screen.
    composer.appendChild(panel);
  }

  // ---------- Smart reply chips (Phase 5.AL) -----------------------
  // Three one-tap reply chips ABOVE the existing draft-reply button.
  // Each chip click opens the standard reply composer pre-filled with
  // the chip's draft body. User reviews + sends.
  function renderSmartReplyChips(messageId, replies, stub, fullData) {
    const actionsRow = document.querySelector(".reader-actions");
    if (!actionsRow || !replies.length) return;
    // Already rendered? Skip.
    if (actionsRow.parentElement.querySelector(".smart-reply-chips")) return;

    const chipsRow = document.createElement("div");
    chipsRow.className = "smart-reply-chips";
    chipsRow.innerHTML = `
      <span class="src-label">
        <img class="k-logo-inline" src="/delta-logo.png" alt="Delta">
        Quick reply:
      </span>
      ${replies.map((r, i) => `
        <button class="src-chip src-chip-${escapeHtml(r.intent || "commit")}" data-i="${i}" title="${escapeHtml(r.draft_body)}">
          ${escapeHtml(r.label)}
        </button>
      `).join("")}
    `;
    actionsRow.parentElement.insertBefore(chipsRow, actionsRow);

    // On chip click, open the standard reply composer with the chip's
    // draft body pre-filled. Reuses the existing onDeltaAction path
    // for the toolbar / open-reply flow.
    chipsRow.querySelectorAll(".src-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const i = Number(chip.dataset.i);
        const r = replies[i];
        if (!r) return;
        // Cheap pre-fill: just stash on a global the reply composer reads.
        window._smartReplyPrefill = {
          messageId,
          body: r.draft_body,
          intent: r.intent,
        };
        // Open reply with the prefill applied.
        if (typeof onDeltaAction === "function") {
          onDeltaAction("draft-reply", stub);
        }
      });
    });
  }

  // ---------- Attachments bar (in reader header) -------------------
  function renderAttachmentsBar(data) {
    const bar = document.getElementById("readerAttachmentsBar");
    if (!bar) return;
    const attachments = Array.isArray(data?.attachments) ? data.attachments : [];
    if (!attachments.length) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    const messageId = data.id;
    bar.innerHTML = `
      <div class="rab-chips">
        ${attachments.map((a, i) => attachmentChipHtml(messageId, a, i)).join("")}
      </div>
      ${attachments.length > 1
        ? `<button type="button" class="rab-all" id="rabDownloadAll">Download all</button>`
        : ""}
    `;

    // Phase 5.BP — left click opens the file INSIDE the inbox (modal
    // PDF/image viewer). No new tab, no download dialog. Holding the
    // modifier key still opens in a new tab (default browser
    // behaviour). The chip's anchor href is the inline-disposition
    // URL so the "Open externally" button in the modal works too.
    bar.querySelectorAll(".rab-chip").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        // Cmd/Ctrl/middle-click → let browser open in new tab.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        openAttachmentPreview({
          url: chip.dataset.url,
          filename: chip.dataset.filename,
          mimeType: chip.dataset.mime || "",
          sizeBytes: Number(chip.dataset.size || 0),
        });
      });
    });
    const dlAll = bar.querySelector("#rabDownloadAll");
    if (dlAll) {
      dlAll.addEventListener("click", () => {
        attachments.forEach((a, i) => {
          // Slight stagger so the browser doesn't block multi-downloads
          setTimeout(() => {
            const url = `/api/gmail/message/${encodeURIComponent(messageId)}/attachment/${encodeURIComponent(a.attachmentId)}?filename=${encodeURIComponent(a.filename || "attachment")}&mimeType=${encodeURIComponent(a.mimeType || "application/octet-stream")}`;
            triggerDownload(url, a.filename || "attachment");
          }, i * 250);
        });
      });
    }
  }

  function attachmentChipHtml(messageId, a, idx) {
    const filename = a.filename || "(unnamed)";
    const mimeType = a.mimeType || "application/octet-stream";
    const baseUrl = `/api/gmail/message/${encodeURIComponent(messageId)}/attachment/${encodeURIComponent(a.attachmentId)}?filename=${encodeURIComponent(filename)}&mimeType=${encodeURIComponent(mimeType)}`;
    // Phase 5.BO — PDFs / images / text get an inline-disposition URL
    // so left-click opens them in a new tab using the browser's native
    // viewer (no download dialog). Other types still force download
    // because there's no useful in-browser preview for them.
    const lower = (filename || "").toLowerCase();
    const previewable =
      mimeType === "application/pdf" || /\.pdf$/.test(lower) ||
      /^image\//i.test(mimeType) || /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lower) ||
      /^text\/plain/i.test(mimeType) || /\.(txt|md|log)$/.test(lower);
    const url = previewable ? `${baseUrl}&disposition=inline` : baseUrl;
    const iconSvg = attachmentIconFor(mimeType, filename);
    const target = previewable ? ` target="_blank" rel="noopener"` : ` download="${escapeHtml(filename)}"`;
    return `
      <a class="rab-chip" href="${url}"${target}
         data-url="${url}"
         data-filename="${escapeHtml(filename)}"
         data-mime="${escapeHtml(mimeType)}"
         data-size="${a.size || 0}"
         title="${escapeHtml(filename)}">
        <span class="rab-icon">${iconSvg}</span>
        <span class="rab-info">
          <span class="rab-name">${escapeHtml(filename)}</span>
          <span class="rab-meta">${fmtSize(a.size)}</span>
        </span>
      </a>`;
  }

  // Map MIME type / extension to a coloured icon glyph. Plain enough we
  // don't need an icon library — three buckets cover 95% of attachments.
  function attachmentIconFor(mimeType, filename) {
    const lower = (filename || "").toLowerCase();
    const isXls = /\.(xlsx?|csv)$/.test(lower) || mimeType.includes("spreadsheet") || mimeType.includes("csv");
    const isDoc = /\.docx?$/.test(lower) || mimeType.includes("wordprocessing") || mimeType === "application/msword";
    const isPdf = /\.pdf$/.test(lower) || mimeType.includes("pdf");
    const isImg = /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lower) || mimeType.startsWith("image/");
    const isPpt = /\.pptx?$/.test(lower) || mimeType.includes("presentation");
    const isZip = /\.(zip|tar|gz|7z|rar)$/.test(lower);
    let cls = "ft-generic", glyph = "FILE";
    if (isXls) { cls = "ft-xls";  glyph = "XLS"; }
    else if (isDoc) { cls = "ft-doc"; glyph = "DOC"; }
    else if (isPdf) { cls = "ft-pdf"; glyph = "PDF"; }
    else if (isImg) { cls = "ft-img"; glyph = "IMG"; }
    else if (isPpt) { cls = "ft-ppt"; glyph = "PPT"; }
    else if (isZip) { cls = "ft-zip"; glyph = "ZIP"; }
    return `
      <span class="ft-tile ${cls}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>
        <span class="ft-label">${glyph}</span>
      </span>`;
  }

  function triggerDownload(url, filename) {
    // Create a hidden anchor + click it. Browser handles the download
    // because the server sets Content-Disposition: attachment.
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }

  // Phase 5.BP — Outlook-style inline attachment preview modal.
  // Opens PDFs / images right inside the inbox via an <iframe> or
  // <img>, with no new browser tab and no download dialog. The user
  // still gets explicit Download + Open-externally buttons in the
  // modal header for the cases where they want those actions.
  function openAttachmentPreview({ url, filename, mimeType, sizeBytes }) {
    console.log("[att-preview] open:", { filename, mimeType, sizeBytes, url });
    const modal = document.getElementById("attachmentPreview");
    if (!modal) {
      console.warn("[att-preview] modal markup missing — falling back to new-tab");
      window.open(url, "_blank", "noopener");
      return;
    }
    const lower = (filename || "").toLowerCase();
    const isPdf =
      /pdf/.test(mimeType || "") || lower.endsWith(".pdf");
    const isImg =
      /^image\//i.test(mimeType || "") ||
      /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lower);
    const isText =
      /^text\/(plain|markdown|csv)/i.test(mimeType || "") ||
      /\.(txt|md|csv|log)$/.test(lower);

    // Build the inline-disposition URL (forced inline for the iframe
    // even if the chip's data-url already had it; defensive).
    let inlineUrl = url || "";
    if (!/[?&]disposition=/.test(inlineUrl) && (isPdf || isImg || isText)) {
      inlineUrl += (inlineUrl.includes("?") ? "&" : "?") + "disposition=inline";
    }

    // Strip ?disposition=inline for the Download button so it forces
    // a download via the server's default Content-Disposition: attachment.
    const downloadUrl = (url || "").replace(/([?&])disposition=inline(&|$)/, "$1").replace(/[?&]$/, "");

    // Header populate
    const nameEl = document.getElementById("attPreviewName");
    const metaEl = document.getElementById("attPreviewMeta");
    const iconEl = document.getElementById("attPreviewIcon");
    const dlEl = document.getElementById("attPreviewDownload");
    const exEl = document.getElementById("attPreviewExternal");
    const bodyEl = document.getElementById("attPreviewBody");
    if (nameEl) nameEl.textContent = filename || "Attachment";
    if (metaEl) {
      const parts = [];
      if (mimeType) parts.push(mimeType);
      if (sizeBytes) parts.push(fmtSize(sizeBytes));
      metaEl.textContent = parts.join(" · ");
    }
    if (iconEl) {
      const label = isPdf ? "PDF" : isImg ? "IMG" : isText ? "TXT" : "FILE";
      iconEl.textContent = label;
      iconEl.style.background =
        isPdf  ? "var(--red)"           :
        isImg  ? "#5b8def"              :
        isText ? "var(--navy)"          : "var(--gold-dark)";
    }
    if (dlEl) {
      dlEl.href = downloadUrl;
      dlEl.setAttribute("download", filename || "attachment");
    }
    if (exEl) {
      exEl.href = inlineUrl;
    }

    // Body content
    if (!bodyEl) return;
    bodyEl.innerHTML = "";
    if (isPdf || isText) {
      const iframe = document.createElement("iframe");
      iframe.src = inlineUrl;
      iframe.title = filename || "attachment";
      bodyEl.appendChild(iframe);
    } else if (isImg) {
      const img = document.createElement("img");
      img.src = inlineUrl;
      img.alt = filename || "image";
      bodyEl.appendChild(img);
    } else {
      // Unknown / unsupported — surface a friendly fallback with a
      // big Download button (no in-browser preview available).
      const fallback = document.createElement("div");
      fallback.className = "att-fallback";
      fallback.innerHTML = `
        <div style="font-size:42px;margin-bottom:14px">📎</div>
        <div style="font-size:16px;margin-bottom:6px"><strong>${escapeHtml(filename || "Attachment")}</strong></div>
        <div style="opacity:.7;margin-bottom:18px">In-browser preview isn't available for this file type. Download or open externally to view.</div>
      `;
      bodyEl.appendChild(fallback);
    }

    modal.hidden = false;
  }

  function closeAttachmentPreview() {
    const modal = document.getElementById("attachmentPreview");
    if (!modal) return;
    modal.hidden = true;
    // Clear the iframe src so the file stops streaming + frees memory.
    const bodyEl = document.getElementById("attPreviewBody");
    if (bodyEl) bodyEl.innerHTML = "";
  }

  // Wire close handlers once on boot.
  (function wireAttachmentPreview() {
    const closeBtn = document.getElementById("attPreviewClose");
    closeBtn?.addEventListener("click", closeAttachmentPreview);
    const modal = document.getElementById("attachmentPreview");
    modal?.querySelector(".att-preview-backdrop")?.addEventListener("click", closeAttachmentPreview);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const m = document.getElementById("attachmentPreview");
        if (m && !m.hidden) closeAttachmentPreview();
      }
    });
  })();

  function wrapHtmlBody(html) {
    // Minimal wrapper so links open in the parent window (target=_top) and
    // styling matches our reader. Sandbox blocks scripts even if anything
    // sneaks past the server-side sanitizer.
    // Phase 5.BD — RTL support.
    // `dir="auto"` on body + on every block-level child tells the browser
    // to pick direction from the first strong character per paragraph.
    // That gets Farsi/Arabic emails right-aligned automatically while
    // still letting an English signature in the same message stay LTR.
    return `<!doctype html><html dir="auto"><head><base target="_blank">
<style>
  /* Emails are authored for a light background, so we always render them on
     white — even in dark mode — so the sender's (usually dark) text stays
     readable. The app shell stays dark; the email shows as a light "sheet". */
  html, body { background: #ffffff; }
  body { margin: 0; padding: 0; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #282F39; unicode-bidi: plaintext; }
  body, p, div, blockquote, li, td, th { unicode-bidi: plaintext; }
  img { max-width: 100%; height: auto; }
  a { color: #8E6F35; }
  blockquote { border-left: 3px solid #E2DBC8; margin: 8px 0; padding: 4px 12px; color: #4A5260; }
  pre { white-space: pre-wrap; word-wrap: break-word; background: #F7F3E9; padding: 10px; border-radius: 6px; }
  table { border-collapse: collapse; max-width: 100%; }
  /* Reverse the blockquote bar for RTL paragraphs */
  [dir="rtl"] blockquote, blockquote[dir="rtl"] { border-left: none; border-right: 3px solid #E2DBC8; padding: 4px 12px 4px 4px; }
</style>
</head><body dir="auto">${html}</body></html>`;
  }

  function fmtSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // Delta action buttons in the reader.
  //   • 'Draft a reply' → inline draft composer in the MIDDLE pane.
  //   • Summarize / Translate / Ask about this → answer in the Delta
  //     CHAT panel (right side), keeping the email visible in the middle.
  //     If, from that conversation, the user then asks Delta to draft /
  //     compose / forward, that result opens in the MIDDLE composer
  //     (handled by the dock's renderToolEvents). This is the split the
  //     user asked for: reading-Q&A in chat, writing in the middle.
  //   • Add to To Do → still uses the middle-pane action card (it just
  //     creates tasks + offers an "Open To Do →" link).
  const CHAT_PANEL_PROMPTS = {
    summarize: "Summarize this email in 3 bullets.",
    translate: "Translate this email into English (or to whichever language I usually reply in if it's already in English).",
    explain:   "What is this email actually asking for? What should I do about it?",
  };
  function onDeltaAction(action, msg) {
    if (action === "draft-reply") {
      return openDraftComposer(msg);
    }
    if (CHAT_PANEL_PROMPTS[action] && typeof window.__deltaAskInPanel === "function") {
      // Pass the open email's id explicitly so "this email" resolves
      // server-side regardless of list selection / virtualization.
      return window.__deltaAskInPanel(CHAT_PANEL_PROMPTS[action], msg && msg.id);
    }
    return openDeltaActionCard(action, msg);
  }

  // ---------- DELTA ACTION CARD (Phase 5.AS) ------------------------
  // Docked card in the reader showing Delta's response to one of the
  // email actions (Summarize / Translate / Ask about this / Add to
  // To Do). Same red-bordered card styling as the draft composer.
  async function openDeltaActionCard(action, msg) {
    const bodyEl = document.getElementById("readerBody");
    if (!bodyEl) return;
    // Remove any prior delta action card / draft composer so only
    // one card sits in the reader at a time.
    document.querySelectorAll(".delta-action-card").forEach((c) => c.remove());

    const titles = {
      summarize: "Summary",
      translate: "Translation",
      explain:   "Delta — Ask about this email",
      "add-todo": "Add to To Do",
    };
    const prompts = {
      summarize: `Summarize this email in 3 bullets.`,
      translate: `Translate this email into English (or to whichever language I usually reply in if it's already in English).`,
      explain:   `What is this email actually asking for? What should I do about it?`,
      "add-todo": `Extract every action item from this email and create a separate To Do task for each one. Use create_task with source_message_id set to the open email's id so each task links back. Set due_at if a deadline is mentioned, in_my_day=true for anything due today, and important=true if the sender is a key person (Lana, Lazarus, Pia, Maggie). Don't draft a reply — just create the tasks. After all tools run, respond with one short line: "Added N tasks." (no bullets, no recap).`,
    };

    const card = document.createElement("div");
    card.className = "delta-action-card delta-action-" + action;
    card.innerHTML = `
      <div class="dac-head">
        <div class="dac-title">
          <img class="k-logo" src="/delta-logo.png" alt="Delta">
          <span>${escapeHtml(titles[action] || "Delta")}</span>
        </div>
        <button class="dac-close" title="Close">×</button>
      </div>
      <div class="dac-body">
        <div class="dac-loading">
          <span class="dac-spinner"></span>
          <span>Delta is working…</span>
        </div>
      </div>
      ${action === "explain" ? `
        <div class="dac-followup">
          <input type="text" class="dac-followup-input" placeholder="Ask a follow-up…">
          <button class="dac-followup-send" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
            Send
          </button>
        </div>` : ""}
      <div class="dac-actions"></div>
    `;
    bodyEl.prepend(card);

    const bodyDiv = card.querySelector(".dac-body");
    const actionsDiv = card.querySelector(".dac-actions");
    const closeBtn = card.querySelector(".dac-close");
    closeBtn.addEventListener("click", () => card.remove());

    // History for follow-up Q&A on "explain" action.
    const localHistory = [];

    // Fire the initial Delta call.
    const fireDelta = async (userMsg, append = false) => {
      const loadingHtml = `<div class="dac-loading"><span class="dac-spinner"></span><span>Delta is working…</span></div>`;
      if (append) {
        const sep = document.createElement("div");
        sep.className = "dac-message dac-message-user";
        sep.textContent = userMsg;
        bodyDiv.appendChild(sep);
        const loading = document.createElement("div");
        loading.className = "dac-message dac-message-assistant dac-temp";
        loading.innerHTML = loadingHtml;
        bodyDiv.appendChild(loading);
        bodyDiv.scrollTop = bodyDiv.scrollHeight;
      } else {
        bodyDiv.innerHTML = loadingHtml;
      }
      try {
        const r = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMsg,
            history: localHistory,
            openMessageId: msg.id,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error || "Delta failed");
        const reply = data.reply || "(no reply)";
        localHistory.push({ role: "user", content: userMsg });
        localHistory.push({ role: "assistant", content: reply });

        // Phase 5.CX — the "Ask about this email" panel can trigger a
        // draft via a follow-up ("draft a reply, cc Lana"). It used to
        // render ONLY Delta's text, ignoring tool events, so the draft
        // was created server-side but NO composer ever opened — Delta
        // then hallucinated its location ("middle panel"… "right panel").
        // Mirror the main Delta dock: open the draft DIRECTLY in the
        // middle-pane composer. Opening it re-renders the reader, so this
        // action card is replaced by the live editable draft; we return
        // early to avoid showing the now-misleading "the draft is open"
        // text behind it.
        const composerEvent = (data.toolEvents || []).find(
          (ev) =>
            ev.result?.ok && ev.result.draft &&
            (ev.name === "draft_reply" ||
             ev.name === "compose_email" ||
             ev.name === "forward_email")
        );
        if (composerEvent) {
          card.querySelector(".dac-temp")?.remove();
          const d = composerEvent.result.draft;
          if (composerEvent.name === "draft_reply" &&
              typeof window.openComposerWithDraft === "function") {
            window.openComposerWithDraft(d, { keepDeltaOpen: true });
            return;
          }
          if ((composerEvent.name === "compose_email" ||
               composerEvent.name === "forward_email") &&
              typeof window.openNewEmailComposer === "function") {
            window.openNewEmailComposer({
              to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body,
            });
            return;
          }
        }
        // Tools that mutate the inbox (archive / label) — refresh the list
        // so the row updates after the action card finishes.
        if ((data.toolEvents || []).some(
              (ev) => ev.name === "email_action" && ev.result?.ok)) {
          if (typeof window.__refreshInboxList === "function") {
            window.__refreshInboxList();
          }
        }

        if (append) {
          card.querySelector(".dac-temp")?.remove();
          const replyEl = document.createElement("div");
          replyEl.className = "dac-message dac-message-assistant";
          replyEl.innerHTML = (typeof window.renderMarkdown === "function")
            ? window.renderMarkdown(reply)
            : escapeHtml(reply).replace(/\n/g, "<br>");
          bodyDiv.appendChild(replyEl);
          bodyDiv.scrollTop = bodyDiv.scrollHeight;
        } else {
          bodyDiv.innerHTML = (typeof window.renderMarkdown === "function")
            ? window.renderMarkdown(reply)
            : escapeHtml(reply).replace(/\n/g, "<br>");
        }

        // Footer actions: Copy result button (for all non-todo).
        if (action !== "add-todo") {
          actionsDiv.innerHTML = `<button class="dac-action-btn" data-act="copy">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;fill:currentColor;vertical-align:text-bottom;margin-right:4px"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>
            Copy
          </button>`;
          actionsDiv.querySelector("[data-act='copy']").addEventListener("click", (e) => {
            navigator.clipboard.writeText(reply).catch(() => {});
            e.currentTarget.textContent = "✓ Copied";
            setTimeout(() => card.remove(), 600);
          });
        } else {
          // Add to To Do — refresh the rail badge after tasks created.
          actionsDiv.innerHTML = `<button class="dac-action-btn" data-act="open-todo">Open To Do →</button>`;
          actionsDiv.querySelector("[data-act='open-todo']").addEventListener("click", () => {
            window.location.href = "/tasks";
          });
          if (typeof refreshPromisesBadge === "function") refreshPromisesBadge();
        }
      } catch (err) {
        bodyDiv.innerHTML = `<div class="dac-error">Couldn't reach Delta: ${escapeHtml(err.message || String(err))}</div>`;
      }
    };
    fireDelta(prompts[action] || `Help me with this email.`);

    // Wire follow-up input for "explain" action.
    const followupInput = card.querySelector(".dac-followup-input");
    const followupSend = card.querySelector(".dac-followup-send");
    if (followupInput && followupSend) {
      followupInput.addEventListener("input", () => {
        followupSend.disabled = !followupInput.value.trim();
      });
      const submit = () => {
        const text = followupInput.value.trim();
        if (!text) return;
        followupInput.value = "";
        followupSend.disabled = true;
        fireDelta(text, true);
      };
      followupSend.addEventListener("click", submit);
      followupInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    }
  }

  // ---------- OUTLOOK-STYLE TOOLBAR ------------------------------------
  // Wires the Reply/Forward/Archive/Star/Unread/Delete buttons at the top
  // of the open email to real Gmail API actions.
  async function onToolbarAction(action, msg, btn) {
    if (action === "reply" || action === "reply-all") {
      // Use the existing draft composer — Delta will draft, user edits.
      return openDraftComposer(msg, { mode: action });
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
    if (action === "snooze") {
      return openSnoozePopover(msg, btn);
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

  // ---------- SNOOZE — quick-pick popover ----------
  // Six common options + Custom datetime. Sends POST /api/inbox/snooze and
  // removes the row on success. Worker re-adds INBOX + UNREAD at wake time.
  function openSnoozePopover(msg, anchorBtn) {
    const existing = document.getElementById("snoozePopover");
    if (existing) existing.remove();

    const options = computeSnoozeOptions();
    const pop = document.createElement("div");
    pop.id = "snoozePopover";
    pop.className = "snooze-popover";
    pop.innerHTML = `
      <div class="snz-head">Snooze until</div>
      ${options.map((o, i) => `
        <button class="snz-opt" data-iso="${o.iso}" type="button">
          <span class="snz-opt-label">${escapeHtml(o.label)}</span>
          <span class="snz-opt-when">${escapeHtml(o.when)}</span>
        </button>
      `).join("")}
      <button class="snz-opt snz-custom" data-action="custom" type="button">
        <span class="snz-opt-label">Pick a date / time…</span>
      </button>
    `;
    document.body.appendChild(pop);

    // Position near the anchor button. Fallback to center of screen.
    if (anchorBtn) {
      const rect = anchorBtn.getBoundingClientRect();
      const popH = 320; // approx max height
      let top = rect.bottom + 6;
      if (top + popH > window.innerHeight) top = Math.max(8, rect.top - popH - 6);
      pop.style.position = "fixed";
      pop.style.top = top + "px";
      pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 280)) + "px";
    }

    function close() { pop.remove(); document.removeEventListener("click", outsideClick, true); }
    function outsideClick(e) {
      if (!pop.contains(e.target) && e.target !== anchorBtn && !anchorBtn?.contains(e.target)) close();
    }
    setTimeout(() => document.addEventListener("click", outsideClick, true), 0);

    pop.querySelectorAll(".snz-opt").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.action === "custom") {
          close();
          openSnoozeCustomPicker(msg);
          return;
        }
        const iso = btn.dataset.iso;
        close();
        await doSnooze(msg, iso, btn.querySelector(".snz-opt-when")?.textContent || "later");
      });
    });
  }

  // Free-form datetime picker for "Custom..."
  function openSnoozeCustomPicker(msg) {
    const existing = document.getElementById("snoozeCustomModal");
    if (existing) existing.remove();
    const modal = document.createElement("div");
    modal.id = "snoozeCustomModal";
    modal.className = "snooze-custom-modal";
    const defaultDt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    defaultDt.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    const local = `${defaultDt.getFullYear()}-${pad(defaultDt.getMonth()+1)}-${pad(defaultDt.getDate())}T${pad(defaultDt.getHours())}:${pad(defaultDt.getMinutes())}`;
    modal.innerHTML = `
      <div class="snz-custom-backdrop"></div>
      <div class="snz-custom-card">
        <div class="snz-custom-head">Snooze until</div>
        <input id="snzCustomDt" type="datetime-local" class="snz-custom-input" value="${local}">
        <div class="snz-custom-actions">
          <button id="snzCustomCancel" type="button" class="btn-secondary">Cancel</button>
          <button id="snzCustomSave" type="button" class="btn-primary">Snooze</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const cleanup = () => modal.remove();
    modal.querySelector(".snz-custom-backdrop").addEventListener("click", cleanup);
    modal.querySelector("#snzCustomCancel").addEventListener("click", cleanup);
    modal.querySelector("#snzCustomSave").addEventListener("click", async () => {
      const v = modal.querySelector("#snzCustomDt").value;
      if (!v) return;
      const iso = new Date(v).toISOString();
      if (new Date(iso).getTime() <= Date.now() + 30_000) {
        alert("Pick a time at least a minute in the future.");
        return;
      }
      cleanup();
      await doSnooze(msg, iso, `until ${new Date(iso).toLocaleString()}`);
    });
  }

  async function doSnooze(msg, iso, whenLabel) {
    try {
      const r = await fetch("/api/inbox/snooze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: msg.id,
          threadId: msg.threadId || null,
          snoozeUntil: iso,
          stub: {
            from: msg.from || "",
            subject: msg.subject || "",
            snippet: msg.snippet || "",
            date: msg.date || "",
            internalDate: msg.internalDate || null,
          },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.message || data.error || "snooze failed");
      removeFromList(msg.id, `Snoozed ${whenLabel}`);
      showToast(`Snoozed ${whenLabel}`, "ok");
    } catch (err) {
      showToast(`Snooze failed: ${err.message || err}`, "error");
    }
  }

  // Returns six relative snooze options: later today / tomorrow morning /
  // tomorrow evening / next monday / in 2 days / in 1 week.
  // Phase 5.CM-2 — Snooze defaults now read from /api/me/snooze-defaults
  // (Settings → Inbox → Snooze) so each user can pick their own times.
  // Falls back to hardcoded defaults so the menu always works even if
  // the API fails. Format reminder:
  //   morning/afternoon/evening — "HH:MM" (24-hour)
  //   later                     — "+Nh" relative
  //   nextWeek                  — "DAY HH:MM" (DAY is MON…SUN)
  let _snoozeDefaults = {
    morning:   "08:00",
    afternoon: "13:00",
    evening:   "18:00",
    later:     "+3h",
    nextWeek:  "MON 08:00",
  };
  fetch("/api/me/snooze-defaults")
    .then((r) => r.ok ? r.json() : null)
    .then((d) => { if (d && d.snooze_defaults) _snoozeDefaults = { ..._snoozeDefaults, ...d.snooze_defaults }; })
    .catch(() => {});

  // Parse "HH:MM" into {h, m}. Returns null if invalid.
  function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
  }
  // Parse "+Nh" or "+Nm" into milliseconds.
  function parseRelative(s) {
    const m = /^\+(\d+)([hm])$/i.exec(String(s || "").trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2].toLowerCase() === "h" ? n * 3600 * 1000 : n * 60 * 1000;
  }
  // Parse "MON 08:00" / "FRI 17:30" into { dayIdx (0=Sun..6=Sat), h, m }.
  function parseDayTime(s) {
    const m = /^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(\d{1,2}):(\d{2})$/i.exec(String(s || "").trim());
    if (!m) return null;
    const map = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
    return { dayIdx: map[m[1].toUpperCase()], h: Number(m[2]), m: Number(m[3]) };
  }

  function computeSnoozeOptions() {
    const now = new Date();
    const opts = [];
    const sd = _snoozeDefaults;

    // ── Later today — "+Nh" or fallback +3h, but only if it lands same-day and < 22:00.
    const laterDeltaMs = parseRelative(sd.later) || 3 * 60 * 60 * 1000;
    const later = new Date(now.getTime() + laterDeltaMs);
    later.setSeconds(0, 0);
    if (later.getDate() === now.getDate() && later.getHours() < 22) {
      opts.push({ label: "Later today", when: formatWhen(later), iso: later.toISOString() });
    }

    // ── Tomorrow morning — uses sd.morning HH:MM
    const tMorn = parseHHMM(sd.morning) || { h: 8, m: 0 };
    const tomMorn = new Date(now);
    tomMorn.setDate(tomMorn.getDate() + 1);
    tomMorn.setHours(tMorn.h, tMorn.m, 0, 0);
    opts.push({ label: "Tomorrow morning", when: formatWhen(tomMorn), iso: tomMorn.toISOString() });

    // ── Tomorrow evening — uses sd.evening HH:MM
    const tEve = parseHHMM(sd.evening) || { h: 18, m: 0 };
    const tomEve = new Date(now);
    tomEve.setDate(tomEve.getDate() + 1);
    tomEve.setHours(tEve.h, tEve.m, 0, 0);
    opts.push({ label: "Tomorrow evening", when: formatWhen(tomEve), iso: tomEve.toISOString() });

    // ── In 2 days (morning time)
    const inTwoDays = new Date(now);
    inTwoDays.setDate(inTwoDays.getDate() + 2);
    inTwoDays.setHours(tMorn.h, tMorn.m, 0, 0);
    opts.push({ label: "In 2 days", when: formatWhen(inTwoDays), iso: inTwoDays.toISOString() });

    // ── Next week — uses sd.nextWeek "DAY HH:MM"
    const nw = parseDayTime(sd.nextWeek) || { dayIdx: 1, h: 8, m: 0 }; // MON 08:00 fallback
    const nextWk = new Date(now);
    const daysUntil = (nw.dayIdx + 7 - nextWk.getDay()) % 7 || 7;
    nextWk.setDate(nextWk.getDate() + daysUntil);
    nextWk.setHours(nw.h, nw.m, 0, 0);
    opts.push({ label: "Next week", when: formatWhen(nextWk), iso: nextWk.toISOString() });

    // ── In a week (morning time)
    const inAWeek = new Date(now);
    inAWeek.setDate(inAWeek.getDate() + 7);
    inAWeek.setHours(tMorn.h, tMorn.m, 0, 0);
    opts.push({ label: "In a week", when: formatWhen(inAWeek), iso: inAWeek.toISOString() });

    return opts;
  }

  function formatWhen(d) {
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
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

  // --- Markdown shortcuts (Phase 5.CH, 2026-05-25) ----------------
  // Loaded from /api/me/compose-prefs. When ON, the markdown patterns
  // (**bold**, *italic*, `code`, lists, headings, links) get converted
  // to real HTML at SEND time. Quoted history is left untouched.
  let _markdownEnabled = false;
  fetch("/api/me/compose-prefs")
    .then((r) => r.ok ? r.json() : null)
    .then((d) => {
      if (d && d.settings && typeof d.settings.markdownEnabled === "boolean") {
        _markdownEnabled = d.settings.markdownEnabled;
      }
    })
    .catch(() => {});
  function maybeApplyMarkdown(rootEl) {
    if (!_markdownEnabled) return false;
    if (!window.NexaMarkdown || typeof window.NexaMarkdown.applyInPlace !== "function") return false;
    try { return window.NexaMarkdown.applyInPlace(rootEl); }
    catch (err) { console.warn("markdown apply failed:", err); return false; }
  }
  window.DeltaMaybeApplyMarkdown = maybeApplyMarkdown;

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

  // ── Phase 5.CM-2 — Undo-send wrapper. Reads the user's configured
  // delay from /api/me/compose-prefs (cached); during the delay, shows
  // a count-down toast with an Undo button. If user clicks Undo, the
  // actual send is aborted. Setting `undoSendSeconds: 0` skips the
  // countdown entirely (matches the Settings → Compose toggle).
  let _undoSendSeconds = 10;
  fetch("/api/me/compose-prefs")
    .then((r) => r.ok ? r.json() : null)
    .then((d) => {
      if (d && d.settings && Number.isFinite(d.settings.undoSendSeconds)) {
        _undoSendSeconds = d.settings.undoSendSeconds;
      }
    })
    .catch(() => {});

  // doSendNow: function that returns a promise resolving when the
  // actual send goes through. Returns { undone: true } if user
  // clicks Undo during the delay.
  function sendWithUndo(doSendNow) {
    return new Promise((resolve) => {
      const seconds = _undoSendSeconds;
      if (seconds === 0) {
        doSendNow().then(resolve).catch((err) => resolve({ error: err }));
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "delta-undo-toast show";
      wrap.innerHTML = `
        <span class="dut-text">Sending in <span id="dutCount">${seconds}</span>s…</span>
        <button type="button" class="dut-undo" id="dutUndoBtn">Undo</button>
      `;
      document.body.appendChild(wrap);
      let remaining = seconds;
      let cancelled = false;
      const countEl = wrap.querySelector("#dutCount");
      const tick = setInterval(() => {
        remaining -= 1;
        if (cancelled) return;
        if (remaining <= 0) {
          clearInterval(tick);
          wrap.remove();
          doSendNow().then(resolve).catch((err) => resolve({ error: err }));
          return;
        }
        if (countEl) countEl.textContent = String(remaining);
      }, 1000);
      wrap.querySelector("#dutUndoBtn").addEventListener("click", () => {
        cancelled = true;
        clearInterval(tick);
        wrap.remove();
        resolve({ undone: true });
      });
    });
  }
  // Expose for other modules (e.g. assistant.js draft pane).
  window.DeltaSendWithUndo = sendWithUndo;

  // Phase 5.CA — task auto-complete toast.
  // When a reply auto-closes a linked To Do task, show a richer toast
  // with the task title + an Undo button so the user can re-open it
  // if Delta got the wrong task. Stays visible for 6 seconds.
  function showTaskAutoCompletedToast(task) {
    const wrap = document.createElement("div");
    wrap.className = "delta-task-toast show";
    wrap.innerHTML = `
      <span class="dtt-check">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
      </span>
      <div class="dtt-body">
        <div class="dtt-title">Done ✓ <strong></strong></div>
        <div class="dtt-sub">Marked complete because you replied.</div>
      </div>
      <button type="button" class="dtt-undo">Undo</button>
    `;
    wrap.querySelector("strong").textContent = task.title || "task";
    document.body.appendChild(wrap);
    // Stagger so multiple toasts don't overlap.
    const existing = document.querySelectorAll(".delta-task-toast").length;
    wrap.style.bottom = (24 + (existing - 1) * 78) + "px";
    const dismiss = () => {
      wrap.classList.remove("show");
      setTimeout(() => wrap.remove(), 250);
    };
    wrap.querySelector(".dtt-undo").addEventListener("click", async () => {
      try {
        await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completed: false }),
        });
        showToast(`Re-opened: ${task.title}`, "ok");
      } catch (err) {
        showToast(`Undo failed: ${err.message || err}`, "error");
      }
      dismiss();
    });
    setTimeout(dismiss, 6000);
  }

  // ---------- DRAFT COMPOSER -------------------------------------------
  // Inserts a compose card at the top of the reader body, shows a loading
  // spinner while Delta drafts, then lets the user edit and save to Gmail
  // Drafts. The user always sends from Gmail itself.
  async function openDraftComposer(msg, opts = {}) {
    const bodyEl = document.getElementById("readerBody");
    if (!bodyEl) return;

    // mode: 'reply' | 'reply-all' | 'auto'. The toolbar Reply / Reply All
    // buttons force a mode; the Delta "Draft a reply" action leaves it
    // unset → 'auto', which lets the server pick reply-all when the
    // thread has other participants (so a cc'd colleague isn't dropped).
    const mode = opts.mode === "reply-all" ? "reply-all"
               : opts.mode === "reply"     ? "reply"
               : "auto";

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
          <span>${mode === "reply-all" ? "Delta is drafting a reply-all…" : "Delta is drafting a reply…"}</span>
        </div>
        <button class="draft-close" aria-label="Discard draft" title="Discard">×</button>
      </div>
      <div class="draft-confidence" style="display:none"></div>
      <div class="draft-fields">
        <div class="draft-field">
          <label>To</label>
          <input class="draft-to" type="text" placeholder="recipient@example.com">
          <button type="button" class="draft-cc-toggle" data-target="cc" title="Add Cc">Cc</button>
          <button type="button" class="draft-cc-toggle" data-target="bcc" title="Add Bcc">Bcc</button>
        </div>
        <div class="draft-field draft-cc-row" hidden>
          <label>Cc</label>
          <input class="draft-cc" type="text" placeholder="cc@example.com, cc2@example.com">
        </div>
        <div class="draft-field draft-bcc-row" hidden>
          <label>Bcc</label>
          <input class="draft-bcc" type="text" placeholder="bcc@example.com">
        </div>
        <div class="draft-field"><label>Subject</label><input class="draft-subject" type="text" dir="auto"></div>
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
        <button class="tone-chip" data-snippets="open" title="Insert a saved snippet">📋 Snippets</button>
      </div>
      <div class="draft-instructions">
        <input class="draft-extra-instructions" type="text" placeholder="Or type your own instruction: 'mention the flight is at 4:55 PM'…">
        <button class="draft-regen btn delta-btn" disabled>
          <img class="k-logo" src="/delta-logo.png" alt="Delta" /> Re-draft
        </button>
      </div>
      <div class="draft-attach-chips" style="display:none"></div>
      <div class="draft-body-wrap">
        <div class="draft-body" contenteditable="false" dir="auto" data-placeholder="Delta's draft will appear here…"></div>
      </div>
      <div class="draft-actions">
        <button class="draft-send btn primary draft-btn-send" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          Send
        </button>
        <button class="draft-save btn" disabled>Save as draft</button>
        <button class="draft-attach btn" type="button" title="Attach a file to this email">
          <svg viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px;fill:currentColor;vertical-align:text-bottom;margin-right:3px"><path d="M16.5 6.5L9 14a2.5 2.5 0 0 0 3.5 3.5l8-8a4 4 0 0 0-5.7-5.7l-8.8 8.9a5.5 5.5 0 0 0 7.8 7.8l7.3-7.3 1.4 1.4-7.3 7.3a7.5 7.5 0 1 1-10.6-10.6l8.8-8.9a6 6 0 1 1 8.5 8.5l-8 8a4.5 4.5 0 0 1-6.4-6.4L15 5l1.5 1.5z"/></svg>
          Attach
        </button>
        <button class="draft-cancel btn">Cancel</button>
        <input type="file" class="draft-file-input" multiple style="display:none">
        <span class="draft-sig-hint" style="display:none">+ your Transform Iran signature</span>
        <span class="draft-status"></span>
      </div>
    `;
    bodyEl.prepend(composer);

    const toInput = composer.querySelector(".draft-to");
    const ccInput = composer.querySelector(".draft-cc");
    const bccInput = composer.querySelector(".draft-bcc");
    const ccRow = composer.querySelector(".draft-cc-row");
    const bccRow = composer.querySelector(".draft-bcc-row");
    const subjInput = composer.querySelector(".draft-subject");

    // ---- Outgoing file attachments (composer paperclip) --------------
    // Files the recipient receives WITH this email (distinct from the
    // Delta-chat paperclip). Upload to /api/compose/attach → hold an id →
    // send the ids with the message; the server emits multipart/mixed.
    const draftFileInput = composer.querySelector(".draft-file-input");
    const draftAttachBtn = composer.querySelector(".draft-attach");
    const draftChipsEl = composer.querySelector(".draft-attach-chips");
    if (!document.getElementById("draft-attach-css")) {
      const st = document.createElement("style"); st.id = "draft-attach-css";
      st.textContent = ".draft-attach-chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 10px;}"
        + ".draft-attach-chip{display:inline-flex;align-items:center;gap:9px;max-width:300px;background:#fff;border:1px solid rgba(0,0,0,.18);border-radius:8px;padding:7px 10px;font-size:12.5px;line-height:1.25;box-shadow:0 1px 2px rgba(0,0,0,.06);}"
        + ".draft-attach-chip.err{border-color:#e0907f;background:#fdeee9;}"
        + ".draft-attach-chip .dac-ic{font-size:19px;flex:0 0 auto;line-height:1;}"
        + ".draft-attach-chip .dac-meta{display:flex;flex-direction:column;min-width:0;}"
        + ".draft-attach-chip .dac-nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;}"
        + ".draft-attach-chip .dac-sz{opacity:.6;font-size:11px;}"
        + ".draft-attach-chip .dac-x{border:none;background:transparent;cursor:pointer;font-size:16px;opacity:.5;padding:0 0 0 4px;color:inherit;margin-left:auto;}"
        + ".draft-attach-chip .dac-x:hover{opacity:1;}";
      document.head.appendChild(st);
    }
    let draftAttachments = []; // { localId, name, status, id, error }
    function renderDraftChips() {
      if (!draftChipsEl) return;
      draftChipsEl.innerHTML = draftAttachments.map(attachChipHtml).join("");
      draftChipsEl.style.display = draftAttachments.length ? "flex" : "none";
      draftChipsEl.querySelectorAll(".dac-x").forEach((b) => b.addEventListener("click", () => {
        draftAttachments = draftAttachments.filter((p) => p.localId !== b.dataset.lid);
        renderDraftChips();
      }));
    }
    async function uploadDraftFile(file) {
      const localId = "l" + Math.random().toString(36).slice(2);
      const entry = { localId, name: file.name || "file", status: "uploading", id: null };
      draftAttachments.push(entry);
      renderDraftChips();
      try {
        const r = await fetch(
          `/api/compose/attach?name=${encodeURIComponent(file.name || "file")}&type=${encodeURIComponent(file.type || "")}`,
          { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file }
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) {
          entry.status = "error";
          entry.error = data.message || (r.status === 413 ? "File too large (max 25 MB)." : `Upload failed (${r.status})`);
          showToast("Couldn't attach " + entry.name + " — " + entry.error, "error");
        } else {
          entry.status = "ready"; entry.id = data.id; entry.size = data.size;
        }
      } catch (err) {
        entry.status = "error"; entry.error = err.message || "Upload failed";
        showToast("Couldn't attach " + entry.name, "error");
      }
      renderDraftChips();
    }
    if (draftAttachBtn && draftFileInput) {
      draftAttachBtn.addEventListener("click", (e) => { e.preventDefault(); draftFileInput.click(); });
      draftFileInput.addEventListener("change", () => {
        Array.from(draftFileInput.files || []).forEach((f) => { if (draftAttachments.length < 10) uploadDraftFile(f); });
        draftFileInput.value = "";
      });
    }

    // Cc / Bcc toggles — clicking shows/hides the row.
    composer.querySelectorAll(".draft-cc-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.target;
        const row = target === "cc" ? ccRow : bccRow;
        row.hidden = !row.hidden;
        if (!row.hidden) row.querySelector("input")?.focus();
      });
    });

    // Phase 5.AP — autocomplete on To / Cc / Bcc.
    attachRecipientAutocomplete(toInput);
    attachRecipientAutocomplete(ccInput);
    attachRecipientAutocomplete(bccInput);

    const bodyTa = composer.querySelector(".draft-body");
    // Phase 5.AP — @mention in body. Original implementation targets
    // textarea selectionStart API; needs Selection-API port for the
    // contenteditable composer (Phase 5.AQ). Re-enable after porting.
    // attachMentionMenu(bodyTa, toInput, ccInput);

    // Phase 5.AT — language mismatch detector. Parent message's
    // language vs the user's typed prose. If they differ (e.g.
    // received Farsi, typing English), show a chip offering to
    // translate the prose to the parent's language before sending.
    const parentLang = detectScriptLanguage(msg.snippet || "");
    attachLanguageMismatchChip(composer, bodyTa, parentLang);
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
      setBodyEditable(false);
      statusEl.textContent = "";
      bodyTa.innerHTML = "";

      try {
        const r = await fetch("/api/assistant/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            openMessageId: msg.id,
            instructions: extraInstructions || "",
            mode,
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error || "draft failed");
        currentDraft = data;
        toInput.value = data.to || "";
        if (data.cc) {
          ccInput.value = data.cc;
          ccRow.hidden = false;
        }
        subjInput.value = data.subject || "";
        // Render Delta's prose as paragraphs + the original styled
        // quoted history block (preserves sender's signature/colors/
        // logo via the parent's source HTML).
        bodyTa.innerHTML = renderInitialDraftHtml(data.body, data.quotedHtml);
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

        // Phase 5.AO — Sources Delta consulted (research panel)
        renderGroundingPanel(composer, data.grounding);
      } catch (err) {
        titleEl.textContent = "Couldn't generate a draft";
        statusEl.textContent = err.message || String(err);
        statusEl.className = "draft-status error";
      } finally {
        regenBtn.disabled = false;
        saveBtn.disabled = false;
        sendBtn.disabled = false;
        setBodyEditable(true);
        instr.value = "";
      }
    }

    // Phase 5.AQ — helper for the contenteditable .draft-body.
    // textarea.disabled doesn't exist on a div; use contentEditable +
    // a CSS class for the visual locked state.
    function setBodyEditable(yes) {
      bodyTa.contentEditable = yes ? "true" : "false";
      bodyTa.classList.toggle("disabled", !yes);
    }

    // Render initial composer content: Delta's prose as paragraphs +
    // the parent's HTML quoted block (Outlook-style, with original
    // sender's signature preserved).
    function renderInitialDraftHtml(prose, quotedHtml) {
      const escHtml = (s) => String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const proseHtml = escHtml(prose || "")
        .split(/\n{2,}/)
        .map((p) => `<div>${p.replace(/\n/g, "<br>")}</div>`)
        .join(`<div><br></div>`);
      return `${proseHtml}${quotedHtml ? `<div><br></div>${quotedHtml}` : ""}`;
    }

    regenBtn.addEventListener("click", () => generate(instr.value.trim()));
    instr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); regenBtn.click(); }
    });

    // Phase 5.CM-3 — Snippets chip. Opens a small popover with the
    // user's saved snippets (from /api/snippets); clicking one inserts
    // its body at the cursor in the composer.
    const snippetsChip = composer.querySelector('[data-snippets="open"]');
    if (snippetsChip) {
      snippetsChip.addEventListener("click", async (e) => {
        e.preventDefault();
        const existing = document.getElementById("snippetsPopover");
        if (existing) { existing.remove(); return; }

        let snippets = [];
        try {
          const r = await fetch("/api/snippets");
          if (r.ok) snippets = (await r.json()).snippets || [];
        } catch (_) {}

        const pop = document.createElement("div");
        pop.id = "snippetsPopover";
        pop.className = "snz-popover snippets-popover";
        if (!snippets.length) {
          pop.innerHTML = `<div class="snz-head">No snippets yet</div>
            <div style="padding: 12px 14px; color: var(--muted); font-size: 12.5px; max-width: 280px">
              Save reusable phrases in <a href="/settings#compose" style="color: var(--accent, var(--gold))">Settings → Compose → Snippets</a>.
            </div>`;
        } else {
          pop.innerHTML = `<div class="snz-head">Insert snippet</div>` +
            snippets.map((s) => `
              <button class="snz-opt" data-snip-id="${s.id}" type="button">
                <span class="snz-opt-label">${escapeHtml(s.title)}</span>
                <span class="snz-opt-when" style="font-style: italic; opacity: .7">${escapeHtml((s.body || "").slice(0, 60))}${(s.body || "").length > 60 ? "…" : ""}</span>
              </button>
            `).join("");
        }
        document.body.appendChild(pop);

        // Position under the chip.
        const rect = snippetsChip.getBoundingClientRect();
        pop.style.position = "fixed";
        pop.style.top  = `${rect.bottom + 6}px`;
        pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`;
        pop.style.maxHeight = "320px";
        pop.style.overflowY = "auto";

        function close() { pop.remove(); document.removeEventListener("click", outside, true); }
        function outside(ev) { if (!pop.contains(ev.target) && ev.target !== snippetsChip) close(); }
        setTimeout(() => document.addEventListener("click", outside, true), 0);

        pop.querySelectorAll("[data-snip-id]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const snip = snippets.find((s) => String(s.id) === btn.dataset.snipId);
            close();
            if (!snip) return;
            // Insert at cursor in the contenteditable body. Fallback:
            // append to end if no selection exists yet.
            const html = String(snip.body || "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\n/g, "<br>");
            const sel = window.getSelection();
            bodyTa.focus();
            if (sel && sel.rangeCount && bodyTa.contains(sel.anchorNode)) {
              document.execCommand("insertHTML", false, html);
            } else {
              bodyTa.innerHTML = (bodyTa.innerHTML || "") + html;
            }
            fetch(`/api/snippets/${snip.id}/used`, { method: "POST" }).catch(() => {});
            showToast(`Inserted "${snip.title}"`);
          });
        });
      });
    }

    // Tone preset chips — re-draft with that instruction
    composer.querySelectorAll(".tone-chip").forEach((chip) => {
      // Skip the snippets button — it's wired above and shouldn't
      // re-trigger as a tone preset.
      if (chip.dataset.snippets) return;
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
      // Wait for any in-progress attachment uploads before sending.
      if (draftAttachments.some((a) => a.status === "uploading")) {
        statusEl.className = "draft-status error";
        statusEl.textContent = "Still attaching a file — try Send again in a moment.";
        return;
      }
      const attachmentIds = draftAttachments.filter((a) => a.status === "ready" && a.id).map((a) => a.id);
      // No confirm() — clicking Send means Send. The Send button is
      // already explicit + dedicated. Undo-send delay below gives a
      // safety window if the user changes their mind.
      sendBtn.disabled = true;
      saveBtn.disabled = true;
      statusEl.className = "draft-status";
      statusEl.textContent = "Sending…";
      // Markdown shortcuts — convert **bold**, lists, etc. before
      // serialising the body so the recipient sees rendered HTML.
      maybeApplyMarkdown(bodyTa);

      const payload = JSON.stringify({
        to,
        cc: ccInput.value.trim() || undefined,
        bcc: bccInput.value.trim() || undefined,
        subject: subjInput.value,
        // Phase 5.AQ — contenteditable composer sends rich HTML
        // so the recipient sees the parent's original signature/
        // colors/logo in the quoted block. Server's
        // buildMultipartMessage auto-generates the text/plain
        // variant via mime.htmlToText.
        bodyHtml: bodyTa.innerHTML,
        body: bodyTa.innerText, // plain-text fallback for text/plain
        threadId: currentDraft.threadId,
        inReplyTo: currentDraft.inReplyTo,
        // Phase 5.AE — Carry Delta's draft id so the server can
        // diff what was actually sent against the original draft.
        deltaDraftId: currentDraft.deltaDraftId || null,
        attachmentIds, // outgoing file attachments (composer paperclip)
      });

      // Phase 5.CM-2 — Undo-send wrapper. Honours undoSendSeconds from
      // /api/me/compose-prefs. User can click Undo during the countdown
      // to abort the actual fetch entirely.
      const undoResult = await sendWithUndo(async () => {
        const r = await fetch("/api/gmail/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "send failed");
        return { r, data };
      });
      if (undoResult && undoResult.undone) {
        sendBtn.disabled = false;
        saveBtn.disabled = false;
        statusEl.className = "draft-status";
        statusEl.textContent = "Cancelled — undone.";
        return;
      }
      try {
        if (undoResult && undoResult.error) throw undoResult.error;
        const r = undoResult.r;
        const data = undoResult.data;
        statusEl.className = "draft-status ok";
        statusEl.textContent = data.archived ? "Sent + archived ✓" : "Sent ✓";
        sendBtn.textContent = "Sent";
        toInput.disabled = true; subjInput.disabled = true; setBodyEditable(false);
        ccInput.disabled = true; bccInput.disabled = true;
        regenBtn.disabled = true;
        showToast(data.archived ? `Sent to ${to} · archived` : `Sent to ${to}`, "ok");
        // Phase 5.CA — surface any tasks that auto-completed when this
        // reply went out. Show one toast per task so the user sees the
        // exact list, with the option to undo if Delta got it wrong.
        if (Array.isArray(data.autoCompletedTasks) && data.autoCompletedTasks.length) {
          for (const t of data.autoCompletedTasks) {
            showTaskAutoCompletedToast(t);
          }
        }
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
      statusEl.textContent = "Saving draft…";
      // Apply markdown shortcuts so the saved Gmail draft matches Send.
      maybeApplyMarkdown(bodyTa);
      try {
        const r = await fetch("/api/gmail/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: toInput.value,
            cc: ccInput.value.trim() || undefined,
            bcc: bccInput.value.trim() || undefined,
            subject: subjInput.value,
            bodyHtml: bodyTa.innerHTML,
            body: bodyTa.innerText,
            threadId: currentDraft.threadId,
            inReplyTo: currentDraft.inReplyTo,
          }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "save failed");
        statusEl.className = "draft-status ok";
        statusEl.textContent = "Saved to your Drafts ✓";
        titleEl.textContent = "Draft saved";
        setBodyEditable(false);
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

    // Phase 5.AL — if a Smart Reply chip set a pre-fill for THIS
    // message, skip the Claude regenerate hop entirely and populate
    // the composer directly with the chip's draft body.
    // Phase 5.CB — if prefill has INSTRUCTIONS only (no body), pass
    // them to generate() so Delta drafts a tailored reply from the
    // action-item picker's intent (Confirm / Push back / etc.).
    const prefill = window._smartReplyPrefill;
    if (prefill && prefill.messageId === msg.id && !prefill.body && prefill.instructions) {
      const instr = prefill.instructions;
      window._smartReplyPrefill = null;
      generate(instr);
      return;
    }
    // Phase 5.CO — if the prefill already carries the FULL draft
    // metadata (to + subject + threadId — as voice/chat drafts now do),
    // populate currentDraft SYNCHRONOUSLY so the Send button works
    // immediately (no race against an async re-fetch) and the reply-all
    // Cc recipients survive. We only fetch the parent's HTML quoted
    // block in the background — and that's purely cosmetic, never gating
    // Send. Legacy smart-reply chips (body only, no metadata) fall back
    // to the old re-fetch path below.
    const prefillHasFullMeta =
      prefill && prefill.messageId === msg.id && prefill.body &&
      prefill.to && prefill.threadId;

    if (prefillHasFullMeta) {
      window._smartReplyPrefill = null;
      currentDraft = {
        to: prefill.to,
        cc: prefill.cc || "",
        subject: prefill.subject || "",
        body: prefill.body,
        threadId: prefill.threadId,
        inReplyTo: prefill.inReplyTo,
        deltaDraftId: prefill.deltaDraftId,
      };
      toInput.value = prefill.to || "";
      if (prefill.cc && String(prefill.cc).trim()) { ccInput.value = prefill.cc; ccRow.hidden = false; }
      subjInput.value = prefill.subject || "";
      bodyTa.innerHTML = renderInitialDraftHtml(prefill.body, null);
      titleEl.textContent = `Reply ready (${prefill.intent || "drafted"})`;
      // currentDraft is populated above, so Send can fire immediately —
      // enable it here. (generate() enables Send on the normal path, but
      // this synchronous-prefill path skips generate(), so without this
      // the Send button stays disabled and clicking it does nothing.)
      regenBtn.disabled = false; saveBtn.disabled = false; sendBtn.disabled = false; setBodyEditable(true);
      // Background-fetch ONLY the parent's quoted HTML so the composer
      // shows the original message + signature. Best-effort; if it fails
      // we keep the plain body. Don't touch to/cc/subject the user may
      // already be editing.
      fetch("/api/assistant/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openMessageId: msg.id, instructions: "", mode }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.quotedHtml) {
            bodyTa.innerHTML = renderInitialDraftHtml(prefill.body, data.quotedHtml);
          }
          // Backfill thread headers if the prefill somehow lacked them.
          if (data) {
            if (!currentDraft.threadId && data.threadId) currentDraft.threadId = data.threadId;
            if (!currentDraft.inReplyTo && data.inReplyTo) currentDraft.inReplyTo = data.inReplyTo;
          }
        })
        .catch(() => {});
    } else if (prefill && prefill.messageId === msg.id && prefill.body) {
      // Legacy path: prefill has a body but NO metadata (older smart-
      // reply chips). Fetch to/subject/quotedHtml, then set currentDraft.
      setTimeout(() => {
        fetch("/api/assistant/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openMessageId: msg.id, instructions: "", mode }),
        })
          .then((r) => r.json())
          .then((data) => {
            currentDraft = data;
            toInput.value = data.to || "";
            if (data.cc) { ccInput.value = data.cc; ccRow.hidden = false; }
            subjInput.value = data.subject || "";
            bodyTa.innerHTML = renderInitialDraftHtml(prefill.body, data.quotedHtml);
            titleEl.textContent = `Smart reply ready (${prefill.intent || "commit"})`;
            // currentDraft is set just above → enable Send (this path
            // skips generate(), which is the only other place Send is
            // enabled, so otherwise the button stays dead).
            regenBtn.disabled = false; saveBtn.disabled = false; sendBtn.disabled = false; setBodyEditable(true);
          })
          .catch(() => {
            // Fall back to normal generate if metadata fetch fails.
            generate("");
          });
        window._smartReplyPrefill = null;
      }, 0);
    } else {
      // Kick off the initial draft.
      generate("");
    }
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
  const cmpFileInput = document.getElementById("cmpFileInput");
  const cmpAttachChips = document.getElementById("cmpAttachChips");

  // ---- New-Email composer outgoing attachments (paperclip) ----
  let cmpAttachments = []; // { localId, name, status, id, error }
  function renderCmpChips() {
    if (!cmpAttachChips) return;
    cmpAttachChips.innerHTML = cmpAttachments.map(attachChipHtml).join("");
    cmpAttachChips.style.display = cmpAttachments.length ? "flex" : "none";
    cmpAttachChips.querySelectorAll(".dac-x").forEach((b) => b.addEventListener("click", () => {
      cmpAttachments = cmpAttachments.filter((p) => p.localId !== b.dataset.lid);
      renderCmpChips();
    }));
  }
  async function uploadCmpFile(file) {
    const localId = "l" + Math.random().toString(36).slice(2);
    const entry = { localId, name: file.name || "file", status: "uploading", id: null };
    cmpAttachments.push(entry);
    renderCmpChips();
    try {
      const r = await fetch(
        `/api/compose/attach?name=${encodeURIComponent(file.name || "file")}&type=${encodeURIComponent(file.type || "")}`,
        { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        entry.status = "error";
        entry.error = data.message || (r.status === 413 ? "File too large (max 25 MB)." : `Upload failed (${r.status})`);
        showToast("Couldn't attach " + entry.name + " — " + entry.error, "error");
      } else { entry.status = "ready"; entry.id = data.id; entry.size = data.size; }
    } catch (err) { entry.status = "error"; entry.error = err.message || "Upload failed"; showToast("Couldn't attach " + entry.name, "error"); }
    renderCmpChips();
  }
  if (cmpAttach && cmpFileInput) {
    cmpAttach.addEventListener("click", (e) => { e.preventDefault(); cmpFileInput.click(); });
    cmpFileInput.addEventListener("change", () => {
      Array.from(cmpFileInput.files || []).forEach((f) => { if (cmpAttachments.length < 10) uploadCmpFile(f); });
      cmpFileInput.value = "";
    });
  }

  // Phase 5.AP — autocomplete on the standalone Compose modal too.
  if (cmpTo)  attachRecipientAutocomplete(cmpTo);
  if (cmpCc)  attachRecipientAutocomplete(cmpCc);
  if (cmpBcc) attachRecipientAutocomplete(cmpBcc);

  let cmpSignatureHtml = "";

  // Phase 5.AR — dock the New-Email compose inside the reader column
  // instead of as a floating modal overlay. More writing space + matches
  // how the reply composer already lives in the reader pane.
  const readerSection = document.getElementById("reader");
  let _composeOriginalParent = null; // restore on close

  function openCompose() {
    if (!composeModal) return;
    // Always start from a clean slate so state from a previous compose or
    // draft-edit can't leak into this one (wrong thread, deleting the old
    // draft, stale recipients/attachments). Callers (openNewEmailComposer /
    // openDraftForEdit) apply their prefill + _editingDraft AFTER this.
    _editingDraft = null;
    cmpTo.value = ""; cmpCc.value = ""; cmpBcc.value = "";
    cmpSubject.value = ""; cmpBodyRich.innerHTML = "";
    if (cmpCcRow) cmpCcRow.hidden = true;
    if (cmpBccRow) cmpBccRow.hidden = true;
    cmpAttachments = []; renderCmpChips();
    // Move into the reader column + flag as docked. CSS strips the
    // backdrop / fixed positioning and stretches the card to fill.
    if (readerSection && composeModal.parentElement !== readerSection) {
      _composeOriginalParent = composeModal.parentElement;
      readerSection.appendChild(composeModal);
    }
    composeModal.classList.add("docked");
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
    composeModal.classList.remove("docked");
    // Restore to the original DOM location so re-opens are clean.
    if (_composeOriginalParent && composeModal.parentElement !== _composeOriginalParent) {
      _composeOriginalParent.appendChild(composeModal);
    }
    cmpTo.value = ""; cmpCc.value = ""; cmpBcc.value = "";
    cmpSubject.value = ""; cmpBodyRich.innerHTML = "";
    cmpCcRow.hidden = true; cmpBccRow.hidden = true;
    cmpStatus.textContent = "";
    cmpSend.disabled = false; cmpSave.disabled = false;
    cmpAttachments = []; renderCmpChips();
    _editingDraft = null;
  }

  composeBtn?.addEventListener("click", openCompose);

  // Phase 5.BM — Voice/chat Delta can programmatically open the
  // New-Email composer (NOT a reply) with a prefilled draft. Used
  // when the user says "draft a brand-new email to Lazarus" etc.
  // Open a DRAFT in the editable composer (full tools) instead of the
  // read-only reader. Prefills from the draft's content and remembers the
  // draftId + thread so Send goes out in-thread and removes the old draft.
  async function openDraftForEdit(id, messages) {
    const stub = (messages || []).find((m) => m.id === id) || {};
    try {
      const r = await fetch(`/api/gmail/message/${encodeURIComponent(id)}`);
      const data = r.ok ? await r.json() : null;
      const h = (data && data.headers) || {};
      // openNewEmailComposer → openCompose resets _editingDraft + fields,
      // so prefill FIRST, then set the editing context.
      window.openNewEmailComposer({
        to: h.to || stub.to || "",
        cc: h.cc || "",
        bcc: h.bcc || "",
        subject: h.subject || stub.subject || "",
        bodyHtml: (data && data.body && data.body.html) || undefined,
        body: (data && data.body && data.body.html) ? undefined : ((data && data.body && data.body.text) || ""),
      });
      _editingDraft = {
        draftId: stub.draftId || null,
        threadId: (data && data.threadId) || stub.threadId || null,
        inReplyTo: h.inReplyTo || "",
        rowId: id,
      };
      // Show the draft's EXISTING attachments as read-only chips so the
      // user knows they'll be sent (server re-attaches them on send).
      const orig = (data && Array.isArray(data.attachments)) ? data.attachments : [];
      if (orig.length) {
        orig.forEach((p) => cmpAttachments.push({
          localId: "orig" + Math.random().toString(36).slice(2),
          name: p.filename || "attachment", size: p.size,
          status: "ready", id: null, inherited: true,
        }));
        renderCmpChips();
      }
    } catch (err) {
      showToast("Couldn't open draft: " + (err.message || err), "error");
    }
  }

  window.openNewEmailComposer = function (prefill = {}) {
    openCompose();
    // openCompose() does an async settings fetch, but the DOM fields
    // are available immediately — populate them now.
    if (prefill.to)      cmpTo.value      = prefill.to;
    if (prefill.cc)      { cmpCc.value    = prefill.cc;  cmpCcRow.hidden  = false; }
    if (prefill.bcc)     { cmpBcc.value   = prefill.bcc; cmpBccRow.hidden = false; }
    if (prefill.subject) cmpSubject.value = prefill.subject;
    if (prefill.bodyHtml) {
      cmpBodyRich.innerHTML = prefill.bodyHtml;
    } else if (prefill.body) {
      // Convert plain-text body into paragraphs so the rich editor
      // doesn't collapse the whitespace.
      const escaped = String(prefill.body)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      cmpBodyRich.innerHTML = escaped
        .split(/\n\n+/)
        .map((para) => `<div>${para.replace(/\n/g, "<br>")}</div>`)
        .join("<div><br></div>");
    }
    // Flash the composer so the user notices it pop in (matches the
    // voice-draft path for reply drafts).
    requestAnimationFrame(() => {
      composeModal.scrollIntoView({ behavior: "smooth", block: "center" });
      composeModal.classList.add("voice-draft-flash");
      setTimeout(() => composeModal.classList.remove("voice-draft-flash"), 1800);
    });
  };
  cmpClose?.addEventListener("click", () => closeCompose());
  cmpDiscard?.addEventListener("click", () => closeCompose(true));
  // Backdrop click only matters in floating-modal mode (when not docked).
  cmpBackdrop?.addEventListener("click", () => {
    if (!composeModal.classList.contains("docked")) closeCompose();
  });

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
    // Markdown shortcuts: convert **bold**, lists, etc. before reading innerHTML
    maybeApplyMarkdown(cmpBodyRich);
    const bodyHtml = cmpBodyRich.innerHTML.trim();
    if (!bodyHtml || bodyHtml === "<br>" || bodyHtml === "<p></p>") {
      cmpStatus.className = "compose-status error";
      cmpStatus.textContent = "Write something first.";
      return false;
    }
    if (cmpAttachments.some((a) => a.status === "uploading")) {
      cmpStatus.className = "compose-status error";
      cmpStatus.textContent = "Still attaching a file — try again in a moment.";
      return false;
    }
    const payload = {
      to,
      subject: cmpSubject.value,
      bodyHtml,
      attachmentIds: cmpAttachments.filter((a) => a.status === "ready" && a.id).map((a) => a.id),
    };
    if (cmpCc.value.trim()) payload.cc = cmpCc.value.trim();
    if (cmpBcc.value.trim()) payload.bcc = cmpBcc.value.trim();
    // Editing an existing draft: send in-thread, skip a second signature,
    // and tell the server to remove the original Gmail draft.
    if (_editingDraft) {
      payload.noSignature = true;
      if (_editingDraft.draftId) payload.deleteDraftId = _editingDraft.draftId;
      if (_editingDraft.threadId) payload.threadId = _editingDraft.threadId;
      if (_editingDraft.inReplyTo) payload.inReplyTo = _editingDraft.inReplyTo;
    }
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
    cmpSend.disabled = true; cmpSave.disabled = true;
    cmpStatus.className = "compose-status";
    cmpStatus.textContent = "Sending…";
    try {
      const data = await postCompose("/api/gmail/send");
      if (data === false) { cmpSend.disabled = false; cmpSave.disabled = false; return; }
      cmpStatus.className = "compose-status ok";
      cmpStatus.textContent = `Sent ✓`;
      showToast(`Sent to ${to}`, "ok");
      // Phase 5.CA — same auto-complete toast as the reply path.
      if (Array.isArray(data.autoCompletedTasks) && data.autoCompletedTasks.length) {
        for (const t of data.autoCompletedTasks) showTaskAutoCompletedToast(t);
      }
      // If we just sent an edited draft, drop its row from the Drafts list
      // + refresh the Drafts badge (it's no longer a draft).
      if (_editingDraft && _editingDraft.rowId) {
        try { removeFromList(_editingDraft.rowId, "Sent ✓"); } catch (_) {}
        try { loadCounts(); } catch (_) {}
      }
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
      cmpStatus.textContent = "Saved to your Drafts ✓";
      showToast("Saved as draft", "ok");
      // If editing an existing draft, the server replaced it — point at the
      // NEW draft id so a second save doesn't re-delete a stale one.
      if (_editingDraft && data.draftId) {
        // Save replaced the draft with a NEW one (new message id) and
        // deleted the old. Re-point editing state + the visible row + the
        // cached stub at the new id so reopening the draft doesn't 404.
        _editingDraft.draftId = data.draftId;
        const oldRowId = _editingDraft.rowId;
        if (data.messageId && oldRowId) {
          const row = document.querySelector(`.mail-row[data-id="${CSS.escape(oldRowId)}"]`);
          if (row) row.dataset.id = data.messageId;
          const stub = _allMessages.find((m) => m.id === oldRowId);
          if (stub) { stub.id = data.messageId; stub.draftId = data.draftId; }
          _editingDraft.rowId = data.messageId;
        }
      }
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
      const result = await loadInbox({ forceFresh: true });
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
    // Switching folders / VIPs / search always exits delta-search mode.
    if (_deltaSearchActive) {
      _deltaSearchActive = false;
      _deltaSearchSnapshot = null;
      _deltaSearchQuery = "";
      const banner = document.getElementById("deltaSearchBanner");
      if (banner) banner.hidden = true;
    }
    _currentFolder = folder;
    _currentQuery = opts.query || "";
    _currentLabelId = opts.labelId || null;   // Gmail-label folder, if any
    _nextPageToken = null;
    _classificationMap = {};

    // Update title
    const title = opts.title || FOLDER_TITLES[folder] || folder;
    const titleEl = document.getElementById("listTitle");
    if (titleEl) titleEl.textContent = _currentQuery
      ? `Search: "${_currentQuery}"`
      : title;

    // Update active state in rail. For Gmail-label folders highlight by
    // data-label-id; otherwise by data-folder.
    document.querySelectorAll(".folder.active").forEach((f) => f.classList.remove("active"));
    if (_currentLabelId) {
      document.querySelector(`.folder[data-label-id="${CSS.escape(_currentLabelId)}"]`)?.classList.add("active");
    } else {
      document.querySelector(`.folder[data-folder="${folder}"]`)?.classList.add("active");
    }

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

  // -------- IMPORTANT CONTACTS (dynamic rail folders) ----------------
  // Per-user list loaded from /api/important-contacts. Default-seeded with
  // Lana / Lazarus / Maggie / Pia for every user. Plus button lets the user
  // add anyone else (Simon, donors, future contacts module entries…).
  let _importantContacts = [];

  async function loadImportantContacts() {
    try {
      const r = await fetch("/api/important-contacts");
      if (!r.ok) return;
      const data = await r.json();
      _importantContacts = data.contacts || [];
      renderImportantFolders();
    } catch (err) {
      console.warn("[important-contacts] load failed:", err);
    }
  }

  function renderImportantFolders() {
    const wrap = document.getElementById("importantFolders");
    if (!wrap) return;
    if (!_importantContacts.length) {
      wrap.innerHTML = `<div class="important-empty">Nobody pinned yet. Click + to add.</div>`;
      return;
    }
    wrap.innerHTML = _importantContacts.map((c) => `
      <a class="folder important" href="#imp-${encodeURIComponent(c.email)}"
         data-imp-email="${escapeHtml(c.email)}"
         data-imp-name="${escapeHtml(c.name)}"
         data-imp-id="${c.id}">
        <span class="vip-dot" style="background:${escapeHtml(c.color || "#B28E44")}"></span>
        <span class="folder-name">${escapeHtml(c.name)}</span>
        <button class="important-remove" title="Remove from Important" data-imp-remove="${c.id}">×</button>
      </a>
    `).join("");

    wrap.querySelectorAll(".folder.important").forEach((f) => {
      f.addEventListener("click", (e) => {
        if (e.target.classList.contains("important-remove")) return;
        e.preventDefault();
        const email = f.dataset.impEmail;
        const name = f.dataset.impName;
        // Show only mail SENT BY this person — not threads where they're
        // merely a To/Cc recipient. "Important: Lana" = what Lana sent me.
        const q = `from:${email} newer_than:1y`;
        setFolder("important", { query: q, title: name });
        f.classList.add("active");
      });
    });

    wrap.querySelectorAll(".important-remove").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.impRemove;
        const folder = btn.closest(".folder");
        const name = folder?.dataset.impName || "this contact";
        if (!confirm(`Remove ${name} from Important?`)) return;
        try {
          const r = await fetch(`/api/important-contacts/${id}`, { method: "DELETE" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          await loadImportantContacts();
          showToast(`Removed ${name} from Important`, "ok");
        } catch (err) {
          showToast(`Remove failed: ${err.message || err}`, "error");
        }
      });
    });
  }

  // -------- GMAIL LABEL FOLDERS (Phase 5.CR) -------------------------
  // The rail's "Folders" section now mirrors the user's REAL Gmail
  // labels (their own folder structure), pulled live from their account
  // via /api/gmail/labels. Clicking one filters the inbox to that label.
  const FOLDER_SVG = `<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  async function loadGmailFolders() {
    const wrap = document.getElementById("gmailFolders");
    const label = document.getElementById("gmailFoldersLabel");
    if (!wrap) return;
    try {
      const r = await fetch("/api/gmail/labels");
      if (!r.ok) return;
      const data = await r.json();
      const labels = data.labels || [];
      if (!labels.length) {
        wrap.innerHTML = "";
        if (label) label.hidden = true;
        return;
      }
      if (label) label.hidden = false;
      wrap.innerHTML = labels.map((l) => `
        <a class="folder gmail-label" href="#label-${encodeURIComponent(l.id)}"
           data-label-id="${escapeHtml(l.id)}"
           data-label-name="${escapeHtml(l.name)}">
          <span class="folder-i">${FOLDER_SVG}</span>
          <span class="folder-name">${escapeHtml(l.name)}</span>
        </a>
      `).join("");
      wrap.querySelectorAll(".folder.gmail-label").forEach((f) => {
        f.addEventListener("click", (e) => {
          e.preventDefault();
          setFolder("gmail-label", {
            labelId: f.dataset.labelId,
            title: f.dataset.labelName,
          });
        });
      });
    } catch (err) {
      console.warn("[gmail-folders] load failed:", err);
    }
  }

  async function addImportantContact() {
    const email = (prompt("Email address of the person to add to Important:") || "").trim();
    if (!email) return;
    if (!email.includes("@")) {
      showToast("That doesn't look like an email address", "error");
      return;
    }
    const name = (prompt("Display name (shown in the rail):", email.split("@")[0]) || "").trim() || email;
    // Rotate through a few brand colors so each new entry is visually distinct.
    const PALETTE = ["#B28E44", "#E92A2E", "#4F9D5A", "#5B7CA3", "#9C6BAD", "#D27D2D", "#2D8C8C"];
    const color = PALETTE[_importantContacts.length % PALETTE.length];
    try {
      const r = await fetch("/api/important-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, color }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || body.error || "Add failed");
      }
      await loadImportantContacts();
      showToast(`Added ${name} to Important`, "ok");
    } catch (err) {
      showToast(`Add failed: ${err.message || err}`, "error");
    }
  }

  // Returns true if this email address is already in the user's Important
  // list. Used by the reader pane to show or hide the "+ Add to Important"
  // chip next to the sender name.
  function isAlreadyImportant(email) {
    if (!email) return false;
    const lower = email.toLowerCase();
    return _importantContacts.some((c) => c.email.toLowerCase() === lower);
  }

  async function addSenderToImportant(email, name) {
    if (!email) return;
    try {
      const PALETTE = ["#B28E44", "#E92A2E", "#4F9D5A", "#5B7CA3", "#9C6BAD", "#D27D2D", "#2D8C8C"];
      const color = PALETTE[_importantContacts.length % PALETTE.length];
      const r = await fetch("/api/important-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: name || email, color }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || body.error || "Add failed");
      }
      await loadImportantContacts();
      showToast(`Added ${name || email} to Important`, "ok");
    } catch (err) {
      showToast(`Add failed: ${err.message || err}`, "error");
    }
  }

  document.getElementById("importantAddBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    addImportantContact();
  });

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
    const btn = document.getElementById("loadMoreBtn");
    if (!row) return;
    if (_loadingMore) {
      row.hidden = false;
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Loading more…";
      }
      return;
    }
    if (!_nextPageToken) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Load more";
    }
  }
  let _loadingMore = false;
  async function loadMore() {
    if (!_nextPageToken || _loadingMore) return;
    _loadingMore = true;
    updateLoadMoreButton();
    try {
      const result = await loadInbox({ pageToken: _nextPageToken });
      const newMessages = result.messages || [];
      _allMessages = _allMessages.concat(newMessages);
      _nextPageToken = result.nextPageToken;
      appendList(newMessages);
      if (_currentFolder === "inbox" && !_currentQuery) {
        classifyVisible(newMessages);
      }
    } catch (err) {
      const btn = document.getElementById("loadMoreBtn");
      if (btn) btn.textContent = "Load failed — tap to retry";
    } finally {
      _loadingMore = false;
      updateLoadMoreButton();
    }
  }
  function appendList(messages) {
    const listEl2 = document.getElementById("mailList");
    if (!listEl2 || !messages.length) return;
    // Reuse renderList but only add new rows. Markup MUST stay in sync with
    // renderList — keep hover actions, threadId data attr, all of it.
    const html = messages
      .map((m) => {
        const f = parseFrom(m.from);
        const initial = initialOf(f);
        const senderLabel = escapeHtml(f.name || f.email);
        const subj = escapeHtml(m.subject);
        const snip = escapeHtml(m.snippet).slice(0, 140);
        const when = escapeHtml(timeAgo(m.internalDate));
        const unreadCls = m.unread ? "unread" : "";
        const isStarred = Array.isArray(m.labelIds) && m.labelIds.includes("STARRED");
        const clip = m.hasAttachments ? `<span class="mail-attach-icon" title="Has attachment"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6h-1.5v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg></span>` : "";
        return `
          <div class="mail-row ${unreadCls}" data-id="${escapeHtml(m.id)}" data-thread-id="${escapeHtml(m.threadId || "")}">
            <div class="mail-avatar">${escapeHtml(initial)}</div>
            <div class="mail-body">
              <div class="mail-row-top">
                <div class="mail-sender" dir="auto">${senderLabel}</div>
                <div class="mail-row-top-right">${clip}<div class="mail-time">${when}</div></div>
              </div>
              <div class="mail-subject" dir="auto">${subj}</div>
              <div class="mail-row-meta">
                <span class="mail-tag-slot" data-tag-for="${escapeHtml(m.id)}"></span>
                <span class="mail-snippet" dir="auto">${snip}</span>
              </div>
            </div>
            <div class="mail-row-actions" data-actions-for="${escapeHtml(m.id)}">
              <button class="mra-btn" data-action="toggle-read" title="${m.unread ? "Mark read" : "Mark unread"}">
                <svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
              </button>
              <button class="mra-btn ${isStarred ? "starred" : ""}" data-action="toggle-star" title="${isStarred ? "Unstar" : "Star"}">
                <svg viewBox="0 0 24 24" ${isStarred ? "" : 'fill="none" stroke="currentColor" stroke-width="2"'}>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
              <button class="mra-btn" data-action="archive" title="Archive">
                <svg viewBox="0 0 24 24"><path d="M20.54 5.23l-1.39-1.68A1.45 1.45 0 0 0 18 3H6a1.45 1.45 0 0 0-1.15.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
              </button>
              <button class="mra-btn delete" data-action="trash" title="Delete">
                <svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>
            </div>
          </div>`;
      })
      .join("");
    listEl2.insertAdjacentHTML("beforeend", html);
    // Re-wire click handlers for the new rows
    listEl2.querySelectorAll(".mail-row").forEach((row) => {
      if (row._wired) return;
      row._wired = true;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".mail-row-actions")) return;
        onSelect(row.dataset.id, _allMessages);
      });
    });
    // Re-wire hover quick-actions for the appended batch only
    wireRowQuickActions(_allMessages);
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

  // Infinite scroll — auto-fire loadMore when the user scrolls near the
  // bottom of the inbox list. Cheap to do here because the list element
  // has its own scrollbar; we just listen for its scroll event.
  // The 'Load more' button stays as a visible fallback in case the
  // user scrolls super fast or has JS issues.
  const inboxListEl = document.getElementById("mailList");
  if (inboxListEl) {
    let scrollDebounce = null;
    inboxListEl.addEventListener("scroll", () => {
      if (scrollDebounce) return;
      scrollDebounce = requestAnimationFrame(() => {
        scrollDebounce = null;
        if (!_nextPageToken || _loadingMore) return;
        // Fire when we're within ~300px of the bottom.
        const nearBottom = inboxListEl.scrollTop + inboxListEl.clientHeight
                           >= inboxListEl.scrollHeight - 300;
        if (nearBottom) loadMore();
      });
    });
  }

  // Pull the user's Important contacts (per-user; no longer auto-seeded).
  loadImportantContacts();
  // Pull the user's real Gmail labels into the "Folders" rail section.
  loadGmailFolders();

  // =============================================================
  // Phase 5.CM-3 — INBOX-SCOPED KEYBOARD SHORTCUTS — Gmail-style hotkeys
  // for the message list and reader toolbar. Cross-page navigation /
  // search / compose live in /shortcuts-global.js; this block adds the
  // inbox-only ones (j/k row navigation, e archive, # trash, r reply,
  // etc.). Per-user remapping via window.NexaShortcutOverride(label)
  // (kept on the legacy name so Settings → Shortcuts works as-is).
  // Skips firing when focused element is an input / textarea /
  // contenteditable so we don't intercept normal typing.
  // =============================================================
  (function installInboxShortcuts() {
    const ACTIONS = {
      "New email":            { key: "c",     fn: () => document.getElementById("composeBtn")?.click() },
      "Search inbox":         { key: "/",     fn: () => document.querySelector(".search-input")?.focus() },
      "Next message":         { key: "j",     fn: () => moveSel(+1) },
      "Previous message":     { key: "k",     fn: () => moveSel(-1) },
      "Open selected thread": { key: "Enter", fn: () => document.querySelector(".msg.selected")?.click() },
      "Archive thread":       { key: "e",     fn: () => clickToolbar("archive") },
      "Move to trash":        { key: "#",     fn: () => clickToolbar("trash") },
      "Mark as unread":       { key: "u",     fn: () => clickToolbar("unread") },
      "Star / unstar":        { key: "s",     fn: () => clickToolbar("star") },
      "Snooze thread":        { key: "b",     fn: () => clickToolbar("snooze") },
      "Reply":                { key: "r",     fn: () => clickToolbar("reply") },
      "Reply all":            { key: "a",     fn: () => clickToolbar("reply-all") },
      "Forward":              { key: "f",     fn: () => clickToolbar("forward") },
    };

    function moveSel(delta) {
      const rows = Array.from(document.querySelectorAll(".msg"));
      if (!rows.length) return;
      const sel = document.querySelector(".msg.selected");
      const idx = sel ? rows.indexOf(sel) : -1;
      const next = rows[Math.max(0, Math.min(rows.length - 1, idx + delta))];
      next?.click();
      next?.scrollIntoView({ block: "nearest" });
    }
    function clickToolbar(action) {
      const btn = document.querySelector(`.tb-btn[data-tb="${action}"]`);
      btn?.click();
    }

    function keyMatches(binding, event) {
      if (!binding) return false;
      const parts = binding.split(/\s+|\+/).filter(Boolean);
      const wantsMeta  = parts.some((p) => /^(⌘|Cmd|Meta|Win)$/i.test(p));
      const wantsCtrl  = parts.some((p) => /^(Ctrl|Control)$/i.test(p));
      const wantsShift = parts.some((p) => /^(⇧|Shift)$/i.test(p));
      const wantsAlt   = parts.some((p) => /^(⌥|Alt|Option)$/i.test(p));
      const last = parts.filter((p) => !/^(⌘|Cmd|Meta|Win|Ctrl|Control|⇧|Shift|⌥|Alt|Option)$/i.test(p)).pop();
      if (!last) return false;
      const evKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const wantKey = last.length === 1 ? last.toLowerCase() : last;
      if (evKey !== wantKey) return false;
      if (!!event.metaKey  !== wantsMeta)  return false;
      if (!!event.ctrlKey  !== wantsCtrl)  return false;
      if (!!event.shiftKey !== wantsShift) return false;
      if (!!event.altKey   !== wantsAlt)   return false;
      return true;
    }

    function isTypingTarget(t) {
      if (!t) return false;
      const tag = (t.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (t.isContentEditable) return true;
      return false;
    }

    document.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;
      // Skip if a modal/popover that owns its own keys is open.
      if (document.getElementById("snoozePopover")) return;
      if (document.getElementById("snoozeCustomModal")) return;
      const attachPrev = document.getElementById("attachmentPreview");
      if (attachPrev && !attachPrev.hidden) return;

      for (const [label, def] of Object.entries(ACTIONS)) {
        const override = (typeof window.NexaShortcutOverride === "function" ? window.NexaShortcutOverride(label) : null) || def.key;
        if (keyMatches(override, e)) {
          e.preventDefault();
          try { def.fn(); } catch (_) {}
          return;
        }
      }
    });

    // Tiny helper so the Settings → Shortcuts page can know which
    // actions are wired today vs. stub-only documentation.
    window.NexaWiredShortcutActions = (window.NexaWiredShortcutActions || []).concat(Object.keys(ACTIONS));
    window.DeltaWiredShortcutActions = window.NexaWiredShortcutActions;
  })();

  // ---------- DELTA SEARCH FILTER MODE ----------
  // Called from assistant.js when the user clicks an email reference that
  // came from a recent search_inbox tool result. Replaces the inbox list
  // with the search results until the user clears.
  window.activateDeltaSearchFilter = function(searchData, focusId) {
    if (!searchData || !Array.isArray(searchData.results) || !searchData.results.length) {
      // No results to show — just fall through to single-email open.
      if (focusId && typeof window.openMailById === "function") {
        window.openMailById(focusId);
      }
      return;
    }

    // Normalize Delta's stub shape into our mail-row shape.
    const stubs = searchData.results.map((r) => ({
      id: r.id,
      threadId: r.threadId || "",
      from: r.from || "",
      to: "",
      cc: "",
      subject: r.subject || "(no subject)",
      snippet: r.snippet || "",
      date: r.date || "",
      internalDate: r.date ? String(new Date(r.date).getTime()) : null,
      labelIds: [],
      unread: false,
    }));

    if (!_deltaSearchActive) {
      _deltaSearchSnapshot = _allMessages;     // save current view
    }
    _deltaSearchActive = true;
    _deltaSearchQuery = searchData.query || "";
    _allMessages = stubs;
    _nextPageToken = null;                    // disable infinite-scroll fetch

    // Banner
    const banner = document.getElementById("deltaSearchBanner");
    const qEl = document.getElementById("dsbQuery");
    const cEl = document.getElementById("dsbCount");
    if (banner) banner.hidden = false;
    if (qEl) qEl.textContent = `"${searchData.query || ""}"`;
    if (cEl) cEl.textContent = `· ${stubs.length} result${stubs.length === 1 ? "" : "s"}`;

    renderList(_allMessages);
    updateLoadMoreButton();

    // Open the clicked email
    if (focusId) {
      const row = document.querySelector(`.mail-row[data-id="${CSS.escape(focusId)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("just-opened");
        setTimeout(() => row.classList.remove("just-opened"), 1500);
      }
      onSelect(focusId, _allMessages);
    }

    // Classify any of the search results we haven't seen — paints tags.
    if (_currentFolder === "inbox") {
      classifyVisible(_allMessages);
    }
  };

  function clearDeltaSearch() {
    if (!_deltaSearchActive) return;
    _deltaSearchActive = false;
    _deltaSearchQuery = "";
    const banner = document.getElementById("deltaSearchBanner");
    if (banner) banner.hidden = true;

    // Restore the previous list if we had one cached, otherwise reload.
    if (_deltaSearchSnapshot && _deltaSearchSnapshot.length) {
      _allMessages = _deltaSearchSnapshot;
      _deltaSearchSnapshot = null;
      renderList(_allMessages);
    } else {
      _deltaSearchSnapshot = null;
      refreshInbox();
    }
  }
  document.getElementById("dsbClearBtn")?.addEventListener("click", clearDeltaSearch);

  async function main() {
    try {
      const me = await loadMe();
      renderUser(me);
      // Phase 5.BF — expose user info for voice.js. The realtime greeting
      // needs the first name so it can open with "Hi Shahryar, …" rather
      // than a generic "Hi there".
      const fullName = me?.display_name || me?.name || me?.email || "";
      const firstName = String(fullName).split(/[ @]/)[0] || "there";
      window.__deltaUser = { email: me?.email, firstName, fullName };
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

      // Deep-link: /?msg=<gmailId> opens that message in the reader.
      // Used by /tasks "Open source email" links and other cross-page jumps.
      await openMessageFromUrlIfPresent();

      // Wire up notification bell + start polling (Phase 5.BB).
      try { initNotificationCenter(); } catch (err) { console.warn("[notif] init failed:", err); }
    } catch (err) {
      listEl.innerHTML = `
        <div class="list-empty">
          <div class="empty-icon">⚠︎</div>
          <div class="empty-title">Couldn't load Gmail</div>
          <div class="empty-sub">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    }
  }

  // Reads ?msg=<id> from the URL and opens that message. If the message is
  // already in the visible inbox list, just click its row. If not (e.g. an
  // older email surfaced from /tasks), fetch a stub from the server, prepend
  // it to the list, and open it.
  // Opens a Gmail message by id from anywhere in the app (Delta chat refs,
  // task source-email links, ?msg= URL param). If the message is already in
  // the visible inbox snapshot, scrolls + clicks the row. Otherwise fetches
  // a stub via /api/gmail/message/:id, prepends it to the list, then opens.
  // Exposed on window so the assistant panel can reach it without coupling.
  async function openMailById(msgId) {
    if (!msgId) return false;
    const existing = _allMessages.find((m) => m.id === msgId);
    if (existing) {
      const row = document.querySelector(`.mail-row[data-id="${CSS.escape(msgId)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("just-opened");
        setTimeout(() => row.classList.remove("just-opened"), 1500);
      }
      onSelect(msgId, _allMessages);
      return true;
    }
    try {
      const r = await fetch(`/api/gmail/message/${encodeURIComponent(msgId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const h = data.headers || {};
      const stub = {
        id: msgId,
        threadId: data.threadId || null,
        from: h.from || "",
        to: h.to || "",
        cc: h.cc || "",
        subject: h.subject || "(no subject)",
        date: h.date || "",
        snippet: data.snippet || "",
        internalDate: data.internalDate || null,
        labelIds: data.labelIds || [],
        unread: (data.labelIds || []).includes("UNREAD"),
      };
      _allMessages = [stub, ..._allMessages];
      renderList(_allMessages);
      onSelect(msgId, _allMessages);
      const row = document.querySelector(`.mail-row[data-id="${CSS.escape(msgId)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("just-opened");
        setTimeout(() => row.classList.remove("just-opened"), 1500);
      }
      return true;
    } catch (err) {
      showToast(`Couldn't open that email: ${err.message || err}`, "error");
      return false;
    }
  }
  // Expose for Delta chat panel + any cross-module callers.
  window.openMailById = openMailById;

  // Phase 5.AV — promote a Delta-drafted reply from the chat panel
  // into the real middle-pane composer. Used by the chat-draft card's
  // "Open in main composer" button. Pre-fills the composer with the
  // draft body Delta already produced, so the user lands directly on
  // the ready-to-edit version (no second LLM call to regenerate).
  window.openComposerWithDraft = async function(draft, opts = {}) {
    if (!draft) return;
    const msgId = draft.messageId;
    if (!msgId) return;
    // Phase 5.CO — carry the FULL server draft into the prefill, not
    // just the body. draft_reply / compose already returned to, cc,
    // subject, threadId, inReplyTo, deltaDraftId — everything Send
    // needs. Previously we kept only `body` and openDraftComposer
    // re-fetched the metadata via a SECOND /api/assistant/draft call;
    // that re-fetch (a) raced the Send button (currentDraft stayed null
    // until it resolved, so Send silently did nothing) and (b) always
    // re-drafted in reply-only mode, dropping reply-all Cc recipients.
    // Now openDraftComposer can populate currentDraft synchronously.
    window._smartReplyPrefill = {
      messageId: msgId,
      body: draft.body || "",
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      threadId: draft.threadId,
      inReplyTo: draft.inReplyTo,
      deltaDraftId: draft.deltaDraftId,
      intent: "chat-drafted",
    };
    // Reply mode — honour the mode the draft was created in. Explicit
    // opts.mode wins; then the draft's own mode; then infer reply-all
    // from a populated Cc; default reply.
    const draftMode =
      opts.mode === "reply-all" ? "reply-all"
      : draft.mode === "reply-all" ? "reply-all"
      : (draft.cc && String(draft.cc).trim()) ? "reply-all"
      : "reply";
    window._smartReplyPrefill.mode = draftMode;
    // Optionally close the Delta side panel. Voice mode (Phase 5.BK)
    // passes keepDeltaOpen=true so the user can keep talking after a
    // draft is created (e.g. "make it shorter") — the composer still
    // appears in the middle column even with the Delta panel up.
    if (!opts.keepDeltaOpen) {
      document.querySelector(".delta-close")?.click();
    }
    // Find the message — fetch if not in the visible inbox cache.
    let existing = _allMessages.find((m) => m.id === msgId);
    if (!existing) {
      const ok = await openMailById(msgId); // also selects + renders reader
      if (!ok) return;
      existing = _allMessages.find((m) => m.id === msgId);
      if (!existing) return;
    } else {
      // Phase 5.BL — AWAIT onSelect. Without this the reader re-render
      // races the composer mount, and the composer ends up attached to
      // a stale DOM node that gets replaced, so it "blinks and goes".
      // Only re-select if the message isn't already the currently-
      // displayed one (avoid an unnecessary re-render that kills the
      // composer when the user just re-asks Delta to revise).
      const currentlySelected = document.querySelector(".mail-row.selected")?.dataset?.id;
      if (currentlySelected !== msgId) {
        await onSelect(msgId, _allMessages);
      }
    }

    // Now open the composer inside the fresh reader DOM, in the same
    // mode the draft was created in (reply vs reply-all). Phase 5.CO.
    onToolbarAction(draftMode === "reply-all" ? "reply-all" : "reply", existing);

    // Scroll the composer into view + flash a subtle highlight so the
    // user can't miss it when it pops up behind the Delta panel.
    requestAnimationFrame(() => {
      const composer =
        document.querySelector(".compose-modal:not([hidden])") ||
        document.querySelector(".draft-composer") ||
        document.querySelector(".draft-composer-docked");
      if (composer) {
        composer.scrollIntoView({ behavior: "smooth", block: "center" });
        composer.classList.add("voice-draft-flash");
        setTimeout(() => composer.classList.remove("voice-draft-flash"), 1800);
      }
    });
  };

  // Phase 5.BL — keep voice-created drafts alive. If the composer dies
  // for any reason while voice is still running, this re-opens it.
  // Voice mode calls window.__reopenVoiceDraft(draft) on its tool-call
  // success path, and exitVoiceMode also calls it once on close.
  window.__reopenVoiceDraft = async function(draft) {
    if (!draft || !draft.messageId) return;
    // If the composer is already visible AND showing the same message,
    // just refresh the body. Otherwise re-open via openComposerWithDraft.
    const openComposer =
      document.querySelector(".compose-modal:not([hidden])") ||
      document.querySelector(".draft-composer");
    const currentMsg = openComposer?.dataset?.messageId;
    if (openComposer && currentMsg === draft.messageId) {
      // Refresh body in place — used when user says "make it shorter"
      // and the model returns a new draft for the same email.
      const bodyEl = openComposer.querySelector(".draft-body") ||
                     openComposer.querySelector(".compose-body-rich") ||
                     openComposer.querySelector("textarea");
      if (bodyEl) {
        if (bodyEl.tagName === "TEXTAREA") bodyEl.value = draft.body || "";
        else bodyEl.innerHTML = draft.body || "";
        openComposer.classList.add("voice-draft-flash");
        setTimeout(() => openComposer.classList.remove("voice-draft-flash"), 1500);
      }
      return;
    }
    return window.openComposerWithDraft(draft, { keepDeltaOpen: true });
  };

  // -------- Notification center (Phase 5.BB) ----------------------------
  // Bell icon in list header → dropdown of actionable items (overdue
  // promises, due-soon tasks, important-sender unread mail). Click an
  // item → navigate to the source (email, /promises, or /tasks).
  // ----------------------------------------------------------------------
  let _notifPollHandle = null;
  let _notifCache = { notifications: [], unread_count: 0 };

  function initNotificationCenter() {
    const bell = document.getElementById("notifBellBtn");
    const dropdown = document.getElementById("notifDropdown");
    const clearAllBtn = document.getElementById("notifClearAll");
    if (!bell || !dropdown) return;

    bell.addEventListener("click", async (e) => {
      e.stopPropagation();
      const isOpen = !dropdown.hasAttribute("hidden");
      if (isOpen) {
        dropdown.setAttribute("hidden", "");
        return;
      }
      // Opening: render current cache immediately, then mark as seen.
      renderNotifications(_notifCache.notifications);
      dropdown.removeAttribute("hidden");
      try {
        await fetch("/api/notifications/seen", { method: "POST" });
        // Hide unread badge immediately for snappy UX.
        const badge = document.getElementById("notifBadge");
        if (badge) { badge.setAttribute("hidden", ""); badge.textContent = "0"; }
      } catch (_) {}
    });

    clearAllBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await fetch("/api/notifications/dismiss-all", { method: "POST" });
        _notifCache.notifications = [];
        renderNotifications([]);
        updateBadge(0);
      } catch (err) {
        console.warn("[notif] clear-all failed:", err);
      }
    });

    // Close dropdown when clicking outside it.
    document.addEventListener("click", (e) => {
      if (dropdown.hasAttribute("hidden")) return;
      if (dropdown.contains(e.target) || bell.contains(e.target)) return;
      dropdown.setAttribute("hidden", "");
    });

    // Initial fetch + recurring poll every 60s.
    pollNotifications();
    _notifPollHandle = setInterval(pollNotifications, 60_000);
  }

  async function pollNotifications() {
    try {
      const r = await fetch("/api/notifications");
      if (!r.ok) return;
      const data = await r.json();
      if (!data.ok) return;
      _notifCache = data;
      updateBadge(data.unread_count || 0);
      // If dropdown is open, refresh its contents in place.
      const dropdown = document.getElementById("notifDropdown");
      if (dropdown && !dropdown.hasAttribute("hidden")) {
        renderNotifications(data.notifications || []);
      }
    } catch (err) {
      // Silent — bell just stays at previous state.
    }
  }

  function updateBadge(count) {
    const badge = document.getElementById("notifBadge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.removeAttribute("hidden");
    } else {
      badge.setAttribute("hidden", "");
    }
  }

  function notifIconFor(kind) {
    // Returns inline SVG markup matching the notification kind.
    if (kind === "promise-overdue") return `<svg viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm0 6l7.53 13H4.47L12 8zm-1 4v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>`;
    if (kind === "task-overdue") return `<svg viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/></svg>`;
    if (kind === "task-due-soon") return `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zM12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;
    if (kind === "important-unread") return `<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`;
  }

  function renderNotifications(items) {
    const body = document.getElementById("notifDropdownBody");
    if (!body) return;
    if (!items || !items.length) {
      body.innerHTML = `<div class="notif-empty">Nothing to act on right now. Nice.</div>`;
      return;
    }
    body.innerHTML = items.map((n) => `
      <div class="notif-item severity-${escapeHtml(n.severity || "low")}" data-id="${escapeHtml(n.id)}" data-link="${escapeHtml(JSON.stringify(n.link || {}))}">
        <div class="notif-icon">${notifIconFor(n.kind)}</div>
        <div class="notif-body">
          <div class="notif-title">${escapeHtml(n.title || "")}</div>
          <div class="notif-snippet">${escapeHtml(n.body || "")}</div>
          ${n.meta ? `<div class="notif-meta">${escapeHtml(n.meta)}</div>` : ""}
        </div>
        <button class="notif-dismiss" title="Dismiss" aria-label="Dismiss">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    `).join("");

    body.querySelectorAll(".notif-item").forEach((row) => {
      row.addEventListener("click", async (e) => {
        if (e.target.closest(".notif-dismiss")) return;
        let link = {};
        try { link = JSON.parse(row.dataset.link || "{}"); } catch (_) {}
        if (link.type === "email" && link.message_id) {
          // Open in the inbox reader (this page).
          document.getElementById("notifDropdown")?.setAttribute("hidden", "");
          try { await openMailById(link.message_id); } catch (err) { showToast?.(`Couldn't open: ${err.message}`, "error"); }
        } else if (link.type === "promises") {
          window.location.href = "/promises";
        } else if (link.type === "tasks") {
          window.location.href = "/tasks";
        }
      });
    });

    body.querySelectorAll(".notif-dismiss").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const row = btn.closest(".notif-item");
        const id = row?.dataset.id;
        if (!id) return;
        row.style.opacity = "0.4";
        try {
          await fetch(`/api/notifications/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
          row.remove();
          _notifCache.notifications = (_notifCache.notifications || []).filter((n) => n.id !== id);
          if (!_notifCache.notifications.length) renderNotifications([]);
        } catch (err) {
          row.style.opacity = "1";
          console.warn("[notif] dismiss failed:", err);
        }
      });
    });
  }

  async function openMessageFromUrlIfPresent() {
    const params = new URLSearchParams(window.location.search);
    const msgId = params.get("msg");
    if (!msgId) return;

    // Clean the URL bar so a refresh doesn't keep reopening + the back button
    // returns to a normal /inbox state.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("msg");
      window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
    } catch (_) {}

    try {
      await openMailById(msgId);
    } catch (err) {
      showToast(`Couldn't open that email: ${err.message || err}`, "error");
    }
  }

  main();
})();
