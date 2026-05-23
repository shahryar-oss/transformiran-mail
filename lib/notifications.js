// ============================================================================
// lib/notifications.js  —  Phase 5.BB
//
// Single endpoint that aggregates "things you should know about right now"
// from the existing per-feature stores:
//
//   1. Overdue promises          (delta_commitments where due_at < NOW)
//   2. Due-soon tasks            (tasks where due_at in next 24h)
//   3. Overdue tasks             (tasks where due_at < NOW and not done)
//   4. Important unread emails   (inbox_cache where is_important AND unread)
//
// The notifications themselves aren't persisted — they're recomputed on
// each fetch. We only persist:
//   • notification_dismissals  — what the user has cleared
//   • notification_state       — last_seen_at, for the unread badge
//
// Every notification carries a `link` object that tells the client where
// to navigate on click:
//   { type: "email", message_id }   → open the email in the reader
//   { type: "promises" }            → open /promises
//   { type: "tasks" }               → open /tasks
// ============================================================================

const { pool } = require("./db");

// How far ahead to look for "due-soon" tasks.
const DUE_SOON_HOURS = 24;
// How long to keep a "fulfilled / removed" notification visible after the
// underlying item disappears. Right now we just don't bring them back —
// dismissals are sticky by design.

async function getDismissedKeys(userId) {
  const r = await pool.query(
    `SELECT dismiss_key FROM notification_dismissals WHERE user_id = $1`,
    [userId]
  );
  return new Set(r.rows.map((x) => x.dismiss_key));
}

async function getLastSeen(userId) {
  const r = await pool.query(
    `SELECT last_seen_at FROM notification_state WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0]?.last_seen_at || null;
}

async function setLastSeen(userId) {
  await pool.query(
    `INSERT INTO notification_state (user_id, last_seen_at)
       VALUES ($1, NOW())
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = NOW()`,
    [userId]
  );
}

async function dismiss(userId, key) {
  if (!key) return { ok: false, error: "no_key" };
  await pool.query(
    `INSERT INTO notification_dismissals (user_id, dismiss_key)
       VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, key]
  );
  return { ok: true };
}

async function dismissAll(userId) {
  // Mark every CURRENTLY-active notification as dismissed. Convenient for
  // the "Clear all" button in the dropdown.
  const list = await listForUser(userId);
  for (const n of list.notifications) {
    await pool.query(
      `INSERT INTO notification_dismissals (user_id, dismiss_key)
         VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, n.id]
    );
  }
  return { ok: true, count: list.notifications.length };
}

// ---------------------------------------------------------------------------
// Source: overdue promises
// ---------------------------------------------------------------------------
async function fetchOverduePromises(userId) {
  const r = await pool.query(
    `SELECT id, source_message_id, source_thread_id,
            recipient_email, recipient_name,
            commitment_text, due_text, due_at, created_at,
            EXTRACT(EPOCH FROM (NOW() - due_at))::int AS overdue_seconds
       FROM delta_commitments
      WHERE user_id = $1
        AND status = 'open'
        AND due_at IS NOT NULL
        AND due_at < NOW()
      ORDER BY due_at ASC
      LIMIT 50`,
    [userId]
  );
  return r.rows.map((row) => {
    const recipient = row.recipient_name || row.recipient_email || "someone";
    const days = Math.round(row.overdue_seconds / 86400);
    const human =
      days === 0 ? "due today" :
      days === 1 ? "1 day overdue" :
      `${days} days overdue`;
    return {
      id: `promise-overdue:${row.id}`,
      kind: "promise-overdue",
      severity: days >= 3 ? "high" : "medium",
      title: `Overdue promise to ${recipient}`,
      body: row.commitment_text,
      meta: row.due_text ? `Said: "${row.due_text}" — ${human}` : human,
      created_at: row.created_at,
      link: row.source_message_id
        ? { type: "email", message_id: row.source_message_id, thread_id: row.source_thread_id }
        : { type: "promises" },
    };
  });
}

// ---------------------------------------------------------------------------
// Source: tasks due in the next 24h or already overdue
// ---------------------------------------------------------------------------
async function fetchDueTasks(userId) {
  const r = await pool.query(
    `SELECT t.id, t.title, l.name AS list_name, t.due_at, t.source_message_id,
            CASE WHEN t.due_at < NOW() THEN TRUE ELSE FALSE END AS is_overdue
       FROM tasks t
       LEFT JOIN task_lists l ON l.id = t.list_id
      WHERE t.user_id = $1
        AND t.completed_at IS NULL
        AND t.due_at IS NOT NULL
        AND t.due_at < NOW() + INTERVAL '${DUE_SOON_HOURS} hours'
      ORDER BY t.due_at ASC
      LIMIT 50`,
    [userId]
  );
  return r.rows.map((row) => {
    const due = new Date(row.due_at);
    const now = Date.now();
    const diffMin = Math.round((due.getTime() - now) / 60000);
    let when;
    if (row.is_overdue) {
      const overdueMin = -diffMin;
      if (overdueMin < 60) when = `${overdueMin} min overdue`;
      else if (overdueMin < 1440) when = `${Math.round(overdueMin / 60)} hr overdue`;
      else when = `${Math.round(overdueMin / 1440)} day overdue`;
    } else {
      if (diffMin < 60) when = `due in ${diffMin} min`;
      else if (diffMin < 1440) when = `due in ${Math.round(diffMin / 60)} hr`;
      else when = `due tomorrow`;
    }
    return {
      id: `task-${row.is_overdue ? "overdue" : "due-soon"}:${row.id}`,
      kind: row.is_overdue ? "task-overdue" : "task-due-soon",
      severity: row.is_overdue ? "high" : "medium",
      title: row.title,
      body: row.list_name ? `In list: ${row.list_name}` : "",
      meta: when,
      created_at: row.due_at,
      link: row.source_message_id
        ? { type: "email", message_id: row.source_message_id }
        : { type: "tasks" },
    };
  });
}

// ---------------------------------------------------------------------------
// Source: unread emails from Important folder members
// (Phase 5.AK introduced per-user editable Important list; for now we
// just surface unread mail from anyone whose email matches.)
// ---------------------------------------------------------------------------
async function fetchImportantUnread(userId) {
  // Table `important_contacts` (Phase 5.AK — replaced old VIP list).
  let importantEmails;
  try {
    const r = await pool.query(
      `SELECT lower(email) AS email_lower FROM important_contacts WHERE user_id = $1`,
      [userId]
    );
    importantEmails = r.rows.map((x) => x.email_lower);
  } catch (_) {
    return [];
  }
  if (!importantEmails.length) return [];

  // Find unread inbox messages whose from_header contains one of these.
  // We do a simple ILIKE per email — there's usually only 5-15 important
  // senders, so this stays cheap.
  const placeholders = importantEmails.map((_, i) => `lower(from_header) LIKE $${i + 2}`).join(" OR ");
  const params = [userId, ...importantEmails.map((e) => `%${e}%`)];
  const r2 = await pool.query(
    `SELECT message_id, thread_id, from_header, subject, internal_date
       FROM inbox_cache
      WHERE user_id = $1
        AND in_inbox = TRUE
        AND is_unread = TRUE
        AND (${placeholders})
      ORDER BY internal_date DESC NULLS LAST
      LIMIT 20`,
    params
  );
  return r2.rows.map((row) => {
    const senderName = parseSenderName(row.from_header);
    return {
      id: `important-unread:${row.message_id}`,
      kind: "important-unread",
      severity: "medium",
      title: `${senderName} sent you mail`,
      body: row.subject || "(no subject)",
      meta: "Important sender",
      created_at: row.internal_date ? new Date(Number(row.internal_date)).toISOString() : null,
      link: { type: "email", message_id: row.message_id, thread_id: row.thread_id },
    };
  });
}

function parseSenderName(from) {
  if (!from) return "Someone";
  const m = String(from).match(/^"?([^"<]+)"?\s*</);
  if (m) return m[1].trim();
  return from.trim();
}

// ---------------------------------------------------------------------------
// Main: aggregate everything, filter dismissed, sort by severity+time
// ---------------------------------------------------------------------------
async function listForUser(userId) {
  const [promises, tasks, important, dismissed, lastSeen] = await Promise.all([
    fetchOverduePromises(userId).catch((err) => { console.warn("[notif] promises:", err.message); return []; }),
    fetchDueTasks(userId).catch((err) => { console.warn("[notif] tasks:", err.message); return []; }),
    fetchImportantUnread(userId).catch((err) => { console.warn("[notif] important:", err.message); return []; }),
    getDismissedKeys(userId),
    getLastSeen(userId),
  ]);

  const all = [...promises, ...tasks, ...important].filter((n) => !dismissed.has(n.id));

  // Sort: high severity first, then by created_at descending (most recent first).
  const sevRank = (s) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
  all.sort((a, b) => {
    const r = sevRank(a.severity) - sevRank(b.severity);
    if (r !== 0) return r;
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bt - at;
  });

  // Unread count: items created AFTER last_seen_at.
  const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : 0;
  const unreadCount = all.filter((n) => {
    const t = n.created_at ? new Date(n.created_at).getTime() : 0;
    return t > lastSeenMs;
  }).length;

  return {
    ok: true,
    notifications: all,
    count: all.length,
    unread_count: unreadCount,
    last_seen_at: lastSeen,
  };
}

module.exports = {
  listForUser,
  dismiss,
  dismissAll,
  setLastSeen,
};
