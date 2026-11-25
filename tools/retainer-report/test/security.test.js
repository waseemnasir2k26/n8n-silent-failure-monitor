"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main } = require("../src/cli");
const { narrative } = require("../src/llm");
const api = require("../src/api");
const { computeReport, weeklyEmail, DAY } = require("../src/core");
const { monthlyHtml } = require("../src/render");
const { T0, ex } = require("./helpers");

const KEY = "redirect-test-key-123456";
const EX = path.join(__dirname, "..", "examples");
const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
const close = (s) => new Promise((r) => s.close(r));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nrr-sec-"));
function cfgFile() {
  const f = path.join(tmp(), "c.json");
  fs.writeFileSync(
    f,
    JSON.stringify({ client: "Acme", workflows: [{ id: "1" }] }),
  );
  return f;
}
const rep = (label = "x", win = 7) =>
  computeReport({
    executions: [ex("a", "1", "success", 1)],
    workflows: [{ id: "1", label, minutes: 5 }],
    win: { startMs: T0, endMs: T0 + win * DAY },
    prev: { startMs: T0 - win * DAY, endMs: T0 },
    label: "weekly",
  });

test("a 302 to another server never receives X-N8N-API-KEY and the CLI fails", async () => {
  const seen = [];
  const target = await listen((req, res) => {
    seen.push(req.headers);
    res.end("{}");
  });
  const origin = await listen((req, res) => {
    res.writeHead(302, {
      location:
        "http://127.0.0.1:" + target.address().port + "/api/v1/workflows",
    });
    res.end();
  });
  try {
    const errs = [];
    const code = await main(
      ["--config", cfgFile(), "--out", tmp()],
      {
        N8N_BASE_URL: "http://127.0.0.1:" + origin.address().port,
        N8N_API_KEY: KEY,
      },
      { stdout() {}, stderr: (s) => errs.push(s), retryDelayMs: 1 },
    );
    assert.notEqual(code, 0);
    assert.equal(
      seen.length,
      0,
      "redirect target must receive no request at all",
    );
    assert.ok(!seen.some((h) => h["x-n8n-api-key"]));
    assert.match(errs.join("\n"), /redirected \(302\)/);
    assert.ok(!errs.join("\n").includes(KEY));
  } finally {
    await close(origin);
    await close(target);
  }
});

test("network error names the host and cause, never the key", async () => {
  const dead = await listen(() => {});
  const port = dead.address().port;
  await close(dead); // nothing listens here any more
  const errs = [];
  const code = await main(
    ["--config", cfgFile(), "--out", tmp()],
    { N8N_BASE_URL: "http://127.0.0.1:" + port, N8N_API_KEY: KEY },
    { stdout() {}, stderr: (s) => errs.push(s), retryDelayMs: 1 },
  );
  assert.equal(code, 1);
  const text = errs.join(" | ");
  assert.ok(text.includes("Cannot reach http://127.0.0.1:" + port + " (ECONNREFUSED). Check N8N_BASE_URL"), text);
  assert.ok(!text.includes(KEY));
});

test("invalid --end and --month exit 2", async () => {
  for (const bad of [
    ["--end", "2026-02-31"],
    ["--end", "nope"],
    ["--month", "2026-13"],
  ]) {
    const errs = [];
    const code = await main(
      [
        "--config",
        path.join(EX, "sample.config.json"),
        "--from-file",
        path.join(EX, "sample-executions.json"),
        "--out",
        tmp(),
        ...bad,
      ],
      {},
      { stdout() {}, stderr: (s) => errs.push(s) },
    );
    assert.equal(code, 2, bad.join(" ") + " -> " + errs.join());
  }
});

test("GEMINI_MODEL is validated: a bad value falls back to the default model", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok." }] } }],
      }),
    };
  };
  const env = (m) => ({ GEMINI_API_KEY: "gem_testkey123", GEMINI_MODEL: m });
  await narrative(rep(), { env: env("../../v1/evil?x=1#"), fetchImpl });
  await narrative(rep(), { env: env("gemini-1.5-flash"), fetchImpl });
  assert.match(urls[0], /\/v1beta\/models\/gemini-2\.0-flash:generateContent$/);
  assert.match(urls[1], /\/models\/gemini-1\.5-flash:generateContent$/);
  assert.ok(!urls.some((u) => u.includes("evil")));
});

test("pagination cap sets truncated on the library result", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: String(calls),
            workflowId: "1",
            status: "success",
            startedAt: "2026-10-20T10:00:00Z",
          },
        ],
        nextCursor: "more",
      }),
    };
  };
  const r = await api.listExecutions({
    baseUrl: "https://n8n.example.com",
    apiKey: KEY,
    fetchImpl,
    maxPages: 3,
  });
  assert.equal(calls, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.items.length, 3);
  // exactly filling the cap with no further cursor is not truncation
  let n = 0;
  const exact = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [], nextCursor: ++n < 3 ? "x" : null }),
  });
  const e = await api.listExecutions({
    baseUrl: "https://n8n.example.com",
    apiKey: KEY,
    fetchImpl: exact,
    maxPages: 3,
  });
  assert.equal(e.truncated, false);
});

test("CLI: hitting the page cap warns, and report.json plus the outputs say truncated", async () => {
  const out = tmp();
  const errs = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/workflows"))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "1", name: "Leads", tags: [] }],
          nextCursor: null,
        }),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "9",
            workflowId: "1",
            status: "success",
            startedAt: "2026-10-20T10:00:00Z",
          },
        ],
        nextCursor: "more",
      }),
    };
  };
  const code = await main(
    ["--config", cfgFile(), "--out", out, "--end", "2026-10-24"],
    { N8N_BASE_URL: "https://n8n.example.com", N8N_API_KEY: KEY },
    { stdout() {}, stderr: (s) => errs.push(s), fetchImpl },
  );
  assert.equal(code, 0);
  assert.match(errs.join("\n"), /page limit/);
  const r = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  assert.equal(r.truncated, true);
  assert.equal(r.weekly.truncated, true);
  for (const f of [
    "weekly-email.md",
    "weekly-email.html",
    "monthly-report.html",
  ])
    assert.match(
      fs.readFileSync(path.join(out, f), "utf8"),
      /may be incomplete/,
      f,
    );
});

test("n8n workflow Code node warns when the last page still has a cursor", () => {
  const wf = JSON.parse(
    fs.readFileSync(path.join(EX, "n8n-workflow.json"), "utf8"),
  );
  const code = wf.nodes.find((n) => n.type === "n8n-nodes-base.code").parameters
    .jsCode;
  const d = new Date();
  const started = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 9),
  ).toISOString();
  const page = (cursor) => ({
    json: {
      data: [
        { id: "1", workflowId: "101", status: "success", startedAt: started },
      ],
      nextCursor: cursor,
    },
  });
  const run = (items) =>
    new Function("$input", code)({ all: () => items })[0].json;
  const capped = run([page("a"), page("b")]);
  assert.equal(capped.report.truncated, true);
  assert.match(capped.md, /may be incomplete/);
  const done = run([page("a"), page(null)]);
  assert.equal(done.report.truncated, false);
  assert.ok(!/may be incomplete/.test(done.md));
});

test("greeting uses contactName, falls back to 'there', never the business; newlines are flattened in .md", () => {
  const r = rep("Line\nBreak");
  const plain = weeklyEmail(r, { client: "Harbor Dental" }).md;
  assert.match(plain, /\nHi there,\n/);
  assert.ok(!plain.includes("Harbor"));
  assert.match(weeklyEmail(r, { contactName: "Sarah" }).md, /\nHi Sarah,\n/);
  const md = weeklyEmail(r, {
    contactName: "Sa\nrah",
    agency: "A\n# Injected",
    notes: ["x\n- y"],
  }).md;
  assert.match(md, /\nHi Sa rah,\n/);
  assert.ok(!/^# Injected/m.test(md));
  assert.ok(!/^- y/m.test(md));
  assert.ok(!md.includes("Line\nBreak"));
});

test("monthly report shows notes, next step and narrative when given", () => {
  const html = monthlyHtml(rep("x", 28), {
    client: "A",
    notes: ["Added a retry"],
    nextStep: "Approve the follow-ups",
    narrative: "Steady month.",
  });
  for (const t of [
    "Added a retry",
    "Approve the follow-ups",
    "Steady month.",
    "AI model",
  ])
    assert.ok(html.includes(t), t);
});

test("--demo runs on the bundled sample with no other input", async () => {
  const cwd = process.cwd();
  const dir = tmp();
  process.chdir(dir);
  try {
    const code = await main(["--demo"], {}, { stdout() {}, stderr() {} });
    assert.equal(code, 0);
    assert.ok(
      fs.existsSync(
        path.join(dir, "retainer-report-demo", "monthly-report.html"),
      ),
    );
  } finally {
    process.chdir(cwd);
  }
});
