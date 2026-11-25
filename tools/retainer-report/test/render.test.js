"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeReport, weeklyEmail, DAY } = require("../src/core");
const { monthlyHtml } = require("../src/render");
const { T0, ex } = require("./helpers");

const evil = "<script>alert(1)</script>";
const wfs = [{ id: "1", label: evil, minutes: 5 }];
const r = computeReport({
  executions: [ex("a", "1", "success", 1), ex("b", "1", "error", 2)],
  workflows: wfs,
  win: { startMs: T0, endMs: T0 + 7 * DAY },
  prev: { startMs: T0 - 7 * DAY, endMs: T0 },
  hourlyRate: 40,
  label: "weekly",
});

test("weekly email html escapes client, workflow, notes, narrative, agency", () => {
  const e = weeklyEmail(r, {
    client: evil,
    agency: evil,
    notes: [evil],
    nextStep: evil,
    narrative: evil,
  });
  assert.ok(!e.html.includes("<script>"));
  assert.ok(e.html.includes("&lt;script&gt;"));
});

test("monthly html escapes everything user-controlled", () => {
  const html = monthlyHtml(r, {
    client: evil,
    agency: evil,
    notes: [evil],
    narrative: evil,
    currency: "<b>",
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("monthly html is self-contained: inline svg, no external requests, no scripts", () => {
  const html = monthlyHtml(r, { client: "Acme" });
  assert.match(html, /<svg[^>]+role="img"/);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/(src|href)=["']https?:/i.test(html));
  assert.match(html, /@media print/);
  assert.match(html, /estimates/i);
});

test("email states that hours are an estimate and never claims unmeasured fixes", () => {
  const e = weeklyEmail(r, { client: "Acme" });
  assert.match(e.md, /not a measurement/);
  assert.ok(!/fixed/i.test(e.md));
  assert.match(e.md, /Next step/);
});

test("no estimates configured: says time saved is not calculated", () => {
  const rr = computeReport({
    executions: [ex("a", "1", "success", 1)],
    workflows: [{ id: "1", label: "x", minutes: null }],
    win: { startMs: T0, endMs: T0 + 7 * DAY },
    prev: { startMs: T0 - 7 * DAY, endMs: T0 },
    label: "weekly",
  });
  assert.match(weeklyEmail(rr, {}).md, /not calculated/);
  assert.match(monthlyHtml(rr, { client: "A" }), /not calculated/);
});
