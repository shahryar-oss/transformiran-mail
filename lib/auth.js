// Session + Google OAuth login.
// Replaces the earlier magic-link scaffold. Google OAuth IS the auth for
// Delta Mail — there's no separate "email + click link" step. The Audience
// is Internal on the OAuth app, so Google itself enforces that only users
// in the transformiran.com Workspace can log in.

const crypto = require("crypto");
const { pool } = require("./db");
const gmail = require("./gmail");

const SESSION_COOKIE = "tim_session";
const SESSION_TTL_DAYS = 30;
const STATE_COOKIE = "tim_oauth_state";

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

// Set a signed cookie containing the user_id.
function setSession(res, userId) {
  const secret = requireSessionSecret();
  const value = String(userId);
  const sig = sign(value, secret);
  const cookieValue = `${value}.${sig}`;
  res.cookie(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Verify the signed cookie and return the user_id (number), or null.
function readSession(req) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const [value, sig] = raw.split(".");
  if (!value || !sig) return null;
  const secret = requireSessionSecret();
  const expected = sign(value, secret);
  // timing-safe compare
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  const userId = Number(value);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return userId;
}

// Express middleware — attaches req.user if logged in, otherwise req.user = null.
async function attachUser(req, res, next) {
  const uid = readSession(req);
  if (!uid) {
    req.user = null;
    return next();
  }
  try {
    const r = await pool.query(
      `SELECT id, email, display_name, picture_url, welcomed_at, preferred_model FROM users WHERE id = $1`,
      [uid]
    );
    req.user = r.rows[0] || null;
  } catch (err) {
    console.error("[auth] user lookup failed:", err);
    req.user = null;
  }
  next();
}

// Middleware — 401 if not logged in. Use on protected routes.
function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts("html") && req.method === "GET") {
      return res.redirect("/");
    }
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Stash a CSRF-style state value in a short-lived cookie so the callback
// can verify the response came from our /auth/google start.
function newOAuthState(res) {
  const state = crypto.randomBytes(24).toString("base64url");
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000, // 10 min
    path: "/",
  });
  return state;
}

function consumeOAuthState(req, res) {
  const value = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: "/" });
  return value || null;
}

// Persist Google user → users row + tokens → gmail_credentials row.
async function upsertUserAndTokens(userInfo, tokens) {
  const email = (userInfo.email || "").toLowerCase().trim();
  if (!email) throw new Error("oauth_no_email");

  // Optional but recommended: only allow @transformiran.com (Internal audience
  // should already enforce this, but defense in depth).
  if (!/@transformiran\.com$/i.test(email)) {
    const err = new Error("not_transformiran_workspace");
    err.code = "not_transformiran_workspace";
    throw err;
  }

  const userRes = await pool.query(
    `INSERT INTO users (email, display_name, picture_url, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       picture_url  = COALESCE(EXCLUDED.picture_url, users.picture_url),
       last_seen_at = NOW()
     RETURNING id`,
    [email, userInfo.name || null, userInfo.picture || null]
  );
  const userId = userRes.rows[0].id;

  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  await pool.query(
    `INSERT INTO gmail_credentials (user_id, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, gmail_credentials.refresh_token),
       expires_at    = EXCLUDED.expires_at,
       scopes        = EXCLUDED.scopes,
       updated_at    = NOW()`,
    [
      userId,
      tokens.access_token || null,
      tokens.refresh_token || null,
      expiresAt,
      tokens.scope || gmail.SCOPES.join(" "),
    ]
  );

  return { userId, email };
}

// Load the user's Google credentials (decrypted by Postgres, returned in plain).
async function loadGoogleCreds(userId) {
  const r = await pool.query(
    `SELECT access_token, refresh_token, expires_at, scopes
       FROM gmail_credentials WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

function requireSessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET missing or too short");
  }
  return s;
}

module.exports = {
  setSession,
  clearSession,
  readSession,
  attachUser,
  requireAuth,
  newOAuthState,
  consumeOAuthState,
  upsertUserAndTokens,
  loadGoogleCreds,
};
