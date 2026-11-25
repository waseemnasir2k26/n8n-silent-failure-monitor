"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeReport, computePeriod, DAY } = require("../src/core");
const { T0, ex } = require("./helpers");

const wfs = [
  { id: "1", label: "Leads", minutes: 6 },
  { id: "2", label: "Invoices", minutes: 30 },
  { id: "3", label: "No estimate", minutes: null },
];
const win = { startMs: T0, endMs: T0 + 7 * DAY };
const prev = { startMs: T0 - 7 * DAY, endMs: T0 };

test("metric math on a fixture", () => {
  const execs = [
    ...Array.from({ length: 10 }, (_, i) =>
      ex("l" + i, "1", "success", i % 7, i),
    ),
    ex("lf1", "1", "error", 1, 300),
    ex("lf2", "1", "error", 1, 400),
    ...Array.from({ length: 4 }, (_, i) => ex("i" + i, "2", "success", 2, i)),
    ex("x", "9", "success", 1), // not tracked
    ex("w", "1", "other", 1), // waiting or cancelled: ignored
    ex("p1", "1", "success", -3),
    ex("p2", "1", "success", -2),
    ex("p3", "2", "error", -2),
  ];
  const r = computeReport({
    executions: execs,
    workflows: wfs,
    win,
    prev,
    hourlyRate: 50,
    recoveryMinutes: 60,
    label: "weekly",
  });
  assert.equal(r.runs, 16);
  assert.equal(r.success, 14);
  assert.equal(r.errors, 2);
  assert.equal(r.errorRate, 12.5);
  // 10 x 6 min + 4 x 30 min = 180 min = 3 h
  assert.equal(r.hoursSaved, 3);
  assert.equal(r.value, 150);
  assert.equal(r.period.start, "2026-10-12");
  assert.equal(r.period.end, "2026-10-18");
  assert.equal(r.previous.runs, 3);
  assert.equal(r.change.runs.abs, 13);
  assert.equal(r.change.runs.pct, 433.3);
  assert.deepEqual(
    r.topFailing.map((w) => [w.label, w.errors]),
    [["Leads", 2]],
  );
  assert.equal(r.busiestDays[0].date, "2026-10-14"); // day 2 has the most runs (5)
  assert.equal(r.daily.length, 7);
  assert.deepEqual(r.missingEstimates, ["No estimate"]);
  assert.equal(r.change.errors.pct, 100); // previous 1 error, now 2
});

test("hours saved is null when no estimate exists, never invented", () => {
  const r = computeReport({
    executions: [ex("a", "3", "success", 1)],
    workflows: [wfs[2]],
    win,
    prev,
    hourlyRate: 50,
    label: "weekly",
  });
  assert.equal(r.hoursSaved, null);
  assert.equal(r.value, null);
});

test("no hourly rate means no money value", () => {
  const r = computeReport({
    executions: [ex("a", "1", "success", 1)],
    workflows: [wfs[0]],
    win,
    prev,
    label: "weekly",
  });
  assert.equal(r.value, null);
  assert.equal(r.hoursSaved, 0.1);
});

test("week-over-week is null (not infinity) when the previous period is empty", () => {
  const r = computeReport({
    executions: [ex("a", "1", "success", 1)],
    workflows: [wfs[0]],
    win,
    prev,
    label: "weekly",
  });
  assert.equal(r.change.runs.pct, null);
  assert.equal(r.change.runs.abs, 1);
});

test("auto-recovered: later success of the same workflow within the window", () => {
  const execs = [
    ex("e1", "1", "error", 1, 0),
    ex("s1", "1", "success", 1, 30), // recovered (30 min)
    ex("e2", "1", "error", 2, 0),
    ex("s2", "1", "success", 2, 61), // too late
    ex("e3", "1", "error", 3, 0),
    ex("s3", "2", "success", 3, 5), // other workflow
    ex("s4", "1", "success", 4, -5),
    ex("e4", "1", "error", 4, 0), // success came before the error
    ex("e5", "1", "error", 5, 0),
    ex("e6", "1", "error", 5, 10),
    ex("s5", "1", "success", 5, 20), // both recovered
  ];
  const p = computePeriod(execs, [wfs[0], wfs[1]], T0, T0 + 7 * DAY, 60);
  assert.equal(p.errors, 6);
  // e1 by s1, e5 by s5; e6 has no success left (a success recovers one failure)
  assert.equal(p.recovered, 2);
  assert.equal(p.unrecovered, 4);
  const wide = computePeriod(execs, [wfs[0], wfs[1]], T0, T0 + 7 * DAY, 120);
  assert.equal(wide.recovered, 3); // e2 is now inside the window of s2
});

test("a success just after the period end still counts as recovery", () => {
  const execs = [
    ex("e", "1", "error", 6, 23 * 60 + 50),
    ex("s", "1", "success", 7, 5),
  ];
  const p = computePeriod(execs, [wfs[0]], T0, T0 + 7 * DAY, 60);
  assert.equal(p.errors, 1);
  assert.equal(p.recovered, 1);
});
