// Delta Voice Input — Phase 5.AI. Wraps OpenAI's Whisper API.
//
// Frontend records audio via MediaRecorder (webm or mp4 depending on
// browser). Client POSTs the blob to /api/transcribe as multipart
// form-data. We forward it to OpenAI's audio.transcriptions endpoint.
//
// Gracefully no-ops if OPENAI_API_KEY isn't set — the /api/transcribe
// endpoint 503s with a clear message and the mic button stays disabled.

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY || "";
const MODEL = "whisper-1"; // Default for the real-time voice-input path —
                           // Whisper-1 is the most lenient about the codec /
                           // container variations a browser MediaRecorder
                           // produces. The Slack voice-note path passes
                           // model:"gpt-4o-transcribe" instead (Phase 5.CV) —
                           // materially better on non-English incl. Farsi.

function isEnabled() {
  return !!OPENAI_API_KEY();
}

// Transcribe an audio buffer. mime is the source MIME type ("audio/webm",
// "audio/mp4", "audio/ogg" etc) — OpenAI inspects the file content but
// also looks at the filename extension, so we synthesise one. `model`
// lets callers pick gpt-4o-transcribe (better multilingual) vs whisper-1.
async function transcribe(buffer, { mime = "audio/webm", language = null, model = MODEL } = {}) {
  if (!isEnabled()) {
    throw new Error("transcribe_not_configured");
  }
  if (!buffer || !buffer.length) {
    throw new Error("empty_audio");
  }

  // Pick a plausible filename extension from the mime — OpenAI is
  // picky about this even though it inspects content too.
  const ext = mime.includes("mp4") || mime.includes("m4a") ? "mp4"
            : mime.includes("ogg") || mime.includes("opus") ? "ogg"
            : mime.includes("wav") ? "wav"
            : mime.includes("mpeg") || mime.includes("mp3") ? "mp3"
            : mime.includes("aac") ? "aac"
            : mime.includes("flac") ? "flac"
            : "webm";

  const form = new FormData();
  // Node 20+ Blob from Buffer
  const blob = new Blob([buffer], { type: mime });
  form.append("file", blob, `recording.${ext}`);
  form.append("model", model);
  if (language) form.append("language", language);
  // gpt-4o-transcribe only supports json / text response formats (no
  // verbose_json); json works for both models.
  form.append("response_format", "json");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY()}`,
      // NOTE: do NOT set Content-Type; fetch will set the multipart boundary.
    },
    body: form,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Transcribe ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  return { text: json.text || "", model };
}

// Best-effort language detection by script. We only need to know whether
// a transcript is in a Perso-Arabic script (Farsi) so we can flag it as
// "may be imperfect" + provide an English translation. Returns "fa" when
// the text is predominantly Arabic-script, else "en".
function detectLang(text) {
  const s = String(text || "");
  if (!s.trim()) return "en";
  // Arabic block U+0600–U+06FF + Persian extras. Count vs Latin letters.
  const arabic = (s.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) || []).length;
  const latin  = (s.match(/[A-Za-z]/g) || []).length;
  if (arabic === 0) return "en";
  if (arabic >= latin) return "fa";
  return arabic > latin * 0.3 ? "fa" : "en";
}

// Translate a transcript to English via a cheap chat model. Used for
// non-English (Farsi) voice notes so the content is searchable +
// understandable. Returns "" on failure (caller keeps the original).
async function translateToEnglish(text) {
  if (!isEnabled()) return "";
  const src = String(text || "").trim();
  if (!src) return "";
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: "You are a translator. Translate the user's message to natural English. Output ONLY the translation — no notes, no quotes, no preamble." },
          { role: "user", content: src.slice(0, 8000) },
        ],
      }),
    });
    if (!resp.ok) return "";
    const json = await resp.json();
    return (json.choices?.[0]?.message?.content || "").trim();
  } catch (_) {
    return "";
  }
}

module.exports = {
  isEnabled,
  transcribe,
  detectLang,
  translateToEnglish,
  MODEL,
};
