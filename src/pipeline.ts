// pipeline: parse -> classify -> decide. Every evaluation answers fast:
// no GitHub lookup and no approval creation runs inside it.
// The only network call inside an evaluation is the status check on a retry,
// with its own short timeout.

import type { Enrichment } from "./catalog/github.js";
import { classify, type Classification } from "./classify/index.js";
import { approverGroup, ENTRY_TTL_MINUTES, type Config, type Secrets } from "./config.js";
import type { GithubEnricher } from "./enrich/github.js";
import type { Logger } from "./log.js";
import { errorName, type ApprovalInput, type OkedApi } from "./oked-client.js";
import { parseRequest, type Parsed } from "./parse/index.js";
import { REASON_CODES } from "./reason-codes.js";
import { footnote, render } from "./render/index.js";
import { truncate } from "./render/redact.js";
import { RetryState, type Verdict } from "./retry/state.js";
import { FileStore } from "./retry/store.js";
import { needsApproval, type RawRequest, type Tier } from "./types.js";

export type EvalResult = {
  decision: "allow" | "deny";
  reasonCode: string | null;
  // Free-text diagnostic for OpenShell. It never reaches the agent.
  reason: string;
  metadata: Record<string, string>;
};

export type PipelineDeps = {
  config: Config;
  secrets: Secrets;
  oked: OkedApi;
  enricher: GithubEnricher;
  log: Logger;
  now?: () => number;
  // Most approvals that wait in the background at the same time.
  maxOpenApprovals?: number;
};

// Saved with the retry state, so it holds the approver group, never the API key.
type ApprovalContext = { group: string; input: ApprovalInput };

export class Pipeline {
  readonly state: RetryState;
  private readonly now: () => number;
  private readonly maxOpen: number;
  private open = 0;
  private closed = false;
  private readonly aborts = new Set<AbortController>();
  // Background work, so tests and shutdown can wait for it.
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? Date.now;
    this.maxOpen = deps.maxOpenApprovals ?? 20;
    const a = deps.config.approval;
    this.state = new RetryState({
      pendingWindowMs: a.pending_window_minutes * 60_000,
      grantValidMs: a.grant_valid_minutes * 60_000,
      entryTtlMs: ENTRY_TTL_MINUTES * 60_000,
      now: this.now,
      store: a.state_file ? new FileStore(a.state_file, (e) => deps.log({ event: "state_file_error", ...e })) : undefined,
    });
  }

  // Stops background work and saving. The next process takes over from the state file.
  close(): void {
    this.closed = true;
    this.state.detach();
    for (const a of this.aborts) a.abort();
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  async evaluate(raw: RawRequest): Promise<EvalResult> {
    const t0 = this.now();
    let parsed: Parsed | null = null;
    try {
      parsed = parseRequest(raw);
      const action = parsed.action;
      const cls = classify(parsed, this.deps.config.rules, (k) => this.deps.enricher.cachedDefaultBranch(k));
      const existing = this.state.get(action.requestHash);
      // A human decision in progress for this exact request wins over a lower tier.
      const humanOwned = existing && existing.via !== "classifier" && ["pending", "denied", "timed_out"].includes(existing.status);

      if (!needsApproval(cls.tier) && !humanOwned) {
        // Not the fast path: warm the default-branch cache for later setup writes.
        if (cls.source !== "fast_path" && parsed.github) {
          this.deps.enricher.warmDefaultBranch(parsed.github.facts.owner, parsed.github.facts.repo);
        }
        return this.finish(t0, parsed, cls, { decision: "allow", reasonCode: null }, null);
      }

      let verdict = this.state.evaluate(action.requestHash);
      if (verdict.needsStatusCheck) verdict = await this.checkStatus(verdict);
      if (verdict.isNew) this.startApproval(parsed, cls);
      return this.finish(t0, parsed, cls, verdict, verdict);
    } catch (e) {
      this.deps.log({
        event: "evaluate_error",
        requestHash: parsed?.action.requestHash ?? null,
        error: errorName(e),
        latencyMs: this.now() - t0,
      });
      return { decision: "deny", reasonCode: REASON_CODES.unavailable, reason: "OKed: internal error", metadata: {} };
    }
  }

  // On a retry, when nobody watches the approval: one GET, short timeout.
  // Any failure gives the pending code (still a deny), never the error code.
  private async checkStatus(v: Verdict): Promise<Verdict> {
    const hash = v.entry.requestHash;
    const ctx = v.entry.context as ApprovalContext | undefined;
    const apiKey = ctx ? this.deps.secrets.okedKeys.get(ctx.group) : undefined;
    if (!ctx || !apiKey || !v.entry.approvalId) return { ...v, needsStatusCheck: false };
    const t0 = this.now();
    try {
      const s = await this.deps.oked.status(apiKey, v.entry.approvalId, ctx.input, this.deps.config.approval.status_check_timeout_ms);
      this.deps.log({ event: "status_check", requestHash: hash, approvalId: v.entry.approvalId, status: s.status, ms: this.now() - t0 });
      if (s.status === "pending") return { ...v, needsStatusCheck: false };
      this.state.markDecided(hash, s.status, { receiptId: s.receiptId });
      return { ...this.state.evaluate(hash), retryOf: v.entry.approvalId };
    } catch (e) {
      this.deps.log({ event: "status_check_failed", requestHash: hash, approvalId: v.entry.approvalId, error: errorName(e), ms: this.now() - t0 });
      return { ...v, needsStatusCheck: false };
    }
  }

  private startApproval(parsed: Parsed, cls: Classification): void {
    const hash = parsed.action.requestHash;
    if (this.open >= this.maxOpen) {
      // Too many approvals wait already. The next retry tries again.
      this.state.markFailed(hash, false);
      this.deps.log({ event: "approval_skipped", requestHash: hash, reason: "too_many_open_approvals" });
      return;
    }
    this.open++;
    // Start after the reply goes out.
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.runApproval(parsed, cls))
      .catch((e) => {
        this.state.markFailed(hash, false);
        this.deps.log({ event: "approval_error", requestHash: hash, error: errorName(e) });
      })
      .finally(() => {
        this.open--;
        this.background.delete(p);
      });
    this.background.add(p);
  }

  // Runs after the reply: enrichment, then the approval in OKed, then the decision.
  private async runApproval(parsed: Parsed, cls: Classification): Promise<void> {
    const { action, github } = parsed;
    const hash = action.requestHash;
    const t0 = this.now();
    let tier: Tier = cls.tier;
    const enrichment: Enrichment = {};

    if (github) {
      const { owner, repo, number, branch } = github.facts;
      const lookups: Promise<unknown>[] = [];
      if (cls.defaultBranchUnknown || (github.entry.operation === "github.contents.put" && branch === null)) {
        lookups.push(this.deps.enricher.defaultBranch(owner, repo).then((d) => (enrichment.defaultBranch = d)));
      }
      if (github.entry.operation === "github.pulls.merge" && number !== undefined) {
        lookups.push(this.deps.enricher.pull(owner, repo, number).then((p) => (enrichment.pull = p)));
      }
      await Promise.all(lookups);

      if (cls.defaultBranchUnknown && enrichment.defaultBranch) {
        const again = classify(parsed, this.deps.config.rules, () => enrichment.defaultBranch ?? null);
        if (!needsApproval(again.tier)) {
          // With the default branch known, no human is needed. The retry passes.
          this.state.markDecided(hash, "approved", { via: "classifier" });
          this.deps.log({ event: "reclassified", requestHash: hash, operation: action.operation, from: cls.tier, tier: again.tier });
          return;
        }
        tier = again.tier;
      }
    }

    const group = approverGroup(this.deps.config, action.sandboxId, action.sandbox);
    const apiKey = this.deps.secrets.okedKeys.get(group);
    if (!apiKey) throw new Error(`no API key for approver group ${group}`);

    const r = render(parsed, tier, enrichment);
    const input: ApprovalInput = {
      operation: action.operation,
      summary: r.summary,
      tier,
      requestHash: hash,
      fields: {
        Title: r.title,
        Target: action.resource ?? truncate(`${action.method} ${action.host}${action.path}`),
        Subline: r.lines.join("\n"),
        Footnote: footnote(r),
        RequestHash: hash,
      },
      metadata: {
        origin: "openshell",
        operation: action.operation,
        kind: action.kind,
        resource: action.resource,
        summary: r.summary,
        fields: action.fields,
        requestHash: hash,
        sandboxId: action.sandboxId,
        sandbox: action.sandbox,
        scope: "once",
        tier,
        approverGroup: group,
        classification: cls.source,
        rules: cls.rules,
      },
    };
    this.state.setContext(hash, { group, input } satisfies ApprovalContext);
    this.deps.log({
      event: "approval_requested",
      requestHash: hash,
      operation: action.operation,
      resource: action.resource,
      tier,
      summary: r.summary,
      approverGroup: group,
      enrichMs: this.now() - t0,
      pullFound: github?.entry.operation === "github.pulls.merge" ? Boolean(enrichment.pull) : undefined,
    });

    if (this.closed) return;
    const abort = new AbortController();
    this.aborts.add(abort);
    let outcome;
    try {
      outcome = await this.deps.oked.requestApproval(
        apiKey,
        input,
        (approvalId) => {
          if (this.closed) return;
          this.state.markCreated(hash, approvalId, true);
          this.deps.log({ event: "approval_created", requestHash: hash, approvalId, msFromStart: this.now() - t0 });
        },
        abort.signal,
      );
    } finally {
      this.aborts.delete(abort);
    }
    // After close, the state file belongs to the next process.
    if (this.closed) return;

    switch (outcome.kind) {
      case "decided":
        this.state.markDecided(hash, outcome.decision, { approvalId: outcome.approvalId, receiptId: outcome.receiptId });
        this.deps.log({
          event: "approval_decided",
          requestHash: hash,
          approvalId: outcome.approvalId,
          decision: outcome.decision,
          receiptId: outcome.receiptId,
          msFromStart: this.now() - t0,
        });
        return;
      case "lost":
        if (outcome.approvalId) this.state.markCreated(hash, outcome.approvalId, false);
        else this.state.markFailed(hash, false);
        this.deps.log({ event: "approval_lost", requestHash: hash, approvalId: outcome.approvalId, error: outcome.error });
        return;
      case "failed":
        this.state.markFailed(hash, outcome.permanent);
        this.deps.log({
          event: "approval_failed",
          requestHash: hash,
          permanent: outcome.permanent,
          status: outcome.status,
          error: outcome.error,
        });
        return;
    }
  }

  private finish(
    t0: number,
    parsed: Parsed,
    cls: Classification,
    d: { decision: "allow" | "deny"; reasonCode: string | null },
    v: Verdict | null,
  ): EvalResult {
    const a = parsed.action;
    const approvalId = v?.entry.approvalId ?? null;
    const receiptId = d.decision === "allow" ? (v?.entry.receiptId ?? null) : null;
    this.deps.log({
      event: "evaluate",
      sandbox: a.sandbox,
      sandboxId: a.sandboxId,
      operation: a.operation,
      kind: a.kind,
      resource: a.resource,
      tier: cls.tier,
      source: cls.source,
      rule: cls.rules[0] ?? null,
      requestHash: a.requestHash,
      approvalId,
      retryOf: v?.retryOf ?? null,
      decision: d.decision,
      reasonCode: d.reasonCode,
      via: v?.entry.via ?? undefined,
      receiptId,
      latencyMs: this.now() - t0,
    });
    const metadata: Record<string, string> = { operation: a.operation, tier: cls.tier, request_hash: a.requestHash.slice(0, 16) };
    if (approvalId) metadata.approval_id = approvalId;
    if (receiptId) metadata.receipt_id = receiptId;
    const reason =
      d.decision === "allow"
        ? `OKed: allow ${a.operation} (${cls.tier})`
        : `OKed: deny ${a.operation} (${cls.tier})${approvalId ? `, approval ${approvalId}` : ""}`;
    return { decision: d.decision, reasonCode: d.reasonCode, reason, metadata };
  }
}
