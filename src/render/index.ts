// render: the text the approver sees. Real values, short words, no em dashes.

import type { Enrichment } from "../catalog/github.js";
import type { Parsed } from "../parse/index.js";
import type { FieldValue, Tier } from "../types.js";
import { truncate } from "./redact.js";

export const SCOPE_TEXT = "this request only";

const TIER_LABEL: Record<Tier, string> = {
  safe: "Safe",
  warning: "Warning",
  review: "Review",
  high_stakes: "High stakes",
};

const MAX_LINES = 5;

export type Rendered = {
  summary: string;
  title: string; // the summary without " in owner/repo": the Target line shows the repo
  lines: string[]; // "key: value", at most 5
  sandbox: string;
  tier: Tier;
  tierLabel: string;
  scope: typeof SCOPE_TEXT;
};

export function render(parsed: Parsed, tier: Tier, enrichment: Enrichment = {}): Rendered {
  const { action, github } = parsed;
  let summary: string;
  if (github) {
    summary = github.entry.summary(github.facts, enrichment);
  } else if (action.protocol === "graphql") {
    const name = action.operation.replace(/^github\.graphql\./, "");
    summary = `GitHub GraphQL ${action.kind === "read" ? "query" : "mutation"} ${name}`;
  } else {
    summary = `${action.method} ${action.host}${truncate(action.path)}`;
  }

  let title = summary;
  const repoSuffix = github ? ` in ${github.facts.owner}/${github.facts.repo}` : null;
  if (repoSuffix && summary.endsWith(repoSuffix)) title = summary.slice(0, -repoSuffix.length);

  // A line that repeats a value of the summary is clutter. The merge summary
  // already shows the PR title and base, so only head is new.
  const shown = new Set(github?.entry.shown?.(github.facts) ?? []);
  const entries: [string, FieldValue][] = [];
  if (enrichment.pull) entries.push(["head", truncate(enrichment.pull.head)]);
  entries.push(...Object.entries(action.fields).filter(([k]) => !shown.has(k)));
  const lines = entries.slice(0, MAX_LINES).map(([k, v]) => `${k}: ${v}`);

  return { summary, title, lines, sandbox: action.sandbox, tier, tierLabel: TIER_LABEL[tier], scope: SCOPE_TEXT };
}

export function tierLabel(tier: Tier): string {
  return TIER_LABEL[tier];
}

// Sandbox and scope, which the approver must always see. The OKed surfaces
// show the tier in the header, so the footnote does not repeat it.
export function footnote(r: Rendered): string {
  return `Sandbox ${truncate(r.sandbox || "unknown", 64)} · approves ${r.scope}`;
}
