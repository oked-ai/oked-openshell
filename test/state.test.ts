import { test } from "node:test";
import assert from "node:assert/strict";
import { REASON_CODES } from "../src/reason-codes.js";
import { RetryState } from "../src/retry/state.js";

const MIN = 60_000;

function setup() {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const state = new RetryState({
    pendingWindowMs: 10 * MIN,
    grantValidMs: 5 * MIN,
    entryTtlMs: 30 * MIN,
    now: () => t,
  });
  return { state, clock };
}

test("new hash: deny with pending, create one approval", () => {
  const { state } = setup();
  const v = state.evaluate("h1");
  assert.equal(v.decision, "deny");
  assert.equal(v.reasonCode, REASON_CODES.pending);
  assert.equal(v.isNew, true);
  assert.equal(v.retryOf, null);
});

test("pending: deny with pending, no second approval", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markCreated("h1", "appr-1", true);
  clock.advance(MIN);
  const v = state.evaluate("h1");
  assert.deepEqual([v.decision, v.reasonCode, v.isNew, v.retryOf, v.needsStatusCheck], ["deny", REASON_CODES.pending, false, "appr-1", false]);
});

test("approved: allow once, then a repeat needs a new approval", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markCreated("h1", "appr-1", true);
  state.markDecided("h1", "approved", { receiptId: "rcpt_1" });
  clock.advance(MIN);
  const allow = state.evaluate("h1");
  assert.deepEqual([allow.decision, allow.reasonCode, allow.retryOf], ["allow", null, "appr-1"]);
  assert.equal(allow.entry.used, true);
  assert.equal(allow.entry.receiptId, "rcpt_1");

  const again = state.evaluate("h1");
  assert.deepEqual([again.decision, again.reasonCode, again.isNew, again.retryOf], ["deny", REASON_CODES.pending, true, "appr-1"]);
  assert.equal(state.get("h1")!.approvalId, null);
});

test("an approval for one hash never allows another hash", () => {
  const { state } = setup();
  state.evaluate("h1");
  state.markDecided("h1", "approved", { approvalId: "appr-1" });
  const other = state.evaluate("h2");
  assert.deepEqual([other.decision, other.isNew], ["deny", true]);
});

test("an approved grant expires 5 minutes after the decision", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markDecided("h1", "approved", { approvalId: "appr-1" });
  clock.advance(5 * MIN + 1);
  const v = state.evaluate("h1");
  assert.deepEqual([v.decision, v.isNew], ["deny", true]);
});

test("denied: deny with the denied code on every retry", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markCreated("h1", "appr-1", true);
  state.markDecided("h1", "denied");
  for (let i = 0; i < 3; i++) {
    clock.advance(MIN);
    const v = state.evaluate("h1");
    assert.deepEqual([v.decision, v.reasonCode, v.isNew], ["deny", REASON_CODES.denied, false]);
  }
});

test("timed out: OKed timeout, and a local timeout at 10 minutes", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markDecided("h1", "timed_out");
  assert.equal(state.evaluate("h1").reasonCode, REASON_CODES.timedOut);

  state.evaluate("h2");
  state.markCreated("h2", "appr-2", true);
  clock.advance(10 * MIN - 1);
  assert.equal(state.evaluate("h2").reasonCode, REASON_CODES.pending);
  clock.advance(1);
  const v = state.evaluate("h2");
  assert.deepEqual([v.reasonCode, v.entry.status], [REASON_CODES.timedOut, "timed_out"]);
  assert.equal(state.evaluate("h2").reasonCode, REASON_CODES.timedOut);
});

test("a late approval replaces a local timeout", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markCreated("h1", "appr-1", true);
  clock.advance(10 * MIN);
  assert.equal(state.evaluate("h1").reasonCode, REASON_CODES.timedOut);
  state.markDecided("h1", "approved", { receiptId: "r" });
  assert.equal(state.evaluate("h1").decision, "allow");
});

test("expiry: entries are dropped 30 minutes after creation", () => {
  const { state, clock } = setup();
  state.evaluate("h1");
  state.markDecided("h1", "denied", { approvalId: "appr-1" });
  clock.advance(30 * MIN);
  const v = state.evaluate("h1");
  assert.deepEqual([v.reasonCode, v.isNew], [REASON_CODES.pending, true]);
  assert.equal(state.size, 1);
});

test("nobody watches a pending approval: the retry asks for a status check", () => {
  const { state } = setup();
  state.evaluate("h1");
  state.markCreated("h1", "appr-1", true);
  state.markWatching("h1", false);
  const v = state.evaluate("h1");
  assert.deepEqual([v.reasonCode, v.needsStatusCheck], [REASON_CODES.pending, true]);
});

test("failed: a transient failure creates a new approval, a permanent one gives the unavailable code", () => {
  const { state } = setup();
  state.evaluate("h1");
  state.markFailed("h1", false);
  const retry = state.evaluate("h1");
  assert.deepEqual([retry.reasonCode, retry.isNew], [REASON_CODES.pending, true]);

  state.markFailed("h1", true);
  const blocked = state.evaluate("h1");
  assert.deepEqual([blocked.decision, blocked.reasonCode, blocked.isNew], ["deny", REASON_CODES.unavailable, false]);
  assert.equal(state.get("h1"), undefined);
});

test("a decision for an unknown or replaced entry changes nothing", () => {
  const { state } = setup();
  state.markDecided("nope", "approved");
  assert.equal(state.size, 0);
  state.evaluate("h1");
  state.markDecided("h1", "denied");
  state.markDecided("h1", "approved");
  assert.equal(state.get("h1")!.status, "denied");
});
