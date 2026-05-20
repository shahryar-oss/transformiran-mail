// Contacts — per-user people directory. Pull-extracts from inbox_cache so
// the list populates from real email history; supplements with manual
// entries. Per-user isolation via user_id on every query.

const { pool } = require("./db");

// Pull a sender display name out of a 'Name <email>' From header.
function nameFromHeader(rawFrom) {
  if (!rawFrom) return "";
  const m = String(rawFrom).match(/^(.*?)\s*<([^>]+)>/);
  if (m && m[1]) return m[1].replace(/^"|"$/g, "").trim();
  // No bracket form — return the local-part of the email as a fallback.
  const at = String(rawFrom).indexOf("@");
  return at > 0 ? String(rawFrom).slice(0, at) : String(rawFrom);
}

function emailFromHeader(rawFrom) {
  if (!rawFrom) return "";
  const m = String(rawFrom).match(/<([^>]+)>/);
  return (m ? m[1] : String(rawFrom)).toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// LIST / GET
// ---------------------------------------------------------------------------

async function list(userId, { search, sort = "name", limit = 500 } = {}) {
  const params = [userId];
  let where = `WHERE c.user_id = $1`;
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where += ` AND (LOWER(c.name) LIKE $${params.length} OR LOWER(c.email) LIKE $${params.length} OR LOWER(COALESCE(c.organization, '')) LIKE $${params.length})`;
  }
  let order;
  switch (sort) {
    case "recent":     order = `ORDER BY c.last_seen_at DESC NULLS LAST, c.name ASC`; break;
    case "frequent":   order = `ORDER BY c.email_count DESC, c.name ASC`; break;
    case "name":
    default:           order = `ORDER BY LOWER(c.name) ASC`;
  }
  params.push(limit);
  const r = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone, c.organization, c.job_title,
            c.photo_url, c.notes, c.source, c.last_seen_at, c.email_count,
            c.created_at, c.updated_at,
            EXISTS (
              SELECT 1 FROM important_contacts ic
               WHERE ic.user_id = c.user_id AND LOWER(ic.email) = LOWER(c.email)
            ) AS is_important
       FROM contacts c
       ${where}
       ${order}
       LIMIT $${params.length}`,
    params
  );
  return r.rows.map(shape);
}

async function get(userId, id) {
  const r = await pool.query(
    `SELECT c.id, c.name, c.email, c.phone, c.organization, c.job_title,
            c.photo_url, c.notes, c.source, c.last_seen_at, c.email_count,
            c.created_at, c.updated_at,
            EXISTS (
              SELECT 1 FROM important_contacts ic
               WHERE ic.user_id = c.user_id AND LOWER(ic.email) = LOWER(c.email)
            ) AS is_important
       FROM contacts c
      WHERE c.user_id = $1 AND c.id = $2`,
    [userId, id]
  );
  return r.rows[0] ? shape(r.rows[0]) : null;
}

function shape(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone || "",
    organization: row.organization || "",
    job_title: row.job_title || "",
    photo_url: row.photo_url || "",
    notes: row.notes || "",
    source: row.source,
    last_seen_at: row.last_seen_at,
    email_count: row.email_count || 0,
    is_important: !!row.is_important,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// CREATE / UPDATE / DELETE
// ---------------------------------------------------------------------------

async function create(userId, { name, email, phone, organization, job_title, photo_url, notes }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("invalid_email");
  const cleanName = String(name || "").trim() || cleanEmail.split("@")[0];
  const r = await pool.query(
    `INSERT INTO contacts (user_id, name, email, phone, organization, job_title, photo_url, notes, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual')
     ON CONFLICT (user_id, LOWER(email)) DO UPDATE SET
       name         = EXCLUDED.name,
       phone        = COALESCE(NULLIF(EXCLUDED.phone, ''), contacts.phone),
       organization = COALESCE(NULLIF(EXCLUDED.organization, ''), contacts.organization),
       job_title    = COALESCE(NULLIF(EXCLUDED.job_title, ''), contacts.job_title),
       photo_url    = COALESCE(NULLIF(EXCLUDED.photo_url, ''), contacts.photo_url),
       notes        = COALESCE(NULLIF(EXCLUDED.notes, ''), contacts.notes),
       updated_at   = NOW()
     RETURNING id, name, email, phone, organization, job_title, photo_url, notes,
               source, last_seen_at, email_count, created_at, updated_at`,
    [
      userId, cleanName, cleanEmail,
      phone || null, organization || null, job_title || null,
      photo_url || null, notes || null,
    ]
  );
  return shape(r.rows[0]);
}

async function update(userId, id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const k of ["name", "phone", "organization", "job_title", "photo_url", "notes"]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      values.push(patch[k]);
    }
  }
  // We deliberately do NOT allow email changes — that would break the unique
  // constraint + the dedupe link with inbox_cache. Delete + recreate instead.
  if (!fields.length) return get(userId, id);
  values.push(userId, id);
  const r = await pool.query(
    `UPDATE contacts SET ${fields.join(", ")}, updated_at = NOW()
      WHERE user_id = $${i++} AND id = $${i}
      RETURNING id, name, email, phone, organization, job_title, photo_url, notes,
                source, last_seen_at, email_count, created_at, updated_at`,
    values
  );
  if (!r.rows[0]) return null;
  // Re-fetch through get() so is_important is computed.
  return get(userId, Number(r.rows[0].id));
}

async function remove(userId, id) {
  const r = await pool.query(
    `DELETE FROM contacts WHERE user_id = $1 AND id = $2`,
    [userId, id]
  );
  return r.rowCount > 0;
}

// ---------------------------------------------------------------------------
// EXTRACT FROM INBOX — auto-populate contacts from inbox_cache senders.
// Run on /contacts page load (fire-and-forget) so the user's first visit
// already shows real people without manual data entry.
// ---------------------------------------------------------------------------

async function extractFromInbox(userId, { limit = 500 } = {}) {
  // Pull every distinct sender from the inbox_cache. We only look at the
  // INCOMING side — the user's own outgoing addresses aren't useful here.
  const r = await pool.query(
    `SELECT from_header,
            MAX(internal_date) AS last_internal,
            COUNT(*) AS msg_count
       FROM inbox_cache
      WHERE user_id = $1
        AND from_header IS NOT NULL AND from_header <> ''
      GROUP BY from_header
      ORDER BY MAX(internal_date) DESC NULLS LAST
      LIMIT $2`,
    [userId, limit]
  );

  // Roll up by normalized email so the same person under different display
  // names (e.g. 'Lana' / 'Lana Silk') maps to ONE contact row.
  const byEmail = new Map();
  for (const row of r.rows) {
    const email = emailFromHeader(row.from_header);
    if (!email || !email.includes("@")) continue;
    const name = nameFromHeader(row.from_header) || email.split("@")[0];
    const last = row.last_internal ? new Date(Number(row.last_internal)) : null;
    const existing = byEmail.get(email);
    if (existing) {
      existing.count += Number(row.msg_count);
      if (last && (!existing.last || last > existing.last)) {
        existing.last = last;
        existing.name = name;   // prefer the name from the most recent message
      }
    } else {
      byEmail.set(email, { email, name, count: Number(row.msg_count), last });
    }
  }

  // Upsert each. New rows get source='auto-inbox'. Existing rows just have
  // their last_seen + count refreshed (and name if currently empty).
  let added = 0;
  let refreshed = 0;
  for (const c of byEmail.values()) {
    const result = await pool.query(
      `INSERT INTO contacts (user_id, name, email, source, last_seen_at, email_count)
       VALUES ($1, $2, $3, 'auto-inbox', $4, $5)
       ON CONFLICT (user_id, LOWER(email)) DO UPDATE SET
         last_seen_at = GREATEST(EXCLUDED.last_seen_at, contacts.last_seen_at),
         email_count  = EXCLUDED.email_count,
         name         = CASE
                          WHEN contacts.name IS NULL OR contacts.name = '' OR contacts.name = SPLIT_PART(contacts.email, '@', 1)
                          THEN EXCLUDED.name
                          ELSE contacts.name
                        END,
         updated_at   = NOW()
       RETURNING (xmax = 0) AS was_inserted`,
      [userId, c.name, c.email, c.last, c.count]
    );
    if (result.rows[0]?.was_inserted) added++;
    else refreshed++;
  }
  return { scanned: r.rows.length, added, refreshed, uniqueEmails: byEmail.size };
}

// Find the user's recent email exchanges with a given email address.
// Used by the contact detail panel to show "Recent emails" without going
// to Gmail. Reads from inbox_cache for speed.
async function recentEmails(userId, email, { limit = 8 } = {}) {
  if (!email) return [];
  const r = await pool.query(
    `SELECT message_id, thread_id, from_header, to_header, subject, snippet,
            date_header, internal_date, is_unread
       FROM inbox_cache
      WHERE user_id = $1
        AND (LOWER(from_header) LIKE $2
             OR LOWER(to_header) LIKE $2
             OR LOWER(cc_header) LIKE $2)
      ORDER BY internal_date DESC NULLS LAST
      LIMIT $3`,
    [userId, `%${email.toLowerCase()}%`, limit]
  );
  return r.rows.map((row) => ({
    id: row.message_id,
    threadId: row.thread_id,
    from: row.from_header || "",
    to: row.to_header || "",
    subject: row.subject || "(no subject)",
    snippet: row.snippet || "",
    date: row.date_header || "",
    internalDate: row.internal_date ? String(row.internal_date) : null,
    unread: !!row.is_unread,
  }));
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  extractFromInbox,
  recentEmails,
};
