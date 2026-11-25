"use strict";

// Replace every occurrence of each secret (and any X-N8N-API-KEY header echo) before text is logged or written.
function redact(text, secrets) {
  let s = String(text == null ? "" : text);
  for (const sec of secrets || []) {
    if (typeof sec === "string" && sec.length >= 4)
      s = s.split(sec).join("[redacted]");
  }
  return s.replace(
    /(x-n8n-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    "$1[redacted]",
  );
}

function secretsFromEnv(env) {
  return [env.N8N_API_KEY, env.GROQ_API_KEY, env.GEMINI_API_KEY].filter(
    Boolean,
  );
}

module.exports = { redact, secretsFromEnv };
