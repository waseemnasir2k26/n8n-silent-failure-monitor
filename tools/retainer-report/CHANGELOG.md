# Changelog

## 1.0.1 - 2026-10-25

- Monthly report layout: fixed table layout and wrapping, so a very long workflow or client name cannot widen the page (`scripts/check-layout.py` verifies with Chrome).
- `--month` and `--end` require years 2000 to 2100 (a 2-digit year no longer maps to 19xx).
- Workflow `id` must be a string or integer. Offline `workflows` are validated (exit 2 instead of a TypeError).
- Bidi control characters are stripped; markdown syntax in names, notes and labels is escaped in the `.md` email.
- Offline rows without an id are never deduplicated (and are reported); rows with a bad timestamp or no workflowId are counted and reported; epoch-millisecond timestamps are accepted.
- Monthly footer markup fixed (no nested paragraphs). README: `--demo` also ignores `--month`; warning about sharing a tag across clients.

- Executions are deduplicated by workflow id and execution id, so overlapping pages or a hand-edited file no longer double-count.
- An `http://` N8N_BASE_URL on a non-local host is refused (the key would travel in cleartext) unless `--allow-http` is passed.
- Config ranges: `hourlyRate` 0 to 10000 and finite, `minutesSavedPerSuccessfulRun` 0 to 600.
- `truncated` is set only when more pages exist and the newest-first listing is still inside the window.
- A 200 response that is not JSON (for example a login page) fails at once with a clear message and is not retried.
- Warning when a configured workflow has 0 runs in the week. The offline line prints the file name only. README documents that `--demo` ignores `--end`, `--config` and `--from-file`.

- Security: API requests no longer follow redirects, so `X-N8N-API-KEY` cannot be forwarded to another host. A redirect now fails with a clear message. Covered by a two-server regression test.
- Network errors now print the host and cause (for example `Cannot reach https://host (ECONNREFUSED). Check N8N_BASE_URL`), never the key.
- Invalid `--end` and `--month` values exit with code 2.
- Pagination cap: hitting the page limit prints a warning, sets `truncated: true` in `report.json`, and adds a warning to the email and report footer. The n8n workflow Code node does the same when its 20-page cap is hit.
- Recovery counting is now one-to-one and O(n log n): each failure is recovered at most once, and a success recovers at most one failure. Counts can be lower than in 1.0.0 when several failures precede one success.
- Monthly report now shows `notes`, `nextStep` and the AI summary. `--narrative` writes a separate summary for the week and the month.
- New optional `contactName` for the greeting ("Hi Sarah,"; fallback "Hi there,"). Newlines are flattened in the `.md` output.
- `--demo` flag runs on the bundled sample and writes `./retainer-report-demo/`.
- README screenshots and `npm run screenshots`. Groq model name is validated like the Gemini one. Removed dead code. Added `repository` and `homepage`.

## 1.0.0 - 2026-10-25

- CLI `n8n-retainer-report`: reads the n8n public API (`/api/v1/executions`, `/api/v1/workflows`) with cursor pagination, or an offline `--from-file` JSON.
- Per-client `report.config.json`: workflows by id or tag, minutes saved per successful run (user-supplied estimates), hourly rate, recovery window.
- Metrics: runs, success, errors, error rate, auto-recovered, top failing workflows, busiest days, estimated hours saved and value, change vs the previous period.
- Outputs: `weekly-email.md`, `weekly-email.html`, `monthly-report.html` (printable one-pager with inline SVG chart), `report.json`.
- Optional 3-sentence summary via Groq or Gemini free tier (`--narrative`); only aggregates are sent.
- `examples/n8n-workflow.json`: weekly schedule to Gmail draft, built from the same code.
- Only execution metadata is read; payloads are never requested or stored. API keys are redacted from all output.
