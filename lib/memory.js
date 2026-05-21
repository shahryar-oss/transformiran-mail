// Delta Memory — persistent facts Delta has been told to remember.
// Two access patterns:
//   1. Explicit:   user says "remember X about Y" → Delta calls remember()
//   2. Auto-load:  when chatting, system loads memories about the people in
//                  the inbox snapshot + the open message sender, and injects
//                  them into the system prompt.

const { pool } = require("./db");
const embeddings = require("./embeddings");

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
  const cleanSubject = String(subject).slice(0, 200).trim();
  const cleanFact = String(fact).slice(0, 4000).trim();

  // Try to embed (no-op if OPENAI_API_KEY not set). Combining subject + fact
  // captures who AND what so semantic search hits cleanly.
  const embedInput = `${cleanSubject}: ${cleanFact}`;
  let vec = null;
  try { vec = await embeddings.embedText(embedInput); } catch (_) {}

  const r = await pool.query(
    `INSERT INTO delta_memory (user_id, subject, subject_email, category, fact, source, embedding, embedding_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, subject, subject_email, category, fact, source, created_at, updated_at`,
    [
      userId,
      cleanSubject,
      subject_email ? String(subject_email).toLowerCase().slice(0, 320).trim() : null,
      category ? String(category).slice(0, 40).trim() : null,
      cleanFact,
      source || "manual",
      vec ? JSON.stringify(vec) : null,
      vec ? new Date() : null,
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

// Phase 5.AC — Semantic search over memories. Embed the user's query
// (the text they sent to Delta), fetch this user's memories that have
// embeddings, cosine-rank them, return the top N. Falls back gracefully
// to keyword search if OpenAI isn't configured or no memories have embeddings.
async function loadByQuery(userId, queryText, { limit = 8, threshold = 0.3 } = {}) {
  if (!queryText || !queryText.trim()) return [];
  if (!embeddings.isEnabled()) return [];

  const queryVec = await embeddings.embedText(queryText);
  if (!queryVec) return [];

  let candidates;
  try {
    const r = await pool.query(
      `SELECT id, subject, subject_email, category, fact, embedding
         FROM delta_memory
        WHERE user_id = $1 AND embedding IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 500`,
      [userId]
    );
    candidates = r.rows;
  } catch (err) {
    console.warn("[memory.loadByQuery] db failed:", err.message);
    return [];
  }

  // Score + sort. JSONB comes back as JS array already, but defend.
  const scored = [];
  for (const row of candidates) {
    let vec = row.embedding;
    if (typeof vec === "string") {
      try { vec = JSON.parse(vec); } catch (_) { continue; }
    }
    if (!Array.isArray(vec)) continue;
    const sim = embeddings.cosineSimilarity(queryVec, vec);
    if (sim < threshold) continue;
    scored.push({ ...row, _similarity: sim });
  }
  scored.sort((a, b) => b._similarity - a._similarity);
  return scored.slice(0, limit).map(({ _similarity, embedding, ...rest }) => rest);
}

// One-time backfill: generate embeddings for any user memories that don't
// have one yet. Called from a background worker so existing rows light up
// over time after OPENAI_API_KEY is added.
async function backfillEmbeddings({ limit = 25 } = {}) {
  if (!embeddings.isEnabled()) return { backfilled: 0, skipped: "no_openai_key" };
  const r = await pool.query(
    `SELECT id, subject, fact
       FROM delta_memory
      WHERE embedding IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );
  let n = 0;
  for (const row of r.rows) {
    const input = `${row.subject}: ${row.fact}`;
    const vec = await embeddings.embedText(input);
    if (!vec) continue;
    try {
      await pool.query(
        `UPDATE delta_memory SET embedding = $1, embedding_at = NOW() WHERE id = $2`,
        [JSON.stringify(vec), row.id]
      );
      n++;
    } catch (err) {
      console.warn(`[memory.backfillEmbeddings] save failed for ${row.id}:`, err.message);
    }
  }
  return { backfilled: n };
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
  loadByQuery,
  backfillEmbeddings,
  identifiersFromContext,
  formatForPrompt,
  emailOf,
  nameOf,
};
