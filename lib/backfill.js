// Historical Gmail backfill — indexes the user's ENTIRE mail history so
// Delta can search across everything, not just the last 30 messages.
//
// Resumable: progress + page tokens stored in `backfill_jobs`. If the
// server restarts mid-run, it picks back up.
//
// Two phases:
//   1. "list"  — paginate users.messages.list to collect every message ID
//                (with metadata snippet) → store stubs in gmail_messages_indexed
//   2. "meta"  — for each indexed stub WITHOUT headers, batch-fetch
//                format=metadata to fill in From/To/Subject/Date
//
// We don't store bodies during backfill — those are fetched on demand
// when the user opens a message. Keeps storage to ~1 KB / row.

const { google } = require("googleapis");
const { pool } = require("./db");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");
const mime = require("./mime");

// Tuning knobs — tune these to balance speed vs Gmail rate limits.
// Gmail quota: 250 quota units / user / second. messages.list = 5 units,
// messages.get(metadata) = 5 units. So 250/5 = 50 calls/sec theoretical
// max. We stay well under that.
const LIST_PAGE_SIZE = 500;       // gmail messages.list maxResults cap
const META_CONCURRENCY = 8;       // parallel messages.get during meta phase
const META_BATCH = 50;            // messages to fetch per worker tick
const LIST_PAGES_PER_TICK = 4;    // list pages to consume per worker tick

function safeStringList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function parseEmailAddress(raw) {
  if (!raw) return { name: "", email: "" };
  const m = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || "").replace(/^"|"$/g, "").trim(), email: m[2].toLowerCase().trim() };
  return { name: "", email: String(raw).toLowerCase().trim() };
}

// ===========================================================================
// JOB STATE
// ===========================================================================

async function getJob(userId) {
  const r = await pool.query(`SELECT * FROM backfill_jobs WHERE user_id = $1`, [userId]);
  return r.rows[0] || null;
}

async function startJob(userId) {
  const existing = await getJob(userId);
  if (existing) {
    if (existing.status === "completed") {
      return existing;
    }
    if (existing.status === "running" || existing.status === "pending") {
      return existing;
    }
    // failed or paused — reset to pending and try again
    await pool.query(
      `UPDATE backfill_jobs SET status = 'pending', error = NULL, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    return getJob(userId);
  }
  const r = await pool.query(
    `INSERT INTO backfill_jobs (user_id, status, started_at)
     VALUES ($1, 'pending', NOW())
     RETURNING *`,
    [userId]
  );
  return r.rows[0];
}

async function setStatus(userId, status, error = null) {
  await pool.query(
    `UPDATE backfill_jobs SET status = $1, error = $2, updated_at = NOW(),
       completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
     WHERE user_id = $3`,
    [status, error, userId]
  );
}

async function setProgress(userId, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const k of ["phase", "next_page_token", "pending_ids", "total_estimated", "total_indexed"]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      values.push(patch[k]);
    }
  }
  if (!fields.length) return;
  fields.push(`last_progress_at = NOW()`);
  fields.push(`updated_at = NOW()`);
  values.push(userId);
  await pool.query(
    `UPDATE backfill_jobs SET ${fields.join(", ")} WHERE user_id = $${i}`,
    values
  );
}

// ===========================================================================
// WORKER — call repeatedly. Returns { done, advanced, indexed, total }.
// Caller should re-invoke until done=true.
// ===========================================================================

async function tick(userId) {
  const job = await getJob(userId);
  if (!job) return { done: true, reason: "no_job" };
  if (job.status === "completed") return { done: true, reason: "already_completed" };
  if (job.status === "failed") return { done: true, reason: "failed", error: job.error };

  const creds = await loadGoogleCreds(userId);
  if (!creds) {
    await setStatus(userId, "failed", "no_google_creds");
    return { done: true, reason: "no_creds" };
  }

  await setStatus(userId, "running");
  const oauth = authedClientFromTokens(creds);
  const g = google.gmail({ version: "v1", auth: oauth });

  try {
    if (job.phase === "list" || !job.phase) {
      return await tickList(g, job);
    }
    if (job.phase === "meta") {
      return await tickMeta(g, job);
    }
    // Unknown phase — mark done
    await setStatus(userId, "completed");
    return { done: true };
  } catch (err) {
    console.error(`[backfill ${userId}] tick failed:`, err);
    await setStatus(userId, "failed", String(err.message || err));
    return { done: true, reason: "error", error: String(err.message || err) };
  }
}

// LIST PHASE — paginate through messages.list, store stubs.
async function tickList(g, job) {
  const userId = job.user_id;
  let pageToken = job.next_page_token || null;
  let pagesThisTick = 0;
  let newRows = 0;

  while (pagesThisTick < LIST_PAGES_PER_TICK) {
    const r = await g.users.messages.list({
      userId: "me",
      maxResults: LIST_PAGE_SIZE,
      pageToken: pageToken || undefined,
    });
    const list = r.data.messages || [];
    const nextToken = r.data.nextPageToken || null;
    const sizeEstimate = r.data.resultSizeEstimate || job.total_estimated || null;

    if (list.length === 0) {
      // No more messages — move to meta phase
      await setProgress(userId, {
        phase: "meta",
        next_page_token: null,
        total_estimated: sizeEstimate || job.total_estimated || 0,
      });
      return { done: false, advanced: true, indexed: job.total_indexed, total: sizeEstimate };
    }

    // Bulk insert stubs (id only — meta gets filled in phase 2).
    const ids = list.map((m) => m.id);
    const placeholders = [];
    const values = [];
    let n = 1;
    for (const id of ids) {
      placeholders.push(`($${n++}, $${n++})`);
      values.push(userId, id);
    }
    const ins = await pool.query(
      `INSERT INTO gmail_messages_indexed (user_id, message_id)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (user_id, message_id) DO NOTHING`,
      values
    );
    newRows += ins.rowCount || 0;

    pageToken = nextToken;
    pagesThisTick++;

    if (!nextToken) {
      // End of pagination — switch to meta phase
      await setProgress(userId, {
        phase: "meta",
        next_page_token: null,
        total_estimated: sizeEstimate || (job.total_estimated || 0) + newRows,
      });
      return { done: false, advanced: true, indexed: job.total_indexed, total: sizeEstimate };
    }
  }

  // Still more pages — persist the cursor for next tick
  await setProgress(userId, {
    next_page_token: pageToken,
    total_estimated: job.total_estimated,
  });
  return { done: false, advanced: true, indexed: job.total_indexed };
}

// META PHASE — find stubs missing headers, batch-fetch metadata.
async function tickMeta(g, job) {
  const userId = job.user_id;

  // Find next batch of stubs that haven't had metadata fetched yet
  const r = await pool.query(
    `SELECT message_id FROM gmail_messages_indexed
      WHERE user_id = $1 AND from_email IS NULL
      ORDER BY message_id
      LIMIT $2`,
    [userId, META_BATCH]
  );
  const ids = r.rows.map((row) => row.message_id);
  if (ids.length === 0) {
    // Done — count total
    const c = await pool.query(
      `SELECT COUNT(*)::INT AS n FROM gmail_messages_indexed WHERE user_id = $1`,
      [userId]
    );
    await setProgress(userId, {
      phase: "done",
      total_indexed: c.rows[0].n,
      total_estimated: c.rows[0].n,
    });
    await setStatus(userId, "completed");
    // Recompute contact aggregates
    await rebuildContacts(userId);
    return { done: true, indexed: c.rows[0].n, total: c.rows[0].n };
  }

  // Fetch each in parallel, capped at META_CONCURRENCY
  const results = [];
  for (let i = 0; i < ids.length; i += META_CONCURRENCY) {
    const slice = ids.slice(i, i + META_CONCURRENCY);
    const sliceResults = await Promise.all(
      slice.map((id) =>
        g.users.messages
          .get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
          })
          .then((res) => ({ id, data: res.data, ok: true }))
          .catch((err) => ({ id, ok: false, err: err.message }))
      )
    );
    results.push(...sliceResults);
  }

  // Batch upsert into indexed table
  const ok = results.filter((r) => r.ok);
  const ROW_FIELDS = 11;
  if (ok.length) {
    const placeholders = [];
    const values = [];
    let n = 1;
    for (const r of ok) {
      const m = r.data;
      const headers = mime.headersToMap(m.payload?.headers || []);
      const fromParsed = parseEmailAddress(headers.from);
      const toParsed = (headers.to || "").split(",").map((s) => parseEmailAddress(s).email).filter(Boolean).join(",");
      const ccParsed = (headers.cc || "").split(",").map((s) => parseEmailAddress(s).email).filter(Boolean).join(",");
      const dateSent = headers.date ? new Date(headers.date) : null;
      const labels = (m.labelIds || []).join(",");
      const isSent = (m.labelIds || []).includes("SENT");
      placeholders.push(
        `($${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++})`
      );
      values.push(
        userId,
        r.id,
        m.threadId || null,
        m.internalDate ? Number(m.internalDate) : null,
        dateSent && !isNaN(dateSent) ? dateSent.toISOString() : null,
        fromParsed.name || null,
        fromParsed.email || null,
        toParsed || null,
        ccParsed || null,
        headers.subject || null,
        m.snippet || null
      );
    }
    await pool.query(
      `INSERT INTO gmail_messages_indexed
        (user_id, message_id, thread_id, internal_date, date_sent,
         from_name, from_email, to_emails, cc_emails, subject, snippet)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (user_id, message_id) DO UPDATE SET
         thread_id     = EXCLUDED.thread_id,
         internal_date = EXCLUDED.internal_date,
         date_sent     = EXCLUDED.date_sent,
         from_name     = EXCLUDED.from_name,
         from_email    = EXCLUDED.from_email,
         to_emails     = EXCLUDED.to_emails,
         cc_emails     = EXCLUDED.cc_emails,
         subject       = EXCLUDED.subject,
         snippet       = EXCLUDED.snippet`,
      values
    );

    // Also update labels + is_sent in a separate, simpler statement.
    // (Hard to do as part of the bulk upsert above without ballooning param count.)
    for (const r of ok) {
      const m = r.data;
      await pool.query(
        `UPDATE gmail_messages_indexed
            SET labels = $1, is_sent = $2
          WHERE user_id = $3 AND message_id = $4`,
        [(m.labelIds || []).join(","), (m.labelIds || []).includes("SENT"), userId, r.id]
      );
    }
  }

  // Mark failed ones as indexed too (just store the ID, no headers — Gmail
  // can return 404 if a message was deleted between list and get).
  // Already exist as stub rows, so nothing to do.

  // Progress
  const c = await pool.query(
    `SELECT COUNT(*)::INT AS done FROM gmail_messages_indexed
      WHERE user_id = $1 AND from_email IS NOT NULL`,
    [userId]
  );
  await setProgress(userId, { total_indexed: c.rows[0].done });

  return { done: false, advanced: true, indexed: c.rows[0].done, total: job.total_estimated };
}

// ===========================================================================
// CONTACT AGGREGATES — recomputed after backfill completes.
// ===========================================================================

async function rebuildContacts(userId) {
  // Received: count messages where from_email != user
  // Sent: count messages where is_sent = true
  // For sent: extract first recipient from to_emails
  try {
    await pool.query(`DELETE FROM gmail_contacts WHERE user_id = $1`, [userId]);

    // Received side
    await pool.query(
      `INSERT INTO gmail_contacts (user_id, email, display_name, total_received, last_interaction, first_interaction, last_seen_subject)
       SELECT $1, from_email, MAX(from_name), COUNT(*), MAX(date_sent), MIN(date_sent),
              (ARRAY_AGG(subject ORDER BY date_sent DESC NULLS LAST))[1]
         FROM gmail_messages_indexed
        WHERE user_id = $1 AND from_email IS NOT NULL AND is_sent = FALSE
        GROUP BY from_email
       ON CONFLICT (user_id, email) DO UPDATE SET
         total_received = EXCLUDED.total_received,
         last_interaction = EXCLUDED.last_interaction,
         first_interaction = EXCLUDED.first_interaction,
         display_name = COALESCE(EXCLUDED.display_name, gmail_contacts.display_name),
         last_seen_subject = EXCLUDED.last_seen_subject,
         updated_at = NOW()`,
      [userId]
    );

    // Sent side — only count first recipient of each sent message for simplicity
    await pool.query(
      `INSERT INTO gmail_contacts (user_id, email, total_sent, last_interaction)
       SELECT $1, split_part(to_emails, ',', 1), COUNT(*), MAX(date_sent)
         FROM gmail_messages_indexed
        WHERE user_id = $1 AND is_sent = TRUE AND to_emails IS NOT NULL
        GROUP BY split_part(to_emails, ',', 1)
       ON CONFLICT (user_id, email) DO UPDATE SET
         total_sent = EXCLUDED.total_sent,
         last_interaction = GREATEST(COALESCE(gmail_contacts.last_interaction, EXCLUDED.last_interaction), EXCLUDED.last_interaction),
         updated_at = NOW()`,
      [userId]
    );
  } catch (err) {
    console.error("[backfill] rebuildContacts failed:", err);
  }
}

// ===========================================================================
// SEARCH — used by Delta's search_inbox tool
// ===========================================================================

async function searchIndexed(userId, query, { limit = 25 } = {}) {
  // Parse a tiny Gmail-style query language: "from:lana subject:budget hello world"
  const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
  const where = ["user_id = $1"];
  const params = [userId];

  let freeText = [];
  for (const tok of tokens) {
    const m = tok.match(/^(from|to|subject|has):(.+)$/i);
    if (!m) { freeText.push(tok); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].toLowerCase();
    if (key === "from") {
      params.push(val);
      where.push(`(lower(from_email) LIKE '%' || $${params.length} || '%' OR lower(from_name) LIKE '%' || $${params.length} || '%')`);
    } else if (key === "to") {
      params.push(val);
      where.push(`lower(to_emails) LIKE '%' || $${params.length} || '%'`);
    } else if (key === "subject") {
      params.push(val);
      where.push(`lower(subject) LIKE '%' || $${params.length} || '%'`);
    }
  }
  if (freeText.length) {
    const text = freeText.join(" ").toLowerCase();
    params.push(text);
    where.push(`(lower(subject) LIKE '%' || $${params.length} || '%' OR lower(snippet) LIKE '%' || $${params.length} || '%')`);
  }

  params.push(Math.min(50, Math.max(1, Number(limit) || 25)));

  const sql = `
    SELECT message_id, thread_id, internal_date, date_sent, from_name, from_email,
           subject, snippet, is_sent, labels
      FROM gmail_messages_indexed
     WHERE ${where.join(" AND ")}
     ORDER BY internal_date DESC NULLS LAST
     LIMIT $${params.length}
  `;
  const r = await pool.query(sql, params);
  return r.rows;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

module.exports = {
  startJob,
  getJob,
  tick,
  searchIndexed,
  rebuildContacts,
};
