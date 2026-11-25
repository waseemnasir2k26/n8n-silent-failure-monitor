"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computePeriod, normalizeStatus, DAY } = require("../src/core");
const { T0, ex } = require("./helpers");

const wf = [{ id: "1", label: "Leads", minutes: 6 }];
const run = (execs, window = 60) =>
  computePeriod(execs, wf, T0, T0 + 7 * DAY, window);

test("recovery: one success after three failures recovers exactly one", () => {
  const execs = [
    ex("f1", "1", "error", 1, 0),
    ex("f2", "1", "error", 1, 5),
    ex("f3", "1", "error", 1, 10),
    ex("ok", "1", "success", 1, 15),
  ];
  const p = run(execs);
  assert.equal(p.errors, 3);
  assert.equal(p.recovered, 1);
  assert.equal(p.unrecovered, 2);
  // two successes recover two failures, never more
  assert.equal(run([...execs, ex("ok2", "1", "success", 1, 20)]).recovered, 2);
});

test("recovery: a success at the same instant as a failure does not recover it", () => {
  assert.equal(
    run([ex("e", "1", "error", 1, 0), ex("s", "1", "success", 1, 0)]).recovered,
    0,
  );
});

test("recovery: a failure older than the window is skipped, a later one still matches", () => {
  const p = run([
    ex("old", "1", "error", 1, 0),
    ex("new", "1", "error", 1, 100),
    ex("ok", "1", "success", 1, 120),
  ]);
  assert.equal(p.recovered, 1);
});

test("recovery stays fast on large inputs (n log n, not n squared)", () => {
  const execs = [];
  for (let i = 0; i < 40000; i++)
    execs.push(ex("e" + i, "1", i % 2 ? "error" : "success", 1, i % 1400));
  const t = Date.now();
  run(execs);
  assert.ok(Date.now() - t < 3000);
});

test("crashed and failed statuses count as errors; waiting is ignored", () => {
  assert.equal(normalizeStatus({ status: "crashed" }), "error");
  assert.equal(normalizeStatus({ status: "FAILED" }), "error");
  assert.equal(normalizeStatus({ status: "waiting" }), "other");
  assert.equal(normalizeStatus({ finished: true }), "success");
  assert.equal(run([ex("c", "1", "crashed", 1)]).errors, 1);
});
