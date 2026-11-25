"use strict";
// Minimal 5-field cron reader, used only to find the LONGEST gap between two fire
// times (the number the stall check needs). Fire times are enumerated in UTC; DST
// shifts move a gap by an hour at most, which the 2x tolerance absorbs.
const MIN = 60000;

function expandField(field, lo, hi, names) {
  const out = new Set();
  for (let part of String(field).split(",")) {
    part = part.toLowerCase();
    if (names)
      for (const [k, v] of Object.entries(names))
        part = part.split(k).join(String(v));
    let step = 1;
    const sl = part.split("/");
    if (sl.length === 2) {
      step = Number(sl[1]);
      part = sl[0];
    } else if (sl.length > 2) return null;
    if (!Number.isInteger(step) || step < 1) return null;
    let a, b;
    if (part === "*" || part === "?") {
      a = lo;
      b = hi;
    } else if (/^\d+$/.test(part)) {
      a = Number(part);
      b = sl.length === 2 ? hi : a;
    } else if (/^\d+-\d+$/.test(part)) {
      [a, b] = part.split("-").map(Number);
    } else return null;
    if (a < lo || b > hi || a > b) return null;
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseCron(expr) {
  if (typeof expr !== "string") return null;
  let f = expr.trim().split(/\s+/);
  if (f.length === 6) f = f.slice(1); // n8n allows a leading seconds field; minute resolution is enough here
  if (f.length !== 5) return null;
  const minute = expandField(f[0], 0, 59);
  const hour = expandField(f[1], 0, 23);
  const dom = expandField(f[2], 1, 31);
  const month = expandField(f[3], 1, 12, MONTHS);
  const dowRaw = expandField(f[4], 0, 7, DAYS);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => d % 7));
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domStar: /^[*?]/.test(f[2]),
    dowStar: /^[*?]/.test(f[4]),
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()))
    return false;
  if (!c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // standard cron: when both day fields are restricted, either may match
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

// Longest gap in ms between consecutive fire times, scanning ~13 months. null if unreadable or never fires.
function maxGapMs(expr, scanDays = 400) {
  const c = parseCron(expr);
  if (!c) return null;
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const end = start + scanDays * 864e5;
  let prev = null;
  let first = null;
  let max = 0;
  for (let t = start; t < end; t += MIN) {
    if (matches(c, new Date(t))) {
      if (first === null) first = t;
      if (prev !== null && t - prev > max) max = t - prev;
      prev = t;
    }
  }
  if (first === null) return null;
  return max || scanDays * 864e5; // single fire in the window: treat as yearly-ish
}

module.exports = { parseCron, maxGapMs };
