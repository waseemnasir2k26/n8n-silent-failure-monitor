"use strict";
// Work out how often a workflow is meant to run, from its trigger nodes.
// Field names follow n8n's own node parameters:
//  - n8n-nodes-base.scheduleTrigger: parameters.rule.interval[] {field, <unit>Interval, expression}
//  - n8n-nodes-base.cron (legacy):   parameters.triggerTimes.item[] {mode, value, unit, cronExpression}
//  - n8n-nodes-base.interval (legacy): parameters.interval + parameters.unit
const { maxGapMs } = require("./cron");

const S = 1e3,
  M = 6e4,
  H = 36e5,
  D = 864e5;
const num = (v, d = 1) =>
  Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d;
const short = (t) => String(t || "").replace(/^n8n-nodes-base\./, "");
const UNIT_MS = {
  seconds: S,
  minutes: M,
  hours: H,
  days: D,
  weeks: 7 * D,
  months: 31 * D,
};

// One scheduleTrigger rule item -> { ms, text } or null
function ruleItem(it) {
  if (!it || typeof it !== "object") return null;
  const f = it.field;
  if (f === "cronExpression") {
    const ms = maxGapMs(it.expression);
    return ms ? { ms, text: `cron ${it.expression}` } : null;
  }
  const key = {
    seconds: "secondsInterval",
    minutes: "minutesInterval",
    hours: "hoursInterval",
    days: "daysInterval",
    weeks: "weeksInterval",
    months: "monthsInterval",
  }[f];
  if (!key) return null;
  const n = num(it[key]);
  return {
    ms: n * UNIT_MS[f],
    text: `every ${n} ${n === 1 ? f.replace(/s$/, "") : f}`,
  };
}

function cronNodeItem(it) {
  if (!it) return null;
  switch (it.mode) {
    case "everyMinute":
      return { ms: M, text: "every minute" };
    case "everyHour":
      return { ms: H, text: "every hour" };
    case "everyDay":
      return { ms: D, text: "every day" };
    case "everyWeek":
      return { ms: 7 * D, text: "every week" };
    case "everyMonth":
      return { ms: 31 * D, text: "every month" };
    case "everyX": {
      const unit = String(it.unit || "minutes");
      const u = UNIT_MS[unit];
      if (!u) return null;
      const n = num(it.value);
      return { ms: n * u, text: `every ${n} ${unit}` };
    }
    case "custom": {
      const ms = maxGapMs(it.cronExpression);
      return ms ? { ms, text: `cron ${it.cronExpression}` } : null;
    }
    default:
      return null;
  }
}

// -> { kind: "schedule"|"webhook"|"none", intervalMs, text, unreadable }
function describeTrigger(workflow) {
  const nodes = (
    Array.isArray(workflow && workflow.nodes) ? workflow.nodes : []
  ).filter((n) => n && !n.disabled);
  const items = [];
  let sawSchedule = false;
  let unreadable = false;
  for (const n of nodes) {
    const t = short(n.type);
    const p =
      n.parameters && typeof n.parameters === "object" ? n.parameters : {};
    if (t === "scheduleTrigger") {
      sawSchedule = true;
      const list =
        p.rule && Array.isArray(p.rule.interval)
          ? p.rule.interval
          : [{ field: "days", daysInterval: 1 }];
      for (const it of list) {
        const r = ruleItem(it);
        if (r) items.push(r);
        else unreadable = true;
      }
    } else if (t === "cron") {
      sawSchedule = true;
      const list =
        p.triggerTimes && Array.isArray(p.triggerTimes.item)
          ? p.triggerTimes.item
          : [];
      for (const it of list) {
        const r = cronNodeItem(it);
        if (r) items.push(r);
        else unreadable = true;
      }
    } else if (t === "interval") {
      sawSchedule = true;
      const u = UNIT_MS[String(p.unit || "seconds")];
      if (u)
        items.push({
          ms: num(p.interval) * u,
          text: `every ${num(p.interval)} ${p.unit || "seconds"}`,
        });
      else unreadable = true;
    }
  }
  if (sawSchedule) {
    if (!items.length)
      return {
        kind: "schedule",
        intervalMs: null,
        text: "unreadable schedule",
        unreadable: true,
      };
    // Several rules fire as a union, so the longest gap between runs is at most the longest single interval.
    // Use that: it is the most forgiving reading, so it can only under-report, not cry wolf.
    const worst = items.reduce((a, b) => (b.ms > a.ms ? b : a));
    return {
      kind: "schedule",
      intervalMs: worst.ms,
      text: items.map((i) => i.text).join("; "),
      unreadable,
    };
  }
  if (
    nodes.some((n) =>
      ["webhook", "formTrigger", "chatTrigger"].includes(short(n.type)),
    )
  )
    return {
      kind: "webhook",
      intervalMs: null,
      text: "webhook",
      unreadable: false,
    };
  return {
    kind: "none",
    intervalMs: null,
    text: "no schedule or webhook trigger",
    unreadable: false,
  };
}

module.exports = { describeTrigger };
