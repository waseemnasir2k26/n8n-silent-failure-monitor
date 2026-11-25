"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateConfig,
  resolveWorkflows,
  ConfigError,
} = require("../src/config");

const ok = {
  client: "Acme",
  workflows: [{ id: 101, minutesSavedPerSuccessfulRun: 5 }],
};

test("valid config gets defaults", () => {
  const c = validateConfig(ok);
  assert.equal(c.recoveryWindowMinutes, 60);
  assert.equal(c.hourlyRate, null);
  assert.equal(c.currency, "$");
  assert.equal(c.workflows[0].id, "101");
});

test("invalid configs report every problem", () => {
  assert.throws(
    () => validateConfig({ workflows: [] }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /client/);
      assert.match(e.message, /workflows/);
      return true;
    },
  );
  assert.throws(() => validateConfig({ ...ok, hourlyRate: -1 }), /hourlyRate/);
  assert.throws(
    () => validateConfig({ ...ok, recoveryWindowMinutes: 0 }),
    /recoveryWindowMinutes/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...ok,
        workflows: [{ id: "1", minutesSavedPerSuccessfulRun: -2 }],
      }),
    /minutesSaved/,
  );
  assert.throws(
    () => validateConfig({ ...ok, workflows: [{ id: "1", tag: "x" }] }),
    /exactly one/,
  );
  assert.throws(
    () => validateConfig({ ...ok, workflows: [{}] }),
    /exactly one/,
  );
  assert.throws(() => validateConfig({ ...ok, notes: "nope" }), /notes/);
  assert.throws(() => validateConfig(null), /JSON object/);
});

test("minutes are never invented: missing stays null", () => {
  assert.equal(
    validateConfig({ client: "A", workflows: [{ id: "1" }] }).workflows[0]
      .minutes,
    null,
  );
});

test("tags resolve to workflows, ids dedupe, unknowns warn", () => {
  const c = validateConfig({
    client: "A",
    workflows: [
      { id: "1", label: "Mine" },
      { tag: "Acme", minutesSavedPerSuccessfulRun: 3 },
      { tag: "ghost" },
      { id: "9" },
    ],
  });
  const api = [
    { id: "1", name: "One", tags: [{ id: "t", name: "acme" }] },
    { id: "2", name: "Two", tags: [{ id: "t", name: "acme" }] },
    { id: "3", name: "Three", tags: [] },
  ];
  const { workflows, warnings } = resolveWorkflows(c, api);
  assert.deepEqual(
    workflows.map((w) => [w.id, w.label, w.minutes]),
    [
      ["1", "Mine", null],
      ["2", "Two", 3],
      ["9", "9", null],
    ],
  );
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /ghost/.test(w)));
  assert.ok(warnings.some((w) => /\b9\b/.test(w)));
});
