// Separate admin authentication for the email-platform admin console.
// Completely independent of the Google-OAuth user session — admin access
// is gated by a dedicated passphrase (stored as a sha256 hash in the
// ADMIN_PASSWORD_HASH env var) and its own signed, short-lived cookie.
// So being logged into a mailbox does NOT grant admin, and vice-versa.

const crypto = require("crypto");

const ADMIN_COOKIE = "tim_admin";
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; // 12-hour admin session

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}
function sha256hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function isConfigured() {
  return !!process.env.ADMIN_PASSWORD_HASH;
}

// Constant-time compare of sha256(passphrase) against the stored hash.
function verifyPassphrase(pass) {
  const stored = process.env.ADMIN_PASSWORD_HASH || "";
  if (!stored || !pass) return false;
  const got = sha256hex(pass);
  if (got.length !== stored.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(stored.toLowerCase()));
  } catch (_) {
    return false;
  }
}

function setAdminSession(res) {
  const exp = String(Date.now() + ADMIN_TTL_MS);
  const sig = crypto.createHmac("sha256", sessionSecret()).update("admin:" + exp).digest("base64url");
  res.cookie(ADMIN_COOKIE, `${exp}.${sig}`, {
    httpOnly: true, secure: true, sameSite: "lax", maxAge: ADMIN_TTL_MS, path: "/",
  });
}
function clearAdminSession(res) {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
}

function isAdmin(req) {
  const raw = req.cookies?.[ADMIN_COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!exp || !sig) return false;
  let expected;
  try {
    expected = crypto.createHmac("sha256", sessionSecret()).update("admin:" + exp).digest("base64url");
  } catch (_) { return false; }
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  if (!Number.isFinite(Number(exp)) || Date.now() > Number(exp)) return false;
  return true;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    if (req.accepts("html") && req.method === "GET") return res.redirect("/admin/login");
    return res.status(401).json({ error: "admin_unauthorized" });
  }
  next();
}

// Brute-force throttle — per-IP attempt counter, in-memory.
const _attempts = new Map(); // ip -> { count, first }
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 10 * 60 * 1000;
function loginThrottled(ip) {
  const rec = _attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { _attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function recordFailedLogin(ip) {
  const rec = _attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) { _attempts.set(ip, { count: 1, first: Date.now() }); }
  else { rec.count += 1; }
}
function clearLoginAttempts(ip) { _attempts.delete(ip); }

module.exports = {
  ADMIN_COOKIE, ADMIN_TTL_MS,
  isConfigured, verifyPassphrase, sha256hex,
  setAdminSession, clearAdminSession, isAdmin, requireAdmin,
  loginThrottled, recordFailedLogin, clearLoginAttempts,
};
