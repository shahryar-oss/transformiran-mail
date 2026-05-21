// Delta Voice — edit-diff learning (Phase 5.AE).
//
// Every time Delta drafts a reply we stash the draft text with a generated
// draft_id. The client carries that draft_id through compose → send. On
// send we diff what the user actually sent against Delta's original draft,
// then store the pair in delta_draft_edits. A periodic distiller turns
// the most recent N pairs into a per-user "voice profile" — a short
// cheatsheet of preferred openings, sign-offs, sentence length, formality,
// idiosyncrasies — that gets injected into draftReply system prompts so
// subsequent drafts sound progressively more like the user.
//
// Three moving parts:
//   1. captureOriginal(user, ...) → returns draftId. Called from draftReply.
//   2. recordSend(user, draftId, sentText) → diffs + writes edit row.
//      Called from /api/gmail/send.
//   3. distillProfileIfReady(user) → checks if enough new edits have
//      arrived; if so, calls Claude to produce a fresh voice profile.
//      Called from a nightly worker AND opportunistically from recordSend
//      when the un-distilled count crosses a threshold.

const crypto = require("crypto");
const { pool } = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const DISTILLER_MODEL = "claude-sonnet-4-6";

// Minimum number of new edits needed before we'll re-distill. Distilling
// every edit is wasteful; waiting too long means the profile lags. Five
// new edits is a reasonable cadence — most users will hit this in a few
// days of real use.
const REDISTILL_AFTER_NEW_EDITS = 5;
// Hard cap on edits we feed the distiller — keeps the prompt size bounded.
const MAX_EDITS_TO_DISTILL = 25;
// Skip edits where the user changed almost nothing — those tell us
// nothing about voice and pollute the signal.
const MIN_DELTA_RATIO = 0.02;
// Also skip edits where the user rewrote the whole thing — likely they
// rejected Delta's draft entirely, which isn't a voice signal either.
const MAX_DELTA_RATIO = 0.85;

// ---------- helpers ----------

// Strip the user's signature off the bottom (we don't want to teach Delta
// that the user always types their email address). Heuristic: drop anything
// after a line that looks like "-- ", or after the last paragraph if it
// contains an email or phone-shaped string.
function stripSignature(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^-- ?$/.test(lines[i].trim())) {
      return lines.slice(0, i).join("\n").trim();
    }
  }
  return text.trim();
}

// Strip the quoted-original-message tail. Anything from "On ... wrote:"
// onwards, or from a line of consecutive >'s, is the quoted original.
function stripQuoted(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((line) =>
    /^On .+? wrote:\s*$/.test(line.trim()) ||
    /^-{3,} ?Original Message ?-{3,}$/i.test(line.trim()) ||
    /^From: .+/.test(line.trim()) && lines.slice(0, lines.indexOf(line)).some((l) => l.trim() === "")
  );
  if (cut > 0) return lines.slice(0, cut).join("\n").trim();
  return text.trim();
}

// Strip HTML tags + signature + quoted reply. Result is just the user's
// fresh prose, which is what we want to learn voice from.
function cleanBodyForLearning(text) {
  if (!text) return "";
  // Cheap HTML → text: strip tags, decode the common entities. Good
  // enough for voice signal — we don't need pristine output.
  let s = String(text)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  s = stripQuoted(s);
  s = stripSignature(s);
  // Collapse triple+ blank lines.
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Cheap similarity: Jaccard over whitespace-split tokens. Not perfect
// but fast, deterministic, and good enough to filter trivial vs. heavy
// edits without dragging in a full diff library.
function similarity(a, b) {
  if (!a || !b) return 0;
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!tokensA.size && !tokensB.size) return 1;
  let intersect = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersect++;
  const union = tokensA.size + tokensB.size - intersect;
  return union ? intersect / union : 0;
}

// ---------- capture / record ----------

// Called from draftReply. Returns the draft_id the caller should surface
// to the client (so it can be carried through compose and back to send).
async function captureOriginal(userId, { sourceMessageId, instructions, draftText }) {
  if (!userId || !draftText) return null;
  const draftId = crypto.randomBytes(12).toString("hex");
  try {
    await pool.query(
      `INSERT INTO delta_draft_originals (draft_id, user_id, source_message_id, instructions, draft_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [draftId, userId, sourceMessageId || null, instructions || null, draftText]
    );
    return draftId;
  } catch (err) {
    console.warn("[voice.captureOriginal] failed:", err.message);
    return null;
  }
}

// Called from /api/gmail/send. Looks up the original Delta draft by id,
// diffs against what the user actually sent, writes the pair to
// delta_draft_edits, and triggers a re-distill if enough new edits have
// accumulated. All errors are swallowed — capture is best-effort.
async function recordSend(userId, draftId, sentTextRaw) {
  if (!userId || !draftId || !sentTextRaw) return { recorded: false };
  let original;
  try {
    const r = await pool.query(
      `SELECT draft_id, source_message_id, draft_text
         FROM delta_draft_originals
        WHERE draft_id = $1 AND user_id = $2 AND consumed_at IS NULL`,
      [draftId, userId]
    );
    original = r.rows[0];
  } catch (err) {
    console.warn("[voice.recordSend] lookup failed:", err.message);
    return { recorded: false };
  }
  if (!original) return { recorded: false, reason: "no_original" };

  const draftClean = cleanBodyForLearning(original.draft_text);
  const sentClean = cleanBodyForLearning(sentTextRaw);
  const sim = similarity(draftClean, sentClean);

  try {
    await pool.query(
      `INSERT INTO delta_draft_edits
         (user_id, draft_id, source_message_id, drafted_text, sent_text, similarity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, draftId, original.source_message_id, draftClean, sentClean, sim]
    );
    await pool.query(
      `UPDATE delta_draft_originals SET consumed_at = NOW() WHERE draft_id = $1`,
      [draftId]
    );
  } catch (err) {
    console.warn("[voice.recordSend] insert failed:", err.message);
    return { recorded: false };
  }

  // Opportunistic distill — if the unseen-by-distiller count crosses the
  // threshold, refresh the voice profile now. Errors are non-fatal.
  distillProfileIfReady({ id: userId }).catch((err) =>
    console.warn("[voice.recordSend] opportunistic distill failed:", err.message)
  );

  return { recorded: true, similarity: sim };
}

// ---------- distill ----------

// Returns { needsDistill, newEditCount, lastEditId } for the given user.
async function distillStatus(userId) {
  const profileRow = await pool.query(
    `SELECT last_edit_id, distilled_from_count
       FROM delta_voice_profiles WHERE user_id = $1`,
    [userId]
  );
  const lastEditId = profileRow.rows[0]?.last_edit_id || 0;
  const newRows = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0) AS max_id
       FROM delta_draft_edits
      WHERE user_id = $1 AND id > $2
        AND similarity BETWEEN $3 AND $4`,
    [userId, lastEditId, 1 - MAX_DELTA_RATIO, 1 - MIN_DELTA_RATIO]
  );
  const newCount = newRows.rows[0].n;
  const maxId = Number(newRows.rows[0].max_id);
  return {
    needsDistill: newCount >= REDISTILL_AFTER_NEW_EDITS,
    newEditCount: newCount,
    lastEditId: maxId,
    hasProfile: profileRow.rows.length > 0,
  };
}

// Pull the most recent N edits worth feeding the distiller. We rank by
// "edit size" (i.e. lower similarity = more signal) and then by recency.
async function pullEditsForDistill(userId) {
  const r = await pool.query(
    `SELECT id, drafted_text, sent_text, similarity, created_at
       FROM delta_draft_edits
      WHERE user_id = $1
        AND similarity BETWEEN $2 AND $3
      ORDER BY created_at DESC
      LIMIT $4`,
    [userId, 1 - MAX_DELTA_RATIO, 1 - MIN_DELTA_RATIO, MAX_EDITS_TO_DISTILL]
  );
  return r.rows;
}

// Builds the distiller prompt. Outputs a structured "voice cheatsheet"
// that downstream draftReply can paste verbatim into its system prompt.
function buildDistillPrompt(user, edits) {
  const userName = user.display_name || user.email || "the user";
  const examples = edits.map((e, i) => {
    return `--- EXAMPLE ${i + 1} (similarity ${e.similarity?.toFixed?.(2) ?? "?"}) ---
DELTA'S DRAFT:
${e.drafted_text}

USER'S FINAL SENT VERSION:
${e.sent_text}`;
  }).join("\n\n");

  return `You are analyzing how ${userName} edits AI-drafted emails to make them sound more like themselves.

Below are recent pairs: each shows what Delta (an AI assistant) drafted, and what the user actually sent. The differences reveal the user's voice.

Your job: write a concise VOICE CHEATSHEET (max 350 words) that a future draft-writer can read to write in this user's voice from the start. Focus on patterns you can confirm across multiple examples, not one-offs.

Cover, where the examples show clear patterns:
- Preferred greetings / openings (e.g., "Hi X,", "Dear X,", no greeting, etc.)
- Preferred sign-offs (e.g., "Best,", "Thanks,", just first name, etc.)
- Sentence length: short and punchy vs. flowing vs. long
- Formality: very formal / professional-warm / casual / direct
- Recurring phrases the user adds or removes
- Words/phrases the user systematically removes (e.g., they cut "I hope you're doing well" — flag it)
- Idiosyncrasies (em-dashes, parentheticals, all-caps for emphasis, lowercase i, etc.)
- How they handle requests vs. responses (do they always restate the question? skip pleasantries? etc.)

Write in second person directly to a future draft-writer, e.g. "Open with just 'Hi [name],' — no 'I hope...' line. Keep sentences short. Sign off with 'Best,\\n${userName.split(" ")[0]}'."

Be specific. If something is ambiguous from the examples, leave it out — don't speculate. The cheatsheet is going to be pasted into another AI's system prompt, so every line must be confident and actionable.

EDIT EXAMPLES:

${examples}

Now write the cheatsheet. Output only the cheatsheet text — no preamble, no markdown headers, no closing remarks.`;
}

async function distillProfile(user) {
  if (!anthropic) {
    return { ok: false, reason: "no_anthropic_key" };
  }
  const status = await distillStatus(user.id);
  if (!status.needsDistill && status.hasProfile) {
    return { ok: false, reason: "not_enough_new_edits", newEditCount: status.newEditCount };
  }
  const edits = await pullEditsForDistill(user.id);
  if (edits.length < REDISTILL_AFTER_NEW_EDITS && !status.hasProfile) {
    return { ok: false, reason: "not_enough_edits_yet", have: edits.length };
  }
  if (!edits.length) {
    return { ok: false, reason: "no_edits" };
  }

  const prompt = buildDistillPrompt(user, edits);
  let profileText;
  try {
    const resp = await anthropic.messages.create({
      model: DISTILLER_MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    profileText = (resp.content[0]?.text || "").trim();
  } catch (err) {
    console.warn("[voice.distillProfile] anthropic failed:", err.message);
    return { ok: false, reason: "anthropic_failed", error: err.message };
  }
  if (!profileText) {
    return { ok: false, reason: "empty_response" };
  }

  const lastEditId = edits.reduce((max, e) => Math.max(max, Number(e.id)), 0);
  await pool.query(
    `INSERT INTO delta_voice_profiles (user_id, profile_text, distilled_from_count, last_edit_id, generated_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET profile_text         = EXCLUDED.profile_text,
           distilled_from_count = EXCLUDED.distilled_from_count,
           last_edit_id         = EXCLUDED.last_edit_id,
           updated_at           = NOW()`,
    [user.id, profileText, edits.length, lastEditId]
  );
  console.log(`[voice.distillProfile] user ${user.id}: refreshed from ${edits.length} edits`);
  return { ok: true, profile_text: profileText, distilled_from: edits.length };
}

// Only distill if status says we're ready — saves API calls.
async function distillProfileIfReady(user) {
  const status = await distillStatus(user.id);
  if (status.needsDistill || (!status.hasProfile && status.newEditCount >= REDISTILL_AFTER_NEW_EDITS)) {
    return distillProfile(user);
  }
  return { ok: false, reason: "not_ready", ...status };
}

// ---------- load (used by draftReply system prompt) ----------

async function loadProfile(userId) {
  try {
    const r = await pool.query(
      `SELECT profile_text, distilled_from_count, generated_at
         FROM delta_voice_profiles WHERE user_id = $1`,
      [userId]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.warn("[voice.loadProfile] failed:", err.message);
    return null;
  }
}

// Return all users with at least one new edit since last distill — for
// the nightly worker.
async function listUsersNeedingDistill({ limit = 10 } = {}) {
  const r = await pool.query(
    `SELECT u.id, u.email, u.display_name
       FROM users u
       JOIN delta_draft_edits e ON e.user_id = u.id
       LEFT JOIN delta_voice_profiles p ON p.user_id = u.id
      WHERE e.id > COALESCE(p.last_edit_id, 0)
      GROUP BY u.id, u.email, u.display_name, p.last_edit_id
     HAVING COUNT(e.id) >= $1
      LIMIT $2`,
    [REDISTILL_AFTER_NEW_EDITS, limit]
  );
  return r.rows;
}

// Stats for /settings UI.
async function getStats(userId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total_edits,
            COUNT(*) FILTER (WHERE similarity BETWEEN 0.15 AND 0.98)::int AS useful_edits,
            COALESCE(AVG(similarity), 0)::real AS avg_similarity,
            MAX(created_at) AS last_edit_at
       FROM delta_draft_edits
      WHERE user_id = $1`,
    [userId]
  );
  const stats = r.rows[0];
  const profile = await loadProfile(userId);
  return {
    total_edits: stats.total_edits,
    useful_edits: stats.useful_edits,
    avg_similarity: stats.avg_similarity,
    last_edit_at: stats.last_edit_at,
    profile_text: profile?.profile_text || null,
    distilled_from_count: profile?.distilled_from_count || 0,
    profile_generated_at: profile?.generated_at || null,
  };
}

// Cleanup: drop original-draft rows older than 30 days that haven't been
// consumed (user gave up on the draft) or that have been consumed
// (we already wrote their edit pair).
async function pruneOriginals({ olderThanDays = 30 } = {}) {
  const r = await pool.query(
    `DELETE FROM delta_draft_originals
      WHERE created_at < NOW() - ($1 || ' days')::interval
      RETURNING draft_id`,
    [olderThanDays]
  );
  return r.rowCount;
}

module.exports = {
  captureOriginal,
  recordSend,
  distillProfile,
  distillProfileIfReady,
  distillStatus,
  loadProfile,
  listUsersNeedingDistill,
  getStats,
  pruneOriginals,
  // helpers exported for tests
  cleanBodyForLearning,
  similarity,
};
