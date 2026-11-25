"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { redact, secretsFromEnv } = require("../src/redact");

test("redacts keys and header echoes", () => {
  const s = redact(
    'x supersecret1 y X-N8N-API-KEY: abc123def "x-n8n-api-key":"zzz999"',
    ["supersecret1"],
  );
  assert.ok(!s.includes("supersecret1"));
  assert.ok(!s.includes("abc123def"));
  assert.ok(!s.includes("zzz999"));
});

test("short or empty secrets are ignored safely", () => {
  assert.equal(redact("abc", ["", "a", undefined]), "abc");
  assert.deepEqual(secretsFromEnv({ N8N_API_KEY: "k", OTHER: "x" }), ["k"]);
});
