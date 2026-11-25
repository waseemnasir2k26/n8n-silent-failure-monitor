"use strict";
const { DYNAMIC } = require("./graph");
const { maskPath } = require("./redact");

/** Webhook label with the path masked (first 4 chars + hash) unless showPaths. */
function hookLabel(n, showPaths) {
  const p = n.attrs && n.attrs.path;
  if (showPaths || !p || p === DYNAMIC) return n.label;
  return `${n.attrs.method} /${maskPath(p)}`;
}

function index(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map();
  const inn = new Map();
  for (const l of graph.links) {
    if (!out.has(l.source)) out.set(l.source, []);
    out.get(l.source).push(l);
    if (!inn.has(l.target)) inn.set(l.target, []);
    inn.get(l.target).push(l);
  }
  return { byId, out, inn };
}

const REL_FOR = {
  credential: "uses_credential",
  host: "calls_host",
  sheet: "reads_writes",
  env: "reads_env",
};
const NODE_TYPE_FOR = {
  credential: "credential",
  host: "host",
  sheet: "sheet",
  env: "envvar",
  workflow: "workflow",
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function matchNodes(graph, kind, value) {
  const q = String(value).trim().toLowerCase();
  const type = NODE_TYPE_FOR[kind];
  return graph.nodes.filter((n) => {
    if (n.type !== type) return false;
    if (n.label.toLowerCase() === q) return true;
    const a = n.attrs;
    if (kind === "credential" || kind === "workflow")
      return String(a.n8nId || "").toLowerCase() === q;
    if (kind === "sheet") return String(a.documentId || "").toLowerCase() === q;
    return false;
  });
}

const tag = (n) => `[${n.attrs.instance}] ${n.label}`;

/**
 * Who is affected if the target dies. Direct users, then transitive callers through
 * calls_workflow (cycle safe), plus error-handler notes.
 */
function blast(graph, kind, value) {
  const ix = index(graph);
  const matches = matchNodes(graph, kind, value);
  const affected = new Map(); // wfId -> {distance, chain:[ids], target}
  const queue = [];

  for (const m of matches) {
    if (kind === "workflow") {
      if (!affected.has(m.id)) {
        affected.set(m.id, { distance: 0, chain: [m.id], target: m });
        queue.push(m.id);
      }
      continue;
    }
    for (const l of ix.inn.get(m.id) || []) {
      if (l.rel !== REL_FOR[kind]) continue;
      if (!affected.has(l.source)) {
        affected.set(l.source, { distance: 0, chain: [l.source], target: m });
        queue.push(l.source);
      }
    }
  }
  // BFS upward: callers of an affected sub-workflow are affected too.
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const info = affected.get(cur);
    for (const l of ix.inn.get(cur) || []) {
      if (l.rel !== "calls_workflow" || affected.has(l.source)) continue;
      affected.set(l.source, {
        distance: info.distance + 1,
        chain: [l.source, ...info.chain],
        target: info.target,
      });
      queue.push(l.source);
    }
  }

  const rows = [...affected.entries()]
    .map(([id, info]) => {
      const n = ix.byId.get(id);
      const names = info.chain.map((c) => ix.byId.get(c).label);
      if (kind !== "workflow")
        names.push(
          `uses ${info.target.label} [${info.target.attrs.instance || "all instances"}]`,
        );
      return {
        id,
        name: n.label,
        instance: n.attrs.instance,
        active: n.attrs.active === true,
        missing: n.attrs.missing === true,
        distance: info.distance,
        via: info.distance === 0 ? "direct" : "sub-workflow",
        why: names.join(" -> "),
      };
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        cmp(a.instance, b.instance) ||
        cmp(a.name, b.name),
    );

  const errorHandlerNotes = [];
  for (const r of rows) {
    const prot = (ix.inn.get(r.id) || [])
      .filter((l) => l.rel === "error_handler")
      .map((l) => ix.byId.get(l.source));
    if (prot.length)
      errorHandlerNotes.push({
        handler: `[${r.instance}] ${r.name}`,
        protects: prot.map(tag).sort(),
        note: "These workflows use the affected workflow as their error workflow, so their failures will go unreported.",
      });
  }
  const real = rows.filter((r) => !r.missing);
  return {
    query: { kind, value },
    matches: matches.map((m) => ({
      id: m.id,
      label: m.label,
      instance: m.attrs.instance || null,
      type: m.type,
      ...(m.attrs.credType ? { credType: m.attrs.credType } : {}),
    })),
    affected: rows,
    errorHandlerNotes,
    summary: {
      total: real.length,
      active: real.filter((r) => r.active).length,
      inactive: real.filter((r) => !r.active).length,
      direct: real.filter((r) => r.distance === 0).length,
      viaSubWorkflow: real.filter((r) => r.distance > 0).length,
    },
  };
}

function blastText(res) {
  const { kind, value } = res.query;
  const L = [];
  L.push(`Blast radius: ${kind} "${value}"`);
  if (!res.matches.length) {
    L.push(`  No ${kind} matches "${value}" in this graph.`);
    return L.join("\n") + "\n";
  }
  const many = res.matches.length > 1;
  L.push(
    `  Matches ${res.matches.length} ${kind === "env" ? "env var" : kind}${many ? "s" : ""}${many && kind === "credential" ? " (same name, separate credentials, never merged)" : ""}:`,
  );
  for (const m of res.matches)
    L.push(
      `    - ${m.instance ? `[${m.instance}] ` : ""}${m.label}${m.credType ? ` (${m.credType.join(", ")})` : ""}`,
    );
  const s = res.summary;
  L.push("");
  L.push(
    `  If ${many ? "these" : "it"} stop${many ? "" : "s"} working: ${s.total} workflow${s.total === 1 ? "" : "s"} affected (${s.active} active, ${s.inactive} inactive; ${s.direct} direct, ${s.viaSubWorkflow} via sub-workflow calls)`,
  );
  for (const r of res.affected) {
    L.push(
      `    ${r.distance === 0 ? "direct" : "chain "}  [${r.instance}] ${r.name}  (${r.missing ? "not in input" : r.active ? "active" : "inactive"})`,
    );
    if (r.distance > 0 || kind !== "workflow")
      L.push(`            why: ${r.why}`);
  }
  for (const n of res.errorHandlerNotes)
    L.push(
      `  note: ${n.handler} is the error workflow for ${n.protects.join(", ")}. Their failures would go unreported.`,
    );
  return L.join("\n") + "\n";
}

/** Single points of failure. */
function spof(graph, min = 3, opts = {}) {
  const ix = index(graph);
  const users = (id, rel) =>
    (ix.inn.get(id) || [])
      .filter((l) => l.rel === rel)
      .map((l) => ix.byId.get(l.source));
  const rank = (a, b) =>
    b.activeWorkflows - a.activeWorkflows ||
    cmp(a.label + (a.instance || ""), b.label + (b.instance || ""));

  const credentials = [];
  for (const n of graph.nodes.filter((x) => x.type === "credential")) {
    const u = users(n.id, "uses_credential");
    const act = u.filter((w) => w.attrs.active);
    if (act.length >= min)
      credentials.push({
        label: n.label,
        instance: n.attrs.instance,
        credType: n.attrs.credType || [],
        activeWorkflows: act.length,
        totalWorkflows: u.length,
        workflows: act.map((w) => w.label).sort(),
      });
  }
  const hosts = [];
  for (const n of graph.nodes.filter(
    (x) => x.type === "host" && x.label !== DYNAMIC,
  )) {
    const u = users(n.id, "calls_host");
    const act = u.filter((w) => w.attrs.active);
    if (act.length >= min)
      hosts.push({
        label: n.label,
        instance: "",
        activeWorkflows: act.length,
        totalWorkflows: u.length,
        workflows: act.map((w) => `[${w.attrs.instance}] ${w.label}`).sort(),
      });
  }
  const noErrorWorkflow = graph.nodes
    .filter((w) => {
      if (
        w.type !== "workflow" ||
        w.attrs.missing ||
        !w.attrs.active ||
        w.attrs.isErrorHandler
      )
        return false;
      if ((ix.out.get(w.id) || []).some((l) => l.rel === "error_handler"))
        return false;
      const t = w.attrs.triggerTypes || [];
      return !(t.length && t.every((x) => x === "executeWorkflow"));
    })
    .map((w) => ({ label: w.label, instance: w.attrs.instance }))
    .sort((a, b) => cmp(a.instance + a.label, b.instance + b.label));
  const openWebhooks = [];
  for (const n of graph.nodes.filter(
    (x) => x.type === "webhook" && x.attrs.authentication === "none",
  )) {
    const u = users(n.id, "exposes_webhook");
    openWebhooks.push({
      webhook: hookLabel(n, opts.showPaths),
      instance: n.attrs.instance,
      workflows: u
        .map((w) => ({ label: w.label, active: w.attrs.active === true }))
        .sort((a, b) => cmp(a.label, b.label)),
      active: u.some((w) => w.attrs.active),
    });
  }
  openWebhooks.sort((a, b) =>
    cmp(a.instance + a.webhook, b.instance + b.webhook),
  );
  const subworkflows = [];
  for (const n of graph.nodes.filter(
    (x) => x.type === "workflow" && !x.attrs.missing,
  )) {
    const callers = [
      ...new Set(
        users(n.id, "calls_workflow")
          .filter((w) => w.attrs.active)
          .map((w) => w.label),
      ),
    ].sort();
    if (callers.length >= min)
      subworkflows.push({
        label: n.label,
        instance: n.attrs.instance,
        callers: callers.length,
        workflows: callers,
      });
  }
  credentials.sort(rank);
  hosts.sort(rank);
  subworkflows.sort((a, b) => b.callers - a.callers || cmp(a.label, b.label));
  return {
    min,
    credentials,
    hosts,
    noErrorWorkflow,
    openWebhooks,
    subworkflows,
    orphanCredentials: {
      available: false,
      note: "Skipped: the n8n public API does not list unused credentials, so only credentials referenced by a workflow are known.",
    },
  };
}

function spofText(r) {
  const L = [
    `Single points of failure (threshold ${r.min} active workflows)`,
    "",
  ];
  const sec = (title, rows, fmt) => {
    L.push(`${title}: ${rows.length}`);
    for (const x of rows) L.push(`  - ${fmt(x)}`);
    L.push("");
  };
  sec(
    "Credentials",
    r.credentials,
    (c) => `[${c.instance}] ${c.label}: ${c.activeWorkflows} active workflows`,
  );
  sec(
    "External hosts",
    r.hosts,
    (h) => `${h.label}: ${h.activeWorkflows} active workflows`,
  );
  sec(
    "Active workflows with no error workflow",
    r.noErrorWorkflow,
    (w) => `[${w.instance}] ${w.label}`,
  );
  sec(
    "Webhooks with authentication none",
    r.openWebhooks,
    (w) =>
      `[${w.instance}] ${w.webhook} (${w.workflows.map((x) => x.label).join(", ")})`,
  );
  sec(
    "Sub-workflows called by many",
    r.subworkflows,
    (s) => `[${s.instance}] ${s.label}: ${s.callers} callers`,
  );
  L.push(`Orphan credentials: ${r.orphanCredentials.note}`);
  return L.join("\n") + "\n";
}

module.exports = { hookLabel, blast, blastText, spof, spofText, index, matchNodes };
