// parse: raw request -> Action. A parse error never throws: it gives an opaque
// action with kind "unknown", which classifies as review.

import { GITHUB_HOST, type GithubMatch } from "../catalog/github.js";
import { requestHash } from "../hash.js";
import { redactFields } from "../render/redact.js";
import type { Action, RawRequest } from "../types.js";
import { readGraphqlBody, type GqlRequest } from "./graphql.js";
import { opaqueAction } from "./opaque.js";
import { parseGithubRest } from "./rest.js";
import { sniffBody } from "./sniff.js";

export type Parsed = {
  action: Action;
  github: GithubMatch | null;
  graphql: GqlRequest | null;
};

export function parseRequest(raw: RawRequest): Parsed {
  const base = {
    sandboxId: raw.sandboxId,
    sandbox: raw.sandbox,
    host: raw.host.toLowerCase(),
    method: raw.method,
    path: raw.path,
    requestHash: requestHash(raw),
  };
  try {
    const sniffed = sniffBody(raw.body);
    if (sniffed.kind === "malformed") return opaque(opaqueAction(base, null, "", "unknown"));
    // MCP over HTTP is not parsed yet: a JSON-RPC body is opaque.
    if (sniffed.kind === "json" && isJsonRpc(sniffed.value)) return opaque(opaqueAction(base, sniffed, raw.query));

    if (base.host === GITHUB_HOST && base.method === "POST" && /^\/graphql\/?$/i.test(base.path)) {
      const gql = sniffed.kind === "json" ? readGraphqlBody(sniffed.value) : null;
      if (!gql || !gql.selected) return opaque(opaqueAction(base, null, "", "unknown"));
      return { action: graphqlAction(base, gql), github: null, graphql: gql };
    }

    const rest = parseGithubRest(base, sniffed);
    if (rest) return { ...rest, graphql: null };
    return opaque(opaqueAction(base, sniffed, raw.query));
  } catch {
    return opaque(opaqueAction(base, null, "", "unknown"));
  }
}

function opaque(action: Action): Parsed {
  return { action, github: null, graphql: null };
}

function isJsonRpc(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(isJsonRpc);
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).jsonrpc === "string";
}

function graphqlAction(base: Omit<Action, "protocol" | "operation" | "kind" | "resource" | "fields">, gql: GqlRequest): Action {
  const op = gql.selected!;
  // A document with any mutation is a write, even when the selected operation is a query.
  const kind = gql.firstMutation ? "write" : op.type === "query" ? "read" : "unknown";
  const named = op.type === "mutation" ? op : (gql.firstMutation ?? op);
  const name = (named.name ?? named.rootFields[0] ?? "anonymous").slice(0, 64);
  const entries: [string, unknown][] = [
    ["operation_type", named.type],
    ["root_fields", named.rootFields.join(", ")],
    ...flatten(gql.variables, ""),
  ];
  return {
    ...base,
    protocol: "graphql",
    operation: `github.graphql.${name}`,
    kind,
    resource: null,
    fields: redactFields(entries),
  };
}

// Variables as dotted keys, two levels deep: { input: { title } } -> input.title.
function flatten(obj: Record<string, unknown>, prefix: string, depth = 0): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 1) {
      out.push(...flatten(v as Record<string, unknown>, key, depth + 1));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

