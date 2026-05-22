// Per-email extractions — Phase 5.AL.
//
// One Claude call extracts BOTH:
//   (a) ACTION_ITEMS — what the sender is asking the user to do, with
//       deadline parsed. Surfaced as a "what they want from you" card
//       at the top of the email reader, with one-click "Add to tasks".
//   (b) SMART_REPLIES — three voice-matched one-tap reply chips that
//       cover the most likely responses (commit / delay-or-question /
//       delegate-or-decline). Generated using the user's voice profile
//       so they sound like the user.
//
// Cached in email_extractions by (user_id, message_id). Lazy — only
// runs when the user actually opens the email. Doubles as a token
// halver (one Claude call for both signals instead of two).

const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("./db");
const voice = require("./voice");

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const EXTRACTOR_MODEL = "claude-sonnet-4-6";
const EXTRACTOR_VERSION = 1;
const MAX_INPUT_CHARS = 6000;

function isAvailable() {
  return !!anthropic;
}

function hashBody(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 32);
}

function buildPrompt({ user, message, voiceProfile }) {
  const userName = user.display_name || user.email;
  const firstName = userName.split(" ")[0];
  const body = (message.bodyText || message.body || message.snippet || "").slice(0, MAX_INPUT_CHARS);
  const today = new Date().toISOString().slice(0, 10);
  return `You are reading an email that ${userName} just received. Extract two things in ONE structured JSON output.

==========================================
1) ACTION_ITEMS
==========================================
What does the SENDER want ${firstName} to do? Be strict. Only extract clear, addressable asks — "send the budget", "call me back", "approve this", "review the doc". Not vague "let me know your thoughts" pleasantries unless followed by something concrete. Not the sender's own statements about what THEY will do.

For each action item:
- text: 3-12 word imperative for ${firstName} ("Send the budget", "Call Lana back", "Approve the contract")
- due_text: how the sender phrased the deadline ("by Friday", "ASAP", "tonight"), or null if unstated
- due_at_iso: that deadline resolved to ISO 8601 in Europe/Amsterdam (today is ${today}). 17:00 local if just a date. null if unstated.
- urgency: "high" (today/tomorrow/ASAP) | "medium" (this week) | "low" (next week or no deadline)

If there are NO real asks, return action_items: [].

==========================================
2) SMART_REPLIES — three one-tap reply chips
==========================================
Three short replies covering the three most-likely responses ${firstName} would send:

  CHIP 1 — COMMIT: "${firstName} agrees / says yes / will do the thing."
  CHIP 2 — CLARIFY-OR-DELAY: "${firstName} needs more info / time / context first."
  CHIP 3 — DELEGATE-OR-DECLINE: "${firstName} routes it elsewhere or says no."

Each chip has:
- label: ≤24 chars button text, terse and natural ("Yes, sending today.", "Need more time", "Pass to Pia")
- draft_body: 1-3 sentence reply ready to send. ${firstName}'s voice. No greeting bloat ("I hope you're well…"), no signature. Match the tone of the incoming email — casual for casual, formal for formal.
- intent: "commit" | "clarify" | "delegate"

If the email is a pure FYI / newsletter / automated notification, return smart_replies: [] — chips would just add noise.

${voiceProfile ? `==========================================
${firstName.toUpperCase()}'S VOICE CHEATSHEET
==========================================
${voiceProfile}

Follow this voice precisely in every smart reply draft.

` : ""}==========================================
THE EMAIL
==========================================
From: ${message.from || "(unknown)"}
To: ${message.to || userName}
Subject: ${message.subject || "(no subject)"}
Date: ${message.date || message.date_header || new Date().toISOString()}

----- BODY -----
${body}
----- END BODY -----

==========================================
OUTPUT
==========================================
Return ONLY this JSON object — no preamble, no markdown fences:

{
  "action_items": [
    { "text": "...", "due_text": null, "due_at_iso": null, "urgency": "low" }
  ],
  "smart_replies": [
    { "label": "...", "draft_body": "...", "intent": "commit" },
    { "label": "...", "draft_body": "...", "intent": "clarify" },
    { "label": "...", "draft_body": "...", "intent": "delegate" }
  ]
}`;
}

function parseReply(raw) {
  if (!raw) return { action_items: [], smart_replies: [] };
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    return { action_items: [], smart_replies: [] };
  }
  try {
    const obj = JSON.parse(s.slice(firstBrace, lastBrace + 1));
    const ai = Array.isArray(obj.action_items)
      ? obj.action_items
          .filter((x) => x && typeof x.text === "string" && x.text.trim())
          .slice(0, 5)
          .map((x) => ({
            text: x.text.trim().slice(0, 200),
            due_text: x.due_text ? String(x.due_text).slice(0, 80) : null,
            due_at_iso: x.due_at_iso ? safeIso(x.due_at_iso) : null,
            urgency: ["high", "medium", "low"].includes(x.urgency) ? x.urgency : "low",
          }))
      : [];
    const sr = Array.isArray(obj.smart_replies)
      ? obj.smart_replies
          .filter((x) => x && typeof x.draft_body === "string" && x.draft_body.trim())
          .slice(0, 4)
          .map((x) => ({
            label: (x.label || "").trim().slice(0, 28) || x.draft_body.slice(0, 24),
            draft_body: x.draft_body.trim().slice(0, 600),
            intent: ["commit", "clarify", "delegate"].includes(x.intent) ? x.intent : "commit",
          }))
      : [];
    return { action_items: ai, smart_replies: sr };
  } catch (err) {
    console.warn("[emailExtractions] parse failed:", err.message);
    return { action_items: [], smart_replies: [] };
  }
}

function safeIso(s) {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (_) { return null; }
}

// Read-cache: if we already have a fresh extraction (matching input_hash
// + extractor_version), return it. Otherwise null + caller does the work.
async function getCached(userId, messageId, currentInputHash) {
  try {
    const r = await pool.query(
      `SELECT action_items, smart_replies, input_hash, extractor_version, extracted_at
         FROM email_extractions
        WHERE user_id = $1 AND message_id = $2`,
      [userId, messageId]
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.extractor_version !== EXTRACTOR_VERSION) return null;
    if (currentInputHash && row.input_hash && row.input_hash !== currentInputHash) return null;
    return {
      action_items: row.action_items || [],
      smart_replies: row.smart_replies || [],
      cached: true,
      extracted_at: row.extracted_at,
    };
  } catch (err) {
    console.warn("[emailExtractions.getCached] failed:", err.message);
    return null;
  }
}

async function persist(userId, messageId, threadId, inputHash, action_items, smart_replies) {
  try {
    await pool.query(
      `INSERT INTO email_extractions
          (user_id, message_id, thread_id, action_items, smart_replies, input_hash, extractor_version, extracted_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, NOW())
       ON CONFLICT (user_id, message_id) DO UPDATE SET
         thread_id         = EXCLUDED.thread_id,
         action_items      = EXCLUDED.action_items,
         smart_replies     = EXCLUDED.smart_replies,
         input_hash        = EXCLUDED.input_hash,
         extractor_version = EXCLUDED.extractor_version,
         extracted_at      = NOW()`,
      [
        userId, messageId, threadId || null,
        JSON.stringify(action_items),
        JSON.stringify(smart_replies),
        inputHash,
        EXTRACTOR_VERSION,
      ]
    );
  } catch (err) {
    console.warn("[emailExtractions.persist] failed:", err.message);
  }
}

// Public: extract action items + smart replies for a single message.
// Caller passes the user + the parsed message (with .id, .from, .to,
// .subject, .bodyText, .threadId). Best-effort: returns empty arrays
// on any failure so the UI never breaks.
async function extractFor(user, message) {
  if (!user?.id) return { action_items: [], smart_replies: [], skipped: "no_user" };
  if (!message) return { action_items: [], smart_replies: [], skipped: "no_message" };

  const messageId = message.id || message.messageId || message.message_id;
  const threadId = message.threadId || message.thread_id || null;
  if (!messageId) return { action_items: [], smart_replies: [], skipped: "no_message_id" };

  const body = message.bodyText || message.body || message.snippet || "";
  const inputHash = hashBody(`${message.subject || ""}\n${body}`);

  // Cache lookup
  const cached = await getCached(user.id, messageId, inputHash);
  if (cached) return cached;

  if (!isAvailable()) {
    return { action_items: [], smart_replies: [], skipped: "no_anthropic_key" };
  }

  // Pull voice profile (already cached in DB) so smart replies sound
  // like the user. Fine to fail silently.
  let voiceProfileText = null;
  try {
    const vp = await voice.loadProfile(user.id);
    if (vp?.profile_text) voiceProfileText = vp.profile_text;
  } catch (_) {}

  let parsed = { action_items: [], smart_replies: [] };
  try {
    const resp = await anthropic.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 900,
      messages: [{ role: "user", content: buildPrompt({ user, message, voiceProfile: voiceProfileText }) }],
    });
    const raw = (resp.content[0]?.text || "").trim();
    parsed = parseReply(raw);
  } catch (err) {
    console.warn("[emailExtractions.extractFor] anthropic failed:", err.message);
    return { action_items: [], smart_replies: [], error: err.message };
  }

  // Persist before returning so concurrent opens of the same email don't
  // re-extract.
  await persist(user.id, messageId, threadId, inputHash, parsed.action_items, parsed.smart_replies);

  if (parsed.action_items.length || parsed.smart_replies.length) {
    console.log(`[emailExtractions] user ${user.id} message ${messageId}: ${parsed.action_items.length} action(s), ${parsed.smart_replies.length} reply chip(s)`);
  }
  return { ...parsed, cached: false };
}

// Invalidate cache for a message (e.g. when its body changed or user
// dismissed all suggestions).
async function invalidate(userId, messageId) {
  try {
    await pool.query(
      `DELETE FROM email_extractions WHERE user_id = $1 AND message_id = $2`,
      [userId, messageId]
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isAvailable,
  extractFor,
  invalidate,
  hashBody,
  EXTRACTOR_VERSION,
};
