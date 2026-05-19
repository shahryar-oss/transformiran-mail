// Gmail OAuth + API client placeholder.
// Phase 1: wire the OAuth flow + initial message fetch.
// Phase 2: 3-4 year historical backfill into gmail_messages table.

const { google } = require("googleapis");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
  "profile",
];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function buildAuthUrl(state) {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

async function exchangeCode(code) {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

module.exports = { SCOPES, buildAuthUrl, exchangeCode, makeOAuthClient };
