# n8n-silent-failure-monitor

Find the n8n workflows that quietly stopped running, before your client does.

```text
$ node bin/nsfm.js check --config tools/silent-failure-check/fixtures/demo-config.json --now 2026-11-20T12:00:00Z
STATUS   CLIENT       WORKFLOW                            EXPECTED   LAST RUN  DETAIL
-------  -----------  ----------------------------------  ---------  --------  --------------------------------------------
STALLED  Demo Client  Daily invoice export                every 24h  3d ago    no run for 3d (limit 48h, every 24h)
STALLED  Demo Client  Hourly sheet import (never ran)     every 60m  never     never ran, last changed 319d ago
STALLED  Demo Client  Nightly report, +08:00 run 51h ago  every 24h  51h ago   no run for 51h (limit 48h, every 24h)
STALLED  Demo Client  Order intake webhook                webhook    30h ago   no run for 30h (limit 24h, max silence 24h)
FAILING  Demo Client  CRM push (every 15 min)             every 15m  5m ago    last 3 runs errored, last success 65m ago
FAILING  Demo Client  Flaky API sync (hourly, mixed)      every 60m  10m ago   no success for 3h10m, runs are erroring
OK       Demo Client  Contact form webhook                webhook    30h ago   webhook, no max-silence set, not checked
OK       Demo Client  Just activated hourly job           every 60m  never     no runs yet, recently changed (grace period)
OK       Demo Client  Lead intake sync (hourly)           every 60m  20m ago   last run 20m ago
OK       Demo Client  Nightly backup, +08:00 run 47h ago  every 24h  47h ago   last run 47h ago
OK       Demo Client  Weekday morning digest (cron)       every 3d   3h ago    last run 3h ago

13 workflows: 4 stalled, 2 failing, 5 ok, 2 hidden (disabled or not scheduled; use --all)
$ echo $?
1
```

The data above is fake demo data from `tools/silent-failure-check/fixtures/`. The exit code is 1 when anything is STALLED or FAILING, so you can run it from cron.

Run it yourself (needs Node 20 or newer, no `npm install`):

```bash
git clone https://github.com/waseemnasir2k26/n8n-silent-failure-monitor && cd n8n-silent-failure-monitor && node bin/nsfm.js check --config tools/silent-failure-check/fixtures/demo-config.json --now 2026-11-20T12:00:00Z
```

| Command    | What it does                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `check`    | Silent-failure check. Flags workflows that stopped running or keep failing.                         |
| `graph`    | Estate graph. Maps credentials, webhooks and sub-workflow calls, and shows what breaks if one dies. |
| `report`   | Retainer report. Turns execution history into a weekly client email and a monthly report.           |
| `handover` | Handover docs. Builds a plain-English client handover pack from workflow JSON.                      |
| `lint`     | Workflow lint. Finds leaked secrets, missing error handling and unbounded AI-agent loops.           |
| `breaker`  | Circuit breaker pack. Importable n8n sub-workflows that cap spend, loops and error rate.            |

## Why this exists

An n8n workflow that errors is easy to see. One that simply stops running is not. The trigger gets deactivated, a credential expires and the schedule never fires, or the instance restarts and the workflow never comes back. Nothing errors, so nothing alerts. One agency owner reported losing a $2,500 a month client after a workflow sat silent for three days.

`check` looks for the missing runs, not just the failed ones.

## Quick start (about 5 minutes)

1. Install Node 20 or newer and clone this repo. There are no dependencies to install.
2. Create an API key in each n8n instance: Settings, n8n API. A read-only key is enough. It needs permission to list workflows and executions.
3. Put the URL and key in environment variables. Do not put them in a file in the repo.

   ```bash
   export CLIENT_A_N8N_URL="https://n8n.client-a.example"
   export CLIENT_A_N8N_KEY="paste-your-key-here"
   ```

4. Copy `tools/silent-failure-check/fixtures/clients.example.json` to `clients.json` and list your clients. The file holds the names of the environment variables, never their values.
5. Run it:

   ```bash
   node bin/nsfm.js check --config clients.json
   ```

6. Put it in cron or any scheduler and alert on a non-zero exit code. For one instance with no config file, set `N8N_BASE_URL` and `N8N_API_KEY` and run `node bin/nsfm.js check`.

## Config

```json
{
  "defaults": { "factor": 2, "failRuns": 3 },
  "clients": [
    {
      "name": "Client A",
      "urlEnv": "CLIENT_A_N8N_URL",
      "keyEnv": "CLIENT_A_N8N_KEY",
      "webhookMaxSilence": {
        "default": "24h",
        "workflows": { "Order intake webhook": "6h" }
      }
    },
    { "name": "Client B (offline export)", "file": "exports/client-b.json" }
  ]
}
```

- `urlEnv` and `keyEnv` are environment variable names. The tool refuses a config that contains a URL or key value.
- `file` reads an offline export instead: `{"workflows": [...], "executions": [...]}`, using the same fields the n8n API returns.
- `webhookMaxSilence` is per client or per workflow (by name or id), such as `30m`, `24h` or `2d`. Without it, webhook workflows are never flagged.

## How the check decides

- Only active workflows are checked. Archived and inactive ones are listed as DISABLED (use `--all`).
- The expected interval comes from the Schedule Trigger node (every N seconds to months, or a cron expression), the older Cron node, or the older Interval node. For cron expressions the longest gap between two runs is used, so a weekday-only job gets a 3-day gap over the weekend.
- STALLED: no run for more than 2 times the expected interval (`--factor` changes the 2), or the workflow has never run and was last changed longer ago than that limit. Newly changed workflows get a grace period.
- FAILING: the last 3 finished runs errored (`--fail-runs`), or there has been no success inside the limit and the latest run errored.
- Webhook workflows: STALLED only when your max-silence threshold is exceeded.
- Executions with status `running`, `waiting`, `new` or `canceled` count as activity but not as success or failure.

Options: `--json`, `--all`, `--client <name>`, `--factor`, `--fail-runs`, `--webhook-max-silence`, `--now`. Exit codes: 0 fine, 1 stalled or failing, 2 could not check (bad input or API error).

## The other tools

Each tool keeps its own README, examples and tests under `tools/<name>/`. Those READMEs were written when each tool had its own repo, so install lines such as `npx github:waseemnasir2k26/n8n-estate-graph` there refer to the old standalone repos. From this repo, use `node bin/nsfm.js <tool>`.

- `graph`: `node bin/nsfm.js graph build --from-dir exports/client-a --label client-a --out graph-out`, then `blast` or `spof` against `graph-out/graph.json`.
- `report`: `node bin/nsfm.js report --config my-config.json --out out`. See `tools/retainer-report/README.md` for the config.
- `handover`: `node bin/nsfm.js handover --from-dir exports --out handover --title "Client name"`.
- `lint`: `node bin/nsfm.js lint ./my-workflows --fail-on high`.
- `breaker`: import the JSON files in `tools/circuit-breaker-pack/workflows/` into n8n and wire them as that README describes. `node bin/nsfm.js breaker` checks the JSON is valid.

## Tests

```bash
npm test          # runs every tool's suite, one after another
node scripts/test-all.js silent-failure-check
```

The `handover-docs` suite includes a fuzz test that takes a couple of minutes on a slow machine.

## Limitations

- The check is a pull check. It sees what the n8n API shows at the moment you run it. If it runs on the same server as n8n and that server is down, it cannot alert you. Run it from somewhere else.
- It only reads the latest 50 executions per workflow. Instances that prune execution history aggressively can show a healthy but rarely running workflow as "never ran".
- Schedules are read from the workflow's trigger node. It does not know about runs triggered by other workflows, the Execute Workflow node, or manual runs.
- Cron gaps are worked out in UTC. Daylight saving changes shift a gap by an hour at most, which the 2x margin absorbs.
- With several schedule rules on one trigger, the longest single interval is used. This avoids false alarms but can miss a stall in a more frequent rule.
- Webhook workflows need a threshold you choose. The tool cannot guess how often a webhook should be called.
- Tested against fixtures and a local mock server. It has not yet been run against a live n8n instance. The API fields it uses (`status`, `startedAt`, `stoppedAt`, `workflowId`, `nextCursor`, `X-N8N-API-KEY`) were checked against the n8n public API spec in the n8n source repo.
- The sub-tools come from five earlier standalone repos. They work, but their docs are not yet unified.

## Hosted version

A hosted, multi-client version is planned: one dashboard for all your instances, alerts, and white-label monthly client reports. It is not built yet. Details and a founding list are on the landing page: https://waseemnasir2k26.github.io/n8n-silent-failure-monitor/

## Licence

MIT. See `LICENSE`. Each tool under `tools/` is also MIT.
