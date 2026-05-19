// Magic-link auth — Phase 1 will wire the full flow.
// Same pattern as the dashboard's lib/auth.js.

const crypto = require("crypto");
const { pool } = require("./db");

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function issueMagicLink(email) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await pool.query(
    `INSERT INTO magic_link_tokens (token, email, expires_at) VALUES ($1, $2, $3)`,
    [token, email.toLowerCase().trim(), expiresAt]
  );
  return token;
}

async function consumeMagicLink(token) {
  const r = await pool.query(
    `SELECT email, expires_at, used_at FROM magic_link_tokens WHERE token = $1`,
    [token]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.used_at) return { ok: false, reason: "already_used" };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired" };
  await pool.query(`UPDATE magic_link_tokens SET used_at = NOW() WHERE token = $1`, [token]);
  return { ok: true, email: row.email };
}

module.exports = { issueMagicLink, consumeMagicLink };
