// Deny and retry. Map requestHash -> entry.
// evaluate() never waits: it decides from the map. The pipeline updates the map
// when OKed creates or decides an approval. With a store, every change is saved,
// so a restart keeps pending, decided and used approvals.

import { REASON_CODES, type ReasonCodes } from "../reason-codes.js";

export type Status = "pending" | "approved" | "denied" | "timed_out" | "failed";

export type Entry = {
  requestHash: string;
  approvalId: string | null;
  status: Status;
  createdAt: number;
  decidedAt: number | null;
  used: boolean;
  receiptId: string | null;
  // Pending: true while OKed holds our long-poll open, so the decision comes to us.
  // False: ask OKed for the status on the next retry. Never saved: after a
  // restart, no long-poll is open.
  watching: boolean;
  // Failed: true for a failure that a retry cannot fix (bad API key, bad request).
  permanent: boolean;
  // Approved: "classifier" when the full data showed that no human was needed.
  via: "human" | "classifier" | null;
  // The approval this entry replaces, for the retryOf log field.
  previousApprovalId: string | null;
  // Owned by the caller: what it needs for a later status check. It is saved
  // with the entry, so it must be plain JSON and hold no secrets.
  context?: unknown;
};

export type Verdict = {
  decision: "allow" | "deny";
  reasonCode: string | null;
  entry: Entry;
  // True: a new approval must be created for this entry.
  isNew: boolean;
  // The approval ID when this evaluation is a retry.
  retryOf: string | null;
  // True: pending, but nobody watches the approval. Ask OKed for the status.
  needsStatusCheck: boolean;
};

// Where entries survive a restart. save() gets every live entry each time.
export interface StateStore {
  load(): Entry[];
  save(entries: Entry[]): void;
}

export type StateOptions = {
  pendingWindowMs: number;
  grantValidMs: number;
  entryTtlMs: number;
  codes?: ReasonCodes;
  now?: () => number;
  store?: StateStore;
};

export class RetryState {
  private readonly entries = new Map<string, Entry>();
  private readonly codes: ReasonCodes;
  private readonly now: () => number;
  private store: StateStore | null;
  private lastSweep = 0;

  constructor(private readonly opts: StateOptions) {
    this.codes = opts.codes ?? REASON_CODES;
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? null;
    if (this.store) this.restore(this.store.load());
  }

  get size(): number {
    return this.entries.size;
  }

  get(hash: string): Entry | undefined {
    return this.entries.get(hash);
  }

  // Stop saving. A closed pipeline calls this, so a late result cannot overwrite
  // the file that a new process already uses.
  detach(): void {
    this.store = null;
  }

  evaluate(hash: string): Verdict {
    const now = this.now();
    const swept = this.sweep(now);
    const v = this.decide(hash, now);
    // A plain pending retry changes nothing. Everything else is saved.
    if (swept || v.isNew || v.reasonCode !== this.codes.pending) this.persist();
    return v;
  }

  private decide(hash: string, now: number): Verdict {
    const e = this.entries.get(hash);
    if (!e) return this.fresh(hash, null);

    switch (e.status) {
      case "pending":
        if (now - e.createdAt >= this.opts.pendingWindowMs) {
          e.status = "timed_out";
          e.decidedAt = now;
          e.watching = false;
          return this.deny(e, this.codes.timedOut);
        }
        return this.deny(e, this.codes.pending, !e.watching && e.approvalId !== null);
      case "approved":
        // Single use. A used or expired grant needs a new decision.
        if (e.used || now - (e.decidedAt ?? e.createdAt) > this.opts.grantValidMs) {
          return this.fresh(hash, e.approvalId);
        }
        e.used = true;
        return { decision: "allow", reasonCode: null, entry: e, isNew: false, retryOf: e.approvalId, needsStatusCheck: false };
      case "denied":
        return this.deny(e, this.codes.denied);
      case "timed_out":
        return this.deny(e, this.codes.timedOut);
      case "failed":
        if (e.permanent) {
          this.entries.delete(hash);
          return this.deny(e, this.codes.unavailable);
        }
        return this.fresh(hash, e.approvalId ?? e.previousApprovalId);
    }
  }

  markCreated(hash: string, approvalId: string | null, watching: boolean): void {
    const e = this.live(hash, "pending");
    if (!e) return;
    if (approvalId) e.approvalId = approvalId;
    e.watching = watching;
    this.persist();
  }

  setContext(hash: string, context: unknown): void {
    const e = this.entries.get(hash);
    if (!e) return;
    e.context = context;
    this.persist();
  }

  markWatching(hash: string, watching: boolean): void {
    const e = this.live(hash, "pending");
    if (e) e.watching = watching;
  }

  // A decision from OKed. A late decision also replaces a local timeout.
  markDecided(
    hash: string,
    decision: "approved" | "denied" | "timed_out",
    info: { approvalId?: string | null; receiptId?: string | null; via?: "human" | "classifier" } = {},
  ): void {
    const e = this.entries.get(hash);
    if (!e || (e.status !== "pending" && e.status !== "timed_out")) return;
    if (e.status === "timed_out" && decision === "timed_out") return;
    e.status = decision;
    e.decidedAt = this.now();
    e.watching = false;
    if (info.approvalId) e.approvalId = info.approvalId;
    e.receiptId = info.receiptId ?? null;
    e.via = decision === "approved" ? (info.via ?? "human") : null;
    this.persist();
  }

  markFailed(hash: string, permanent: boolean): void {
    const e = this.live(hash, "pending");
    if (!e) return;
    e.status = "failed";
    e.permanent = permanent;
    e.watching = false;
    this.persist();
  }

  private live(hash: string, status: Status): Entry | undefined {
    const e = this.entries.get(hash);
    return e && e.status === status ? e : undefined;
  }

  private fresh(hash: string, previousApprovalId: string | null): Verdict {
    const entry: Entry = {
      requestHash: hash,
      approvalId: null,
      status: "pending",
      createdAt: this.now(),
      decidedAt: null,
      used: false,
      receiptId: null,
      watching: false,
      permanent: false,
      via: null,
      previousApprovalId,
    };
    this.entries.set(hash, entry);
    return {
      decision: "deny",
      reasonCode: this.codes.pending,
      entry,
      isNew: true,
      retryOf: previousApprovalId,
      needsStatusCheck: false,
    };
  }

  private deny(e: Entry, reasonCode: string, needsStatusCheck = false): Verdict {
    return { decision: "deny", reasonCode, entry: e, isNew: false, retryOf: e.approvalId, needsStatusCheck };
  }

  // Drop entries 30 minutes after creation. At most once per second. True if any went.
  private sweep(now: number): boolean {
    if (now - this.lastSweep < 1000) return false;
    this.lastSweep = now;
    let dropped = false;
    for (const [hash, e] of this.entries) {
      if (now - e.createdAt >= this.opts.entryTtlMs) {
        this.entries.delete(hash);
        dropped = true;
      }
    }
    return dropped;
  }

  // Entries from before a restart. No long-poll survives a restart, so a pending
  // approval with an ID gets a status check on the next retry. A pending entry
  // with no approval ID may never have reached OKed: the next retry creates one.
  private restore(saved: Entry[]): void {
    const now = this.now();
    for (const e of saved) {
      if (now - e.createdAt >= this.opts.entryTtlMs) continue;
      const entry: Entry = { ...e, watching: false };
      if (entry.status === "pending" && entry.approvalId === null) {
        entry.status = "failed";
        entry.permanent = false;
      }
      this.entries.set(entry.requestHash, entry);
    }
  }

  private persist(): void {
    this.store?.save([...this.entries.values()]);
  }
}
