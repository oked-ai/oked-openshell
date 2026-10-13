// A mock of the OKed backend endpoints that oked-openshell uses, with real
// signed receipts (test key). Same shapes as oked-app backend/src/approval.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  generateSigningSeed,
  jsonValue,
  newReceiptId,
  signBody,
  signerFromSeed,
  subjectDigest,
  type ReceiptBody,
  type ReceiptKey,
  type SignedReceipt,
} from "@oked/receipt-core";

export const GOOD_KEY = "test-api-key";
const OPERATOR = "00000000-0000-4000-8000-000000000001";

export type MockApproval = {
  id: string;
  body: any;
  status: "pending" | "approved" | "denied" | "timed_out";
  receipt: SignedReceipt | null;
  res: ServerResponse | null;
};

export type Mode = "normal" | "429" | "500" | "drop_after_headers" | "bad_receipt";

export type MockOked = {
  url: string;
  keys: ReceiptKey[];
  approvals: MockApproval[];
  calls: { method: string; path: string; auth: string | undefined }[];
  mode: Mode;
  // Delay before every response, in ms.
  delayMs: number;
  decide(id: string, decision: "approved" | "denied" | "timed_out"): void;
  waitForApprovals(n: number): Promise<void>;
  close(): Promise<void>;
};

export async function startMockOked(): Promise<MockOked> {
  const seed = generateSigningSeed();
  const signer = signerFromSeed(seed.seed, "test-kid");
  const other = signerFromSeed(generateSigningSeed().seed, "test-kid");
  const keys: ReceiptKey[] = [
    { kid: "test-kid", alg: "Ed25519", public_key: signer.publicKey, not_before: "2020-01-01T00:00:00.000Z", not_after: null },
  ];
  const waiters: (() => void)[] = [];
  let seq = 0;

  const mock: MockOked = {
    url: "",
    keys,
    approvals: [],
    calls: [],
    mode: "normal",
    delayMs: 0,
    decide(id, decision) {
      const a = mock.approvals.find((x) => x.id === id);
      if (!a || a.status !== "pending") throw new Error(`cannot decide ${id}`);
      a.status = decision;
      a.receipt = makeReceipt(a, decision, mock.mode === "bad_receipt" ? other : signer);
      if (a.res && !a.res.writableEnded) {
        const wire = decision === "timed_out" ? "timeout" : decision;
        a.res.end(JSON.stringify({ approval_id: a.id, decision: wire, status: wire, receipt: a.receipt }));
      }
    },
    async waitForApprovals(n) {
      while (mock.approvals.length < n) await new Promise<void>((r) => waiters.push(r));
    },
    close: () =>
      new Promise((resolve) => {
        for (const a of mock.approvals) a.res?.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  function makeReceipt(a: MockApproval, decision: MockApproval["status"], by: typeof signer): SignedReceipt {
    const now = new Date().toISOString();
    const body: ReceiptBody = {
      v: 1,
      receipt_id: newReceiptId(),
      chain_id: `op_${OPERATOR}`,
      seq: ++seq,
      issued_at: now,
      issuer: "mock.oked",
      operator_id: OPERATOR,
      request_id: a.id,
      subject_type: "tool_call",
      subject_digest: subjectDigest({
        type: "tool_call",
        operator_id: OPERATOR,
        request_id: a.id,
        source: a.body.metadata?.source || "sdk",
        action: a.body.action,
        description: jsonValue(a.body.description),
        tool_input: jsonValue(a.body.metadata?.tool_input),
        client_nonce: a.body.nonce ?? null,
      }),
      display_digest: null,
      summary: a.body.description ?? null,
      risk_tier: a.body.tier,
      decision: decision as ReceiptBody["decision"],
      decided_at: now,
      decider: { kind: "human", operator_id: OPERATOR, display_name: "Tester", assurance: "channel", channel: "telegram", rule_id: null, reason: null },
      requester: { operator_id: OPERATOR, api_key_id: null, client: a.body.client ?? null },
      same_person: true,
      prev_receipt_digest: null,
    };
    return signBody(body, by);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    mock.calls.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization });
    if (mock.delayMs > 0) await new Promise((r) => setTimeout(r, mock.delayMs));
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/approve") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (mock.mode === "429") return void res.writeHead(429).end('{"error":"too many pending approvals"}');
      if (mock.mode === "500") return void res.writeHead(500).end("{}");
      const a: MockApproval = { id: randomUUID(), body, status: "pending", receipt: null, res };
      mock.approvals.push(a);
      res.writeHead(200, { "content-type": "application/json" });
      res.write(" ");
      if (mock.mode === "drop_after_headers") setTimeout(() => res.destroy(), 20);
      waiters.splice(0).forEach((w) => w());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/pending") {
      const rows = mock.approvals
        .filter((a) => a.status === "pending")
        .map((a) => ({ id: a.id, action: a.body.action, description: a.body.description, tier: a.body.tier, fields: a.body.fields }));
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows.reverse()));
    }
    const m = /^\/api\/v1\/receipts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const a = mock.approvals.find((x) => x.id === m[1]);
      if (!a || !a.receipt) return void res.writeHead(404).end('{"error":"receipt not found"}');
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(a.receipt));
    }
    res.writeHead(404).end("{}");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
