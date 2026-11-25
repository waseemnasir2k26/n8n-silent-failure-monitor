"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main, monthWindow } = require("../src/cli");
const { narrative } = require("../src/llm");
const { computeReport, DAY } = require("../src/core");
const { T0, ex, pagedFetch } = require("./helpers");

const root = path.join(__dirname, "..");
const sampleArgs = (out) => [
  "--config",
  path.join(root, "examples/sample.config.json"),
  "--from-file",
  path.join(root, "examples/sample-executions.json"),
  "--out",
  out,
  "--end",
  "2026-10-24",
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nrr-"));

test("offline mode writes all four outputs from the sample", async () => {
  const out = tmp();
  const lines = [];
  const code = await main(
    sampleArgs(out),
    {},
    { stdout: (s) => lines.push(s), stderr: (s) => lines.push(s) },
  );
  assert.equal(code, 0, lines.join("\n"));
  for (const f of [
    "weekly-email.md",
    "weekly-email.html",
    "monthly-report.html",
    "report.json",
  ]) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
  const rep = JSON.parse(
    fs.readFileSync(path.join(out, "report.json"), "utf8"),
  );
  assert.equal(rep.weekly.period.start, "2026-10-18");
  assert.equal(rep.monthly.period.start, "2026-09-01");
  assert.equal(rep.monthly.period.end, "2026-09-30");
  assert.equal(rep.narrative, null);
  // workflow 999 is not in the config and must not be counted
  assert.ok(!rep.weekly.perWorkflow.some((w) => w.id === "999"));
  assert.match(rep.note, /estimates/);
});

test("offline mode does not need or use API credentials", async () => {
  let called = false;
  const code = await main(
    sampleArgs(tmp()),
    {},
    {
      stdout() {},
      stderr() {},
      fetchImpl: async () => {
        called = true;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(called, false);
});

test("live mode without credentials fails with a clear message", async () => {
  const errs = [];
  const code = await main(
    ["--config", path.join(root, "examples/sample.config.json")],
    {},
    { stdout() {}, stderr: (s) => errs.push(s) },
  );
  assert.equal(code, 2);
  assert.match(errs.join(), /N8N_BASE_URL and N8N_API_KEY/);
});

test("live mode end to end with a fake API, key never printed or written", async () => {
  const key = "live-key-9876543210"; // gitleaks:allow (test fake)
  const out = tmp();
  const log = [];
  const calls = [];
  const day = (n) =>
    new Date(Date.UTC(2026, 9, 20) + n * 3600000).toISOString();
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows"))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "101", name: "Leads", tags: [] }],
          nextCursor: null,
        }),
      };
    const body = {
      data: [
        {
          id: "1",
          workflowId: "101",
          status: "success",
          startedAt: day(1),
          stoppedAt: day(1),
          data: { email: "leak@example.com" },
        },
      ],
      nextCursor: null,
    };
    return { ok: true, status: 200, json: async () => body };
  };
  const cfg = path.join(tmp(), "c.json");
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      client: "Acme",
      workflows: [{ id: "101", minutesSavedPerSuccessfulRun: 6 }],
    }),
  );
  const code = await main(
    ["--config", cfg, "--out", out, "--end", "2026-10-24"],
    { N8N_BASE_URL: "https://n8n.example.com", N8N_API_KEY: key },
    { stdout: (s) => log.push(s), stderr: (s) => log.push(s), fetchImpl },
  );
  assert.equal(code, 0, log.join("\n"));
  assert.ok(
    calls.some(
      (c) =>
        c.includes("/api/v1/executions") &&
        c.includes("workflowId=101") &&
        c.includes("includeData=false"),
    ),
  );
  const all =
    log.join("\n") +
    fs
      .readdirSync(out)
      .map((f) => fs.readFileSync(path.join(out, f), "utf8"))
      .join("\n");
  assert.ok(!all.includes(key));
  assert.ok(!all.includes("leak@example.com"));
});

test("errors never print the API key", async () => {
  const key = "live-key-9876543210"; // gitleaks:allow (test fake)
  const errs = [];
  const cfg = path.join(tmp(), "c.json");
  fs.writeFileSync(
    cfg,
    JSON.stringify({ client: "Acme", workflows: [{ id: "1" }] }),
  );
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => "forbidden for " + key,
  });
  const code = await main(
    ["--config", cfg],
    { N8N_BASE_URL: "https://n8n.example.com", N8N_API_KEY: key },
    { stdout() {}, stderr: (s) => errs.push(s), fetchImpl, retryDelayMs: 1 },
  );
  assert.equal(code, 1);
  assert.ok(!errs.join().includes(key));
});

test("bad month and bad date are rejected", async () => {
  assert.throws(() => monthWindow("2026-13"), /--month/);
  const errs = [];
  const code = await main(
    [...sampleArgs(tmp()), "--end", "2026-02-31"],
    {},
    { stdout() {}, stderr: (s) => errs.push(s) },
  );
  assert.notEqual(code, 0);
  assert.match(errs.join(), /Invalid date/);
});

const rep = computeReport({
  executions: [ex("a", "1", "success", 1), ex("b", "1", "error", 2)],
  workflows: [{ id: "1", label: "SecretWorkflowName", minutes: 5 }],
  win: { startMs: T0, endMs: T0 + 7 * DAY },
  prev: { startMs: T0 - 7 * DAY, endMs: T0 },
  hourlyRate: 40,
  label: "weekly",
});

test("narrative skips cleanly without a key", async () => {
  const warns = [];
  const r = await narrative(rep, {
    env: {},
    warn: (m) => warns.push(m),
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(r, null);
  assert.match(warns[0], /skipping/);
});

test("narrative sends aggregates only and uses the key as a header, not in the body", async () => {
  let body, headers;
  const fetchImpl = async (url, init) => {
    body = init.body;
    headers = init.headers;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Three sentences here." } }],
      }),
    };
  };
  const r = await narrative(rep, {
    env: { GROQ_API_KEY: "gsk_testkey123" },
    fetchImpl,
  });
  assert.deepEqual(r, { text: "Three sentences here.", provider: "groq" });
  assert.ok(!body.includes("SecretWorkflowName"));
  assert.ok(!body.includes("gsk_testkey123"));
  assert.equal(headers.authorization, "Bearer gsk_testkey123");
  assert.ok(body.includes(String.raw`\"runs\":2`));
});

test("narrative falls back to Gemini when Groq fails, and never throws", async () => {
  const warns = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("groq")) return { ok: false, status: 500 };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "From gemini." }] } }],
      }),
    };
  };
  const r = await narrative(rep, {
    env: { GROQ_API_KEY: "gsk_testkey123", GEMINI_API_KEY: "gem_testkey123" },
    fetchImpl,
    warn: (m) => warns.push(m),
  });
  assert.equal(r.provider, "gemini");
  const dead = await narrative(rep, {
    env: { GROQ_API_KEY: "gsk_testkey123" },
    fetchImpl: async () => {
      throw new Error("boom gsk_testkey123");
    },
    warn: (m) => warns.push(m),
  });
  assert.equal(dead, null);
  assert.ok(!warns.join().includes("gsk_testkey123"));
});

test("--narrative on the CLI adds a labelled summary", async () => {
  const out = tmp();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "Runs were steady." } }],
    }),
  });
  const code = await main(
    [...sampleArgs(out), "--narrative"],
    { GROQ_API_KEY: "gsk_testkey123" },
    { stdout() {}, stderr() {}, fetchImpl },
  );
  assert.equal(code, 0);
  assert.match(
    fs.readFileSync(path.join(out, "weekly-email.md"), "utf8"),
    /drafted by an AI model/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")).narrative
      .weekly.provider,
    "groq",
  );
});

void pagedFetch;
