"use strict";
// One shared scrub for every string that is written anywhere (graph.json, report.html,
// report.md, blast and spof text and --json). buildGraph() and loadGraph() both finish
// with sanitizeGraph(), so no output path can bypass it.
//
// Token rule, for any run of 16+ characters without whitespace:
//   1. letters + digits mixed, with at least 2 letter/digit switches, entropy >= 3.5 bits/char
//   2. mixed case with lower-to-upper switches >= length / 3, or a camelCase split that
//      yields a word no human name has (aB, Zq, a vowel-less 4+ letter word, 5+ capitals)
//   3. UUID anywhere, or a hex run of 24+
//   4. base64url-looking run of 24+ (mixed case or digits) with entropy >= 4
// Rules 1 and 2 are checked per segment (split on "-" and "_") so that long hyphenated
// words such as "appointment-reminders-weekly" stay readable.

const { scrubText } = require("./secrets");
const { clean } = require("./util");

const RUN = /[A-Za-z0-9_+=-]{16,}/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const SHORT_WORDS = new Set(
  "a i v to on my id in of at by is it up go do ai mc me we or an as be no so us ok hi".split(
    " ",
  ),
);

function segmentLooksRandom(seg) {
  if (seg.length < 16) return false;
  const letters = /[A-Za-z]/.test(seg);
  const digits = /[0-9]/.test(seg);
  if (letters && digits) {
    let sw = 0;
    for (let i = 1; i < seg.length; i++)
      if (/[0-9]/.test(seg[i]) !== /[0-9]/.test(seg[i - 1])) sw++;
    if (sw >= 2 && entropy(seg) >= 3.5) return true;
  }
  let up = 0;
  for (let i = 1; i < seg.length; i++)
    if (/[a-z]/.test(seg[i - 1]) && /[A-Z]/.test(seg[i])) up++;
  if (up >= seg.length / 3) return true;
  // Word shape. Split camelCase into words; real names are made of words with vowels,
  // short acronyms and common short words. A random mixed-case run almost always holds
  // a one-lowercase-letter "word" (aB, Zq), a vowel-less 4+ letter word or a long
  // capital run.
  const words = seg.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) || [];
  return words.some(
    (w) =>
      (/^[A-Z]?[a-z]$/.test(w) && !SHORT_WORDS.has(w.toLowerCase())) ||
      /^[A-Z]{5,}$/.test(w) ||
      (/^[A-Z]?[a-z]{4,}$/.test(w) && !/[aeiouy]/i.test(w)),
  );
}

function runLooksRandom(run) {
  if (run.length < 16) return false;
  if (/^[0-9a-f]{24,}$/i.test(run)) return true;
  if (
    run.length >= 24 &&
    /^[A-Za-z0-9_-]+$/.test(run) &&
    (/[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run))) &&
    entropy(run) >= 4
  )
    return true;
  return run.split(/[-_]/).some(segmentLooksRandom);
}

/** True when a single string (no whitespace) looks like a random token or id. */
function tokenish(s) {
  s = String(s);
  UUID.lastIndex = 0;
  if (UUID.test(s)) return true;
  return runLooksRandom(s);
}

/** Replace random-looking runs inside free text. `allow` = exact runs to leave alone (known ids). */
function maskRuns(text, allow) {
  return text
    .replace(UUID, (m) => (allow && allow.has(m) ? m : "[REDACTED]"))
    .replace(RUN, (m) =>
      allow && allow.has(m) ? m : runLooksRandom(m) ? "[REDACTED]" : m,
    );
}

/** Names, labels, sheet and table names, anything a human typed. */
function safe(v, allow) {
  const base = scrubText(clean(v).trim(), { entropy: false });
  return maskRuns(base, allow).slice(0, 300);
}

/** Machine identifiers (ids, hostnames, types): token patterns only, no randomness rule. */
function safeId(v) {
  return scrubText(clean(v).trim(), { entropy: false }).slice(0, 300);
}

/** Webhook path: every random-looking segment becomes {random}; human segments stay. */
function scrubPath(p) {
  return String(p)
    .split("/")
    .map((seg) =>
      seg && (tokenish(seg) || safeId(seg) !== seg) ? "{random}" : seg,
    )
    .join("/");
}

/** Same rule for hostname labels: a random subdomain is hidden, the rest stays. */
function scrubHost(h) {
  return String(h)
    .split(".")
    .map((l) => (tokenish(l) ? "{random}" : l))
    .join(".");
}

// Machine identifiers: n8n ids, node and credential type names (googleSheetsOAuth2Api),
// instance labels, HTTP method, auth mode. Token patterns are still scrubbed; the
// randomness rule is not applied, or type names like "googleDriveOAuth2Api" vanish.
const ID_KEYS = new Set([
  "n8nId",
  "documentId",
  "errorWorkflow",
  "credType",
  "triggerTypes",
  "instance",
  "method",
  "authentication",
  "kind",
]);

/** Final pass over a whole graph. Idempotent. */
function sanitizeGraph(g) {
  const idOf = (s) => safeId(s);
  const nodes = g.nodes.map((n) => {
    const a = n.attrs || {};
    const allow = new Set();
    if (a.n8nId) allow.add(String(a.n8nId));
    if (a.documentId)
      for (const part of String(a.documentId).split("/")) allow.add(part);
    const attrs = {};
    for (const [k, v] of Object.entries(a)) {
      if (ID_KEYS.has(k))
        attrs[k] =
          typeof v === "string"
            ? idOf(v)
            : Array.isArray(v)
              ? v.map((x) => (typeof x === "string" ? idOf(x) : x))
              : v;
      else if (k === "path") attrs[k] = scrubPath(safeId(v));
      else if (typeof v === "string")
        attrs[k] = n.type === "host" ? v : safe(v, allow);
      else if (Array.isArray(v))
        attrs[k] = v.map((x) => (typeof x === "string" ? safe(x, allow) : x));
      else attrs[k] = v;
    }
    let label = n.label;
    if (n.type === "webhook") label = `${attrs.method} /${attrs.path}`;
    else if (n.type === "host") label = scrubHost(safeId(n.label));
    else label = safe(n.label, allow);
    return { id: idOf(n.id), type: n.type, label, attrs };
  });
  const links = g.links.map((l) => ({
    source: idOf(l.source),
    target: idOf(l.target),
    rel: l.rel,
  }));
  const meta = {
    ...g.meta,
    sources: (g.meta.sources || []).map((s) => ({
      ...s,
      label: safe(s.label),
    })),
  };
  return { meta, nodes, links };
}

module.exports = {
  tokenish,
  safe,
  safeId,
  scrubPath,
  scrubHost,
  sanitizeGraph,
  maskRuns,
};
