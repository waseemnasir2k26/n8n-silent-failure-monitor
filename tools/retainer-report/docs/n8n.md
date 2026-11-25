# Run it inside n8n (no terminal)

`examples/n8n-workflow.json` is a four-node workflow: Schedule (Mondays 07:00) -> HTTP Request to your n8n API -> Code node -> Gmail **draft**. It never sends anything. You review the draft and send it yourself.

The Code node contains the same metric and email code as the CLI (it is generated from `src/core.js` by `npm run build:workflow`), so the numbers match.

## Setup

1. In n8n: Settings -> n8n API -> create an API key (read access is enough).
2. Import `examples/n8n-workflow.json` (Workflows -> Import from file).
3. Create a credential of type **Header Auth**: name `X-N8N-API-KEY`, value = the key. Attach it to the HTTP Request node. Do not paste the key into the node itself.
4. In the HTTP Request node, replace `http://localhost:5678` in the URL with your n8n address (keep the `/api/v1/executions` path).
5. Open the Code node and edit the `CONFIG` block at the top: client name, your agency name, hourly rate, and the workflows to report on.
   - `id` is the workflow id (visible in the workflow URL).
   - `minutes` is **your** estimate of minutes saved per successful run. Leave it `null` if you have no estimate; the report then says time saved is not calculated.
   - `notes` are lines you write yourself ("Added a retry on the CRM step"). They appear under "Work done this week". The workflow does not guess what you fixed.
   - `contactName` is the first name used in the greeting ("Hi Sarah,"). Empty gives "Hi there,".
   - `to` is the client's email address for the draft.
6. Attach your Gmail credential to the draft node. Execute once manually and check the draft.
7. Activate the workflow when you are happy.

## What it reads

The HTTP node calls `GET /api/v1/executions?limit=250&includeData=false` and pages with `nextCursor` (up to 20 pages, 5,000 executions). With `includeData=false` n8n returns metadata only: id, workflow id, status, timestamps. Execution payloads are not requested.

## Limits

- If the 20-page cap is hit, the draft starts its Issues list with a warning that the data may be incomplete.
- The HTTP node pulls executions for the whole instance, not per workflow. A busy instance may exceed 5,000 executions in the window; raise `maxRequests` or use the CLI, which fetches per workflow.
- Ids only (no tags) inside n8n. The CLI supports tags.
- Weekly window is the 7 days ending yesterday, UTC.
- Imported workflows can need small node-version fixes on older n8n versions. This workflow has been tested by running its Code node against fixtures, not on a live n8n instance.
