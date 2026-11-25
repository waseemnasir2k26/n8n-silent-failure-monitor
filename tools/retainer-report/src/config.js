"use strict";
const fs = require("fs");

class ConfigError extends Error {}

function validateConfig(raw) {
  const errs = [];
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!c) throw new ConfigError("Config must be a JSON object");
  const client = typeof c.client === "string" ? c.client.trim() : "";
  if (!client) errs.push('"client" must be a non-empty string');

  let hourlyRate = null;
  if (c.hourlyRate != null) {
    if (
      typeof c.hourlyRate !== "number" ||
      !Number.isFinite(c.hourlyRate) ||
      c.hourlyRate < 0 ||
      c.hourlyRate > 10000
    )
      errs.push('"hourlyRate" must be a finite number from 0 to 10000');
    else hourlyRate = c.hourlyRate;
  }
  let recoveryWindowMinutes = 60;
  if (c.recoveryWindowMinutes != null) {
    const v = c.recoveryWindowMinutes;
    if (!Number.isInteger(v) || v < 1 || v > 1440)
      errs.push('"recoveryWindowMinutes" must be an integer from 1 to 1440');
    else recoveryWindowMinutes = v;
  }
  const notes = [];
  if (c.notes != null) {
    if (
      !Array.isArray(c.notes) ||
      c.notes.length > 10 ||
      c.notes.some((n) => typeof n !== "string" || !n.trim() || n.length > 300)
    ) {
      errs.push(
        '"notes" must be an array of up to 10 non-empty strings (max 300 chars each)',
      );
    } else notes.push(...c.notes.map((n) => n.trim()));
  }
  for (const k of ["agency", "nextStep", "currency", "contactName"]) {
    if (c[k] != null && typeof c[k] !== "string")
      errs.push('"' + k + '" must be a string');
  }
  const workflows = [];
  if (!Array.isArray(c.workflows) || c.workflows.length === 0) {
    errs.push('"workflows" must be a non-empty array');
  } else {
    c.workflows.forEach((w, i) => {
      const at = "workflows[" + i + "]";
      if (!w || typeof w !== "object")
        return errs.push(at + " must be an object");
      const idOk =
        (typeof w.id === "string" && w.id.trim() !== "") ||
        (typeof w.id === "number" && Number.isInteger(w.id));
      if (w.id != null && !idOk)
        errs.push(at + ".id must be a string or an integer");
      const hasId = idOk;
      const hasTag = typeof w.tag === "string" && w.tag.trim() !== "";
      if (hasId === hasTag)
        errs.push(at + ' needs exactly one of "id" or "tag"');
      let minutes = null;
      if (w.minutesSavedPerSuccessfulRun != null) {
        const m = w.minutesSavedPerSuccessfulRun;
        if (typeof m !== "number" || !Number.isFinite(m) || m < 0 || m > 600)
          errs.push(
            at +
              ".minutesSavedPerSuccessfulRun must be a number from 0 to 600",
          );
        else minutes = m;
      }
      if (w.label != null && typeof w.label !== "string")
        errs.push(at + ".label must be a string");
      workflows.push({
        id: hasId ? String(w.id).trim() : null,
        tag: hasTag ? w.tag.trim() : null,
        label: w.label || null,
        minutes,
      });
    });
  }
  if (errs.length)
    throw new ConfigError("Invalid config:\n- " + errs.join("\n- "));
  return {
    client,
    agency: c.agency || "",
    contactName: String(c.contactName || "").replace(/[\r\n]+/g, " ").trim(),
    nextStep: c.nextStep || "",
    currency: c.currency || "$",
    hourlyRate,
    recoveryWindowMinutes,
    notes,
    workflows,
  };
}

function loadConfig(path) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError("Cannot read config " + path + ": " + e.code);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(
      "Config " + path + " is not valid JSON: " + e.message,
    );
  }
  return validateConfig(raw);
}

// Expand id/tag entries into concrete [{id,label,minutes}] using the workflow list (names + tags).
function resolveWorkflows(cfg, apiWorkflows) {
  const byId = new Map(apiWorkflows.map((w) => [w.id, w]));
  const out = new Map();
  const warnings = [];
  for (const w of cfg.workflows) {
    if (w.id) {
      if (!out.has(w.id)) {
        const known = byId.get(w.id);
        if (!known && apiWorkflows.length)
          warnings.push(
            "Workflow id " + w.id + " was not found in the workflow list",
          );
        out.set(w.id, {
          id: w.id,
          label: w.label || (known && known.name) || w.id,
          minutes: w.minutes,
        });
      }
    } else {
      const t = w.tag.toLowerCase();
      const hits = apiWorkflows.filter((a) =>
        a.tags.some(
          (x) =>
            String(x.name || "").toLowerCase() === t || String(x.id) === w.tag,
        ),
      );
      if (!hits.length)
        warnings.push('Tag "' + w.tag + '" matched no workflows');
      for (const h of hits)
        if (!out.has(h.id))
          out.set(h.id, {
            id: h.id,
            label: h.name || h.id,
            minutes: w.minutes,
          });
    }
  }
  return { workflows: [...out.values()], warnings };
}

module.exports = { validateConfig, loadConfig, resolveWorkflows, ConfigError };
