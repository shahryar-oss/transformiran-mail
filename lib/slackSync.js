// ============================================================================
// lib/slackSync.js  —  Phase 5.BS  Background sync of Slack content
//
// One sync pass per (viewer, channel) pair:
//   • Workspace bot token reads public + private channels it's a member of.
//   • Each TI user's personal token reads everything THEY can see —
//     DMs, group DMs, channels — without needing the bot invited.
//
// Strategy
//   1. Refresh slack_channels list from each viewer's perspective.
//      (conversations.list with types=public,private,im,mpim — the
//      bot won't see channels it's not in but will list everything
//      else; the user token sees everything they're in.)
//   2. For each channel + viewer, page through conversations.history
//      starting from latest_ts cursor (i.e. only the new stuff).
//   3. Upsert messages into slack_messages keyed by (team, channel, ts).
//   4. For any file attached, upsert into slack_files. We don't fetch
//      file BYTES here — that happens lazily when Delta asks via the
//      read_slack_file tool (Phase 5.BU).
//   5. Resolve unknown user IDs in batches via users.info and cache.
//
// Rate-limit-aware: Slack tier 3 = ~50 req/min. We pause 100ms between
// channels and bail out of long pagination after MAX_PAGES_PER_CYCLE so
// no single sync starves the others.
// ============================================================================

const { pool } = require("./db");
const slack = require("./slack");

const MAX_PAGES_PER_CYCLE = 5;      // safety cap on long history pages
const PAGE_SIZE = 200;               // Slack accepts up to 1000 but smaller is gentler
const PAUSE_MS = 120;                // between channels
const MAX_HISTORY_DAYS_FIRST_SYNC = 90; // initial backfill window

function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Channel list refresh
// ---------------------------------------------------------------------------
async function refreshChannels(teamId, token, types) {
  let cursor = "";
  let pages = 0;
  const seenChannelIds = [];
  do {
    const data = await slack.callSlackApi("conversations.list", {
      types: types || "public_channel,private_channel,mpim,im",
      exclude_archived: true,
      limit: 200,
      cursor: cursor || undefined,
    }, token);
    const channels = data.channels || [];
    for (const c of channels) {
      const kind = c.is_im ? "im"
        : c.is_mpim ? "mpim"
        : c.is_private ? "private_channel"
        : "public_channel";
      await pool.query(
        `INSERT INTO slack_channels
           (team_id, channel_id, name, kind, is_archived, created, num_members, topic, purpose, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (team_id, channel_id) DO UPDATE SET
           name = EXCLUDED.name,
           kind = EXCLUDED.kind,
           is_archived = EXCLUDED.is_archived,
           num_members = EXCLUDED.num_members,
           topic = EXCLUDED.topic,
           purpose = EXCLUDED.purpose,
           updated_at = NOW()`,
        [
          teamId,
          c.id,
          c.name || (c.is_im ? `dm:${c.user || ""}` : null),
          kind,
          !!c.is_archived,
          c.created || null,
          c.num_members || null,
          c.topic?.value || null,
          c.purpose?.value || null,
        ],
      );
      seenChannelIds.push({ id: c.id, kind });
    }
    cursor = data.response_metadata?.next_cursor || "";
    pages++;
  } while (cursor && pages < 8);
  return seenChannelIds;
}

// ---------------------------------------------------------------------------
// Per-channel history pagination
// ---------------------------------------------------------------------------
async function getCursor(viewer, teamId, channelId) {
  const r = await pool.query(
    `SELECT latest_ts FROM slack_sync_cursors
       WHERE viewer = $1 AND team_id = $2 AND channel_id = $3`,
    [viewer, teamId, channelId],
  );
  return r.rows[0]?.latest_ts || null;
}

async function setCursor(viewer, teamId, channelId, latestTs) {
  await pool.query(
    `INSERT INTO slack_sync_cursors (viewer, team_id, channel_id, latest_ts, last_sync_at)
       VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (viewer, team_id, channel_id) DO UPDATE SET
       latest_ts = EXCLUDED.latest_ts,
       last_sync_at = NOW()`,
    [viewer, teamId, channelId, latestTs],
  );
}

async function syncChannelHistory(viewer, teamId, channelId, token) {
  let oldest = await getCursor(viewer, teamId, channelId);
  if (!oldest) {
    // First sync — pull last MAX_HISTORY_DAYS_FIRST_SYNC days only.
    const cutoff = (Date.now() / 1000) - (MAX_HISTORY_DAYS_FIRST_SYNC * 86400);
    oldest = String(cutoff);
  }
  let cursor = "";
  let pages = 0;
  let newestSeen = oldest;
  let totalIngested = 0;
  do {
    let data;
    try {
      data = await slack.callSlackApi("conversations.history", {
        channel: channelId,
        oldest,
        limit: PAGE_SIZE,
        cursor: cursor || undefined,
        inclusive: false,
      }, token);
    } catch (err) {
      // "not_in_channel" = bot needs to be invited. Skip silently and continue.
      if (err.slackResponse?.error === "not_in_channel") return { ingested: 0, skipped: "not_in_channel" };
      if (err.slackResponse?.error === "channel_not_found") return { ingested: 0, skipped: "channel_not_found" };
      throw err;
    }
    const messages = data.messages || [];
    for (const m of messages) {
      const ts = m.ts;
      if (!ts) continue;
      if (parseFloat(ts) > parseFloat(newestSeen || "0")) newestSeen = ts;
      // Skip channel join / leave / topic-change noise — keep regular
      // messages + bot_message + file_share + thread replies only.
      if (m.subtype && !["bot_message", "file_share", "thread_broadcast"].includes(m.subtype)) {
        continue;
      }
      await pool.query(
        `INSERT INTO slack_messages
           (team_id, channel_id, ts, thread_ts, slack_user_id, user_name, text_body, subtype, reactions, file_ids, permalink, ingested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::text[], $11, NOW())
         ON CONFLICT (team_id, channel_id, ts) DO UPDATE SET
           text_body = EXCLUDED.text_body,
           reactions = EXCLUDED.reactions,
           ingested_at = NOW()`,
        [
          teamId,
          channelId,
          ts,
          m.thread_ts || null,
          m.user || m.bot_id || null,
          null, // user_name resolved in a separate pass
          m.text || "",
          m.subtype || null,
          JSON.stringify(m.reactions || []),
          (m.files || []).map((f) => f.id),
          null, // permalink resolved on-demand
        ],
      );
      // Upsert files referenced in this message.
      for (const f of (m.files || [])) {
        await pool.query(
          `INSERT INTO slack_files
             (team_id, file_id, channel_id, filename, title, mimetype, filetype, size_bytes, url_private, url_private_download, slack_user_id, created, ingested_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
           ON CONFLICT (team_id, file_id) DO UPDATE SET
             filename = EXCLUDED.filename,
             title = EXCLUDED.title,
             mimetype = EXCLUDED.mimetype,
             ingested_at = NOW()`,
          [
            teamId,
            f.id,
            channelId,
            f.name || null,
            f.title || null,
            f.mimetype || null,
            f.filetype || null,
            f.size || null,
            f.url_private || null,
            f.url_private_download || null,
            f.user || null,
            f.created || null,
          ],
        );
      }
      totalIngested++;
    }
    cursor = data.response_metadata?.next_cursor || "";
    pages++;
  } while (cursor && pages < MAX_PAGES_PER_CYCLE);

  if (newestSeen && newestSeen !== oldest) {
    await setCursor(viewer, teamId, channelId, newestSeen);
  } else {
    // Even if nothing new, mark last_sync_at.
    await setCursor(viewer, teamId, channelId, oldest);
  }
  return { ingested: totalIngested };
}

// ---------------------------------------------------------------------------
// User directory cache
// ---------------------------------------------------------------------------
async function backfillUnknownUsers(teamId, token) {
  // Look at the most-recent 200 messages for distinct user ids we don't yet
  // have in slack_users; resolve them in batches.
  const r = await pool.query(
    `SELECT DISTINCT m.slack_user_id
       FROM slack_messages m
       LEFT JOIN slack_users u
         ON u.team_id = m.team_id AND u.slack_user_id = m.slack_user_id
      WHERE m.team_id = $1 AND m.slack_user_id IS NOT NULL AND u.slack_user_id IS NULL
      LIMIT 50`,
    [teamId],
  );
  for (const row of r.rows) {
    try {
      const data = await slack.callSlackApi("users.info", { user: row.slack_user_id }, token);
      if (!data.ok) continue;
      const u = data.user || {};
      await pool.query(
        `INSERT INTO slack_users (team_id, slack_user_id, name, real_name, display_name, email, is_bot, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (team_id, slack_user_id) DO UPDATE SET
           name = EXCLUDED.name, real_name = EXCLUDED.real_name,
           display_name = EXCLUDED.display_name, email = EXCLUDED.email,
           is_bot = EXCLUDED.is_bot, updated_at = NOW()`,
        [
          teamId,
          row.slack_user_id,
          u.name || null,
          u.real_name || null,
          u.profile?.display_name || null,
          u.profile?.email || null,
          !!u.is_bot,
        ],
      );
      // Denormalise: write the resolved name into recent messages too,
      // so search results render fast without a join later.
      await pool.query(
        `UPDATE slack_messages
            SET user_name = $1
          WHERE team_id = $2 AND slack_user_id = $3 AND user_name IS NULL`,
        [u.real_name || u.name || row.slack_user_id, teamId, row.slack_user_id],
      );
    } catch (_) {
      // Best-effort — skip and move on.
    }
    await pause(80);
  }
}

// ---------------------------------------------------------------------------
// Per-workspace bot sync (one pass over all channels the bot is in)
// ---------------------------------------------------------------------------
async function syncWorkspaceBot(ws) {
  const viewer = `bot:${ws.team_id}`;
  const channels = await refreshChannels(ws.team_id, ws.bot_token, "public_channel,private_channel");
  let totalIngested = 0;
  let skipped = 0;
  for (const ch of channels) {
    try {
      const r = await syncChannelHistory(viewer, ws.team_id, ch.id, ws.bot_token);
      totalIngested += r.ingested;
      if (r.skipped) skipped++;
    } catch (err) {
      console.warn(`[slack-sync bot] ${ws.team_id}/${ch.id} failed:`, err.message);
    }
    await pause(PAUSE_MS);
  }
  await backfillUnknownUsers(ws.team_id, ws.bot_token);
  return { viewer, ingested: totalIngested, channels: channels.length, skipped };
}

// ---------------------------------------------------------------------------
// Per-TI-user sync (channels + DMs the user can see)
// ---------------------------------------------------------------------------
async function syncUser(tiUserId) {
  const conn = await slack.getUserToken(tiUserId);
  if (!conn) return { skipped: "no_user_token" };
  const viewer = `user:${tiUserId}`;
  const channels = await refreshChannels(
    conn.team_id,
    conn.user_token,
    "public_channel,private_channel,im,mpim",
  );
  let totalIngested = 0;
  for (const ch of channels) {
    try {
      const r = await syncChannelHistory(viewer, conn.team_id, ch.id, conn.user_token);
      totalIngested += r.ingested;
    } catch (err) {
      console.warn(`[slack-sync user] ${tiUserId}/${ch.id} failed:`, err.message);
    }
    await pause(PAUSE_MS);
  }
  await backfillUnknownUsers(conn.team_id, conn.user_token);
  return { viewer, ingested: totalIngested, channels: channels.length };
}

// ---------------------------------------------------------------------------
// Top-level sync entry point — used by the scheduler + admin endpoint
// ---------------------------------------------------------------------------
async function syncAll() {
  if (!slack.isConfigured()) return { skipped: "not_configured" };
  // 1. Workspace bot pass (one per workspace row).
  const wsRows = await pool.query(`SELECT * FROM slack_workspaces`);
  const out = { workspaces: [], users: [] };
  for (const ws of wsRows.rows) {
    try {
      const r = await syncWorkspaceBot(ws);
      out.workspaces.push({ team_id: ws.team_id, ...r });
    } catch (err) {
      console.warn("[slack-sync] workspace sync failed:", err.message);
    }
  }
  // 2. Per-user pass — every TI user with a connected Slack.
  const userRows = await pool.query(`SELECT user_id FROM slack_user_tokens`);
  for (const row of userRows.rows) {
    try {
      const r = await syncUser(row.user_id);
      out.users.push({ ti_user_id: row.user_id, ...r });
    } catch (err) {
      console.warn(`[slack-sync] user ${row.user_id} sync failed:`, err.message);
    }
  }
  console.log("[slack-sync] done:", JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------------------
// Cheap counter for the UI / admin diag — how much Slack content do we have?
// ---------------------------------------------------------------------------
async function stats(teamId) {
  if (teamId) {
    const r = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM slack_channels WHERE team_id=$1) AS channels,
         (SELECT COUNT(*) FROM slack_messages WHERE team_id=$1) AS messages,
         (SELECT COUNT(*) FROM slack_files    WHERE team_id=$1) AS files,
         (SELECT COUNT(*) FROM slack_users    WHERE team_id=$1) AS users`,
      [teamId],
    );
    return r.rows[0];
  }
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM slack_channels) AS channels,
       (SELECT COUNT(*) FROM slack_messages) AS messages,
       (SELECT COUNT(*) FROM slack_files)    AS files,
       (SELECT COUNT(*) FROM slack_users)    AS users`,
  );
  return r.rows[0];
}

module.exports = {
  syncAll,
  syncWorkspaceBot,
  syncUser,
  stats,
};
