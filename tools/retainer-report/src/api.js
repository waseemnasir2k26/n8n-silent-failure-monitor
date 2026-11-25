"use strict";
const { redact } = require("./redact");
const { normalizeExecution } = require("./core");
const { ConfigError } = require("./config");

function isLoopback(host) {
  return host === "localhost" || host === "[::1]" || host.startsWith("127.");
}

function cleanBase(url, allowHttp) {
  if (!url) throw new Error("N8N_BASE_URL is not set");
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("N8N_BASE_URL is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("N8N_BASE_URL must be http(s)");
  if (u.protocol === "http:" && !allowHttp && !isLoopback(u.hostname))
    throw new ConfigError(
      "N8N_BASE_URL uses http:// on a non-local host (" + u.hostname + "), so the API key would be sent in cleartext. Use https://, or pass --allow-http if you accept that.",
    );
  return u.origin + u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

async function getJson({
  base,
  path,
  params,
  apiKey,
  fetchImpl,
  retries,
  retryDelayMs,
}) {
  const url = new URL(base + "/api/v1" + path);
  for (const [k, v] of Object.entries(params || {}))
    if (v != null) url.searchParams.set(k, String(v));
  const secrets = [apiKey];
  const origin = url.origin;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url.toString(), {
        headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" },
        // Never follow redirects: a custom header would be forwarded to the redirect target.
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      if (res.status >= 300 && res.status < 400) {
        let where = "another location";
        try {
          const loc =
            res.headers && res.headers.get && res.headers.get("location");
          if (loc) where = new URL(loc, url).origin;
        } catch {
          /* ignore */
        }
        throw Object.assign(
          new Error(
            "n8n API at " +
              origin +
              " redirected (" +
              res.status +
              ") to " +
              where +
              ". Redirects are not followed so the API key is never sent elsewhere. Set N8N_BASE_URL to the final URL.",
          ),
          { fatal: true },
        );
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw Object.assign(
            new ConfigError(
              "N8N_BASE_URL returned HTML, not the n8n API. Check the URL (it should be the instance root, e.g. https://n8n.example.com)",
            ),
            { fatal: true },
          );
        }
      }
      const body = redact((await res.text()).slice(0, 200), secrets);
      lastErr = new Error(
        "n8n API " + res.status + " for " + path + (body ? ": " + body : ""),
      );
      if (res.status !== 429 && res.status < 500)
        throw Object.assign(lastErr, { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
      const cause =
        (e.cause && (e.cause.code || e.cause.message)) || e.name || "error";
      lastErr = new Error(
        redact(
          "Cannot reach " + origin + " (" + cause + "). Check N8N_BASE_URL",
          secrets,
        ),
      );
    }
    if (attempt < retries)
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
  }
  throw lastErr;
}

function opts(o) {
  if (!o.apiKey) throw new Error("N8N_API_KEY is not set");
  return {
    base: cleanBase(o.baseUrl, o.allowHttp),
    apiKey: o.apiKey,
    fetchImpl: o.fetchImpl || globalThis.fetch,
    retries: o.retries == null ? 2 : o.retries,
    retryDelayMs: o.retryDelayMs == null ? 1000 : o.retryDelayMs,
    maxPages: o.maxPages || 200,
  };
}

// Both list functions return { items, truncated }. truncated is true when maxPages was hit
// while more pages were still available.
async function listWorkflows(o) {
  const c = opts(o);
  const items = [];
  let cursor;
  let truncated = false;
  for (let page = 0; page < c.maxPages; page++) {
    const j = await getJson({
      ...c,
      path: "/workflows",
      params: { limit: 250, cursor },
    });
    for (const w of j.data || []) {
      items.push({
        id: String(w.id),
        name: String(w.name || ""),
        tags: (w.tags || []).map((t) =>
          typeof t === "string" ? { name: t } : { id: t.id, name: t.name },
        ),
      });
    }
    cursor = j.nextCursor;
    if (!cursor) break;
    if (page === c.maxPages - 1) truncated = true;
  }
  return { items, truncated };
}

// Newest first. Stops once a page reaches executions older than stopBeforeMs.
// includeData is always false: payloads are never requested.
async function listExecutions(o) {
  const c = opts(o);
  const items = [];
  let cursor;
  let truncated = false;
  for (let page = 0; page < c.maxPages; page++) {
    const j = await getJson({
      ...c,
      path: "/executions",
      params: {
        limit: 250,
        cursor,
        workflowId: o.workflowId,
        includeData: "false",
      },
    });
    let reachedOld = false;
    let last = null;
    for (const raw of j.data || []) {
      const e = normalizeExecution(raw);
      if (!e) continue;
      items.push(e);
      last = e;
      if (o.stopBeforeMs != null && e.startMs < o.stopBeforeMs)
        reachedOld = true;
    }
    cursor = j.nextCursor;
    if (!cursor || reachedOld) break;
    // truncated only if more pages exist AND the newest-first listing is still inside the window
    const inWindow = !last || o.stopBeforeMs == null || last.startMs >= o.stopBeforeMs;
    if (page === c.maxPages - 1 && inWindow) truncated = true;
  }
  return { items, truncated };
}

module.exports = { listWorkflows, listExecutions, cleanBase };
