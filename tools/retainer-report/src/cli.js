"use strict";
const fs = require("fs");
const path = require("path");
const {
  dayStartUtc,
  dayOf,
  DAY,
  normalizeExecution,
  computeReport,
  weeklyEmail,
} = require("./core");
const { loadConfig, resolveWorkflows, ConfigError } = require("./config");
const { listWorkflows, listExecutions } = require("./api");
const { monthlyHtml } = require("./render");
const { narrative } = require("./llm");
const { redact, secretsFromEnv } = require("./redact");

const HELP = `n8n-retainer-report - weekly email and monthly one-pager from n8n execution metadata

Usage:
  n8n-retainer-report [options]

Options:
  --config <file>       Config (default: report.config.json)
  --from-file <file>    Offline mode: read executions (and workflows) from JSON instead of the API
  --out <dir>           Output directory (default: out)
  --end <YYYY-MM-DD>    Last day of the weekly window, UTC (default: yesterday)
  --month <YYYY-MM>     Month for the monthly report (default: the full month before --end)
  --demo                Run on the bundled sample data and write ./retainer-report-demo/
  --allow-http          Allow an http:// N8N_BASE_URL on a non-local host (the key is sent in cleartext)
  --narrative           Add a 3-sentence AI summary if GROQ_API_KEY or GEMINI_API_KEY is set
  --help, --version

Env (live mode): N8N_BASE_URL, N8N_API_KEY. Optional: GROQ_API_KEY, GEMINI_API_KEY.
`;

function parseArgs(argv) {
  const a = { config: "report.config.json", out: "out" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new ConfigError(k + " needs a value");
      return argv[++i];
    };
    if (k === "--config") a.config = val();
    else if (k === "--from-file") a.fromFile = val();
    else if (k === "--out") a.out = val();
    else if (k === "--end") a.end = val();
    else if (k === "--month") a.month = val();
    else if (k === "--narrative") a.narrative = true;
    else if (k === "--demo") a.demo = true;
    else if (k === "--allow-http") a.allowHttp = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--version" || k === "-v") a.version = true;
    else throw new ConfigError("Unknown option " + k);
  }
  return a;
}

function monthWindow(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || +m[2] < 1 || +m[2] > 12)
    throw new ConfigError('Invalid --month "' + ym + '", expected YYYY-MM');
  const y = +m[1],
    mo = +m[2] - 1;
  if (y < 2000 || y > 2100)
    throw new ConfigError('Invalid --month "' + ym + '", year must be 2000 to 2100');
  return {
    win: { startMs: Date.UTC(y, mo, 1), endMs: Date.UTC(y, mo + 1, 1) },
    prev: { startMs: Date.UTC(y, mo - 1, 1), endMs: Date.UTC(y, mo, 1) },
  };
}

function readOffline(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(
      "Cannot read executions file " + file + ": " + (e.code || e.message),
    );
  }
  const rawExec = Array.isArray(j) ? j : j && (j.executions || j.data);
  if (!Array.isArray(rawExec))
    throw new ConfigError(
      file + ' must be an array of executions or {"executions": [...]}',
    );
  const rawWf = Array.isArray(j) ? [] : j.workflows == null ? [] : j.workflows;
  if (!Array.isArray(rawWf))
    throw new ConfigError(file + ': "workflows" must be an array');
  const workflows = rawWf.map((w, i) => {
    const at = file + ": workflows[" + i + "]";
    if (!w || typeof w !== "object" || Array.isArray(w))
      throw new ConfigError(at + " must be an object");
    if (
      !(typeof w.id === "string" && w.id !== "") &&
      !(typeof w.id === "number" && Number.isInteger(w.id))
    )
      throw new ConfigError(at + ".id must be a string or an integer");
    if (w.tags != null && !Array.isArray(w.tags))
      throw new ConfigError(at + ".tags must be an array");
    return {
      id: String(w.id),
      name: String(w.name || ""),
      tags: (w.tags || []).map((t, k) => {
        if (typeof t === "string") return { name: t };
        if (t && typeof t === "object" && !Array.isArray(t))
          return { id: t.id, name: t.name };
        throw new ConfigError(at + ".tags[" + k + "] must be a string or object");
      }),
    };
  });
  const skipped = { badTimestamp: 0, noWorkflowId: 0, noId: 0 };
  const executions = [];
  for (const raw of rawExec) {
    if (!raw || typeof raw !== "object" || raw.workflowId == null) {
      skipped.noWorkflowId++;
      continue;
    }
    const e = normalizeExecution(raw);
    if (!e) {
      skipped.badTimestamp++;
      continue;
    }
    if (e.id == null) skipped.noId++;
    executions.push(e);
  }
  return { executions, workflows, skipped };
}

async function main(argv, env, deps) {
  const d = deps || {};
  const out = d.stdout || ((s) => process.stdout.write(s + "\n"));
  const err = d.stderr || ((s) => process.stderr.write(s + "\n"));
  const secrets = secretsFromEnv(env);
  try {
    const args = parseArgs(argv);
    if (args.help) return (out(HELP), 0);
    if (args.version) return (out(require("../package.json").version), 0);

    if (args.demo) {
      const ex = path.join(__dirname, "..", "examples");
      args.config = path.join(ex, "sample.config.json");
      args.fromFile = path.join(ex, "sample-executions.json");
      args.end = "2026-10-24";
      args.month = undefined;
      if (!argv.includes("--out")) args.out = "retainer-report-demo";
    }
    const cfg = loadConfig(args.config);
    const now = d.now ? d.now() : Date.now();
    const endDay = args.end || dayOf(now - DAY);
    let endMs;
    try {
      endMs = dayStartUtc(endDay) + DAY;
    } catch (e) {
      throw new ConfigError("Invalid --end: " + e.message);
    }
    const weekWin = { startMs: endMs - 7 * DAY, endMs };
    const weekPrev = { startMs: endMs - 14 * DAY, endMs: endMs - 7 * DAY };
    let month = args.month;
    if (!month) {
      const e = new Date(endMs - DAY);
      const prior = new Date(
        Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 1, 1),
      );
      month = prior.toISOString().slice(0, 7);
    }
    const mw = monthWindow(month);

    let executions,
      apiWorkflows,
      truncated = false;
    if (args.fromFile) {
      const off = readOffline(args.fromFile);
      ({ executions, workflows: apiWorkflows } = off);
      if (off.skipped.badTimestamp)
        err("warning: " + off.skipped.badTimestamp + " rows skipped: bad timestamp");
      if (off.skipped.noWorkflowId)
        err("warning: " + off.skipped.noWorkflowId + " rows skipped: no workflowId");
      if (off.skipped.noId)
        err("warning: " + off.skipped.noId + " rows had no id; counted individually");
      out(
        "Offline mode: " +
          executions.length +
          " executions from " +
          path.basename(args.fromFile),
      );
    } else {
      const o = {
        baseUrl: env.N8N_BASE_URL,
        apiKey: env.N8N_API_KEY,
        fetchImpl: d.fetchImpl,
        retryDelayMs: d.retryDelayMs,
        allowHttp: args.allowHttp,
      };
      if (!o.baseUrl || !o.apiKey)
        throw new ConfigError(
          "Set N8N_BASE_URL and N8N_API_KEY, or use --from-file executions.json",
        );
      const wl = await listWorkflows(o);
      apiWorkflows = wl.items;
      if (wl.truncated) truncated = true;
      const { workflows: wf } = resolveWorkflows(cfg, apiWorkflows);
      const earliest = Math.min(weekPrev.startMs, mw.prev.startMs);
      executions = [];
      for (const w of wf) {
        const r = await listExecutions({
          ...o,
          workflowId: w.id,
          stopBeforeMs: earliest - DAY,
        });
        executions.push(...r.items);
        if (r.truncated) truncated = true;
      }
      out(
        "Fetched " +
          executions.length +
          " executions for " +
          wf.length +
          " workflows",
      );
    }
    if (truncated)
      err(
        "warning: the page limit was reached while fetching, so results may be incomplete. This is flagged in the report.",
      );
    const { workflows, warnings } = resolveWorkflows(cfg, apiWorkflows);
    for (const w of warnings) err("warning: " + w);
    if (!workflows.length)
      throw new ConfigError("No workflows matched the config");

    const base = {
      executions,
      workflows,
      hourlyRate: cfg.hourlyRate,
      recoveryMinutes: cfg.recoveryWindowMinutes,
      truncated,
    };
    const weekly = computeReport({
      ...base,
      win: weekWin,
      prev: weekPrev,
      label: "weekly",
    });
    const monthly = computeReport({
      ...base,
      win: mw.win,
      prev: mw.prev,
      label: "monthly",
    });

    for (const w of weekly.perWorkflow)
      if (w.runs === 0)
        err(
          "warning: workflow \"" + w.label + "\" (" + w.id + ") had 0 runs in " + weekly.period.start + " to " + weekly.period.end + ". Check the id or tag.",
        );

    let narr = null;
    let narrM = null;
    if (args.narrative) {
      const nopts = {
        env,
        currency: cfg.currency,
        fetchImpl: d.fetchImpl,
        warn: (m) => err(m),
      };
      narr = await narrative(weekly, nopts);
      narrM = await narrative(monthly, nopts);
    }

    const email = weeklyEmail(weekly, {
      client: cfg.client,
      contactName: cfg.contactName,
      agency: cfg.agency,
      nextStep: cfg.nextStep,
      notes: cfg.notes,
      currency: cfg.currency,
      narrative: narr && narr.text,
    });
    const html = monthlyHtml(monthly, {
      client: cfg.client,
      agency: cfg.agency,
      notes: cfg.notes,
      nextStep: cfg.nextStep,
      narrative: narrM && narrM.text,
      currency: cfg.currency,
    });
    const report = {
      client: cfg.client,
      note: "Hours saved are runs x per-run minute estimates supplied in the config. They are estimates, not measurements.",
      truncated,
      weekly,
      monthly,
      narrative:
        narr || narrM
          ? {
              weekly: narr && { text: narr.text, provider: narr.provider },
              monthly: narrM && { text: narrM.text, provider: narrM.provider },
            }
          : null,
    };
    fs.mkdirSync(args.out, { recursive: true });
    const write = (n, c) => fs.writeFileSync(path.join(args.out, n), c);
    write("weekly-email.md", email.md);
    write("weekly-email.html", email.html);
    write("monthly-report.html", html);
    write("report.json", JSON.stringify(report, null, 2) + "\n");
    out(
      "Wrote weekly-email.md, weekly-email.html, monthly-report.html, report.json to " +
        args.out,
    );
    return 0;
  } catch (e) {
    err("Error: " + redact(e.message, secrets));
    return e instanceof ConfigError ? 2 : 1;
  }
}

module.exports = { main, parseArgs, monthWindow };
