"use strict";
// Build the estate graph from parsed n8n workflows.
//
// SAFETY: only an allow-list of fields is ever read from a node (type, disabled,
// credentials {id,name}, and a handful of parameters named below). Every string that
// reaches the graph goes through S(), which runs the secret scrubber. Sticky notes,
// pinned data, static data and every other parameter are never emitted.

const { collectEnvRefs } = require("./secrets");
const { safe, safeId, scrubPath, scrubHost, sanitizeGraph } = require("./scrub");
const { clean } = require("./util");

const DYNAMIC = "dynamic-expression";

// Node type (short name, lower case, "trigger" stripped) -> API host.
const SERVICE_HOSTS = {
  slack: "slack.com",
  stripe: "api.stripe.com",
  openai: "api.openai.com",
  lmchatopenai: "api.openai.com",
  embeddingsopenai: "api.openai.com",
  anthropic: "api.anthropic.com",
  lmchatanthropic: "api.anthropic.com",
  lmchatgooglegemini: "generativelanguage.googleapis.com",
  lmchatgroq: "api.groq.com",
  googlesheets: "sheets.googleapis.com",
  googledocs: "docs.googleapis.com",
  googledrive: "www.googleapis.com",
  googlecalendar: "www.googleapis.com",
  gmail: "gmail.googleapis.com",
  youtube: "www.googleapis.com",
  airtable: "api.airtable.com",
  notion: "api.notion.com",
  telegram: "api.telegram.org",
  twilio: "api.twilio.com",
  sendgrid: "api.sendgrid.com",
  github: "api.github.com",
  hubspot: "api.hubapi.com",
  shopify: "myshopify.com",
  discord: "discord.com",
  whatsapp: "graph.facebook.com",
  facebookgraphapi: "graph.facebook.com",
  mailchimp: "api.mailchimp.com",
  linkedin: "api.linkedin.com",
  twitter: "api.twitter.com",
  microsoftoutlook: "graph.microsoft.com",
  microsoftexcel: "graph.microsoft.com",
  microsoftteams: "graph.microsoft.com",
  asana: "app.asana.com",
  trello: "api.trello.com",
  clickup: "api.clickup.com",
  zoom: "api.zoom.us",
  calendly: "api.calendly.com",
  typeform: "api.typeform.com",
  elevenlabs: "api.elevenlabs.io",
  gohighlevel: "services.leadconnectorhq.com",
};

const NON_TRIGGER = new Set(["manualtrigger", "executeworkflowtrigger"]);

function shortType(type) {
  return String(type || "")
    .split(".")
    .pop();
}

/** Scrub a string for output. entropy=false for identifiers (ids, types), true for names. */
function S(v, entropy = true, allow) {
  return entropy ? safe(v, allow) : safeId(v);
}

function isExpr(v) {
  return typeof v === "string" && (v.startsWith("=") || v.includes("{{"));
}

/** Resource-locator or plain string -> { value, name, mode }. */
function rl(p) {
  if (p == null) return null;
  if (typeof p === "string" || typeof p === "number")
    return { value: String(p), name: "", mode: "" };
  if (typeof p === "object" && p.value != null)
    return {
      value: String(p.value),
      name: typeof p.cachedResultName === "string" ? p.cachedResultName : "",
      mode: typeof p.mode === "string" ? p.mode : "",
    };
  return null;
}

/** URL (possibly an expression) -> hostname only. */
function hostFromUrl(raw) {
  if (typeof raw !== "string") return DYNAMIC;
  let s = raw.trim();
  if (s.startsWith("=")) s = s.slice(1).trim();
  if (!s) return DYNAMIC;
  let host = "";
  if (s.includes("{{")) {
    const prefix = s.slice(0, s.indexOf("{{"));
    const m = /^https?:\/\/(?:[^/@\s]*@)?([^/?#:\s@]+)(?::\d+)?[/?#]/i.exec(
      prefix,
    );
    if (!m) return DYNAMIC;
    host = m[1];
  } else {
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
        .hostname;
    } catch {
      return DYNAMIC;
    }
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (
    !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(host) &&
    !/^\[[0-9a-f:.]+\]$/.test(host)
  )
    return DYNAMIC;
  if (S(host, false) !== host) return DYNAMIC;
  return scrubHost(host);
}

/** Google Sheets/Docs/Drive id from an id or a docs.google.com URL. */
function googleId(v) {
  if (!v || isExpr(v)) return null;
  const m = /\/(?:d|folders)\/([A-Za-z0-9_-]{10,100})/.exec(v);
  const id = m ? m[1] : v.trim();
  return /^[A-Za-z0-9_-]{6,100}$/.test(id) && S(id, false) === id ? id : null;
}

function plainId(v) {
  return typeof v === "string" &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(v) &&
    S(v, false) === v
    ? v
    : null;
}

function scheduleSummary(node) {
  const type = shortType(node.type).toLowerCase();
  const p = node.parameters || {};
  const parts = [];
  if (type === "scheduletrigger") {
    const items =
      p.rule && Array.isArray(p.rule.interval) ? p.rule.interval : [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const f = String(it.field || "");
      const num = (k) => (typeof it[k] === "number" ? it[k] : null);
      if (
        f === "cronExpression" &&
        typeof it.expression === "string" &&
        /^[\w*/,\- ?]{1,60}$/.test(it.expression)
      )
        parts.push(`cron ${it.expression.trim()}`);
      else if (f === "seconds")
        parts.push(`every ${num("secondsInterval") || 1}s`);
      else if (f === "minutes")
        parts.push(`every ${num("minutesInterval") || 1}m`);
      else if (f === "hours") parts.push(`every ${num("hoursInterval") || 1}h`);
      else if (f === "days" || f === "") {
        const h = num("triggerAtHour");
        const n = num("daysInterval") || 1;
        parts.push(
          `${n === 1 ? "daily" : `every ${n} days`}${h != null ? ` at ${String(h).padStart(2, "0")}:00` : ""}`,
        );
      } else if (f === "weeks") parts.push("weekly");
      else if (f === "months") parts.push("monthly");
    }
  } else if (type === "interval") {
    if (typeof p.interval === "number")
      parts.push(
        `every ${p.interval} ${typeof p.unit === "string" ? p.unit : "seconds"}`,
      );
  } else if (type === "cron") {
    const items =
      p.triggerTimes && Array.isArray(p.triggerTimes.item)
        ? p.triggerTimes.item
        : [];
    for (const it of items)
      if (it && typeof it.mode === "string") parts.push(`cron node ${it.mode}`);
  }
  return S(parts.length ? parts.join(", ") : "schedule (unspecified)", false);
}

/**
 * @param {{instance:string, wf:object}[]} items
 * @param {{date?:string, sources?:object[]}} opts
 */
function buildGraph(items, opts = {}) {
  const nodes = new Map();
  const links = new Map();
  const dynamicRefs = { hosts: 0, sheets: 0, workflows: 0, webhooks: 0 };

  const addNode = (id, type, label, attrs = {}) => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, type, label, attrs: {} };
      nodes.set(id, n);
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (Array.isArray(v)) {
        const cur = n.attrs[k] || [];
        n.attrs[k] = [...new Set([...cur, ...v])].sort();
      } else if (v !== undefined && n.attrs[k] === undefined) n.attrs[k] = v;
    }
    return n;
  };
  const link = (source, target, rel) =>
    links.set(`${source}\u0000${target}\u0000${rel}`, { source, target, rel });

  // Pass 1: workflow nodes + resolution indexes.
  const byId = new Map();
  const byName = new Map();
  const seen = new Set();
  const records = [];
  for (const { instance, wf } of items) {
    if (!wf || typeof wf !== "object" || !Array.isArray(wf.nodes)) continue;
    const inst = S(instance, false);
    const name = S(
      wf.name == null || wf.name === "" ? "(unnamed workflow)" : wf.name,
    );
    const n8nId = wf.id != null ? plainId(String(wf.id)) : null;
    const key = n8nId || `name:${name}`;
    const id = `wf:${inst}:${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({ inst, wf, id, name, n8nId });
    byId.set(`${inst}\u0000${n8nId || ""}`, id);
    if (!byName.has(`${inst}\u0000${name}`))
      byName.set(`${inst}\u0000${name}`, id);
  }

  const resolveWf = (inst, ref) => {
    const r = rl(ref);
    if (!r || isExpr(r.value)) return { dynamic: true };
    const idv = plainId(r.value);
    if (idv && byId.has(`${inst}\u0000${idv}`))
      return { id: byId.get(`${inst}\u0000${idv}`) };
    if (r.name && byName.has(`${inst}\u0000${S(r.name)}`))
      return { id: byName.get(`${inst}\u0000${S(r.name)}`) };
    if (!idv) return { dynamic: true };
    return { stub: idv, name: r.name ? S(r.name) : `(not in input: ${idv})` };
  };

  for (const r of records) {
    const wf = r.wf;
    const real = (wf.nodes || []).filter(
      (n) => n && typeof n === "object" && shortType(n.type) !== "stickyNote",
    );
    const active = wf.active === true;
    const triggers = new Set();
    let isErrorHandler = false;
    for (const n of real) {
      if (n.disabled === true) continue;
      const st = shortType(n.type);
      const low = st.toLowerCase();
      if (low === "errortrigger") isErrorHandler = true;
      if (low === "executeworkflowtrigger") triggers.add("executeWorkflow");
      else if (
        !NON_TRIGGER.has(low) &&
        (low.endsWith("trigger") ||
          low === "webhook" ||
          low === "cron" ||
          low === "interval")
      )
        triggers.add(S(st, false));
    }
    const settings =
      wf.settings && typeof wf.settings === "object" ? wf.settings : {};
    const errWf =
      typeof settings.errorWorkflow === "string"
        ? plainId(settings.errorWorkflow)
        : null;
    addNode(r.id, "workflow", r.name, {
      instance: r.inst,
      active,
      n8nId: r.n8nId || "",
      triggerTypes: [...triggers].sort(),
      errorWorkflow: errWf || "",
      isErrorHandler,
    });

    if (errWf) {
      const t = resolveWf(r.inst, errWf);
      if (t.id) link(r.id, t.id, "error_handler");
      else if (t.stub) {
        const sid = `wf:${r.inst}:${t.stub}`;
        addNode(sid, "workflow", t.name, {
          instance: r.inst,
          active: false,
          n8nId: t.stub,
          missing: true,
        });
        link(r.id, sid, "error_handler");
      }
    }

    let hookN = 0;
    for (const node of real) {
      if (node.disabled === true) continue;
      const type = String(node.type || "");
      const st = shortType(type);
      const low = st.toLowerCase();
      const base = low.replace(/trigger$/, "");
      const p =
        node.parameters && typeof node.parameters === "object"
          ? node.parameters
          : {};

      // credentials: id + NAME only, never data
      if (node.credentials && typeof node.credentials === "object") {
        for (const [credType, c] of Object.entries(node.credentials)) {
          if (!c || typeof c !== "object") continue;
          const cname = S(
            c.name == null || c.name === "" ? "(unnamed credential)" : c.name,
          );
          const cid = c.id != null ? plainId(String(c.id)) : null;
          const id = `cred:${r.inst}:${cid || `name:${cname}`}`;
          addNode(id, "credential", cname, {
            instance: r.inst,
            credType: [S(credType, false)],
            n8nId: cid || "",
          });
          link(r.id, id, "uses_credential");
        }
      }

      // webhooks
      if (low === "webhook" || low === "formtrigger") {
        let path =
          typeof p.path === "string" && p.path
            ? p.path
            : typeof node.webhookId === "string"
              ? node.webhookId
              : "";
        path = path.replace(/^\/+/, "");
        if (
          !path ||
          isExpr(path) ||
          !/^[\w\-./:{}]{1,200}$/.test(path)
        ) {
          path = DYNAMIC;
          dynamicRefs.webhooks++;
        } else path = scrubPath(path);
        const method =
          low === "formtrigger"
            ? "GET"
            : typeof p.httpMethod === "string" &&
                /^[A-Za-z]{3,7}$/.test(p.httpMethod)
              ? p.httpMethod.toUpperCase()
              : "GET";
        const auth =
          typeof p.authentication === "string" &&
          /^[A-Za-z]{2,30}$/.test(p.authentication)
            ? p.authentication
            : "none";
        // Identity never depends on the raw path: for auth none the path is the secret.
        const id = `hook:${r.id.slice(3)}:${hookN++}`;
        addNode(id, "webhook", `${method} /${path}`, {
          instance: r.inst,
          path,
          method,
          authentication: auth,
        });
        link(r.id, id, "exposes_webhook");
      }

      // hosts
      let host = null;
      if (low === "httprequest") {
        host = hostFromUrl(p.url);
      } else if (SERVICE_HOSTS[base]) host = SERVICE_HOSTS[base];
      if (host) {
        if (host === DYNAMIC) dynamicRefs.hosts++;
        addNode(`host:${host}`, "host", host, {});
        link(r.id, `host:${host}`, "calls_host");
      }

      // sheets / docs / drive / airtable
      if (
        low === "googlesheets" ||
        low === "googlesheetstrigger" ||
        low === "googledocs" ||
        low === "googledrive" ||
        low === "googledrivetrigger"
      ) {
        let found = null;
        for (const k of [
          "documentId",
          "documentURL",
          "spreadsheetId",
          "fileId",
          "folderId",
        ]) {
          if (p[k] == null) continue;
          const v = rl(p[k]);
          found = { v, id: v ? googleId(v.value) : null };
          break;
        }
        if (found && found.id) {
          const sn = rl(p.sheetName);
          const sheetName =
            sn && !isExpr(sn.value) ? S(sn.name || sn.value) : "";
          const kind = low.startsWith("googledrive")
            ? "drive"
            : low === "googledocs"
              ? "doc"
              : "sheet";
          addNode(
            `sheet:${found.id}`,
            "sheet",
            found.v.name ? S(found.v.name) : found.id,
            {
              kind,
              documentId: found.id,
              sheetNames: sheetName && sheetName !== "gid=0" ? [sheetName] : [],
            },
          );
          link(r.id, `sheet:${found.id}`, "reads_writes");
        } else if (found) dynamicRefs.sheets++;
      } else if (low === "airtable" || low === "airtabletrigger") {
        const b = rl(p.base);
        const t = rl(p.table);
        const bid = b && plainId(b.value);
        const tid = t && plainId(t.value);
        if (bid) {
          const id = `sheet:airtable:${bid}${tid ? `/${tid}` : ""}`;
          const label = `${b.name ? S(b.name) : bid}${tid ? ` / ${t.name ? S(t.name) : tid}` : ""}`;
          addNode(id, "sheet", label, {
            kind: "airtable",
            documentId: `${bid}${tid ? `/${tid}` : ""}`,
            sheetNames: [],
          });
          link(r.id, id, "reads_writes");
        } else if (b) dynamicRefs.sheets++;
      }

      // sub-workflow calls
      if (
        low === "executeworkflow" &&
        (p.source == null || p.source === "database")
      ) {
        const t = resolveWf(r.inst, p.workflowId);
        if (t.id) link(r.id, t.id, "calls_workflow");
        else if (t.stub) {
          const sid = `wf:${r.inst}:${t.stub}`;
          addNode(sid, "workflow", t.name, {
            instance: r.inst,
            active: false,
            n8nId: t.stub,
            missing: true,
          });
          link(r.id, sid, "calls_workflow");
        } else dynamicRefs.workflows++;
      }

      // schedules
      if (low === "scheduletrigger" || low === "cron" || low === "interval") {
        const sum = scheduleSummary(node);
        addNode(`sched:${sum}`, "schedule", sum, {});
        link(r.id, `sched:${sum}`, "triggered_by");
      }

      // env var names (names only)
      const env = collectEnvRefs(p).env.filter(
        (e) => /^[A-Za-z_]\w{0,80}$/.test(e) && S(e, false) === e,
      );
      for (const e of env) {
        addNode(`env:${r.inst}:${e}`, "envvar", e, { instance: r.inst });
        link(r.id, `env:${r.inst}:${e}`, "reads_env");
      }
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const n of nodeList) {
    const sorted = {};
    for (const k of Object.keys(n.attrs).sort()) sorted[k] = n.attrs[k];
    n.attrs = sorted;
  }
  const linkList = [...links.values()].sort((a, b) =>
    a.source !== b.source
      ? a.source < b.source
        ? -1
        : 1
      : a.target !== b.target
        ? a.target < b.target
          ? -1
          : 1
        : a.rel < b.rel
          ? -1
          : a.rel > b.rel
            ? 1
            : 0,
  );
  const wfs = nodeList.filter((n) => n.type === "workflow" && !n.attrs.missing);
  const count = (t) => nodeList.filter((n) => n.type === t).length;
  const meta = {
    tool: "n8n-estate-graph",
    version: require("../package.json").version,
    ...(opts.date ? { date: String(opts.date) } : {}),
    sources: (opts.sources || []).map((s) => ({
      label: S(s.label, false),
      kind: s.kind,
      ...(s.host ? { host: S(s.host, false) } : {}),
    })),
    counts: {
      workflows: wfs.length,
      activeWorkflows: wfs.filter((n) => n.attrs.active).length,
      credentials: count("credential"),
      hosts: count("host"),
      webhooks: count("webhook"),
      sheets: count("sheet"),
      envvars: count("envvar"),
      schedules: count("schedule"),
    },
    dynamicRefs,
    inputFiles: opts.inputFiles || { total: 0, skipped: 0 },
  };
  return sanitizeGraph({ meta, nodes: nodeList, links: linkList });
}

module.exports = { buildGraph, hostFromUrl, DYNAMIC, SERVICE_HOSTS };
