// Delta Memory — persistent facts Delta has been told to remember.
// Two access patterns:
//   1. Explicit:   user says "remember X about Y" → Delta calls remember()
//   2. Auto-load:  when chatting, system loads memories about the people in
//                  the inbox snapshot + the open message sender, and injects
//                  them into the system prompt.

const { pool } = require("./db");

// Extract a normalized email from a "Name <email>" From header string.
function emailOf(rawFrom) {
  if (!rawFrom) return "";
  const m = rawFrom.match(/<([^>]+)>/);
  return (m ? m[1] : rawFrom).toLowerCase().trim();
}

// Extract a display name from "Name <email>" — falls back to the email local part.
function nameOf(rawFrom) {
  if (!rawFrom) return "";
  const m = rawFrom.match(/^(.*?)\s*<([^>]+)>/);
  if (m && m[1]) return m[1].replace(/^"|"$/g, "").trim();
  // "alice@example.com" → "alice"
  const at = rawFrom.indexOf("@");
  return at > 0 ? rawFrom.slice(0, at) : rawFrom;
}

// ---------- CRUD ----------

async function listAll(userId) {
  const r = await pool.query(
    `SELECT id, subject, subject_email, category, fact, source, created_at, updated_at
       FROM delta_memory
      WHERE user_id = $1
      ORDER BY lower(subject) ASC, created_at ASC`,
    [userId]
  );
  return r.rows;
}

async function add(userId, { subject, subject_email, category, fact, source }) {
  if (!subject || !fact) throw new Error("subject_and_fact_required");
  const r = await pool.query(
    `INSERT INTO delta_memory (user_id, subject, subject_email, category, fact, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, subject, subject_email, category, fact, source, created_at, updated_at`,
    [
      userId,
      String(subject).slice(0, 200).trim(),
      subject_email ? String(subject_email).toLowerCase().slice(0, 320).trim() : null,
      category ? String(category).slice(0, 40).trim() : null,
      String(fact).slice(0, 4000).trim(),
      source || "manual",
    ]
  );
  return r.rows[0];
}

async function update(userId, id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const k of ["subject", "subject_email", "category", "fact"]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      values.push(patch[k] === null ? null : String(patch[k]).slice(0, k === "fact" ? 4000 : 320));
    }
  }
  if (!fields.length) return null;
  values.push(userId, id);
  const r = await pool.query(
    `UPDATE delta_memory SET ${fields.join(", ")}, updated_at = NOW()
      WHERE user_id = $${i++} AND id = $${i}
      RETURNING id, subject, subject_email, category, fact, source, created_at, updated_at`,
    values
  );
  return r.rows[0] || null;
}

async function remove(userId, id) {
  const r = await pool.query(
    `DELETE FROM delta_memory WHERE user_id = $1 AND id = $2`,
    [userId, id]
  );
  return r.rowCount > 0;
}

// ---------- Relevance loading for chat context ----------

// Find memories matching any of the given subject identifiers.
// Each identifier is either a name (matches subject ILIKE) or an email (matches subject_email).
async function loadRelevant(userId, identifiers) {
  if (!identifiers || !identifiers.length) return [];

  const lowerNames = [];
  const lowerEmails = [];
  for (const raw of identifiers) {
    if (!raw) continue;
    if (raw.includes("@")) lowerEmails.push(raw.toLowerCase().trim());
    else lowerNames.push(raw.toLowerCase().trim());
  }

  // Always include "self" + "general" memories — they're cross-cutting.
  const subjects = ["self", "general"];

  const params = [userId, subjects];
  let whereName = "";
  let whereEmail = "";
  if (lowerNames.length) {
    params.push(lowerNames);
    whereName = ` OR lower(subject) = ANY($${params.length}::text[])
                  OR ${lowerNames.map((_, i) => `lower(subject) LIKE '%' || $${3 + i} || '%'`).join(" OR ")}`;
    // Append each name once more for LIKE params
    for (const n of lowerNames) params.push(n);
    // Adjust whereName to use the right positions — simpler: just exact match + ANY for now.
    // Rebuild using only exact match for safety:
    whereName = ` OR lower(subject) = ANY($3::text[])`;
    // Trim back params: keep userId, subjects, lowerNames
    params.length = 3;
  }
  if (lowerEmails.length) {
    params.push(lowerEmails);
    whereEmail = ` OR lower(subject_email) = ANY($${params.length}::text[])`;
  }

  const sql = `
    SELECT id, subject, subject_email, category, fact
      FROM delta_memory
     WHERE user_id = $1
       AND ( lower(subject) = ANY($2::text[])${whereName}${whereEmail} )
     ORDER BY lower(subject) ASC, created_at ASC
     LIMIT 80
  `;

  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (err) {
    console.warn("[memory.loadRelevant] failed:", err.message);
    return [];
  }
}

// Build identifiers list from an inbox snapshot + open message.
function identifiersFromContext({ inboxSnapshot = [], openMessage = null, user = null }) {
  const out = new Set();
  if (user?.display_name) out.add(user.display_name);
  if (user?.email) out.add(user.email.toLowerCase());

  for (const m of inboxSnapshot) {
    if (m.from) {
      const n = nameOf(m.from);
      const e = emailOf(m.from);
      if (n) out.add(n);
      if (e) out.add(e);
    }
  }
  if (openMessage?.from) {
    const n = nameOf(openMessage.from);
    const e = emailOf(openMessage.from);
    if (n) out.add(n);
    if (e) out.add(e);
  }
  return Array.from(out);
}

// Format a list of memory rows into a system-prompt-ready block.
function formatForPrompt(memories) {
  if (!memories.length) return "";
  const grouped = new Map();
  for (const m of memories) {
    const key = m.subject;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(m);
  }
  const sections = [];
  for (const [subject, items] of grouped.entries()) {
    const lines = items.map((m) => {
      const cat = m.category ? `[${m.category}] ` : "";
      return `  - ${cat}${m.fact}`;
    });
    const subjLabel = subject === "self"
      ? "About the current user"
      : subject === "general"
      ? "General (cross-cutting)"
      : `About ${subject}`;
    sections.push(`${subjLabel}:\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

module.exports = {
  listAll,
  add,
  update,
  remove,
  loadRelevant,
  identifiersFromContext,
  formatForPrompt,
  emailOf,
  nameOf,
};
