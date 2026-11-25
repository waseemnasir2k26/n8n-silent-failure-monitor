"use strict";
// Self-contained on purpose (no requires): scripts/build-workflow.js inlines everything
// above the "exports" marker into the n8n Code node, so the CLI and the n8n route
// share one implementation of the numbers and the weekly email.

const DAY = 86400000;

// Bidi control characters can visually reorder text in a client-facing report; strip them.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

function esc(v) {
  return String(v == null ? "" : v)
    .replace(BIDI, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStartUtc(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m)
    throw new Error('Invalid date "' + dateStr + '", expected YYYY-MM-DD');
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (dayOf(ms) !== dateStr) throw new Error('Invalid date "' + dateStr + '"');
  return ms;
}

function normalizeStatus(e) {
  const s = String(e.status || "").toLowerCase();
  if (s === "success") return "success";
  if (s === "error" || s === "crashed" || s === "failed") return "error";
  if (!s && e.finished === true) return "success";
  return "other";
}

// Whitelist: only metadata survives. Payload fields (data, workflowData, ...) are dropped here.
function normalizeExecution(e) {
  if (!e || e.workflowId == null) return null;
  // ISO strings or epoch milliseconds
  const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));
  const startMs = toMs(e.startedAt);
  if (!Number.isFinite(startMs) || Math.abs(startMs) > 8.64e15) return null;
  const stopMs = toMs(e.stoppedAt);
  return {
    id: e.id == null ? null : String(e.id),
    workflowId: String(e.workflowId),
    status: normalizeStatus(e),
    startedAt: new Date(startMs).toISOString(),
    stoppedAt:
      Number.isFinite(stopMs) && Math.abs(stopMs) <= 8.64e15
        ? new Date(stopMs).toISOString()
        : null,
    startMs,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function pctChange(cur, prev) {
  return prev > 0 ? round1(((cur - prev) / prev) * 100) : null;
}

// Same workflowId:id counts once (overlapping live pages, hand-edited offline files).
function dedupeExecutions(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    // Rows without an id cannot be matched, so they are never deduplicated.
    if (e.id != null) {
      const k = e.workflowId + ":" + e.id;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(e);
  }
  return out;
}

function computePeriod(execs, workflows, startMs, endMs, recoveryMin) {
  const tracked = new Map(workflows.map((w) => [String(w.id), w]));
  const mine = execs
    .filter((e) => tracked.has(e.workflowId) && e.status !== "other")
    .sort((a, b) => a.startMs - b.startMs);
  // Recovery: per workflow, one pass over time-ordered runs. A success recovers at most one
  // failure (the oldest one still inside the window); a failure is recovered at most once.
  const recoveredSet = new Set();
  const byWf = new Map();
  for (const e of mine) {
    if (!byWf.has(e.workflowId)) byWf.set(e.workflowId, []);
    byWf.get(e.workflowId).push(e);
  }
  const win = recoveryMin * 60000;
  for (const list of byWf.values()) {
    list.sort(
      (x, y) =>
        x.startMs - y.startMs ||
        (x.status === "success" ? -1 : 1) - (y.status === "success" ? -1 : 1),
    );
    const q = [];
    let head = 0;
    for (const e of list) {
      if (e.status === "error") {
        q.push(e);
        continue;
      }
      while (head < q.length && e.startMs - q[head].startMs > win) head++;
      if (head < q.length) recoveredSet.add(q[head++]);
    }
  }
  const per = new Map();
  for (const w of workflows) {
    per.set(String(w.id), {
      id: String(w.id),
      label: w.label || String(w.id),
      minutesPerRun: w.minutes == null ? null : w.minutes,
      runs: 0,
      success: 0,
      errors: 0,
      recovered: 0,
    });
  }
  const daily = new Map();
  for (let t = startMs; t < endMs; t += DAY)
    daily.set(dayOf(t), { date: dayOf(t), runs: 0, errors: 0 });

  for (const e of mine) {
    if (e.startMs < startMs || e.startMs >= endMs) continue;
    const w = per.get(e.workflowId);
    const d = daily.get(dayOf(e.startMs));
    w.runs++;
    d.runs++;
    if (e.status === "success") {
      w.success++;
    } else {
      w.errors++;
      d.errors++;
      if (recoveredSet.has(e)) w.recovered++;
    }
  }

  const perWorkflow = [...per.values()].map((w) => ({
    ...w,
    errorRate: w.runs ? round1((w.errors / w.runs) * 100) : 0,
    hoursSaved:
      w.minutesPerRun == null
        ? null
        : round1((w.success * w.minutesPerRun) / 60),
    hoursSavedRaw:
      w.minutesPerRun == null ? 0 : (w.success * w.minutesPerRun) / 60,
  }));
  const runs = perWorkflow.reduce((a, w) => a + w.runs, 0);
  const success = perWorkflow.reduce((a, w) => a + w.success, 0);
  const errors = perWorkflow.reduce((a, w) => a + w.errors, 0);
  const recovered = perWorkflow.reduce((a, w) => a + w.recovered, 0);
  const hoursRaw = perWorkflow.reduce((a, w) => a + w.hoursSavedRaw, 0);
  const dailyArr = [...daily.values()];
  return {
    runs,
    success,
    errors,
    recovered,
    unrecovered: errors - recovered,
    errorRate: runs ? round1((errors / runs) * 100) : 0,
    hoursSavedRaw: hoursRaw,
    perWorkflow: perWorkflow.map(({ hoursSavedRaw, ...rest }) => rest),
    topFailing: perWorkflow
      .filter((w) => w.errors > 0)
      .sort((a, b) => b.errors - a.errors || a.label.localeCompare(b.label))
      .slice(0, 3)
      .map((w) => ({
        id: w.id,
        label: w.label,
        errors: w.errors,
        runs: w.runs,
        errorRate: w.errorRate,
      })),
    busiestDays: dailyArr
      .filter((d) => d.runs > 0)
      .sort((a, b) => b.runs - a.runs || a.date.localeCompare(b.date))
      .slice(0, 3),
    daily: dailyArr,
    missingEstimates: perWorkflow
      .filter((w) => w.minutesPerRun == null)
      .map((w) => w.label),
  };
}

// execs: normalized executions. workflows: [{id,label,minutes|null}]. win/prev: {startMs,endMs} (end exclusive).
function computeReport({
  executions,
  workflows,
  win,
  prev,
  hourlyRate,
  recoveryMinutes,
  label,
  truncated,
}) {
  executions = dedupeExecutions(executions);
  const rec = recoveryMinutes == null ? 60 : recoveryMinutes;
  const cur = computePeriod(executions, workflows, win.startMs, win.endMs, rec);
  const old = computePeriod(
    executions,
    workflows,
    prev.startMs,
    prev.endMs,
    rec,
  );
  const rate = hourlyRate == null ? null : hourlyRate;
  const money = (h) => (rate == null ? null : Math.round(h * rate));
  const anyEstimate = workflows.some((w) => w.minutes != null);
  const { hoursSavedRaw, ...curRest } = cur;
  return {
    label,
    truncated: !!truncated,
    period: {
      start: dayOf(win.startMs),
      end: dayOf(win.endMs - 1),
      days: Math.round((win.endMs - win.startMs) / DAY),
    },
    ...curRest,
    hoursSaved: anyEstimate ? round1(hoursSavedRaw) : null,
    value: anyEstimate ? money(hoursSavedRaw) : null,
    hourlyRate: rate,
    recoveryMinutes: rec,
    previous: {
      period: { start: dayOf(prev.startMs), end: dayOf(prev.endMs - 1) },
      runs: old.runs,
      success: old.success,
      errors: old.errors,
      errorRate: old.errorRate,
      hoursSaved: anyEstimate ? round1(old.hoursSavedRaw) : null,
      value: anyEstimate ? money(old.hoursSavedRaw) : null,
    },
    change: {
      runs: { abs: cur.runs - old.runs, pct: pctChange(cur.runs, old.runs) },
      errors: {
        abs: cur.errors - old.errors,
        pct: pctChange(cur.errors, old.errors),
      },
      errorRatePoints: round1(cur.errorRate - old.errorRate),
      hoursSaved: anyEstimate
        ? {
            abs: round1(cur.hoursSavedRaw - old.hoursSavedRaw),
            pct: pctChange(cur.hoursSavedRaw, old.hoursSavedRaw),
          }
        : null,
    },
  };
}

// ---- weekly email (md + html from one model) ----

function fmtChange(c, unit) {
  if (!c) return "";
  if (c.pct === null)
    return c.abs === 0
      ? "no change"
      : (c.abs > 0 ? "+" : "") +
          c.abs +
          unit +
          " (no data for the previous period)";
  return (c.abs > 0 ? "+" : "") + c.pct + "%";
}

function pluralize(n, one, many) {
  return n + " " + (n === 1 ? one : many);
}

function oneLine(v) {
  return String(v == null ? "" : v)
    .replace(BIDI, "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .trim();
}

// Escape markdown link and emphasis syntax in user-supplied text (used for the .md output only).
function mdEsc(v) {
  return String(v == null ? "" : v).replace(/[\[\]()*_`]/g, "\\$&");
}

function emailModel(r, opts, userText) {
  const o = opts || {};
  const u = userText || ((x) => x);
  const contact = u(oneLine(o.contactName)) || "there";
  const cur = o.currency || "$";
  const lines = { ran: [], issues: [], done: [], next: [] };
  lines.ran.push(
    pluralize(r.runs, "run", "runs") +
      " completed, " +
      r.success +
      " successful (" +
      (r.runs ? round1((r.success / r.runs) * 100) : 0) +
      "%).",
  );
  if (r.hoursSaved != null) {
    let s = "Estimated time saved: " + r.hoursSaved + " hours";
    if (r.value != null)
      s += " (about " + cur + r.value + " at " + cur + r.hourlyRate + "/hour)";
    s +=
      ". This is runs multiplied by the per-run minutes we agreed, not a measurement.";
    lines.ran.push(s);
  } else {
    lines.ran.push(
      "Time saved is not calculated because no per-run estimates are configured.",
    );
  }
  if (r.previous.runs > 0) {
    lines.ran.push(
      "Versus the previous 7 days: runs " +
        fmtChange(r.change.runs, "") +
        (r.change.hoursSaved
          ? ", estimated hours saved " + fmtChange(r.change.hoursSaved, "h")
          : "") +
        ".",
    );
  }
  if (r.errors === 0) {
    lines.issues.push("No failed runs this week.");
  } else {
    lines.issues.push(
      pluralize(r.errors, "run failed", "runs failed") +
        " (" +
        r.errorRate +
        "% of runs). " +
        r.recovered +
        " recovered automatically on a later run within " +
        r.recoveryMinutes +
        " minutes; " +
        r.unrecovered +
        (r.unrecovered === 1 ? " needs" : " need") +
        " a manual look.",
    );
    for (const w of r.topFailing)
      lines.issues.push(
        u(w.label) +
          ": " +
          pluralize(w.errors, "failure", "failures") +
          " out of " +
          w.runs +
          " runs.",
      );
  }
  if (r.truncated)
    lines.issues.unshift(
      "Warning: this report may be incomplete. The fetch stopped at its page limit, so counts can be too low.",
    );
  for (const n of o.notes || []) lines.done.push(u(n));
  lines.next.push(
    u(o.nextStep) ||
      "Reply if anything above looks off, or if there is a process you want automated next.",
  );
  const subject =
    (o.subject || "Your automations this week") +
    ": " +
    r.runs +
    " runs" +
    (r.hoursSaved != null
      ? ", about " + r.hoursSaved + " hours saved (estimate)"
      : "") +
    (r.errors ? ", " + pluralize(r.errors, "error", "errors") : ", no errors");
  const sections = [
    { title: "What ran", items: lines.ran },
    { title: "Issues", items: lines.issues },
  ];
  if (lines.done.length)
    sections.push({ title: "Work done this week", items: lines.done });
  if (o.narrative)
    sections.unshift({
      title:
        "Summary (drafted by an AI model from the totals below, check before sending)",
      items: [u(o.narrative)],
      plain: true,
    });
  sections.push({ title: "Next step", items: lines.next, plain: true });
  const intro =
    "Here is the weekly summary for " +
    r.period.start +
    " to " +
    r.period.end +
    " (UTC).";
  const signoff = o.agency ? u(o.agency) : "";
  return { subject, greeting: "Hi " + contact + ",", intro, sections, signoff };
}

function weeklyEmailMd(m) {
  const out = [
    "Subject: " + oneLine(m.subject),
    "",
    oneLine(m.greeting),
    "",
    oneLine(m.intro),
    "",
  ];
  for (const s of m.sections) {
    out.push("**" + oneLine(s.title) + "**", "");
    for (const it of s.items)
      out.push(s.plain ? oneLine(it) : "- " + oneLine(it));
    out.push("");
  }
  out.push("Thanks,");
  if (m.signoff) out.push(oneLine(m.signoff));
  return out.join("\n") + "\n";
}

function weeklyEmailHtml(m) {
  const p = "margin:0 0 12px;line-height:1.5";
  const parts = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
      esc(m.subject) +
      "</title></head>",
    '<body style="margin:0;padding:24px;background:#ffffff;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:15px">',
    '<div style="max-width:560px;margin:0 auto">',
    '<p style="' + p + '">' + esc(m.greeting) + "</p>",
    '<p style="' + p + '">' + esc(m.intro) + "</p>",
  ];
  for (const s of m.sections) {
    parts.push(
      '<h2 style="font-size:15px;margin:20px 0 6px;color:#111827">' +
        esc(s.title) +
        "</h2>",
    );
    if (s.plain) {
      for (const it of s.items)
        parts.push('<p style="' + p + '">' + esc(it) + "</p>");
    } else {
      parts.push(
        '<ul style="margin:0 0 12px;padding-left:20px;line-height:1.5">' +
          s.items.map((it) => "<li>" + esc(it) + "</li>").join("") +
          "</ul>",
      );
    }
  }
  parts.push(
    '<p style="' +
      p +
      '">Thanks,' +
      (m.signoff ? "<br>" + esc(m.signoff) : "") +
      "</p>",
    "</div></body></html>",
  );
  return parts.join("\n") + "\n";
}

function weeklyEmail(r, opts) {
  const m = emailModel(r, opts);
  const mMd = emailModel(r, opts, mdEsc);
  return {
    subject: m.subject,
    md: weeklyEmailMd(mMd),
    html: weeklyEmailHtml(m),
  };
}

// --- exports ---
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DAY,
    esc,
    oneLine,
    mdEsc,
    dayOf,
    dayStartUtc,
    normalizeStatus,
    normalizeExecution,
    computePeriod,
    dedupeExecutions,
    computeReport,
    emailModel,
    weeklyEmail,
  };
}
