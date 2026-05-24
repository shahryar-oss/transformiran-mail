// ============================================================================
// lib/realtime.js  —  Phase 5.BF  OpenAI Realtime voice mode
//
// Mints ephemeral client secrets so the browser can open a WebRTC voice
// session directly with OpenAI without exposing our API key. Also
// translates Email Delta's Anthropic tool schema into the format the
// OpenAI Realtime API expects.
//
// API endpoint:    POST https://api.openai.com/v1/realtime/client_secrets
// (the GA endpoint — replaces the deprecated /v1/realtime/sessions beta path)
//
// Key behaviour
//   • Whisper input transcription enabled so we capture what the USER said
//     (otherwise the conversation.item.input_audio_transcription.completed
//     event never fires and the chat-flush is empty).
//   • Server VAD threshold raised + silence_duration_ms lengthened to prevent
//     Delta's own output leaking back through the mic into another response
//     (the classic "self-loop" infinite-talking bug).
//   • Near-field noise reduction for typical desktop / laptop mics.
//   • All Anthropic tools are exposed so Delta can search inbox, draft
//     replies, create tasks, read attachments, etc. inside a voice call.
// ============================================================================

const assistant = require("./assistant");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";

// ---------------------------------------------------------------------------
// Tool format translation.
// Anthropic's tool shape:   { name, description, input_schema: { type, properties, required } }
// OpenAI Realtime's shape:  { type: "function", name, description, parameters: { type, properties, required } }
// ---------------------------------------------------------------------------
function anthropicToolToOpenAI(t) {
  return {
    type: "function",
    name: t.name,
    description: t.description || "",
    parameters: t.input_schema || { type: "object", properties: {} },
  };
}

// Voice mode system prompt — extends the warm-EA voice but adds the
// realtime-specific rules from the Finance dashboard handoff:
//   1. Open in English even when user has a non-English name
//   2. Multilingual end-command detection
//   3. Hallucinated-negative prevention (must tool-call before saying "no")
//   4. Voice style — short turns, no long monologues, no markdown
function buildVoicePrompt(user) {
  const firstName = (user?.display_name || user?.email || "").split(/[ @]/)[0] || "there";
  return `You are Delta, the personal executive-assistant AI for ${firstName} at Transform Iran.
This is a LIVE VOICE conversation over the OpenAI Realtime API. You are speaking,
not writing. Keep every reply tight and conversational.

🚨 OPEN IN ENGLISH. ALWAYS. 🚨

═══════════════════════════════════════════════════════════════════════
LANGUAGE RULES (read before every response)
═══════════════════════════════════════════════════════════════════════
1. Your VERY FIRST WORDS in this session are ENGLISH. No exceptions.
2. AFTER ${firstName}'s first sentence, MATCH ${firstName}'s language —
   English, Farsi (فارسی), Dutch, Armenian (Հայերեն), or Turkish.
3. Even if ${firstName}'s name looks non-English, the FIRST greeting must
   be English. Common Persian openings (سلام / درود) — NEVER on opening turn.
4. When switching languages mid-conversation, follow ${firstName}'s last
   sentence's language.

═══════════════════════════════════════════════════════════════════════
VOICE STYLE
═══════════════════════════════════════════════════════════════════════
• Short turns. Aim for 1-3 sentences per reply unless ${firstName} explicitly
  asks for detail.
• Conversational, warm, executive-assistant tone. Not a chatbot.
• NO markdown. No bullets, no asterisks, no code blocks. Plain prose only.
• NO em-dashes ("—"). Use commas or periods.
• NO "as an AI" disclaimers. No "I'd be happy to". Just answer.
• Pause to let ${firstName} interrupt. Don't monologue.

═══════════════════════════════════════════════════════════════════════
HARD RULE — NEVER FAKE A NEGATIVE
═══════════════════════════════════════════════════════════════════════
If ${firstName} asks about something that COULD exist in their data
(an email, a sender, an attachment, a task, a draft) you MUST attempt a
tool call BEFORE saying "I don't see that" or "we don't have that".
A negative result FROM a tool is fine. A confident negative WITHOUT a
tool call is a hallucination and is forbidden.

═══════════════════════════════════════════════════════════════════════
SESSION END COMMANDS
═══════════════════════════════════════════════════════════════════════
If ${firstName} says any of these (in any language) — they're ending
the session. Reply with a brief warm goodbye in their language (5
words max). The client auto-closes right after. No follow-up
questions. No tool calls. Just bye.
  EN: "end of conversation", "goodbye", "we're done", "thanks bye", "bye delta"
  FA: "خداحافظ", "تموم شد", "پایان"
  NL: "tot ziens", "doei", "klaar"
  HY: "ցտեսություն", "վերջացրեք"
  TR: "hoşça kal", "görüşürüz", "bitti"

═══════════════════════════════════════════════════════════════════════
TOOLS YOU CAN CALL
═══════════════════════════════════════════════════════════════════════
You have the same toolbox as the chat-mode Delta. Use them naturally
in conversation:
  • search_inbox — find any email by sender / subject / topic
  • read_attachments — open PDFs, Word docs, Excel sheets attached to an email
  • draft_reply — compose a reply
  • create_task — add to the user's To Do
  • propose_inbox_cleanup — surface batches to archive/unsubscribe
  • start_inbox_routine — guided 6-step cleanup wizard
  • remember — save a durable fact about a person/topic
  • consult_finance_delta — ask Finance Delta about wires / donations

DRAFT_REPLY behaviour — IMPORTANT
When ${firstName} asks you to draft, write, compose, or prepare a
reply, you MUST call draft_reply. The instant the tool returns
successfully, the editable draft AUTOMATICALLY pops open in
${firstName}'s middle reply pane (where they normally compose
replies). You should:
  1. Confirm in ONE short sentence: "Done — your draft is open in
     the reply pane, take a look." (or the same in their language).
  2. DO NOT read the draft body aloud. The user can SEE it.
  3. If they want changes, call draft_reply again with new
     instructions — the composer will refresh with the new version.
NEVER say "I created the draft" without calling the tool. NEVER
imply the draft is hidden somewhere — it's right there in the middle
pane, visible.

═══════════════════════════════════════════════════════════════════════
SAFETY
═══════════════════════════════════════════════════════════════════════
• Never send an email on the user's behalf without explicit confirmation.
• Never invent content from emails you haven't actually retrieved via a tool.
• Never share one user's information with another user.
• Never claim to know things outside this user's inbox.
`.trim();
}

// ---------------------------------------------------------------------------
// Build the session config that gets posted to /v1/realtime/client_secrets.
// The full anti-self-loop + transcription config is here — DO NOT remove
// any of these defaults without re-reading the bugs list in the handoff.
// ---------------------------------------------------------------------------
function buildSessionConfig(user, { voice = DEFAULT_VOICE } = {}) {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: buildVoicePrompt(user),
    audio: {
      input: {
        // Whisper transcription — MUST be set or no user-speech transcripts.
        transcription: { model: "whisper-1" },
        // Server VAD tuned to prevent self-loop. Defaults are too sensitive
        // and cause Delta to talk to herself in an infinite loop.
        turn_detection: {
          type: "server_vad",
          threshold: 0.65,
          prefix_padding_ms: 300,
          silence_duration_ms: 900,
          create_response: true,
          interrupt_response: true,
        },
        // Near-field for typical laptop / desktop mics — far-field is for
        // conference-room arrays.
        noise_reduction: { type: "near_field" },
      },
      output: {
        voice,   // marin / cedar / alloy / shimmer
      },
    },
    tools: (assistant.TOOLS || []).map(anthropicToolToOpenAI),
    tool_choice: "auto",
  };
}

// ---------------------------------------------------------------------------
// Mint an ephemeral key. Browser uses this to negotiate WebRTC directly.
// Returns { ok: true, value, expires_at, session, model } or { ok: false, error }.
// ---------------------------------------------------------------------------
async function mintClientSecret(user, opts = {}) {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: "OPENAI_API_KEY not set on server" };
  }
  const session = buildSessionConfig(user, opts);
  const body = {
    expires_after: { anchor: "created_at", seconds: 600 },
    session,
  };
  try {
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        // NO `OpenAI-Beta: realtime=v1` header — that was the deprecated path.
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `OpenAI ${resp.status}: ${text.slice(0, 400)}` };
    }
    const data = await resp.json();
    return {
      ok: true,
      value: data.value,
      expires_at: data.expires_at,
      session: data.session,
      model: REALTIME_MODEL,
    };
  } catch (err) {
    return { ok: false, error: `mint failed: ${err.message || String(err)}` };
  }
}

function isConfigured() {
  return !!OPENAI_API_KEY;
}

module.exports = {
  isConfigured,
  mintClientSecret,
  REALTIME_MODEL,
  DEFAULT_VOICE,
};
