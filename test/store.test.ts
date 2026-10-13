import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REASON_CODES } from "../src/reason-codes.js";
import { RetryState, type Entry, type StateStore } from "../src/retry/state.js";
import { expandHome, FileStore } from "../src/retry/store.js";

const dir = mkdtempSync(join(tmpdir(), "oked-store-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

function state(store: StateStore, now: () => number) {
  return new RetryState({ pendingWindowMs: 10 * MIN, grantValidMs: 5 * MIN, entryTtlMs: 30 * MIN, now, store });
}

test("file store: round trip, mode 600, no runtime-only fields", () => {
  const path = join(dir, "sub", "state.json");
  const t = 1_000_000;
  const s1 = state(new FileStore(path), () => t);
  s1.evaluate(H1);
  s1.markCreated(H1, "appr-1", true);
  s1.setContext(H1, { group: "core-team", input: { operation: "github.pulls.merge" } });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries[0].watching, undefined);
  assert.equal(raw.entries[0].context.group, "core-team");

  const s2 = state(new FileStore(path), () => t + MIN);
  const e = s2.get(H1)!;
  assert.deepEqual([e.status, e.approvalId, e.watching], ["pending", "appr-1", false]);
  // Nobody watches it after the restart: the retry asks for a status check.
  const v = s2.evaluate(H1);
  assert.deepEqual([v.reasonCode, v.needsStatusCheck, v.isNew], [REASON_CODES.pending, true, false]);
});

test("restore: a pending entry with no approval ID gets a new approval", () => {
  const path = join(dir, "no-id.json");
  const s1 = state(new FileStore(path), () => 0);
  s1.evaluate(H2); // denied with pending, approval not created yet
  const s2 = state(new FileStore(path), () => 1000);
  const v = s2.evaluate(H2);
  assert.deepEqual([v.reasonCode, v.isNew], [REASON_CODES.pending, true]);
});

test("restore: used approvals stay used, expired entries are dropped", () => {
  const path = join(dir, "used.json");
  let t = 0;
  const s1 = state(new FileStore(path), () => t);
  s1.evaluate(H1);
  s1.markDecided(H1, "approved", { approvalId: "appr-1" });
  assert.equal(s1.evaluate(H1).decision, "allow");
  s1.evaluate(H3);
  s1.markDecided(H3, "denied", { approvalId: "appr-3" });

  t = MIN;
  const s2 = state(new FileStore(path), () => t);
  const again = s2.evaluate(H1);
  assert.deepEqual([again.decision, again.isNew, again.retryOf], ["deny", true, "appr-1"]);
  assert.equal(s2.evaluate(H3).reasonCode, REASON_CODES.denied);

  t = 31 * MIN;
  const s3 = state(new FileStore(path), () => t);
  assert.equal(s3.get(H3), undefined);
});

test("a corrupt or foreign file is an empty state plus an error event", () => {
  const path = join(dir, "bad.json");
  const errors: unknown[] = [];
  writeFileSync(path, "{not json");
  assert.deepEqual(new FileStore(path, (e) => errors.push(e)).load(), []);
  writeFileSync(path, JSON.stringify({ version: 2, entries: [] }));
  assert.deepEqual(new FileStore(path, (e) => errors.push(e)).load(), []);
  assert.equal(errors.length, 2);
  assert.ok(!JSON.stringify(errors).includes("not json"), "errors never carry file contents");
  assert.deepEqual(new FileStore(join(dir, "missing.json"), (e) => errors.push(e)).load(), []);
  assert.equal(errors.length, 2, "a missing file is not an error");
});

test("a write problem is reported, and the state keeps working in memory", () => {
  const errors: { op: string }[] = [];
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  const s = state(new FileStore(join(blocker, "state.json"), (e) => errors.push(e)), () => 0);
  assert.equal(s.evaluate(H1).isNew, true);
  assert.ok(errors.some((e) => e.op === "save"));
  assert.equal(s.evaluate(H1).isNew, false);
});

test("detach stops saving", () => {
  const saved: Entry[][] = [];
  const s = state({ load: () => [], save: (e) => saved.push(e) }, () => 0);
  s.evaluate(H1);
  const n = saved.length;
  s.detach();
  s.markDecided(H1, "approved", { approvalId: "x" });
  assert.equal(saved.length, n);
});

test("expandHome", () => {
  assert.ok(!expandHome("~/x").startsWith("~"));
  assert.equal(expandHome("/abs/x"), "/abs/x");
});
