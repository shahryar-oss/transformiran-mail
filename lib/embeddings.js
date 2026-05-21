// Embedding wrapper — OpenAI text-embedding-3-small. Used by Phase 5.AC
// semantic memory recall. Gracefully no-ops when OPENAI_API_KEY isn't set,
// so the rest of the app keeps working with keyword-only memory search.
//
// Cost: ~$0.02 per 1M tokens. A typical memory row is ~50 tokens, so
// embedding 1000 memories costs ~$0.001. Per-query embed is ~$0.0000002.

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;     // native size for text-embedding-3-small

function isEnabled() {
  return !!process.env.OPENAI_API_KEY;
}

async function embedText(text) {
  if (!isEnabled()) return null;
  if (!text || typeof text !== "string") return null;
  const clean = text.trim().slice(0, 8000);   // 8k char cap for safety
  if (!clean) return null;

  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: clean,
        encoding_format: "float",
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.warn(`[embeddings] OpenAI returned ${r.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = await r.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== DIMENSIONS) {
      console.warn("[embeddings] unexpected response shape");
      return null;
    }
    return vec;
  } catch (err) {
    console.warn("[embeddings] embedText failed:", err.message);
    return null;
  }
}

// Cosine similarity between two equal-length vectors.
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = {
  isEnabled,
  embedText,
  cosineSimilarity,
  MODEL,
  DIMENSIONS,
};
