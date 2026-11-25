"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main } = require("../src/cli");
const api = require("../src/api");
const { validateConfig } = require("../src/config");
const { computeReport, DAY } = require("../src/core");
const { T0, ex } = require("./helpers");

const KEY = "round2-test-key-123456";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nrr-r2-"));
const cfgFile = (workflows = [{ id: "1" }]) => {
  const f = path.join(tmp(), "c.json");
  fs.writeFileSync(f, JSON.stringify({ client: "Acme", workflows }));
  return f;
};
const win = { startMs: T0, endMs: T0 + 7 * DAY };
const prev = { startMs: T0 - 7 * DAY, endMs: T0 };

test("the same execution id three times counts once", () => {
  const e = ex("dup", "1", "success", 1);
  const r = computeReport({
    executions: [e, { ...e }, { ...e }],
    workflows: [{ id: "1", label: "x", minutes: 6 }],
    win,
    prev,
    label: "weekly",
  });
  assert.equal(r.runs, 1);
  assert.equal(r.success, 1);
  // same id on a different workflow is a different execution
  const r2 = computeReport({
    executions: [ex("7", "1", "success", 1), ex("7", "2", "success", 1)],
    workflows: [
      { id: "1", label: "a", minutes: 1 },
      { id: "2", label: "b", minutes: 1 },
    ],
    win,
    prev,
    label: "weekly",
  });
  assert.equal(r2.runs, 2);
});

test("http:// on a non-local host is refused unless --allow-http", async () => {
  assert.throws(() => api.cleanBase("http://n8n.example.com"), /cleartext/);
  assert.equal(
    api.cleanBase("http://n8n.example.com", true),
    "http://n8n.example.com",
  );
  for (const ok of [
    "http://localhost:5678",
    "http://127.0.0.1:5678",
    "http://[::1]:5678",
    "https://n8n.example.com",
  ])
    assert.doesNotThrow(() => api.cleanBase(ok), ok);
  const errs = [];
  let called = false;
  const env = { N8N_BASE_URL: "http://n8n.example.com", N8N_API_KEY: KEY };
  const deps = {
    stdout() {},
    stderr: (s) => errs.push(s),
    fetchImpl: async () => (
      (called = true),
      { ok: false, status: 500, text: async () => "" }
    ),
  };
  const code = await main(["--config", cfgFile(), "--out", tmp()], env, deps);
  assert.equal(code, 2);
  assert.equal(called, false, "no request may be made");
  assert.match(errs.join(" | "), /cleartext/);
  assert.ok(!errs.join(" | ").includes(KEY));
  // with the flag it proceeds to the request
  await main(["--config", cfgFile(), "--out", tmp(), "--allow-http"], env, {
    ...deps,
    retryDelayMs: 1,
  });
  assert.equal(called, true);
});

test("config ranges: hourlyRate 0-10000 finite, minutes 0-600", () => {
  const base = { client: "A", workflows: [{ id: "1" }] };
  for (const bad of [-1, 10001, Infinity, NaN])
    assert.throws(
      () => validateConfig({ ...base, hourlyRate: bad }),
      /hourlyRate/,
      String(bad),
    );
  assert.equal(
    validateConfig({ ...base, hourlyRate: 10000 }).hourlyRate,
    10000,
  );
  assert.equal(validateConfig({ ...base, hourlyRate: 0 }).hourlyRate, 0);
  for (const bad of [-1, 601, Infinity])
    assert.throws(
      () =>
        validateConfig({
          ...base,
          workflows: [{ id: "1", minutesSavedPerSuccessfulRun: bad }],
        }),
      /0 to 600/,
      String(bad),
    );
  assert.equal(
    validateConfig({
      ...base,
      workflows: [{ id: "1", minutesSavedPerSuccessfulRun: 600 }],
    }).workflows[0].minutes,
    600,
  );
});

test("truncated is not set when the last item is already older than the window", async () => {
  const mk = (startedAt) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ id: "1", workflowId: "1", status: "success", startedAt }],
      nextCursor: "more",
    }),
  });
  const o = {
    baseUrl: "https://n8n.example.com",
    apiKey: KEY,
    maxPages: 1,
    stopBeforeMs: Date.parse("2026-09-01"),
  };
  assert.equal(
    (await api.listExecutions({ ...o, fetchImpl: mk("2026-10-20T00:00:00Z") }))
      .truncated,
    true,
  );
  assert.equal(
    (await api.listExecutions({ ...o, fetchImpl: mk("2026-01-01T00:00:00Z") }))
      .truncated,
    false,
  );
});

test("a 200 response that is not JSON is a fatal error with no retries", async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>Sign in</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const errs = [];
    const code = await main(
      ["--config", cfgFile(), "--out", tmp()],
      {
        N8N_BASE_URL: "http://127.0.0.1:" + server.address().port,
        N8N_API_KEY: KEY,
      },
      { stdout() {}, stderr: (s) => errs.push(s), retryDelayMs: 1 },
    );
    assert.equal(code, 2);
    assert.equal(n, 1, "must not retry");
    assert.match(
      errs.join(" | "),
      /returned HTML, not the n8n API\. Check the URL \(it should be the instance root, e\.g\. https:\/\/n8n\.example\.com\)/,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("offline line prints the file name only; zero-run workflows warn", async () => {
  const EX = path.join(__dirname, "..", "examples");
  const cfg = path.join(tmp(), "c.json");
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      client: "A",
      workflows: [{ id: "101" }, { id: "424242" }],
    }),
  );
  const lines = [];
  const code = await main(
    [
      "--config",
      cfg,
      "--from-file",
      path.join(EX, "sample-executions.json"),
      "--out",
      tmp(),
      "--end",
      "2026-10-24",
    ],
    {},
    { stdout: (s) => lines.push(s), stderr: (s) => lines.push(s) },
  );
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(
    text,
    /Offline mode: \d+ executions from sample-executions\.json$/m,
  );
  assert.ok(!text.includes(EX));
  assert.match(text, /workflow "424242" \(424242\) had 0 runs/);
  assert.ok(!/"101" .* had 0 runs/.test(text));
});

test("README sample lines match the real weekly email output", () => {
  const readme = fs.readFileSync(
    path.join(__dirname, "..", "README.md"),
    "utf8",
  );
  const md = fs.readFileSync(
    path.join(__dirname, "..", "examples", "sample", "weekly-email.md"),
    "utf8",
  );
  for (const line of readme
    .split(/\r?\n/)
    .filter((l) => /^- (114 runs|Estimated time saved|6 runs failed)/.test(l)))
    assert.ok(md.includes(line), line);
});
