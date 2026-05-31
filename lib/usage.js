// Admin-console telemetry helpers — Delta usage/cost, email sends,
// activity sessions, and chat persistence. All best-effort: a logging
// failure must never break the user-facing request, so every helper
// swallows its own errors.

const { pool } = require("./db");

// USD per 1,000,000 tokens. Update here if Anthropic pricing changes;
// override per-model via env (e.g. DELTA_PRICE_OPUS_IN). Keyed by a
// normalised model family so date-suffixed ids still match.
const PRICING = {
  // family: [inputPer1M, outputPer1M]
  sonnet: [Number(process.env.DELTA_PRICE_SONNET_IN || 3),  Number(process.env.DELTA_PRICE_SONNET_OUT || 15)],
  opus:   [Number(process.env.DELTA_PRICE_OPUS_IN   || 15), Number(process.env.DELTA_PRICE_OPUS_OUT   || 75)],
  haiku:  [Number(process.env.DELTA_PRICE_HAIKU_IN  || 0.8),Number(process.env.DELTA_PRICE_HAIKU_OUT  || 4)],
  // OpenAI realtime/voice is billed differently; rough blended placeholder.
  voice:  [Number(process.env.DELTA_PRICE_VOICE_IN  || 5),  Number(process.env.DELTA_PRICE_VOICE_OUT  || 20)],
};

function priceFor(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("opus")) return PRICING.opus;
  if (m.includes("haiku")) return PRICING.haiku;
  if (m.includes("sonnet")) return PRICING.sonnet;
  if (m.includes("realtime") || m.includes("voice") || m.includes("gpt-4o")) return PRICING.voice;
  return PRICING.sonnet; // safe default
}

function costUsd(model, inTokens, outTokens) {
  const [inR, outR] = priceFor(model);
  return (Number(inTokens || 0) / 1e6) * inR + (Number(outTokens || 0) / 1e6) * outR;
}

// Record one Delta call's token usage + computed cost.
async function recordDeltaUsage({ userId, surface = "chat", model, inTokens = 0, outTokens = 0 }) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO delta_usage (user_id, surface, model, in_tokens, out_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, surface, model || null, inTokens, outTokens, costUsd(model, inTokens, outTokens)],
    );
  } catch (err) {
    console.warn("[usage] recordDeltaUsage failed:", err.message);
  }
}

// Record one outbound email.
async function recordEmailSend({ userId, to, subject, kind = "reply", threadId = null }) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO email_sends (user_id, to_email, subject, kind, thread_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, (to || "").slice(0, 300), (subject || "").slice(0, 500), kind, threadId],
    );
  } catch (err) {
    console.warn("[usage] recordEmailSend failed:", err.message);
  }
}

// Persist one Delta chat turn for quality monitoring. Content is capped
// so a giant draft body doesn't bloat the table.
async function recordChatTurn({ userId, role, content, surface = "chat", model = null }) {
  if (!userId || !role) return;
  try {
    await pool.query(
      `INSERT INTO delta_chat_messages (user_id, role, content, surface, model)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, role, String(content || "").slice(0, 8000), surface, model],
    );
  } catch (err) {
    console.warn("[usage] recordChatTurn failed:", err.message);
  }
}

// Heartbeat → session window. A ping within IDLE_GAP of the user's most
// recent ping extends that session; otherwise it opens a new one. Summing
// (last_ping_at - started_at) per session approximates time-on-app.
const IDLE_GAP_MS = 5 * 60 * 1000; // 5 min gap = new session
async function touchSession(userId) {
  if (!userId) return;
  try {
    const r = await pool.query(
      `SELECT id, last_ping_at FROM user_sessions
        WHERE user_id = $1 ORDER BY last_ping_at DESC LIMIT 1`,
      [userId],
    );
    const last = r.rows[0];
    if (last && (Date.now() - new Date(last.last_ping_at).getTime()) < IDLE_GAP_MS) {
      await pool.query(
        `UPDATE user_sessions SET last_ping_at = NOW(), ping_count = ping_count + 1 WHERE id = $1`,
        [last.id],
      );
    } else {
      await pool.query(`INSERT INTO user_sessions (user_id) VALUES ($1)`, [userId]);
    }
  } catch (err) {
    console.warn("[usage] touchSession failed:", err.message);
  }
}

module.exports = {
  PRICING, priceFor, costUsd,
  recordDeltaUsage, recordEmailSend, recordChatTurn, touchSession,
};
