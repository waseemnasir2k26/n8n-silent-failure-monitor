"use strict";
// Core verdict logic. Pure: no network, no clock (callers pass `now`).
// Execution fields used (n8n public API, GET /executions): id, status, startedAt, stoppedAt, workflowId.
// status values: canceled | crashed | error | new | running | success | unknown | waiting.
const { describeTrigger } = require("./schedule");
const { formatDuration } = require("./duration");

const FAIL = new Set(["error", "crashed"]);
const DEFAULTS = { factor: 2, failN: 3, minGraceMs: 10 * 6e4 };

// Timestamps may carry any offset ("Z", "+08:00"); Date.parse turns them into the same instant.
function ts(v) {
  if (v == null) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function isActive(w) {
  if (w.isArchived === true) return false;
  if (w.active === true) return true;
  return w.activeVersionId != null && w.active !== false; // newer n8n: active is deprecated in favour of activeVersionId
}

function evaluateWorkflow(workflow, executions, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now;
  const base = {
    id: String(workflow.id),
    name: String(workflow.name || workflow.id),
  };
  const trig = describeTrigger(workflow);
  const row = (status, extra) => ({
    ...base,
    trigger: trig.text,
    expectedMs: trig.intervalMs,
    lastRunAt: null,
    lastSuccessAt: null,
    detail: "",
    ...extra,
    status,
  });

  if (!isActive(workflow)) return row("DISABLED", { detail: "not active" });
  if (trig.kind === "none") return row("SKIP", { detail: trig.text });

  // newest first, only runs that actually started
  const runs = (executions || [])
    .map((e) => ({
      status: e.status || (e.finished ? "success" : "error"),
      at: ts(e.startedAt),
    }))
    .filter((e) => e.at !== null && e.at <= now + 5 * 6e4)
    .sort((a, b) => b.at - a.at);
  const lastRun = runs[0] || null;
  const lastOk = runs.find((r) => r.status === "success") || null;
  const info = {
    lastRunAt: lastRun ? new Date(lastRun.at).toISOString() : null,
    lastSuccessAt: lastOk ? new Date(lastOk.at).toISOString() : null,
  };

  let limitMs;
  let expectedLabel;
  if (trig.kind === "schedule") {
    if (!trig.intervalMs)
      return row("SKIP", {
        ...info,
        detail: "schedule could not be read; not checked",
      });
    limitMs = Math.max(o.factor * trig.intervalMs, o.minGraceMs);
    expectedLabel = `every ${formatDuration(trig.intervalMs)}`;
  } else {
    limitMs = o.webhookMaxSilenceMs || null;
    if (!limitMs)
      return row("OK", {
        ...info,
        detail: "webhook, no max-silence set, not checked",
      });
    expectedLabel = `max silence ${formatDuration(limitMs)}`;
  }

  if (!lastRun) {
    const born = ts(workflow.updatedAt) ?? ts(workflow.createdAt);
    if (born !== null && now - born <= limitMs)
      return row("OK", {
        detail: "no runs yet, recently changed (grace period)",
      });
    return row("STALLED", {
      detail:
        "never ran" +
        (born !== null
          ? `, last changed ${formatDuration(now - born)} ago`
          : ""),
    });
  }

  const sinceRun = now - lastRun.at;
  if (sinceRun > limitMs)
    return row("STALLED", {
      ...info,
      detail: `no run for ${formatDuration(sinceRun)} (limit ${formatDuration(limitMs)}, ${expectedLabel})`,
    });

  if (trig.kind === "schedule") {
    const finished = runs.filter(
      (r) => r.status === "success" || FAIL.has(r.status),
    );
    const lastN = finished.slice(0, o.failN);
    if (lastN.length === o.failN && lastN.every((r) => FAIL.has(r.status)))
      return row("FAILING", {
        ...info,
        detail:
          `last ${o.failN} runs errored` +
          (lastOk
            ? `, last success ${formatDuration(now - lastOk.at)} ago`
            : ", no success on record"),
      });
    if (
      finished.length &&
      (!lastOk || now - lastOk.at > limitMs) &&
      FAIL.has(finished[0].status)
    )
      return row("FAILING", {
        ...info,
        detail: lastOk
          ? `no success for ${formatDuration(now - lastOk.at)}, runs are erroring`
          : "no success on record, runs are erroring",
      });
  }
  return row("OK", {
    ...info,
    detail: `last run ${formatDuration(sinceRun)} ago`,
  });
}

// Per-workflow max silence for webhooks: map keyed by workflow id or exact name, plus a default.
function webhookLimitFor(workflow, silenceCfg) {
  if (!silenceCfg) return null;
  const { byWorkflow = {}, defaultMs = null } = silenceCfg;
  return (
    byWorkflow[String(workflow.id)] ??
    byWorkflow[String(workflow.name)] ??
    defaultMs ??
    null
  );
}

function evaluateAll(workflows, executionsByWorkflow, opts = {}) {
  return workflows.map((w) => {
    const execs = executionsByWorkflow[String(w.id)] || [];
    return evaluateWorkflow(w, execs, {
      ...opts,
      webhookMaxSilenceMs: webhookLimitFor(w, opts.webhookSilence),
    });
  });
}

module.exports = { evaluateWorkflow, evaluateAll, isActive, DEFAULTS };
