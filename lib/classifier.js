// Email classifier — Delta tags each inbox message into a category so the
// list can show what matters at a glance, with no chat command required.
// Cached per (user, message_id) in Postgres so we only pay once per email.

const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("./db");

const CLASSIFIER_MODEL = process.env.DELTA_CLASSIFY_MODEL || "claude-sonnet-4-6";
const BATCH_SIZE = 15;        // messages per Anthropic call
const MAX_REASON_LEN = 80;

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const VALID_CATEGORIES = new Set([
  "URGENT",
  "REPLY_NEEDED",
  "TASK",
  "FYI",
  "RECEIPT",
  "NEWSLETTER",
  "INTERNAL",
  "AUTO",
  "DONE",   // server-set when the user replies + archives — not predicted by AI
]);
const VALID_URGENCIES = new Set(["urgent", "today", "this_week", "low"]);

const CLASSIFY_SYSTEM = `
You are an email triage classifier for a Transform Iran executive (CEO/COO).
For each message you receive, output a JSON object with exactly these fields:
  - id: the message id you were given
  - category: one of URGENT | REPLY_NEEDED | TASK | FYI | RECEIPT | NEWSLETTER | INTERNAL | AUTO
  - urgency: one of urgent | today | this_week | low
  - reason: a short phrase (≤ 10 words) explaining the category, in English

Category definitions:
  URGENT       — Requires action today. Time-sensitive, important.
  REPLY_NEEDED — Someone is asking the user a question or for a reply.
  TASK         — A clear action item delegated to the user (not just a question).
  FYI          — Informational only. No action needed. Status updates, news.
  RECEIPT      — Invoices, payment confirmations, receipts, financial notices.
  NEWSLETTER   — Marketing, mass communication, generic broadcasts.
  INTERNAL     — From another Transform Iran staff member, low-key, no urgent ask.
  AUTO         — System-generated (deploy notifications, account alerts, build errors).

Bias toward URGENT/REPLY_NEEDED for emails from:
  Lana Silk, Lazarus Yeghnazar, Maggie Yeghnazar, Pia van Belen, Lauren,
  Barmak, Remco (finance), Simon (UK finance), or any donor mentioning gifts.

Output ONLY a JSON array, no prose. Example:
[
  {"id":"abc123","category":"REPLY_NEEDED","urgency":"today","reason":"Pia asking about Tehran trip approval"},
  {"id":"def456","category":"NEWSLETTER","urgency":"low","reason":"OpenAI billing newsletter"}
]
`.trim();

function buildBatchPrompt(messages) {
  const lines = messages.map((m, i) => {
    const from = (m.from || "").slice(0, 120);
    const subj = (m.subject || "").slice(0, 140);
    const snip = (m.snippet || "").slice(0, 220);
    return `[${i + 1}] id=${m.id}
   from: ${from}
   subject: ${subj}
   snippet: ${snip}`;
  });
  return `Classify these ${messages.length} messages:\n\n${lines.join("\n\n")}`;
}

function parseClassifications(text) {
  // Models occasionally wrap JSON in ```json fences — strip them.
  let body = text.trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  // Try to locate a JSON array in the body if the model added extra prose.
  const firstBracket = body.indexOf("[");
  const lastBracket = body.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    body = body.slice(firstBracket, lastBracket + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error("classifier_parse_failed: " + err.message);
  }
  if (!Array.isArray(parsed)) throw new Error("classifier_not_array");
  return parsed
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const cat = String(row.category || "").toUpperCase();
      const urg = String(row.urgency || "low").toLowerCase();
      return {
        id: String(row.id || ""),
        category: VALID_CATEGORIES.has(cat) ? cat : "FYI",
        urgency: VALID_URGENCIES.has(urg) ? urg : "low",
        reason: String(row.reason || "").slice(0, MAX_REASON_LEN),
      };
    })
    .filter((r) => r && r.id);
}

async function classifyBatch(messages) {
  if (!messages.length) return [];
  const r = await client().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 1200,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: buildBatchPrompt(messages) }],
  });
  const text = (r.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseClassifications(text);
}

// Returns existing classifications for a user keyed by message_id.
async function loadExisting(userId, messageIds) {
  if (!messageIds.length) return new Map();
  const r = await pool.query(
    `SELECT message_id, category, urgency, short_reason
       FROM email_classifications
      WHERE user_id = $1 AND message_id = ANY($2::text[])`,
    [userId, messageIds]
  );
  const map = new Map();
  for (const row of r.rows) {
    map.set(row.message_id, {
      id: row.message_id,
      category: row.category,
      urgency: row.urgency,
      reason: row.short_reason,
    });
  }
  return map;
}

async function saveClassifications(userId, rows) {
  if (!rows.length) return;
  // Use multi-row UPSERT
  const values = [];
  const params = [];
  rows.forEach((c, i) => {
    const base = i * 5;
    params.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    values.push(userId, c.id, c.category, c.urgency, c.reason);
  });
  const sql = `
    INSERT INTO email_classifications
      (user_id, message_id, category, urgency, short_reason)
    VALUES ${params.join(",")}
    ON CONFLICT (user_id, message_id) DO UPDATE SET
      category     = EXCLUDED.category,
      urgency      = EXCLUDED.urgency,
      short_reason = EXCLUDED.short_reason,
      classified_at = NOW()
  `;
  await pool.query(sql, values);
}

// Main entry — classify a list of messages (only those not already cached).
// Returns the full set of classifications (cached + newly classified).
async function classifyForUser(userId, messages) {
  if (!messages || !messages.length) return {};
  const ids = messages.map((m) => m.id);
  const existing = await loadExisting(userId, ids);

  const todo = messages.filter((m) => !existing.has(m.id));
  const fresh = [];

  // Run batches in parallel for snappier UX. Cap at 3 concurrent to be
  // gentle on the rate limiter.
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    batches.push(todo.slice(i, i + BATCH_SIZE));
  }
  const CONCURRENCY = 3;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map((b) =>
        classifyBatch(b).catch((err) => {
          console.warn("[classifier] batch failed:", err.message);
          return [];
        })
      )
    );
    for (const r of results) fresh.push(...r);
  }

  if (fresh.length) {
    try {
      await saveClassifications(userId, fresh);
    } catch (err) {
      console.error("[classifier] save failed:", err);
    }
  }

  const out = {};
  for (const [id, c] of existing) out[id] = c;
  for (const c of fresh) out[c.id] = c;
  return out;
}

// Mark a list of message IDs as DONE (used by /api/gmail/send after a
// reply is sent, to keep the inbox clean and visually distinguish replied
// threads with a green DONE chip).
async function markMessagesDone(userId, messageIds, reason = "Replied") {
  if (!messageIds || !messageIds.length) return 0;
  const { pool } = require("./db");
  const placeholders = [];
  const values = [];
  let n = 1;
  for (const id of messageIds) {
    placeholders.push(`($${n++}, $${n++}, $${n++}, $${n++}, $${n++})`);
    values.push(userId, id, "DONE", "low", reason);
  }
  const sql = `
    INSERT INTO email_classifications (user_id, message_id, category, urgency, short_reason)
    VALUES ${placeholders.join(",")}
    ON CONFLICT (user_id, message_id) DO UPDATE SET
      category     = EXCLUDED.category,
      urgency      = EXCLUDED.urgency,
      short_reason = EXCLUDED.short_reason,
      classified_at = NOW()
  `;
  const r = await pool.query(sql, values);
  return r.rowCount;
}

module.exports = { classifyForUser, classifyBatch, markMessagesDone, VALID_CATEGORIES };
