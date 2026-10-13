// End to end through gRPC: a test client built from the same proto, the real
// pipeline, a mocked OKed API and a mocked GitHub API.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { parseConfig } from "../src/config.js";
import { OkedClient } from "../src/oked-client.js";
import { REASON_CODES } from "../src/reason-codes.js";
import { buildPipeline, createServer, listen, loadProto, middlewareService } from "../src/server.js";
import type { Pipeline } from "../src/pipeline.js";
import { GITHUB_TOKEN, startMockGithub, type MockGithub } from "./mock-github.js";
import { GOOD_KEY, startMockOked, type MockOked } from "./mock-oked.js";

const CONTRACT = "openshell.supervisor-middleware.contract";
const gateway = {
  protocol_version: { major: 1, minor: 0 },
  implementation_name: "openshell/gateway",
  implementation_version: "0.1.2",
  supported_capabilities: [CONTRACT],
  required_capabilities: [CONTRACT],
};

type Svc = { server: grpc.Server; client: any; pipeline: Pipeline; logs: Record<string, any>[] };

const stateDir = mkdtempSync(join(tmpdir(), "oked-openshell-test-"));
let stateCounter = 0;
let oked: MockOked;
let gh: MockGithub;
let svc: Svc;

async function startSvc(opts: { okedUrl?: string; apiKey?: string; statusTimeoutMs?: number; stateFile?: string } = {}): Promise<Svc> {
  const stateFile = opts.stateFile ?? join(stateDir, `state-${++stateCounter}.json`);
  const yaml = `
listen: 127.0.0.1:0
oked: { api_url: "${opts.okedUrl ?? oked.url}" }
github: { api_url: "${gh.url}" }
approval: { status_check_timeout_ms: ${opts.statusTimeoutMs ?? 1000}, state_file: "${stateFile}" }
approvers: { default: core-team, sandboxes: { spike: core-team } }
`;
  const loaded = parseConfig(yaml, { OKED_API_KEY: opts.apiKey ?? GOOD_KEY, OKED_GITHUB_READ_TOKEN: GITHUB_TOKEN });
  const logs: Record<string, any>[] = [];
  const log = (l: Record<string, unknown>) => logs.push(l);
  const client = new OkedClient({
    apiUrl: loaded.config.oked.api_url,
    requireReceipt: true,
    maxWaitMs: 60_000,
    receiptKeys: oked.keys,
  });
  const pipeline = buildPipeline(loaded, log, client);
  const server = createServer(pipeline, loaded.config.name, log);
  const port = await listen(server, "127.0.0.1:0");
  const Client = middlewareService(loadProto());
  return { server, client: new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()), pipeline, logs };
}

async function stopSvc(s: Svc): Promise<void> {
  s.pipeline.close();
  s.client.close();
  s.server.forceShutdown();
}

function call(client: any, method: string, req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](req, { deadline: Date.now() + 10_000 }, (err: grpc.ServiceError | null, res: any) => (err ? reject(err) : resolve(res)));
  });
}

let sandboxCounter = 0;
function evaluation(method: string, path: string, body: unknown = null, sandboxId = "400e804a-b9e4-4faa-a5f1-a5dbe5f4c9cf") {
  return {
    phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS",
    context: { request_id: `req-${++sandboxCounter}`, sandbox_id: sandboxId, sandbox: "spike", workspace: "default" },
    target: { scheme: "https", host: "api.github.com", port: 443, method, path, query: "" },
    headers: [{ name: "content-type", value: "application/x-www-form-urlencoded" }],
    body: body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
    middleware_name: "oked-approval",
  };
}

async function evaluate(s: Svc, req: unknown): Promise<{ res: any; ms: number }> {
  const t0 = performance.now();
  const res = await call(s.client, "EvaluateHttpRequest", req);
  return { res, ms: performance.now() - t0 };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

before(async () => {
  oked = await startMockOked();
  gh = await startMockGithub();
  svc = await startSvc();
});
after(async () => {
  await stopSvc(svc);
  await oked.close();
  await gh.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("Describe returns the manifest; bad gateway metadata fails", async () => {
  const m = await call(svc.client, "Describe", { gateway });
  assert.equal(m.name, "oked-approval");
  assert.equal(m.bindings.length, 1);
  assert.equal(m.bindings[0].operation, "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST");
  assert.equal(m.bindings[0].phase, "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS");
  assert.equal(m.bindings[0].max_payload_bytes, 4194304);
  assert.deepEqual(m.extension.protocol_version, { major: 1, minor: 0 });
  assert.deepEqual(m.extension.supported_capabilities, [CONTRACT]);
  assert.deepEqual(m.extension.required_capabilities, [CONTRACT]);
  await assert.rejects(call(svc.client, "Describe", {}), (e: grpc.ServiceError) => e.code === grpc.status.FAILED_PRECONDITION);
});

test("ValidateConfig accepts no config and rejects a config block", async () => {
  assert.equal((await call(svc.client, "ValidateConfig", { middleware_name: "oked-approval" })).valid, true);
  const r = await call(svc.client, "ValidateConfig", { middleware_name: "oked-approval", config: { fields: { a: { string_value: "b" } } } });
  assert.equal(r.valid, false);
});

test("allow: a read passes at once, with no OKed or GitHub call", async () => {
  const okedCalls = oked.calls.length;
  const ghCalls = gh.calls.length;
  const { res, ms } = await evaluate(svc, evaluation("GET", "/repos/acme/web/issues"));
  assert.equal(res.decision, "DECISION_ALLOW");
  assert.equal(res.reason_code, "");
  assert.ok(ms < 100, `${ms} ms`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(oked.calls.length, okedCalls);
  assert.equal(gh.calls.length, ghCalls, "enrichment never runs on the fast path");
  const line = svc.logs.findLast((l) => l.event === "evaluate")!;
  assert.deepEqual([line.operation, line.tier, line.source, line.decision], ["github.read", "safe", "fast_path", "allow"]);
});

test("warning: a comment passes and is logged as warning", async () => {
  const { res } = await evaluate(svc, evaluation("POST", "/repos/acme/web/issues/1/comments", { body: "hello" }));
  assert.equal(res.decision, "DECISION_ALLOW");
  const line = svc.logs.findLast((l) => l.event === "evaluate")!;
  assert.deepEqual([line.operation, line.tier, line.decision], ["github.issues.comment", "warning", "allow"]);
});

test("merge: deny at once, enrich after the reply, approve, the retry passes once", async () => {
  gh.pulls[42] = { title: "Fix login", base: "main", head: "fix-login" };
  gh.delayMs = 800; // enrichment is slow; the evaluation must not wait for it
  const req = evaluation("PUT", "/repos/acme/web/pulls/42/merge", {});
  const before = oked.approvals.length;

  const first = await evaluate(svc, req);
  assert.equal(first.res.decision, "DECISION_DENY");
  assert.equal(first.res.reason_code, REASON_CODES.pending);
  assert.ok(first.ms < 100, `first evaluation took ${first.ms} ms`);

  await oked.waitForApprovals(before + 1);
  gh.delayMs = 0;
  const a = oked.approvals.at(-1)!;
  assert.equal(a.body.description, "Merge PR #42 'Fix login' into main in acme/web");
  assert.equal(a.body.tier, "high_stakes");
  assert.equal(a.body.fields.Title, "Merge PR #42 'Fix login' into main");
  assert.equal(a.body.fields.Target, "acme/web#42");
  assert.equal(a.body.fields.Footnote, "Sandbox spike · approves this request only");
  assert.equal(a.body.metadata.sandboxId, "400e804a-b9e4-4faa-a5f1-a5dbe5f4c9cf");
  assert.equal(a.body.metadata.scope, "once");

  // Retry while pending: still the pending code, no second approval.
  await waitFor(() => svc.pipeline.state.get(a.body.nonce)?.approvalId === a.id);
  const pending = await evaluate(svc, req);
  assert.equal(pending.res.reason_code, REASON_CODES.pending);
  assert.equal(oked.approvals.length, before + 1);
  assert.equal(svc.logs.findLast((l) => l.event === "evaluate")!.retryOf, a.id);

  oked.decide(a.id, "approved");
  await waitFor(() => svc.pipeline.state.get(a.body.nonce)?.status === "approved");
  const allowed = await evaluate(svc, req);
  assert.equal(allowed.res.decision, "DECISION_ALLOW");
  const line = svc.logs.findLast((l) => l.event === "evaluate")!;
  assert.equal(line.decision, "allow");
  assert.equal(line.approvalId, a.id);
  assert.match(line.receiptId, /^rcpt_/);

  // Single use: the same request again needs a new approval.
  const again = await evaluate(svc, req);
  assert.equal(again.res.reason_code, REASON_CODES.pending);
  await oked.waitForApprovals(before + 2);
  assert.equal(svc.logs.findLast((l) => l.event === "evaluate")!.retryOf, a.id);
  oked.decide(oked.approvals.at(-1)!.id, "denied");
});

test("the same request from another sandbox is a different approval", async () => {
  const before = oked.approvals.length;
  const r1 = await evaluate(svc, evaluation("POST", "/repos/acme/web/issues", { title: "x" }, "sandbox-a"));
  const r2 = await evaluate(svc, evaluation("POST", "/repos/acme/web/issues", { title: "x" }, "sandbox-b"));
  assert.equal(r1.res.reason_code, REASON_CODES.pending);
  assert.equal(r2.res.reason_code, REASON_CODES.pending);
  await oked.waitForApprovals(before + 2);
  assert.notEqual(oked.approvals[before]!.body.nonce, oked.approvals[before + 1]!.body.nonce);
  for (const a of oked.approvals.slice(before)) oked.decide(a.id, "timed_out");
});

test("denied: the retry gets the denied code", async () => {
  const req = evaluation("DELETE", "/repos/acme/web/git/refs/heads/old-branch");
  const before = oked.approvals.length;
  await evaluate(svc, req);
  await oked.waitForApprovals(before + 1);
  const a = oked.approvals.at(-1)!;
  assert.equal(a.body.description, "Delete branch old-branch in acme/web");
  oked.decide(a.id, "denied");
  await waitFor(() => svc.pipeline.state.get(a.body.nonce)?.status === "denied");
  const { res } = await evaluate(svc, req);
  assert.deepEqual([res.decision, res.reason_code], ["DECISION_DENY", REASON_CODES.denied]);
});

test("open a PR: cold cache, then one approval for the PR only", async () => {
  // Use a new repo, so the default branch is not in the cache.
  const ref = evaluation("POST", "/repos/acme/cold/git/refs", { ref: "refs/heads/feature-x", sha: "abc" });
  const before = oked.approvals.length;
  const first = await evaluate(svc, ref);
  assert.equal(first.res.reason_code, REASON_CODES.pending, "unknown default branch: stricter tier");
  await svc.pipeline.idle();
  assert.equal(oked.approvals.length, before, "the lookup showed a feature branch: no approval");
  const retry = await evaluate(svc, ref);
  assert.equal(retry.res.decision, "DECISION_ALLOW");

  const put = await evaluate(svc, evaluation("PUT", "/repos/acme/cold/contents/a.txt", { message: "m", content: "eA==", branch: "feature-x" }));
  assert.equal(put.res.decision, "DECISION_ALLOW");
  assert.equal(svc.logs.findLast((l) => l.event === "evaluate")!.tier, "warning");

  const pr = await evaluate(svc, evaluation("POST", "/repos/acme/cold/pulls", { title: "Add a.txt", head: "feature-x", base: "main" }));
  assert.equal(pr.res.reason_code, REASON_CODES.pending);
  await oked.waitForApprovals(before + 1);
  assert.equal(oked.approvals.at(-1)!.body.description, "Open PR 'Add a.txt' from feature-x into main in acme/cold");
  assert.equal(oked.approvals.length, before + 1);
  oked.decide(oked.approvals.at(-1)!.id, "denied");
});

test("OKed down: a status check that fails gives the pending code within the limit", async () => {
  oked.mode = "drop_after_headers";
  const req = evaluation("POST", "/repos/acme/web/issues", { title: "status check" });
  await evaluate(svc, req);
  await svc.pipeline.idle();
  const hash = oked.approvals.at(-1)!.body.nonce;
  assert.equal(svc.pipeline.state.get(hash)?.watching, false);
  oked.mode = "normal";
  oked.delayMs = 1500;
  const { res, ms } = await evaluate(svc, req);
  oked.delayMs = 0;
  assert.equal(res.reason_code, REASON_CODES.pending);
  assert.ok(ms < 1200, `status check took ${ms} ms`);
  assert.ok(svc.logs.some((l) => l.event === "status_check_failed"));

  // OKed is back and the approver approved: the next retry finds the decision.
  oked.decide(oked.approvals.at(-1)!.id, "approved");
  const ok = await evaluate(svc, req);
  assert.equal(ok.res.decision, "DECISION_ALLOW");
});

test("OKed down: unreachable gives pending, a bad API key gives the unavailable code", async () => {
  const down = await startSvc({ okedUrl: "http://127.0.0.1:1" });
  try {
    const req = evaluation("POST", "/repos/acme/web/issues", { title: "down" });
    assert.equal((await evaluate(down, req)).res.reason_code, REASON_CODES.pending);
    await down.pipeline.idle();
    assert.equal((await evaluate(down, req)).res.reason_code, REASON_CODES.pending, "a short outage keeps the agent retrying");
  } finally {
    await stopSvc(down);
  }
  const badKey = await startSvc({ apiKey: "wrong-key" });
  try {
    const req = evaluation("POST", "/repos/acme/web/issues", { title: "bad key" });
    assert.equal((await evaluate(badKey, req)).res.reason_code, REASON_CODES.pending);
    await badKey.pipeline.idle();
    const r = (await evaluate(badKey, req)).res;
    assert.deepEqual([r.decision, r.reason_code], ["DECISION_DENY", REASON_CODES.unavailable]);
  } finally {
    await stopSvc(badKey);
  }
});

test("a phase other than PRE_CREDENTIALS is denied", async () => {
  const { res } = await evaluate(svc, { ...evaluation("GET", "/x"), phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN" });
  assert.deepEqual([res.decision, res.reason_code], ["DECISION_DENY", REASON_CODES.unavailable]);
});

test("load: 100 parallel safe requests, all allowed, p99 under 100 ms", async () => {
  const times = await Promise.all(
    Array.from({ length: 100 }, (_, i) => evaluate(svc, evaluation("GET", `/repos/acme/web/issues/${i}`))),
  );
  assert.ok(times.every((t) => t.res.decision === "DECISION_ALLOW"));
  const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
  const p99 = sorted[98]!;
  assert.ok(p99 < 100, `p99 ${p99.toFixed(1)} ms`);
});

test("logs hold no body values, header values or secrets", async () => {
  const before = oked.approvals.length;
  await evaluate(svc, evaluation("POST", "/repos/acme/web/issues", { title: "t", body: "BODYSECRET-77" }));
  await oked.waitForApprovals(before + 1);
  for (const a of oked.approvals.filter((x) => x.status === "pending")) oked.decide(a.id, "timed_out");
  await svc.pipeline.idle();
  const text = JSON.stringify(svc.logs);
  for (const secret of ["BODYSECRET-77", GITHUB_TOKEN, GOOD_KEY, "x-www-form-urlencoded"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("restart between the approval request and the decision: no second approval, the retry passes", async () => {
  const stateFile = join(stateDir, "restart-pending.json");
  const a = await startSvc({ stateFile });
  const req = evaluation("PUT", "/repos/acme/web/pulls/77/merge", {});
  const before = oked.approvals.length;
  assert.equal((await evaluate(a, req)).res.reason_code, REASON_CODES.pending);
  await oked.waitForApprovals(before + 1);
  const appr = oked.approvals.at(-1)!;
  await waitFor(() => a.pipeline.state.get(appr.body.nonce)?.approvalId === appr.id);
  await stopSvc(a);

  const b = await startSvc({ stateFile });
  try {
    const restored = b.pipeline.state.get(appr.body.nonce);
    assert.deepEqual([restored?.status, restored?.approvalId, restored?.watching], ["pending", appr.id, false]);
    // Still pending: the retry asks OKed for the status and gets the pending code.
    assert.equal((await evaluate(b, req)).res.reason_code, REASON_CODES.pending);
    oked.decide(appr.id, "approved");
    const ok = await evaluate(b, req);
    assert.equal(ok.res.decision, "DECISION_ALLOW");
    assert.ok(ok.ms < 1200, `${ok.ms} ms`);
    assert.equal(oked.approvals.length, before + 1, "the restart made no second approval");
    const line = b.logs.findLast((l) => l.event === "evaluate")!;
    assert.deepEqual([line.approvalId, typeof line.receiptId], [appr.id, "string"]);
  } finally {
    await stopSvc(b);
  }
});

test("restart after the decision: approved and used, denied, all kept", async () => {
  const stateFile = join(stateDir, "restart-decided.json");
  const a = await startSvc({ stateFile });
  const approve = evaluation("PUT", "/repos/acme/web/pulls/78/merge", {});
  const deny = evaluation("PUT", "/repos/acme/web/pulls/79/merge", {});
  const before = oked.approvals.length;
  await evaluate(a, approve);
  await evaluate(a, deny);
  await oked.waitForApprovals(before + 2);
  const [pa, pd] = oked.approvals.slice(before);
  oked.decide(pa!.id, "approved");
  oked.decide(pd!.id, "denied");
  await waitFor(() => a.pipeline.state.get(pa!.body.nonce)?.status === "approved" && a.pipeline.state.get(pd!.body.nonce)?.status === "denied");
  await stopSvc(a);

  const b = await startSvc({ stateFile });
  try {
    assert.equal((await evaluate(b, approve)).res.decision, "DECISION_ALLOW", "an approval from before the restart still allows one request");
    assert.equal((await evaluate(b, deny)).res.reason_code, REASON_CODES.denied);
  } finally {
    await stopSvc(b);
  }

  // Single use survives a restart too.
  const c = await startSvc({ stateFile });
  try {
    assert.equal((await evaluate(c, approve)).res.reason_code, REASON_CODES.pending);
    await oked.waitForApprovals(before + 3);
    oked.decide(oked.approvals.at(-1)!.id, "timed_out");
  } finally {
    await stopSvc(c);
  }
});
