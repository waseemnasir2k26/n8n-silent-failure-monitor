"use strict";

const CONTROL = new RegExp(
  "[" +
    [[0, 8], [11, 12], [14, 31], [127, 127], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
      .map(([a, b]) => String.fromCharCode(a) + (b > a ? "-" + String.fromCharCode(b) : ""))
      .join("") +
    "]",
  "g",
);

function clean(v) {
  return String(v == null ? "" : v).replace(CONTROL, "").replace(/[\r\n\t]+/g, " ");
}

function esc(v) {
  return clean(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function walkStrings(value, cb, path = "", depth = 0) {
  if (depth > 14 || value == null) return;
  if (typeof value === "string") {
    cb(value.length > 200000 ? value.slice(0, 200000) : value, path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, cb, `${path}[${i}]`, depth + 1));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      walkStrings(v, cb, path ? `${path}.${k}` : k, depth + 1);
    }
  }
}

module.exports = { clean, esc, walkStrings };
