// ============================================================================
// lib/slack.js  —  Phase 5.BR  Slack OAuth + token persistence + API client
//
// Two-token model:
//   • Bot token (one per workspace) — reads shared channels + files,
//     posts messages. Installed once by an admin.
//   • User token (one per TI user) — reads DMs and does workspace-wide
//     search.messages. Each staff member connects their own.
//
// All env vars come from process.env. Production needs:
//   SLACK_CLIENT_ID
//   SLACK_CLIENT_SECRET
//   SLACK_REDIRECT_URI       (defaults to PUBLIC_BASE_URL + /api/slack/oauth-callback)
//   SLACK_INSTALL_REDIRECT   (defaults to PUBLIC_BASE_URL + /api/slack/install-callback)
//   PUBLIC_BASE_URL          (e.g. https://mail.transformiran.info)
// ============================================================================

const crypto = require("crypto");
const { pool } = require("./db");

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://mail.transformiran.info").replace(/\/$/, "");

const REDIRECT_URI_USER =
  process.env.SLACK_REDIRECT_URI ||
  `${PUBLIC_BASE_URL}/api/slack/oauth-callback`;
const REDIRECT_URI_INSTALL =
  process.env.SLACK_INSTALL_REDIRECT ||
  `${PUBLIC_BASE_URL}/api/slack/install-callback`;

// Bot scopes — workspace install. Lets the bot read shared channels +
// files + identities. Matches the scopes the user adds in api.slack.com.
const BOT_SCOPES = [
  "channels:history", "channels:read",
  "groups:history",   "groups:read",
  "mpim:history",     "mpim:read",
  "files:read",
  "users:read",       "users:read.email",
  "team:read",
  "chat:write",
].join(",");

// User scopes — per-user connect. Includes search:read (NOT available
// for bot tokens) and DM history.
const USER_SCOPES = [
  "search:read",
  "im:history",       "im:read",
  "mpim:history",     "mpim:read",
  "channels:history", "channels:read",
  "groups:history",   "groups:read",
  "files:read",
  "users:read",
].join(",");

function isConfigured() {
  return !!(SLACK_CLIENT_ID && SLACK_CLIENT_SECRET);
}

// ---------------------------------------------------------------------------
// OAuth — start URLs.
// ---------------------------------------------------------------------------

async function generateState(userId, flow) {
  const state = crypto.randomBytes(24).toString("hex");
  await pool.query(
    `INSERT INTO slack_oauth_state (state, user_id, flow) VALUES ($1, $2, $3)`,
    [state, userId, flow],
  );
  // Garbage collect anything older than 10 minutes.
  await pool.query(
    `DELETE FROM slack_oauth_state WHERE created_at < NOW() - INTERVAL '10 minutes'`,
  ).catch(() => {});
  return state;
}

async function consumeState(state) {
  const r = await pool.query(
    `DELETE FROM slack_oauth_state WHERE state = $1 RETURNING user_id, flow, created_at`,
    [state],
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const ageSec = (Date.now() - new Date(row.created_at).getTime()) / 1000;
  if (ageSec > 600) return null;
  return { userId: row.user_id, flow: row.flow };
}

function buildInstallUrl(state) {
  // Workspace install — uses scope=<bot scopes>. After approval the
  // workspace's bot token is delivered to install-callback.
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: BOT_SCOPES,
    redirect_uri: REDIRECT_URI_INSTALL,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

function buildUserConnectUrl(state) {
  // Per-user connect — uses user_scope (NOT scope) so we get a user
  // token, not another bot token.
  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    user_scope: USER_SCOPES,
    redirect_uri: REDIRECT_URI_USER,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

// ---------------------------------------------------------------------------
// OAuth — token exchange + storage.
// ---------------------------------------------------------------------------

async function exchangeCode(code, redirectUri) {
  // POST to https://slack.com/api/oauth.v2.access with client creds.
  const body = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`slack oauth.v2.access HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`slack oauth: ${data.error || "unknown_error"}`);
  }
  return data;
}

async function saveWorkspaceInstall(data, installedByUserId) {
  // Shape of oauth.v2.access response for a bot install:
  //   { ok, access_token (xoxb-), bot_user_id, scope,
  //     team: { id, name }, ... }
  const teamId = data.team?.id;
  const teamName = data.team?.name;
  const botToken = data.access_token;
  const botUserId = data.bot_user_id;
  const scope = data.scope || "";
  if (!teamId || !botToken) throw new Error("install_missing_fields");
  await pool.query(
    `INSERT INTO slack_workspaces
       (team_id, team_name, bot_user_id, bot_token, scope, installed_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (team_id) DO UPDATE SET
       team_name    = EXCLUDED.team_name,
       bot_user_id  = EXCLUDED.bot_user_id,
       bot_token    = EXCLUDED.bot_token,
       scope        = EXCLUDED.scope,
       installed_by = EXCLUDED.installed_by,
       updated_at   = NOW()`,
    [teamId, teamName, botUserId, botToken, scope, installedByUserId],
  );
  return { teamId, teamName };
}

async function saveUserConnect(data, tiUserId) {
  // Shape of oauth.v2.access for user-scope grant:
  //   { ok, authed_user: { id, scope, access_token (xoxp-), ... },
  //     team: { id, name }, ... }
  const teamId = data.team?.id;
  const authed = data.authed_user || {};
  const slackUserId = authed.id;
  const userToken = authed.access_token;
  const scope = authed.scope || "";
  if (!teamId || !slackUserId || !userToken) {
    throw new Error("user_connect_missing_fields");
  }
  // Look up the user's Slack profile (display name + email) so we can
  // surface it in Settings UI.
  let slackUserName = null;
  let slackEmail = null;
  try {
    const profile = await callSlackApi("users.info", { user: slackUserId }, userToken);
    if (profile.ok) {
      slackUserName = profile.user?.real_name || profile.user?.name || null;
      slackEmail = profile.user?.profile?.email || null;
    }
  } catch (_) {}
  await pool.query(
    `INSERT INTO slack_user_tokens
       (user_id, team_id, slack_user_id, slack_user_name, slack_email, user_token, scope, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, team_id) DO UPDATE SET
       slack_user_id   = EXCLUDED.slack_user_id,
       slack_user_name = EXCLUDED.slack_user_name,
       slack_email     = EXCLUDED.slack_email,
       user_token      = EXCLUDED.user_token,
       scope           = EXCLUDED.scope,
       updated_at      = NOW()`,
    [tiUserId, teamId, slackUserId, slackUserName, slackEmail, userToken, scope],
  );
  return { teamId, slackUserId, slackUserName, slackEmail };
}

// ---------------------------------------------------------------------------
// Read accessors.
// ---------------------------------------------------------------------------

async function getWorkspace(teamId) {
  if (!teamId) {
    const r = await pool.query(
      `SELECT team_id, team_name, bot_user_id, bot_token, scope, installed_at
         FROM slack_workspaces ORDER BY installed_at ASC LIMIT 1`,
    );
    return r.rows[0] || null;
  }
  const r = await pool.query(
    `SELECT team_id, team_name, bot_user_id, bot_token, scope, installed_at
       FROM slack_workspaces WHERE team_id = $1`,
    [teamId],
  );
  return r.rows[0] || null;
}

async function getUserToken(userId, teamId = null) {
  let r;
  if (teamId) {
    r = await pool.query(
      `SELECT team_id, slack_user_id, slack_user_name, slack_email, user_token, scope, connected_at, updated_at
         FROM slack_user_tokens WHERE user_id = $1 AND team_id = $2`,
      [userId, teamId],
    );
  } else {
    r = await pool.query(
      `SELECT team_id, slack_user_id, slack_user_name, slack_email, user_token, scope, connected_at, updated_at
         FROM slack_user_tokens WHERE user_id = $1
         ORDER BY connected_at DESC LIMIT 1`,
      [userId],
    );
  }
  return r.rows[0] || null;
}

async function status(userId) {
  // Combined: is the workspace installed + has THIS user connected.
  const ws = await getWorkspace();
  const ut = userId ? await getUserToken(userId) : null;
  return {
    configured: isConfigured(),
    workspace: ws ? {
      team_id: ws.team_id,
      team_name: ws.team_name,
      installed_at: ws.installed_at,
    } : null,
    user_connected: !!ut,
    user_connection: ut ? {
      team_id: ut.team_id,
      slack_user_id: ut.slack_user_id,
      slack_user_name: ut.slack_user_name,
      slack_email: ut.slack_email,
      connected_at: ut.connected_at,
    } : null,
  };
}

async function disconnectUser(userId) {
  await pool.query(
    `DELETE FROM slack_user_tokens WHERE user_id = $1`,
    [userId],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lightweight Slack API client.
//
// callSlackApi("conversations.list", { types: "public_channel" }, token)
// callSlackApi("search.messages",     { query: "foo" },             userToken)
// ---------------------------------------------------------------------------
async function callSlackApi(method, params = {}, token) {
  if (!token) throw new Error("slack_token_required");
  const url = `https://slack.com/api/${encodeURIComponent(method)}`;
  // Slack accepts either application/x-www-form-urlencoded OR
  // application/json with Authorization: Bearer. JSON is cleaner for
  // POSTs with arrays/objects. For most calls form is fine.
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === "string" ? v : String(v));
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "Authorization": `Bearer ${token}`,
    },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!data.ok) {
    const err = new Error(`slack_api_${method}_${data.error || "unknown"}`);
    err.slackResponse = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// File download — authenticated GET against url_private. Uses the bot
// token for files in shared channels; falls back to the user token when
// the bot can't reach the file (e.g. DM-attached files).
// ---------------------------------------------------------------------------
async function fetchFileBytes(tiUserId, fileId) {
  // Look up file metadata from our cache first.
  const r = await pool.query(
    `SELECT team_id, file_id, filename, title, mimetype, filetype, size_bytes,
            url_private, url_private_download, channel_id
       FROM slack_files WHERE file_id = $1`,
    [fileId],
  );
  const meta = r.rows[0];
  if (!meta) {
    // Not in our cache — pull file metadata live via files.info using
    // whichever token we have.
    const conn = await getUserToken(tiUserId);
    const ws = await getWorkspace();
    const token = conn?.user_token || ws?.bot_token;
    if (!token) throw new Error("no_slack_token");
    const info = await callSlackApi("files.info", { file: fileId }, token);
    if (!info.ok) throw new Error(`files.info: ${info.error || "unknown"}`);
    const f = info.file || {};
    return {
      meta: {
        file_id: f.id,
        filename: f.name,
        mimetype: f.mimetype,
        filetype: f.filetype,
        size_bytes: f.size,
        url_private: f.url_private,
        url_private_download: f.url_private_download,
      },
      bytes: await downloadAuth(f.url_private_download || f.url_private, token),
    };
  }
  // Try user token first (sees DMs), bot token second.
  const conn = await getUserToken(tiUserId);
  const ws = await getWorkspace();
  const candidates = [conn?.user_token, ws?.bot_token].filter(Boolean);
  let lastErr;
  for (const token of candidates) {
    try {
      const bytes = await downloadAuth(meta.url_private_download || meta.url_private, token);
      return { meta, bytes };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("file_download_failed");
}

async function downloadAuth(url, token) {
  if (!url) throw new Error("no_url");
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`slack_file_HTTP_${resp.status}`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// ---------------------------------------------------------------------------
// Search — two-tier strategy.
//   1. Live: Slack's search.messages API via the user's token. Best
//      relevance ranking + permalinks. Requires a user token.
//   2. Local: Postgres LIKE / trigram fallback. Useful when the user
//      hasn't OAuth'd yet, or as a complement to the live results.
// ---------------------------------------------------------------------------
async function searchMessages(tiUserId, query, { limit = 15 } = {}) {
  const lim = Math.max(1, Math.min(30, Number(limit) || 15));
  const conn = await getUserToken(tiUserId);

  // Live search first if we have a user token.
  if (conn) {
    try {
      const r = await callSlackApi(
        "search.messages",
        { query, count: lim, highlight: true, sort: "timestamp", sort_dir: "desc" },
        conn.user_token,
      );
      const matches = r.messages?.matches || [];
      return {
        ok: true,
        source: "live",
        query,
        count: matches.length,
        results: matches.map((m) => {
          // Slack channel id prefixes: C = public, G = private/group,
          // D = DM, M = mpim. Surface this so the model can tell DMs
          // apart from channels in the result list.
          const chId = m.channel?.id || "";
          const kind =
            chId.startsWith("D") ? "dm" :
            chId.startsWith("M") ? "group_dm" :
            chId.startsWith("G") ? "private_channel" :
            chId.startsWith("C") ? "public_channel" : null;
          return {
            channel_id: chId || null,
            channel_name: m.channel?.name || (kind === "dm" ? `DM with @${m.username || "unknown"}` : null),
            channel_kind: kind,
            user_id: m.user || null,
            user_name: m.username || null,
            ts: m.ts,
            text: m.text || "",
            permalink: m.permalink || null,
            ts_iso: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : null,
          };
        }),
      };
    } catch (err) {
      // Fall through to local search.
      console.warn("[slack.searchMessages live] failed:", err.message);
    }
  }

  // Local fallback — searches whatever the sync worker has put in Postgres.
  // Splits the query on whitespace + requires every term to appear
  // (case-insensitive). Skips Slack-specific operators (from:/in:/has:)
  // since they're not in the local schema.
  const terms = String(query || "")
    .replace(/\b(from|in|has|before|after):\S+/gi, "")  // strip operators
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) {
    return { ok: true, source: "local", query, count: 0, results: [], note: "Connect your Slack in Settings for full search (DMs + private channels + permalinks)." };
  }
  const conds = terms.map((_, i) => `lower(m.text_body) LIKE '%' || lower($${i + 1}) || '%'`).join(" AND ");
  const params = terms;
  const r = await pool.query(
    `SELECT m.team_id, m.channel_id, m.ts, m.thread_ts, m.slack_user_id,
            m.user_name, m.text_body, m.permalink,
            c.name AS channel_name, c.kind AS channel_kind,
            u.real_name AS resolved_user
       FROM slack_messages m
       LEFT JOIN slack_channels c
         ON c.team_id = m.team_id AND c.channel_id = m.channel_id
       LEFT JOIN slack_users u
         ON u.team_id = m.team_id AND u.slack_user_id = m.slack_user_id
      WHERE ${conds}
      ORDER BY m.ts DESC
      LIMIT ${lim}`,
    params,
  );
  return {
    ok: true,
    source: "local",
    query,
    count: r.rows.length,
    results: r.rows.map((row) => ({
      channel_id: row.channel_id,
      channel_name: row.channel_name || row.channel_id,
      channel_kind: row.channel_kind,
      user_id: row.slack_user_id,
      user_name: row.resolved_user || row.user_name || row.slack_user_id,
      ts: row.ts,
      ts_iso: row.ts ? new Date(parseFloat(row.ts) * 1000).toISOString() : null,
      text: row.text_body || "",
      permalink: row.permalink,
    })),
    note: conn ? null : "Connect your Slack in Settings to also search DMs + private channels.",
  };
}

module.exports = {
  // Config
  isConfigured,
  BOT_SCOPES,
  USER_SCOPES,
  REDIRECT_URI_USER,
  REDIRECT_URI_INSTALL,

  // OAuth
  generateState,
  consumeState,
  buildInstallUrl,
  buildUserConnectUrl,
  exchangeCode,
  saveWorkspaceInstall,
  saveUserConnect,

  // Read / write
  getWorkspace,
  getUserToken,
  status,
  disconnectUser,

  // API client
  callSlackApi,

  // Search
  searchMessages,

  // Files
  fetchFileBytes,
};
