"use strict";
// report.md and report.html. Both are rendered from the graph only (already scrubbed).

const { esc } = require("./util");
const { index, spof, hookLabel } = require("./query");

function mdCell(v) {
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
    .replace(/[\r\n]+/g, " ");
}

function wfName(r) {
  return `[${r.instance}] ${r.name}${r.active ? "" : " (inactive)"}`;
}

/** Workflows hit if this exact node dies: direct users, then callers via calls_workflow. */
function scopeTo(ix, node, rel) {
  const keep = new Map();
  const queue = [];
  for (const l of ix.inn.get(node.id) || []) {
    if (l.rel === rel && !keep.has(l.source)) {
      keep.set(l.source, 0);
      queue.push(l.source);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const l of ix.inn.get(queue[i]) || []) {
      if (l.rel === "calls_workflow" && !keep.has(l.source)) {
        keep.set(l.source, keep.get(queue[i]) + 1);
        queue.push(l.source);
      }
    }
  }
  return [...keep.entries()]
    .map(([id, distance]) => {
      const n = ix.byId.get(id);
      return { id, name: n.label, instance: n.attrs.instance, active: n.attrs.active === true, distance };
    })
    .sort((a, b) => a.distance - b.distance || (a.instance + a.name < b.instance + b.name ? -1 : 1));
}

function byCount(a, b) {
  return b.all.length - a.all.length || (a.node.label + (a.node.attrs.instance || "") < b.node.label + (b.node.attrs.instance || "") ? -1 : 1);
}

/** Shared data model for both renderers. */
function model(graph, min = 3, showPaths = false) {
  const ix = index(graph);
  const s = spof(graph, min, { showPaths });
  const rowsFor = (type, rel) =>
    graph.nodes
      .filter((n) => n.type === type && n.label !== "dynamic-expression")
      .map((n) => {
        const all = scopeTo(ix, n, rel);
        return { node: n, direct: all.filter((r) => r.distance === 0), all };
      })
      .sort(byCount);
  const wfs = graph.nodes.filter((n) => n.type === "workflow" && !n.attrs.missing);
  return {
    s,
    creds: rowsFor("credential", "uses_credential"),
    hosts: rowsFor("host", "calls_host"),
    sheets: rowsFor("sheet", "reads_writes"),
    envs: rowsFor("envvar", "reads_env"),
    hooks: graph.nodes
      .filter((n) => n.type === "webhook")
      .map((n) => ({ ...n, label: hookLabel(n, showPaths) })),
    wfs,
    instances: [...new Set(wfs.map((w) => w.attrs.instance))].sort(),
    min,
  };
}

function markdown(graph, opts = {}) {
  const m = model(graph, opts.min || 3, opts.showPaths === true);
  const c = graph.meta.counts;
  const L = [];
  L.push("# n8n estate graph report", "");
  if (graph.meta.date) L.push(`Date: ${graph.meta.date}`, "");
  L.push(
    `Sources: ${graph.meta.sources.map((s) => `${s.label} (${s.kind}${s.host ? `, ${s.host}` : ""})`).join(", ") || "none"}`,
    "",
  );
  L.push("## Summary", "");
  L.push("| Metric | Count |", "| --- | --- |");
  L.push(`| Workflows | ${c.workflows} (${c.activeWorkflows} active) |`);
  L.push(
    `| Credentials referenced | ${c.credentials} |`,
    `| External hosts | ${c.hosts} |`,
    `| Webhooks | ${c.webhooks} |`,
    `| Sheets / docs / bases | ${c.sheets} |`,
    `| Env vars | ${c.envvars} |`,
    `| Schedules | ${c.schedules} |`,
    "",
  );

  L.push(`## Single points of failure (threshold ${m.min})`, "");
  const tbl = (head, rows) => {
    if (!rows.length) return L.push("None.", "");
    L.push(
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
    );
    for (const r of rows) L.push(`| ${r.map(mdCell).join(" | ")} |`);
    L.push("");
  };
  L.push("### Credentials used by many active workflows", "");
  tbl(
    ["Instance", "Credential", "Active workflows", "Workflows"],
    m.s.credentials.map((x) => [
      x.instance,
      x.label,
      x.activeWorkflows,
      x.workflows.join(", "),
    ]),
  );
  L.push("### Hosts used by many active workflows", "");
  tbl(
    ["Host", "Active workflows", "Workflows"],
    m.s.hosts.map((x) => [x.label, x.activeWorkflows, x.workflows.join(", ")]),
  );
  L.push("### Active workflows with no error workflow", "");
  tbl(
    ["Instance", "Workflow"],
    m.s.noErrorWorkflow.map((x) => [x.instance, x.label]),
  );
  L.push("### Webhooks with authentication none", "");
  tbl(
    ["Instance", "Webhook", "Workflow", "Active"],
    m.s.openWebhooks.map((x) => [
      x.instance,
      x.webhook,
      x.workflows.map((w) => w.label).join(", "),
      x.active ? "yes" : "no",
    ]),
  );
  L.push("### Sub-workflows called by many", "");
  tbl(
    ["Instance", "Sub-workflow", "Callers"],
    m.s.subworkflows.map((x) => [x.instance, x.label, x.workflows.join(", ")]),
  );
  L.push(`Orphan credentials: ${m.s.orphanCredentials.note}`, "");

  L.push("## Credentials", "");
  tbl(
    [
      "Instance",
      "Credential",
      "Type",
      "Direct",
      "Affected (incl. via sub-workflows)",
      "Workflows",
    ],
    m.creds.map((r) => [
      r.node.attrs.instance,
      r.node.label,
      (r.node.attrs.credType || []).join(", "),
      r.direct.length,
      r.all.length,
      r.all.map(wfName).join(", "),
    ]),
  );
  L.push("## External hosts", "");
  tbl(
    ["Host", "Direct", "Affected", "Workflows"],
    m.hosts.map((r) => [
      r.node.label,
      r.direct.length,
      r.all.length,
      r.all.map(wfName).join(", "),
    ]),
  );
  L.push("## Sheets, docs and bases", "");
  tbl(
    ["Name", "Kind", "Tabs", "Affected", "Workflows"],
    m.sheets.map((r) => [
      r.node.label,
      r.node.attrs.kind,
      (r.node.attrs.sheetNames || []).join(", "),
      r.all.length,
      r.all.map(wfName).join(", "),
    ]),
  );
  L.push("## Env vars", "");
  tbl(
    ["Instance", "Name", "Affected", "Workflows"],
    m.envs.map((r) => [
      r.node.attrs.instance,
      r.node.label,
      r.all.length,
      r.all.map(wfName).join(", "),
    ]),
  );
  L.push("## Webhooks", "");
  tbl(
    ["Instance", "Webhook", "Authentication"],
    m.hooks.map((n) => [n.attrs.instance, n.label, n.attrs.authentication]),
  );
  L.push("## Workflows", "");
  tbl(
    ["Instance", "Workflow", "Active", "Triggers", "Error workflow"],
    m.wfs.map((w) => [
      w.attrs.instance,
      w.label,
      w.attrs.active ? "yes" : "no",
      (w.attrs.triggerTypes || []).join(", "),
      w.attrs.errorWorkflow
        ? "set"
        : w.attrs.isErrorHandler
          ? "is one"
          : "none",
    ]),
  );
  L.push(
    "## Limits",
    "",
    "Static analysis of exported workflow JSON. Dynamic expressions show as `dynamic-expression`. No runtime tracing. Only credentials referenced by a workflow are listed.",
    "",
  );
  return L.join("\n");
}

const CSS = `:root{--bg:#fff;--fg:#1c2330;--mut:#5b6678;--line:#dfe4ec;--acc:#1f5eff;--warn:#b42318;--tile:#f3f6fb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 56px}h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{font-size:16px;margin:22px 0 6px}
.sub{color:var(--mut);margin:0 0 18px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tile{background:var(--tile);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tile b{display:block;font-size:24px}.tile span{color:var(--mut);font-size:13px}
.bar{display:flex;gap:10px;align-items:center;margin:18px 0}select{font:inherit;padding:4px 8px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--tile)}
.warn{color:var(--warn);font-weight:600}.none{color:var(--mut)}code{background:var(--tile);padding:1px 4px;border-radius:4px}footer{margin-top:40px;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:12px}a{color:var(--acc)}
@media (max-width:600px){main{padding:16px 12px}}`;

const JS = `(function(){var s=document.getElementById('inst');if(!s)return;s.addEventListener('change',function(){var v=s.value;var rows=document.querySelectorAll('[data-instance]');for(var i=0;i<rows.length;i++){var r=rows[i];var ins=(r.getAttribute('data-instance')||'').split('|');r.hidden=!(v===''||ins.indexOf(v)>-1);}});})();`;

function html(graph, opts = {}) {
  const m = model(graph, opts.min || 3, opts.showPaths === true);
  const c = graph.meta.counts;
  const t = (head, rows, empty = "None.") => {
    if (!rows.length) return `<p class="none">${esc(empty)}</p>`;
    return `<div class="wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr data-instance="${esc(r.ins)}">${r.cells.map((x) => `<td>${x}</td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table></div>`;
  };
  const wl = (rows) =>
    rows.map((r) => `${esc(wfName(r))}`).join("<br>") ||
    '<span class="none">none</span>';
  const insOf = (rows) =>
    [...new Set(rows.map((r) => r.instance))].sort().join("|");
  const tiles = [
    ["Workflows", `${c.workflows}`],
    ["Active", `${c.activeWorkflows}`],
    ["Credentials", `${c.credentials}`],
    ["External hosts", `${c.hosts}`],
    ["Webhooks", `${c.webhooks}`],
    ["Sheets / bases", `${c.sheets}`],
    ["Env vars", `${c.envvars}`],
  ];
  const p = [];
  p.push(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>n8n estate graph report</title><style>${CSS}</style></head><body><main>`,
  );
  p.push(
    `<h1>n8n estate graph report</h1><p class="sub">${esc(graph.meta.sources.map((s) => `${s.label} (${s.kind}${s.host ? `, ${s.host}` : ""})`).join(", ") || "no sources")}${graph.meta.date ? ` &middot; ${esc(graph.meta.date)}` : ""}</p>`,
  );
  p.push(
    `<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>`,
  );
  p.push(
    `<div class="bar"><label for="inst">Client / instance</label><select id="inst"><option value="">All</option>${m.instances.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}</select></div>`,
  );

  p.push(
    `<h2>Single points of failure</h2><p class="sub">Threshold: ${m.min} active workflows.</p>`,
  );
  p.push("<h3>Credentials used by many active workflows</h3>");
  p.push(
    t(
      ["Instance", "Credential", "Active workflows", "Workflows"],
      m.s.credentials.map((x) => ({
        ins: x.instance,
        cells: [
          esc(x.instance),
          `<span class="warn">${esc(x.label)}</span>`,
          x.activeWorkflows,
          x.workflows.map(esc).join("<br>"),
        ],
      })),
    ),
  );
  p.push("<h3>Hosts used by many active workflows</h3>");
  p.push(
    t(
      ["Host", "Active workflows", "Workflows"],
      m.s.hosts.map((x) => ({
        ins: [
          ...new Set(x.workflows.map((w) => /^\[([^\]]*)\]/.exec(w)[1])),
        ].join("|"),
        cells: [
          `<code>${esc(x.label)}</code>`,
          x.activeWorkflows,
          x.workflows.map(esc).join("<br>"),
        ],
      })),
    ),
  );
  p.push("<h3>Active workflows with no error workflow</h3>");
  p.push(
    t(
      ["Instance", "Workflow"],
      m.s.noErrorWorkflow.map((x) => ({
        ins: x.instance,
        cells: [esc(x.instance), esc(x.label)],
      })),
    ),
  );
  p.push("<h3>Webhooks with authentication none</h3>");
  p.push(
    t(
      ["Instance", "Webhook", "Workflow", "Active"],
      m.s.openWebhooks.map((x) => ({
        ins: x.instance,
        cells: [
          esc(x.instance),
          `<span class="warn"><code>${esc(x.webhook)}</code></span>`,
          x.workflows.map((w) => esc(w.label)).join("<br>"),
          x.active ? "yes" : "no",
        ],
      })),
    ),
  );
  p.push("<h3>Sub-workflows called by many</h3>");
  p.push(
    t(
      ["Instance", "Sub-workflow", "Callers"],
      m.s.subworkflows.map((x) => ({
        ins: x.instance,
        cells: [
          esc(x.instance),
          esc(x.label),
          x.workflows.map(esc).join("<br>"),
        ],
      })),
    ),
  );
  p.push(
    `<p class="none">Orphan credentials: ${esc(m.s.orphanCredentials.note)}</p>`,
  );

  p.push("<h2>Credentials</h2>");
  p.push(
    t(
      ["Instance", "Credential", "Type", "Direct", "Affected", "Workflows"],
      m.creds.map((r) => ({
        ins: r.node.attrs.instance,
        cells: [
          esc(r.node.attrs.instance),
          esc(r.node.label),
          esc((r.node.attrs.credType || []).join(", ")),
          r.direct.length,
          r.all.length,
          wl(r.all),
        ],
      })),
    ),
  );
  p.push("<h2>External hosts</h2>");
  p.push(
    t(
      ["Host", "Direct", "Affected", "Workflows"],
      m.hosts.map((r) => ({
        ins: insOf(r.all),
        cells: [
          `<code>${esc(r.node.label)}</code>`,
          r.direct.length,
          r.all.length,
          wl(r.all),
        ],
      })),
    ),
  );
  p.push("<h2>Sheets, docs and bases</h2>");
  p.push(
    t(
      ["Name", "Kind", "Tabs", "Affected", "Workflows"],
      m.sheets.map((r) => ({
        ins: insOf(r.all),
        cells: [
          esc(r.node.label),
          esc(r.node.attrs.kind),
          esc((r.node.attrs.sheetNames || []).join(", ")),
          r.all.length,
          wl(r.all),
        ],
      })),
    ),
  );
  p.push("<h2>Env vars</h2>");
  p.push(
    t(
      ["Instance", "Name", "Affected", "Workflows"],
      m.envs.map((r) => ({
        ins: r.node.attrs.instance,
        cells: [
          esc(r.node.attrs.instance),
          `<code>${esc(r.node.label)}</code>`,
          r.all.length,
          wl(r.all),
        ],
      })),
    ),
  );
  p.push("<h2>Webhooks</h2>");
  p.push(
    t(
      ["Instance", "Webhook", "Authentication"],
      m.hooks.map((n) => ({
        ins: n.attrs.instance,
        cells: [
          esc(n.attrs.instance),
          `<code>${esc(n.label)}</code>`,
          n.attrs.authentication === "none"
            ? `<span class="warn">none</span>`
            : esc(n.attrs.authentication),
        ],
      })),
    ),
  );
  p.push("<h2>Workflows</h2>");
  p.push(
    t(
      ["Instance", "Workflow", "Active", "Triggers", "Error workflow"],
      m.wfs.map((w) => ({
        ins: w.attrs.instance,
        cells: [
          esc(w.attrs.instance),
          esc(w.label),
          w.attrs.active ? "yes" : "no",
          esc((w.attrs.triggerTypes || []).join(", ")),
          w.attrs.errorWorkflow
            ? "set"
            : w.attrs.isErrorHandler
              ? "is one"
              : "none",
        ],
      })),
    ),
  );
  p.push(
    `<h2>Limits</h2><p>Static analysis of exported workflow JSON. Dynamic expressions show as <code>dynamic-expression</code>. No runtime tracing. Only credentials referenced by a workflow are listed.</p>`,
  );
  p.push(
    `<footer>Built by <a href="https://skynetjoe.com">SkynetLabs</a> &middot; <a href="https://github.com/waseemnasir2k26">GitHub</a></footer>`,
  );
  p.push(`</main><script>${JS}</script></body></html>`);
  return p.join("\n");
}

module.exports = { markdown, html, model };
