"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Pull workflow objects out of any supported JSON shape. */
function extractWorkflows(json) {
  if (Array.isArray(json)) return json.flatMap(extractWorkflows);
  if (!json || typeof json !== "object") return [];
  if (json.meta && json.meta.tool === "n8n-estate-graph") return []; // our own graph.json
  if (Array.isArray(json.nodes)) return [json];
  if (Array.isArray(json.data)) return json.data.flatMap(extractWorkflows); // API page
  if (Array.isArray(json.workflows))
    return json.workflows.flatMap(extractWorkflows);
  if (
    json.data &&
    typeof json.data === "object" &&
    Array.isArray(json.data.nodes)
  )
    return [json.data];
  return [];
}

function listJson(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      throw new Error(`Cannot read directory: ${dir}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.json$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** @returns {{workflows:object[], files:number, skipped:number}} */
function loadDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    throw new Error(`Not a directory: ${dir}`);
  const workflows = [];
  const entries = [];
  let files = 0;
  let skipped = 0;
  const skippedFiles = [];
  const skip = (f) => {
    skipped++;
    skippedFiles.push(path.relative(dir, f).split(path.sep).join("/"));
  };
  for (const f of listJson(dir)) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
    } catch {
      files++;
      skip(f);
      continue;
    }
    if (json && json.meta && json.meta.tool === "n8n-estate-graph") continue; // our own output
    files++;
    const w = extractWorkflows(json);
    if (!w.length) skip(f);
    workflows.push(...w);
    for (const wf of w) entries.push({ wf, file: f });
  }
  return { workflows, entries, files, skipped, skippedFiles };
}

module.exports = { extractWorkflows, loadDir };
