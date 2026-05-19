// Delta FAB + panel controller + chat client.
// Wires:
//   - FAB toggle (welcome panel slides in from the right)
//   - Welcome textarea/Send + suggestion chips → POST /api/assistant
//   - Transition welcome → chat state on first message
//   - Conversation rendering (user + assistant bubbles)
//   - Esc / click outside to close
//
// Stateless backend: every turn sends {message, history, openMessageId?}.

(() => {
  const fab = document.getElementById("deltaFab");
  const panel = document.getElementById("deltaPanel");
  const closeBtn = panel?.querySelector(".delta-close");
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
  const history = [];

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
    const div = document.createElement("div");
    div.className = "delta-msg " + role + (opts.loading ? " loading" : "") + (opts.error ? " error" : "");
    if (role === "assistant" && !opts.error) {
      div.innerHTML =
        `<img class="delta-msg-avatar" src="/delta-logo.png" alt="Delta">` +
        escapeHtml(text);
    } else {
      div.textContent = text;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function ensureChatState() {
    if (!welcome.hidden) {
      welcome.hidden = true;
      chat.hidden = false;
      setTimeout(() => inputChat?.focus(), 60);
    }
  }

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

    try {
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history: history.slice(0, -1),   // backend already gets `message` as the latest user turn
          openMessageId: getOpenMessageId(),
        }),
      });

      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || body.error || ("HTTP " + r.status));

      const reply = body.reply || "(no reply)";
      loadingEl.remove();
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
