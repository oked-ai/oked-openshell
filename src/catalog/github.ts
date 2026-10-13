// The GitHub REST catalog, built from the requests that real coding agents send.
// Each entry turns one method and path into an operation, a kind, a resource,
// display fields, a default tier and a summary with real values.

import { truncate } from "../render/redact.js";
import type { ActionKind, Tier } from "../types.js";

export const GITHUB_HOST = "api.github.com";

export type GithubFacts = {
  owner: string;
  repo: string;
  number?: number;
  // The branch that the write changes. Null: the request names no branch, so
  // GitHub uses the default branch.
  branch?: string | null;
  // createRef only: false when the ref is not under refs/heads/ (a tag, for example).
  refIsBranch?: boolean;
  ref?: string;
  path?: string;
  title?: string;
  head?: string;
  base?: string;
};

export type PullInfo = { title: string; base: string; head: string };

// Data from the read-only GitHub token. Undefined or null means unknown.
export type Enrichment = {
  defaultBranch?: string | null;
  pull?: PullInfo | null;
};

export type TierResult = {
  tier: Tier;
  // True when the tier depends on the default branch and the default branch is unknown.
  defaultBranchUnknown: boolean;
};

export type CatalogEntry = {
  operation: string;
  method: string;
  pattern: RegExp;
  kind: ActionKind;
  tier: Tier;
  facts(params: string[], body: Record<string, unknown>): GithubFacts;
  resource(f: GithubFacts, e: Enrichment): string;
  fields(f: GithubFacts, body: Record<string, unknown>): [string, unknown][];
  adjust?(f: GithubFacts, defaultBranch: string | null): TierResult;
  summary(f: GithubFacts, e: Enrichment): string;
  // Field keys whose values the summary already shows. Render hides those lines.
  shown?(f: GithubFacts): string[];
};

export type GithubMatch = { entry: CatalogEntry; facts: GithubFacts };

const REPO = "/repos/([^/]+)/([^/]+)";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function repoOf(f: GithubFacts): string {
  return `${f.owner}/${f.repo}`;
}

function q(v: string | undefined): string {
  return v === undefined ? "" : ` '${truncate(v)}'`;
}

// "Unknown" counts as "could be the default branch": use the stricter tier.
function onDefaultBranch(branch: string | null | undefined, defaultBranch: string | null): TierResult {
  if (branch === null || branch === undefined) return { tier: "review", defaultBranchUnknown: false };
  if (defaultBranch === null) return { tier: "review", defaultBranchUnknown: true };
  return { tier: branch === defaultBranch ? "review" : "warning", defaultBranchUnknown: false };
}

export const GITHUB_CATALOG: CatalogEntry[] = [
  {
    operation: "github.issues.create",
    method: "POST",
    pattern: new RegExp(`^${REPO}/issues/?$`, "i"),
    kind: "write",
    tier: "review",
    facts: ([owner, repo], body) => ({ owner: owner!, repo: repo!, title: str(body.title) }),
    resource: (f) => repoOf(f),
    fields: (_f, b) => [
      ["title", b.title],
      ["body", b.body],
      ["labels", b.labels],
      ["assignees", b.assignees],
      ["milestone", b.milestone],
    ],
    summary: (f) => `Create issue${q(f.title)} in ${repoOf(f)}`,
    shown: (f) => (f.title === undefined ? [] : ["title"]),
  },
  {
    // Also used for PR comments. The path does not show which.
    operation: "github.issues.comment",
    method: "POST",
    pattern: new RegExp(`^${REPO}/issues/(\\d+)/comments/?$`, "i"),
    kind: "write",
    tier: "warning",
    facts: ([owner, repo, n]) => ({ owner: owner!, repo: repo!, number: Number(n) }),
    resource: (f) => `${repoOf(f)}#${f.number}`,
    fields: (_f, b) => [["body", b.body]],
    summary: (f) => `Comment on #${f.number} in ${repoOf(f)}`,
  },
  {
    operation: "github.git.createRef",
    method: "POST",
    pattern: new RegExp(`^${REPO}/git/refs/?$`, "i"),
    kind: "write",
    tier: "warning",
    facts: ([owner, repo], body) => {
      const ref = str(body.ref);
      const refIsBranch = ref !== undefined && ref.startsWith("refs/heads/") && ref.length > 11;
      return { owner: owner!, repo: repo!, ref, refIsBranch, branch: refIsBranch ? ref!.slice(11) : undefined };
    },
    resource: (f) => `${repoOf(f)}@${f.branch ?? f.ref ?? "?"}`,
    fields: (_f, b) => [
      ["ref", b.ref],
      ["sha", b.sha],
    ],
    // A tag or any ref outside refs/heads/ is not a setup write. Lean toward caution.
    adjust: (f, d) => (f.refIsBranch ? onDefaultBranch(f.branch, d) : { tier: "review", defaultBranchUnknown: false }),
    summary: (f) =>
      f.refIsBranch
        ? `Create branch ${truncate(f.branch!)} in ${repoOf(f)}`
        : `Create ref ${truncate(f.ref ?? "?")} in ${repoOf(f)}`,
  },
  {
    operation: "github.contents.put",
    method: "PUT",
    pattern: new RegExp(`^${REPO}/contents/(.+?)/?$`, "i"),
    kind: "write",
    tier: "warning",
    facts: ([owner, repo, path], body) => ({
      owner: owner!,
      repo: repo!,
      path: path!,
      branch: str(body.branch) ?? null,
    }),
    resource: (f, e) => `${repoOf(f)}@${f.branch ?? e.defaultBranch ?? "default"}`,
    fields: (f, b) => [
      ["path", f.path],
      ["branch", b.branch],
      ["message", b.message],
      ["update", typeof b.sha === "string"],
      ["content_bytes", typeof b.content === "string" ? Math.floor((b.content.length * 3) / 4) : undefined],
    ],
    adjust: (f, d) => onDefaultBranch(f.branch, d),
    summary: (f, e) => {
      const branch = f.branch ?? e.defaultBranch ?? null;
      return `Commit ${truncate(f.path!)} to ${branch === null ? "the default branch" : truncate(branch)} in ${repoOf(f)}`;
    },
    shown: (f) => (f.branch ? ["path", "branch"] : ["path"]),
  },
  {
    operation: "github.pulls.create",
    method: "POST",
    pattern: new RegExp(`^${REPO}/pulls/?$`, "i"),
    kind: "write",
    tier: "review",
    facts: ([owner, repo], body) => ({
      owner: owner!,
      repo: repo!,
      title: str(body.title),
      head: str(body.head),
      base: str(body.base),
    }),
    resource: (f) => repoOf(f),
    fields: (_f, b) => [
      ["title", b.title],
      ["head", b.head],
      ["base", b.base],
      ["draft", b.draft],
      ["body", b.body],
    ],
    summary: (f) => {
      const from = f.head === undefined ? "" : ` from ${truncate(f.head)}`;
      const into = f.base === undefined ? "" : ` into ${truncate(f.base)}`;
      return `Open PR${q(f.title)}${from}${into} in ${repoOf(f)}`;
    },
    shown: (f) => (["title", "head", "base"] as const).filter((k) => f[k] !== undefined),
  },
  {
    // The body is often {}. Title and base come from the read-only token (section 7).
    operation: "github.pulls.merge",
    method: "PUT",
    pattern: new RegExp(`^${REPO}/pulls/(\\d+)/merge/?$`, "i"),
    kind: "write",
    tier: "high_stakes",
    facts: ([owner, repo, n]) => ({ owner: owner!, repo: repo!, number: Number(n) }),
    resource: (f) => `${repoOf(f)}#${f.number}`,
    fields: (_f, b) => [
      ["merge_method", b.merge_method],
      ["commit_title", b.commit_title],
      ["commit_message", b.commit_message],
      ["sha", b.sha],
    ],
    summary: (f, e) =>
      e.pull
        ? `Merge PR #${f.number}${q(e.pull.title)} into ${truncate(e.pull.base)} in ${repoOf(f)}`
        : `Merge PR #${f.number} in ${repoOf(f)}`,
  },
  {
    operation: "github.git.deleteRef",
    method: "DELETE",
    pattern: new RegExp(`^${REPO}/git/refs/heads/(.+?)/?$`, "i"),
    kind: "delete",
    tier: "review",
    facts: ([owner, repo, branch]) => ({ owner: owner!, repo: repo!, branch: branch! }),
    resource: (f) => `${repoOf(f)}@${f.branch}`,
    fields: (f) => [["branch", f.branch]],
    adjust: (f, d) => {
      if (d === null) return { tier: "high_stakes", defaultBranchUnknown: true };
      return { tier: f.branch === d ? "high_stakes" : "review", defaultBranchUnknown: false };
    },
    summary: (f) => `Delete branch ${truncate(f.branch!)} in ${repoOf(f)}`,
    shown: () => ["branch"],
  },
];

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Matches a non-read GitHub REST request against the catalog. Null when no entry matches.
export function matchGithub(method: string, path: string, body: Record<string, unknown>): GithubMatch | null {
  for (const entry of GITHUB_CATALOG) {
    if (entry.method !== method) continue;
    const m = entry.pattern.exec(path);
    if (!m) continue;
    const params = m.slice(1).map(decodeSegment);
    return { entry, facts: entry.facts(params, body) };
  }
  return null;
}

// The catalog tier, adjusted by the default-branch checks. `defaultBranch` null: unknown.
export function catalogTier(m: GithubMatch, defaultBranch: string | null): TierResult {
  return m.entry.adjust ? m.entry.adjust(m.facts, defaultBranch) : { tier: m.entry.tier, defaultBranchUnknown: false };
}

export function repoKey(f: Pick<GithubFacts, "owner" | "repo">): string {
  return `${f.owner}/${f.repo}`.toLowerCase();
}

// owner/repo for any /repos/:o/:r/... path, also for reads. Used to warm the default-branch cache.
export function repoFromPath(path: string): { owner: string; repo: string } | null {
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/|$)/i.exec(path);
  return m ? { owner: decodeSegment(m[1]!), repo: decodeSegment(m[2]!) } : null;
}
