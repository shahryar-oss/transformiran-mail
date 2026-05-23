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
  // LOCAL search — searches subject + snippet of every indexed email.
  // Fast (~10ms) and free, but limited to what's in our DB. CRITICAL:
  // snippet is only the ~200-char preview Gmail returns, so anything
  // in the BODY past that preview is invisible to this search.
  //
  // searchInboxWithFallback wraps this with a Gmail q= fallback that
  // covers the full body case. Direct callers (admin debug, etc.) can
  // still use searchIndexed for the local-only behaviour.
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
// SEARCH with Gmail-q= fallback — used by Delta's search_inbox tool
// ===========================================================================
//
// LOCAL search is fast but only knows subject + snippet. When the wanted
// content lives deeper in the body (e.g. "£18,250" mentioned mid-email
// rather than in the first ~200 chars Gmail snippets), local returns 0.
//
// This wrapper falls through to Gmail's native q= search when local
// finds nothing. Gmail searches the FULL body text — same engine as
// the Gmail web search box — so anything Gmail itself can find,
// Delta can find too.
//
// We also opportunistically upsert the fallback results into
// gmail_messages_indexed so the NEXT search for the same content
// hits the local index instantly.

// Translate our local-query syntax to Gmail's q= dialect. Mostly
// 1:1: both use `from:`, `to:`, `subject:` operators. We also expand
// quoted phrases for amounts ("18,250" → '"18,250" OR "18250"') so
// Gmail's tokenizer doesn't strip the comma.
function buildGmailQuery(query) {
  const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (/^(from|to|subject|has|before|after):/i.test(tok)) {
      out.push(tok);
      continue;
    }
    // Amount-like token (digits + separators) — quote it so Gmail keeps
    // the punctuation. Also push the no-separator variant so we catch
    // both "18250" and "18,250" formats in one query.
    if (/^[\d.,]+[kKmM]?$/.test(tok)) {
      const stripped = tok.replace(/[.,]/g, "");
      if (stripped !== tok) {
        out.push(`("${tok}" OR "${stripped}")`);
      } else {
        out.push(`"${tok}"`);
      }
      continue;
    }
    out.push(tok);
  }
  return out.join(" ");
}

async function searchViaGmail(userId, query, { limit = 25 } = {}) {
  const creds = await loadGoogleCreds(userId);
  if (!creds) return [];
  const oauth = authedClientFromTokens(creds);
  const g = google.gmail({ version: "v1", auth: oauth });
  const gq = buildGmailQuery(query);
  if (!gq.trim()) return [];

  let listRes;
  try {
    listRes = await g.users.messages.list({
      userId: "me",
      q: gq,
      maxResults: Math.min(50, Math.max(1, Number(limit) || 25)),
    });
  } catch (err) {
    console.warn("[searchViaGmail] list failed:", err.message);
    return [];
  }
  const ids = (listRes.data.messages || []).map((m) => m.id);
  if (!ids.length) return [];

  // Fetch metadata for each id in parallel (cap concurrency).
  const CHUNK = 8;
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const fetched = await Promise.all(
      slice.map((id) =>
        g.users.messages
          .get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
          })
          .then((r) => r.data)
          .catch(() => null)
      )
    );
    for (const m of fetched.filter(Boolean)) {
      const headers = Object.fromEntries(
        (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
      );
      const rawFrom = headers.from || "";
      const fromMatch = rawFrom.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
      const internalDate = m.internalDate ? Number(m.internalDate) : null;
      const labelIds = m.labelIds || [];
      rows.push({
        message_id: m.id,
        thread_id: m.threadId || null,
        internal_date: internalDate,
        date_sent: internalDate ? new Date(internalDate).toISOString() : null,
        from_name: fromMatch ? fromMatch[1].trim() : (rawFrom.includes("@") ? "" : rawFrom),
        from_email: fromMatch ? fromMatch[2].toLowerCase().trim()
                              : (rawFrom.includes("@") ? rawFrom.toLowerCase().trim() : ""),
        to_emails: headers.to || "",
        cc_emails: headers.cc || "",
        subject: headers.subject || "(no subject)",
        snippet: m.snippet || "",
        labels: labelIds.join(","),
        is_sent: labelIds.includes("SENT"),
        _via_gmail_fallback: true,
      });
    }
  }

  // Opportunistic upsert: future searches for the same content hit the
  // local index instantly. Best-effort.
  if (rows.length) {
    try {
      const valuePlaceholders = [];
      const values = [];
      rows.forEach((r, i) => {
        const b = i * 13;
        valuePlaceholders.push(
          `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11}, $${b+12}, $${b+13})`
        );
        values.push(
          userId,
          r.message_id,
          r.thread_id,
          r.internal_date,
          r.date_sent,
          r.from_name || null,
          r.from_email || null,
          r.to_emails || null,
          r.cc_emails || null,
          r.subject,
          r.snippet,
          r.labels,
          r.is_sent
        );
      });
      await pool.query(
        `INSERT INTO gmail_messages_indexed
           (user_id, message_id, thread_id, internal_date, date_sent,
            from_name, from_email, to_emails, cc_emails, subject, snippet,
            labels, is_sent)
         VALUES ${valuePlaceholders.join(",")}
         ON CONFLICT (user_id, message_id) DO UPDATE SET
           subject  = COALESCE(EXCLUDED.subject, gmail_messages_indexed.subject),
           snippet  = EXCLUDED.snippet,
           labels   = EXCLUDED.labels`,
        values
      );
    } catch (err) {
      // Non-fatal — the search succeeded; the next search just won't
      // benefit from the local cache.
      console.warn("[searchViaGmail] opportunistic indexing failed:", err.message);
    }
  }
  return rows;
}

// Public entry-point used by Delta's search_inbox tool. Local-first,
// Gmail-q= fallback when local returns 0. The fallback is critical
// for body-text matches (amounts, references, etc. that don't appear
// in subject/snippet).
async function searchInboxWithFallback(userId, query, { limit = 25 } = {}) {
  const local = await searchIndexed(userId, query, { limit });
  if (local.length > 0) {
    return local;
  }
  // Nothing locally → try Gmail's q= for body-text coverage.
  const remote = await searchViaGmail(userId, query, { limit }).catch((err) => {
    console.warn("[searchInboxWithFallback] gmail fallback failed:", err.message);
    return [];
  });
  if (remote.length) {
    console.log(`[search_inbox] local=0 → gmail q="${query.slice(0,80)}" returned ${remote.length}`);
  }
  return remote;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

module.exports = {
  startJob,
  getJob,
  tick,
  searchIndexed,
  searchInboxWithFallback,
  searchViaGmail,
  rebuildContacts,
};
