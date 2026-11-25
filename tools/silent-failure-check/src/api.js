"use strict";
// Read-only calls to the n8n public API. Auth header is X-N8N-API-KEY.
//   GET /api/v1/workflows?limit=&cursor=            -> { data: [workflow], nextCursor }
//   GET /api/v1/executions?workflowId=&limit=&cursor=&includeData=false -> { data: [execution], nextCursor }
// Only GET is ever sent. The key is never written to output or error text.

function cleanBase(url) {
  let u = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  u = u.replace(/\/api\/v1$/, "");
  if (!/^https?:\/\//i.test(u))
    throw new Error("base URL must start with http:// or https://");
  return u;
}

async function getJson(base, key, path, params, timeoutMs = 20000) {
  const url = new URL(`${base}/api/v1${path}`);
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-N8N-API-KEY": key, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok)
    throw new Error(
      `n8n API answered ${res.status} for ${path}${res.status === 401 ? " (check the API key)" : ""}`,
    );
  return res.json();
}

async function listWorkflows(base, key, maxPages = 40) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const j = await getJson(base, key, "/workflows", { limit: 250, cursor });
    out.push(...(j.data || []));
    cursor = j.nextCursor;
    if (!cursor) return out;
  }
  throw new Error(
    `more than ${maxPages * 250} workflows; stopped to stay polite`,
  );
}

// Newest first; one page is enough because only the latest runs matter.
async function listExecutions(base, key, workflowId, limit = 50) {
  const j = await getJson(base, key, "/executions", {
    workflowId,
    limit,
    includeData: "false",
  });
  return j.data || [];
}

async function fetchInstance({ url, key, concurrency = 4, onlyIds }) {
  const base = cleanBase(url);
  const workflows = await listWorkflows(base, key);
  const executions = {};
  const need = workflows.filter((w) => !onlyIds || onlyIds(w));
  let i = 0;
  async function worker() {
    while (i < need.length) {
      const w = need[i++];
      executions[String(w.id)] = await listExecutions(base, key, w.id);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, need.length) }, worker),
  );
  return { workflows, executions };
}

module.exports = { fetchInstance, cleanBase, listWorkflows, listExecutions };
