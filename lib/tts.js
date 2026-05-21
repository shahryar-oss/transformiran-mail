// Delta TTS — Phase 5.AH. Voice output for Delta replies.
//
// Two providers supported, picked at request time:
//
//   1. ElevenLabs    — preferred if ELEVENLABS_API_KEY is set. Higher
//                       quality, more expensive (~$0.30/min).
//                       Default voice: "Rachel" (warm female narrator).
//   2. OpenAI TTS    — fallback if only OPENAI_API_KEY is set. Cheap
//                       (~$0.015/min), still good quality.
//                       Default voice: "alloy" (neutral, calm).
//
// Graceful degradation: if neither key is set, isEnabled() returns
// false and the /api/tts endpoint 503s with a clear message. The chat
// UI surfaces the Listen button only when isEnabled is true.
//
// Input safety:
//   - Hard cap of MAX_CHARS on the text. Longer text is truncated to
//     avoid runaway cost from an accidental novel-length reply.
//   - cleanForTTS() strips markdown formatting and Delta's email-ref
//     syntax so the listener doesn't hear "open square bracket pearl
//     close bracket open paren e-mail colon one nine e four…".

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY || "";
const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY || "";

// Limits — TTS is the most expensive per-character action, so we cap
// even when the chat reply itself is longer.
const MAX_CHARS = 3500;

// ---------- defaults ----------

// OpenAI TTS voices: alloy, echo, fable, onyx, nova, shimmer. "Alloy"
// is the most neutral for a professional EA tone.
const DEFAULT_OPENAI_VOICE = "alloy";
const DEFAULT_OPENAI_MODEL = "tts-1"; // tts-1-hd is 2x cost, marginal quality lift

// ElevenLabs default voice = "Rachel" (their stock warm-female narrator).
// Voice IDs from https://api.elevenlabs.io/v1/voices.
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_ELEVENLABS_MODEL = "eleven_turbo_v2_5"; // low-latency

// ---------- helpers ----------

function isEnabled() {
  return !!(OPENAI_API_KEY() || ELEVENLABS_API_KEY());
}

function providerInUse() {
  if (ELEVENLABS_API_KEY()) return "elevenlabs";
  if (OPENAI_API_KEY()) return "openai";
  return null;
}

// Strip markdown + Delta's email-ref syntax + URL noise so the spoken
// output doesn't include formatting characters or unreadable slugs.
function cleanForTTS(text) {
  if (!text) return "";
  let s = String(text);

  // [link text](email:abc123)  →  "link text"
  s = s.replace(/\[([^\]]+)\]\(email:[^)]+\)/g, "$1");
  // [link text](http(s)://…)    →  "link text"
  s = s.replace(/\[([^\]]+)\]\(https?:[^)]+\)/g, "$1");
  // bare URLs → drop them (rarely useful to read out)
  s = s.replace(/\bhttps?:\/\/\S+/g, "");
  // Bold / italic markdown markers
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(?<!\*)\*(?!\*)([^*]+)\*/g, "$1");
  s = s.replace(/(?<!_)_(?!_)([^_]+)_/g, "$1");
  // Inline code + code blocks
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]+)`/g, "$1");
  // Heading hashes
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Bullet markers — replace with comma so the reader pauses naturally
  s = s.replace(/^[ \t]*[-*•][ \t]+/gm, "");
  // Numbered lists → drop the "1." marker
  s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
  // Excessive blank lines
  s = s.replace(/\n{3,}/g, "\n\n");
  // Pipe-delimited table rows → spoken commas
  s = s.replace(/\|/g, ",");
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " ").trim();
  return s;
}

// Truncate to MAX_CHARS at a clean sentence/word boundary so we don't
// cut mid-word (sounds jarring on playback).
function truncateForTTS(text, limit = MAX_CHARS) {
  if (!text || text.length <= limit) return text;
  const slice = text.slice(0, limit);
  // Prefer cutting at the last sentence end.
  const lastSentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("\n")
  );
  if (lastSentence > limit * 0.5) {
    return slice.slice(0, lastSentence + 1);
  }
  // Fallback: cut at last space.
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}

// ---------- providers ----------

async function synthesizeWithOpenAI(text, { voice = DEFAULT_OPENAI_VOICE, model = DEFAULT_OPENAI_MODEL } = {}) {
  const key = OPENAI_API_KEY();
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: "mp3",
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return { provider: "openai", voice, model, mime: "audio/mpeg", buffer: buf };
}

async function synthesizeWithElevenLabs(text, { voice = DEFAULT_ELEVENLABS_VOICE, model = DEFAULT_ELEVENLABS_MODEL } = {}) {
  const key = ELEVENLABS_API_KEY();
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?optimize_streaming_latency=2`, {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Accept": "audio/mpeg",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${resp.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return { provider: "elevenlabs", voice, model, mime: "audio/mpeg", buffer: buf };
}

// Main entrypoint. Caller passes raw text (probably from a Delta reply);
// we clean it, cap it, then route to the available provider.
async function synthesize(rawText, options = {}) {
  if (!isEnabled()) {
    throw new Error("tts_not_configured");
  }
  const cleaned = truncateForTTS(cleanForTTS(rawText));
  if (!cleaned) throw new Error("empty_text");

  // Respect explicit provider hint if passed, else prefer ElevenLabs
  // when both keys are set.
  const provider = options.provider
    || (ELEVENLABS_API_KEY() ? "elevenlabs" : "openai");

  if (provider === "elevenlabs") {
    return synthesizeWithElevenLabs(cleaned, options);
  }
  return synthesizeWithOpenAI(cleaned, options);
}

module.exports = {
  isEnabled,
  providerInUse,
  synthesize,
  cleanForTTS,
  truncateForTTS,
  MAX_CHARS,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_ELEVENLABS_VOICE,
};
