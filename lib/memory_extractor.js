// Nightly memory-extraction pass. Once per user per day, looks at the
// last 24h of activity (sent emails + chat turns + completed tasks) and
// asks Claude to surface durable observations worth remembering.
//
// Stored as memories with source = 'auto-nightly' so the user can see
// provenance in /settings/memory and delete anything wrong. Strict
// guardrails: at most 5 new memories per night, must be specific,
// must not duplicate existing memories.

const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("./db");
const memory = require("./memory");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");
const mime = require("./mime");

const EXTRACTOR_MODEL = process.env.DELTA_EXTRACTOR_MODEL || "claude-sonnet-4-6";

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Per-user state — when did we last run the nightly pass?
// Stored as a row per user in memory_extractor_runs so restarts don't
// re-trigger and concurrent workers don't double up.
// ---------------------------------------------------------------------------
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_extractor_runs (
      user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_run_at   TIMESTAMPTZ,
      last_status   TEXT,
      last_added    INT DEFAULT 0,
      last_error    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function lastRunFor(userId) {
  const r = await pool.query(
    `SELECT last_run_at FROM memory_extractor_runs WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0]?.last_run_at || null;
}

async function recordRun(userId, { added, error }) {
  await pool.query(
    `INSERT INTO memory_extractor_runs (user_id, last_run_at, last_status, last_added, last_error)
     VALUES ($1, NOW(), $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       last_run_at = NOW(),
       last_status = EXCLUDED.last_status,
       last_added  = EXCLUDED.last_added,
       last_error  = EXCLUDED.last_error`,
    [userId, error ? "error" : "ok", added || 0, error ? String(error).slice(0, 500) : null]
  );
}

// ---------------------------------------------------------------------------
// Activity collection — what to feed the model
// ---------------------------------------------------------------------------

// Last 24h of sent emails (subject + first 600 chars of body) — gives the
// model signal about who the user talks to, in what tone, about what topics.
async function fetchRecentSent(userId, hours = 24) {
  try {
    const creds = await loadGoogleCreds(userId);
    if (!creds) return [];
    const oauth = authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: oauth });
    const list = await g.users.messages.list({
      userId: "me",
      maxResults: 25,
      q: `in:sent newer_than:${Math.max(1, Math.ceil(hours / 24))}d`,
    });
    const ids = (list.data.messages || []).map((m) => m.id);
    if (!ids.length) return [];
    const fetches = ids.slice(0, 25).map((id) =>
      g.users.messages
        .get({ userId: "me", id, format: "full" })
        .then((r) => r.data)
        .catch(() => null)
    );
    const messages = (await Promise.all(fetches)).filter(Boolean);
    return messages.map((m) => {
      const headers = mime.headersToMap(m.payload?.headers || []);
      const body = mime.pickBody(m.payload);
      const bodyText = (body.text || mime.htmlToText(body.html || "") || "").slice(0, 600);
      return {
        to: headers.to || "",
        subject: headers.subject || "",
        date: headers.date || "",
        bodyText,
      };
    });
  } catch (err) {
    console.warn(`[memory_extractor] fetchRecentSent failed for user ${userId}:`, err.message);
    return [];
  }
}

// Recently completed tasks — signals what the user actually finishes and
// what kinds of action items recur. Skip if no tasks table activity.
async function fetchRecentCompletedTasks(userId, hours = 48) {
  const r = await pool.query(
    `SELECT title, completed_at, source_message_id
       FROM tasks
      WHERE user_id = $1
        AND completed_at IS NOT NULL
        AND completed_at > NOW() - ($2 || ' hours')::INTERVAL
      ORDER BY completed_at DESC
      LIMIT 15`,
    [userId, String(hours)]
  );
  return r.rows;
}

// Last ~30 memories we already have — so the model knows what NOT to
// duplicate. We don't pull the whole history (could be huge for power users).
async function fetchExistingMemorySummary(userId) {
  const r = await pool.query(
    `SELECT subject, category, fact
       FROM delta_memory
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 30`,
    [userId]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Extraction prompt + parser
// ---------------------------------------------------------------------------

function buildExtractorPrompt(user, sent, completedTasks, existing) {
  const userBlock = `THE USER:
- Name: ${user.display_name || user.email}
- Email: ${user.email}`;

  const sentBlock = sent.length
    ? sent.slice(0, 25).map((m, i) =>
        `[${i + 1}] to: ${m.to}\n    subject: ${m.subject}\n    body: ${m.bodyText.slice(0, 500)}`
      ).join("\n\n")
    : "(no recent sent emails)";

  const tasksBlock = completedTasks.length
    ? completedTasks.map((t) => `- ${t.title}`).join("\n")
    : "(no recently completed tasks)";

  const existingBlock = existing.length
    ? existing.map((m) => `- ${m.subject}${m.category ? ` (${m.category})` : ""}: ${m.fact}`).join("\n")
    : "(no existing memories — first run)";

  return `${userBlock}

You're reviewing the last ~24 hours of this user's activity to surface DURABLE OBSERVATIONS worth remembering for next time.

RECENT SENT EMAILS (last 24h)
${sentBlock}

RECENTLY COMPLETED TASKS (last 48h)
${tasksBlock}

EXISTING MEMORIES (do NOT duplicate any of these)
${existingBlock}

Your job: surface 0–5 NEW durable observations. Hard rules:
- Save only stable, recurring patterns or stated preferences — not one-off events.
- Save only specific facts — "user is busy" is fluff and not allowed.
- Do NOT duplicate existing memories above (different wording counts as duplicate).
- If you have nothing strong to add, return an empty array. Quantity is not the goal.

Output ONLY a JSON array. Each item has:
  - subject:   person's name (e.g. "Pia van Belen"), or "self" for facts about the user, or "general"
  - subject_email: optional email address if the subject is a person and you know it
  - category:  one of preference | birthday | fact | context | sensitivity | language | role
  - fact:      one specific observation, concise English

Examples of GOOD observations:
  {"subject":"self","category":"preference","fact":"Replies in Farsi when emailing Lazarus or Maggie"}
  {"subject":"Pia van Belen","category":"role","fact":"Handles Tehran trip logistics — book travel through her"}
  {"subject":"self","category":"preference","fact":"Closes out tasks the same day they're created — avoid leaving items overnight"}

Examples of BAD (do not save):
  {"subject":"self","fact":"User is busy"} — fluffy
  {"subject":"Pia","fact":"Pia sent an email about Tehran"} — one-off, not a pattern
  {"subject":"Lana","fact":"Lana is CEO"} — likely already in memory

Output ONLY the JSON array, no prose.`;
}

function parseExtractorOutput(text) {
  let body = (text || "").trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const firstBracket = body.indexOf("[");
  const lastBracket = body.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1) return [];
  body = body.slice(firstBracket, lastBracket + 1);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((m) => m && m.subject && m.fact).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function runForUser(user) {
  try {
    const userId = user.id;

    // Skip if we already ran in the last 20h — guards against duplicate
    // runs from scheduler overlap or server restarts.
    const last = await lastRunFor(userId);
    if (last && Date.now() - new Date(last).getTime() < 20 * 60 * 60 * 1000) {
      return { skipped: true, reason: "ran_recently" };
    }

    const [sent, completedTasks, existing] = await Promise.all([
      fetchRecentSent(userId, 24),
      fetchRecentCompletedTasks(userId, 48),
      fetchExistingMemorySummary(userId),
    ]);

    // Skip if there's nothing to learn from
    if (!sent.length && !completedTasks.length) {
      await recordRun(userId, { added: 0 });
      return { skipped: true, reason: "no_activity" };
    }

    const prompt = buildExtractorPrompt(user, sent, completedTasks, existing);
    const r = await client().messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const observations = parseExtractorOutput(text);

    let added = 0;
    for (const obs of observations) {
      try {
        await memory.add(userId, {
          subject: obs.subject,
          subject_email: obs.subject_email || null,
          category: obs.category || null,
          fact: obs.fact,
          source: "auto-nightly",
        });
        added++;
      } catch (err) {
        console.warn(`[memory_extractor] add failed for user ${userId}:`, err.message);
      }
    }

    await recordRun(userId, { added });
    console.log(`[memory_extractor] user ${userId} (${user.email}) — added ${added} observations`);
    return { added, observations };
  } catch (err) {
    console.error(`[memory_extractor] runForUser ${user?.id} failed:`, err);
    try {
      await recordRun(user.id, { added: 0, error: err.message });
    } catch (_) {}
    return { error: err.message };
  }
}

// Find users due for a nightly run (haven't run in 20h+, have welcomed_at set).
async function listDueUsers() {
  const r = await pool.query(
    `SELECT u.id, u.email, u.display_name
       FROM users u
       LEFT JOIN memory_extractor_runs r ON r.user_id = u.id
      WHERE u.welcomed_at IS NOT NULL
        AND (r.last_run_at IS NULL OR r.last_run_at < NOW() - INTERVAL '20 hours')
      LIMIT 5`
  );
  return r.rows;
}

module.exports = { ensureSchema, runForUser, listDueUsers };
