"use strict";
// "90m", "24h", "2d", "30s" -> milliseconds. Returns null when it cannot parse.
const UNIT = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

function parseDuration(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 36e5; // bare number = hours
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i.exec(v);
  if (!m) return null;
  const ms = Number(m[1]) * UNIT[m[2].toLowerCase()];
  return ms > 0 ? ms : null;
}

function formatDuration(ms) {
  if (ms == null) return "-";
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 6e4);
  if (mins < 1) return "<1m";
  if (mins < 120) return `${mins}m`;
  const hrs = abs / 36e5;
  if (hrs < 72) {
    const h = Math.floor(hrs);
    const m = Math.round((hrs - h) * 60);
    return m ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
  }
  return `${Math.round(abs / 864e5)}d`;
}

module.exports = { parseDuration, formatDuration };
