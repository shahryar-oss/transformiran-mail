// Gmail / Calendar / Drive / People / Sheets / Docs OAuth + API client.
// All Google APIs route through this module.

const { google } = require("googleapis");

// Full scope list — matches APIs we enabled in the GCP project (TIemail).
// Audience is Internal, so consent is granted once and these all stay valid.
const SCOPES = [
  // Identity
  "openid",
  "email",
  "profile",
  // Gmail
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  // Calendar
  "https://www.googleapis.com/auth/calendar",
  // Drive (read for now; expand later if we write files)
  "https://www.googleapis.com/auth/drive.readonly",
  // People (contacts)
  "https://www.googleapis.com/auth/contacts.readonly",
  // Sheets + Docs
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
];

function makeOAuthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  }
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  // Mitigate persistent "Premature close" (ERR_STREAM_PREMATURE_CLOSE) errors
  // talking to Google: under gaxios, node-fetch auto-gunzips gzipped responses
  // and THROWS in the gunzip stream when the response doesn't end cleanly
  // (seen across all users + both mail apps against oauth2.googleapis.com/token
  // — token refresh failing ~100%, so nothing syncs). Requesting an
  // uncompressed response skips the gunzip path entirely. This applies to BOTH
  // the internal token refresh AND the Gmail API data calls, since both flow
  // through client.transporter. Best-effort: never let it break client setup.
  try {
    const t = client.transporter;
    if (t) {
      t.defaults = t.defaults || {};
      t.defaults.headers = { ...(t.defaults.headers || {}), "Accept-Encoding": "identity" };
    }
  } catch (_) { /* leave default transport untouched */ }
  return client;
}

function buildAuthUrl(state) {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",   // returns refresh_token
    prompt: "consent",        // forces refresh_token issuance even on re-auth
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

async function exchangeCode(code) {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  // tokens: { access_token, refresh_token, expiry_date, id_token, scope, token_type }
  return tokens;
}

// Returns an OAuth2 client primed with the given user's stored tokens.
// Automatically refreshes access_token if expired (googleapis handles it).
function authedClientFromTokens({ access_token, refresh_token, expires_at, scopes }) {
  const client = makeOAuthClient();
  client.setCredentials({
    access_token,
    refresh_token,
    expiry_date: expires_at ? new Date(expires_at).getTime() : undefined,
    scope: scopes,
  });
  return client;
}

// Quick userinfo call — used right after OAuth callback to learn the user's email.
async function fetchUserInfo(authClient) {
  const oauth2 = google.oauth2({ version: "v2", auth: authClient });
  const r = await oauth2.userinfo.get();
  return r.data; // { id, email, verified_email, name, given_name, family_name, picture, locale, hd }
}

// Fetch ALL sendAs entries (aliases + signatures). Shortwave-style listing.
// Returns { aliases: [{sendAsEmail, displayName, isDefault, isPrimary, signature, replyToAddress, treatAsAlias}], primarySignature: {html, sendAsEmail, displayName} | null }
async function fetchSendAs(authClient) {
  try {
    const g = google.gmail({ version: "v1", auth: authClient });
    const r = await g.users.settings.sendAs.list({ userId: "me" });
    const list = r.data.sendAs || [];
    const withSig = list.filter((s) => s.signature && s.signature.trim());
    const primary =
      withSig.find((s) => s.isDefault) ||
      withSig.find((s) => s.isPrimary) ||
      withSig[0] ||
      null;
    return {
      aliases: list.map((s) => ({
        sendAsEmail: s.sendAsEmail,
        displayName: s.displayName || "",
        isDefault: !!s.isDefault,
        isPrimary: !!s.isPrimary,
        treatAsAlias: !!s.treatAsAlias,
        replyToAddress: s.replyToAddress || "",
        hasSignature: !!(s.signature && s.signature.trim()),
        signatureLength: s.signature ? s.signature.length : 0,
      })),
      primarySignature: primary
        ? {
            html: primary.signature,
            displayName: primary.displayName || "",
            sendAsEmail: primary.sendAsEmail || "",
          }
        : null,
    };
  } catch (err) {
    console.warn("[gmail.fetchSendAs] failed:", err.message);
    return { aliases: [], primarySignature: null };
  }
}

// Fetch the user's primary Gmail signature (the one set in Gmail Settings →
// General → Signature). Transform Iran staff signatures are managed by an
// external service that writes them directly into Gmail, so this is the
// authoritative copy.
//
// Returns { html, displayName, sendAsEmail } or null.
async function fetchPrimarySignature(authClient) {
  const r = await fetchSendAs(authClient);
  return r.primarySignature;
}

// Convert an HTML signature into a plain-text version (used in the text/plain
// part of multipart/alternative messages).
function signatureToPlainText(html) {
  if (!html) return "";
  // Reuse the same HTML→text helper used for inbound mail bodies.
  // (Required dynamically to avoid a circular import.)
  const { htmlToText } = require("./mime");
  return htmlToText(html).trim();
}

// Tiny in-memory cache keyed by user_id — signatures + aliases don't change often.
const _sigCache = new Map();    // user_id → { fetchedAt, signature }
const _sendAsCache = new Map(); // user_id → { fetchedAt, sendAs }
const SIG_TTL_MS = 60 * 60 * 1000; // 60 min

async function getCachedSignature(userId, authClient) {
  const cached = _sigCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < SIG_TTL_MS) {
    return cached.signature;
  }
  const sig = await fetchPrimarySignature(authClient);
  _sigCache.set(userId, { fetchedAt: Date.now(), signature: sig });
  return sig;
}

async function getCachedSendAs(userId, authClient, force = false) {
  if (!force) {
    const cached = _sendAsCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < SIG_TTL_MS) return cached.sendAs;
  }
  const sendAs = await fetchSendAs(authClient);
  _sendAsCache.set(userId, { fetchedAt: Date.now(), sendAs });
  // Also seed the signature cache to keep them in sync.
  _sigCache.set(userId, { fetchedAt: Date.now(), signature: sendAs.primarySignature });
  return sendAs;
}

function invalidateGmailCaches(userId) {
  _sigCache.delete(userId);
  _sendAsCache.delete(userId);
}

// ---------------------------------------------------------------------------
// Transient-error retry for Google API calls.
//
// Google's OAuth token endpoint (oauth2.googleapis.com/token) occasionally
// truncates its gzipped response → "Premature close" / ERR_STREAM_PREMATURE_
// CLOSE. That bubbles up from a LAZY token refresh inside an otherwise-fine
// API call and, with no retry, surfaces to the user as a hard 500 (e.g. the
// reader showing "Couldn't load this message: HTTP 500"). These blips hit all
// users at once and clear within seconds, so a couple of short retries fix the
// symptom. We retry ONLY transient network/stream/5xx/429 errors — never auth
// or 4xx client errors (invalid_grant, 401/403, 404), where retrying is
// pointless or harmful.
// ---------------------------------------------------------------------------
const _TRANSIENT_RX = /premature close|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|ETIMEDOUT|socket hang ?up|EAI_AGAIN|ENOTFOUND|EPIPE|network socket disconnected/i;
function isTransientGoogleError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const status = Number(err.status || (err.response && err.response.status) || 0);
  // Never retry definite auth / client errors.
  if ([400, 401, 403, 404].includes(status)) return false;
  const msg = `${err.message || ""} ${(err.cause && err.cause.message) || ""}`;
  if (/invalid_grant|invalid_token|unauthorized|insufficient|forbidden/i.test(msg)) return false;
  if (["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(code)) return true;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return _TRANSIENT_RX.test(msg);
}
async function withGoogleRetry(fn, { tries = 3, label = "google" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= tries || !isTransientGoogleError(err)) throw err;
      const delay = 200 * attempt + Math.floor(Math.random() * 150); // 200-350, 400-550…
      console.warn(`[${label}] transient Google error (attempt ${attempt}/${tries}): ${err.message}; retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = {
  SCOPES,
  buildAuthUrl,
  exchangeCode,
  makeOAuthClient,
  authedClientFromTokens,
  withGoogleRetry,
  isTransientGoogleError,
  fetchUserInfo,
  fetchPrimarySignature,
  fetchSendAs,
  getCachedSignature,
  getCachedSendAs,
  invalidateGmailCaches,
  signatureToPlainText,
};
