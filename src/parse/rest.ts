// REST: match the method and path against the GitHub catalog.

import { GITHUB_HOST, matchGithub, type GithubMatch } from "../catalog/github.js";
import { redactFields } from "../render/redact.js";
import type { Action } from "../types.js";
import { bodyObject, type Sniffed } from "./sniff.js";

type Base = Pick<Action, "sandboxId" | "sandbox" | "host" | "method" | "path" | "requestHash">;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Null when the host is not GitHub, or no catalog entry matches.
export function parseGithubRest(base: Base, sniffed: Sniffed): { action: Action; github: GithubMatch | null } | null {
  if (base.host !== GITHUB_HOST) return null;
  if (READ_METHODS.has(base.method)) {
    return {
      action: { ...base, protocol: "rest", operation: "github.read", kind: "read", resource: null, fields: {} },
      github: null,
    };
  }
  const body = bodyObject(sniffed);
  const m = matchGithub(base.method, base.path, body);
  if (!m) return null;
  return {
    action: {
      ...base,
      protocol: "rest",
      operation: m.entry.operation,
      kind: m.entry.kind,
      resource: m.entry.resource(m.facts, {}),
      fields: redactFields(m.entry.fields(m.facts, body).filter(([, v]) => v !== undefined && v !== null)),
    },
    github: m,
  };
}
