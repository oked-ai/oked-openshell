// Adapter to the OKed classifier (oked-app backend/src/lib/classify.ts, which
// re-exports classify() from @oked/sdk).
//
// Why the adapter is narrow: that classifier reads agent tool calls (a tool
// name and its input), not HTTP requests. For GitHub REST, the catalog and the
// defaults already know more than it does. It fits one case: a GraphQL
// mutation name reads like an MCP tool name (deleteRef -> mcp__github__delete_ref),
// and its verb rules find destructive verbs. A write never goes below review here.

import { classify as okedClassify } from "@oked/sdk";
import { maxTier, type Action, type Tier } from "../types.js";

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// Null when the OKed classifier has nothing to add for this action.
export function okedTier(action: Action): Tier | null {
  if (action.protocol !== "graphql" || action.kind !== "write") return null;
  const name = action.operation.replace(/^github\.graphql\./, "");
  const tier = okedClassify(`mcp__github__${snake(name)}`, {}) as Tier;
  return maxTier(tier, "review");
}
