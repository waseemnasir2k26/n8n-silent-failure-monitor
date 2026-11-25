'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/api');
const { cleanBase } = api;
// the library returns { items, truncated }; most tests only care about the items
const listExecutions = async (o) => (await api.listExecutions(o)).items;
const listWorkflows = async (o) => (await api.listWorkflows(o)).items;
const { pagedFetch } = require('./helpers');

const row = (id, started, extra = {}) => ({ id, workflowId: '5', status: 'success', startedAt: started, stoppedAt: started, ...extra });

test('paginates with cursor and sends the API key header', async () => {
  const calls = [];
  const fetchImpl = pagedFetch({
    '': { data: [row(1, '2026-10-12T10:00:00Z')], nextCursor: 'c2' },
    c2: { data: [row(2, '2026-10-11T10:00:00Z')], nextCursor: 'c3' },
    c3: { data: [row(3, '2026-10-10T10:00:00Z')], nextCursor: null },
  }, calls);
  const out = await listExecutions({ baseUrl: 'https://n8n.example.com/', apiKey: 'k-12345', fetchImpl, workflowId: '5' });
  assert.deepEqual(out.map((e) => e.id), ['1', '2', '3']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers['X-N8N-API-KEY'], 'k-12345');
  const u = new URL(calls[1].url);
  assert.equal(u.pathname, '/api/v1/executions');
  assert.equal(u.searchParams.get('cursor'), 'c2');
  assert.equal(u.searchParams.get('includeData'), 'false');
  assert.equal(u.searchParams.get('workflowId'), '5');
});

test('stops paging once executions are older than the needed window', async () => {
  const calls = [];
  const fetchImpl = pagedFetch({
    '': { data: [row(1, '2026-10-12T10:00:00Z')], nextCursor: 'c2' },
    c2: { data: [row(2, '2026-01-01T10:00:00Z')], nextCursor: 'c3' },
    c3: { data: [row(3, '2025-01-01T10:00:00Z')], nextCursor: null },
  }, calls);
  const out = await listExecutions({ baseUrl: 'https://n8n.example.com', apiKey: 'k-12345', fetchImpl, stopBeforeMs: Date.parse('2026-09-01') });
  assert.equal(calls.length, 2);
  assert.equal(out.length, 2);
});

test('payload fields are dropped, only metadata is kept', async () => {
  const calls = [];
  const fetchImpl = pagedFetch({
    '': { data: [row(1, '2026-10-12T10:00:00Z', { data: { secret: 'customer@example.com' }, workflowData: { nodes: [] } })], nextCursor: null },
  }, calls);
  const [e] = await listExecutions({ baseUrl: 'https://n8n.example.com', apiKey: 'k-12345', fetchImpl });
  assert.deepEqual(Object.keys(e).sort(), ['id', 'startMs', 'startedAt', 'status', 'stoppedAt', 'workflowId']);
  assert.ok(!JSON.stringify(e).includes('customer@example.com'));
});

test('workflows are paginated and tags normalised', async () => {
  const calls = [];
  const fetchImpl = pagedFetch({
    '': { data: [{ id: 'a', name: 'A', tags: [{ id: 't', name: 'acme' }] }], nextCursor: 'n' },
    n: { data: [{ id: 'b', name: 'B' }], nextCursor: null },
  }, calls);
  const wf = await listWorkflows({ baseUrl: 'https://n8n.example.com', apiKey: 'k-12345', fetchImpl });
  assert.equal(wf.length, 2);
  assert.deepEqual(wf[0].tags, [{ id: 't', name: 'acme' }]);
  assert.deepEqual(wf[1].tags, []);
});

test('API key never appears in errors, even when the server echoes it', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key supersecretkey123 / X-N8N-API-KEY: supersecretkey123' });
  await assert.rejects(
    listExecutions({ baseUrl: 'https://n8n.example.com', apiKey: 'supersecretkey123', fetchImpl, retries: 0 }),
    (e) => { assert.ok(!e.message.includes('supersecretkey123')); assert.match(e.message, /401/); return true; },
  );
});

test('network errors are redacted and retried', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; throw new Error('connect failed for key supersecretkey123'); };
  await assert.rejects(
    listExecutions({ baseUrl: 'https://n8n.example.com', apiKey: 'supersecretkey123', fetchImpl, retries: 1, retryDelayMs: 1 }),
    (e) => !e.message.includes('supersecretkey123'),
  );
  assert.equal(n, 2);
});

test('base url handling', () => {
  assert.equal(cleanBase('https://n8n.example.com/api/v1/'), 'https://n8n.example.com');
  assert.equal(cleanBase('http://localhost:5678'), 'http://localhost:5678');
  assert.throws(() => cleanBase('ftp://x'), /http/);
  assert.throws(() => cleanBase(''), /N8N_BASE_URL/);
});
