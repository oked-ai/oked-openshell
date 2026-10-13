// Opaque: no catalog entry. The operation is http.<METHOD>.

import { redactFields } from "../render/redact.js";
import type { Action, ActionKind } from "../types.js";
import { bodyObject, parseForm, type Sniffed } from "./sniff.js";

type Base = Pick<Action, "sandboxId" | "sandbox" | "host" | "method" | "path" | "requestHash">;

// Only the exact read methods are reads. A method such as "get" is a write.
export function methodKind(method: string): ActionKind {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
  if (method.toUpperCase() === "DELETE") return "delete";
  return "write";
}

export function opaqueAction(base: Base, sniffed: Sniffed | null, query: string, kind?: ActionKind): Action {
  const entries: [string, unknown][] = sniffed ? Object.entries(bodyObject(sniffed)) : [];
  if (query) entries.push(...parseForm(query).map(([k, v]): [string, unknown] => [`?${k}`, v]));
  return {
    ...base,
    protocol: "opaque",
    operation: `http.${base.method.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 16) || "UNKNOWN"}`,
    kind: kind ?? methodKind(base.method),
    resource: null,
    fields: redactFields(entries),
  };
}
