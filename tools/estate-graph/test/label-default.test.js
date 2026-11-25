"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const bin = path.join(__dirname, "..", "bin", "n8n-estate-graph.js");
const ex = path.join(__dirname, "..", "examples", "workflows");

test("no --label: each first-level subfolder becomes its own client", () => {
  const out = execFileSync(process.execPath, [bin, "spof", "--from-dir", ex, "--json"], { encoding: "utf8" });
  const text = JSON.stringify(JSON.parse(out));
  assert.match(text, /acme-dental/);
  assert.match(text, /bali-villas/);
  assert.doesNotMatch(text, /"workflows"\]|\[workflows\]/);
});

test("explicit --label still wins over subfolder names", () => {
  const out = execFileSync(process.execPath, [bin, "spof", "--from-dir", ex, "--label", "one-client", "--json"], { encoding: "utf8" });
  const text = JSON.stringify(JSON.parse(out));
  assert.match(text, /one-client/);
  assert.doesNotMatch(text, /acme-dental/);
});
