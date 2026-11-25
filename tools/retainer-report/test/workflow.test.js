"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "examples", "n8n-workflow.json"),
    "utf8",
  ),
);
const node = (type) => wf.nodes.find((n) => n.type === type);

test("workflow is wired schedule -> HTTP -> Code -> Gmail draft, inactive, no send", () => {
  assert.equal(wf.active, false);
  assert.deepEqual(
    wf.nodes.map((n) => n.type),
    [
      "n8n-nodes-base.scheduleTrigger",
      "n8n-nodes-base.httpRequest",
      "n8n-nodes-base.code",
      "n8n-nodes-base.gmail",
    ],
  );
  assert.equal(node("n8n-nodes-base.gmail").parameters.operation, "create");
  assert.equal(node("n8n-nodes-base.gmail").parameters.resource, "draft");
  for (const n of wf.nodes)
    assert.ok(wf.connections[n.name] || n.type.endsWith("gmail"), n.name);
  assert.ok(
    !JSON.stringify(wf).match(/x-n8n-api-key["']?\s*:\s*["'][^"'{=]/i),
    "no hardcoded key",
  );
  assert.match(
    node("n8n-nodes-base.httpRequest")
      .parameters.queryParameters.parameters.map((p) => p.name + "=" + p.value)
      .join("&"),
    /includeData=false/,
  );
});

test("the Code node runs and produces the same email as the library", () => {
  const code = node("n8n-nodes-base.code").parameters.jsCode;
  const now = new Date();
  const d = (daysAgo, h) =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysAgo,
        h,
      ),
    ).toISOString();
  const page = {
    data: [
      {
        id: "1",
        workflowId: "101",
        status: "success",
        startedAt: d(1, 9),
        stoppedAt: d(1, 9),
        data: { pii: "x" },
      },
      {
        id: "2",
        workflowId: "101",
        status: "success",
        startedAt: d(2, 9),
        stoppedAt: d(2, 9),
      },
      {
        id: "3",
        workflowId: "101",
        status: "error",
        startedAt: d(3, 9),
        stoppedAt: d(3, 9),
      },
      {
        id: "4",
        workflowId: "101",
        status: "success",
        startedAt: d(3, 10),
        stoppedAt: d(3, 10),
      },
      {
        id: "5",
        workflowId: "555",
        status: "success",
        startedAt: d(1, 9),
        stoppedAt: d(1, 9),
      },
    ],
  };
  const fn = new Function("$input", code);
  const out = fn({ all: () => [{ json: page }] });
  const j = out[0].json;
  assert.equal(j.report.runs, 4);
  assert.equal(j.report.errors, 1);
  assert.equal(j.report.recovered, 1);
  assert.equal(j.report.hoursSaved, 0.3); // 3 successes x 6 min = 18 min
  assert.match(j.subject, /4 runs/);
  assert.ok(j.html.includes("<html"));
  assert.ok(!JSON.stringify(j).includes("pii"));
});
