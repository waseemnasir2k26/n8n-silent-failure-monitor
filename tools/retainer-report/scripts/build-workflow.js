"use strict";
// Builds examples/n8n-workflow.json. The Code node embeds src/core.js (above the exports marker)
// so the n8n route and the CLI compute identical numbers.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs
  .readFileSync(path.join(root, "src", "core.js"), "utf8")
  .split("// --- exports ---")[0]
  .replace("'use strict';", "");

const glue = `
// ===== EDIT THIS BLOCK =====
const CONFIG = {
  client: 'Client Name',
  contactName: '', // first name for the greeting, e.g. 'Sarah'. Empty = 'Hi there,'
  agency: 'Your Agency',
  currency: '$',
  hourlyRate: 35, // set to null to hide money value
  recoveryWindowMinutes: 60,
  // minutes = YOUR estimate of time saved per successful run. Leave null if you have no estimate.
  workflows: [
    { id: '101', label: 'Lead intake to CRM', minutes: 6 },
    { id: '102', label: 'Invoice reminders', minutes: 4 },
  ],
  notes: [], // optional lines you write yourself, shown under "Work done this week"
  nextStep: '',
  to: 'client@example.com',
};
// ===== END EDIT =====

const rows = [];
for (const item of $input.all()) {
  const j = item.json;
  if (Array.isArray(j.data)) rows.push(...j.data);
  else if (j.workflowId != null) rows.push(j);
}
// The HTTP node pages with nextCursor up to its maxRequests cap. If the last page still has a cursor, the cap was hit.
const items = $input.all();
const last = items.length ? items[items.length - 1].json : null;
const executions = rows.map(normalizeExecution).filter(Boolean);
const nowMs = Date.now();
const todayMs = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
// truncated only if a cursor is left AND the oldest row fetched is still inside the 14-day window
const oldest = executions.length ? Math.min(...executions.map((e) => e.startMs)) : Infinity;
const truncated = !!(last && last.nextCursor) && oldest >= todayMs - 14 * DAY;
const now = new Date();
const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); // today 00:00 UTC, exclusive
const win = { startMs: endMs - 7 * DAY, endMs };
const prev = { startMs: endMs - 14 * DAY, endMs: endMs - 7 * DAY };
const report = computeReport({
  executions, workflows: CONFIG.workflows, win, prev,
  hourlyRate: CONFIG.hourlyRate, recoveryMinutes: CONFIG.recoveryWindowMinutes, label: 'weekly', truncated,
});
const email = weeklyEmail(report, {
  client: CONFIG.client, contactName: CONFIG.contactName, agency: CONFIG.agency, currency: CONFIG.currency,
  notes: CONFIG.notes, nextStep: CONFIG.nextStep,
});
return [{ json: { to: CONFIG.to, subject: email.subject, html: email.html, md: email.md, report } }];
`;

const workflow = {
  name: "Weekly retainer report (draft only)",
  nodes: [
    {
      parameters: {
        rule: {
          interval: [
            {
              field: "weeks",
              weeksInterval: 1,
              triggerAtDay: [1],
              triggerAtHour: 7,
            },
          ],
        },
      },
      id: "a1000000-0000-4000-8000-000000000001",
      name: "Every Monday 07:00",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, 0],
    },
    {
      parameters: {
        url: 'http://localhost:5678/api/v1/executions',
        authentication: "genericCredentialType",
        genericAuthType: "httpHeaderAuth",
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: "limit", value: "250" },
            { name: "includeData", value: "false" },
          ],
        },
        options: {
          pagination: {
            pagination: {
              parameters: {
                parameters: [
                  {
                    type: "qs",
                    name: "cursor",
                    value: "={{ $response.body.nextCursor }}",
                  },
                ],
              },
              paginationCompleteWhen: "other",
              completeExpression: "={{ !$response.body.nextCursor }}",
              limitPagesFetched: true,
              maxRequests: 20,
            },
          },
        },
      },
      id: "a1000000-0000-4000-8000-000000000002",
      name: "Get executions (metadata only)",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [240, 0],
      notes:
        "Create an HTTP Header Auth credential: name X-N8N-API-KEY, value = your n8n API key. includeData=false keeps payloads out.",
    },
    {
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode: core + glue,
      },
      id: "a1000000-0000-4000-8000-000000000003",
      name: "Compute metrics and email",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [480, 0],
    },
    {
      parameters: {
        resource: "draft",
        operation: "create",
        subject: "={{ $json.subject }}",
        emailType: "html",
        message: "={{ $json.html }}",
        options: { sendTo: "={{ $json.to }}" },
      },
      id: "a1000000-0000-4000-8000-000000000004",
      name: "Create Gmail draft (does not send)",
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [720, 0],
      notes:
        "Draft only. Review it in Gmail, then send yourself. Attach your Gmail credential.",
    },
  ],
  connections: {
    "Every Monday 07:00": {
      main: [
        [{ node: "Get executions (metadata only)", type: "main", index: 0 }],
      ],
    },
    "Get executions (metadata only)": {
      main: [[{ node: "Compute metrics and email", type: "main", index: 0 }]],
    },
    "Compute metrics and email": {
      main: [
        [
          {
            node: "Create Gmail draft (does not send)",
            type: "main",
            index: 0,
          },
        ],
      ],
    },
  },
  pinData: {},
  settings: { executionOrder: "v1" },
  active: false,
  meta: { templateCredsSetupCompleted: false },
};

fs.writeFileSync(
  path.join(root, "examples", "n8n-workflow.json"),
  JSON.stringify(workflow, null, 2) + "\n",
);
console.log("wrote examples/n8n-workflow.json");
