"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { main } = require("../src/cli");
const { buildGraph } = require("../src/graph");
const { html, markdown } = require("../src/render");
const { node, wf, call, trigger, items, cred } = require("../testkit/helpers");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "n8n-estate-graph.js");

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function tmpWith(...wfs) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-cli-"));
  wfs.forEach((w, i) =>
    fs.writeFileSync(path.join(d, `w${i}.json`), JSON.stringify(w)),
  );
  return d;
}

test("exit codes: help 0, no args 2, bad command 2, bad option 2, missing input 2", () => {
  assert.strictEqual(run(["--help"]).code, 0);
  assert.strictEqual(run(["--version"]).code, 0);
  assert.strictEqual(run([]).code, 2);
  assert.strictEqual(run(["nope"]).code, 2);
  assert.strictEqual(run(["build", "--wat"]).code, 2);
  assert.strictEqual(run(["build"]).code, 2);
  assert.strictEqual(run(["build", "--from-dir"]).code, 2);
  assert.strictEqual(run(["build", "--from-dir", "does-not-exist"]).code, 1);
  assert.strictEqual(run(["spof", "--from-dir", ROOT, "--min", "0"]).code, 2);
  assert.strictEqual(
    run(["build", "--from-dir", ROOT, "--date", "yesterday"]).code,
    2,
  );
  assert.strictEqual(run(["blast", "--from-dir", ROOT]).code, 2);
  assert.strictEqual(
    run(["blast", "--from-dir", ROOT, "--host", "a", "--env", "B"]).code,
    2,
  );
  assert.strictEqual(run(["spof", "--graph", "missing.json"]).code, 2);
  assert.strictEqual(run(["build", "--instance", "noequals"]).code, 2);
  assert.strictEqual(
    run(["build", "--instance", "x=https://n8n.example.com"], {
      N8N_API_KEY: "",
      N8N_API_KEY_X: "",
    }).code,
    2,
  );
});

test("exit code 3 when the input has zero workflows", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-empty-"));
  fs.writeFileSync(path.join(d, "x.json"), JSON.stringify({ hello: "world" }));
  const r = run(["build", "--from-dir", d, "--out", path.join(d, "o")]);
  assert.strictEqual(r.code, 3);
  assert.match(r.err, /No workflows/);
  assert.strictEqual(run(["spof", "--from-dir", d]).code, 3);
});

test("build then blast/spof from graph.json, --json is valid JSON, no-match is exit 0", () => {
  const A = wf("A", "A", [call("B", "B")]);
  const B = wf("B", "B", [
    trigger(),
    node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack main")),
  ]);
  const d = tmpWith(A, B);
  const out = path.join(d, "out");
  const b = run(["build", "--from-dir", d, "--label", "acme", "--out", out]);
  assert.strictEqual(b.code, 0, b.err);
  for (const f of ["graph.json", "report.html", "report.md"])
    assert.ok(fs.existsSync(path.join(out, f)));
  const g = path.join(out, "graph.json");
  const bl = run([
    "blast",
    "--graph",
    g,
    "--credential",
    "slack main",
    "--json",
  ]);
  assert.strictEqual(bl.code, 0);
  assert.strictEqual(JSON.parse(bl.out).summary.total, 2);
  assert.match(
    run(["blast", "--graph", g, "--credential", "Slack main"]).out,
    /\[acme\] A/,
  );
  assert.match(
    run(["blast", "--graph", g, "--credential", "nothing"]).out,
    /No credential matches/,
  );
  assert.strictEqual(
    JSON.parse(run(["spof", "--graph", g, "--json", "--min", "1"]).out)
      .credentials.length,
    1,
  );
  assert.strictEqual(
    run(["blast", "--graph", g, "--from-dir", d, "--host", "x"]).code,
    2,
  );
});

test("build is deterministic: same inputs, byte-identical outputs", () => {
  const d = tmpWith(
    wf("A", "A", [
      node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
    ]),
  );
  const read = (o) =>
    ["graph.json", "report.html", "report.md"]
      .map((f) => fs.readFileSync(path.join(o, f), "utf8"))
      .join("\n#\n");
  run(["build", "--from-dir", d, "--out", path.join(d, "o1")]);
  run(["build", "--from-dir", d, "--out", path.join(d, "o2")]);
  assert.strictEqual(read(path.join(d, "o1")), read(path.join(d, "o2")));
  assert.ok(!/\b20\d\d-\d\d-\d\d/.test(read(path.join(d, "o1"))));
});

test("committed sample output is reproduced exactly by the demo inputs", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "neg-demo-"));
  const r = run([
    "build",
    "--from-dir",
    "examples/workflows/acme-dental",
    "--label",
    "acme-dental",
    "--from-dir",
    "examples/workflows/bali-villas",
    "--label",
    "bali-villas",
    "--out",
    out,
    "--date",
    "2026-11-02",
  ]);
  assert.strictEqual(r.code, 0, r.err);
  for (const f of ["graph.json", "report.html", "report.md"]) {
    assert.strictEqual(
      fs.readFileSync(path.join(out, f), "utf8"),
      fs.readFileSync(path.join(ROOT, "examples", "sample-out", f), "utf8"),
      f,
    );
  }
});

test("report.html is self-contained: no external scripts, styles, fonts, images; tables render without JS", () => {
  const g = buildGraph(
    items(
      "a",
      wf("w", "W", [
        node("n8n-nodes-base.webhook", "h", { path: "p" }),
        node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
      ]),
    ),
  );
  const h = html(g);
  const urls = h.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  for (const u of urls)
    assert.match(
      u,
      /^https:\/\/(skynetjoe\.com|github\.com\/waseemnasir2k26)/,
      u,
    );
  assert.ok(!/<script[^>]+src=/i.test(h));
  assert.ok(!/<link\b/i.test(h));
  assert.ok(!/@import|url\(/i.test(h));
  assert.ok(!/<img\b/i.test(h));
  assert.ok((h.match(/<table>/g) || []).length >= 5);
  assert.match(h, /Slack/);
  assert.ok(markdown(g).includes("## Summary"));
});

test("HTML escapes hostile names", () => {
  const g = buildGraph(
    items(
      "a",
      wf("w", "<img src=x onerror=alert(1)>", [
        node(
          "n8n-nodes-base.slack",
          "s",
          {},
          cred("slackApi", "s1", "<script>alert(1)</script>"),
        ),
      ]),
    ),
  );
  const h = html(g);
  assert.ok(!h.includes("<img src=x"));
  assert.ok(!h.includes("<script>alert"));
});

// ---- API mode against a local mock server (no network) ----

function mockServer(pages, seen) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        key: req.headers["x-n8n-api-key"],
      });
      const u = new URL(req.url, "http://x");
      if (req.headers["x-n8n-api-key"] !== "FAKEKEY-for-tests-123456") {
        res.writeHead(401).end("{}");
        return;
      }
      const cursor = u.searchParams.get("cursor") || "0";
      const body = {
        data: pages[Number(cursor)] || [],
        nextCursor: pages[Number(cursor) + 1]
          ? String(Number(cursor) + 1)
          : null,
      };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("API mode: paginates, sends GET only, never puts the key in the URL, labels instances", async () => {
  const seen = [];
  const pages = [
    [
      wf("1", "One", [
        node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
      ]),
    ],
    [
      wf("2", "Two", [
        node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
      ]),
    ],
    [wf("3", "Three", [])],
  ];
  const srv = await mockServer(pages, seen);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    let out = "";
    const io = {
      stdout: (s) => (out += s),
      stderr: (s) => (out += s),
      env: { N8N_API_KEY: "FAKEKEY-for-tests-123456" },
    };
    const code = await main(
      [
        "blast",
        "--instance",
        `client1=${base}`,
        "--credential",
        "Slack",
        "--json",
      ],
      io,
    );
    assert.strictEqual(code, 0, out);
    assert.strictEqual(JSON.parse(out).summary.total, 2);
    assert.strictEqual(seen.length, 3);
    for (const s of seen) {
      assert.strictEqual(s.method, "GET");
      assert.ok(s.url.startsWith("/api/v1/workflows"));
      assert.ok(!s.url.includes("FAKEKEY"));
    }
    // per-instance env var wins and is required when there is more than one instance
    const io2 = {
      stdout: () => {},
      stderr: (s) => (out += s),
      env: { N8N_API_KEY: "FAKEKEY-for-tests-123456" },
    };
    assert.strictEqual(
      await main(
        ["spof", "--instance", `a=${base}`, "--instance", `b=${base}`],
        io2,
      ),
      2,
    );
  } finally {
    srv.close();
  }
});

test("API mode: a rejected key gives exit 1 and the key never appears in output", async () => {
  const seen = [];
  const srv = await mockServer([[]], seen);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    let out = "";
    const key = "FAKEWRONGKEY-abcdef-0123456789";
    const io = {
      stdout: (s) => (out += s),
      stderr: (s) => (out += s),
      env: { N8N_API_KEY_C1: key },
    };
    assert.strictEqual(
      await main(
        ["build", "--instance", `c1=${base}`, "--out", os.tmpdir()],
        io,
      ),
      1,
    );
    assert.ok(!out.includes(key));
    assert.match(out, /refused the key/);
  } finally {
    srv.close();
  }
});

test("API mode: https required for non-local hosts and key is scrubbed from errors", async () => {
  let out = "";
  const key = "FAKEKEY-for-tests-123456";
  const io = {
    stdout: (s) => (out += s),
    stderr: (s) => (out += s),
    env: { N8N_API_KEY: key },
  };
  assert.strictEqual(
    await main(["build", "--instance", "x=http://n8n.example.com"], io),
    2,
  );
  assert.ok(!out.includes(key));
});
