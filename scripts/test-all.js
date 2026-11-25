#!/usr/bin/env node
"use strict";
// Runs every tool's own test suite, one after another (no parallel load).
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..", "tools");
const suites = [
  { name: "silent-failure-check", cwd: "silent-failure-check", cmd: [process.execPath, "--test"] },
  { name: "estate-graph", cwd: "estate-graph", cmd: [process.execPath, "--test"] },
  { name: "retainer-report", cwd: "retainer-report", cmd: [process.execPath, "--test"] },
  { name: "handover-docs", cwd: "handover-docs", cmd: [process.execPath, "--test"] },
  { name: "workflow-lint", cwd: "workflow-lint", cmd: [process.execPath, "--test"] },
  { name: "circuit-breaker-pack (cost math)", cwd: "circuit-breaker-pack", cmd: ["python", "-I", "tests/test_cost_math.py"] },
  { name: "circuit-breaker-pack (validator)", cwd: "circuit-breaker-pack", cmd: ["python", "-I", "tests/test_validator.py"] },
  { name: "circuit-breaker-pack (workflows)", cwd: "circuit-breaker-pack", cmd: ["python", "-I", "tests/validate_workflows.py"] },
];
const only = process.argv[2];
let failed = 0;
for (const s of suites) {
  if (only && !s.name.startsWith(only)) continue;
  console.log(`\n=== ${s.name}`);
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: path.join(root, s.cwd), stdio: "inherit" });
  if (r.status !== 0) {
    failed++;
    console.log(`=== FAILED: ${s.name}`);
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
