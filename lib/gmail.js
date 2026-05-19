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

module.exports = {
  SCOPES,
  buildAuthUrl,
  exchangeCode,
  makeOAuthClient,
  authedClientFromTokens,
  fetchUserInfo,
};
