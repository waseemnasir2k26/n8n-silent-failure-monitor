"use strict";
const fs = require("fs");
const path = require("path");
const { loadConfig, silenceFrom } = require("./config");
const { evaluateAll } = require("./evaluate");
const { fetchInstance } = require("./api");
const { renderTable } = require("./table");
const { parseDuration } = require("./duration");

const HELP = `n8n silent-failure check: finds workflows that stopped running, not just ones that errored.

Usage:
  nsfm check [options]

Sources (pick one):
  --config <file>        JSON listing clients and the env var NAMES for URL and key
  --from-file <file>     offline export: {"workflows":[...],"executions":[...]}
  (neither)              one instance from N8N_BASE_URL and N8N_API_KEY

Options:
  --json                    machine-readable output
  --all                     also list disabled and non-scheduled workflows
  --client <name>           only this client from the config
  --factor <n>              stalled when no run for n x expected interval (default 2)
  --fail-runs <n>           failing when the last n runs errored (default 3)
  --webhook-max-silence <d> flag webhook workflows silent longer than d (30m, 24h, 2d)
  --now <ISO time>          pretend it is this time (for repeatable output)
  -h, --help

Exit codes: 0 all fine, 1 something STALLED or FAILING, 2 could not check (bad input, API error).`;

function parseArgs(argv) {
  const o = { json: false, all: false };
  const takes = new Set([
    "--config",
    "--from-file",
    "--client",
    "--factor",
    "--fail-runs",
    "--webhook-max-silence",
    "--now",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--all") o.all = true;
    else if (takes.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// Accepts {workflows, executions: [..] | {id:[..]}} or n8n-style pages ({data:[..]}).
function readExport(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr = (v) =>
    Array.isArray(v) ? v : v && Array.isArray(v.data) ? v.data : [];
  const workflows = arr(j.workflows);
  let executions = {};
  if (
    Array.isArray(j.executions) ||
    (j.executions && Array.isArray(j.executions.data))
  ) {
    for (const e of arr(j.executions))
      (executions[String(e.workflowId)] ||= []).push(e);
  } else if (j.executions && typeof j.executions === "object")
    executions = j.executions;
  return { workflows, executions };
}

async function run(
  argv,
  env = process.env,
  io = {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    isTTY: process.stdout.isTTY,
  },
) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    io.err(`error: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (o.help) {
    io.out(HELP);
    return 0;
  }
  try {
    const now = o.now ? Date.parse(o.now) : Date.now();
    if (!Number.isFinite(now)) throw new Error("--now is not a valid time");
    const factor = o.factor != null ? Number(o.factor) : null;
    const failRuns = o.failRuns != null ? Number(o.failRuns) : null;
    if (
      (factor !== null && !(factor >= 1)) ||
      (failRuns !== null && !(Number.isInteger(failRuns) && failRuns >= 1))
    )
      throw new Error(
        "--factor must be >= 1 and --fail-runs a whole number >= 1",
      );
    const cliSilence = o.webhookMaxSilence
      ? silenceFrom(o.webhookMaxSilence, "--webhook-max-silence")
      : null;

    let cfg;
    if (o.config) cfg = loadConfig(o.config);
    else if (o.fromFile)
      cfg = { defaults: {}, clients: [{ name: "export", file: o.fromFile }] };
    else
      cfg = {
        defaults: {},
        clients: [
          { name: "default", urlEnv: "N8N_BASE_URL", keyEnv: "N8N_API_KEY" },
        ],
      };
    const baseDir = o.config
      ? path.dirname(path.resolve(o.config))
      : process.cwd();
    let clients = cfg.clients;
    if (o.client) {
      clients = clients.filter((c) => c.name === o.client);
      if (!clients.length)
        throw new Error(`no client named "${o.client}" in the config`);
    }

    const results = [];
    const errors = [];
    for (const c of clients) {
      try {
        let data;
        if (c.file)
          data = readExport(
            o.fromFile ? c.file : path.resolve(baseDir, c.file),
          );
        else {
          const url = env[c.urlEnv];
          const key = env[c.keyEnv];
          if (!url || !key)
            throw new Error(
              `environment variable ${!url ? c.urlEnv : c.keyEnv} is not set`,
            );
          data = await fetchInstance({ url, key });
        }
        const rows = evaluateAll(data.workflows, data.executions, {
          now,
          factor: factor ?? cfg.defaults.factor ?? 2,
          failN: failRuns ?? cfg.defaults.failRuns ?? 3,
          webhookSilence:
            cliSilence ||
            c.webhookSilence ||
            cfg.defaults.webhookSilence ||
            null,
        });
        for (const r of rows) results.push({ client: c.name, ...r });
      } catch (e) {
        errors.push({
          client: c.name,
          error: String(e.message || e).slice(0, 300),
        });
      }
    }

    const count = (s) => results.filter((r) => r.status === s).length;
    const summary = {
      total: results.length,
      stalled: count("STALLED"),
      failing: count("FAILING"),
      ok: count("OK"),
      disabled: count("DISABLED"),
      skipped: count("SKIP"),
      errors: errors.length,
    };
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            generatedAt: new Date(now).toISOString(),
            summary,
            results,
            errors,
          },
          null,
          2,
        ),
      );
    } else {
      if (results.length)
        io.out(
          renderTable(results, {
            now,
            showAll: o.all,
            color: !!io.isTTY && !env.NO_COLOR,
          }),
        );
      for (const e of errors)
        io.err(`could not check "${e.client}": ${e.error}`);
    }
    if (errors.length) return 2;
    return summary.stalled || summary.failing ? 1 : 0;
  } catch (e) {
    io.err(`error: ${e.message}`);
    return 2;
  }
}

module.exports = { run, parseArgs, readExport, HELP };
