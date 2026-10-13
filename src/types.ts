// Shared types for the action pipeline: request -> parse -> Action -> classify -> decide.

export type ActionKind = "read" | "write" | "delete" | "unknown";

export type Tier = "safe" | "warning" | "review" | "high_stakes";

export const TIER_ORDER: readonly Tier[] = ["safe", "warning", "review", "high_stakes"];

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

export function needsApproval(tier: Tier): boolean {
  return tier === "review" || tier === "high_stakes";
}

export type FieldValue = string | number | boolean;

export type Action = {
  protocol: "rest" | "graphql" | "opaque";
  sandboxId: string;
  sandbox: string;
  host: string; // lowercased
  method: string;
  path: string;
  operation: string; // e.g. "github.pulls.merge", "http.POST"
  kind: ActionKind;
  resource: string | null; // e.g. "acme/web#42", "acme/web@feature-x"
  fields: Record<string, FieldValue>; // parsed, redacted, max 10
  requestHash: string;
  intent?: string; // reserved, not set yet
};

// The raw request, as the middleware gets it from OpenShell.
export type RawRequest = {
  sandboxId: string;
  sandbox: string;
  scheme: string;
  host: string;
  port: number;
  method: string;
  path: string;
  query: string;
  headers: { name: string; value: string }[];
  body: Uint8Array;
};
