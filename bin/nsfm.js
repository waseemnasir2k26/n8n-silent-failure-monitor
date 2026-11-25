#!/usr/bin/env node
"use strict";
// One entry point for the six tools. Each tool keeps its own CLI under tools/<name>;
// this file only picks one and passes the remaining arguments through.
const { spawnSync } = require("child_process");
const path = require("path");

const T = path.join(__dirname, "..", "tools");
const TOOLS = {
  check: { desc: "silent-failure check: workflows that stopped running or keep failing", cmd: "node", file: ["silent-failure-check", "bin", "silent-failure-check.js"] },
  graph: { desc: "estate graph: what depends on what, and what breaks if X dies", cmd: "node", file: ["estate-graph", "bin", "n8n-estate-graph.js"] },
  report: { desc: "retainer report: weekly client email and monthly report", cmd: "node", file: ["retainer-report", "bin", "n8n-retainer-report.js"] },
  handover: { desc: "handover docs: client handover pack from workflow JSON", cmd: "node", file: ["handover-docs", "bin", "n8n-handover-docs.js"] },
  lint: { desc: "workflow lint: secrets, missing error handling, unbounded agents", cmd: "node", file: ["workflow-lint", "bin", "cli.js"] },
  breaker: { desc: "circuit breaker pack: validate the importable breaker workflows", cmd: "python", file: ["circuit-breaker-pack", "tests", "validate_workflows.py"] },
};

function help() {
  const rows = Object.entries(TOOLS).map(([k, v]) => `  ${k.padEnd(9)}${v.desc}`);
  console.log(`n8n-silent-failure-monitor\n\nUsage: node bin/nsfm.js <tool> [options]\n\n${rows.join("\n")}\n\nRun a tool with --help for its options. Start with: check`);
}

const [name, ...rest] = process.argv.slice(2);
if (!name || name === "-h" || name === "--help" || name === "help") {
  help();
  process.exit(name ? 0 : 2);
}
const tool = TOOLS[name];
if (!tool) {
  console.error(`unknown tool "${name}"\n`);
  help();
  process.exit(2);
}
const args = tool.cmd === "python" ? ["-I", path.join(T, ...tool.file), ...rest] : [path.join(T, ...tool.file), ...rest];
const r = spawnSync(tool.cmd === "node" ? process.execPath : tool.cmd, args, { stdio: "inherit" });
if (r.error) {
  console.error(`could not start ${tool.cmd}: ${r.error.message}`);
  process.exit(2);
}
process.exit(r.status === null ? 2 : r.status);
