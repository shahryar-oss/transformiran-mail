// Morning briefing — Phase 5.AD.
//
// Once per day per user, Delta synthesizes:
//   - overnight inbox (last 24h)
//   - today's calendar
//   - open tasks (overdue + due-today)
//   - the user's identity + important contacts + relevant memories
// into a structured brief: headline / priorities / calendar / tasks /
// 3 pre-drafted top-priority replies.
//
// Generation is lazy: the API endpoint /api/briefing/today returns
// today's brief if cached, otherwise generates it on-the-fly. A small
// background worker also pre-warms briefings between 04:00–09:00 UTC
// so morning visits hit cached.
//
// Each (user, briefing_date) is unique. The briefing JSON is stored
// in `brief_json` so we don't regenerate when the user re-opens the
// chat panel. `dismissed_at` is set when user clicks Dismiss.

const { pool } = require("./db");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");
const calendarLib = require("./calendar");
const memory = require("./memory");
const importantContacts = require("./important_contacts");
const mime = require("./mime");

const MODEL = process.env.DELTA_BRIEFING_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 2200;

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS morning_briefings (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      briefing_date   DATE NOT NULL,
      generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      shown_at        TIMESTAMPTZ,
      dismissed_at    TIMESTAMPTZ,
      brief_json      JSONB NOT NULL,
      model_used      TEXT,
      input_tokens    INT,
      output_tokens   INT,
      UNIQUE (user_id, briefing_date)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_morning_briefings_user_date
      ON morning_briefings(user_id, briefing_date DESC);
  `);
}

// ---------------------------------------------------------------------------
// CONTEXT COLLECTION
// ---------------------------------------------------------------------------

function todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Pull the most recent inbox messages with bodies — Delta needs body content
// to draft replies. Uses the inbox_cache for the list, then live Gmail for
// each message's body (24 max, parallel, ~3s).
async function collectInbox(userId, limitMessages = 20) {
  try {
    const creds = await loadGoogleCreds(userId);
    if (!creds) return [];
    const oauth = authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: oauth });

    // Use Gmail directly for the freshest list — briefing runs once a day
    // so the cost of a fresh fetch is fine.
    const list = await g.users.messages.list({
      userId: "me",
      maxResults: limitMessages,
      labelIds: ["INBOX"],
    });
    const ids = (list.data.messages || []).map((m) => m.id);
    if (!ids.length) return [];

    // Fetch in parallel chunks of 8 for body content.
    const out = [];
    const CHUNK = 8;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const fetches = await Promise.all(
        slice.map((id) =>
          g.users.messages
            .get({ userId: "me", id, format: "full" })
            .then((r) => r.data)
            .catch(() => null)
        )
      );
      for (const m of fetches) {
        if (!m) continue;
        const headers = mime.headersToMap(m.payload?.headers || []);
        const body = mime.pickBody(m.payload);
        const bodyText = (body.text || mime.htmlToText(body.html || "") || "").slice(0, 1500);
        out.push({
          id: m.id,
          threadId: m.threadId,
          from: headers.from || "",
          to: headers.to || "",
          cc: headers.cc || "",
          subject: headers.subject || "(no subject)",
          date: headers.date || "",
          snippet: m.snippet || "",
          bodyText,
          unread: (m.labelIds || []).includes("UNREAD"),
          labelIds: m.labelIds || [],
        });
      }
    }
    return out;
  } catch (err) {
    console.warn("[briefing] collectInbox failed:", err.message);
    return [];
  }
}

async function collectCalendar(userId) {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);   // today only — keep it focused
    return await calendarLib.listEvents(userId, {
      start: start.toISOString(),
      end: end.toISOString(),
      calendarIds: null,
    });
  } catch (err) {
    console.warn("[briefing] collectCalendar failed:", err.message);
    return [];
  }
}

async function collectTasks(userId) {
  // Overdue + due-today + my-day
  const r = await pool.query(
    `SELECT id, title, due_at, reminder_at, important, in_my_day,
            source_message_id, completed_at
       FROM tasks
      WHERE user_id = $1
        AND completed_at IS NULL
        AND (
          (due_at IS NOT NULL AND due_at <= NOW() + INTERVAL '24 hours')
          OR in_my_day = TRUE
          OR important = TRUE
        )
      ORDER BY
        (due_at IS NOT NULL AND due_at < NOW()) DESC,    -- overdue first
        important DESC,
        due_at ASC NULLS LAST
      LIMIT 12`,
    [userId]
  );
  return r.rows;
}

// Phase 5.AK — Open + overdue commitments for the morning brief.
// Overdue go in first (most urgent), then open with due_at ≤ +48h.
async function collectCommitments(userId) {
  try {
    const commitments = require("./commitments");
    const open = await commitments.listOpen(userId, { limit: 20 });
    const overdue = open.filter((c) => c.is_overdue);
    const dueSoon = open.filter((c) => !c.is_overdue && c.due_at
      && new Date(c.due_at).getTime() - Date.now() < 48 * 3600 * 1000);
    const noDeadline = open.filter((c) => !c.is_overdue && !c.due_at);
    return { overdue, dueSoon, noDeadline, totalOpen: open.length };
  } catch (err) {
    console.warn("[briefing] collectCommitments failed:", err.message);
    return { overdue: [], dueSoon: [], noDeadline: [], totalOpen: 0 };
  }
}

async function collectMemories(userId) {
  // Just the most-recent 40 memories, by recency. They give Delta voice +
  // context without overwhelming the prompt.
  const r = await pool.query(
    `SELECT subject, category, fact
       FROM delta_memory
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 40`,
    [userId]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// PROMPT BUILDING
// ---------------------------------------------------------------------------

function formatInbox(messages, userEmail) {
  if (!messages.length) return "(inbox is empty)";
  return messages.map((m, i) => {
    const inTo  = m.to.toLowerCase().includes(userEmail) ? "TO" : "";
    const inCc  = m.cc.toLowerCase().includes(userEmail) ? "CC" : "";
    const userPos = inTo || inCc || "OTHER";
    return `[#${i + 1}] id=${m.id}
   from: ${m.from}
   to: ${m.to || "(none)"}
   cc: ${m.cc || "(none)"}
   user-position: ${userPos}
   unread: ${m.unread ? "YES" : "no"}
   subject: ${m.subject}
   body: ${(m.bodyText || m.snippet).slice(0, 900)}`;
  }).join("\n\n");
}

function formatCalendar(events) {
  if (!events.length) return "(nothing scheduled)";
  return events.slice(0, 12).map((ev) => {
    const dt = new Date(ev.start);
    const when = ev.allDay ? "All day" : dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const attendees = (ev.attendees || []).map((a) => a.name || a.email).filter(Boolean).slice(0, 4).join(", ");
    return `- ${when}: ${ev.summary || "(untitled)"}${attendees ? ` — with ${attendees}` : ""}${ev.location ? ` @ ${ev.location}` : ""}`;
  }).join("\n");
}

function formatTasks(tasks) {
  if (!tasks.length) return "(no open priority tasks)";
  const now = Date.now();
  return tasks.map((t) => {
    const dueLabel = t.due_at
      ? new Date(t.due_at) < now
        ? `OVERDUE since ${new Date(t.due_at).toLocaleDateString()}`
        : `due ${new Date(t.due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
      : (t.in_my_day ? "in My Day" : "no due date");
    return `- ${t.important ? "★ " : ""}${t.title} (${dueLabel})`;
  }).join("\n");
}

function formatCommitments(c) {
  if (!c || !c.totalOpen) return "(no open commitments — clean slate)";
  const lines = [];
  if (c.overdue.length) {
    lines.push("OVERDUE:");
    for (const x of c.overdue) {
      const days = Math.max(1, Math.round((Date.now() - new Date(x.due_at).getTime()) / 86400000));
      lines.push(`  - ${x.commitment_text} → ${x.recipient_name || x.recipient_email || "someone"} (overdue ${days}d, said "${x.due_text || 'with deadline'}")`);
    }
  }
  if (c.dueSoon.length) {
    lines.push("DUE WITHIN 48H:");
    for (const x of c.dueSoon) {
      const when = new Date(x.due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      lines.push(`  - ${x.commitment_text} → ${x.recipient_name || x.recipient_email || "someone"} (${when}, said "${x.due_text || ''}")`);
    }
  }
  if (c.noDeadline.length) {
    lines.push("OPEN (no fixed deadline):");
    for (const x of c.noDeadline.slice(0, 4)) {
      lines.push(`  - ${x.commitment_text} → ${x.recipient_name || x.recipient_email || "someone"}`);
    }
    if (c.noDeadline.length > 4) lines.push(`  …and ${c.noDeadline.length - 4} more`);
  }
  return lines.join("\n");
}

function formatMemories(memories) {
  if (!memories.length) return "";
  return memories.map((m) => `- ${m.subject}${m.category ? ` (${m.category})` : ""}: ${m.fact}`).join("\n");
}

function formatImportant(contacts) {
  if (!contacts.length) return "";
  return contacts.map((c) => `${c.name} (${c.email})`).join(", ");
}

function buildPrompt(user, ctx) {
  const userEmail = (user.email || "").toLowerCase();
  const firstName = (user.display_name || "").trim().split(/\s+/)[0] || "there";
  const today = new Date();
  const dayName = today.toLocaleDateString(undefined, { weekday: "long" });
  const dateLong = today.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  return `You are Delta, ${firstName}'s AI Executive Assistant at Transform Iran.
Today is **${dayName}, ${dateLong}**. Generate ${firstName}'s morning briefing.

The briefing should feel like a great human EA's verbal handoff — direct, prioritized, no fluff. Brief but with substance.

==========================================
INBOX (last ~20 unread / recent messages)
==========================================
${formatInbox(ctx.inbox, userEmail)}

==========================================
TODAY'S CALENDAR
==========================================
${formatCalendar(ctx.calendar)}

==========================================
OPEN PRIORITY TASKS
==========================================
${formatTasks(ctx.tasks)}

==========================================
YOUR OPEN COMMITMENTS (promises you've made)
==========================================
${formatCommitments(ctx.commitments)}

==========================================
KEY PEOPLE (${firstName}'s Important list)
==========================================
${formatImportant(ctx.importantList)}

==========================================
WHAT DELTA REMEMBERS (relevant facts)
==========================================
${formatMemories(ctx.memories)}

==========================================
YOUR JOB
==========================================
Return ONLY a JSON object with this exact structure:

{
  "headline": "One sentence describing the shape of today (10-15 words).",
  "priorities": [
    "Sentence 1 — the single most important thing.",
    "Sentence 2 — the next thing.",
    "Sentence 3 — optional third"
  ],
  "calendar_summary": "1-2 sentences. Skip if calendar is empty.",
  "tasks_summary": "1 sentence. Mention overdue if any.",
  "commitments_summary": "1-2 sentences IF any commitments are overdue or due within 48h. Mention by name + recipient (e.g. 'You owe Simon the VPN budget by EOD; Lana the staff list since Tuesday.'). Skip entirely if no urgent commitments.",
  "top_replies": [
    {
      "message_id": "the gmail message id from the inbox above",
      "sender_name": "Lana Silk",
      "subject": "subject of the email",
      "why_priority": "One short phrase on why this needs a reply now (e.g., 'she asked for sign-off by EOD')",
      "draft": "A complete, ready-to-send reply in ${firstName}'s voice. Match his tone. No greeting fluff like 'I hope this email finds you well'. Direct, warm, signed with his first letter or name. 3-6 sentences typical."
    }
  ]
}

Rules:
- "top_replies" should have 2-3 entries: ONLY emails that genuinely need ${firstName}'s reply today. Skip newsletters, FYIs, anything where someone else is the doer.
- Use REAL message_ids from the inbox above. Never invent.
- Each draft should be sendable as-is. Don't write "Dear X" if he never does. Don't add "Best regards" if his memory says he signs as "S".
- If nothing in the inbox needs a reply, "top_replies" can be empty.
- Tone for headline + priorities: terse, like a great EA whispering before a meeting.
- NEVER use em-dashes ("—") or en-dashes ("–") in any field. The user has banned them as an AI tell. Use commas, periods, parentheses, or colons instead. Reread before returning and rewrite any sentence that contains "—" or "–". Plain hyphen-minus "-" is fine for compound modifiers ("year-end", "follow-up") but not as a clause separator.
- Output ONLY the JSON. No prose around it. No code fences.`;
}

// ---------------------------------------------------------------------------
// GENERATE
// ---------------------------------------------------------------------------

// Strip em-dashes and en-dashes from generated text. The user banned
// them as an AI tell. Local copy so this module doesn't take a new
// dependency.
function scrubDashes(text) {
  if (!text) return text;
  let s = String(text).replace(/–/g, "—");
  s = s.replace(/\s*—\s*(\n|$)/g, ".$1");
  s = s.replace(/\s+—\s+/g, ", ");
  s = s.replace(/—\s+/g, ", ");
  s = s.replace(/\s+—/g, ",");
  s = s.replace(/(\S)—(\S)/g, "$1, $2");
  s = s.replace(/—/g, ", ");
  s = s.replace(/,\s*\./g, ".");
  s = s.replace(/\.\s*,\s*/g, ". ");
  s = s.replace(/,\s*,/g, ",");
  return s;
}

function parseBriefing(text) {
  let body = (text || "").trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const firstBrace = body.indexOf("{");
  const lastBrace = body.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) throw new Error("no_json_object");
  body = body.slice(firstBrace, lastBrace + 1);
  const parsed = JSON.parse(body);

  // Scrub em/en-dashes from every user-facing string the model
  // produced. The morning briefing card renders these straight to
  // screen + TTS reads them aloud, so we don't want dashes leaking
  // anywhere.
  if (typeof parsed.headline === "string") parsed.headline = scrubDashes(parsed.headline);
  if (Array.isArray(parsed.priorities)) parsed.priorities = parsed.priorities.map((p) => typeof p === "string" ? scrubDashes(p) : p);
  if (typeof parsed.calendar_summary === "string") parsed.calendar_summary = scrubDashes(parsed.calendar_summary);
  if (typeof parsed.tasks_summary === "string") parsed.tasks_summary = scrubDashes(parsed.tasks_summary);
  if (typeof parsed.commitments_summary === "string") parsed.commitments_summary = scrubDashes(parsed.commitments_summary);
  if (Array.isArray(parsed.top_replies)) {
    parsed.top_replies = parsed.top_replies.map((r) => ({
      ...r,
      why_priority: typeof r.why_priority === "string" ? scrubDashes(r.why_priority) : r.why_priority,
      draft: typeof r.draft === "string" ? scrubDashes(r.draft) : r.draft,
    }));
  }
  return parsed;
}

async function generateForUser(user) {
  const [inbox, calendar, tasks, importantList, memories, commitmentsCtx] = await Promise.all([
    collectInbox(user.id),
    collectCalendar(user.id),
    collectTasks(user.id),
    importantContacts.list(user.id).catch(() => []),
    collectMemories(user.id),
    collectCommitments(user.id),
  ]);

  const prompt = buildPrompt(user, { inbox, calendar, tasks, importantList, memories, commitments: commitmentsCtx });

  const r = await client().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  let brief;
  try {
    brief = parseBriefing(text);
  } catch (err) {
    console.warn("[briefing] parse failed:", err.message);
    throw err;
  }

  // Persist (UPSERT — one row per user per calendar day).
  const briefingDate = todayDateKey();
  const row = await pool.query(
    `INSERT INTO morning_briefings
       (user_id, briefing_date, brief_json, model_used, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, briefing_date) DO UPDATE SET
       brief_json    = EXCLUDED.brief_json,
       generated_at  = NOW(),
       model_used    = EXCLUDED.model_used,
       input_tokens  = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens
     RETURNING id, briefing_date, generated_at, shown_at, dismissed_at, brief_json`,
    [
      user.id,
      briefingDate,
      JSON.stringify(brief),
      MODEL,
      r.usage?.input_tokens || null,
      r.usage?.output_tokens || null,
    ]
  );
  return row.rows[0];
}

// Return today's briefing, generating it if missing. Used by the
// /api/briefing/today endpoint.
async function getTodayForUser(user, { allowGenerate = true } = {}) {
  const briefingDate = todayDateKey();
  const existing = await pool.query(
    `SELECT id, briefing_date, generated_at, shown_at, dismissed_at, brief_json
       FROM morning_briefings
      WHERE user_id = $1 AND briefing_date = $2`,
    [user.id, briefingDate]
  );
  if (existing.rows[0]) return existing.rows[0];
  if (!allowGenerate) return null;
  return await generateForUser(user);
}

async function markShown(userId) {
  await pool.query(
    `UPDATE morning_briefings SET shown_at = COALESCE(shown_at, NOW())
      WHERE user_id = $1 AND briefing_date = $2`,
    [userId, todayDateKey()]
  );
}

async function markDismissed(userId) {
  await pool.query(
    `UPDATE morning_briefings SET dismissed_at = NOW()
      WHERE user_id = $1 AND briefing_date = $2`,
    [userId, todayDateKey()]
  );
}

// For the worker — find users who haven't gotten today's brief yet.
async function listUsersNeedingBrief({ limit = 5 } = {}) {
  const today = todayDateKey();
  const r = await pool.query(
    `SELECT u.id, u.email, u.display_name
       FROM users u
      WHERE u.welcomed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM morning_briefings b
           WHERE b.user_id = u.id AND b.briefing_date = $1
        )
      LIMIT $2`,
    [today, limit]
  );
  return r.rows;
}

module.exports = {
  ensureSchema,
  generateForUser,
  getTodayForUser,
  markShown,
  markDismissed,
  listUsersNeedingBrief,
  todayDateKey,
};
