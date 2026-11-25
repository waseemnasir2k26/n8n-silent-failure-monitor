"use strict";
// Deterministic synthetic data for the demo. Not real client data.
const fs = require("fs");
const path = require("path");

let seed = 20261024;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

const workflows = [
  {
    id: "101",
    name: "Lead intake to CRM",
    tags: [{ id: "t1", name: "harbor" }],
  },
  {
    id: "102",
    name: "Invoice reminders",
    tags: [{ id: "t1", name: "harbor" }],
  },
  {
    id: "103",
    name: "Support inbox triage",
    tags: [{ id: "t2", name: "harbor-support" }],
  },
  { id: "999", name: "Internal agency housekeeping", tags: [] },
];
const perDay = { 101: 9, 102: 5, 103: 7, 999: 4 };
const failRate = { 101: 0.04, 102: 0.03, 103: 0.07, 999: 0.2 };
const executions = [];
let id = 1000;
const start = Date.UTC(2026, 7, 1);
const end = Date.UTC(2026, 9, 25);
for (let t = start; t < end; t += 86400000) {
  const dow = new Date(t).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  for (const w of workflows) {
    const n = Math.round(
      perDay[w.id] * (weekend ? 0.3 : 1) * (0.7 + rnd() * 0.6),
    );
    for (let i = 0; i < n; i++) {
      const s = t + Math.floor(rnd() * 86400000);
      const failed = rnd() < failRate[w.id];
      const stop = s + 800 + Math.floor(rnd() * 4000);
      executions.push({
        id: String(id++),
        workflowId: w.id,
        finished: !failed,
        mode: "trigger",
        status: failed ? "error" : "success",
        startedAt: new Date(s).toISOString(),
        stoppedAt: new Date(stop).toISOString(),
      });
      // most failures retry and succeed shortly after
      if (failed && rnd() < 0.7) {
        const rs = s + 60000 + Math.floor(rnd() * 25 * 60000);
        executions.push({
          id: String(id++),
          workflowId: w.id,
          finished: true,
          mode: "retry",
          status: "success",
          startedAt: new Date(rs).toISOString(),
          stoppedAt: new Date(rs + 1500).toISOString(),
        });
      }
    }
  }
}
const root = path.join(__dirname, "..", "examples");
fs.writeFileSync(
  path.join(root, "sample-executions.json"),
  JSON.stringify({ workflows, executions }, null, 1) + "\n",
);
console.log("wrote", executions.length, "executions");
