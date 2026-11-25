"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildGraph } = require("../src/graph");
const { blast, blastText, spof, spofText } = require("../src/query");
const { markdown, html } = require("../src/render");
const { main } = require("../src/cli");
const { node, wf, items, prng, cred } = require("../testkit/helpers");

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function secretKinds(rnd) {
  const r = (n) =>
    Array.from(
      { length: n },
      () => ALNUM[Math.floor(rnd() * ALNUM.length)],
    ).join("");
  const dig = (n) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 10)).join("");
  const a = r(32);
  const b = r(24);
  const c = r(24);
  const d = r(30);
  const e = r(14);
  return [
    { secret: a, text: `sk-${a}`, pattern: true },
    { secret: b, text: `xoxb-${dig(10)}-${b}`, pattern: true },
    {
      secret: c,
      text: `https://h.example.com/p?api_key=${c}&x=1`,
      pattern: false,
    },
    { secret: d, text: `Bearer ${d}`, pattern: true },
    { secret: e, text: `https://admin:${e}@h.example.com/x`, pattern: false },
  ];
}

// Every place a secret can sit in an exported workflow.
const PLACEMENTS = [
  (s) =>
    node("n8n-nodes-base.httpRequest", "H", {
      url: s.text.startsWith("http")
        ? s.text
        : `https://api.example.com/x?z=${s.text}`,
    }),
  (s) =>
    node("n8n-nodes-base.httpRequest", "H", {
      url: "https://api.example.com/x",
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: "Authorization", value: s.text }],
      },
    }),
  (s) =>
    node("n8n-nodes-base.code", "C", {
      jsCode: `const k = "${s.text}"; return [{ k, v: $env.SOME_VAR }];`,
    }),
  (s) =>
    node("n8n-nodes-base.stickyNote", "S", {
      content: `token ${s.text} and $env.STICKY_ONLY`,
    }),
  (s) =>
    node("n8n-nodes-base.set", "Set", {
      values: { string: [{ name: "token", value: s.text }] },
    }),
  (s) =>
    node("n8n-nodes-base.httpRequest", "H", {
      url: "https://api.example.com/x",
      jsonBody: `{"api_key": "${s.secret}"}`,
    }),
  (s) =>
    node("n8n-nodes-base.googleSheets", "G", {
      documentId: { __rl: true, value: "1AbCdEfGhIjKlMnOpQrStUv", mode: "id" },
      sheetName: s.text,
    }),
];

function build(wfs) {
  return buildGraph(items("c1", ...wfs), {
    sources: [{ label: "c1", kind: "dir" }],
  });
}

function allOutputs(g) {
  const out = [
    JSON.stringify(g, null, 2),
    markdown(g),
    html(g),
    spofText(spof(g, 1)),
    JSON.stringify(spof(g, 1)),
  ];
  for (const n of g.nodes) {
    const kind = {
      credential: "credential",
      host: "host",
      sheet: "sheet",
      envvar: "env",
      workflow: "workflow",
    }[n.type];
    if (!kind) continue;
    const r = blast(g, kind, n.label);
    out.push(blastText(r), JSON.stringify(r));
  }
  return out.join("\n");
}

test("redaction fuzz: 250 random secret placements never reach any output", () => {
  const rnd = prng(20261102);
  let checked = 0;
  for (let i = 0; i < 250; i++) {
    const kinds = secretKinds(rnd);
    const s = kinds[Math.floor(rnd() * kinds.length)];
    const place = PLACEMENTS[Math.floor(rnd() * PLACEMENTS.length)];
    const nodes = [
      place(s),
      node(
        "n8n-nodes-base.slack",
        "Slack",
        {},
        cred("slackApi", "s1", "Slack"),
      ),
    ];
    const w = wf("w1", "Fuzz", nodes);
    const out = allOutputs(build([w]));
    assert.ok(
      !out.includes(s.secret),
      `case ${i}: secret leaked (placement ${PLACEMENTS.findIndex((p) => p === place)}, kind ${s.text.slice(0, 6)})`,
    );
    checked++;
  }
  assert.strictEqual(checked, 250);
});

test("redaction fuzz: pattern secrets in names, credential names and webhook paths are scrubbed", () => {
  const rnd = prng(7);
  for (let i = 0; i < 60; i++) {
    const s = secretKinds(rnd).filter((k) => k.pattern)[i % 3];
    const w = wf("w1", `Flow ${s.text}`, [
      node(
        "n8n-nodes-base.gmail",
        "G",
        {},
        cred("gmailOAuth2", "c1", `Gmail ${s.text}`),
      ),
      node("n8n-nodes-base.webhook", "W", {
        path: `hook-${s.text}`,
        httpMethod: "POST",
      }),
    ]);
    const out = allOutputs(build([w]));
    assert.ok(!out.includes(s.secret), `case ${i}: secret leaked from a label`);
  }
});

test("hard-coded tokens in node params and sticky notes (HM-01 style) never appear", () => {
  const tokens = [
    ["xox", "b-111111111111-FAKEHERMESTOKEN123456"].join(""),
    "sk-FAKELIVEKEYabcdefghijklmnop12",
    "Bearer FAKEAPPROVETOKEN0123456789abcdef",
    "ghp_FAKEGITHUBTOKEN0123456789abcdefghijkl",
  ];
  const w = wf("w1", "HM-01 Hermes Slack Agent", [
    node("n8n-nodes-base.httpRequest", "Slack", {
      url: "https://slack.com/api/chat.postMessage",
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: "Authorization", value: tokens[2] }],
      },
      jsonBody: `{"token":"${tokens[0]}"}`,
    }),
    node("n8n-nodes-base.code", "Code", {
      jsCode: `const k='${tokens[1]}'; const g='${tokens[3]}';`,
    }),
    node("n8n-nodes-base.stickyNote", "Note", { content: tokens.join(" ") }),
  ]);
  const w2 = {
    ...wf("w2", "pin", []),
    pinData: { x: [{ json: { t: tokens[0] } }] },
    staticData: { global: { t: tokens[1] } },
  };
  const out = allOutputs(build([w, w2]));
  for (const t of tokens)
    assert.ok(
      !out.includes(t.split("-").pop()) && !out.includes(t),
      `leaked ${t.slice(0, 6)}`,
    );
});

test("CLI end to end: stdout, graph.json, report.html and report.md carry no secret", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-red-"));
  const secret = "FAKEENDTOENDSECRET0123456789abcdef";
  const w = wf("w1", "E2E", [
    node("n8n-nodes-base.httpRequest", "H", {
      url: `https://svc.example.com/x?api_key=${secret}`,
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: "Authorization", value: `Bearer ${secret}` }],
      },
    }),
    node("n8n-nodes-base.stickyNote", "S", { content: `sk-${secret}` }),
  ]);
  fs.writeFileSync(path.join(d, "w.json"), JSON.stringify(w));
  const outDir = path.join(d, "out");
  let captured = "";
  const io = { stdout: (s) => (captured += s), stderr: (s) => (captured += s) };
  assert.strictEqual(
    await main(["build", "--from-dir", d, "--out", outDir], io),
    0,
  );
  assert.strictEqual(
    await main(["blast", "--from-dir", d, "--host", "svc.example.com"], io),
    0,
  );
  assert.strictEqual(
    await main(
      ["blast", "--from-dir", d, "--host", "svc.example.com", "--json"],
      io,
    ),
    0,
  );
  assert.strictEqual(
    await main(["spof", "--from-dir", d, "--min", "1"], io),
    0,
  );
  const files = ["graph.json", "report.html", "report.md"]
    .map((f) => fs.readFileSync(path.join(outDir, f), "utf8"))
    .join("\n");
  assert.ok(!(captured + files).includes(secret));
  assert.ok(files.includes("svc.example.com"));
});
