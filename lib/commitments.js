// Delta Commitments — Phase 5.AK.
//
// "What did I say I'd do?" — the most important question an
// executive's email inbox can answer, and the one most email clients
// completely ignore.
//
// Every time the user sends an email, we extract any commitments the
// USER (not the recipient) made — promises, deliverables, follow-ups,
// callbacks with deadlines. Stored in delta_commitments.
//
// On inbound emails, we check whether the new message fulfills any
// existing commitment in that thread (the user replied to the same
// thread = follow-up landed; OR a reply from the recipient in the
// same thread = the loop closed).
//
// Public surface:
//   extractFromSent(user, message)       - run after /api/gmail/send
//   maybeFulfillFromInbound(user, message) - run after each inbox sync
//   listOpen / listOverdue / listAll     - read for UI + morning brief
//   dismiss(userId, id)                  - user manually clears
//   markFulfilled(userId, id)            - manual mark-done

const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("./db");
const memory = require("./memory");

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const EXTRACTOR_MODEL = "claude-sonnet-4-6";

// Hard cap on input size — emails get truncated to this many chars
// before we ask Claude to extract commitments. Plenty of context for
// any real reply.
const MAX_INPUT_CHARS = 5000;

function isExtractorAvailable() {
  return !!anthropic;
}

// Cheap pre-filter — emails with NO future-tense commitment-shaped
// language are almost certainly commitment-free. Saves a Claude call
// per thank-you email.
function looksLikeItMightContainCommitment(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const triggers = [
    /\bi(?:'| wi)ll\b/, /\bi will\b/, /\bi'?ll\b/,
    /\bwe(?:'| wi)ll\b/, /\bwe will\b/, /\bwe'?ll\b/,
    /\bi can\b/, /\bi can do\b/,
    /\blet me\b/, /\blet me know\b/,
    /\bi'?m going to\b/, /\bgoing to\b/,
    /\bgive me until\b/, /\bby (?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|tonight|eod|end of day|cob|end of week)\b/,
    /\bwill (?:send|check|revert|respond|call|email|circle back|get back|review|update|forward|share|attach|confirm|update)\b/,
    /\bhappy to\b/, /\bwill (?:do|set up|sort)\b/,
    /\bcircling back\b/,
    /\b(?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|today|asap|by)\b.*\b(?:send|share|do|check)/,
    // Dutch/Farsi minimums — broad
    /\bik (?:zal|ga|stuur)/, /\bik kan/,
    /انجام/, /می‌فرستم/, /می‌رسانم/,
  ];
  return triggers.some((r) => r.test(t));
}

// Build a structured prompt asking Claude for commitments only.
function buildExtractorPrompt(user, message) {
  const body = (message.bodyText || message.body || "").slice(0, MAX_INPUT_CHARS);
  const userName = user.display_name || user.email;
  const recipient = message.to || "";
  const today = new Date().toISOString().slice(0, 10);
  return `You are analysing an email that ${userName} just sent. Extract any COMMITMENTS the user made — clear promises to do something, deliverables, follow-ups, or callbacks. Be strict: a commitment must be a future action the user owes someone, ideally with a deadline.

ALWAYS commitments (extract these):
- "I'll send you the budget by Friday"     → text:"Send the budget", due_text:"by Friday"
- "Will check with Lana and revert tomorrow" → two commitments? No — one ("Check with Lana and revert"), due_text:"tomorrow"
- "Happy to help — I'll set it up next week" → text:"Set it up", due_text:"next week"
- "Let me get back to you by EOD" → text:"Get back to recipient", due_text:"end of day today"

NEVER commitments (do NOT extract):
- "Thanks for the update" (no action)
- "Let me know if you need anything" (offer to recipient, no user-owed action)
- "I think we should…" (opinion)
- "We will need to…" (general planning, not a user-owed action with deadline)
- "Will be in touch" (too vague — no deadline AND no concrete deliverable)
- Casual social pleasantries

DEADLINE PARSING:
- Today's date is ${today}. Convert relative deadlines to an absolute ISO date in the user's local timezone (Europe/Amsterdam if unknown).
- "tomorrow" → tomorrow's date at 17:00 local
- "by Friday" → the next upcoming Friday at 17:00 local
- "next week" → the upcoming Monday at 09:00 local (vague — that's OK)
- "EOD" / "end of day" → today at 17:00 local
- If no deadline at all → due_text:null, due_at_iso:null (still a commitment, just open-ended)

THE EMAIL:
From: ${userName} <${user.email}>
To: ${recipient}
Subject: ${message.subject || "(no subject)"}
Date: ${message.date || new Date().toISOString()}

----- BODY -----
${body}
----- END BODY -----

Output ONLY this JSON object — no preamble, no markdown fences:
{
  "commitments": [
    {
      "text": "Short imperative description of the commitment, 3-12 words",
      "due_text": "How the user phrased the deadline, exactly as written, or null",
      "due_at_iso": "ISO 8601 with timezone, or null"
    }
  ]
}

If there are no commitments, return { "commitments": [] }.`;
}

function parseExtractorReply(raw) {
  if (!raw) return [];
  let s = String(raw).trim();
  // Strip code fences if model emitted them despite the instruction.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const obj = JSON.parse(s);
    if (!Array.isArray(obj?.commitments)) return [];
    return obj.commitments
      .filter((c) => c && typeof c.text === "string" && c.text.trim())
      .map((c) => ({
        text: c.text.trim().slice(0, 240),
        due_text: c.due_text ? String(c.due_text).slice(0, 80) : null,
        due_at: c.due_at_iso ? safeIso(c.due_at_iso) : null,
      }));
  } catch (err) {
    console.warn("[commitments] parse failed:", err.message);
    return [];
  }
}

function safeIso(s) {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (_) { return null; }
}

// Pull recipient name + email out of a "Name <email>" To header.
function parseRecipient(rawTo) {
  if (!rawTo) return { recipient_email: null, recipient_name: null };
  const m = String(rawTo).match(/^"?([^"<,]+?)"?\s*<([^>]+)>/);
  if (m) {
    return { recipient_name: m[1].trim(), recipient_email: m[2].toLowerCase().trim() };
  }
  if (rawTo.includes("@")) {
    return { recipient_name: null, recipient_email: rawTo.toLowerCase().split(",")[0].trim() };
  }
  return { recipient_name: rawTo.trim(), recipient_email: null };
}

// Public: extract + persist commitments from a just-sent email.
async function extractFromSent(user, message) {
  if (!user?.id) return { extracted: 0, skipped: "no_user" };
  if (!isExtractorAvailable()) return { extracted: 0, skipped: "no_anthropic_key" };
  const body = message.bodyText || message.body || "";
  if (!body || !looksLikeItMightContainCommitment(body)) {
    return { extracted: 0, skipped: "no_commitment_signal" };
  }
  let extracted = [];
  try {
    const resp = await anthropic.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: buildExtractorPrompt(user, message) }],
    });
    const raw = (resp.content[0]?.text || "").trim();
    extracted = parseExtractorReply(raw);
  } catch (err) {
    console.warn("[commitments.extractFromSent] anthropic failed:", err.message);
    return { extracted: 0, skipped: "extractor_error" };
  }
  if (!extracted.length) return { extracted: 0, skipped: "none_found" };

  const { recipient_email, recipient_name } = parseRecipient(message.to);
  const messageId = message.sentMessageId || message.messageId || message.id;
  const threadId = message.threadId || null;

  let inserted = 0;
  for (const c of extracted) {
    try {
      await pool.query(
        `INSERT INTO delta_commitments
            (user_id, source_message_id, source_thread_id,
             recipient_email, recipient_name,
             commitment_text, due_text, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [user.id, messageId, threadId, recipient_email, recipient_name,
         c.text, c.due_text, c.due_at]
      );
      inserted++;
    } catch (err) {
      console.warn("[commitments.extractFromSent] insert failed:", err.message);
    }
  }
  if (inserted > 0) {
    console.log(`[commitments] user ${user.id}: extracted ${inserted} commitment(s) from sent email to ${recipient_email}`);
  }
  return { extracted: inserted };
}

// Public: when a new inbound message lands, check whether it
// fulfills any open commitment of this user. Strategy: if the
// inbound is in a thread that has an open commitment AND the
// inbound is FROM the recipient of that commitment (i.e. they
// replied), mark all open commitments in that thread as fulfilled.
//
// We don't try to match by free text — too noisy. Thread-based
// fulfilment is conservative + good enough for v1. The user can
// also manually dismiss anything that wasn't actually fulfilled.
async function maybeFulfillFromInbound(user, message) {
  if (!user?.id || !message) return { fulfilled: 0 };
  const threadId = message.thread_id || message.threadId;
  if (!threadId) return { fulfilled: 0 };
  const fromEmail = extractFromEmail(message.from_header || message.from || "");
  if (!fromEmail) return { fulfilled: 0 };

  const r = await pool.query(
    `UPDATE delta_commitments
        SET status = 'fulfilled',
            fulfilled_at = NOW(),
            fulfilled_by_message_id = $3,
            updated_at = NOW()
      WHERE user_id = $1
        AND source_thread_id = $2
        AND status = 'open'
        AND LOWER(recipient_email) = LOWER($4)
      RETURNING id, commitment_text`,
    [user.id, threadId, message.message_id || message.id, fromEmail]
  );
  if (r.rowCount > 0) {
    console.log(`[commitments] user ${user.id}: ${r.rowCount} commitment(s) auto-fulfilled by reply from ${fromEmail}`);
  }
  return { fulfilled: r.rowCount, items: r.rows };
}

function extractFromEmail(rawFrom) {
  if (!rawFrom) return "";
  const m = String(rawFrom).match(/<([^>]+)>/);
  return ((m ? m[1] : rawFrom) || "").toLowerCase().trim();
}

// Read-side ---------------------------------------------------------

async function listOpen(userId, { limit = 50 } = {}) {
  const r = await pool.query(
    `SELECT id, source_message_id, source_thread_id,
            recipient_email, recipient_name,
            commitment_text, due_text, due_at,
            status, created_at,
            CASE WHEN due_at IS NOT NULL AND due_at < NOW() THEN TRUE ELSE FALSE END AS is_overdue
       FROM delta_commitments
      WHERE user_id = $1 AND status = 'open'
      ORDER BY
        (due_at IS NULL) ASC,            -- with-deadline first
        due_at ASC,                       -- soonest first
        created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

async function listOverdue(userId) {
  const r = await pool.query(
    `SELECT id, source_message_id, source_thread_id,
            recipient_email, recipient_name,
            commitment_text, due_text, due_at,
            EXTRACT(EPOCH FROM (NOW() - due_at))::int AS overdue_seconds
       FROM delta_commitments
      WHERE user_id = $1
        AND status = 'open'
        AND due_at IS NOT NULL
        AND due_at < NOW()
      ORDER BY due_at ASC`,
    [userId]
  );
  return r.rows;
}

async function listFulfilledRecently(userId, { hours = 48 } = {}) {
  const r = await pool.query(
    `SELECT id, recipient_email, commitment_text, due_text, fulfilled_at
       FROM delta_commitments
      WHERE user_id = $1
        AND status = 'fulfilled'
        AND fulfilled_at > NOW() - ($2 || ' hours')::INTERVAL
      ORDER BY fulfilled_at DESC`,
    [userId, hours]
  );
  return r.rows;
}

async function listAll(userId, { status = null, limit = 100 } = {}) {
  const params = [userId];
  let where = "user_id = $1";
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(limit);
  const r = await pool.query(
    `SELECT id, source_message_id, source_thread_id,
            recipient_email, recipient_name,
            commitment_text, due_text, due_at,
            status, created_at, fulfilled_at, dismissed_at
       FROM delta_commitments
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function dismiss(userId, id) {
  const r = await pool.query(
    `UPDATE delta_commitments
        SET status = 'cancelled',
            dismissed_at = NOW(),
            updated_at = NOW()
      WHERE user_id = $1 AND id = $2 AND status IN ('open', 'overdue')
      RETURNING id`,
    [userId, id]
  );
  return { ok: r.rowCount > 0 };
}

async function markFulfilled(userId, id) {
  const r = await pool.query(
    `UPDATE delta_commitments
        SET status = 'fulfilled',
            fulfilled_at = NOW(),
            updated_at = NOW()
      WHERE user_id = $1 AND id = $2 AND status IN ('open', 'overdue')
      RETURNING id`,
    [userId, id]
  );
  return { ok: r.rowCount > 0 };
}

// Stats for morning brief / dashboard.
async function getStats(userId) {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open' AND (due_at IS NULL OR due_at >= NOW()))::int AS open_count,
       COUNT(*) FILTER (WHERE status = 'open' AND due_at IS NOT NULL AND due_at < NOW())::int AS overdue_count,
       COUNT(*) FILTER (WHERE status = 'fulfilled' AND fulfilled_at > NOW() - INTERVAL '7 days')::int AS fulfilled_last_7d,
       COUNT(*)::int AS total
       FROM delta_commitments
      WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0];
}

module.exports = {
  isExtractorAvailable,
  looksLikeItMightContainCommitment,
  extractFromSent,
  maybeFulfillFromInbound,
  listOpen,
  listOverdue,
  listFulfilledRecently,
  listAll,
  dismiss,
  markFulfilled,
  getStats,
};
