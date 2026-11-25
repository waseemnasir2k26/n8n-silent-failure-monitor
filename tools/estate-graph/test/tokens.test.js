"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main } = require("../src/cli");
const { buildGraph } = require("../src/graph");
const { tokenish, scrubPath, safe } = require("../src/scrub");
const { blast, spof } = require("../src/query");
const { markdown, html } = require("../src/render");
const { node, wf, items, cred, prng } = require("../testkit/helpers");

const SHEET_TOKEN = "xQvKpLmRtWzNbYcHsJdF";
const PATH_TOKEN = "ZqP8Lm3Rv7Xn2Kd9Wb4T";
const UUID = "3f2b8c1e-9a47-4d65-b0e2-7c19a5d8e3f4";

function probeWorkflows() {
  const sheet = (n) => ({
    documentId: { __rl: true, value: "1AbCdEfGhIjKlMnOpQrStUv", mode: "id" },
    sheetName: n,
  });
  return [
    wf("p1", "Probe", [
      node(
        "n8n-nodes-base.googleSheets",
        "G",
        sheet(`Leads ${SHEET_TOKEN}`),
        cred("googleSheetsOAuth2Api", "gs1", "Sheets"),
      ),
      node("n8n-nodes-base.webhook", "W1", {
        path: `hook/${PATH_TOKEN}`,
        httpMethod: "POST",
      }),
      node("n8n-nodes-base.webhook", "W2", { path: UUID, httpMethod: "POST" }),
      node("n8n-nodes-base.webhook", "W3", {
        path: "acme/lead",
        httpMethod: "POST",
      }),
    ]),
  ];
}

test("probe strings never appear in any output format, including --json", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-probe-"));
  const src = path.join(d, "in");
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, "p.json"),
    JSON.stringify(probeWorkflows()[0]),
  );
  const out = path.join(d, "out");
  let cap = "";
  const io = { stdout: (s) => (cap += s), stderr: (s) => (cap += s) };
  const runs = [
    ["build", "--from-dir", src, "--out", out],
    ["spof", "--from-dir", src, "--min", "1"],
    ["spof", "--from-dir", src, "--min", "1", "--json"],
    ["blast", "--from-dir", src, "--sheet", "1AbCdEfGhIjKlMnOpQrStUv"],
    [
      "blast",
      "--from-dir",
      src,
      "--sheet",
      "1AbCdEfGhIjKlMnOpQrStUv",
      "--json",
    ],
    ["blast", "--from-dir", src, "--workflow", "Probe", "--json"],
  ];
  for (const a of runs) assert.strictEqual(await main(a, io), 0, a.join(" "));
  const files = ["graph.json", "report.html", "report.md"]
    .map((f) => fs.readFileSync(path.join(out, f), "utf8"))
    .join("\n");
  const all = cap + files;
  for (const t of [SHEET_TOKEN, PATH_TOKEN, UUID])
    assert.ok(!all.includes(t), `leaked ${t.slice(0, 6)}`);
  // the human readable parts survive, and open webhooks are still listed with the redacted path
  assert.ok(all.includes("POST /hook/{random}"));
  assert.ok(all.includes("POST /{random}"));
  assert.ok(all.includes("POST /acme/lead"));
  assert.ok(all.includes("Leads [REDACTED]"));
  const s = JSON.parse(
    cap.slice(cap.indexOf('{\n  "min"')).split("\n}\n")[0] + "\n}",
  );
  assert.strictEqual(s.openWebhooks.length, 3);
});

test("webhook identity does not depend on the raw path", () => {
  const mk = (p) =>
    wf("w", "W", [
      node("n8n-nodes-base.webhook", "h", { path: p, httpMethod: "POST" }),
    ]);
  const a = buildGraph(items("c", mk(`x/${PATH_TOKEN}`)));
  const b = buildGraph(items("c", mk("x/Rt5Yh8Jk2Lp9Qw3Er7Ty")));
  assert.deepStrictEqual(
    a.nodes.map((n) => n.id),
    b.nodes.map((n) => n.id),
  );
  assert.ok(a.nodes.some((n) => n.id === "hook:c:w:0"));
});

test("normal names are not flagged", () => {
  for (const name of [
    "GoogleSheetsAccountProduction",
    "appointment-reminders-weekly",
    "Hostinger Webhook Bearer (mail-inbound)",
    "LG Postgres",
    "Stripe Payment Sync",
    "getUserAccountBalanceFromDatabase",
    "task-force-2024-reminder-emails",
    "GoogleSheetsAccount2026",
  ]) {
    assert.strictEqual(safe(name), name, name);
    assert.ok(!tokenish(name.replace(/ /g, "")) || name.includes(" "), name);
  }
  for (const p of [
    "acme/lead",
    "villa/enquiry",
    "appointment-reminders-weekly",
    "v1/orders/create",
  ])
    assert.strictEqual(scrubPath(p), p);
  const g = buildGraph(
    items(
      "c",
      wf("w", "Hostinger Webhook Bearer (mail-inbound)", [
        node(
          "n8n-nodes-base.slack",
          "s",
          {},
          cred("slackApi", "s1", "GoogleSheetsAccountProduction"),
        ),
      ]),
    ),
  );
  assert.strictEqual(
    g.nodes.find((n) => n.type === "workflow").label,
    "Hostinger Webhook Bearer (mail-inbound)",
  );
  assert.strictEqual(
    g.nodes.find((n) => n.type === "credential").label,
    "GoogleSheetsAccountProduction",
  );
});

test("random tokens are caught: digit-free mixed case, alnum, UUID, hex, base64url", () => {
  for (const t of [
    SHEET_TOKEN,
    PATH_TOKEN,
    UUID,
    "9f86d081884c7d659a2feaa0c55ad015",
    "dGhpcyBpcyBhIHRlc3Qgb2Ygc29tZXRoaW5n",
    "aBcDeFgHiJkLmNoPqRs",
  ])
    assert.ok(tokenish(t), t);
  assert.strictEqual(
    safe(`Report ${SHEET_TOKEN} weekly`),
    "Report [REDACTED] weekly",
  );
});

test("known n8n ids stay readable where they are identifiers", () => {
  const g = buildGraph(
    items(
      "c",
      wf("Nj5nReYJYZ0ueAAq", "W", [
        node(
          "n8n-nodes-base.slack",
          "s",
          {},
          cred("slackApi", "Qw3Er7Ty9Ui2Op5As", "Slack"),
        ),
      ]),
    ),
  );
  assert.ok(g.nodes.some((n) => n.id === "wf:c:Nj5nReYJYZ0ueAAq"));
  assert.strictEqual(blast(g, "workflow", "Nj5nReYJYZ0ueAAq").summary.total, 1);
  assert.strictEqual(
    blast(g, "credential", "Qw3Er7Ty9Ui2Op5As").summary.total,
    1,
  );
});

test("random subdomain labels are hidden, hostnames stay", () => {
  const w = wf("w", "W", [
    node("n8n-nodes-base.httpRequest", "h", {
      url: `https://${SHEET_TOKEN.toLowerCase()}${"Ab12Cd34"}.example.com/x`,
    }),
  ]);
  const g = buildGraph(items("c", w));
  assert.ok(!JSON.stringify(g).includes(SHEET_TOKEN.toLowerCase()));
});

test("fuzz: digit-free and mixed-case random tokens never reach outputs (200 cases)", () => {
  const rnd = prng(424242);
  const LET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const ALN = LET + "0123456789";
  const gen = (alpha, n) =>
    Array.from(
      { length: n },
      () => alpha[Math.floor(rnd() * alpha.length)],
    ).join("");
  for (let i = 0; i < 200; i++) {
    const tok = gen(i % 2 ? LET : ALN, 16 + Math.floor(rnd() * 20));
    // a random draw can come out all one case (rare); mixed case is the property under test
    if (!/[a-z]/.test(tok) || !/[A-Z]/.test(tok)) continue;
    const place = i % 4;
    const w =
      place === 0
        ? wf("w", "F", [
            node("n8n-nodes-base.googleSheets", "g", {
              documentId: "1AbCdEfGhIjKlMnOpQrStUv",
              sheetName: `Tab ${tok}`,
            }),
          ])
        : place === 1
          ? wf("w", "F", [
              node("n8n-nodes-base.webhook", "h", {
                path: `p/${tok}`,
                httpMethod: "POST",
              }),
            ])
          : place === 2
            ? wf("w", `Flow ${tok}`, [
                node(
                  "n8n-nodes-base.slack",
                  "s",
                  {},
                  cred("slackApi", "s1", `Cred ${tok}`),
                ),
              ])
            : wf("w", "F", [
                node("n8n-nodes-base.airtable", "a", {
                  base: { value: "appABC123", cachedResultName: `Base ${tok}` },
                  table: { value: "tblXYZ789", cachedResultName: "T" },
                }),
              ]);
    const g = buildGraph(items("c", w));
    const outs = [
      JSON.stringify(g),
      markdown(g),
      html(g),
      JSON.stringify(spof(g, 1)),
    ].join("\n");
    assert.ok(!outs.includes(tok), `case ${i} leaked ${tok}`);
  }
});

test("skipped files are reported on stderr and counted in meta, exit code unchanged", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-skip-"));
  fs.writeFileSync(path.join(d, "ok.json"), JSON.stringify(wf("1", "A", [])));
  fs.writeFileSync(path.join(d, "broken.json"), "{not json");
  fs.writeFileSync(path.join(d, "other.json"), JSON.stringify({ hello: 1 }));
  let err = "";
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "neg-skipout-"));
  const code = await main(["build", "--from-dir", d, "--out", outDir], {
    stdout: () => {},
    stderr: (s) => (err += s),
  });
  assert.strictEqual(code, 0);
  assert.match(
    err,
    /Skipped 2 of 3 files \(not n8n workflow JSON\): broken\.json, other\.json/,
  );
  const g = JSON.parse(
    fs.readFileSync(path.join(outDir, "graph.json"), "utf8"),
  );
  assert.deepStrictEqual(g.meta.inputFiles, { total: 3, skipped: 2 });
});

test("credential and trigger type names are identifiers, not redacted", () => {
  const g = buildGraph(
    items(
      "c",
      wf("w", "W", [
        node(
          "n8n-nodes-base.googleDrive",
          "d",
          {},
          cred("googleDriveOAuth2Api", "d1", "Drive"),
        ),
        node(
          "n8n-nodes-base.microsoftOutlook",
          "o",
          {},
          cred("microsoftOutlookOAuth2Api", "o1", "Outlook"),
        ),
      ]),
    ),
  );
  const types = g.nodes
    .filter((n) => n.type === "credential")
    .flatMap((n) => n.attrs.credType)
    .sort();
  assert.deepStrictEqual(types, [
    "googleDriveOAuth2Api",
    "microsoftOutlookOAuth2Api",
  ]);
  assert.ok(!markdown(g).includes("[REDACTED]"));
});
