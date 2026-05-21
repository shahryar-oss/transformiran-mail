// Email classifier — Delta tags each inbox message into a category so the
// list can show what matters at a glance, with no chat command required.
// Cached per (user, message_id) in Postgres so we only pay once per email.

const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("./db");

const CLASSIFIER_MODEL = process.env.DELTA_CLASSIFY_MODEL || "claude-sonnet-4-6";
const BATCH_SIZE = 15;        // messages per Anthropic call
const CONCURRENCY = 5;        // parallel batches (was 3 — bumped for perf)
const BODY_CHARS = 800;       // chars of body per message (was 1500 — bumped down for perf)
const MAX_REASON_LEN = 80;

// Bump this any time the system prompt / rules change in a way that
// invalidates previous classifications. loadExisting() treats rows with
// prompt_version < CURRENT as missing → they re-classify automatically
// next time the inbox is loaded. No user-side "re-tag" click needed.
const CURRENT_PROMPT_VERSION = 3;   // Phase 5.AB — calendar-aware

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

// Format the next 48h of calendar events into a short string the model
// can use as context. Returns null if there are no events.
function formatCalendarContext(events) {
  if (!Array.isArray(events) || !events.length) return null;
  const now = Date.now();
  const upcoming = events
    .filter((ev) => ev.start && new Date(ev.start).getTime() >= now - 60 * 60 * 1000)
    .slice(0, 12);
  if (!upcoming.length) return null;
  return upcoming.map((ev) => {
    const dt = new Date(ev.start);
    const when = dt.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    const attendees = Array.isArray(ev.attendees)
      ? ev.attendees.map((a) => a.name || a.email).filter(Boolean).slice(0, 5).join(", ")
      : "";
    return `- ${when}: ${ev.summary || "(untitled)"}${attendees ? ` — with ${attendees}` : ""}`;
  }).join("\n");
}

function buildClassifySystem(user, calendarContext) {
  const name = (user?.display_name || "").trim();
  const email = (user?.email || "").trim().toLowerCase();
  const firstName = name.split(/\s+/)[0] || "";
  const calBlock = formatCalendarContext(calendarContext);
  const calSection = calBlock
    ? `\n\nUSER'S NEXT 48H CALENDAR (use to boost urgency):\n${calBlock}\n\nWhen an email is FROM or TO someone the user has a meeting with in the next 24h, bias toward URGENT / REPLY_NEEDED — it's probably meeting-related and time-pressured.`
    : "";
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

═══════════════════════════════════════════════════════════════════════════════
WORKED EXAMPLES — apply these patterns EXACTLY
═══════════════════════════════════════════════════════════════════════════════

EXAMPLE A — User in CC only, salutation addresses TO recipients → FYI

  from: Lana Silk <lana@transformiran.com>
  to: Anet Zohrabian <anet@...>, Lazarus Yeghnazar <lazarus@...>
  cc: Shahryar Tooraji <shahryar@...>
  user-position: CC
  sender-in-important-list: YES
  subject: 2x 100k gifts - instructions on usage and reporting
  body: "Hi both, We have had two significant gifts in the recent few weeks…
        @Anet Zohrabian please can you work with dad to keep a track of…"

  → CORRECT: { "category": "FYI", "urgency": "low", "reason": "Lana CCs user on instructions to Anet+Lazarus" }
  → WRONG (do NOT do this): { "category": "URGENT" }

  Why: salutation 'Hi both' addresses the two TO recipients explicitly.
  The only @-mention in the body is @Anet (not the user). The user is in
  CC. The 'sender-in-important-list: YES' flag is NOT enough — there must
  also be a direct ask of the user in the body. There isn't one here.

EXAMPLE B — User in TO, important sender, clear ask → URGENT/REPLY_NEEDED

  from: Pia van Belen <pia@...>
  to: Shahryar Tooraji <shahryar@...>
  user-position: TO
  sender-in-important-list: YES
  subject: Tehran trip — please approve before Friday
  body: "Shahryar, can you confirm the dates by Friday so we can book?"

  → CORRECT: { "category": "REPLY_NEEDED", "urgency": "today", "reason": "Pia asking user to confirm Tehran dates by Friday" }

EXAMPLE C — User in CC but direct address in body → REPLY_NEEDED

  from: Lana Silk <lana@...>
  to: Anet <anet@...>
  cc: Shahryar <shahryar@...>
  user-position: CC
  sender-in-important-list: YES
  body: "Anet, please send the receipts. Shahryar, can you double-check the
         OFAC paperwork on this one?"

  → CORRECT: { "category": "REPLY_NEEDED", "urgency": "today", "reason": "Lana asks user to double-check OFAC paperwork" }

  Why: even though user is only in CC, the body has a direct ask
  ('Shahryar, can you…') — that beats the CC-default.${calSection}

Output ONLY a JSON array, no prose. Example:
[
  {"id":"abc123","category":"REPLY_NEEDED","urgency":"today","reason":"Pia asking about Tehran trip approval"},
  {"id":"def456","category":"FYI","urgency":"low","reason":"Lana CCs Shahryar on update to Anet+Lazarus"},
  {"id":"ghi789","category":"NEWSLETTER","urgency":"low","reason":"OpenAI billing newsletter"}
]
`.trim();
}

function buildBatchPrompt(messages, user, importantList, calendarContext) {
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

  // Build a set of normalized email addresses the user is meeting with in
  // the next 24 hours — those senders get the meeting-today flag.
  const meetingEmails = new Set();
  if (Array.isArray(calendarContext)) {
    const cutoff = Date.now() + 24 * 60 * 60 * 1000;
    for (const ev of calendarContext) {
      if (!ev.start) continue;
      const ts = new Date(ev.start).getTime();
      if (ts > cutoff) continue;
      for (const a of (ev.attendees || [])) {
        if (a.email && !a.email.toLowerCase().includes(userEmail)) {
          meetingEmails.add(a.email.toLowerCase());
        }
      }
    }
  }
  const senderHasMeetingToday = (fromHeader) => {
    if (!fromHeader || !meetingEmails.size) return false;
    const m = String(fromHeader).match(/<([^>]+)>/);
    const email = (m ? m[1] : fromHeader).toLowerCase().trim();
    return meetingEmails.has(email);
  };
  const lines = messages.map((m, i) => {
    const from = (m.from || "").slice(0, 200);
    const to = (m.to || "").slice(0, 400);
    const cc = (m.cc || "").slice(0, 400);
    const bcc = (m.bcc || "").slice(0, 400);
    const subj = (m.subject || "").slice(0, 200);
    const body = (m.bodyText || m.snippet || "").slice(0, BODY_CHARS);

    // Tell the model explicitly where the user appears.
    const lowerAll = (to + " " + cc + " " + bcc).toLowerCase();
    let userIn = "NOT_LISTED";
    if (userEmail && to.toLowerCase().includes(userEmail))       userIn = "TO";
    else if (userEmail && cc.toLowerCase().includes(userEmail))  userIn = "CC";
    else if (userEmail && bcc.toLowerCase().includes(userEmail)) userIn = "BCC";
    else if (userEmail && lowerAll.includes(userEmail))          userIn = "OTHER";

    const importantFlag = senderIsImportant(from) ? "YES" : "no";
    const meetingFlag = senderHasMeetingToday(from) ? "YES" : "no";
    return `[${i + 1}] id=${m.id}
   from: ${from}
   to: ${to || "(none)"}
   cc: ${cc || "(none)"}
   user-position: ${userIn}
   sender-in-important-list: ${importantFlag}
   sender-has-meeting-with-user-in-24h: ${meetingFlag}
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

async function classifyBatch(messages, user, importantList, calendarContext) {
  if (!messages.length) return [];
  const r = await client().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 1500,
    system: buildClassifySystem(user, calendarContext),
    messages: [{ role: "user", content: buildBatchPrompt(messages, user, importantList, calendarContext) }],
  });
  const text = (r.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseClassifications(text);
}

// Returns existing classifications for a user keyed by message_id.
// EXCLUDES rows tagged under an old prompt version — those are treated as
// missing so they re-classify with the current rules. DONE rows are exempt
// because they're set by the live-sync / task-completion code paths, not
// the AI, so prompt-version-bumps shouldn't invalidate them.
async function loadExisting(userId, messageIds) {
  if (!messageIds.length) return new Map();
  const r = await pool.query(
    `SELECT message_id, category, urgency, short_reason, prompt_version
       FROM email_classifications
      WHERE user_id = $1 AND message_id = ANY($2::text[])
        AND (prompt_version >= $3 OR category = 'DONE')`,
    [userId, messageIds, CURRENT_PROMPT_VERSION]
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
  // Use multi-row UPSERT, stamping the current prompt version on every row
  // so future loadExisting() calls keep them until the rules change again.
  const values = [];
  const params = [];
  rows.forEach((c, i) => {
    const base = i * 6;
    params.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
    values.push(userId, c.id, c.category, c.urgency, c.reason, CURRENT_PROMPT_VERSION);
  });
  const sql = `
    INSERT INTO email_classifications
      (user_id, message_id, category, urgency, short_reason, prompt_version)
    VALUES ${params.join(",")}
    ON CONFLICT (user_id, message_id) DO UPDATE SET
      category       = EXCLUDED.category,
      urgency        = EXCLUDED.urgency,
      short_reason   = EXCLUDED.short_reason,
      prompt_version = EXCLUDED.prompt_version,
      classified_at  = NOW()
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

  // Phase 5.AB — Load today's + tomorrow's calendar events. Email from
  // someone the user is meeting today/tomorrow gets weighted up.
  let calendarContext = null;
  try {
    const calendarLib = require("./calendar");
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 2);  // today + tomorrow
    const events = await calendarLib.listEvents(userId, {
      start: start.toISOString(),
      end: end.toISOString(),
      calendarIds: null,
    });
    calendarContext = events;
  } catch (err) {
    console.warn("[classifier] calendar context fetch failed:", err.message);
  }

  // Run batches in parallel for snappier UX. Cap at 3 concurrent to be
  // gentle on the rate limiter.
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    batches.push(todo.slice(i, i + BATCH_SIZE));
  }
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map((b) =>
        classifyBatch(b, userObj, importantList, calendarContext).catch((err) => {
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
