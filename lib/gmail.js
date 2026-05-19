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
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
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

// Fetch the user's primary Gmail signature (the one set in Gmail Settings →
// General → Signature). Transform Iran staff signatures are managed by an
// external service that writes them directly into Gmail, so this is the
// authoritative copy.
//
// Returns { html, displayName, sendAsEmail } or null.
async function fetchPrimarySignature(authClient) {
  try {
    const g = google.gmail({ version: "v1", auth: authClient });
    const r = await g.users.settings.sendAs.list({ userId: "me" });
    const sendAsList = r.data.sendAs || [];

    // Prefer the primary (isDefault), fall back to the first one with a signature.
    const withSig = sendAsList.filter((s) => s.signature && s.signature.trim());
    if (!withSig.length) return null;
    const primary = withSig.find((s) => s.isDefault) || withSig[0];
    return {
      html: primary.signature,         // raw HTML as the user wrote / org pushed
      displayName: primary.displayName || "",
      sendAsEmail: primary.sendAsEmail || "",
    };
  } catch (err) {
    console.warn("[gmail.fetchPrimarySignature] failed:", err.message);
    return null;
  }
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

// Tiny in-memory cache keyed by user_id — signatures don't change often.
const _sigCache = new Map();   // user_id → { fetchedAt, signature }
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

module.exports = {
  SCOPES,
  buildAuthUrl,
  exchangeCode,
  makeOAuthClient,
  authedClientFromTokens,
  fetchUserInfo,
  fetchPrimarySignature,
  getCachedSignature,
  signatureToPlainText,
};
