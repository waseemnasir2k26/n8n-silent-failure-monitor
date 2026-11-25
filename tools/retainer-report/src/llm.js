"use strict";
const { redact, secretsFromEnv } = require("./redact");

// Only aggregates leave the machine: totals, no workflow names, no ids, no execution rows.
function aggregatesFor(r, currency) {
  return {
    period: r.period.start + " to " + r.period.end,
    runs: r.runs,
    successful: r.success,
    errors: r.errors,
    errorRatePercent: r.errorRate,
    autoRecovered: r.recovered,
    needManualLook: r.unrecovered,
    estimatedHoursSaved: r.hoursSaved,
    estimatedValue: r.value,
    currency: currency || "$",
    runsChangePercentVsPrevious: r.change.runs.pct,
    errorsChangeVsPrevious: r.change.errors.abs,
  };
}

const PROMPT =
  "You write a 3-sentence summary of an automation retainer report for a small-business client. " +
  'Use ONLY the numbers in the JSON. Do not invent causes, fixes or numbers. Say "estimated" for hours and value. ' +
  "Plain, calm tone, no hype, no emoji. Output the 3 sentences only.";

function clean(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, 700) : null;
}

async function post(fetchImpl, url, headers, body) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// Returns { text, provider } or null. Never throws; a failure just means no narrative.
async function narrative(r, { env, currency, fetchImpl, warn }) {
  const f = fetchImpl || globalThis.fetch;
  const data = JSON.stringify(aggregatesFor(r, currency));
  const secrets = secretsFromEnv(env);
  const say = warn || (() => {});
  if (env.GROQ_API_KEY) {
    try {
      const j = await post(
        f,
        "https://api.groq.com/openai/v1/chat/completions",
        { authorization: "Bearer " + env.GROQ_API_KEY },
        {
          model: /^[\w.-]+$/.test(env.GROQ_MODEL || "")
            ? env.GROQ_MODEL
            : "llama-3.3-70b-versatile",
          temperature: 0.2,
          max_tokens: 250,
          messages: [
            { role: "system", content: PROMPT },
            { role: "user", content: data },
          ],
        },
      );
      const text = clean(
        j.choices &&
          j.choices[0] &&
          j.choices[0].message &&
          j.choices[0].message.content,
      );
      if (text) return { text, provider: "groq" };
    } catch (e) {
      say("Groq narrative failed: " + redact(e.message, secrets));
    }
  }
  if (env.GEMINI_API_KEY) {
    try {
      const model = /^[\w.-]+$/.test(env.GEMINI_MODEL || "")
        ? env.GEMINI_MODEL
        : "gemini-2.0-flash";
      const j = await post(
        f,
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          model +
          ":generateContent",
        { "x-goog-api-key": env.GEMINI_API_KEY },
        {
          systemInstruction: { parts: [{ text: PROMPT }] },
          contents: [{ role: "user", parts: [{ text: data }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 250 },
        },
      );
      const text = clean(
        j.candidates &&
          j.candidates[0] &&
          j.candidates[0].content &&
          j.candidates[0].content.parts &&
          j.candidates[0].content.parts.map((p) => p.text || "").join(" "),
      );
      if (text) return { text, provider: "gemini" };
    } catch (e) {
      say("Gemini narrative failed: " + redact(e.message, secrets));
    }
  }
  if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY)
    say("No GROQ_API_KEY or GEMINI_API_KEY set, skipping narrative.");
  return null;
}

module.exports = { narrative, aggregatesFor };
