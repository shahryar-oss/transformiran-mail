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

function buildClassifySystem(user) {
  const name = (user?.display_name || "").trim();
  const email = (user?.email || "").trim().toLowerCase();
  const firstName = name.split(/\s+/)[0] || "";
  return `
You are an email triage classifier for **${name || "a Transform Iran executive"}** (${email || "CEO/COO"}).
You tag each message from THIS USER's perspective — meaning: is THIS user the one expected to act?

For each message, output a JSON object with exactly these fields:
  - id: the message id you were given
  - category: one of URGENT | REPLY_NEEDED | TASK | FYI | RECEIPT | NEWSLETTER | INTERNAL | AUTO
  - urgency: one of urgent | today | this_week | low
  - reason: a short phrase (≤ 10 words) explaining the category, in English

Category definitions:
  URGENT       — THIS user must act today. Time-sensitive ask directed at them.
  REPLY_NEEDED — Someone is asking THIS user a question or for a reply.
  TASK         — A clear action item delegated to THIS user (not just a question).
  FYI          — Informational only. THIS user is being kept in the loop but is not the doer.
  RECEIPT      — Invoices, payment confirmations, receipts, financial notices.
  NEWSLETTER   — Marketing, mass communication, generic broadcasts.
  INTERNAL     — From another Transform Iran staff member, low-key, no urgent ask of THIS user.
  AUTO         — System-generated (deploy notifications, account alerts, build errors).

═══════════════════════════════════════════════════════════════════════════════
CRITICAL RULES — recipient awareness (the difference between FYI and URGENT)
═══════════════════════════════════════════════════════════════════════════════

THIS user's email is: **${email}**${firstName ? ` (first name: **${firstName}**)` : ""}

1. **CC vs TO matters.** If the user is in CC but NOT in TO, the DEFAULT is FYI.
   They are being kept informed, not asked to act. ONLY upgrade to REPLY_NEEDED /
   URGENT / TASK if the BODY contains a direct ask of THIS user. Look for:
     - Their first name followed by a request: "${firstName || "Shahryar"}, can you..." / "${firstName || "Shahryar"} — please..."
     - An @-mention: "@${firstName || "Shahryar"}" / "@${name || "the user"}"
     - A sentence that references them by name with an action: "I need ${firstName || "Shahryar"} to confirm..."
   Without one of those signals, CC-only mail is FYI even if the sender is a VIP.

2. **Salutations are signals.** "Hi @first_recipient," / "Hi @both_TO_recipients,"
   / "Hi @team," explicitly addressed to the TO recipients reinforces that
   CC users are FYI. If the salutation names someone OTHER than this user,
   and this user is in CC, default to FYI.

3. **Read the body, not just the snippet.** A 1500-char body excerpt is provided.
   Even when the user is in TO, search the body for whether there's an actual
   ask, deadline, or decision needed FROM THEM — vs. just being a status update.

4. **Important-sender bias is conditional.** Each message has a
   'sender-in-important-list: YES/no' line. YES means the sender is in
   THIS user's personalized Important folders (e.g. Lana Silk, Lazarus
   Yeghnazar, Pia van Belen — but this list is per-user and editable).
   When that flag is YES:
     - If THIS user is in TO → bias toward URGENT / REPLY_NEEDED
     - If THIS user is ONLY in CC → bias toward FYI / INTERNAL (unless body has direct ask)
   Also treat donors who mention gifts as important regardless of the flag.

5. **Sender = THIS user.** If the From address is THIS user's own email, this is
   their own sent mail looped back (often through forwarding rules) — tag FYI
   with urgency=low.

Output ONLY a JSON array, no prose. Example:
[
  {"id":"abc123","category":"REPLY_NEEDED","urgency":"today","reason":"Pia asking about Tehran trip approval"},
  {"id":"def456","category":"FYI","urgency":"low","reason":"Lana CCs Shahryar on update to Anet+Lazarus"},
  {"id":"ghi789","category":"NEWSLETTER","urgency":"low","reason":"OpenAI billing newsletter"}
]
`.trim();
}

function buildBatchPrompt(messages, user, importantList) {
  const userEmail = (user?.email || "").trim().toLowerCase();
  const important = Array.isArray(importantList) ? importantList : [];
  const senderIsImportant = (fromHeader) => {
    if (!fromHeader || !important.length) return false;
    const raw = String(fromHeader).toLowerCase();
    return important.some((c) =>
      (c.email && raw.includes(c.email.toLowerCase())) ||
      (c.name && raw.includes(c.name.toLowerCase()))
    );
  };
  const lines = messages.map((m, i) => {
    const from = (m.from || "").slice(0, 200);
    const to = (m.to || "").slice(0, 400);
    const cc = (m.cc || "").slice(0, 400);
    const bcc = (m.bcc || "").slice(0, 400);
    const subj = (m.subject || "").slice(0, 200);
    const body = (m.bodyText || m.snippet || "").slice(0, 1500);

    // Tell the model explicitly where the user appears.
    const lowerAll = (to + " " + cc + " " + bcc).toLowerCase();
    let userIn = "NOT_LISTED";
    if (userEmail && to.toLowerCase().includes(userEmail))       userIn = "TO";
    else if (userEmail && cc.toLowerCase().includes(userEmail))  userIn = "CC";
    else if (userEmail && bcc.toLowerCase().includes(userEmail)) userIn = "BCC";
    else if (userEmail && lowerAll.includes(userEmail))          userIn = "OTHER";

    const importantFlag = senderIsImportant(from) ? "YES" : "no";
    return `[${i + 1}] id=${m.id}
   from: ${from}
   to: ${to || "(none)"}
   cc: ${cc || "(none)"}
   user-position: ${userIn}
   sender-in-important-list: ${importantFlag}
   subject: ${subj}
   body (first 1500 chars):
${body || "(empty)"}
---`;
  });
  return `Classify these ${messages.length} messages from the user's perspective:\n\n${lines.join("\n\n")}`;
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

async function classifyBatch(messages, user, importantList) {
  if (!messages.length) return [];
  const r = await client().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 1500,
    system: buildClassifySystem(user),
    messages: [{ role: "user", content: buildBatchPrompt(messages, user, importantList) }],
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
// `user` is the full user record ({ id, email, display_name }) so the
// classifier can be recipient-aware (FYI vs URGENT depends on whether THIS
// user is in TO vs CC, plus whether the body addresses them directly).
// `opts.force` re-classifies even if a row already exists (Re-classify button).
async function classifyForUser(user, messages, opts = {}) {
  if (!messages || !messages.length) return {};
  const userId = typeof user === "object" ? user.id : user;
  const userObj = typeof user === "object" ? user : { id: user };
  const ids = messages.map((m) => m.id);
  const existing = opts.force ? new Map() : await loadExisting(userId, ids);

  const todo = messages.filter((m) => !existing.has(m.id));
  const fresh = [];

  // Load the user's Important contacts once per request so per-batch calls
  // don't re-fetch. Used to mark sender-in-important-list in the prompt.
  let importantList = [];
  try {
    const importantContacts = require("./important_contacts");
    importantList = await importantContacts.list(userId);
  } catch (err) {
    console.warn("[classifier] loading important contacts failed:", err.message);
  }

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
        classifyBatch(b, userObj, importantList).catch((err) => {
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
