// Delta Voice Input — Phase 5.AI. Wraps OpenAI's Whisper API.
//
// Frontend records audio via MediaRecorder (webm or mp4 depending on
// browser). Client POSTs the blob to /api/transcribe as multipart
// form-data. We forward it to OpenAI's audio.transcriptions endpoint.
//
// Gracefully no-ops if OPENAI_API_KEY isn't set — the /api/transcribe
// endpoint 503s with a clear message and the mic button stays disabled.

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY || "";
const MODEL = "whisper-1"; // OpenAI's GA Whisper API. 4o-mini-transcribe is
                           // newer/cheaper but Whisper-1 is more lenient
                           // about codec/container variations.

function isEnabled() {
  return !!OPENAI_API_KEY();
}

// Transcribe an audio buffer. mime is the source MIME type ("audio/webm",
// "audio/mp4", "audio/ogg" etc) — OpenAI inspects the file content but
// also looks at the filename extension, so we synthesise one.
async function transcribe(buffer, { mime = "audio/webm", language = null } = {}) {
  if (!isEnabled()) {
    throw new Error("transcribe_not_configured");
  }
  if (!buffer || !buffer.length) {
    throw new Error("empty_audio");
  }

  // Pick a plausible filename extension from the mime — OpenAI is
  // picky about this even though it inspects content too.
  const ext = mime.includes("mp4") ? "mp4"
            : mime.includes("ogg") ? "ogg"
            : mime.includes("wav") ? "wav"
            : mime.includes("mpeg") || mime.includes("mp3") ? "mp3"
            : "webm";

  const form = new FormData();
  // Node 20+ Blob from Buffer
  const blob = new Blob([buffer], { type: mime });
  form.append("file", blob, `recording.${ext}`);
  form.append("model", MODEL);
  if (language) form.append("language", language);
  // Verbose response gives us duration etc — useful for analytics later.
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
    throw new Error(`Whisper ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  return { text: json.text || "", model: MODEL };
}

module.exports = {
  isEnabled,
  transcribe,
  MODEL,
};
