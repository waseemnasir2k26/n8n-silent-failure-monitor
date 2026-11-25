"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildGraph, hostFromUrl } = require("../src/graph");
const { extractWorkflows, loadDir } = require("../src/inputs");
const { blast, spof } = require("../src/query");
const { node, wf, call, trigger, http, cred, items } = require("../testkit/helpers");

const byType = (g, t) => g.nodes.filter((n) => n.type === t);

test("extractWorkflows accepts object, array, API page and wrapper shapes", () => {
  const w = wf("1", "A", []);
  assert.strictEqual(extractWorkflows(w).length, 1);
  assert.strictEqual(extractWorkflows([w, w]).length, 2);
  assert.strictEqual(
    extractWorkflows({ data: [w, w, w], nextCursor: null }).length,
    3,
  );
  assert.strictEqual(extractWorkflows({ workflows: [w] }).length, 1);
  assert.strictEqual(
    extractWorkflows({ id: "c1", name: "cred", type: "x", data: "enc" }).length,
    0,
  );
  assert.strictEqual(extractWorkflows("nope").length, 0);
});

test("loadDir reads recursively, skips bad JSON and non-workflow files", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neg-"));
  fs.mkdirSync(path.join(d, "sub"));
  fs.writeFileSync(path.join(d, "a.json"), JSON.stringify(wf("1", "A", [])));
  fs.writeFileSync(
    path.join(d, "sub", "b.json"),
    JSON.stringify([wf("2", "B", []), wf("3", "C", [])]),
  );
  fs.writeFileSync(path.join(d, "bad.json"), "{not json");
  fs.writeFileSync(
    path.join(d, "creds.json"),
    JSON.stringify([{ id: "1", name: "x", data: "enc" }]),
  );
  fs.writeFileSync(path.join(d, "notes.txt"), "ignore");
  const r = loadDir(d);
  assert.strictEqual(r.workflows.length, 3);
  assert.strictEqual(r.skipped, 2);
  assert.throws(() => loadDir(path.join(d, "missing")), /Not a directory/);
});

test("credential identity is instance + id, so two clients' same-named credential never merges", () => {
  const mk = (id) =>
    wf("w", "W", [
      node(
        "n8n-nodes-base.gmail",
        "g",
        {},
        cred("gmailOAuth2", id, "Gmail account"),
      ),
    ]);
  const g = buildGraph([
    ...items("acme", mk("c1")),
    ...items("bali", mk("c1")),
  ]);
  assert.strictEqual(byType(g, "credential").length, 2);
  const g2 = buildGraph(
    items("acme", mk("c1"), wf("w2", "W2", mk("c1").nodes)),
  );
  assert.strictEqual(byType(g2, "credential").length, 1);
  const res = blast(g, "credential", "Gmail account");
  assert.strictEqual(res.matches.length, 2);
  assert.strictEqual(res.summary.total, 2);
});

test("credential without id falls back to name", () => {
  const w = wf("w", "W", [
    node("n8n-nodes-base.slack", "s", {}, { slackApi: { name: "Slack main" } }),
  ]);
  const g = buildGraph(items("a", w));
  assert.strictEqual(byType(g, "credential")[0].id, "cred:a:name:Slack main");
});

test("hostFromUrl: hostname only, expressions, userinfo, junk", () => {
  assert.strictEqual(
    hostFromUrl("https://API.Example.com/v1/x?token=abc#f"),
    "api.example.com",
  );
  assert.strictEqual(
    hostFromUrl("https://user:pass@db.example.com:8443/x"),
    "db.example.com",
  );
  assert.strictEqual(
    hostFromUrl("=https://api.example.com/{{ $json.id }}"),
    "api.example.com",
  );
  assert.strictEqual(hostFromUrl("={{ $json.url }}"), "dynamic-expression");
  assert.strictEqual(
    hostFromUrl("={{ $env.BASE }}/render"),
    "dynamic-expression",
  );
  assert.strictEqual(
    hostFromUrl("https://{{ $json.sub }}.example.com/x"),
    "dynamic-expression",
  );
  assert.strictEqual(
    hostFromUrl("https://api{{ $json.n }}.example.com/x"),
    "dynamic-expression",
  );
  assert.strictEqual(hostFromUrl("example.org/path"), "example.org");
  assert.strictEqual(hostFromUrl("not a url at all %%"), "dynamic-expression");
  assert.strictEqual(hostFromUrl(""), "dynamic-expression");
  assert.strictEqual(hostFromUrl(undefined), "dynamic-expression");
  assert.strictEqual(
    hostFromUrl("https://sk-FAKEKEY0123456789abcdefghij.example.com/"),
    "dynamic-expression",
  );
});

test("service nodes map to their API host and expressions count as dynamic", () => {
  const w = wf("w", "W", [
    node("n8n-nodes-base.slack", "s", {}),
    node("n8n-nodes-base.stripe", "p", {}),
    node("@n8n/n8n-nodes-langchain.lmChatOpenAi", "m", {}),
    http("={{ $json.u }}"),
  ]);
  const g = buildGraph(items("a", w));
  assert.deepStrictEqual(
    byType(g, "host").map((h) => h.label),
    ["api.openai.com", "api.stripe.com", "dynamic-expression", "slack.com"],
  );
  assert.strictEqual(g.meta.dynamicRefs.hosts, 1);
});

test("sticky notes and disabled nodes are ignored", () => {
  const w = wf("w", "W", [
    node("n8n-nodes-base.stickyNote", "note", {
      content: "uses $env.SECRET_STICKY and https://evil.example.com",
    }),
    { ...http("https://disabled.example.com/x"), disabled: true },
    http("https://live.example.com/x"),
  ]);
  const g = buildGraph(items("a", w));
  assert.deepStrictEqual(
    byType(g, "host").map((h) => h.label),
    ["live.example.com"],
  );
  assert.strictEqual(byType(g, "envvar").length, 0);
});

test("webhooks: path, method, authentication; auth none is the default", () => {
  const w = wf("w", "W", [
    node("n8n-nodes-base.webhook", "a", {
      path: "/hook/a",
      httpMethod: "POST",
    }),
    node("n8n-nodes-base.webhook", "b", {
      path: "hook/b",
      authentication: "basicAuth",
    }),
    node("n8n-nodes-base.webhook", "c", { path: "={{ $json.p }}" }),
  ]);
  const g = buildGraph(items("a", w));
  const hooks = byType(g, "webhook");
  assert.strictEqual(hooks.length, 3);
  assert.strictEqual(
    hooks.find((h) => h.attrs.path === "hook/a").attrs.authentication,
    "none",
  );
  assert.strictEqual(
    hooks.find((h) => h.attrs.path === "hook/b").attrs.authentication,
    "basicAuth",
  );
  assert.ok(hooks.some((h) => h.attrs.path === "dynamic-expression"));
});

test("sheets: id from url, resource locator, airtable, dynamic skipped", () => {
  const rl = (v, n) => ({
    __rl: true,
    value: v,
    mode: "id",
    cachedResultName: n,
  });
  const w = wf("w", "W", [
    node("n8n-nodes-base.googleSheets", "a", {
      documentId: rl("1AbCdEfGhIjKlMnOpQrStUv", "Leads"),
      sheetName: rl("Tab1", "Tab1"),
    }),
    node("n8n-nodes-base.googleSheets", "b", {
      documentId:
        "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUv/edit#gid=0",
      sheetName: "Tab2",
    }),
    node("n8n-nodes-base.googleSheets", "c", {
      documentId: "={{ $json.doc }}",
    }),
    node("n8n-nodes-base.airtable", "d", {
      base: rl("appABC123", "CRM"),
      table: rl("tblXYZ789", "People"),
    }),
  ]);
  const g = buildGraph(items("a", w));
  const sheets = byType(g, "sheet");
  assert.strictEqual(sheets.length, 2);
  const gs = sheets.find((s) => s.attrs.kind === "sheet");
  assert.deepStrictEqual(gs.attrs.sheetNames, ["Tab1", "Tab2"]);
  assert.strictEqual(gs.label, "Leads");
  assert.strictEqual(g.meta.dynamicRefs.sheets, 1);
  assert.strictEqual(
    blast(g, "sheet", "1AbCdEfGhIjKlMnOpQrStUv").summary.total,
    1,
  );
  assert.strictEqual(blast(g, "sheet", "leads").summary.total, 1);
});

test("env refs and schedules", () => {
  const w = wf("w", "W", [
    node("n8n-nodes-base.scheduleTrigger", "s", {
      rule: {
        interval: [{ field: "days", daysInterval: 1, triggerAtHour: 9 }],
      },
    }),
    node("n8n-nodes-base.code", "c", {
      jsCode: "return [{ k: $env.MY_VAR, j: $env['OTHER_VAR'] }];",
    }),
  ]);
  const g = buildGraph(items("a", w));
  assert.deepStrictEqual(
    byType(g, "envvar").map((e) => e.label),
    ["MY_VAR", "OTHER_VAR"],
  );
  assert.strictEqual(byType(g, "schedule")[0].label, "daily at 09:00");
  assert.strictEqual(blast(g, "env", "MY_VAR").summary.total, 1);
});

test("blast follows a 3-level sub-workflow chain upward", () => {
  const A = wf("A", "A", [call("B", "B")]);
  const B = wf("B", "B", [trigger(), call("C", "C")]);
  const C = wf("C", "C", [
    trigger(),
    node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
  ]);
  const g = buildGraph(items("x", A, B, C));
  const r = blast(g, "credential", "Slack");
  assert.deepStrictEqual(
    r.affected.map((a) => [a.name, a.distance]),
    [
      ["C", 0],
      ["B", 1],
      ["A", 2],
    ],
  );
  assert.strictEqual(r.affected[2].why, "A -> B -> C -> uses Slack [x]");
  assert.strictEqual(blast(g, "workflow", "C").summary.total, 3);
  assert.strictEqual(blast(g, "workflow", "A").summary.total, 1);
});

test("blast is cycle safe", () => {
  const A = wf("A", "A", [
    call("B", "B"),
    node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
  ]);
  const B = wf("B", "B", [call("A", "A")]);
  const g = buildGraph(items("x", A, B));
  assert.strictEqual(blast(g, "credential", "Slack").summary.total, 2);
  assert.strictEqual(blast(g, "workflow", "A").summary.total, 2);
});

test("calls to workflows missing from the input become stubs, not crashes", () => {
  const g = buildGraph(items("x", wf("A", "A", [call("GONE", "Gone")])));
  assert.strictEqual(g.meta.counts.workflows, 1);
  assert.ok(g.links.some((l) => l.rel === "calls_workflow"));
  assert.strictEqual(blast(g, "workflow", "Gone").summary.total, 1); // only A; stub excluded from counts
});

test("sub-workflow resolves by cached name when ids do not match", () => {
  const g = buildGraph(
    items("x", wf("A", "A", [call("OLDID", "B")]), wf("B", "B", [trigger()])),
  );
  assert.ok(
    g.links.some((l) => l.rel === "calls_workflow" && l.target === "wf:x:B"),
  );
});

test("error_handler links, notes in blast, and handler flag", () => {
  const H = wf("H", "Handler", [
    node("n8n-nodes-base.errorTrigger", "e", {}),
    node("n8n-nodes-base.slack", "s", {}, cred("slackApi", "s1", "Slack")),
  ]);
  const P = wf("P", "Protected", [http("https://a.example.com")], {
    errorWorkflow: "H",
  });
  const g = buildGraph(items("x", H, P));
  assert.ok(
    g.links.some(
      (l) =>
        l.rel === "error_handler" &&
        l.source === "wf:x:P" &&
        l.target === "wf:x:H",
    ),
  );
  assert.strictEqual(
    g.nodes.find((n) => n.id === "wf:x:H").attrs.isErrorHandler,
    true,
  );
  const r = blast(g, "credential", "Slack");
  assert.strictEqual(r.errorHandlerNotes.length, 1);
  assert.deepStrictEqual(r.errorHandlerNotes[0].protects, ["[x] Protected"]);
  assert.deepStrictEqual(spof(g, 3).noErrorWorkflow, []);
});

test("spof thresholds count active workflows only", () => {
  const c = cred("slackApi", "s1", "Slack");
  const mk = (i, active) =>
    wf(`w${i}`, `W${i}`, [node("n8n-nodes-base.slack", "s", {}, c)], {
      active,
    });
  const g = buildGraph(items("x", mk(1, true), mk(2, true), mk(3, false)));
  assert.strictEqual(spof(g, 3).credentials.length, 0);
  assert.strictEqual(spof(g, 2).credentials.length, 1);
  assert.strictEqual(spof(g, 2).credentials[0].activeWorkflows, 2);
  assert.strictEqual(spof(g, 2).credentials[0].totalWorkflows, 3);
  const g4 = buildGraph(items("x", mk(1, true), mk(2, true), mk(3, true)));
  assert.strictEqual(spof(g4, 3).credentials.length, 1);
  assert.strictEqual(spof(g4, 3).hosts.length, 1);
});

test("spof: open webhooks, no error workflow, sub-workflow callers, dynamic host excluded", () => {
  const sub = wf("S", "Sub", [trigger()]);
  const callers = [1, 2, 3].map((i) =>
    wf(`c${i}`, `Caller${i}`, [call("S", "Sub"), http("={{ $json.u }}")]),
  );
  const hook = wf("h", "Hook", [
    node("n8n-nodes-base.webhook", "w", { path: "p", httpMethod: "POST" }),
  ]);
  const s = spof(buildGraph(items("x", sub, ...callers, hook)), 3);
  assert.strictEqual(s.subworkflows.length, 1);
  assert.strictEqual(s.subworkflows[0].callers, 3);
  assert.strictEqual(s.hosts.length, 0);
  assert.strictEqual(s.openWebhooks.length, 1);
  assert.ok(s.noErrorWorkflow.some((w) => w.label === "Hook"));
  assert.ok(!s.noErrorWorkflow.some((w) => w.label === "Sub"));
  assert.strictEqual(s.orphanCredentials.available, false);
});

test("graph is deterministic and has no timestamps unless a date is given", () => {
  const w = wf("w", "W", [http("https://a.example.com")]);
  const a = JSON.stringify(buildGraph(items("x", w)));
  assert.strictEqual(a, JSON.stringify(buildGraph(items("x", w))));
  assert.ok(!/"date"/.test(a));
  assert.ok(
    /"date":"2026-01-02"/.test(
      JSON.stringify(buildGraph(items("x", w), { date: "2026-01-02" })),
    ),
  );
});

test("our own graph.json in an input folder is not mistaken for a workflow", () => {
  const g = buildGraph(items("a", wf("w", "W", [http("https://a.example.com")])));
  assert.strictEqual(extractWorkflows(g).length, 0);
});
