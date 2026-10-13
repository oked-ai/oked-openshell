import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approverGroup, parseConfig } from "../src/config.js";

const SPEC_EXAMPLE = `
oked:
  api_url: https://api.oked.ai
  api_key_env: OKED_API_KEY
github:
  read_token_env: OKED_GITHUB_READ_TOKEN
approval:
  pending_window_minutes: 10
  grant_valid_minutes: 5
  status_check_timeout_ms: 1000
approvers:
  default: core-team
  sandboxes:
    spike: core-team
rules: []
`;

test("the spec example config is valid, with defaults", () => {
  const { config, secrets } = parseConfig(SPEC_EXAMPLE, { OKED_API_KEY: "k1", OKED_GITHUB_READ_TOKEN: "t" });
  assert.equal(config.name, "oked-approval");
  assert.equal(config.listen, "127.0.0.1:50052");
  assert.equal(config.oked.require_receipt, true);
  assert.equal(config.github.lookup_timeout_ms, 2000);
  assert.equal(secrets.okedKeys.get("core-team"), "k1");
  assert.equal(secrets.githubToken, "t");
  assert.ok(!JSON.stringify(config).includes("k1"), "secrets stay out of the config object");
});

test("the demo config is valid", () => {
  const text = readFileSync(new URL("../examples/github-demo/oked-openshell.yaml", import.meta.url), "utf8");
  parseConfig(text, { OKED_API_KEY: "k" });
});

test("no GitHub token: enrichment off, still valid", () => {
  assert.equal(parseConfig(SPEC_EXAMPLE, { OKED_API_KEY: "k" }).secrets.githubToken, null);
});

test("invalid config refuses to start", () => {
  const env = { OKED_API_KEY: "k" };
  const bad = [
    "approvers: {}",
    "approvers: { default: g }\nunknown_key: 1",
    "approvers: { default: g }\nrules: [{ name: r, tier: urgent, host: x }]",
    "approvers: { default: g }\nrules: [{ name: r, tier: review }]",
    "approvers: { default: g }\nrules: [{ name: r, tier: review, path: '(' }]",
    "approvers: { default: g }\nrules: [{ name: r, tier: review, when: [{ field: a, op: in, value: x }] }]",
    "approvers: { default: g }\nrules: [{ name: r, tier: review, when: [{ field: a, op: gt, value: x }] }]",
    "approvers: { default: g }\nrules: [{ name: r, tier: review, when: [{ field: a, op: regex, value: '[' }] }]",
    "approvers: { default: g }\napproval: { pending_window_minutes: 30, grant_valid_minutes: 5 }",
    "approvers: { default: g }\nlisten: nope",
  ];
  for (const text of bad) assert.throws(() => parseConfig(text, env), /invalid config/, text);
});

test("a missing OKed API key refuses to start", () => {
  assert.throws(() => parseConfig(SPEC_EXAMPLE, {}), /needs the OKed API key in \$OKED_API_KEY/);
  assert.throws(
    () => parseConfig("approvers: { default: a, sandboxes: { s: b }, groups: { b: { api_key_env: KEY_B } } }", { OKED_API_KEY: "k" }),
    /group "b".*KEY_B/,
  );
});

test("routing: sandbox_id wins over name, else the default group", () => {
  const { config, secrets } = parseConfig(
    `approvers:
  default: core-team
  sandboxes:
    spike: core-team
    400e804a-b9e4-4faa-a5f1-a5dbe5f4c9cf: release-team
  groups:
    release-team: { api_key_env: OKED_RELEASE_KEY }
`,
    { OKED_API_KEY: "core", OKED_RELEASE_KEY: "release" },
  );
  assert.equal(approverGroup(config, "400e804a-b9e4-4faa-a5f1-a5dbe5f4c9cf", "spike"), "release-team");
  assert.equal(approverGroup(config, "other-id", "spike"), "core-team");
  assert.equal(approverGroup(config, "other-id", "other"), "core-team");
  assert.equal(secrets.okedKeys.get("release-team"), "release");
  assert.equal(secrets.okedKeys.get("core-team"), "core");
});
