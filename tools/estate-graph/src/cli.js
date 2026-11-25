"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { loadDir } = require("./inputs");
const { fetchWorkflows, scrubKey, normaliseBase } = require("./api");
const { buildGraph } = require("./graph");
const { sanitizeGraph, safe } = require("./scrub");
const { blast, blastText, spof, spofText, matchNodes } = require("./query");
const { markdown, html } = require("./render");
const { redactGraph, h } = require("./redact");

const VERSION = require("../package.json").version;

const HELP = `n8n-estate-graph ${VERSION}
Map every n8n workflow you run into a dependency graph, then ask what breaks if X dies.

Usage:
  n8n-estate-graph build [inputs] [--out DIR] [--date YYYY-MM-DD]
  n8n-estate-graph blast [inputs | --graph FILE] (--credential X | --host X | --sheet X | --workflow X | --env X) [--json]
  n8n-estate-graph spof  [inputs | --graph FILE] [--min N] [--json]

Inputs (repeatable):
  --from-dir DIR          folder of exported workflow JSON (recursive)
  --label NAME            client label for the matching --from-dir (default: each first-level
                          subfolder is one client; loose files use the folder name)
  --instance LABEL=URL    n8n instance, read via GET only. Key in env N8N_API_KEY_<LABEL>
                          (or N8N_API_KEY when there is a single instance)

Output safety:
  --redact-all            hash credential names/ids, workflow names/ids, sheet ids and tab
                          names, webhook paths, hostnames and any email (build/blast/spof)
  --show-paths            print raw custom webhook paths in spof and the reports (default:
                          first 4 chars + hash)

Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 input had zero workflows,
            4 blast matched nothing.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { dirs: [], labels: [], instances: [], target: [], flags: {} };
  const valued = new Set([
    "--from-dir",
    "--label",
    "--instance",
    "--graph",
    "--out",
    "--date",
    "--min",
    "--credential",
    "--host",
    "--sheet",
    "--workflow",
    "--env",
  ]);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val;
    if (a.startsWith("--") && a.includes("=")) {
      val = a.slice(a.indexOf("=") + 1);
      a = a.slice(0, a.indexOf("="));
    }
    if (a === "--help" || a === "-h") o.flags.help = true;
    else if (a === "--version" || a === "-v") o.flags.version = true;
    else if (a === "--json") o.flags.json = true;
    else if (a === "--redact-all") o.flags.redactAll = true;
    else if (a === "--show-paths") o.flags.showPaths = true;
    else if (valued.has(a)) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith("--"))
          throw new UsageError(`${a} needs a value`);
      }
      if (a === "--from-dir") o.dirs.push(val);
      else if (a === "--label") o.labels.push(val);
      else if (a === "--instance") o.instances.push(val);
      else if (
        ["--credential", "--host", "--sheet", "--workflow", "--env"].includes(a)
      )
        o.target.push([a.slice(2), val]);
      else o[a.slice(2)] = val;
    } else if (a.startsWith("-")) throw new UsageError(`Unknown option: ${a}`);
    else rest.push(a);
  }
  o.command = rest[0];
  if (rest.length > 1) throw new UsageError(`Unexpected argument: ${rest[1]}`);
  return o;
}

async function collect(o, env, fetchImpl) {
  const items = [];
  const sources = [];
  const inputFiles = { total: 0, skipped: 0 };
  const skippedNames = [];
  o.dirs.forEach((d, i) => {
    // Explicit --label wins. Otherwise each first-level subfolder is its own client
    // (examples/workflows/acme-dental/*.json -> "acme-dental"); loose files use the folder name.
    const root = path.resolve(d);
    const r = loadDir(d);
    inputFiles.total += r.files;
    inputFiles.skipped += r.skipped;
    skippedNames.push(...r.skippedFiles);
    const seen = new Set();
    for (const { wf, file } of r.entries) {
      let label = o.labels[i];
      if (!label) {
        const rel = path.relative(root, path.resolve(file)).split(path.sep);
        label = rel.length > 1 ? rel[0] : path.basename(root);
      }
      items.push({ instance: label, wf });
      if (!seen.has(label)) {
        seen.add(label);
        sources.push({ label, kind: "dir" });
      }
    }
    if (!seen.size)
      sources.push({ label: o.labels[i] || path.basename(root), kind: "dir" });
  });
  if (o.labels.length > o.dirs.length)
    throw new UsageError("--label given more times than --from-dir");
  for (const spec of o.instances) {
    const eq = spec.indexOf("=");
    if (eq < 1)
      throw new UsageError(
        `--instance expects LABEL=URL, got: ${spec.slice(0, 40)}`,
      );
    const label = spec.slice(0, eq);
    const url = spec.slice(eq + 1);
    const varName = `N8N_API_KEY_${label.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const key =
      env[varName] || (o.instances.length === 1 ? env.N8N_API_KEY : "");
    if (!key)
      throw new UsageError(
        `No API key for instance "${label}". Set ${varName}${o.instances.length === 1 ? " or N8N_API_KEY" : ""}.`,
      );
    let base;
    try {
      base = normaliseBase(url);
    } catch (e) {
      throw new UsageError(scrubKey(e.message, key));
    }
    let wfs;
    try {
      wfs = await fetchWorkflows({ baseUrl: base, apiKey: key, fetchImpl });
    } catch (e) {
      const err = new Error(scrubKey(e.message, key));
      err.runtime = true;
      throw err;
    }
    for (const wf of wfs) items.push({ instance: label, wf });
    sources.push({ label, kind: "api", host: new URL(base).host });
  }
  return { items, sources, inputFiles, skippedNames };
}

function loadGraph(file) {
  let g;
  try {
    g = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`Cannot read graph file: ${file}`);
  }
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.links) || !g.meta)
    throw new UsageError(`Not an n8n-estate-graph graph.json: ${file}`);
  return g;
}

async function getGraph(o, env, fetchImpl, err) {
  if (o.graph) {
    if (o.dirs.length || o.instances.length)
      throw new UsageError("Use either --graph or inputs, not both");
    return sanitizeGraph(loadGraph(o.graph));
  }
  if (!o.dirs.length && !o.instances.length)
    throw new UsageError("No input. Give --from-dir, --instance or --graph.");
  const { items, sources, inputFiles, skippedNames } = await collect(
    o,
    env,
    fetchImpl,
  );
  if (inputFiles.skipped) {
    const shown = o.flags.redactAll
      ? "(names hidden by --redact-all)"
      : skippedNames
          .slice(0, 5)
          .map((n) => safe(n))
          .join(", ");
    err(`Skipped ${inputFiles.skipped} of ${inputFiles.total} files (not n8n workflow JSON): ${shown}${!o.flags.redactAll && skippedNames.length > 5 ? ", ..." : ""}
`);
  }
  return buildGraph(items, { date: o.date, sources, inputFiles });
}

/** @returns {Promise<number>} exit code */
async function main(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  const env = io.env || process.env;
  try {
    const o = parseArgs(argv);
    if (o.flags.version) return (out(`${VERSION}\n`), 0);
    if (o.flags.help || !o.command) {
      out(HELP);
      return o.command || o.flags.help ? 0 : 2;
    }
    if (!["build", "blast", "spof"].includes(o.command))
      throw new UsageError(`Unknown command: ${o.command}`);
    if (o.date !== undefined) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.date);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (
        !d ||
        d.getUTCFullYear() !== +m[1] ||
        d.getUTCMonth() !== +m[2] - 1 ||
        d.getUTCDate() !== +m[3]
      )
        throw new UsageError("--date must be a real date in YYYY-MM-DD form");
    }
    let min = 3;
    if (o.min !== undefined) {
      min = Number(o.min);
      if (!Number.isInteger(min) || min < 1)
        throw new UsageError("--min must be a whole number >= 1");
    }
    if (o.command === "blast" && o.target.length !== 1)
      throw new UsageError(
        "blast needs exactly one of --credential, --host, --sheet, --workflow, --env",
      );
    if (o.command !== "blast" && o.target.length)
      throw new UsageError(
        "--credential/--host/--sheet/--workflow/--env belong to the blast command",
      );

    const g0 = await getGraph(o, env, io.fetch, err);
    let g = g0;
    let idMap = null;
    if (o.flags.redactAll) ({ graph: g, idMap } = redactGraph(g0));
    const showPaths = o.flags.showPaths === true && !o.flags.redactAll;
    if (!g.meta.counts || g.meta.counts.workflows === 0) {
      err("No workflows found in the input.\n");
      return 3;
    }

    if (o.command === "build") {
      const dir = path.resolve(o.out || "estate-graph-out");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "graph.json"),
        JSON.stringify(g, null, 2) + "\n",
      );
      fs.writeFileSync(
        path.join(dir, "report.md"),
        markdown(g, { min, showPaths }),
      );
      fs.writeFileSync(
        path.join(dir, "report.html"),
        html(g, { min, showPaths }),
      );
      const c = g.meta.counts;
      out(
        `Workflows: ${c.workflows} (${c.activeWorkflows} active)\nCredentials: ${c.credentials}\nHosts: ${c.hosts}\nWebhooks: ${c.webhooks}\nSheets: ${c.sheets}\nEnv vars: ${c.envvars}\nWrote graph.json, report.md, report.html to ${dir}\n`,
      );
      return 0;
    }
    if (o.command === "blast") {
      const [kind, value] = o.target[0];
      let q = value;
      if (idMap) {
        // Match on the real graph, then ask the redacted graph about the hashed twin.
        const first = matchNodes(g0, kind, value)[0];
        const red = first && g.nodes.find((n) => n.id === idMap.get(first.id));
        q = red ? red.label : h(kind, value);
      }
      const res = blast(g, kind, q);
      out(o.flags.json ? JSON.stringify(res, null, 2) + "\n" : blastText(res));
      return res.matches.length ? 0 : 4;
    }
    const r = spof(g, min, { showPaths });
    out(o.flags.json ? JSON.stringify(r, null, 2) + "\n" : spofText(r));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`Error: ${e.message}\nRun with --help for usage.\n`);
      return 2;
    }
    err(`Error: ${e.message}\n`);
    return 1;
  }
}

module.exports = { main, parseArgs, UsageError };
