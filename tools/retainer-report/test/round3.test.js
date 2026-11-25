"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main, monthWindow } = require("../src/cli");
const { validateConfig } = require("../src/config");
const {
  computeReport,
  weeklyEmail,
  oneLine,
  esc,
  normalizeExecution,
  DAY,
} = require("../src/core");
const { monthlyHtml } = require("../src/render");
const { T0, ex } = require("./helpers");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nrr-r3-"));
const win = { startMs: T0, endMs: T0 + 7 * DAY };
const prev = { startMs: T0 - 7 * DAY, endMs: T0 };
const report = (label, extra = {}) =>
  computeReport({
    executions: [ex("a", "1", "success", 1), ex("b", "1", "error", 2)],
    workflows: [{ id: "1", label, minutes: 5 }],
    win,
    prev,
    label: "weekly",
    ...extra,
  });

function offline(obj, workflows = [{ id: "1" }]) {
  const dir = tmp();
  const exFile = path.join(dir, "e.json");
  const cfg = path.join(dir, "c.json");
  fs.writeFileSync(exFile, JSON.stringify(obj));
  fs.writeFileSync(cfg, JSON.stringify({ client: "A", workflows }));
  return {
    args: [
      "--config",
      cfg,
      "--from-file",
      exFile,
      "--out",
      path.join(dir, "out"),
      "--end",
      "2026-10-18",
    ],
    out: path.join(dir, "out"),
  };
}
const run = async (args) => {
  const lines = [];
  const code = await main(
    args,
    {},
    { stdout: (s) => lines.push(s), stderr: (s) => lines.push(s) },
  );
  return { code, text: lines.join("\n") };
};

test("long unbroken label cannot widen the monthly report", () => {
  const html = monthlyHtml(report("W".repeat(200)), {
    client: "C".repeat(200),
  });
  assert.match(html, /table-layout:fixed/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /<colgroup>/);
  // numeric columns keep fixed widths so they stay visible in print too
  assert.match(html, /<col style="width:12%">/);
});

test("--month with a year outside 2000-2100 or a 2-digit year exits 2", async () => {
  assert.throws(() => monthWindow("0050-03"), /year/);
  assert.throws(() => monthWindow("1999-12"), /year/);
  assert.throws(() => monthWindow("2101-01"), /year/);
  assert.doesNotThrow(() => monthWindow("2026-09"));
  for (const flag of [
    ["--month", "0050-03"],
    ["--end", "0050-03-01"],
  ]) {
    const o = offline([]);
    const r = await run([...o.args, ...flag]);
    assert.equal(r.code, 2, flag.join(" ") + r.text);
  }
});

test("workflow id must be a string or integer", () => {
  const base = { client: "A" };
  for (const bad of [{}, [], [1], { a: 1 }, true, 1.5])
    assert.throws(
      () => validateConfig({ ...base, workflows: [{ id: bad }] }),
      /id|exactly one/,
      JSON.stringify(bad),
    );
  assert.equal(
    validateConfig({ ...base, workflows: [{ id: 7 }] }).workflows[0].id,
    "7",
  );
  assert.equal(
    validateConfig({ ...base, workflows: [{ id: " 7 " }] }).workflows[0].id,
    "7",
  );
});

test("bidi controls are stripped; markdown syntax in names is escaped in the .md only", () => {
  const evil = "a‮b⁦c⁩d";
  assert.equal(oneLine(evil), "abcd");
  assert.equal(esc(evil), "abcd");
  const r = report("[Click](http://evil.example) *bold* _it_ `code`");
  const e = weeklyEmail(r, {
    contactName: "*Sa*rah",
    notes: ["see [x](y)"],
    nextStep: "do _this_",
  });
  assert.ok(!e.md.includes("[Click](http"));
  assert.ok(
    e.md.includes(
      "\\[Click\\]\\(http://evil.example\\) \\*bold\\* \\_it\\_ \\`code\\`",
    ),
  );
  assert.ok(e.md.includes("Hi \\*Sa\\*rah,"));
  assert.ok(e.md.includes("see \\[x\\]\\(y\\)"));
  // html keeps the readable text (it is escaped for HTML instead)
  assert.ok(e.html.includes("[Click](http://evil.example) *bold*"));
  // our own punctuation is not escaped
  assert.match(e.md, /successful \(\d/);
});

test("rows without an id are never deduplicated and are reported", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    workflowId: "1",
    status: "success",
    startedAt: new Date(Date.UTC(2026, 9, 14, 1, i)).toISOString(),
  }));
  const r = computeReport({
    executions: rows.map(normalizeExecution),
    workflows: [{ id: "1", label: "x", minutes: 1 }],
    win,
    prev,
    label: "weekly",
  });
  assert.equal(r.runs, 10);
  const o = offline({ executions: rows });
  const res = await run(o.args);
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /10 rows had no id; counted individually/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(o.out, "report.json"), "utf8")).weekly
      .runs,
    10,
  );
});

test("malformed offline workflows exit 2 with a clear message, not a TypeError", async () => {
  for (const wf of [
    [null],
    "nope",
    [{ id: "1", tags: "x" }],
    [{ id: "1", tags: [null] }],
    [{ name: "no id" }],
    [[]],
  ]) {
    const o = offline({ executions: [], workflows: wf });
    const r = await run(o.args);
    assert.equal(r.code, 2, JSON.stringify(wf) + " -> " + r.text);
    assert.ok(!/TypeError/.test(r.text));
  }
});

test("bad timestamps are counted and reported; epoch milliseconds are accepted", async () => {
  const ms = Date.UTC(2026, 9, 14, 8);
  const rows = [
    { id: "1", workflowId: "1", status: "success", startedAt: ms },
    {
      id: "2",
      workflowId: "1",
      status: "success",
      startedAt: new Date(ms + 60000).toISOString(),
    },
    { id: "3", workflowId: "1", status: "success", startedAt: "not a date" },
    { id: "4", workflowId: "1", status: "success" },
    { id: "5", status: "success", startedAt: ms },
  ];
  const o = offline(rows);
  const res = await run(o.args);
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /2 rows skipped: bad timestamp/);
  assert.match(res.text, /1 rows skipped: no workflowId/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(o.out, "report.json"), "utf8")).weekly
      .runs,
    2,
  );
});

test("monthly footer markup is not nested; hourlyRate 0 still shows the value line", () => {
  const html = monthlyHtml(report("x", { truncated: true, hourlyRate: 0 }), {
    client: "A",
  });
  assert.ok(
    !/<p class="foot">(?:(?!<\/p>).)*<p/s.test(html),
    "no <p> inside a foot <p>",
  );
  assert.match(html, /may be incomplete/);
  assert.match(html, /\$0/);
  const e = weeklyEmail(report("x", { hourlyRate: 0 }), { currency: "$" });
  assert.match(e.md, /about \$0 at \$0\/hour/);
});
