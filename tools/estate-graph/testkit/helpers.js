"use strict";
let seq = 0;

function node(type, name, parameters = {}, credentials) {
  return {
    id: `n${++seq}`,
    name,
    type,
    typeVersion: 1,
    position: [0, 0],
    parameters,
    ...(credentials ? { credentials } : {}),
  };
}

function wf(id, name, nodes, extra = {}) {
  const { active = true, errorWorkflow } = extra;
  return {
    id,
    name,
    active,
    nodes,
    connections: {},
    settings: errorWorkflow ? { errorWorkflow } : {},
  };
}

const call = (id, name) =>
  node("n8n-nodes-base.executeWorkflow", `call ${name}`, {
    source: "database",
    workflowId: { __rl: true, value: id, mode: "list", cachedResultName: name },
  });
const trigger = () =>
  node("n8n-nodes-base.executeWorkflowTrigger", "When called");
const http = (url) => node("n8n-nodes-base.httpRequest", "HTTP", { url });
const cred = (type, id, name) => ({ [type]: { id, name } });

function items(instance, ...wfs) {
  return wfs.map((w) => ({ instance, wf: w }));
}

// Small deterministic PRNG for the fuzz test.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

module.exports = { node, wf, call, trigger, http, cred, items, prng };
