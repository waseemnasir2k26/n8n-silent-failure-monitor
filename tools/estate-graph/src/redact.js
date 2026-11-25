"use strict";
// --redact-all: replace every client-identifying value with a short stable hash
// (sha256, first 8 hex chars, prefixed by kind, e.g. cred#a1b2c3d4). The same input
// always gives the same hash, so two workflows that share a credential still share
// a node. Instance labels (the client names you typed) and credential TYPES
// (googleSheetsOAuth2Api) are kept: they are yours, and they keep the report useful.
const crypto = require("node:crypto");

const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const HASHED = /^[a-z]+#[0-9a-f]{8}$/;

function h(kind, value) {
  const d = crypto.createHash("sha256").update(String(value)).digest("hex");
  return `${kind}#${d.slice(0, 8)}`;
}

/** First 4 chars + short hash. Already-hashed paths are left alone. */
function maskPath(p) {
  p = String(p);
  if (!p || HASHED.test(p)) return p;
  return `${p.slice(0, 4)}***#${h("p", p).slice(2)}`;
}

function stripEmails(s) {
  return String(s).replace(EMAIL, (m) => h("email", m.toLowerCase()));
}

function redactGraph(g) {
  const idMap = new Map();
  const nodes = g.nodes.map((n) => {
    const a = n.attrs || {};
    const attrs = { ...a };
    let label = n.label;
    let id;
    switch (n.type) {
      case "workflow":
        id = h("wf", n.id);
        label = h("wf", n.label);
        if (a.n8nId) attrs.n8nId = h("wf", a.n8nId);
        if (a.errorWorkflow) attrs.errorWorkflow = h("wf", a.errorWorkflow);
        break;
      case "credential":
        id = h("cred", n.id);
        label = h("cred", n.label);
        if (a.n8nId) attrs.n8nId = h("cred", a.n8nId);
        break;
      case "webhook": {
        id = h("hook", n.id);
        const p = a.path === "dynamic-expression" ? a.path : h("hook", a.path);
        attrs.path = p;
        label = `${a.method} /${p}`;
        break;
      }
      case "host":
        if (n.label !== "dynamic-expression") {
          id = h("host", n.id);
          label = h("host", n.label);
        } else id = n.id;
        break;
      case "sheet":
        id = h("sheet", n.id);
        label = h("sheet", n.label);
        if (a.documentId) attrs.documentId = h("doc", a.documentId);
        if (Array.isArray(a.sheetNames))
          attrs.sheetNames = a.sheetNames.map((t) => h("tab", t));
        break;
      default:
        id = n.id;
    }
    idMap.set(n.id, id);
    for (const [k, v] of Object.entries(attrs))
      if (typeof v === "string") attrs[k] = stripEmails(v);
      else if (Array.isArray(v))
        attrs[k] = v.map((x) => (typeof x === "string" ? stripEmails(x) : x));
    return { id, type: n.type, label: stripEmails(label), attrs };
  });
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  nodes.sort((a, b) => cmp(a.id, b.id));
  const links = g.links
    .map((l) => ({
      source: idMap.get(l.source) || l.source,
      target: idMap.get(l.target) || l.target,
      rel: l.rel,
    }))
    .sort(
      (a, b) =>
        cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.rel, b.rel),
    );
  const meta = {
    ...g.meta,
    redacted: true,
    sources: (g.meta.sources || []).map((s) => ({
      ...s,
      ...(s.host ? { host: h("host", s.host) } : {}),
    })),
  };
  return { graph: { meta, nodes, links }, idMap };
}

module.exports = { redactGraph, maskPath, stripEmails, h };
