// ============================================================================
// public/voice.js  —  Phase 5.BF  Voice Mode (OpenAI Realtime WebRTC)
//
// Wires the "voice mode" button in the Delta panel header to a live
// WebRTC session with OpenAI's Realtime API. Renders the animated orb
// overlay, captures the running transcript, flushes it back into the
// chat panel when the session ends, and prevents the classic self-loop
// bug by tuning server VAD + listening for explicit end-commands in
// 5 languages.
//
// Pre-reqs (already wired by the time this loads):
//   • #deltaVoiceMode    — button in panel header
//   • #deltaVoiceOverlay — overlay div, hidden by default
//   • #deltaMessages     — chat thread (transcript flushes here)
//   • window.renderMarkdown (optional — for tool-trail badges)
// ============================================================================

(() => {
  // Single global state object — easier to inspect from devtools than
  // closure-scoped vars. Keep all mutable per-session data here.
  const voiceMode = {
    active: false,
    pc: null,             // RTCPeerConnection
    dc: null,             // RTCDataChannel
    micStream: null,
    remoteAudio: null,
    ephemeralKey: null,
    model: null,

    transcript: [],           // committed turns
    _partialTranscript: "",   // streaming assistant text
    _currentAssistantToolsUsed: [],

    _pendingClose: false,
    _closeTimer: null,

    // Pending tool calls (function_call events) keyed by call_id so we
    // can match function_call_output back to the same call.
    _pendingTools: new Map(),
  };

  // Expose for devtools debugging.
  window.__deltaVoice = voiceMode;

  // ---------------------- DOM refs (lazy) ----------------------------
  const $ = (id) => document.getElementById(id);

  function ensureBootstrap() {
    const btn = $("deltaVoiceMode");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (voiceMode.active) return;
      await startVoiceSession();
    });
    $("dvoCloseBtn")?.addEventListener("click", exitVoiceMode);
    $("dvoEndBtn")?.addEventListener("click", exitVoiceMode);

    // Probe availability and unhide the button if the server has an
    // OpenAI key configured. Otherwise leave it hidden so users don't
    // see a button that throws.
    probeAvailability().catch(() => {});
  }

  async function probeAvailability() {
    try {
      const r = await fetch("/api/voice/realtime-status");
      if (!r.ok) return;
      const data = await r.json();
      if (data.ok && data.available) {
        $("deltaVoiceMode")?.removeAttribute("hidden");
      }
    } catch (_) {}
  }

  // ---------------------- SESSION LIFECYCLE --------------------------

  async function startVoiceSession() {
    if (voiceMode.active) return;
    showOverlay();
    setStatus("Connecting…", "thinking");
    resetTranscript();

    try {
      // 1. Mint ephemeral key.
      const sessResp = await fetch("/api/voice/realtime-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const sessData = await sessResp.json();
      if (!sessResp.ok || !sessData.ok) {
        throw new Error(sessData.error || `HTTP ${sessResp.status}`);
      }
      voiceMode.ephemeralKey = sessData.value;
      voiceMode.model = sessData.model;

      // 2. Set up WebRTC: data channel + mic + remote audio sink.
      const pc = new RTCPeerConnection();
      voiceMode.pc = pc;

      const dc = pc.createDataChannel("oai-events");
      voiceMode.dc = dc;
      dc.onmessage = (e) => {
        try { handleRealtimeEvent(JSON.parse(e.data)); }
        catch (err) { console.warn("[voice] bad event:", err, e.data); }
      };
      dc.addEventListener("open", onDataChannelOpen);

      // Mic — browser audio constraints help even though server VAD does
      // the heavy lifting.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      voiceMode.micStream = stream;
      stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));

      // Remote audio — Delta's voice.
      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      voiceMode.remoteAudio = remoteAudio;
      pc.ontrack = (e) => { remoteAudio.srcObject = e.streams[0]; };

      // 3. SDP exchange with OpenAI.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(voiceMode.model)}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${voiceMode.ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!sdpResp.ok) {
        const text = await sdpResp.text().catch(() => "");
        throw new Error(`OpenAI SDP exchange failed (${sdpResp.status}): ${text.slice(0, 200)}`);
      }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      voiceMode.active = true;
      setStatus("Listening", "listening");
    } catch (err) {
      console.error("[voice] start failed:", err);
      setStatus("Couldn't start voice session", "thinking");
      $("dvoPartial").textContent = err.message || String(err);
      setTimeout(exitVoiceMode, 3500);
    }
  }

  function onDataChannelOpen() {
    // Per the handoff doc bug #6: even with session-level English-locked
    // instructions, the FIRST response.create needs its own response-level
    // override or the model picks the user's heritage language for the
    // opening greeting. This is the only place we have to be explicit.
    const firstName = (window.__deltaUser?.firstName) ||
                      (window.__deltaUser?.email || "").split("@")[0] ||
                      "there";
    const greeting = `IMPORTANT: Greet ${firstName} IN ENGLISH ONLY. Say something like "Hi ${firstName}, what can I help with?" — under 10 words. DO NOT use Farsi, Persian, Dutch, Armenian, Turkish, or any other language for this opening greeting. English only.`;
    try {
      voiceMode.dc.send(JSON.stringify({
        type: "response.create",
        response: { instructions: greeting },
      }));
    } catch (err) {
      console.warn("[voice] failed to send opening greeting:", err);
    }
  }

  function exitVoiceMode() {
    // Order matters: flush transcript BEFORE clearing buffers.
    flushVoiceTranscriptToChat();

    if (voiceMode._closeTimer) {
      clearTimeout(voiceMode._closeTimer);
      voiceMode._closeTimer = null;
    }
    try { voiceMode.dc?.close(); } catch (_) {}
    try { voiceMode.pc?.close(); } catch (_) {}
    try { voiceMode.micStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try {
      if (voiceMode.remoteAudio) {
        voiceMode.remoteAudio.srcObject = null;
        voiceMode.remoteAudio.pause();
      }
    } catch (_) {}

    voiceMode.pc = null;
    voiceMode.dc = null;
    voiceMode.micStream = null;
    voiceMode.remoteAudio = null;
    voiceMode.active = false;
    voiceMode.transcript = [];
    voiceMode._partialTranscript = "";
    voiceMode._pendingClose = false;
    voiceMode._pendingTools.clear();

    hideOverlay();
  }

  function resetTranscript() {
    voiceMode.transcript = [];
    voiceMode._partialTranscript = "";
    voiceMode._currentAssistantToolsUsed = [];
    voiceMode._pendingClose = false;
    voiceMode._pendingTools.clear();
    const partial = $("dvoPartial");
    if (partial) partial.textContent = "";
  }

  // ---------------------- REALTIME EVENT HANDLER ---------------------

  function handleRealtimeEvent(evt) {
    // Debug logging for transcript + error events. Toggle window
    // .__DELTA_VOICE_DEBUG=true to see everything.
    if (window.__DELTA_VOICE_DEBUG ||
        evt.type === "error" ||
        evt.type.startsWith("conversation.item.input_audio_transcription") ||
        evt.type.startsWith("response.audio_transcript") ||
        evt.type.startsWith("response.output_audio_transcript") ||
        evt.type === "response.done" ||
        evt.type === "session.created" ||
        evt.type === "session.updated") {
      console.log("[realtime evt]", evt.type, evt.transcript ? `"${String(evt.transcript).slice(0,100)}"` : "");
    }

    switch (evt.type) {
      // Session ack — could update status here, but the SDP swap already did.
      case "session.created":
      case "session.updated":
        break;

      case "input_audio_buffer.speech_started":
        setStatus("Listening", "listening");
        break;
      case "input_audio_buffer.speech_stopped":
        setStatus("Thinking", "thinking");
        break;

      // User said something — committed text.
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(evt.transcript || "").trim();
        if (text) {
          voiceMode.transcript.push({ role: "user", text, ts: Date.now() });
        }
        if (text && detectVoiceEndCommand(text) && !voiceMode._pendingClose) {
          voiceMode._pendingClose = true;
          // Safety: if the assistant never finishes the goodbye reply, close anyway.
          voiceMode._closeTimer = setTimeout(exitVoiceMode, 4000);
        }
        break;
      }

      // Assistant text — streaming partial (legacy + GA variants).
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        voiceMode._partialTranscript += String(evt.delta || "");
        renderPartial(voiceMode._partialTranscript);
        setStatus("Speaking", "speaking");
        break;
      }

      // Assistant text — committed (legacy + GA variants).
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const text = String(evt.transcript || voiceMode._partialTranscript || "").trim();
        if (text) {
          voiceMode.transcript.push({
            role: "assistant",
            text,
            ts: Date.now(),
            toolsUsed: voiceMode._currentAssistantToolsUsed.slice(),
          });
        }
        voiceMode._partialTranscript = "";
        voiceMode._currentAssistantToolsUsed = [];
        renderPartial("");
        setStatus("Listening", "listening");
        break;
      }

      // Tool call — the model wants us to run a function.
      case "response.function_call_arguments.done": {
        const { call_id: callId, name, arguments: args } = evt;
        if (!callId || !name) break;
        voiceMode._pendingTools.set(callId, { name, args });
        voiceMode._currentAssistantToolsUsed.push(name);
        runToolCall(callId, name, args).catch((err) => {
          console.warn("[voice] tool", name, "failed:", err);
        });
        break;
      }

      // Whole response done — emit fallback transcripts if individual
      // *_transcript.done events didn't fire.
      case "response.done": {
        const items = evt.response?.output || [];
        for (const item of items) {
          if (item.role !== "assistant") continue;
          const text = (item.content || [])
            .map((p) => p.transcript || p.text || "")
            .join(" ").trim();
          if (!text) continue;
          const dup = voiceMode.transcript.some((t) => t.role === "assistant" && t.text === text);
          if (!dup) {
            voiceMode.transcript.push({
              role: "assistant",
              text,
              ts: Date.now(),
              toolsUsed: voiceMode._currentAssistantToolsUsed.slice(),
            });
          }
        }
        voiceMode._currentAssistantToolsUsed = [];
        voiceMode._partialTranscript = "";
        renderPartial("");
        if (voiceMode._pendingClose) {
          if (voiceMode._closeTimer) clearTimeout(voiceMode._closeTimer);
          setTimeout(exitVoiceMode, 800);
        }
        break;
      }

      case "error":
        console.error("[voice] OpenAI error event:", evt.error || evt);
        break;
    }
  }

  // ---------------------- TOOL CALL PROXY ----------------------------

  async function runToolCall(callId, name, argumentsRaw) {
    // Forward to the server, which has the user's Gmail creds + DB
    // access. Return the result to OpenAI as function_call_output.
    try {
      const resp = await fetch("/api/voice/tool-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          arguments: argumentsRaw,
          callId,
          openMessageId: window.__deltaOpenMessageId || null,
        }),
      });
      const data = await resp.json();
      const output = data.ok ? data.result : { ok: false, error: data.error || "tool_failed" };
      const dc = voiceMode.dc;
      if (!dc || dc.readyState !== "open") return;
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      }));
      // Ask the model to continue with the tool result available.
      dc.send(JSON.stringify({ type: "response.create" }));
    } catch (err) {
      console.warn("[voice] tool", name, "transport error:", err);
    } finally {
      voiceMode._pendingTools.delete(callId);
    }
  }

  // ---------------------- TRANSCRIPT FLUSH ---------------------------

  function flushVoiceTranscriptToChat() {
    const body = document.getElementById("deltaMessages");
    if (!body) return;

    // Switch from welcome → chat state if we're not there yet.
    try {
      if (typeof window.__deltaShowChatState === "function") {
        window.__deltaShowChatState();
      }
    } catch (_) {}

    const turns = voiceMode.transcript.filter((t) => t.text?.trim());

    // Salvage in-flight partial if user ended mid-reply.
    if (voiceMode._partialTranscript?.trim()) {
      turns.push({
        role: "assistant",
        text: voiceMode._partialTranscript.trim() + " …",
        ts: Date.now(),
      });
    }

    // Divider + Copy button always render so the user knows something happened.
    const start = turns[0]?.ts ? new Date(turns[0].ts) : new Date();
    const end = turns[turns.length - 1]?.ts ? new Date(turns[turns.length - 1].ts) : new Date();
    const fmtTime = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const divider = document.createElement("div");
    divider.className = "voice-divider";
    divider.innerHTML = `🎙 Voice session · ${fmtTime(start)}–${fmtTime(end)} · ${turns.length} turn${turns.length === 1 ? "" : "s"}`;
    body.appendChild(divider);

    const copyRow = document.createElement("div");
    copyRow.className = "voice-copy-row";
    const copyBtn = document.createElement("button");
    copyBtn.className = "voice-copy-btn";
    copyBtn.innerHTML = `📋 Copy transcript`;
    copyBtn.addEventListener("click", () => copyTranscript(turns, copyBtn));
    copyRow.appendChild(copyBtn);
    body.appendChild(copyRow);

    if (!turns.length) {
      const note = document.createElement("div");
      note.className = "delta-msg-wrap delta-msg-meta";
      note.style.cssText = "padding: 8px 14px; color: var(--muted); font-size: 12.5px; font-style: italic;";
      note.textContent = "No turns captured — the session ended before any audio was transcribed.";
      body.appendChild(note);
    } else {
      for (const t of turns) {
        if (t.role === "user") {
          appendVoiceUserBubble(body, t.text);
        } else {
          appendVoiceAssistantBubble(body, t.text, t.toolsUsed || []);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  }

  function appendVoiceUserBubble(parent, text) {
    const wrap = document.createElement("div");
    wrap.className = "delta-msg-wrap delta-msg-user";
    wrap.innerHTML = `<div class="delta-msg user"><div class="delta-msg-content"></div></div>`;
    wrap.querySelector(".delta-msg-content").textContent = text;
    parent.appendChild(wrap);
  }

  function appendVoiceAssistantBubble(parent, text, toolsUsed) {
    const wrap = document.createElement("div");
    wrap.className = "delta-msg-wrap delta-msg-assistant";
    const html = (typeof window.renderMarkdown === "function")
      ? window.renderMarkdown(text)
      : `<p>${escapeHtml(text)}</p>`;
    const toolBadge = (Array.isArray(toolsUsed) && toolsUsed.length)
      ? `<div class="delta-tool-trail">🔍 ${toolsUsed.length} source${toolsUsed.length === 1 ? "" : "s"}: ${toolsUsed.map(escapeHtml).join(", ")}</div>`
      : "";
    wrap.innerHTML = `
      <div class="delta-msg assistant md-content">
        ${html}
        ${toolBadge}
      </div>
    `;
    parent.appendChild(wrap);
  }

  function copyTranscript(turns, btn) {
    const lines = [
      `🎙 Voice session — ${new Date().toLocaleString()}`,
      `${turns.length} turns`,
      "",
    ];
    for (const t of turns) {
      const ts = t.ts ? new Date(t.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const role = t.role === "user" ? "You" : "Delta";
      lines.push(`[${ts}] ${role}: ${t.text}`);
    }
    const text = lines.join("\n");
    navigator.clipboard?.writeText(text).then(() => {
      btn.classList.add("copied");
      const orig = btn.innerHTML;
      btn.innerHTML = "✓ Copied";
      setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = orig; }, 1800);
    }).catch(() => {
      btn.textContent = "Copy failed";
    });
  }

  // ---------------------- MULTILINGUAL END DETECTOR ------------------

  function detectVoiceEndCommand(transcript) {
    const raw = String(transcript || "").trim();
    if (!raw) return false;
    const norm = raw.toLowerCase().replace(/[.,!?؟،।'`]/g, " ").replace(/\s+/g, " ").trim();
    // English — terminal phrases. Avoid matching "stop talking about X".
    if (/\b(end (of )?(this |the |our )?(conversation|session|chat|call)|stop (the |this )?(session|conversation)|we ?'?re? done|that ?'?s all|good ?bye|bye bye|bye delta|thanks?,? ?bye|end (it|now)|close (the )?(session|chat)|exit (voice mode|session)|i ?'?m done)\b/.test(norm)) return true;
    // Farsi
    if (/(خداحافظ|بدرود|خدافظ|تمام شد|تموم شد|پایان مکالمه|کافیه|تمومش کن)/.test(raw)) return true;
    // Dutch
    if (/\b(tot ziens|doei|doeg|dag delta|einde gesprek|stop gesprek|klaar|afsluiten)\b/.test(norm)) return true;
    // Armenian
    if (/(ցտեսություն|մնաք բարով|վերջացրեք|խոսակցության վերջ|բավական է)/.test(raw)) return true;
    // Turkish
    if (/\b(hoşça kal|görüşürüz|bitti|işimiz bitti|bitirelim|kapat oturum)\b/.test(norm)) return true;
    return false;
  }

  // ---------------------- UI helpers ---------------------------------

  function showOverlay() {
    const o = $("deltaVoiceOverlay");
    if (o) o.removeAttribute("hidden");
  }
  function hideOverlay() {
    const o = $("deltaVoiceOverlay");
    if (o) {
      o.setAttribute("hidden", "");
      o.classList.remove("state-listening", "state-speaking", "state-thinking");
    }
    const partial = $("dvoPartial");
    if (partial) partial.textContent = "";
  }
  function setStatus(text, state) {
    const o = $("deltaVoiceOverlay");
    const t = $("dvoStatusText");
    if (t) t.textContent = text;
    if (o) {
      o.classList.remove("state-listening", "state-speaking", "state-thinking");
      if (state) o.classList.add("state-" + state);
    }
  }
  function renderPartial(text) {
    const p = $("dvoPartial");
    if (p) p.textContent = text;
  }
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------------------- INIT ---------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureBootstrap);
  } else {
    ensureBootstrap();
  }
})();
