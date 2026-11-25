'use strict';
const { normalizeExecution, DAY } = require('../src/core');

const T0 = Date.UTC(2026, 9, 12); // 2026-10-12 00:00 UTC (a Monday)
const at = (days, minutes = 0) => new Date(T0 + days * DAY + minutes * 60000).toISOString();
function ex(id, wf, status, days, minutes = 0) {
  return normalizeExecution({ id, workflowId: wf, status, startedAt: at(days, minutes), stoppedAt: at(days, minutes + 1) });
}
// Fake fetch that serves pages keyed by cursor and records calls.
function pagedFetch(pages, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const cursor = new URL(url).searchParams.get('cursor') || '';
    const p = pages[cursor];
    return { ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) };
  };
}
module.exports = { T0, at, ex, pagedFetch };
