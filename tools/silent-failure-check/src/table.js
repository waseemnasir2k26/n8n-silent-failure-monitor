"use strict";
const { formatDuration } = require("./duration");

const ORDER = { STALLED: 0, FAILING: 1, OK: 2, DISABLED: 3, SKIP: 4 };

function pad(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "~" : s + " ".repeat(n - s.length);
}

// results: [{client, status, name, trigger, lastRunAt, detail}]
function renderTable(results, { now, showAll = false, color = false } = {}) {
  const shown = results
    .filter((r) => showAll || (r.status !== "DISABLED" && r.status !== "SKIP"))
    .sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        a.client.localeCompare(b.client) ||
        a.name.localeCompare(b.name),
    );
  const rows = shown.map((r) => [
    r.status,
    r.client,
    r.name,
    r.expectedMs ? `every ${formatDuration(r.expectedMs)}` : r.trigger,
    r.lastRunAt
      ? formatDuration(now - Date.parse(r.lastRunAt)) + " ago"
      : "never",
    r.detail,
  ]);
  const head = [
    "STATUS",
    "CLIENT",
    "WORKFLOW",
    "EXPECTED",
    "LAST RUN",
    "DETAIL",
  ];
  const caps = [8, 18, 38, 18, 11, 64];
  const w = head.map((h, i) =>
    Math.min(
      caps[i],
      Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
    ),
  );
  const paint = (s, st) =>
    !color
      ? s
      : st === "STALLED" || st === "FAILING"
        ? `\x1b[31m${s}\x1b[0m`
        : st === "OK"
          ? `\x1b[32m${s}\x1b[0m`
          : s;
  const line = (cells, st) =>
    cells
      .map((c, i) => (i === 0 ? paint(pad(c, w[i]), st) : pad(c, w[i])))
      .join("  ")
      .trimEnd();
  const out = [line(head, ""), w.map((n) => "-".repeat(n)).join("  ")];
  for (const r of rows) out.push(line(r, r[0]));
  const count = (s) => results.filter((r) => r.status === s).length;
  const hidden = results.length - shown.length;
  out.push("");
  out.push(
    `${results.length} workflows: ${count("STALLED")} stalled, ${count("FAILING")} failing, ${count("OK")} ok` +
      (hidden
        ? `, ${hidden} hidden (disabled or not scheduled; use --all)`
        : ""),
  );
  return out.join("\n");
}

module.exports = { renderTable };
