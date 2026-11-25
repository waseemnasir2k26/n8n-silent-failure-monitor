"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { run } = require("../src/cli");
const { loadConfig } = require("../src/config");

const FIX = path.join(__dirname, "..", "fixtures");
const NOW = "2026-11-20T12:00:00Z";

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false },
  };
}

test("CLI: table output, exit 1 when something is stalled or failing", async () => {
  const c = capture();
  const code = await run(
    ["--config", path.join(FIX, "demo-config.json"), "--now", NOW],
    {},
    c.io,
  );
  assert.equal(code, 1);
  assert.match(
    c.out.join("\n"),
    /STALLED\s+Demo Client\s+Daily invoice export/,
  );
  assert.match(c.out.join("\n"), /4 stalled, 2 failing, 5 ok/);
});

test("CLI: --json is valid JSON with a summary", async () => {
  const c = capture();
  const code = await run(
    ["--from-file", path.join(FIX, "instance.json"), "--now", NOW, "--json"],
    {},
    c.io,
  );
  assert.equal(code, 1);
  const j = JSON.parse(c.out.join("\n"));
  assert.equal(j.summary.total, 13);
  assert.equal(j.summary.disabled, 1);
  assert.ok(j.results.every((r) => r.client === "export"));
});

test("CLI: exit 0 when everything is healthy", async () => {
  const f = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nsfm-")),
    "ok.json",
  );
  const all = JSON.parse(
    fs.readFileSync(path.join(FIX, "instance.json"), "utf8"),
  );
  fs.writeFileSync(
    f,
    JSON.stringify({
      workflows: all.workflows.filter((w) => w.id === "101"),
      executions: all.executions.filter((e) => e.workflowId === "101"),
    }),
  );
  const c = capture();
  assert.equal(await run(["--from-file", f, "--now", NOW], {}, c.io), 0);
});

test("CLI: missing env vars give exit 2 and name the variable, never a value", async () => {
  const f = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nsfm-")),
    "c.json",
  );
  fs.writeFileSync(
    f,
    JSON.stringify({
      clients: [
        { name: "A", urlEnv: "NSFM_TEST_URL", keyEnv: "NSFM_TEST_KEY" },
      ],
    }),
  );
  const c = capture();
  assert.equal(await run(["--config", f], {}, c.io), 2);
  assert.match(c.err.join("\n"), /NSFM_TEST_URL is not set/);
});

test("config: secrets in the file are refused", () => {
  const f = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nsfm-")),
    "c.json",
  );
  fs.writeFileSync(
    f,
    JSON.stringify({
      clients: [{ name: "A", url: "https://example.invalid", apiKey: "x" }],
    }),
  );
  assert.throws(() => loadConfig(f), /not allowed/);
  fs.writeFileSync(
    f,
    JSON.stringify({
      clients: [{ name: "A", urlEnv: "https://example.invalid", keyEnv: "K" }],
    }),
  );
  assert.throws(() => loadConfig(f), /environment variable NAME/);
});

test("CLI: bad flags exit 2", async () => {
  const c = capture();
  assert.equal(await run(["--nope"], {}, c.io), 2);
  assert.equal(
    await run(
      ["--factor", "0.5", "--from-file", path.join(FIX, "instance.json")],
      {},
      capture().io,
    ),
    2,
  );
});

test("API mode against a local mock server: sends X-N8N-API-KEY, pages with cursor, flags a stall", async () => {
  const seen = [];
  const wfs = [
    {
      id: "1",
      name: "Hourly",
      active: true,
      updatedAt: "2026-01-01T00:00:00Z",
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "hours", hoursInterval: 1 }] },
          },
        },
      ],
    },
    {
      id: "2",
      name: "Healthy",
      active: true,
      updatedAt: "2026-01-01T00:00:00Z",
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "hours", hoursInterval: 1 }] },
          },
        },
      ],
    },
  ];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({
      path: u.pathname,
      key: req.headers["x-n8n-api-key"],
      q: Object.fromEntries(u.searchParams),
    });
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/api/v1/workflows") {
      if (!u.searchParams.get("cursor"))
        return res.end(JSON.stringify({ data: [wfs[0]], nextCursor: "c2" }));
      return res.end(JSON.stringify({ data: [wfs[1]], nextCursor: null }));
    }
    if (u.pathname === "/api/v1/executions") {
      const id = u.searchParams.get("workflowId");
      const t =
        id === "2"
          ? new Date(Date.parse(NOW) - 10 * 6e4).toISOString()
          : "2026-11-10T00:00:00Z";
      return res.end(
        JSON.stringify({
          data: [
            {
              id: "9",
              workflowId: id,
              status: "success",
              startedAt: t,
              stoppedAt: t,
            },
          ],
          nextCursor: null,
        }),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = capture();
    const env = {
      T_URL: `http://127.0.0.1:${server.address().port}`,
      T_KEY: "test-key-not-real",
    };
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nsfm-")),
      "c.json",
    );
    fs.writeFileSync(
      f,
      JSON.stringify({
        clients: [{ name: "Mock", urlEnv: "T_URL", keyEnv: "T_KEY" }],
      }),
    );
    const code = await run(["--config", f, "--now", NOW, "--json"], env, c.io);
    assert.equal(code, 1);
    const j = JSON.parse(c.out.join("\n"));
    assert.deepEqual(
      j.results.map((r) => [r.id, r.status]),
      [
        ["1", "STALLED"],
        ["2", "OK"],
      ],
    );
    assert.ok(seen.every((s) => s.key === "test-key-not-real"));
    assert.ok(
      seen.some((s) => s.path === "/api/v1/workflows" && s.q.cursor === "c2"),
      "second workflows page requested with cursor",
    );
    assert.ok(
      seen
        .filter((s) => s.path === "/api/v1/executions")
        .every((s) => s.q.includeData === "false" && s.q.workflowId),
    );
    assert.ok(
      !JSON.stringify(j).includes("test-key-not-real"),
      "key never in output",
    );
  } finally {
    server.close();
  }
});

test("API error is reported with exit 2 and does not leak the key", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = capture();
    const env = {
      T_URL: `http://127.0.0.1:${server.address().port}`,
      T_KEY: "test-key-not-real",
    };
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nsfm-")),
      "c.json",
    );
    fs.writeFileSync(
      f,
      JSON.stringify({
        clients: [{ name: "Mock", urlEnv: "T_URL", keyEnv: "T_KEY" }],
      }),
    );
    assert.equal(await run(["--config", f], env, c.io), 2);
    const text = c.err.join("\n");
    assert.match(text, /401/);
    assert.ok(!text.includes("test-key-not-real"));
  } finally {
    server.close();
  }
});
