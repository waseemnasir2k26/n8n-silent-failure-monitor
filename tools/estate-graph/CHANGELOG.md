# Changelog

## 1.0.3 - 2026-11-05

- New `--redact-all` (build, blast, spof): credential names/ids, workflow names/ids, documentIds, sheet and tab names, webhook paths, hostnames and any email become short stable hashes.
- Custom webhook paths in `spof` and the reports are masked (first 4 chars + hash) unless `--show-paths`.
- README: removed the "safe by construction" overstatement; added "Before you share the output" listing exactly what is retained.
- `blast` exits 4 when nothing matches. `--date` rejects impossible dates (2026-13-99).
- API error messages name `--instance` instead of N8N_BASE_URL. README claims about related tools corrected; report screenshot added.

## 1.0.2 - 2026-11-05

- One shared scrub (`src/scrub.js`) runs as the last step of every build and every `--graph` load, so no output path (graph.json, report.html, report.md, blast, spof, `--json`) can skip it.
- Random-looking tokens are masked inside names, sheet names and Airtable names, including digit-free mixed-case tokens and UUIDs. Webhook paths keep their human segments; random segments show as `{random}`. Random subdomain labels are hidden.
- Webhook node ids no longer contain the raw path (for auth none, the path is the secret).
- Credential and trigger type names (googleDriveOAuth2Api and similar) are kept as identifiers and never masked.
- Files that are not n8n workflow JSON are reported on stderr and counted in `meta.inputFiles`; the tool's own graph.json is ignored when it sits inside an input folder.

## 1.0.1 - 2026-11-02

- Without `--label`, each first-level subfolder of a `--from-dir` is its own client (loose files keep the folder name). Explicit `--label` still wins.
- README: real clone URL, graphify link.

## 1.0.0

- Build a dependency graph (graph.json, report.html, report.md) from exported workflow JSON or a live n8n instance (GET only).
- `blast` command: what breaks if a credential, host, sheet, workflow or env var dies, including callers up the sub-workflow chain.
- `spof` command: shared credentials, shared hosts, workflows with no error workflow, open webhooks, heavily called sub-workflows.
- Redaction by construction: only an allow-list of fields is read, URLs are reduced to hostnames, sticky notes are ignored.
