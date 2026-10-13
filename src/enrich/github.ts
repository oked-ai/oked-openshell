// Read-only GitHub lookups with OKed's own token: PR title,
// base and head for a merge, and the repo default branch.
// Callers never wait on these inside an evaluation. The token never leaves
// the Authorization header: not in logs, errors, receipts or approval text.

import type { PullInfo } from "../catalog/github.js";

const DEFAULT_BRANCH_TTL_MS = 10 * 60_000;
// After 10 minutes, the last known default branch is still used for up to 24
// hours while a background lookup refreshes it. Without this, every setup write
// after a quiet 10 minutes gets the stricter tier and the pending code.
const DEFAULT_BRANCH_STALE_MS = 24 * 60 * 60_000;
const PULL_TTL_MS = 60_000;
// A failed lookup is not tried again for this long.
const FAILURE_TTL_MS = 30_000;

type Cached<T> = { value: T; expires: number };

export type GithubEnricherOptions = {
  apiUrl: string;
  token: string | null;
  timeoutMs: number;
  now?: () => number;
  // Called after each lookup, for the log. Never gets the token.
  onLookup?: (event: { kind: "default_branch" | "pull"; repo: string; ok: boolean; status: number | null; ms: number }) => void;
};

export class GithubEnricher {
  private readonly base: string;
  private readonly now: () => number;
  private readonly branches = new Map<string, Cached<string | null>>();
  // The last successful default-branch lookup per repo.
  private readonly lastKnown = new Map<string, { value: string; at: number }>();
  private readonly pulls = new Map<string, Cached<PullInfo | null>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: GithubEnricherOptions) {
    this.base = opts.apiUrl.replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.token !== null;
  }

  // From the cache only. Never waits on the network. Null: unknown.
  // A value older than 10 minutes (up to 24 hours) is used, and a background
  // lookup refreshes it.
  cachedDefaultBranch(repoKey: string): string | null {
    const key = repoKey.toLowerCase();
    const c = this.branches.get(key);
    if (c && c.expires > this.now() && c.value !== null) return c.value;
    const known = this.lastKnown.get(key);
    if (!known || this.now() - known.at >= DEFAULT_BRANCH_STALE_MS) return null;
    const [owner, repo] = key.split("/");
    if (owner && repo && !(c && c.expires > this.now())) void this.defaultBranch(owner, repo);
    return known.value;
  }

  // Starts a lookup in the background when the cache has no fresh value.
  warmDefaultBranch(owner: string, repo: string): void {
    const key = `${owner}/${repo}`.toLowerCase();
    const c = this.branches.get(key);
    if (!this.enabled || (c && c.expires > this.now())) return;
    void this.defaultBranch(owner, repo);
  }

  async defaultBranch(owner: string, repo: string): Promise<string | null> {
    const key = `${owner}/${repo}`.toLowerCase();
    const c = this.branches.get(key);
    if (c && c.expires > this.now()) return c.value;
    return this.once(`branch:${key}`, async () => {
      const data = await this.get(`/repos/${enc(owner)}/${enc(repo)}`, "default_branch", key);
      const value = typeof data?.default_branch === "string" ? data.default_branch : null;
      this.branches.set(key, { value, expires: this.now() + (value === null ? FAILURE_TTL_MS : DEFAULT_BRANCH_TTL_MS) });
      if (value !== null) this.lastKnown.set(key, { value, at: this.now() });
      return value;
    });
  }

  async pull(owner: string, repo: string, number: number): Promise<PullInfo | null> {
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    const c = this.pulls.get(key);
    if (c && c.expires > this.now()) return c.value;
    return this.once(`pull:${key}`, async () => {
      const data = await this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`, "pull", key);
      const pr = data as { title?: unknown; base?: { ref?: unknown }; head?: { ref?: unknown } } | null;
      const value =
        pr && typeof pr.title === "string" && typeof pr.base?.ref === "string" && typeof pr.head?.ref === "string"
          ? { title: pr.title, base: pr.base.ref, head: pr.head.ref }
          : null;
      this.pulls.set(key, { value, expires: this.now() + (value === null ? FAILURE_TTL_MS : PULL_TTL_MS) });
      return value;
    });
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // One GET. Returns the JSON object, or null on any failure. Never throws.
  private async get(path: string, kind: "default_branch" | "pull", repo: string): Promise<Record<string, unknown> | null> {
    if (!this.opts.token) return null;
    const t0 = this.now();
    let status: number | null = null;
    try {
      const res = await fetch(`${this.base}${path}`, {
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "oked-openshell",
        },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      status = res.status;
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const data = (await res.json()) as unknown;
      return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    } catch {
      return null;
    } finally {
      this.opts.onLookup?.({ kind, repo, ok: status !== null && status < 300, status, ms: this.now() - t0 });
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
