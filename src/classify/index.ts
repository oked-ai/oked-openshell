// classify: Action -> tier.
// 1. Fast path: a read that no rule matches is safe.
// 2. Catalog tier, with the default-branch checks.
// 3. Config rules. A matching rule wins over the catalog tier. When several
//    rules match, the highest tier wins.
// 4. OKed classifier, for actions with no catalog entry.
// 5. Defaults: write or unknown is review, delete is high_stakes.

import { catalogTier, repoKey } from "../catalog/github.js";
import type { Rule } from "../config.js";
import type { Parsed } from "../parse/index.js";
import { maxTier, type ActionKind, type Tier } from "../types.js";
import { okedTier } from "./oked-adapter.js";
import { matchingRules } from "./rules.js";

export type Classification = {
  tier: Tier;
  source: "fast_path" | "catalog" | "rule" | "oked" | "default";
  rules: string[]; // names of the matching rules
  // The catalog tier depends on the default branch, and it was not known.
  defaultBranchUnknown: boolean;
};

// owner/repo (lowercase) -> default branch, or null when unknown. Never waits.
export type DefaultBranchLookup = (repoKey: string) => string | null;

export function defaultTier(kind: ActionKind): Tier {
  if (kind === "read") return "safe";
  if (kind === "delete") return "high_stakes";
  return "review"; // write, unknown
}

export function classify(parsed: Parsed, rules: Rule[], defaultBranch: DefaultBranchLookup): Classification {
  const { action, github } = parsed;
  const matched = matchingRules(rules, action);
  const names = matched.map((r) => r.name);

  if (action.kind === "read" && matched.length === 0) {
    return { tier: "safe", source: "fast_path", rules: [], defaultBranchUnknown: false };
  }

  if (matched.length > 0) {
    const tier = matched.map((r) => r.tier).reduce(maxTier);
    return { tier, source: "rule", rules: names, defaultBranchUnknown: false };
  }

  if (github) {
    const r = catalogTier(github, defaultBranch(repoKey(github.facts)));
    return { tier: r.tier, source: "catalog", rules: [], defaultBranchUnknown: r.defaultBranchUnknown };
  }

  const oked = okedTier(action);
  if (oked) return { tier: oked, source: "oked", rules: [], defaultBranchUnknown: false };

  return { tier: defaultTier(action.kind), source: "default", rules: [], defaultBranchUnknown: false };
}
