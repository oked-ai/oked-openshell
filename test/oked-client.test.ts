import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { OkedClient, type ApprovalInput } from "../src/oked-client.js";
import { GOOD_KEY, startMockOked, type MockOked } from "./mock-oked.js";

let mock: MockOked;
let client: OkedClient;

before(async () => {
  mock = await startMockOked();
  client = new OkedClient({ apiUrl: mock.url, requireReceipt: true, maxWaitMs: 10_000, receiptKeys: mock.keys });
});
after(() => mock.close());
beforeEach(() => {
  mock.mode = "normal";
  mock.delayMs = 0;
});

let n = 0;
function input(): ApprovalInput {
  n++;
  const hash = n.toString(16).padStart(64, "0");
  return {
    operation: "github.pulls.merge",
    summary: "Merge PR #42 'Fix login' into main in acme/web",
    tier: "high_stakes",
    requestHash: hash,
    fields: { Title: "Merge PR #42 'Fix login' into main in acme/web", Target: "acme/web#42", RequestHash: hash },
    metadata: { origin: "openshell", requestHash: hash, sandboxId: "sbx-1", scope: "once" },
  };
}

test("approve: creates the approval, finds its ID, verifies the receipt", async () => {
  const created: (string | null)[] = [];
  const inp = input();
  const p = client.requestApproval(GOOD_KEY, inp, (id) => created.push(id));
  await mock.waitForApprovals(mock.approvals.length + 1);
  const a = mock.approvals.at(-1)!;
  // What OKed gets: our tier, no tool_input, the request hash as the nonce.
  assert.equal(a.body.action, "github.pulls.merge");
  assert.equal(a.body.tier, "high_stakes");
  assert.equal(a.body.nonce, inp.requestHash);
  assert.equal(a.body.metadata.source, "openshell");
  assert.equal(a.body.metadata.tool_input, undefined);
  assert.equal(a.body.client, "oked-openshell/0.1.0");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(created, [null, a.id]);
  mock.decide(a.id, "approved");
  const out = await p;
  assert.equal(out.kind, "decided");
  if (out.kind !== "decided") return;
  assert.deepEqual([out.approvalId, out.decision], [a.id, "approved"]);
  assert.match(out.receiptId!, /^rcpt_/);
});

test("denied and timed out decisions", async () => {
  for (const d of ["denied", "timed_out"] as const) {
    const p = client.requestApproval(GOOD_KEY, input(), () => {});
    await mock.waitForApprovals(mock.approvals.length + 1);
    mock.decide(mock.approvals.at(-1)!.id, d);
    const out = await p;
    assert.deepEqual(out.kind === "decided" && out.decision, d);
  }
});

test("an approval with a bad receipt never counts", async () => {
  mock.mode = "bad_receipt";
  const p = client.requestApproval(GOOD_KEY, input(), () => {});
  await mock.waitForApprovals(mock.approvals.length + 1);
  mock.decide(mock.approvals.at(-1)!.id, "approved");
  const out = await p;
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.permanent, true);
});

test("bad API key is permanent, 429 and 500 are transient, no server is transient", async () => {
  const bad = await client.requestApproval("wrong-key", input(), () => assert.fail("not created"));
  assert.deepEqual(bad.kind === "failed" && [bad.permanent, bad.status], [true, 401]);
  mock.mode = "429";
  const busy = await client.requestApproval(GOOD_KEY, input(), () => {});
  assert.deepEqual(busy.kind === "failed" && [busy.permanent, busy.status], [false, 429]);
  mock.mode = "500";
  const down = await client.requestApproval(GOOD_KEY, input(), () => {});
  assert.deepEqual(down.kind === "failed" && [down.permanent, down.status], [false, 500]);
  const none = new OkedClient({ apiUrl: "http://127.0.0.1:1", requireReceipt: true, maxWaitMs: 2000 });
  const gone = await none.requestApproval(GOOD_KEY, input(), () => {});
  assert.deepEqual(gone.kind === "failed" && [gone.permanent, gone.status], [false, null]);
});

test("the connection breaks after OKed created the approval: lost, with the ID", async () => {
  mock.mode = "drop_after_headers";
  const out = await client.requestApproval(GOOD_KEY, input(), () => {});
  assert.equal(out.kind, "lost");
  assert.equal(out.kind === "lost" && out.approvalId, mock.approvals.at(-1)!.id);
});

test("status read by approval ID: pending, then decided with a verified receipt", async () => {
  mock.mode = "drop_after_headers";
  const inp = input();
  const out = await client.requestApproval(GOOD_KEY, inp, () => {});
  const id = out.kind === "lost" ? out.approvalId! : assert.fail("expected lost");
  mock.mode = "normal";
  assert.deepEqual(await client.status(GOOD_KEY, id, inp, 1000), { status: "pending" });
  mock.decide(id, "approved");
  const s = await client.status(GOOD_KEY, id, inp, 1000);
  assert.equal(s.status, "approved");
  assert.match((s as { receiptId: string }).receiptId, /^rcpt_/);
});

test("status check times out", async () => {
  mock.delayMs = 300;
  await assert.rejects(client.status(GOOD_KEY, "00000000-0000-4000-8000-00000000abcd", input(), 100), /TimeoutError|aborted/i);
});
