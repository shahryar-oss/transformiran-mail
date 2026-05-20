// Per-user Important contacts — VIPs you want pinned as folders in the rail
// and weighted by the classifier / routine wizard. Auto-seeded with the org
// defaults (Lana / Lazarus / Maggie / Pia) on first access for any user, so
// the experience is good out of the box.

const { pool } = require("./db");

const DEFAULTS = [
  { name: "Lana Silk",        email: "lana@transformiran.com",    color: "#B28E44" },
  { name: "Lazarus Yeghnazar", email: "lazarus@transformiran.com", color: "#E92A2E" },
  { name: "Maggie Yeghnazar", email: "maggie@transformiran.com",  color: "#4F9D5A" },
  { name: "Pia van Belen",    email: "pia@transformiran.com",     color: "#5B7CA3" },
];

// Auto-seed defaults the first time we encounter a user. Idempotent because
// of the unique index on (user_id, LOWER(email)) — ON CONFLICT DO NOTHING.
async function ensureSeeded(userId) {
  const seeded = await pool.query(
    `SELECT COUNT(*)::INT AS n FROM important_contacts WHERE user_id = $1`,
    [userId]
  );
  if (seeded.rows[0].n > 0) return;
  for (let i = 0; i < DEFAULTS.length; i++) {
    const d = DEFAULTS[i];
    await pool.query(
      `INSERT INTO important_contacts (user_id, email, name, color, position)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [userId, d.email, d.name, d.color, i]
    );
  }
}

async function list(userId) {
  await ensureSeeded(userId);
  const r = await pool.query(
    `SELECT id, email, name, color, position, created_at
       FROM important_contacts
      WHERE user_id = $1
      ORDER BY position, created_at`,
    [userId]
  );
  return r.rows.map((row) => ({ ...row, id: Number(row.id) }));
}

async function add(userId, { email, name, color }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanName = String(name || "").trim() || cleanEmail;
  if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("invalid_email");
  const posR = await pool.query(
    `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM important_contacts WHERE user_id = $1`,
    [userId]
  );
  const r = await pool.query(
    `INSERT INTO important_contacts (user_id, email, name, color, position)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, LOWER(email)) DO UPDATE
       SET name = EXCLUDED.name, color = COALESCE(EXCLUDED.color, important_contacts.color)
     RETURNING id, email, name, color, position`,
    [userId, cleanEmail, cleanName, color || null, posR.rows[0].p]
  );
  return { ...r.rows[0], id: Number(r.rows[0].id) };
}

async function remove(userId, id) {
  await pool.query(
    `DELETE FROM important_contacts WHERE user_id = $1 AND id = $2`,
    [userId, id]
  );
}

// Match a sender header ('"Lana Silk" <lana@transformiran.com>') against
// THIS user's important contacts. Returns the matching row or null.
async function matchSender(userId, fromHeader) {
  if (!fromHeader) return null;
  const raw = String(fromHeader).toLowerCase();
  const contacts = await list(userId);
  for (const c of contacts) {
    if (c.email && raw.includes(c.email.toLowerCase())) return c;
    if (c.name && raw.includes(c.name.toLowerCase())) return c;
  }
  return null;
}

module.exports = { list, add, remove, matchSender, ensureSeeded, DEFAULTS };
