"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main } = require("../src/cli");
const { node, wf } = require("../testkit/helpers");

const SECRETS = [
  "jane@clientco.com",
  "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
  "Jane Doe invoices",
  "clientco-secret-hook",
  "crm.clientco.com",
  "Jane Doe Billing",
];

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-redact-"));
  const w = wf("wf-clientco-77", "Jane Doe Billing", [
    node(
      "n8n-nodes-base.webhook",
      "hook",
      { path: "clientco-secret-hook", httpMethod: "POST" },
    ),
    node(
      "n8n-nodes-base.googleSheets",
      "sheet",
      {
        documentId: {
          __rl: true,
          value: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
          mode: "id",
          cachedResultName: "Client ledger",
        },
        sheetName: { __rl: true, value: "gid=5", mode: "list", cachedResultName: "Jane Doe invoices" },
      },
      { googleSheetsOAuth2Api: { id: "cred-991", name: "jane@clientco.com Google" } },
    ),
    node("n8n-nodes-base.httpRequest", "crm", { url: "https://crm.clientco.com/api/x" }),
  ]);
  fs.writeFileSync(path.join(d, "w.json"), JSON.stringify(w));
  return d;
}

async function run(args) {
  let out = "";
  let err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: {},
  });
  return { code, out, err };
}

test("sanity: without --redact-all the fixture does carry the identifiers", async () => {
  const d = fixture();
  const o = path.join(d, "out");
  await run(["build", "--from-dir", d, "--label", "c", "--out", o, "--date", "2026-11-02"]);
  const all = fs.readFileSync(path.join(o, "graph.json"), "utf8");
  assert.ok(all.includes("jane@clientco.com"));
  assert.ok(all.includes("clientco-secret-hook"));
});

test("build --redact-all: no identifier appears in any output file", async () => {
  const d = fixture();
  const o = path.join(d, "out");
  const r = await run(["build", "--from-dir", d, "--label", "c", "--out", o, "--redact-all"]);
  assert.strictEqual(r.code, 0);
  for (const f of ["graph.json", "report.md", "report.html"]) {
    const txt = fs.readFileSync(path.join(o, f), "utf8");
    for (const s of SECRETS) assert.ok(!txt.includes(s), `${f} leaks ${s}`);
    assert.ok(!txt.includes("wf-clientco-77") && !txt.includes("cred-991"), `${f} leaks ids`);
  }
  assert.match(fs.readFileSync(path.join(o, "graph.json"), "utf8"), /cred#[0-9a-f]{8}/);
});

test("--redact-all is stable: same input, same hashes", async () => {
  const d = fixture();
  await run(["build", "--from-dir", d, "--label", "c", "--out", path.join(d, "a"), "--redact-all"]);
  await run(["build", "--from-dir", d, "--label", "c", "--out", path.join(d, "b"), "--redact-all"]);
  assert.strictEqual(
    fs.readFileSync(path.join(d, "a", "graph.json"), "utf8"),
    fs.readFileSync(path.join(d, "b", "graph.json"), "utf8"),
  );
});

test("blast and spof --redact-all print no identifier, blast still finds the credential", async () => {
  const d = fixture();
  const b = await run(["blast", "--from-dir", d, "--label", "c", "--credential", "jane@clientco.com Google", "--redact-all"]);
  assert.strictEqual(b.code, 0);
  assert.match(b.out, /1 workflow affected/);
  const bj = await run(["blast", "--from-dir", d, "--label", "c", "--credential", "jane@clientco.com Google", "--redact-all", "--json"]);
  const s = await run(["spof", "--from-dir", d, "--label", "c", "--min", "1", "--redact-all"]);
  for (const txt of [b.out, bj.out, s.out]) for (const x of SECRETS) assert.ok(!txt.includes(x), `leaks ${x}`);
});

test("default spof, report.md and report.html never print the raw custom webhook path", async () => {
  const d = fixture();
  const s = await run(["spof", "--from-dir", d, "--label", "c"]);
  assert.ok(!s.out.includes("clientco-secret-hook"));
  assert.match(s.out, /POST \/clie\*\*\*#[0-9a-f]{8}/);
  const o = path.join(d, "out");
  await run(["build", "--from-dir", d, "--label", "c", "--out", o]);
  for (const f of ["report.md", "report.html"])
    assert.ok(!fs.readFileSync(path.join(o, f), "utf8").includes("clientco-secret-hook"), f);
  const shown = await run(["spof", "--from-dir", d, "--label", "c", "--show-paths"]);
  assert.ok(shown.out.includes("clientco-secret-hook"));
});

test("--date rejects impossible dates", async () => {
  const d = fixture();
  for (const bad of ["2026-13-99", "2026-02-30", "26-1-1"]) {
    const r = await run(["build", "--from-dir", d, "--out", path.join(d, "o"), "--date", bad]);
    assert.strictEqual(r.code, 2, bad);
  }
});

test("blast with no match exits 4", async () => {
  const d = fixture();
  const r = await run(["blast", "--from-dir", d, "--label", "c", "--credential", "nope"]);
  assert.strictEqual(r.code, 4);
});

test("report.html tables are static markup (work with JavaScript off)", async () => {
  const d = fixture();
  const o = path.join(d, "out");
  await run(["build", "--from-dir", d, "--label", "c", "--out", o]);
  const h = fs.readFileSync(path.join(o, "report.html"), "utf8");
  assert.ok((h.match(/<table>/g) || []).length >= 4);
  assert.ok(!/<tr[^>]*\shidden/.test(h), "rows are not hidden in the static HTML");
  assert.ok(h.includes("<td>Jane Doe Billing</td>") || h.includes("Jane Doe Billing"));
});
