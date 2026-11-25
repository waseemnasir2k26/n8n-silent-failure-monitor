"use strict";
// Config lists client names and the NAMES of environment variables. Never values.
// {
//   "defaults": { "factor": 2, "failRuns": 3, "webhookMaxSilence": "48h" },
//   "clients": [
//     { "name": "Client A", "urlEnv": "CLIENT_A_N8N_URL", "keyEnv": "CLIENT_A_N8N_KEY",
//       "webhookMaxSilence": { "default": "24h", "workflows": { "Order intake": "6h" } } },
//     { "name": "Offline export", "file": "exports/client-b.json" }
//   ]
// }
const fs = require("fs");
const { parseDuration } = require("./duration");

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRETISH = new Set([
  "url",
  "key",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
]);

function silenceFrom(v, where) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") {
    const ms = parseDuration(v);
    if (!ms)
      throw new Error(
        `${where}: cannot read duration ${JSON.stringify(v)} (use 30m, 24h, 2d)`,
      );
    return { defaultMs: ms, byWorkflow: {} };
  }
  const out = { defaultMs: null, byWorkflow: {} };
  if (v.default != null) {
    out.defaultMs = parseDuration(v.default);
    if (!out.defaultMs) throw new Error(`${where}.default: bad duration`);
  }
  for (const [k, d] of Object.entries(v.workflows || {})) {
    const ms = parseDuration(d);
    if (!ms) throw new Error(`${where}.workflows["${k}"]: bad duration`);
    out.byWorkflow[k] = ms;
  }
  return out;
}

function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read config ${path}: ${e.message}`);
  }
  if (!raw || !Array.isArray(raw.clients) || !raw.clients.length)
    throw new Error('config needs a non-empty "clients" array');
  const d = raw.defaults || {};
  const defaults = {
    factor: d.factor ?? 2,
    failRuns: d.failRuns ?? 3,
    webhookSilence: silenceFrom(
      d.webhookMaxSilence,
      "defaults.webhookMaxSilence",
    ),
  };
  const clients = raw.clients.map((c, i) => {
    const where = `clients[${i}]`;
    if (!c || typeof c.name !== "string" || !c.name.trim())
      throw new Error(`${where}: "name" is required`);
    for (const k of Object.keys(c))
      if (SECRETISH.has(k.toLowerCase()))
        throw new Error(
          `${where}: key "${k}" is not allowed. Put the env var NAME in urlEnv / keyEnv instead.`,
        );
    if (c.file)
      return {
        name: c.name,
        file: String(c.file),
        webhookSilence: silenceFrom(
          c.webhookMaxSilence,
          `${where}.webhookMaxSilence`,
        ),
      };
    for (const k of ["urlEnv", "keyEnv"]) {
      if (typeof c[k] !== "string" || !ENV_NAME.test(c[k]))
        throw new Error(
          `${where}.${k} must be an environment variable NAME such as CLIENT_A_N8N_URL, not a value`,
        );
    }
    return {
      name: c.name,
      urlEnv: c.urlEnv,
      keyEnv: c.keyEnv,
      webhookSilence: silenceFrom(
        c.webhookMaxSilence,
        `${where}.webhookMaxSilence`,
      ),
    };
  });
  return { defaults, clients };
}

module.exports = { loadConfig, silenceFrom };
