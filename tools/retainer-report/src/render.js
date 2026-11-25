"use strict";
const { esc } = require("./core");

function barChart(daily) {
  const W = 720,
    H = 170,
    padL = 28,
    padB = 22,
    padT = 8;
  const n = daily.length || 1;
  const max = Math.max(1, ...daily.map((d) => d.runs));
  const plotW = W - padL,
    plotH = H - padB - padT;
  const bw = plotW / n;
  const bars = [];
  const labels = [];
  daily.forEach((d, i) => {
    const x = padL + i * bw;
    const h = (d.runs / max) * plotH;
    const eh = (d.errors / max) * plotH;
    const y = padT + plotH - h;
    const w = Math.max(1, bw * 0.72);
    bars.push(
      '<rect x="' +
        x.toFixed(1) +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        w.toFixed(1) +
        '" height="' +
        (h - eh).toFixed(1) +
        '" fill="#2563eb"><title>' +
        esc(d.date) +
        ": " +
        d.runs +
        " runs, " +
        d.errors +
        " errors</title></rect>",
    );
  });
  // errors drawn as a red cap at the bottom of each bar so they stay visible when small
  daily.forEach((d, i) => {
    if (!d.errors) return;
    const x = padL + i * bw;
    const eh = Math.max(2, (d.errors / max) * plotH);
    const w = Math.max(1, bw * 0.72);
    bars.push(
      '<rect x="' +
        x.toFixed(1) +
        '" y="' +
        (padT + plotH - eh).toFixed(1) +
        '" width="' +
        w.toFixed(1) +
        '" height="' +
        eh.toFixed(1) +
        '" fill="#b91c1c"/>',
    );
  });
  const step = n > 14 ? 5 : 1;
  daily.forEach((d, i) => {
    if (i % step === 0)
      labels.push(
        '<text x="' +
          (padL + i * bw).toFixed(1) +
          '" y="' +
          (H - 6) +
          '" font-size="10" fill="#4b5563">' +
          esc(d.date.slice(5)) +
          "</text>",
      );
  });
  const grid =
    '<line x1="' +
    padL +
    '" y1="' +
    (padT + plotH) +
    '" x2="' +
    W +
    '" y2="' +
    (padT + plotH) +
    '" stroke="#9ca3af"/>' +
    '<text x="0" y="' +
    (padT + 8) +
    '" font-size="10" fill="#4b5563">' +
    max +
    '</text><text x="0" y="' +
    (padT + plotH) +
    '" font-size="10" fill="#4b5563">0</text>';
  const total = daily.reduce((a, d) => a + d.runs, 0);
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" width="100%" role="img" aria-label="Runs per day, ' +
    total +
    ' runs in total; failed runs shown in red">' +
    grid +
    bars.join("") +
    labels.join("") +
    "</svg>"
  );
}

function monthlyHtml(r, o) {
  const cur = o.currency || "$";
  const kpi = (v, l, sub) =>
    '<div class="kpi"><div class="v">' +
    esc(v) +
    '</div><div class="l">' +
    esc(l) +
    "</div>" +
    (sub ? '<div class="s">' + esc(sub) + "</div>" : "") +
    "</div>";
  const chg = (c) =>
    c && c.pct != null
      ? (c.pct > 0 ? "+" : "") + c.pct + "% vs previous month"
      : "no prior data";
  const rows = r.perWorkflow
    .map(
      (w) =>
        "<tr><td>" +
        esc(w.label) +
        '</td><td class="n">' +
        w.runs +
        '</td><td class="n">' +
        w.success +
        '</td><td class="n">' +
        w.errors +
        '</td><td class="n">' +
        (w.minutesPerRun == null ? "not set" : esc(w.minutesPerRun) + " min") +
        '</td><td class="n">' +
        (w.hoursSaved == null ? "n/a" : esc(w.hoursSaved)) +
        "</td></tr>",
    )
    .join("");
  const issues =
    r.errors === 0
      ? "<p>No failed runs this month.</p>"
      : "<p>" +
        r.errors +
        " failed runs (" +
        r.errorRate +
        "%). " +
        r.recovered +
        " recovered automatically on a later run within " +
        r.recoveryMinutes +
        " minutes; " +
        r.unrecovered +
        " needed a manual look.</p>" +
        (r.topFailing.length
          ? "<ul>" +
            r.topFailing
              .map(
                (w) =>
                  "<li>" +
                  esc(w.label) +
                  ": " +
                  w.errors +
                  " failures in " +
                  w.runs +
                  " runs</li>",
              )
              .join("") +
            "</ul>"
          : "");
  const busy = r.busiestDays.length
    ? "<p>Busiest days: " +
      r.busiestDays
        .map((d) => esc(d.date) + " (" + d.runs + " runs)")
        .join(", ") +
      ".</p>"
    : "";
  const notes = (o.notes || []).length
    ? "<h2>Work done</h2><ul>" +
      o.notes.map((n) => "<li>" + esc(n) + "</li>").join("") +
      "</ul>"
    : "";
  const next = o.nextStep
    ? "<h2>Next step</h2><p>" + esc(o.nextStep) + "</p>"
    : "";
  const trunc = r.truncated
    ? '<p class="foot"><strong>Warning:</strong> this report may be incomplete. The data fetch stopped at its page limit, so counts can be too low.</p>'
    : "";
  const narr = o.narrative
    ? "<h2>Summary</h2><p>" +
      esc(o.narrative) +
      '</p><p class="muted">Drafted by an AI model from the totals in this report. Check it before sending.</p>'
    : "";
  const est =
    r.hoursSaved != null
      ? "Hours saved = successful runs x the minutes-per-run estimate for each workflow. Those minutes are estimates agreed with the client, not measured. " +
        (r.hourlyRate != null
          ? "Value uses " + esc(cur) + esc(r.hourlyRate) + "/hour."
          : "No hourly rate set, so no money value is shown.")
      : "No per-run time estimates are configured, so time saved is not calculated.";
  const missing = r.missingEstimates.length
    ? " No estimate set for: " +
      r.missingEstimates.join(", ") +
      " (counted as zero hours)."
    : "";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" +
    esc(o.client) +
    " automation report " +
    esc(r.period.start) +
    "</title><style>" +
    ":root{--bg:#fff;--fg:#1f2937;--mut:#4b5563;--line:#d1d5db;--acc:#1d4ed8}*{box-sizing:border-box}" +
    "body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Arial,Helvetica,sans-serif}" +
    ".page{max-width:780px;margin:0 auto;padding:28px 24px}h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid var(--line);padding-bottom:3px}" +
    ".sub{color:var(--mut);margin:0 0 14px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.kpi{border:1px solid var(--line);border-radius:6px;padding:10px}" +
    ".kpi .v{font-size:22px;font-weight:700}.kpi .l{color:var(--mut);font-size:12px}.kpi .s{color:var(--mut);font-size:11px}" +
    ".page{overflow-wrap:anywhere}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);overflow-wrap:anywhere;word-break:break-word}td.n,th.n{text-align:right}" +
    ".muted,.foot{color:var(--mut);font-size:12px}.legend span{display:inline-block;width:10px;height:10px;margin:0 4px 0 10px;vertical-align:middle}" +
    "p,ul{margin:4px 0 8px}.btn{font:inherit;padding:6px 10px;margin-bottom:10px}" +
    "@media(max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}}" +
    "@media print{@page{size:A4;margin:14mm}.noprint{display:none}.page{padding:0;max-width:none}}" +
    '</style></head><body><div class="page">' +
    '<p class="noprint muted">To save as PDF, use your browser\'s Print and choose Save as PDF.</p>' +
    "<h1>" +
    esc(o.client) +
    ": automation report</h1>" +
    '<p class="sub">' +
    esc(r.period.start) +
    " to " +
    esc(r.period.end) +
    " (UTC)" +
    (o.agency ? " &middot; prepared by " + esc(o.agency) : "") +
    "</p>" +
    '<div class="kpis">' +
    kpi(r.runs, "Runs", chg(r.change.runs)) +
    kpi(r.success, "Successful", r.errorRate + "% error rate") +
    kpi(
      r.hoursSaved == null ? "n/a" : r.hoursSaved + " h",
      "Estimated hours saved",
      r.change.hoursSaved ? chg(r.change.hoursSaved) : "",
    ) +
    kpi(
      r.value == null ? "n/a" : cur + r.value,
      "Estimated value",
      r.hourlyRate != null ? "at " + cur + r.hourlyRate + "/hour" : "",
    ) +
    "</div>" +
    narr +
    "<h2>Runs per day</h2>" +
    barChart(r.daily) +
    '<div class="legend muted"><span style="background:#2563eb"></span>successful<span style="background:#b91c1c"></span>failed</div>' +
    busy +
    '<h2>By workflow</h2><table><colgroup><col><col style="width:12%"><col style="width:10%"><col style="width:12%"><col style="width:17%"><col style="width:15%"></colgroup><thead><tr><th>Workflow</th><th class="n">Runs</th><th class="n">OK</th><th class="n">Errors</th><th class="n">Est. per run</th><th class="n">Hours saved</th></tr></thead><tbody>' +
    rows +
    "</tbody></table>" +
    "<h2>Issues</h2>" +
    issues +
    notes +
    next +
    trunc +
    '<p class="foot">' +
    est +
    esc(missing) +
    " Source: n8n execution metadata (ids, status, timestamps). Execution data is not read.</p>" +
    "</div></body></html>\n"
  );
}

module.exports = { monthlyHtml, barChart };
