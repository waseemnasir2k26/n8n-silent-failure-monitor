"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { evaluateAll, evaluateWorkflow } = require("../src/evaluate");
const { describeTrigger } = require("../src/schedule");
const { maxGapMs } = require("../src/cron");
const { parseDuration, formatDuration } = require("../src/duration");
const { readExport } = require("../src/cli");

const NOW = Date.parse("2026-11-20T12:00:00Z");
const FIX = path.join(__dirname, "..", "fixtures", "instance.json");
const data = readExport(FIX);
const results = evaluateAll(data.workflows, data.executions, {
  now: NOW,
  webhookSilence: {
    defaultMs: null,
    byWorkflow: { "Order intake webhook": 24 * 36e5 },
  },
});
const by = (id) => results.find((r) => r.id === id);

test("fixture: healthy hourly workflow is OK", () =>
  assert.equal(by("101").status, "OK"));
test("fixture: daily workflow silent 80h is STALLED", () => {
  assert.equal(by("102").status, "STALLED");
  assert.match(by("102").detail, /no run for 3d/);
});
test("fixture: last 3 runs errored is FAILING", () => {
  assert.equal(by("103").status, "FAILING");
  assert.match(by("103").detail, /last 3 runs errored/);
});
test("fixture: webhook over the user-set max silence is STALLED", () =>
  assert.equal(by("104").status, "STALLED"));
test("fixture: webhook with no threshold is never flagged", () => {
  assert.equal(by("105").status, "OK");
  assert.match(by("105").detail, /not checked/);
});
test("fixture: disabled workflow is DISABLED and never flagged", () =>
  assert.equal(by("106").status, "DISABLED"));
test("fixture: weekday cron uses the longest gap (Fri to Mon), so 3h-old run is OK", () => {
  assert.equal(
    describeTrigger(by("107") && data.workflows.find((w) => w.id === "107"))
      .intervalMs,
    72 * 36e5,
  );
  assert.equal(by("107").status, "OK");
});
test("fixture: timezone edge, +08:00 timestamps compare as instants (47h OK, 51h STALLED)", () => {
  assert.equal(by("108").status, "OK");
  assert.equal(by("109").status, "STALLED");
});
test("fixture: never-ran workflow old enough is STALLED", () => {
  assert.equal(by("110").status, "STALLED");
  assert.match(by("110").detail, /never ran/);
});
test("fixture: never-ran workflow changed 20 minutes ago gets a grace period", () =>
  assert.equal(by("111").status, "OK"));
test("fixture: manual-only workflow is SKIP", () =>
  assert.equal(by("112").status, "SKIP"));
test("fixture: errors with no success inside the window is FAILING even with fewer than N errors", () => {
  assert.equal(by("113").status, "FAILING");
});

test("a single error among successes stays OK", () => {
  const w = data.workflows.find((x) => x.id === "101");
  const ex = [
    { status: "error", startedAt: "2026-11-20T11:30:00Z" },
    { status: "success", startedAt: "2026-11-20T10:30:00Z" },
    { status: "success", startedAt: "2026-11-20T09:30:00Z" },
  ];
  assert.equal(evaluateWorkflow(w, ex, { now: NOW }).status, "OK");
});

test("boundary: exactly 2x the interval is OK, one minute past is STALLED", () => {
  const w = data.workflows.find((x) => x.id === "101"); // hourly -> limit 2h
  const at = (min) => [
    { status: "success", startedAt: new Date(NOW - min * 6e4).toISOString() },
  ];
  assert.equal(evaluateWorkflow(w, at(120), { now: NOW }).status, "OK");
  assert.equal(evaluateWorkflow(w, at(121), { now: NOW }).status, "STALLED");
});

test("--factor widens the window", () => {
  const w = data.workflows.find((x) => x.id === "101");
  const ex = [
    { status: "success", startedAt: new Date(NOW - 3 * 36e5).toISOString() },
  ];
  assert.equal(evaluateWorkflow(w, ex, { now: NOW }).status, "STALLED");
  assert.equal(evaluateWorkflow(w, ex, { now: NOW, factor: 4 }).status, "OK");
});

test("same instant written with different offsets gives the same verdict", () => {
  const w = data.workflows.find((x) => x.id === "102");
  const a = [{ status: "success", startedAt: "2026-11-19T00:00:00Z" }];
  const b = [{ status: "success", startedAt: "2026-11-19T07:00:00+07:00" }];
  const c = [{ status: "success", startedAt: "2026-11-18T19:00:00-05:00" }];
  const s = [a, b, c].map(
    (e) => evaluateWorkflow(w, e, { now: NOW }).lastRunAt,
  );
  assert.equal(new Set(s).size, 1);
});

test("running and waiting executions are neither success nor failure", () => {
  const w = data.workflows.find((x) => x.id === "101");
  const ex = [
    { status: "running", startedAt: "2026-11-20T11:55:00Z" },
    { status: "success", startedAt: "2026-11-20T11:00:00Z" },
  ];
  assert.equal(evaluateWorkflow(w, ex, { now: NOW }).status, "OK");
});

test("executions without startedAt are ignored", () => {
  const w = data.workflows.find((x) => x.id === "101");
  assert.equal(
    evaluateWorkflow(w, [{ status: "new", startedAt: null }], {
      now: NOW,
      webhookMaxSilenceMs: null,
    }).status,
    "STALLED",
  );
});

test("archived workflow is not checked; activeVersionId counts as active", () => {
  const w = { ...data.workflows.find((x) => x.id === "101") };
  assert.equal(
    evaluateWorkflow({ ...w, isArchived: true }, [], { now: NOW }).status,
    "DISABLED",
  );
  const { active, ...rest } = w;
  assert.notEqual(
    evaluateWorkflow({ ...rest, activeVersionId: "v1" }, [], { now: NOW })
      .status,
    "DISABLED",
  );
});

test("schedule parsing: scheduleTrigger units, legacy cron node, interval node", () => {
  const mk = (type, parameters) => ({ nodes: [{ type, parameters }] });
  assert.equal(
    describeTrigger(
      mk("n8n-nodes-base.scheduleTrigger", {
        rule: { interval: [{ field: "minutes", minutesInterval: 5 }] },
      }),
    ).intervalMs,
    5 * 6e4,
  );
  assert.equal(
    describeTrigger(
      mk("n8n-nodes-base.scheduleTrigger", {
        rule: { interval: [{ field: "weeks", weeksInterval: 2 }] },
      }),
    ).intervalMs,
    14 * 864e5,
  );
  assert.equal(
    describeTrigger(
      mk("n8n-nodes-base.cron", {
        triggerTimes: {
          item: [{ mode: "everyX", value: 10, unit: "minutes" }],
        },
      }),
    ).intervalMs,
    10 * 6e4,
  );
  assert.equal(
    describeTrigger(
      mk("n8n-nodes-base.interval", { interval: 30, unit: "seconds" }),
    ).intervalMs,
    30000,
  );
  assert.equal(
    describeTrigger(
      mk("n8n-nodes-base.scheduleTrigger", {
        rule: {
          interval: [
            { field: "hours", hoursInterval: 1 },
            { field: "days", daysInterval: 1 },
          ],
        },
      }),
    ).intervalMs,
    864e5,
  );
});

test("a disabled trigger node does not count", () => {
  const t = describeTrigger({
    nodes: [
      {
        type: "n8n-nodes-base.scheduleTrigger",
        disabled: true,
        parameters: {},
      },
    ],
  });
  assert.equal(t.kind, "none");
});

test("unreadable cron expression is SKIP, not a false alarm", () => {
  const w = {
    id: "x",
    name: "bad",
    active: true,
    nodes: [
      {
        type: "n8n-nodes-base.scheduleTrigger",
        parameters: {
          rule: {
            interval: [{ field: "cronExpression", expression: "nonsense" }],
          },
        },
      },
    ],
  };
  assert.equal(evaluateWorkflow(w, [], { now: NOW }).status, "SKIP");
});

test("cron max gap", () => {
  assert.equal(maxGapMs("*/5 * * * *"), 5 * 6e4);
  assert.equal(maxGapMs("0 9 * * *"), 24 * 36e5);
  assert.equal(maxGapMs("0 9 * * 1-5"), 72 * 36e5);
  assert.equal(maxGapMs("0 0 1 * *") >= 28 * 864e5, true);
  assert.equal(maxGapMs("61 * * * *"), null);
});

test("duration helpers", () => {
  assert.equal(parseDuration("90m"), 90 * 6e4);
  assert.equal(parseDuration("2d"), 2 * 864e5);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("0h"), null);
  assert.equal(formatDuration(80 * 36e5), "3d");
  assert.equal(formatDuration(5 * 6e4), "5m");
});
