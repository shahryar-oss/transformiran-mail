// Delta FAB + panel controller + chat client.
// Wires:
//   - FAB toggle (welcome panel slides in from the right)
//   - Welcome textarea/Send + suggestion chips → POST /api/assistant
//   - Transition welcome → chat state on first message
//   - Markdown rendering of Delta's responses (bold/headings/lists/code/links)
//   - Per-message action row (Copy, Regenerate)
//   - 'New chat' button to wipe the conversation
//   - Esc / click outside to close
//
// Stateless backend: every turn sends {message, history, openMessageId?}.

// =====================================================================
// MARKDOWN — minimal, focused parser for Delta's structured replies.
// Handles: # ## ### headings, **bold**, *italic*, `code`, ```code blocks,
// - bullet lists, 1. numbered lists, > blockquotes, [text](url) links,
// blank-line paragraphs, soft line breaks. NOT a full CommonMark parser;
// just enough to render Delta's responses cleanly + safely.
// =====================================================================
function renderMarkdown(src) {
  if (!src) return "";

  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  // Unique placeholders that won't appear in normal text.
  const PH_OPEN = "\x01\x02";
  const PH_CLOSE = "\x02\x01";
  const codeBlocks = [];
  const tableBlocks = [];

  // 1. Pull fenced code blocks out first so their contents aren't re-parsed.
  src = src.replace(/```([a-z0-9_-]*)\n?([\s\S]*?)```/gi, (m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(esc(code.replace(/\n$/, "")));
    return `${PH_OPEN}CB${idx}${PH_CLOSE}`;
  });

  // 2. GFM-style markdown tables (with separator row).
  //    | Col 1 | Col 2 |
  //    |-------|------:|
  //    | a     | b     |
  src = src.replace(
    /(^|\n)((?:\|[^\n]*\|[ \t]*\n)(?:\|[\s:\-|]+\|[ \t]*\n)(?:\|[^\n]*\|[ \t]*\n?)+)/g,
    (m, pfx, block) => {
      const rows = block.trim().split("\n").map((r) => r.trim());
      const splitRow = (row) =>
        row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = splitRow(rows[0]);
      const sep = splitRow(rows[1]);
      if (!sep.every((c) => /^:?-{1,}:?$/.test(c))) return m;
      const align = sep.map((s) => {
        const left = s.startsWith(":");
        const right = s.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
      });
      const body = rows.slice(2).map(splitRow);
      const cellInline = (cell) => {
        let c = esc(cell);
        c = c.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        c = c.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
        c = c.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
        return c;
      };
      let html = '<table class="md-table"><thead><tr>';
      for (let i = 0; i < header.length; i++) {
        const a = align[i] ? ` style="text-align:${align[i]}"` : "";
        html += `<th${a}>${cellInline(header[i])}</th>`;
      }
      html += "</tr></thead><tbody>";
      for (const row of body) {
        html += "<tr>";
        for (let i = 0; i < header.length; i++) {
          const a = align[i] ? ` style="text-align:${align[i]}"` : "";
          html += `<td${a}>${cellInline(row[i] || "")}</td>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
      const idx = tableBlocks.length;
      tableBlocks.push(html);
      return `${pfx}${PH_OPEN}TBL${idx}${PH_CLOSE}`;
    }
  );

  // 3. Fallback table: 2+ consecutive `|`-delimited lines with NO separator
  //    row. Delta sometimes forgets the separator — treat first line as
  //    header anyway. We require 2+ pipes per line (3+ columns) to avoid
  //    grabbing every paragraph with one stray pipe.
  src = src.replace(
    /(^|\n)((?:\|[^\n|]+\|[^\n|]+\|[^\n]*(?:\n|$)){2,})/g,
    (m, pfx, block) => {
      const rows = block.trim().split("\n").map((r) => r.trim());
      const splitRow = (row) =>
        row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      // If line 2 is a real separator, leave for the strict matcher above.
      if (rows[1] && splitRow(rows[1]).every((c) => /^:?-{1,}:?$/.test(c))) return m;
      const header = splitRow(rows[0]);
      const body = rows.slice(1).map(splitRow);
      const cellInline = (cell) => {
        let c = esc(cell);
        c = c.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        return c;
      };
      let html = '<table class="md-table"><thead><tr>';
      for (const h of header) html += `<th>${cellInline(h)}</th>`;
      html += "</tr></thead><tbody>";
      for (const row of body) {
        html += "<tr>";
        for (let i = 0; i < header.length; i++) {
          html += `<td>${cellInline(row[i] || "")}</td>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
      const idx = tableBlocks.length;
      tableBlocks.push(html);
      return `${pfx}${PH_OPEN}TBL${idx}${PH_CLOSE}`;
    }
  );

  // 4. Escape the rest of the text.
  src = esc(src);

  // 5. Restore code blocks + tables.
  src = src.replace(
    new RegExp(PH_OPEN + "CB(\\d+)" + PH_CLOSE, "g"),
    (m, i) => `<pre class="md-pre"><code>${codeBlocks[+i]}</code></pre>`
  );
  src = src.replace(
    new RegExp(PH_OPEN + "TBL(\\d+)" + PH_CLOSE, "g"),
    (m, i) => tableBlocks[+i]
  );

  // 6. Inline code.
  src = src.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');

  // 7. Email refs: [text](email:<message_id>) — clickable.
  src = src.replace(/\[([^\]]+)\]\(email:([A-Za-z0-9_-]{6,64})\)/g,
    '<a href="#" class="md-email-ref" data-msg-id="$2">$1</a>');

  // 8. Links: [text](url) — only http(s) or relative paths.
  src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 9. Headings (must run before bold so '# **X**' doesn't get mangled).
  src = src.replace(/^###\s+(.+)$/gm, '<h4 class="md-h">$1</h4>');
  src = src.replace(/^##\s+(.+)$/gm, '<h3 class="md-h">$1</h3>');
  src = src.replace(/^#\s+(.+)$/gm, '<h2 class="md-h">$1</h2>');

  // 10. Bold + italic. Bold first to avoid greedy single-star matches.
  src = src.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  src = src.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  src = src.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  src = src.replace(/(^|[\s(])_([^_\n]+)_($|[\s),.!?])/g, "$1<em>$2</em>$3");

  // 11. Blockquotes.
  src = src.replace(/(^|\n)>\s?(.+?)(?=\n[^>]|\n*$)/g, (m, pfx, content) => {
    return pfx + '<blockquote class="md-bq">' + content + "</blockquote>";
  });

  // 12. Group consecutive bullet/numbered lines into <ul>/<ol>.
  const lines = src.split("\n");
  const out = [];
  let listType = null;
  let para = [];

  function flushPara() {
    if (!para.length) return;
    const text = para.join(" ");
    if (text.trim()) out.push("<p>" + text + "</p>");
    para = [];
  }
  function openList(type) {
    if (listType === type) return;
    if (listType) out.push(`</${listType}>`);
    out.push(`<${type} class="md-list">`);
    listType = type;
  }
  function closeList() {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^(\d+)\.\s+(.+)$/);
    const isBlock = /^<(h\d|blockquote|pre|table)\b/.test(line.trimStart());

    if (bullet) {
      flushPara();
      openList("ul");
      out.push("<li>" + bullet[1] + "</li>");
    } else if (numbered) {
      flushPara();
      openList("ol");
      out.push("<li>" + numbered[2] + "</li>");
    } else if (isBlock) {
      flushPara();
      closeList();
      out.push(line);
    } else if (line.trim() === "") {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();

  return out.join("\n");
}

// Phase 5.AS — expose to global so the docked Delta action card in
// the inbox reader can use the same markdown renderer.
window.renderMarkdown = renderMarkdown;

(() => {
  const fab = document.getElementById("deltaFab");
  const panel = document.getElementById("deltaPanel");
  const closeBtn = panel?.querySelector(".delta-close");
  const newChatBtn = document.getElementById("deltaNewChat");
  const welcome = document.getElementById("deltaWelcome");
  const chat = document.getElementById("deltaChat");
  const messagesEl = document.getElementById("deltaMessages");
  const inputWelcome = document.getElementById("deltaInputWelcome");
  const sendWelcome = document.getElementById("deltaSendWelcome");
  const inputChat = document.getElementById("deltaInputChat");
  const sendChat = document.getElementById("deltaSendChat");
  const suggestionsEl = document.getElementById("deltaSuggestions");

  if (!fab || !panel) return;

  // Conversation state — array of {role:"user"|"assistant", content:string}
  let history = [];

  // Per-user model preference — loaded from /api/me on open
  let selectedModel = "basic";
  function getSelectedModel() { return selectedModel; }
  async function loadUserPrefs() {
    try {
      const r = await fetch("/api/me");
      if (!r.ok) return;
      const me = await r.json();
      if (me.preferredModel === "basic" || me.preferredModel === "advanced") {
        selectedModel = me.preferredModel;
        updateModelLabel();
      }
    } catch (_) {}
  }
  function updateModelLabel() {
    const lbl = document.getElementById("deltaModelLabel");
    if (lbl) lbl.textContent = selectedModel === "advanced" ? "Advanced" : "Basic";
  }
  async function setModel(m) {
    selectedModel = m;
    updateModelLabel();
    try {
      await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferred_model: m }),
      });
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // -- panel toggle ------------------------------------------------------
  function isOpen() { return panel.classList.contains("open"); }
  function openPanel() {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    fab.classList.add("open");
    document.body.classList.add("delta-panel-open");
    setTimeout(() => {
      const focusEl = chat.hidden ? inputWelcome : inputChat;
      focusEl?.focus();
    }, 80);
    // Phase 5.AD — show today's morning briefing on panel open. Fires once
    // per session; if already shown today, the helper skips quietly.
    maybeShowMorningBriefing();
    // Phase 5.AF — surface any pending decision-rule suggestions.
    maybeShowRuleSuggestions();
  }
  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    fab.classList.remove("open");
    document.body.classList.remove("delta-panel-open");
  }

  fab.addEventListener("click", () => { isOpen() ? closePanel() : openPanel(); });
  closeBtn?.addEventListener("click", closePanel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) closePanel();
  });
  document.addEventListener("click", (e) => {
    if (!isOpen()) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    closePanel();
  });

  // -- conversation rendering --------------------------------------------
  function getOpenMessageId() {
    const sel = document.querySelector(".mail-row.selected");
    return sel ? sel.dataset.id : null;
  }

  function appendMessage(role, text, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = "delta-msg-wrap " + role;

    const bubble = document.createElement("div");
    bubble.className = "delta-msg " + role + (opts.loading ? " loading" : "") + (opts.error ? " error" : "");

    if (role === "assistant" && !opts.error && !opts.loading) {
      // Render markdown so headings/bold/lists actually display.
      bubble.innerHTML =
        `<img class="delta-msg-avatar" src="/delta-logo.png" alt="Delta">` +
        `<div class="md-content">${renderMarkdown(text)}</div>`;
      // Wire email-ref clicks.
      bubble.querySelectorAll(".md-email-ref").forEach((a) => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const id = a.dataset.msgId;
          if (id) openEmailById(id);
        });
      });
    } else if (role === "assistant" && opts.loading) {
      bubble.innerHTML =
        `<img class="delta-msg-avatar" src="/delta-logo.png" alt="Delta">` +
        `<span class="delta-thinking">Delta is thinking<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>`;
    } else if (role === "assistant" && opts.error) {
      bubble.textContent = text;
    } else {
      bubble.textContent = text;
    }
    wrap.appendChild(bubble);

    // Per-message action row (Copy + Listen + Regenerate) on finalized
    // Delta messages.
    if (role === "assistant" && !opts.loading && !opts.error) {
      const actions = document.createElement("div");
      actions.className = "delta-msg-actions";
      const listenBtnHtml = ttsEnabled
        ? `<button class="delta-msg-act delta-listen" data-act="listen" title="Listen">${ICON.speaker}</button>`
        : "";
      actions.innerHTML = `
        <button class="delta-msg-act" data-act="copy" title="Copy">${ICON.copy}</button>
        ${listenBtnHtml}
        <button class="delta-msg-act" data-act="regen" title="Regenerate">${ICON.regen}</button>
      `;
      actions.querySelector('[data-act="copy"]').addEventListener("click", () => {
        navigator.clipboard.writeText(text).catch(() => {});
        flashAct(actions.querySelector('[data-act="copy"]'), "Copied");
      });
      actions.querySelector('[data-act="regen"]').addEventListener("click", () => regenerateLast());
      const listenBtn = actions.querySelector('[data-act="listen"]');
      if (listenBtn) {
        listenBtn.addEventListener("click", () => toggleListen(listenBtn, text));
      }
      wrap.appendChild(actions);

      // Auto-play newest assistant reply if the user has it enabled
      // (off by default; user toggles via the speaker icon in the
      // panel header).
      if (autoPlayEnabled && !opts.isHistoryReplay && ttsEnabled && listenBtn) {
        console.log("[tts] auto-play triggered for new assistant message", { textLen: text.length, ctxState: audioCtx?.state });
        // Pulse the Listen button so even if Safari ultimately mutes
        // the programmatic playback, the user sees a clear "tap me
        // to hear" affordance.
        listenBtn.classList.add("autoplay-pulse");
        setTimeout(() => listenBtn.classList.remove("autoplay-pulse"), 4000);
        // Slight defer so the message bubble paints first.
        setTimeout(() => {
          toggleListen(listenBtn, text, { autoplay: true }).catch((err) => {
            console.warn("[tts] auto-play failed:", err);
            ttsToast("Tap the speaker on the reply to hear it", { error: true });
          });
        }, 80);
      }
    }

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  const ICON = {
    copy:    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>`,
    regen:   `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4V1L8 5l4 4V6c3.3 0 6 2.7 6 6 0 1-.3 2-.7 2.8l1.5 1.5C19.5 15 20 13.6 20 12c0-4.4-3.6-8-8-8zm-6.3 4.7L4.2 7.2C3.5 9 3 10.4 3 12c0 4.4 3.6 8 8 8v3l4-4-4-4v3c-3.3 0-6-2.7-6-6 0-1 .3-2 .7-2.8z"/></svg>`,
    speaker: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4a1 1 0 0 0 1 1h3l4 4V5L7 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 4.04v2.06a6 6 0 0 1 0 11.8v2.06a8 8 0 0 0 0-15.92z"/></svg>`,
    stop:    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>`,
  };

  // -------- TTS / voice output (Phase 5.AH) --------------------------
  // Listen button on each Delta reply + auto-play toggle in the panel
  // header. Only one audio plays at a time — starting a new one stops
  // any currently-playing audio.
  //
  // Why Web Audio API instead of `new Audio()`: Safari (and increasingly
  // Chrome) kills the "user-gesture" autoplay grant after any `await`
  // in the click handler — so `await fetch(); audio.play();` silently
  // rejects. AudioContext.resume() called synchronously at the start
  // of the click handler "unlocks" the context for the rest of the
  // session, and subsequent decoded buffers play even after async.
  let ttsEnabled = false;
  let ttsProvider = null;
  let autoPlayEnabled = localStorage.getItem("delta-tts-autoplay") === "1";
  let audioCtx = null;             // shared AudioContext (lazy-init)
  let currentSource = null;        // AudioBufferSourceNode currently playing
  let currentListenBtn = null;     // Listen button bound to current source

  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    // Calling resume() inside a user gesture unlocks autoplay for the
    // session even though we'll await network I/O afterwards.
    if (audioCtx.state === "suspended" && audioCtx.resume) {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Small floating toast so an error or "loading" is always visible
  // — silence is never an acceptable failure mode for an audio feature.
  function ttsToast(text, opts = {}) {
    let toast = document.querySelector(".delta-tts-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "delta-tts-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.className = "delta-tts-toast" + (opts.error ? " error" : opts.ok ? " ok" : "");
    toast.style.opacity = "1";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.opacity = "0";
    }, opts.duration || 2400);
  }

  // Probe /api/tts/status once on page load to decide whether to show
  // the Listen + auto-play UI at all.
  (async function probeTtsStatus() {
    try {
      const r = await fetch("/api/tts/status");
      if (!r.ok) return;
      const data = await r.json();
      if (data.ok && data.enabled) {
        ttsEnabled = true;
        ttsProvider = data.provider;
        // Surface the auto-play toggle in the panel head.
        mountAutoPlayToggle();
      }
    } catch (_) {}
  })();

  function mountAutoPlayToggle() {
    const head = document.querySelector(".delta-panel-actions");
    if (!head) return;
    if (head.querySelector(".delta-tts-toggle")) return;
    const btn = document.createElement("button");
    btn.className = "delta-tts-toggle" + (autoPlayEnabled ? " active" : "");
    btn.type = "button";
    btn.title = autoPlayEnabled
      ? "Auto-play Delta replies (ON) — click to turn off"
      : "Auto-play Delta replies (OFF) — click to turn on";
    btn.setAttribute("aria-pressed", autoPlayEnabled ? "true" : "false");
    btn.innerHTML = ICON.speaker;
    btn.addEventListener("click", async () => {
      // SYNCHRONOUSLY unlock the AudioContext while we still have the
      // user-gesture grant. Anything async after this is fine.
      ensureAudioCtx();

      autoPlayEnabled = !autoPlayEnabled;
      localStorage.setItem("delta-tts-autoplay", autoPlayEnabled ? "1" : "0");
      btn.classList.toggle("active", autoPlayEnabled);
      btn.setAttribute("aria-pressed", autoPlayEnabled ? "true" : "false");
      btn.title = autoPlayEnabled
        ? "Auto-play Delta replies (ON) — click to turn off"
        : "Auto-play Delta replies (OFF) — click to turn on";
      // If turning off mid-playback, stop the current audio.
      if (!autoPlayEnabled) {
        stopCurrentAudio();
        ttsToast("Voice off");
        return;
      }
      // Turning ON — speak a one-second confirmation so the user
      // gets immediate audible feedback that TTS is working.
      ttsToast("Generating voice…");
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Voice on. I'll read Delta's replies aloud from now on.",
          }),
        });
        if (!r.ok) {
          const errBody = await r.json().catch(() => ({}));
          throw new Error(errBody.message || errBody.error || ("HTTP " + r.status));
        }
        const arrayBuffer = await r.arrayBuffer();
        await playArrayBuffer(arrayBuffer);
        ttsToast("Voice on", { ok: true });
      } catch (err) {
        console.warn("[tts] confirmation playback failed:", err);
        ttsToast("Voice failed: " + (err.message || "unknown error"), { error: true });
        btn.title = "Auto-play ON — but couldn't play a test (" + (err.message || "error") + ")";
      }
    });
    // Insert before the New chat / close buttons so it sits on the
    // left of the action cluster.
    head.insertBefore(btn, head.firstChild);
  }

  function stopCurrentAudio() {
    if (currentSource) {
      try { currentSource.stop(); } catch (_) {}
      try { currentSource.disconnect(); } catch (_) {}
      currentSource = null;
    }
    if (currentListenBtn) {
      currentListenBtn.classList.remove("playing");
      // Re-render the button content if it had an icon (per-message
      // buttons get a speaker icon back; toggle buttons keep their
      // own state managed separately).
      if (currentListenBtn.dataset.act === "listen" || currentListenBtn.classList.contains("bc-reply-listen") || currentListenBtn.classList.contains("bc-listen")) {
        currentListenBtn.innerHTML = ICON.speaker;
      }
      currentListenBtn.title = "Listen";
      currentListenBtn = null;
    }
  }

  // Decode an ArrayBuffer of MP3 bytes via the shared AudioContext +
  // return a started BufferSourceNode. We keep the source on a module
  // singleton so a second Listen click stops the first.
  function playArrayBuffer(arrayBuffer, onEnded) {
    const ctx = ensureAudioCtx();
    if (!ctx) throw new Error("AudioContext unavailable");
    return new Promise((resolve, reject) => {
      ctx.decodeAudioData(
        arrayBuffer.slice(0), // copy — Safari mutates the input
        (buffer) => {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);
          src.addEventListener("ended", () => {
            if (currentSource === src) {
              stopCurrentAudio();
              if (onEnded) onEnded();
            }
          });
          stopCurrentAudio();
          currentSource = src;
          src.start();
          resolve(src);
        },
        (err) => reject(new Error("decodeAudioData failed: " + (err?.message || err)))
      );
    });
  }

  // Toggle play/stop for a given Delta message. If currently playing
  // this same message, stop. Otherwise: stop whatever's playing, fetch
  // fresh audio bytes, decode + play via AudioContext.
  async function toggleListen(btn, text, opts = {}) {
    if (!ttsEnabled) {
      if (!opts.autoplay) {
        ttsToast("Voice output isn't configured on this server", { error: true });
      }
      throw new Error("tts_not_enabled");
    }
    if (currentListenBtn === btn && currentSource) {
      // Click on already-playing button → stop.
      stopCurrentAudio();
      return;
    }
    // CRITICAL: unlock AudioContext synchronously here, BEFORE any
    // await. Once resumed inside a user gesture, the context stays
    // unlocked for the rest of the session even after async work.
    // For auto-play (no user gesture), this still tries to resume —
    // if Safari refuses, playArrayBuffer will fail visibly.
    ensureAudioCtx();
    stopCurrentAudio();
    // Loading state on the clicked button.
    btn.classList.add("loading");
    btn.innerHTML = `<span class="delta-listen-spinner" aria-hidden="true"></span>`;
    btn.title = opts.autoplay ? "Auto-playing…" : "Generating audio…";
    try {
      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || err.error || ("HTTP " + resp.status));
      }
      const arrayBuffer = await resp.arrayBuffer();
      // Force the context to running BEFORE we try to play. In Safari
      // the context can lapse back to "suspended" while we were
      // awaiting fetch — we need to nudge it back. resume() returns
      // a Promise that resolves once the context is actually running.
      if (audioCtx && audioCtx.state === "suspended" && audioCtx.resume) {
        try { await audioCtx.resume(); } catch (_) {}
      }
      if (audioCtx && audioCtx.state !== "running") {
        // Context wouldn't resume — likely Safari requires a user
        // gesture. Roll back the button to "ready to play" state so
        // the user can tap it.
        btn.classList.remove("loading");
        btn.classList.add("autoplay-pulse");
        btn.innerHTML = ICON.speaker;
        btn.title = "Tap to hear (browser blocked auto-play)";
        if (!opts.autoplay) {
          ttsToast("Tap the speaker to hear", { error: true });
        }
        return;
      }
      btn.classList.remove("loading");
      btn.classList.add("playing");
      btn.innerHTML = ICON.stop;
      btn.title = "Stop";
      currentListenBtn = btn;
      await playArrayBuffer(arrayBuffer);
    } catch (err) {
      btn.classList.remove("loading", "playing");
      btn.innerHTML = ICON.speaker;
      btn.title = "Listen — " + (err.message || "failed");
      if (!opts.autoplay) {
        ttsToast("Voice failed: " + (err.message || "unknown error"), { error: true });
      }
      console.warn("[tts] play failed:", err);
      throw err;
    }
  }

  // Stop any playing audio when the panel closes.
  document.addEventListener("delta:panel-closed", () => stopCurrentAudio());

  // ===== Voice INPUT (Whisper) — Phase 5.AI ===========================
  // Push-to-talk: hold the mic button to record, release to transcribe.
  // Also tap-to-toggle (one click starts, another stops) for users who
  // don't want to hold a button.
  let micEnabled = false;
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let activeMicBtn = null;
  let activeTargetEl = null;

  (async function probeMicStatus() {
    try {
      const r = await fetch("/api/transcribe/status");
      if (!r.ok) return;
      const data = await r.json();
      if (!data.ok || !data.enabled) return;
      // Server side ready. Now check browser support for MediaRecorder.
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        console.warn("[mic] browser missing MediaRecorder / mediaDevices");
        return;
      }
      micEnabled = true;
      // Enable both mic buttons + bind handlers.
      document.querySelectorAll(".delta-mic").forEach((btn) => {
        btn.disabled = false;
        btn.title = "Click to talk (or hold)";
        wireMicButton(btn);
      });
    } catch (err) {
      console.warn("[mic] probe failed:", err);
    }
  })();

  function wireMicButton(btn) {
    // Click = toggle. mousedown+up provides push-to-talk feel for those
    // who prefer it (hold > 400ms triggers PTT mode, short tap = toggle).
    let pttArmed = false;
    let pttTimer = null;

    const startWithBtn = () => startRecording(btn);
    const stopWithBtn  = () => stopRecording(btn);

    btn.addEventListener("mousedown", (e) => {
      if (!micEnabled) return;
      e.preventDefault();
      if (mediaRecorder && mediaRecorder.state === "recording") return;
      pttArmed = false;
      pttTimer = setTimeout(() => { pttArmed = true; startWithBtn(); }, 220);
    });
    btn.addEventListener("mouseup", (e) => {
      e.preventDefault();
      clearTimeout(pttTimer);
      if (pttArmed) {
        // Push-to-talk release.
        if (mediaRecorder && mediaRecorder.state === "recording") stopWithBtn();
      } else {
        // Short tap → toggle.
        if (mediaRecorder && mediaRecorder.state === "recording") {
          stopWithBtn();
        } else {
          startWithBtn();
        }
      }
      pttArmed = false;
    });
    btn.addEventListener("mouseleave", () => {
      // If user drags away mid-PTT, stop.
      if (pttArmed && mediaRecorder && mediaRecorder.state === "recording") {
        stopWithBtn();
        pttArmed = false;
      }
    });
    // Touch support — collapses to tap-toggle (mobile rarely does PTT
    // well anyway).
    btn.addEventListener("touchstart", (e) => {
      if (!micEnabled) return;
      e.preventDefault();
      if (mediaRecorder && mediaRecorder.state === "recording") {
        stopWithBtn();
      } else {
        startWithBtn();
      }
    }, { passive: false });
  }

  async function startRecording(btn) {
    if (!micEnabled) return;
    if (mediaRecorder && mediaRecorder.state === "recording") return;
    activeMicBtn = btn;
    activeTargetEl = document.getElementById(btn.dataset.micTarget || "");
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      ttsToast("Microphone blocked — check Safari permissions", { error: true });
      console.warn("[mic] getUserMedia failed:", err);
      return;
    }
    // Pick a mime type the browser actually supports. Safari prefers
    // mp4; Chrome/Firefox prefer webm.
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    let pickedMime = "";
    for (const m of candidates) {
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) {
        pickedMime = m;
        break;
      }
    }
    recordedChunks = [];
    try {
      mediaRecorder = pickedMime
        ? new MediaRecorder(mediaStream, { mimeType: pickedMime })
        : new MediaRecorder(mediaStream);
    } catch (err) {
      console.warn("[mic] MediaRecorder ctor failed:", err);
      mediaStream.getTracks().forEach((t) => t.stop());
      ttsToast("Couldn't start recording: " + err.message, { error: true });
      return;
    }
    mediaRecorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    });
    mediaRecorder.addEventListener("stop", () => uploadRecording(pickedMime || mediaRecorder.mimeType || "audio/webm"));
    mediaRecorder.start();
    btn.classList.add("recording");
    ttsToast("Listening… release to send", { duration: 60000 });
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;
    mediaRecorder.stop();
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (activeMicBtn) activeMicBtn.classList.remove("recording");
  }

  async function uploadRecording(mime) {
    const btn = activeMicBtn;
    const targetEl = activeTargetEl;
    const blob = new Blob(recordedChunks, { type: mime });
    recordedChunks = [];
    if (!blob.size) {
      ttsToast("No audio captured");
      return;
    }
    if (btn) btn.classList.add("transcribing");
    ttsToast("Transcribing…");
    try {
      const arrBuf = await blob.arrayBuffer();
      const r = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": mime },
        body: arrBuf,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || err.error || ("HTTP " + r.status));
      }
      const data = await r.json();
      const text = (data.text || "").trim();
      if (!text) {
        ttsToast("Nothing heard — try again", { error: true });
        return;
      }
      // Insert into the right input. Append with a space if the field
      // already has content, so the user can dictate additions to a
      // partial draft.
      if (targetEl) {
        const cur = targetEl.value.trim();
        targetEl.value = cur ? `${cur} ${text}` : text;
        targetEl.focus();
        // Trigger any input listeners (e.g. autosize).
        targetEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      ttsToast("Transcribed", { ok: true });
    } catch (err) {
      console.warn("[mic] transcribe failed:", err);
      ttsToast("Transcribe failed: " + (err.message || "unknown error"), { error: true });
    } finally {
      if (btn) btn.classList.remove("transcribing");
    }
  }

  function flashAct(btn, text) {
    const orig = btn.innerHTML;
    btn.innerHTML = `<span style="font-size:11px;font-weight:600;">${text}</span>`;
    setTimeout(() => { btn.innerHTML = orig; }, 1100);
  }

  async function regenerateLast() {
    // Find the last user message — re-run with the same context.
    let lastUserIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const userText = history[lastUserIdx].content;
    // Trim history to before the regenerated turn
    history = history.slice(0, lastUserIdx);
    // Remove the last assistant bubble + actions from the DOM
    const wraps = messagesEl.querySelectorAll(".delta-msg-wrap");
    if (wraps.length) {
      const last = wraps[wraps.length - 1];
      // Also remove the previous user bubble — sendMessage will re-append.
      const userBubble = last.previousElementSibling;
      if (last) last.remove();
      if (userBubble && userBubble.classList.contains("user")) userBubble.remove();
    }
    sendMessage(userText);
  }

  function ensureChatState() {
    if (!welcome.hidden) {
      welcome.hidden = true;
      chat.hidden = false;
      if (newChatBtn) newChatBtn.hidden = false;
      setTimeout(() => inputChat?.focus(), 60);
    }
  }
  // Expose for voice.js — when a voice session ends, the transcript
  // flush needs to switch out of welcome state if we're still there.
  window.__deltaShowChatState = ensureChatState;

  function resetToWelcome() {
    history = [];
    messagesEl.innerHTML = "";
    chat.hidden = true;
    welcome.hidden = false;
    if (newChatBtn) newChatBtn.hidden = true;
    setTimeout(() => inputWelcome?.focus(), 60);
  }

  newChatBtn?.addEventListener("click", resetToWelcome);

  // Opens an email by ID — clicked from a [email:abc123] reference in Delta's response.
  // Tracks the most recent search_inbox tool result. When the user clicks
  // an email reference that belongs to one of those results, we filter the
  // inbox list to show ALL results from that search — like Outlook does.
  let _deltaLatestSearch = null;

  function openEmailById(id) {
    if (!id) return;
    // If this id was part of the most recent Delta search, filter the inbox
    // to show all those results (banner + clear). Otherwise just open the
    // single email.
    if (_deltaLatestSearch && Array.isArray(_deltaLatestSearch.results)
        && _deltaLatestSearch.results.some((r) => r.id === id)
        && typeof window.activateDeltaSearchFilter === "function") {
      window.activateDeltaSearchFilter(_deltaLatestSearch, id);
      return;
    }
    // Defer to the inbox-side openMailById which handles both in-list
    // matches (scroll + click) and out-of-window cases (fetch stub via
    // /api/gmail/message and inject).
    if (typeof window.openMailById === "function") {
      window.openMailById(id);
    } else {
      // Hard fallback: navigate via deep-link URL.
      window.location.href = `/?msg=${encodeURIComponent(id)}`;
    }
  }

  // ---------- MODEL PICKER ----------
  const modelPickerBtn = document.getElementById("deltaModelPicker");
  const modelPopover = document.getElementById("deltaModelPopover");
  modelPickerBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    modelPopover.hidden = !modelPopover.hidden;
    if (promptsPopover) promptsPopover.hidden = true;
  });
  modelPopover?.querySelectorAll(".dmp-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      setModel(opt.dataset.model);
      modelPopover.hidden = true;
    });
  });

  // ---------- SAVED PROMPTS ----------
  const promptsBtn = document.getElementById("deltaPromptsBtn");
  const promptsPopover = document.getElementById("deltaPromptsPopover");
  const dppList = document.getElementById("dppList");
  let promptsCache = [];

  async function loadPrompts() {
    try {
      const r = await fetch("/api/prompts");
      if (!r.ok) return;
      const data = await r.json();
      promptsCache = data.prompts || [];
      renderPrompts();
    } catch (_) {}
  }

  function renderPrompts() {
    if (!promptsCache.length) {
      dppList.innerHTML = `<div class="dpp-empty">No saved prompts yet. Type something in the input then click "+ Save".</div>`;
      return;
    }
    dppList.innerHTML = promptsCache
      .map(
        (p) => `
        <div class="dpp-item" data-id="${p.id}">
          <button class="dpp-use" data-use="${p.id}" title="Use this prompt">
            <div class="dpp-title">${escapeHtml(p.title)}</div>
            <div class="dpp-body">${escapeHtml((p.body || "").slice(0, 100))}${p.body.length > 100 ? "…" : ""}</div>
          </button>
          <button class="dpp-del" data-del="${p.id}" title="Delete">×</button>
        </div>`
      )
      .join("");
    dppList.querySelectorAll("[data-use]").forEach((b) => {
      b.addEventListener("click", () => firePrompt(Number(b.dataset.use)));
    });
    dppList.querySelectorAll("[data-del]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = Number(b.dataset.del);
        await fetch(`/api/prompts/${id}`, { method: "DELETE" });
        loadPrompts();
      });
    });
  }

  async function firePrompt(id) {
    const p = promptsCache.find((x) => x.id === id);
    if (!p) return;
    promptsPopover.hidden = true;
    fetch(`/api/prompts/${id}/used`, { method: "POST" }).catch(() => {});
    sendMessage(p.body);
  }

  function openPromptsPopover() {
    if (!promptsPopover) return;
    promptsPopover.hidden = false;
    if (modelPopover) modelPopover.hidden = true;
  }

  promptsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    promptsPopover.hidden ? openPromptsPopover() : (promptsPopover.hidden = true);
  });

  // "+ Save" button
  promptsPopover?.querySelector(".dpp-add")?.addEventListener("click", async () => {
    const body = (inputChat.value || inputWelcome.value || "").trim();
    if (!body) {
      flashAct(promptsPopover.querySelector(".dpp-add"), "Type first");
      return;
    }
    const title = prompt("Title for this prompt?", body.slice(0, 60));
    if (!title) return;
    await fetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    loadPrompts();
  });

  // Close popovers on outside click
  document.addEventListener("click", (e) => {
    if (modelPopover && !modelPopover.hidden && !modelPopover.contains(e.target) && e.target !== modelPickerBtn) {
      modelPopover.hidden = true;
    }
    if (promptsPopover && !promptsPopover.hidden && !promptsPopover.contains(e.target) && e.target !== promptsBtn) {
      promptsPopover.hidden = true;
    }
  });

  // ↑ key in input → open prompts popover
  function bindUpKey(input) {
    input?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" && input.value.trim() === "") {
        e.preventDefault();
        openPromptsPopover();
      }
    });
  }
  bindUpKey(inputWelcome);
  bindUpKey(inputChat);

  // Initial load
  loadUserPrefs();
  loadPrompts();

  // -- sending -----------------------------------------------------------
  let inFlight = false;

  async function sendMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || inFlight) return;
    inFlight = true;

    ensureChatState();
    appendMessage("user", trimmed);
    history.push({ role: "user", content: trimmed });

    inputWelcome.value = "";
    inputChat.value = "";
    inputChat.style.height = "";  // reset auto-grow

    const loadingEl = appendMessage("assistant", "Delta is thinking…", { loading: true });
    [sendWelcome, sendChat].forEach((b) => b && (b.disabled = true));

    // Phase 5.AU — live-progress labels. As Delta calls tools, the
    // bubble's label flips to match. Returns to "thinking" between
    // tool calls (model is reasoning about the next step).
    const TOOL_LABELS = {
      search_inbox:          "Delta is searching your inbox",
      draft_reply:           "Delta is drafting a reply",
      compose_email:         "Delta is composing a new email",
      forward_email:         "Delta is forwarding the email",
      email_action:          "Delta is updating the email",
      propose_inbox_cleanup: "Delta is analysing your inbox",
      start_inbox_routine:   "Delta is running your inbox routine",
      create_task:           "Delta is adding to your tasks",
      remember:              "Delta is saving to memory",
      consult_finance_delta: "Delta is consulting Finance Delta",
      read_attachments:      "Delta is opening the attachments",
    };
    const setLoadingLabel = (text) => {
      const span = loadingEl.querySelector(".delta-thinking");
      if (!span) return;
      // Set safely: a text node for the label + three dot spans.
      span.textContent = text;
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.textContent = ".";
        span.appendChild(dot);
      }
    };
    const liveToolEvents = []; // accumulates so we can de-dupe at done
    const handleProgress = (ev) => {
      if (ev.type === "thinking") {
        setLoadingLabel("Delta is thinking");
      } else if (ev.type === "tool_start") {
        setLoadingLabel(TOOL_LABELS[ev.tool] || `Delta is using ${ev.tool}`);
      } else if (ev.type === "tool_end") {
        // Next "thinking" event will update the label.
      } else if (ev.type === "tool_event" && ev.event) {
        // Phase 5.AW — render this tool event's card immediately so
        // the draft / cleanup batch / task confirmation appears as
        // soon as the tool finishes, not at the very end. Also avoids
        // bundling all tool results into one big 'done' SSE payload
        // that can get truncated on long drafts.
        liveToolEvents.push(ev.event);
        console.log("[chat] tool_event arrived:", ev.event.name, "ok=", ev.event.result?.ok, "has_draft=", !!ev.event.result?.draft, "body_chars=", ev.event.result?.draft?.body?.length || 0);
        try { renderToolEvents([ev.event]); } catch (err) { console.error("[chat] tool_event render failed:", err); }
      }
    };

    try {
      const r = await fetch("/api/assistant/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({
          message: trimmed,
          history: history.slice(0, -1),   // backend already gets `message` as the latest user turn
          openMessageId: getOpenMessageId(),
          model: getSelectedModel(),
        }),
      });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);

      // Read SSE stream and dispatch progress / done / error events.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalBody = null;
      let streamErr = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // Parse "event: X\ndata: Y" pair (we always emit them as a pair).
          const evMatch = raw.match(/^event: (\w+)$/m);
          const dtMatch = raw.match(/^data: (.+)$/m);
          if (!evMatch || !dtMatch) continue;
          const event = evMatch[1];
          let data; try { data = JSON.parse(dtMatch[1]); } catch (_) { continue; }
          if (event === "progress") {
            handleProgress(data);
          } else if (event === "done") {
            finalBody = data;
          } else if (event === "error") {
            streamErr = data.error || "stream_error";
          }
        }
      }

      if (streamErr) throw new Error(streamErr);
      const body = finalBody || {};
      const reply = body.reply || "(no reply)";
      loadingEl.remove();
      // Render any tool events the live stream missed (e.g. if it
      // dropped one, or for legacy /api/assistant payloads). De-dupe
      // by index — the live stream already rendered the first N.
      if (Array.isArray(body.toolEvents) && body.toolEvents.length > liveToolEvents.length) {
        const remaining = body.toolEvents.slice(liveToolEvents.length);
        renderToolEvents(remaining);
      }
      appendMessage("assistant", reply);
      history.push({ role: "assistant", content: reply });
    } catch (err) {
      loadingEl.remove();
      appendMessage("assistant", "Couldn't reach Delta: " + (err.message || err), { error: true });
    } finally {
      inFlight = false;
      [sendWelcome, sendChat].forEach((b) => b && (b.disabled = false));
    }
  }

  // Render a small gray transparency line for each tool Delta called.
  // For draft_reply, also render an inline editable draft card.
  function renderToolEvents(events) {
    for (const ev of events) {
      // Track the most recent search_inbox result so email-ref clicks can
      // switch the inbox into 'Delta search' filter mode.
      if (ev.name === "search_inbox" && ev.result?.ok && Array.isArray(ev.result.results)) {
        _deltaLatestSearch = {
          query: ev.input?.query || ev.result?.query || "",
          results: ev.result.results,
          ts: Date.now(),
        };
      }

      // Transparency line (always)
      const div = document.createElement("div");
      div.className = "delta-tool-event";
      const desc = describeToolEvent(ev);
      div.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg><span>${desc}</span>`;
      messagesEl.appendChild(div);

      // For draft_reply with a successful result, render the draft card too.
      if (ev.name === "draft_reply" && ev.result?.ok && ev.result.draft) {
        renderChatDraftCard(ev.result.draft, ev.result.styleExamples);
      }

      // Phase 5.BM — compose_email auto-opens the NEW EMAIL composer
      // (not a reply). Skipping the chat-card route since the New Email
      // composer is itself the editable card.
      if (ev.name === "compose_email" && ev.result?.ok && ev.result.draft) {
        if (typeof window.openNewEmailComposer === "function") {
          window.openNewEmailComposer({
            to: ev.result.draft.to,
            cc: ev.result.draft.cc,
            bcc: ev.result.draft.bcc,
            subject: ev.result.draft.subject,
            body: ev.result.draft.body,
          });
        }
      }

      // Phase 5.BN — forward_email also opens the New-Email composer
      // (the forwarded content + intro note is in result.draft.body).
      if (ev.name === "forward_email" && ev.result?.ok && ev.result.draft) {
        if (typeof window.openNewEmailComposer === "function") {
          window.openNewEmailComposer({
            to: ev.result.draft.to,
            cc: ev.result.draft.cc,
            subject: ev.result.draft.subject,
            body: ev.result.draft.body,
          });
        }
      }

      // Phase 5.BN — email_action server already did the change; refresh
      // the inbox list so the row disappears / updates.
      if (ev.name === "email_action" && ev.result?.ok) {
        if (typeof window.__refreshInboxList === "function") {
          window.__refreshInboxList();
        }
      }

      // For propose_inbox_cleanup, render each batch as an interactive card.
      if (ev.name === "propose_inbox_cleanup" && ev.result?.ok && ev.result.batches) {
        for (const batch of ev.result.batches) {
          renderCleanupBatchCard(batch);
        }
      }

      // For create_task with a successful result, render the inline task card.
      if (ev.name === "create_task" && ev.result?.ok && ev.result.task) {
        renderTaskCreatedCard(ev.result.task);
      }

      // For proactive memory saves, render an undo card so the user can
      // correct Delta when it picks up something wrong or unwanted.
      // Explicit "remember X" calls skip this — the user just asked for it.
      if (ev.name === "remember" && ev.result?.ok && ev.result.proactive && ev.result.memory) {
        renderMemorySavedCard(ev.result.memory);
      }

      // For start_inbox_routine, mount a wizard that shows one step at a time.
      if (ev.name === "start_inbox_routine" && ev.result?.ok && ev.result.routine?.steps?.length) {
        renderRoutineWizard(ev.result.routine);
      }
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function describeToolEvent(ev) {
    if (ev.error || ev.result?.error) {
      const err = ev.error || ev.result.error;
      return `<em>${ev.name} failed:</em> ${escapeHtml(err)}`;
    }
    if (ev.name === "remember") {
      const subj = ev.input?.subject || "someone";
      const cat = ev.input?.category ? ` (${ev.input.category})` : "";
      const proactive = ev.result?.proactive ? " (Delta picked up on this)" : "";
      return `Saved memory about <strong>${escapeHtml(subj)}</strong>${cat}${proactive}`;
    }
    if (ev.name === "draft_reply") {
      const se = ev.result?.styleExamples;
      const recipient = se?.recipient || ev.result?.draft?.to || "recipient";
      if (se?.count >= 1) {
        return `Found <strong>${se.count}</strong> writing example${se.count === 1 ? "" : "s"} to ${escapeHtml(recipient)}`;
      }
      return `Drafting reply to ${escapeHtml(recipient)} (no past examples found — using general tone)`;
    }
    if (ev.name === "compose_email") {
      const recipient = ev.result?.draft?.to || ev.input?.to || "(no recipient yet)";
      return `Composed new email to <strong>${escapeHtml(recipient)}</strong> — opened in the composer`;
    }
    if (ev.name === "forward_email") {
      const recipient = ev.result?.draft?.to || ev.input?.to || "recipient";
      return `Forwarded to <strong>${escapeHtml(recipient)}</strong> — opened in the composer`;
    }
    if (ev.name === "email_action") {
      const a = ev.result?.action || ev.input?.action || "(unknown)";
      const labels = {
        archive: "Archived the email",
        trash: "Moved the email to trash",
        mark_read: "Marked as read",
        mark_unread: "Marked as unread",
        star: "Starred the email",
        unstar: "Removed star",
        mark_done: "Marked as done + archived",
        snooze: ev.result?.wake_at
          ? `Snoozed until ${new Date(ev.result.wake_at).toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}`
          : "Snoozed",
      };
      return labels[a] || `Did ${escapeHtml(a)}`;
    }
    if (ev.name === "search_inbox") {
      const n = ev.result?.count || 0;
      const q = ev.input?.query || "";
      return `Searched your full inbox — <strong>${n}</strong> result${n === 1 ? "" : "s"} for "${escapeHtml(q)}"`;
    }
    if (ev.name === "read_attachments") {
      const atts = ev.result?.attachments || [];
      if (!atts.length) return `No attachments to read on this message`;
      const okOnes = atts.filter((a) => a.textContent);
      const errOnes = atts.filter((a) => a.error);
      const names = okOnes.map((a) => `<strong>${escapeHtml(a.filename)}</strong>`).join(", ");
      let line = `Read ${okOnes.length} attachment${okOnes.length === 1 ? "" : "s"}`;
      if (names) line += ` — ${names}`;
      if (errOnes.length) line += ` <span style="color:var(--muted)">(${errOnes.length} couldn't be parsed)</span>`;
      return line;
    }
    if (ev.name === "propose_inbox_cleanup") {
      const b = ev.result?.batchCount || 0;
      const t = ev.result?.totalThreads || 0;
      if (b === 0) return `Your inbox already looks clean — nothing obvious to clean up`;
      return `Analyzed your inbox — <strong>${b}</strong> cleanup batch${b === 1 ? "" : "es"}, ${t} thread${t === 1 ? "" : "s"} total`;
    }
    if (ev.name === "create_task") {
      const t = ev.result?.task;
      const title = t?.title || ev.input?.title || "task";
      const list = ev.result?.listName || "Tasks";
      return `Added task to <strong>${escapeHtml(list)}</strong> — ${escapeHtml(title)}`;
    }
    if (ev.name === "start_inbox_routine") {
      const r = ev.result?.routine;
      const n = r?.totalSteps || 0;
      const t = r?.totalThreads || 0;
      if (!n) return `Your inbox is already clean — nothing for the routine to do`;
      return `Built a <strong>${n}-step</strong> routine covering ${t} thread${t === 1 ? "" : "s"}`;
    }
    // Generic fallback for future tools.
    return `Ran <strong>${escapeHtml(ev.name)}</strong>` +
      (ev.result?.summary ? ` — ${escapeHtml(ev.result.summary)}` : "");
  }

  // -------- INTERACTIVE CLEANUP BATCH CARD ---------------------------
  function renderCleanupBatchCard(batch) {
    const card = document.createElement("div");
    card.className = "cleanup-batch";
    card.dataset.batchId = batch.id;

    // Domain → favicon URL via Google's s2 service. Falls back to a colored
    // initial via onerror. This is how we get the Shortwave-style sender
    // logos that make brands recognizable at a glance.
    const senderDomain = (email) => {
      const at = (email || "").lastIndexOf("@");
      return at >= 0 ? (email || "").slice(at + 1).toLowerCase() : "";
    };
    const faviconFor = (email) => {
      const d = senderDomain(email);
      if (!d) return "";
      return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(d)}`;
    };

    const checkboxes = batch.threads.map((t) => {
      const initial = escapeHtml((t.sender || t.senderEmail || "?").charAt(0).toUpperCase());
      const fav = faviconFor(t.senderEmail || "");
      const senderName = t.sender || t.senderEmail || "(unknown)";
      return `
      <label class="cb-row">
        <input type="checkbox" data-tid="${escapeHtml(t.threadId)}" data-mid="${escapeHtml(t.messageId)}" checked>
        <div class="cb-favicon">
          ${fav ? `<img src="${fav}" alt="" onerror="this.parentNode.classList.add('no-fav');this.remove();">` : ""}
          <span class="cb-favicon-fallback">${initial}</span>
        </div>
        <div class="cb-content">
          <div class="cb-sender">${escapeHtml(senderName)}</div>
          <div class="cb-subject">${escapeHtml(t.subject)}</div>
        </div>
      </label>`;
    }).join("");

    const altButton = batch.altAction
      ? `<button class="cb-alt-btn" data-action="${escapeHtml(batch.altAction)}" data-label="${escapeHtml(batch.altActionLabel)}">${escapeHtml(batch.altActionLabel)}</button>`
      : "";

    card.innerHTML = `
      <div class="cb-head">
        <div class="cb-title">
          <img class="k-logo" src="/delta-logo.png" alt="Delta">
          <span>${escapeHtml(batch.title)}</span>
          <span class="cb-count">${batch.totalThreads} thread${batch.totalThreads === 1 ? "" : "s"}</span>
        </div>
        <button class="cb-close" title="Dismiss">×</button>
      </div>
      ${batch.description ? `<div class="cb-desc">${escapeHtml(batch.description)}</div>` : ""}
      <div class="cb-list">
        ${checkboxes}
        ${batch.truncated ? `<div class="cb-more">+ ${batch.totalThreads - batch.threads.length} more not shown</div>` : ""}
      </div>
      <div class="cb-actions">
        <button class="cb-skip">Skip</button>
        <div class="cb-action-group">
          ${altButton}
          <button class="cb-primary-btn" data-action="${escapeHtml(batch.action)}">${escapeHtml(batch.actionLabel)}</button>
        </div>
        <span class="cb-status"></span>
      </div>
    `;

    const closeBtn = card.querySelector(".cb-close");
    const skipBtn = card.querySelector(".cb-skip");
    const primaryBtn = card.querySelector(".cb-primary-btn");
    const altBtn = card.querySelector(".cb-alt-btn");
    const statusEl = card.querySelector(".cb-status");

    closeBtn?.addEventListener("click", () => card.remove());
    skipBtn?.addEventListener("click", () => {
      card.style.opacity = "0.4";
      card.querySelectorAll("input, button").forEach((b) => b.disabled = true);
      statusEl.textContent = "Skipped";
    });

    async function executeAction(action, label) {
      const selectedTids = Array.from(card.querySelectorAll("input[type=checkbox]:checked"))
        .map((cb) => cb.dataset.tid);
      if (!selectedTids.length) {
        statusEl.className = "cb-status error";
        statusEl.textContent = "Nothing selected";
        return;
      }
      card.querySelectorAll("input, button").forEach((b) => b.disabled = true);
      statusEl.className = "cb-status";
      statusEl.textContent = `${label}…`;
      try {
        const r = await fetch("/api/inbox/bulk-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadIds: selectedTids, action }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "action failed");
        statusEl.className = "cb-status ok";
        statusEl.textContent = `${data.succeeded} done · ${data.failed} failed`;
        // For unsubscribe: open the URLs returned for senders that need browser-side
        if (action === "unsubscribe" && data.unsubscribeUrls?.length) {
          for (const u of data.unsubscribeUrls.slice(0, 5)) {
            // Open in new tab (browser will block if popup blocker, but user clicked)
            window.open(u.url, "_blank", "noopener");
          }
          if (data.unsubscribeUrls.length > 5) {
            statusEl.textContent += ` · ${data.unsubscribeUrls.length} pages opened`;
          }
        }
        // Fade card after success
        setTimeout(() => {
          card.style.transition = "opacity .4s, max-height .4s";
          card.style.opacity = "0.5";
        }, 400);
      } catch (err) {
        statusEl.className = "cb-status error";
        statusEl.textContent = err.message || String(err);
        card.querySelectorAll("input, button").forEach((b) => b.disabled = false);
      }
    }

    primaryBtn?.addEventListener("click", () => executeAction(batch.action, batch.actionLabel));
    altBtn?.addEventListener("click", () => executeAction(batch.altAction, batch.altActionLabel));

    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // -------- INLINE DRAFT CARD IN CHAT ---------------------------------
  function renderChatDraftCard(draft, styleExamples) {
    // Defensive: if draft is missing or empty, render a fallback card so
    // the user at least sees something (and we get a console signal that
    // points at the data path, not the render path).
    if (!draft || typeof draft !== "object") {
      console.warn("[chat] renderChatDraftCard called with no draft:", draft);
      const placeholder = document.createElement("div");
      placeholder.className = "chat-draft";
      placeholder.innerHTML = `<div class="chat-draft-head"><div class="chat-draft-title"><img class="k-logo" src="/delta-logo.png" alt="Delta"><span>Drafted reply</span></div></div><div style="padding:14px;color:var(--muted);font-size:13px">(Draft data missing — please try again.)</div>`;
      messagesEl.appendChild(placeholder);
      return;
    }
    console.log("[chat] renderChatDraftCard:", { to: draft.to, subject: draft.subject, body_chars: (draft.body || "").length });

    const card = document.createElement("div");
    card.className = "chat-draft";
    const confCls =
      styleExamples?.confidence === "high"   ? "conf-high"   :
      styleExamples?.confidence === "medium" ? "conf-medium" : "conf-low";
    const exampleCount = styleExamples?.count || 0;
    const confLine = exampleCount >= 1
      ? `Matched your style with <strong>${exampleCount}</strong> past email${exampleCount === 1 ? "" : "s"} to ${escapeHtml(styleExamples.recipient || draft.to)}`
      : `First email to <strong>${escapeHtml(draft.to)}</strong> — using your general tone`;

    card.innerHTML = `
      <div class="chat-draft-head">
        <div class="chat-draft-title">
          <img class="k-logo" src="/delta-logo.png" alt="Delta">
          <span>Drafted reply</span>
        </div>
        <button class="chat-draft-close" title="Discard">×</button>
      </div>
      <div class="chat-draft-conf ${confCls}">
        <svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
        <span>${confLine}</span>
      </div>
      <div class="chat-draft-fields">
        <div class="cd-field"><label>To</label><input class="cd-to" type="text" value="${escapeHtml(draft.to || "")}"></div>
        <div class="cd-field"><label>Subject</label><input class="cd-subject" type="text" dir="auto" value="${escapeHtml(draft.subject || "")}"></div>
      </div>
      <textarea class="chat-draft-body" rows="6" dir="auto">${escapeHtml(draft.body || "")}</textarea>
      <div class="chat-draft-actions">
        <button class="cd-open btn primary" title="Open in the main reply composer with this draft pre-loaded">
          <svg viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;fill:currentColor;vertical-align:text-bottom;margin-right:4px"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/></svg>
          Open in main composer
        </button>
        <button class="cd-revise btn" title="Ask Delta to revise this draft">
          <svg viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;fill:currentColor;vertical-align:text-bottom;margin-right:4px"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          Revise
        </button>
        <button class="cd-save btn">Save to Gmail Drafts</button>
        <span class="cd-sig-hint">+ your Transform Iran signature</span>
        <span class="cd-status"></span>
      </div>
    `;

    // Attach FIRST so the card is always visible, even if a handler
    // attach fails below. Earlier code put appendChild at the bottom, so
    // any querySelector returning null + an addEventListener throw would
    // silently drop the entire card.
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const toEl = card.querySelector(".cd-to");
    const subjEl = card.querySelector(".cd-subject");
    const bodyEl = card.querySelector(".chat-draft-body");
    const openBtn = card.querySelector(".cd-open");
    const reviseBtn = card.querySelector(".cd-revise");
    const saveBtn = card.querySelector(".cd-save");
    const statusEl = card.querySelector(".cd-status");
    const closeBtn = card.querySelector(".chat-draft-close");

    closeBtn?.addEventListener("click", () => card.remove());

    // Phase 5.AV — "Open in main composer" promotes the draft into the
    // middle-pane reply composer, where the user has the full WYSIWYG
    // editor (with the parent's quoted history + their signature) and
    // can review then click Send. This is the canonical "send for real"
    // path now — the chat-draft card itself stays editor-only.
    openBtn?.addEventListener("click", () => {
      // Capture any edits the user made INSIDE the chat card before
      // promoting — pass them along as the body.
      const liveDraft = {
        ...draft,
        to: toEl.value,
        subject: subjEl.value,
        body: bodyEl.value,
      };
      if (typeof window.openComposerWithDraft === "function") {
        window.openComposerWithDraft(liveDraft);
        statusEl.className = "cd-status ok";
        statusEl.textContent = "Opened in main composer ↗";
      } else {
        statusEl.className = "cd-status error";
        statusEl.textContent = "Can't reach main composer — refresh and try again.";
      }
    });

    // Phase 5.AV — "Revise" prompts for revision instructions, then
    // sends a follow-up message to Delta asking for a redraft. The new
    // draft will land in a fresh chat-draft card below.
    reviseBtn?.addEventListener("click", () => {
      const instr = window.prompt("How should I revise this draft? (e.g. 'shorter', 'in Farsi', 'firmer push back on the deadline')");
      if (!instr || !instr.trim()) return;
      const chatInput = document.getElementById("deltaInputChat");
      if (!chatInput) return;
      chatInput.value = `Please revise the draft to ${draft.to}: ${instr.trim()}`;
      chatInput.focus();
      // Trigger Send.
      document.getElementById("deltaSendChat")?.click();
    });

    saveBtn?.addEventListener("click", async () => {
      saveBtn.disabled = true;
      statusEl.className = "cd-status";
      statusEl.textContent = "Saving…";
      try {
        const r = await fetch("/api/gmail/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: toEl.value,
            subject: subjEl.value,
            body: bodyEl.value,
            threadId: draft.threadId,
            inReplyTo: draft.inReplyTo,
          }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "save failed");
        statusEl.className = "cd-status ok";
        statusEl.innerHTML = `Saved! <a href="${data.gmailUrl}" target="_blank" rel="noopener">Open in Gmail Drafts ↗</a>`;
        saveBtn.textContent = "Saved";
        toEl.disabled = true; subjEl.disabled = true; bodyEl.disabled = true;
      } catch (err) {
        if (statusEl) {
          statusEl.className = "cd-status error";
          statusEl.textContent = err.message || String(err);
        }
        saveBtn.disabled = false;
      }
    });
  }

  // -------- INLINE "MEMORY SAVED" CARD (proactive only) --------------
  // Shows when Delta proactively saved an observation. Gives the user
  // one-click Undo so they can correct mistakes, plus a "See in Memory"
  // link to /settings where they can edit/manage memories.
  // -------- MORNING BRIEFING — daily AI brief card (Phase 5.AD) -------
  // Once per session, on the first chat-panel open of the day, fetch
  // today's briefing and render as a structured card at the top of the
  // chat thread. Subsequent opens of the panel are no-ops.
  let _briefingShownThisSession = false;

  async function maybeShowMorningBriefing() {
    if (_briefingShownThisSession) return;
    _briefingShownThisSession = true;
    try {
      // Show a placeholder card while we wait — feels faster than nothing.
      const placeholder = renderBriefingPlaceholder();

      const r = await fetch("/api/briefing/today");
      placeholder?.remove();
      if (!r.ok) return;
      const data = await r.json();
      if (!data.ok || !data.brief) return;
      // Don't re-show if user dismissed today's brief earlier.
      if (data.dismissed_at) return;

      renderBriefingCard(data.brief, data);
      // Mark as shown so the worker knows the user saw it.
      fetch("/api/briefing/shown", { method: "POST" }).catch(() => {});
    } catch (err) {
      console.warn("[briefing] load failed:", err);
    }
  }

  function renderBriefingPlaceholder() {
    ensureChatState();
    const card = document.createElement("div");
    card.className = "briefing-card briefing-loading";
    card.innerHTML = `
      <div class="bc-loading-text">Delta is putting together your morning brief…</div>
    `;
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return card;
  }

  function renderBriefingCard(brief, meta) {
    ensureChatState();
    const today = new Date();
    const dayName = today.toLocaleDateString(undefined, { weekday: "long" });
    const dateStr = today.toLocaleDateString(undefined, { month: "long", day: "numeric" });

    const card = document.createElement("div");
    card.className = "briefing-card";

    const repliesHtml = (brief.top_replies || []).map((r, i) => `
      <div class="bc-reply" data-msg-id="${escapeHtml(r.message_id || "")}">
        <div class="bc-reply-head">
          <span class="bc-reply-num">${i + 1}</span>
          <div class="bc-reply-meta">
            <div class="bc-reply-sender">${escapeHtml(r.sender_name || "(sender)")}</div>
            <div class="bc-reply-subject">${escapeHtml(r.subject || "(no subject)")}</div>
          </div>
        </div>
        ${r.why_priority ? `<div class="bc-reply-why">${escapeHtml(r.why_priority)}</div>` : ""}
        <textarea class="bc-reply-body" data-default="${escapeHtml(r.draft || "")}">${escapeHtml(r.draft || "")}</textarea>
        <div class="bc-reply-actions">
          <button class="bc-btn bc-open" data-action="open" data-msg-id="${escapeHtml(r.message_id || "")}">Open email</button>
          <button class="bc-btn bc-save" data-action="save" data-msg-id="${escapeHtml(r.message_id || "")}" data-subject="${escapeHtml(r.subject || "")}">Save to Drafts</button>
          <span class="bc-reply-status"></span>
        </div>
      </div>
    `).join("");

    // Listen button only mounts if TTS is enabled. Plays the spoken
    // form of the brief (headline + priorities + calendar/tasks
    // summary), not the pre-drafted reply bodies.
    const listenHtml = ttsEnabled
      ? `<button class="bc-listen" data-act="listen-brief" title="Listen to the brief">${ICON.speaker}</button>`
      : "";

    card.innerHTML = `
      <div class="bc-head">
        <div class="bc-head-text">
          <div class="bc-greeting">Good ${greetingFor(today)}</div>
          <div class="bc-date">${escapeHtml(dayName)}, ${escapeHtml(dateStr)}</div>
        </div>
        ${listenHtml}
        <button class="bc-dismiss" title="Dismiss">×</button>
      </div>
      ${brief.headline ? `<div class="bc-headline">${escapeHtml(brief.headline)}</div>` : ""}
      ${Array.isArray(brief.priorities) && brief.priorities.length ? `
        <div class="bc-section">
          <div class="bc-section-label">Today's priorities</div>
          <ul class="bc-priorities">
            ${brief.priorities.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}
          </ul>
        </div>` : ""}
      ${brief.calendar_summary ? `
        <div class="bc-section bc-inline">
          <span class="bc-inline-icon">
            <svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg>
          </span>
          <span>${escapeHtml(brief.calendar_summary)}</span>
        </div>` : ""}
      ${brief.tasks_summary ? `
        <div class="bc-section bc-inline">
          <span class="bc-inline-icon">
            <svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-2.79 7.21l-5.79 5.8-2.21-2.22-1.42 1.42L9 14.4l8.21-8.19-1.42-1.42z"/></svg>
          </span>
          <span>${escapeHtml(brief.tasks_summary)}</span>
        </div>` : ""}
      ${brief.commitments_summary ? `
        <div class="bc-section bc-inline bc-commitments">
          <span class="bc-inline-icon">
            <svg viewBox="0 0 24 24" style="fill: var(--red, #e92a2e)"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 5h2v6h-2V7zm0 8h2v2h-2v-2z"/></svg>
          </span>
          <span><strong>Promises:</strong> ${escapeHtml(brief.commitments_summary)} <a href="/promises" style="margin-left:6px;color:var(--gold-dark,#8a6b2a);font-weight:600;text-decoration:none;">see all →</a></span>
        </div>` : ""}
      ${repliesHtml ? `
        <div class="bc-section">
          <div class="bc-section-label">Pre-drafted replies <span class="bc-count">${brief.top_replies.length}</span></div>
          <div class="bc-replies">
            ${repliesHtml}
          </div>
        </div>` : ""}
    `;

    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Wire interactions
    card.querySelector(".bc-dismiss")?.addEventListener("click", async () => {
      card.style.transition = "opacity .25s, max-height .25s";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 250);
      fetch("/api/briefing/dismiss", { method: "POST" }).catch(() => {});
    });

    // Listen to the whole brief (headline + priorities + summaries).
    // Skips the pre-drafted reply bodies — those have their own
    // per-reply Listen buttons.
    const listenBtn = card.querySelector(".bc-listen");
    if (listenBtn) {
      const parts = [];
      if (brief.headline) parts.push(brief.headline);
      if (Array.isArray(brief.priorities) && brief.priorities.length) {
        parts.push("Today's priorities. " + brief.priorities.join(". "));
      }
      if (brief.calendar_summary) parts.push(brief.calendar_summary);
      if (brief.tasks_summary) parts.push(brief.tasks_summary);
      if (brief.commitments_summary) parts.push("Promises. " + brief.commitments_summary);
      const briefText = parts.join(" ");
      listenBtn.addEventListener("click", () => toggleListen(listenBtn, briefText));
    }

    // Per-reply Listen buttons — only if TTS is enabled.
    if (ttsEnabled) {
      card.querySelectorAll(".bc-reply").forEach((replyEl) => {
        const actionsRow = replyEl.querySelector(".bc-reply-actions");
        if (!actionsRow) return;
        const senderEl = replyEl.querySelector(".bc-reply-sender");
        const subjectEl = replyEl.querySelector(".bc-reply-subject");
        const whyEl = replyEl.querySelector(".bc-reply-why");
        const bodyEl = replyEl.querySelector(".bc-reply-body");
        const replyListenBtn = document.createElement("button");
        replyListenBtn.className = "bc-btn bc-reply-listen";
        replyListenBtn.title = "Listen to this draft";
        replyListenBtn.innerHTML = ICON.speaker;
        replyListenBtn.addEventListener("click", () => {
          const text = [
            senderEl?.textContent ? "Reply to " + senderEl.textContent + "." : "",
            subjectEl?.textContent ? "Subject: " + subjectEl.textContent + "." : "",
            whyEl?.textContent ? whyEl.textContent : "",
            "Draft:",
            bodyEl?.value || "",
          ].filter(Boolean).join(" ");
          toggleListen(replyListenBtn, text);
        });
        // Insert before the existing "Open email" button
        actionsRow.insertBefore(replyListenBtn, actionsRow.firstChild);
      });
    }

    card.querySelectorAll(".bc-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const action = btn.dataset.action;
        const msgId = btn.dataset.msgId;
        if (action === "open") {
          if (msgId) openEmailById(msgId);
          return;
        }
        if (action === "save") {
          const replyEl = btn.closest(".bc-reply");
          const bodyEl = replyEl?.querySelector(".bc-reply-body");
          const status = replyEl?.querySelector(".bc-reply-status");
          const draft = bodyEl?.value?.trim();
          if (!draft) {
            if (status) { status.textContent = "Draft is empty"; status.className = "bc-reply-status error"; }
            return;
          }
          btn.disabled = true;
          if (status) { status.textContent = "Saving…"; status.className = "bc-reply-status"; }
          try {
            const r = await fetch("/api/briefing/save-draft", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ messageId: msgId, draft, subject: btn.dataset.subject || "" }),
            });
            const data = await r.json();
            if (!r.ok || !data.ok) throw new Error(data.message || "save failed");
            if (status) {
              status.className = "bc-reply-status ok";
              status.innerHTML = `Saved ✓ <a href="${escapeHtml(data.gmailUrl || "#")}" target="_blank" rel="noopener">Open in Gmail Drafts ↗</a>`;
            }
            btn.textContent = "Saved";
          } catch (err) {
            if (status) { status.textContent = err.message || "save failed"; status.className = "bc-reply-status error"; }
            btn.disabled = false;
          }
        }
      });
    });
  }

  function greetingFor(d) {
    const h = d.getHours();
    if (h < 5)  return "evening";
    if (h < 12) return "morning";
    if (h < 17) return "afternoon";
    return "evening";
  }

  // -------- DECISION-RULE SUGGESTIONS (Phase 5.AF) --------------------
  // When the user opens the panel and the miner has found patterns
  // worth confirming, show one card per candidate. Each card has
  // "Yes, automate this" + "No thanks". Confirmed candidates become
  // active rules that auto-apply to future matching mail.
  let _ruleSuggestionsShownThisSession = false;

  async function maybeShowRuleSuggestions() {
    if (_ruleSuggestionsShownThisSession) return;
    _ruleSuggestionsShownThisSession = true;
    try {
      const r = await fetch("/api/decision-rules/candidates");
      if (!r.ok) return;
      const data = await r.json();
      if (!data.ok || !Array.isArray(data.candidates) || !data.candidates.length) return;
      // Show at most 2 per session — don't flood the chat.
      for (const c of data.candidates.slice(0, 2)) {
        renderRuleSuggestionCard(c);
      }
    } catch (err) {
      console.warn("[rule-suggestions] load failed:", err);
    }
  }

  function renderRuleSuggestionCard(candidate) {
    ensureChatState();
    const card = document.createElement("div");
    card.className = "rule-suggestion";
    card.dataset.candidateId = String(candidate.id);
    card.innerHTML = `
      <div class="rs-head">
        <img class="k-logo" src="/delta-logo.png" alt="Delta">
        <span class="rs-title">Pattern I noticed</span>
      </div>
      <div class="rs-prompt">${escapeHtml(candidate.prompt || "")}</div>
      <div class="rs-actions">
        <button class="rs-btn rs-confirm">Yes, automate this</button>
        <button class="rs-btn rs-reject">No thanks</button>
        <span class="rs-status"></span>
      </div>
    `;
    const statusEl = card.querySelector(".rs-status");
    const confirmBtn = card.querySelector(".rs-confirm");
    const rejectBtn = card.querySelector(".rs-reject");

    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      rejectBtn.disabled = true;
      statusEl.textContent = "Saving…";
      try {
        const r = await fetch(`/api/decision-rules/candidates/${candidate.id}/confirm`, { method: "POST" });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.message || data.error || "failed");
        statusEl.className = "rs-status ok";
        statusEl.textContent = "Rule active — Delta will handle these from now on.";
        confirmBtn.style.display = "none";
        rejectBtn.style.display = "none";
        setTimeout(() => card.classList.add("rs-fadeout"), 2000);
        setTimeout(() => card.remove(), 2400);
      } catch (err) {
        statusEl.className = "rs-status error";
        statusEl.textContent = err.message || String(err);
        confirmBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    });

    rejectBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      rejectBtn.disabled = true;
      statusEl.textContent = "OK.";
      try {
        await fetch(`/api/decision-rules/candidates/${candidate.id}/reject`, { method: "POST" });
      } catch (_) {}
      card.classList.add("rs-fadeout");
      setTimeout(() => card.remove(), 400);
    });

    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMemorySavedCard(mem) {
    const card = document.createElement("div");
    card.className = "memory-saved-card";
    card.dataset.memoryId = String(mem.id);

    const subjectLine = `${escapeHtml(mem.subject)}${mem.category ? ` <span class="ms-category">(${escapeHtml(mem.category)})</span>` : ""}`;

    card.innerHTML = `
      <div class="ms-head">
        <span class="ms-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm-3 18a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1H9z"/></svg>
        </span>
        <span class="ms-title">Delta remembered</span>
        <span class="ms-source">auto</span>
      </div>
      <div class="ms-subject">${subjectLine}</div>
      <div class="ms-fact">${escapeHtml(mem.fact)}</div>
      <div class="ms-actions">
        <button class="ms-undo" type="button">Undo — forget this</button>
        <a class="ms-edit" href="/settings#memory">Edit in Settings</a>
        <span class="ms-status"></span>
      </div>
    `;

    const undoBtn = card.querySelector(".ms-undo");
    const statusEl = card.querySelector(".ms-status");
    undoBtn?.addEventListener("click", async () => {
      undoBtn.disabled = true;
      statusEl.textContent = "Forgetting…";
      try {
        const r = await fetch(`/api/memory/${mem.id}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        statusEl.className = "ms-status ok";
        statusEl.textContent = "Forgotten ✓";
        card.classList.add("undone");
        setTimeout(() => {
          card.style.transition = "opacity .4s, max-height .4s";
          card.style.opacity = "0.5";
        }, 400);
      } catch (err) {
        statusEl.className = "ms-status error";
        statusEl.textContent = `Couldn't forget: ${err.message || err}`;
        undoBtn.disabled = false;
      }
    });

    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // -------- INLINE TASK-CREATED CARD ---------------------------------
  function renderTaskCreatedCard(task) {
    const card = document.createElement("div");
    card.className = "chat-task-card";
    card.dataset.taskId = String(task.id);

    const dueLabel = task.due_at
      ? new Date(task.due_at).toLocaleDateString(undefined, {
          weekday: "short", month: "short", day: "numeric",
        })
      : null;

    const flags = [];
    if (task.important) {
      flags.push(
        `<span class="ctc-flag important"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8L2 9.3l6.9-1z"/></svg>Important</span>`
      );
    }
    if (task.in_my_day) {
      flags.push(
        `<span class="ctc-flag myday"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>My Day</span>`
      );
    }
    if (dueLabel) {
      flags.push(
        `<span class="ctc-flag due"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg>Due ${escapeHtml(dueLabel)}</span>`
      );
    }

    const sourceBlock = task.source_message_id
      ? `<a class="ctc-source" href="/?msg=${encodeURIComponent(task.source_message_id)}" title="Jump to source email">
           <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 4l8 5 8-5"/></svg>
           <span>${escapeHtml(task.source_subject || "Open source email")}</span>
         </a>`
      : "";

    card.innerHTML = `
      <div class="ctc-head">
        <div class="ctc-title">
          <span class="ctc-check"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span class="ctc-titletext">${escapeHtml(task.title)}</span>
        </div>
        <span class="ctc-list">${escapeHtml(task.list_name || "Tasks")}</span>
      </div>
      ${flags.length ? `<div class="ctc-flags">${flags.join("")}</div>` : ""}
      ${task.notes ? `<div class="ctc-notes">${escapeHtml(task.notes)}</div>` : ""}
      ${sourceBlock}
      <div class="ctc-actions">
        <a class="ctc-open btn" href="/tasks" target="_self">Open in To Do</a>
        <span class="ctc-status"></span>
      </div>
    `;

    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // -------- GUIDED INBOX-ORGANIZE ROUTINE (wizard) ------------------
  // Shows ONE step at a time. User clicks Done → that step's action
  // executes against the selected threads → next step slides in.
  // After the last step, renders a final summary card with totals.
  function renderRoutineWizard(routine) {
    const wrap = document.createElement("div");
    wrap.className = "routine-wizard";
    wrap.dataset.totalSteps = String(routine.steps.length);
    messagesEl.appendChild(wrap);

    const state = {
      stepIndex: 0,
      totals: { archived: 0, unsubscribed: 0, marked_done: 0, tasks_created: 0, tasks_deduped: 0, skipped: 0 },
    };

    const senderDomain = (email) => {
      const at = (email || "").lastIndexOf("@");
      return at >= 0 ? (email || "").slice(at + 1).toLowerCase() : "";
    };
    const faviconFor = (email) => {
      const d = senderDomain(email);
      if (!d) return "";
      return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(d)}`;
    };

    function buildStepCard(step, idx, total) {
      const card = document.createElement("div");
      card.className = "rw-step";
      card.dataset.action = step.action;

      const rows = step.threads.map((t) => {
        const initial = escapeHtml((t.sender || t.senderEmail || "?").charAt(0).toUpperCase());
        const fav = faviconFor(t.senderEmail || "");
        const senderName = t.sender || t.senderEmail || "(unknown)";
        return `
          <label class="cb-row">
            <input type="checkbox" data-tid="${escapeHtml(t.threadId)}" data-mid="${escapeHtml(t.messageId)}" data-sender="${escapeHtml(senderName)}" data-email="${escapeHtml(t.senderEmail || "")}" data-subject="${escapeHtml(t.subject || "")}" checked>
            <div class="cb-favicon">
              ${fav ? `<img src="${fav}" alt="" onerror="this.parentNode.classList.add('no-fav');this.remove();">` : ""}
              <span class="cb-favicon-fallback">${initial}</span>
            </div>
            <div class="cb-content">
              <div class="cb-sender">${escapeHtml(senderName)}</div>
              <div class="cb-subject">${escapeHtml(t.subject || "")}</div>
            </div>
          </label>`;
      }).join("");

      const altBtn = step.altAction
        ? `<button class="cb-alt-btn" data-action="${escapeHtml(step.altAction)}">${escapeHtml(step.altActionLabel)}</button>`
        : "";

      card.innerHTML = `
        <div class="rw-head">
          <div class="rw-step-meta">
            <span class="rw-step-num">Step ${idx + 1} of ${total}</span>
            <div class="rw-progress"><div class="rw-progress-fill" style="width:${Math.round(((idx) / total) * 100)}%"></div></div>
          </div>
          <button class="rw-close" title="Close routine">×</button>
        </div>
        <div class="rw-title">${escapeHtml(step.title)}</div>
        ${step.description ? `<div class="rw-desc">${escapeHtml(step.description)}</div>` : ""}
        <div class="rw-count">${step.totalThreads} thread${step.totalThreads === 1 ? "" : "s"} selected by default — uncheck anything you want to keep</div>
        <div class="cb-list rw-list">
          ${rows}
          ${step.truncated ? `<div class="cb-more">+ ${step.totalThreads - step.threads.length} more not shown</div>` : ""}
        </div>
        <div class="rw-actions">
          <button class="rw-skip">Skip this step</button>
          <div class="rw-action-group">
            ${altBtn}
            <button class="rw-primary" data-action="${escapeHtml(step.action)}">${escapeHtml(step.actionLabel)}</button>
          </div>
          <span class="rw-status"></span>
        </div>
      `;
      return card;
    }

    async function executeStep(step, card, action) {
      const selected = Array.from(card.querySelectorAll("input[type=checkbox]:checked"));
      if (!selected.length) {
        const s = card.querySelector(".rw-status");
        s.className = "rw-status error";
        s.textContent = "Nothing selected — uncheck to skip, or check at least one.";
        return false;
      }
      card.querySelectorAll("input, button").forEach((b) => b.disabled = true);
      const statusEl = card.querySelector(".rw-status");
      statusEl.className = "rw-status";
      statusEl.textContent = "Working…";

      try {
        if (action === "add_to_todo") {
          const items = selected.map((cb) => ({
            threadId: cb.dataset.tid,
            messageId: cb.dataset.mid,
            senderName: cb.dataset.sender,
            senderEmail: cb.dataset.email,
            subject: cb.dataset.subject,
          }));
          const r = await fetch("/api/inbox/add-to-todo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items,
              listName: step.listName || "Reply to",
              important: !!step.important,
              inMyDay: !!step.important,
            }),
          });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.message || data.error || "add_to_todo failed");
          state.totals.tasks_created += data.created || 0;
          state.totals.tasks_deduped += data.deduped || 0;
          statusEl.className = "rw-status ok";
          const dedupNote = data.deduped > 0
            ? ` (${data.deduped} already in your list)`
            : "";
          statusEl.textContent = `Added ${data.created} task${data.created === 1 ? "" : "s"} to ${data.listName}${dedupNote}`;
        } else {
          const threadIds = selected.map((cb) => cb.dataset.tid);
          const r = await fetch("/api/inbox/bulk-action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadIds, action }),
          });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.message || data.error || "action failed");
          if (action === "unsubscribe") {
            state.totals.unsubscribed += data.succeeded || 0;
            if (data.unsubscribeUrls?.length) {
              for (const u of data.unsubscribeUrls.slice(0, 5)) {
                window.open(u.url, "_blank", "noopener");
              }
            }
          } else if (action === "mark_done") {
            state.totals.marked_done += data.succeeded || 0;
          } else {
            state.totals.archived += data.succeeded || 0;
          }
          statusEl.className = "rw-status ok";
          statusEl.textContent = `Done — ${data.succeeded} processed`;
        }
        return true;
      } catch (err) {
        statusEl.className = "rw-status error";
        statusEl.textContent = err.message || String(err);
        card.querySelectorAll("input, button").forEach((b) => b.disabled = false);
        return false;
      }
    }

    function advance() {
      state.stepIndex++;
      mountStep();
    }

    function mountStep() {
      wrap.innerHTML = "";
      if (state.stepIndex >= routine.steps.length) {
        wrap.appendChild(buildSummaryCard());
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return;
      }
      const step = routine.steps[state.stepIndex];
      const card = buildStepCard(step, state.stepIndex, routine.steps.length);
      wrap.appendChild(card);

      card.querySelector(".rw-close")?.addEventListener("click", () => {
        if (!confirm("Stop the routine here? You can run it again any time.")) return;
        wrap.appendChild(buildSummaryCard(true));
        card.remove();
      });

      card.querySelector(".rw-skip")?.addEventListener("click", () => {
        state.totals.skipped++;
        advance();
      });

      card.querySelector(".rw-primary")?.addEventListener("click", async () => {
        const ok = await executeStep(step, card, step.action);
        if (ok) setTimeout(advance, 600);
      });
      card.querySelector(".cb-alt-btn")?.addEventListener("click", async () => {
        const ok = await executeStep(step, card, step.altAction);
        if (ok) setTimeout(advance, 600);
      });

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function buildSummaryCard(stoppedEarly) {
      const card = document.createElement("div");
      card.className = "rw-summary";
      const t = state.totals;
      const lines = [];
      if (t.unsubscribed) lines.push(`<li>Unsubscribed from <strong>${t.unsubscribed}</strong> sender${t.unsubscribed === 1 ? "" : "s"}</li>`);
      if (t.marked_done) lines.push(`<li>Marked <strong>${t.marked_done}</strong> thread${t.marked_done === 1 ? "" : "s"} done</li>`);
      if (t.archived) lines.push(`<li>Archived <strong>${t.archived}</strong> thread${t.archived === 1 ? "" : "s"}</li>`);
      if (t.tasks_created) lines.push(`<li>Added <strong>${t.tasks_created}</strong> task${t.tasks_created === 1 ? "" : "s"} to your To Do</li>`);
      if (t.tasks_deduped) lines.push(`<li><strong>${t.tasks_deduped}</strong> already in your list — skipped</li>`);
      if (t.skipped) lines.push(`<li>Skipped <strong>${t.skipped}</strong> step${t.skipped === 1 ? "" : "s"}</li>`);
      const body = lines.length
        ? `<ul class="rw-summary-list">${lines.join("")}</ul>`
        : `<div class="rw-summary-empty">Nothing was changed.</div>`;
      card.innerHTML = `
        <div class="rw-summary-head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
          <span>${stoppedEarly ? "Routine stopped" : "Inbox organized"}</span>
        </div>
        ${body}
        <div class="rw-summary-actions">
          ${t.tasks_created ? `<a class="rw-summary-btn primary" href="/tasks">Open To Do</a>` : ""}
        </div>
      `;
      return card;
    }

    mountStep();
  }

  // -- input wiring ------------------------------------------------------
  function wireInput(input, sendBtn) {
    if (!input || !sendBtn) return;
    sendBtn.addEventListener("click", () => sendMessage(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value);
      }
    });
    // Auto-grow up to 160px
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(160, input.scrollHeight) + "px";
    });
  }
  wireInput(inputWelcome, sendWelcome);
  wireInput(inputChat, sendChat);

  // -- suggestion chips --------------------------------------------------
  suggestionsEl?.querySelectorAll(".delta-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.dataset.prompt || chip.textContent.trim();
      sendMessage(prompt);
    });
  });
})();
