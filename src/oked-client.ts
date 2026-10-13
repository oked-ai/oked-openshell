// Client for the OKed backend API (oked-app, NestJS). It uses two endpoints
// of the public OKed API:
//
// - POST /api/v1/approve creates the ApprovalRequest, sends it to Telegram and
//   the dashboard, then holds the HTTP response open (heartbeats every 25 s)
//   until a decision or 10 minutes. The middleware calls it in the background,
//   after it has denied the agent's request, so it never holds an evaluation.
// - GET /api/v1/receipts/:id is the status read by approval ID: 404 while the
//   approval is pending, 200 with the signed receipt once it is decided.
//
// The request hash goes in as the receipt nonce, so the signed receipt binds
// to the exact request that ran. Operation, resource, sandbox and scope go in
// the existing `metadata` JSON column. No migration is needed.

import { checkReceipt, OKED_RECEIPT_KEYS_URL } from "@oked/sdk";
import type { Tier } from "./types.js";

export const CLIENT_NAME = "oked-openshell/0.1.0";
export const SOURCE = "openshell";

export type ApprovalInput = {
  operation: string; // OKed `action`
  summary: string; // OKed `description`
  tier: Tier;
  fields: Record<string, string>; // OKed display fields: Title, Target, Subline, Body, Footnote
  metadata: Record<string, unknown>;
  requestHash: string; // receipt nonce, and the key to find the approval ID
};

export type Decision = "approved" | "denied" | "timed_out";

export type ApprovalOutcome =
  | { kind: "decided"; approvalId: string; decision: Decision; receiptId: string | null }
  // OKed created the approval, then the connection broke before a decision.
  | { kind: "lost"; approvalId: string | null; error: string }
  // OKed did not create the approval.
  | { kind: "failed"; permanent: boolean; status: number | null; error: string };

export type StatusResult = { status: "pending" } | { status: Decision; receiptId: string | null };

export interface OkedApi {
  // Creates the approval, then waits for the decision (up to the OKed timeout).
  // onCreated runs when OKed has created the approval, and again when the ID is known.
  requestApproval(
    apiKey: string,
    input: ApprovalInput,
    onCreated: (approvalId: string | null) => void,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome>;
  // One GET with a timeout. Throws on any error or timeout.
  status(apiKey: string, approvalId: string, input: ApprovalInput, timeoutMs: number): Promise<StatusResult>;
}

export type ReceiptKeys = Parameters<typeof checkReceipt>[2]["trust"]["keys"];

export type OkedClientOptions = {
  apiUrl: string;
  requireReceipt: boolean;
  // Longest wait for one approval: the OKed timeout plus a margin.
  maxWaitMs: number;
  // Tests and self-hosted backends: verify receipts with exactly these keys.
  receiptKeys?: ReceiptKeys;
};

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`OKed API returned HTTP ${status}`);
  }
}

type ApproveBody = { approval_id?: string | null; decision?: string; status?: string; receipt?: unknown };

export class OkedClient implements OkedApi {
  private readonly base: string;
  private readonly keysUrl: string;

  constructor(private readonly opts: OkedClientOptions) {
    this.base = opts.apiUrl.replace(/\/+$/, "");
    const host = new URL(this.base).hostname;
    this.keysUrl = host === "api.oked.ai" ? OKED_RECEIPT_KEYS_URL : `${this.base}/.well-known/oked-receipt-keys.json`;
  }

  async requestApproval(
    apiKey: string,
    input: ApprovalInput,
    onCreated: (approvalId: string | null) => void,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const timeout = AbortSignal.timeout(this.opts.maxWaitMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          action: input.operation,
          description: input.summary,
          tier: input.tier,
          fields: input.fields,
          nonce: input.requestHash,
          client: CLIENT_NAME,
          // No tool_input: the backend then keeps our tier. With tool_input it
          // would classify the action again as an agent tool call.
          metadata: { ...input.metadata, source: SOURCE },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      return { kind: "failed", permanent: false, status: null, error: errorName(e) };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // A bad key or a bad request does not get better with a retry. 429 (too
      // many pending approvals), 5xx and 504 can.
      const permanent = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
      return { kind: "failed", permanent, status: res.status, error: `HTTP ${res.status}` };
    }

    // OKed sends the headers after it has created the approval and sent the notification.
    onCreated(null);
    let approvalId: string | null = null;
    const idLookup = this.findApprovalId(apiKey, input.requestHash)
      .then((id) => {
        if (id && !approvalId) {
          approvalId = id;
          onCreated(id);
        }
      })
      .catch(() => {});

    let body: ApproveBody;
    try {
      body = JSON.parse((await res.text()).trim()) as ApproveBody;
    } catch (e) {
      await idLookup;
      return { kind: "lost", approvalId, error: errorName(e) };
    }
    const id = typeof body.approval_id === "string" ? body.approval_id : approvalId;
    if (!id) return { kind: "lost", approvalId: null, error: "no approval_id" };
    approvalId = id;

    const decision: Decision | null =
      body.decision === "approved" ? "approved" : body.decision === "denied" ? "denied" : body.decision === "timeout" ? "timed_out" : null;
    if (!decision) return { kind: "lost", approvalId: id, error: `unknown decision ${String(body.decision).slice(0, 20)}` };

    try {
      const receipt = await this.verify({ approval_id: id, decision: body.decision!, receipt: body.receipt }, input);
      return { kind: "decided", approvalId: id, decision, receiptId: receipt?.body.receipt_id ?? null };
    } catch (e) {
      // Nobody acts on an approval that we cannot prove.
      return { kind: "failed", permanent: true, status: null, error: `receipt check failed: ${errorName(e)}` };
    }
  }

  async status(apiKey: string, approvalId: string, input: ApprovalInput, timeoutMs: number): Promise<StatusResult> {
    const res = await fetch(`${this.base}/api/v1/receipts/${encodeURIComponent(approvalId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { status: "pending" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(res.status);
    }
    const receipt = (await res.json()) as { body?: { decision?: string; receipt_id?: string } };
    const d = receipt.body?.decision;
    if (d !== "approved" && d !== "denied" && d !== "timed_out") throw new Error("receipt has no decision");
    const response = d === "timed_out" ? "timeout" : d;
    const checked = await this.verify({ approval_id: approvalId, decision: response, receipt }, input);
    return { status: d, receiptId: checked?.body.receipt_id ?? null };
  }

  // The newest pending approvals in this key's scope hold our request hash in `fields`.
  private async findApprovalId(apiKey: string, requestHash: string): Promise<string | null> {
    const res = await fetch(`${this.base}/api/v1/pending`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new HttpError(res.status);
    const rows = (await res.json()) as { id?: string; fields?: Record<string, unknown> | null }[];
    const row = Array.isArray(rows) ? rows.find((r) => r.fields?.RequestHash === requestHash) : undefined;
    return typeof row?.id === "string" ? row.id : null;
  }

  private verify(result: { approval_id: string; decision: string; receipt: unknown }, input: ApprovalInput) {
    return checkReceipt(
      result,
      { action: input.operation, description: input.summary, toolInput: undefined, source: SOURCE, nonce: input.requestHash },
      {
        required: this.opts.requireReceipt,
        trust: this.opts.receiptKeys ? { keys: this.opts.receiptKeys, keysUrl: this.keysUrl } : { keysUrl: this.keysUrl },
      },
    );
  }
}

// An error name and message, short, for logs. Never a response body.
export function errorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 200);
  return String(e).slice(0, 200);
}
