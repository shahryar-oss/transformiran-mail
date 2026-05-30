// Slack voice-note transcription — Phase 5.CV.
//
// Slack "audio clips" / voice messages arrive as files attached to a
// message. The sync worker already stores the message + a slack_files
// row (with mimetype / url_private) — but it never listens to the audio,
// so the spoken content is invisible to search + Delta. This worker
// fills that gap:
//
//   1. Find synced messages that attach an audio file and haven't been
//      transcribed yet (slack_messages.transcript_status IS NULL).
//   2. Download the audio (via slack.fetchFileBytes — user token for DMs,
//      bot token for channels).
//   3. Transcribe with gpt-4o-transcribe (better on non-English than
//      whisper-1).
//   4. Detect language; for non-English (Farsi) ALSO translate to English
//      so it's searchable + understandable. Farsi is flagged downstream
//      as "auto-transcribed, may be imperfect" so it never reads as fact.
//   5. Store transcript / transcript_en / transcript_lang on the message.
//
// Paced: a handful per cycle so the backlog drains without hammering the
// OpenAI API or Slack rate limits. Transcription cost ≈ $0.006/min audio.

const { pool } = require("./db");
const slack = require("./slack");
const transcribe = require("./transcribe");

const AUDIO_FILETYPES = ["m4a", "mp4", "mp3", "webm", "ogg", "oga", "wav", "amr", "aac", "flac", "mpga", "opus"];

function isAudioFile(f) {
  if (!f) return false;
  if (f.mimetype && /^audio\//i.test(f.mimetype)) return true;
  if (f.filetype && AUDIO_FILETYPES.includes(String(f.filetype).toLowerCase())) return true;
  return false;
}

// TI user ids that have a Slack user token — needed to download DM files.
async function connectedUserIds() {
  const r = await pool.query(`SELECT DISTINCT user_id FROM slack_user_tokens ORDER BY user_id`);
  return r.rows.map((x) => x.user_id);
}

async function markStatus(row, status) {
  await pool.query(
    `UPDATE slack_messages SET transcript_status = $4
       WHERE team_id = $1 AND channel_id = $2 AND ts = $3`,
    [row.team_id, row.channel_id, row.ts, status],
  );
}

// Transcribe up to `limit` pending voice notes. Returns { ok, processed }.
async function transcribePending({ limit = 5 } = {}) {
  if (!transcribe.isEnabled()) return { ok: false, reason: "transcribe_not_configured", processed: 0 };

  const audioFiletypeList = AUDIO_FILETYPES.map((t) => `'${t}'`).join(",");
  const r = await pool.query(
    `SELECT m.team_id, m.channel_id, m.ts, m.file_ids
       FROM slack_messages m
      WHERE m.transcript_status IS NULL
        AND m.file_ids IS NOT NULL
        AND array_length(m.file_ids, 1) > 0
        AND EXISTS (
          SELECT 1 FROM slack_files f
           WHERE f.file_id = ANY(m.file_ids)
             AND (f.mimetype ILIKE 'audio/%' OR lower(f.filetype) IN (${audioFiletypeList}))
        )
      ORDER BY m.ts DESC
      LIMIT $1`,
    [limit],
  );
  if (!r.rows.length) return { ok: true, processed: 0 };

  const userIds = await connectedUserIds();
  if (!userIds.length) return { ok: false, reason: "no_connected_slack_user", processed: 0 };

  let processed = 0;
  for (const row of r.rows) {
    try {
      // First audio file attached to this message.
      const fr = await pool.query(
        `SELECT file_id, mimetype, filetype FROM slack_files
          WHERE file_id = ANY($1)
            AND (mimetype ILIKE 'audio/%' OR lower(filetype) IN (${audioFiletypeList}))
          LIMIT 1`,
        [row.file_ids],
      );
      const audio = fr.rows[0];
      if (!audio) { await markStatus(row, "no_audio"); continue; }

      // Download — try each connected user's token (covers DMs + channels).
      let bytes = null;
      let mime = audio.mimetype || "audio/mp4";
      for (const uid of userIds) {
        try {
          const dl = await slack.fetchFileBytes(uid, audio.file_id);
          if (dl?.bytes?.length) { bytes = dl.bytes; mime = dl.meta?.mimetype || mime; break; }
        } catch (_) { /* try next token */ }
      }
      if (!bytes || !bytes.length) { await markStatus(row, "error"); continue; }

      // Transcribe with the better multilingual model.
      const { text } = await transcribe.transcribe(bytes, { mime, model: "gpt-4o-transcribe" });
      const clean = (text || "").trim();
      if (!clean) { await markStatus(row, "empty"); continue; }

      const lang = transcribe.detectLang(clean);
      let en = null;
      if (lang !== "en") {
        en = (await transcribe.translateToEnglish(clean)) || null;
      }

      await pool.query(
        `UPDATE slack_messages
            SET transcript = $4, transcript_en = $5, transcript_lang = $6, transcript_status = 'done'
          WHERE team_id = $1 AND channel_id = $2 AND ts = $3`,
        [row.team_id, row.channel_id, row.ts, clean, en, lang],
      );
      processed++;
    } catch (err) {
      console.warn("[slackVoice] transcription failed for ts", row.ts, "-", err.message);
      try { await markStatus(row, "error"); } catch (_) {}
    }
  }
  return { ok: true, processed };
}

// Reset 'error' rows back to pending so the next cycle retries them
// (e.g. after a token refresh). Returns how many were reset.
async function resetErrors() {
  const r = await pool.query(
    `UPDATE slack_messages SET transcript_status = NULL WHERE transcript_status = 'error'`,
  );
  return r.rowCount || 0;
}

// How many voice notes are transcribed / pending — for the admin endpoint.
async function stats() {
  const audioFiletypeList = AUDIO_FILETYPES.map((t) => `'${t}'`).join(",");
  const r = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE m.transcript_status = 'done')  AS done,
        COUNT(*) FILTER (WHERE m.transcript_status IS NULL)   AS pending,
        COUNT(*) FILTER (WHERE m.transcript_status = 'error') AS errored
       FROM slack_messages m
      WHERE m.file_ids IS NOT NULL AND array_length(m.file_ids,1) > 0
        AND EXISTS (
          SELECT 1 FROM slack_files f
           WHERE f.file_id = ANY(m.file_ids)
             AND (f.mimetype ILIKE 'audio/%' OR lower(f.filetype) IN (${audioFiletypeList}))
        )`,
  );
  return r.rows[0] || { done: 0, pending: 0, errored: 0 };
}

module.exports = { transcribePending, resetErrors, stats, isAudioFile };
