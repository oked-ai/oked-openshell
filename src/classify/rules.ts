// Config rules: match on host, method, path regex, operation, kind and field
// conditions (eq, in, regex, gt, lt). No eval.

import type { Condition, Rule } from "../config.js";
import type { Action } from "../types.js";

function list(v: string | string[] | undefined): string[] | null {
  return v === undefined ? null : Array.isArray(v) ? v : [v];
}

// "*" matches any text. Nothing else is special.
function glob(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`, "i");
  return re.test(value);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conditionHolds(c: Condition, action: Action): boolean {
  const v = action.fields[c.field];
  if (v === undefined) return false;
  switch (c.op) {
    case "eq":
      return typeof v === "number" && typeof c.value === "number" ? v === c.value : String(v) === String(c.value);
    case "in":
      return (c.value as (string | number)[]).some((x) => String(x) === String(v));
    case "regex":
      return new RegExp(c.value as string).test(String(v));
    case "gt":
      return Number(v) > (c.value as number);
    case "lt":
      return Number(v) < (c.value as number);
  }
}

export function ruleMatches(rule: Rule, action: Action): boolean {
  const hosts = list(rule.host);
  if (hosts && !hosts.some((h) => glob(h, action.host))) return false;
  const methods = list(rule.method);
  if (methods && !methods.some((m) => m.toUpperCase() === action.method.toUpperCase())) return false;
  if (rule.path && !new RegExp(rule.path).test(action.path)) return false;
  const ops = list(rule.operation);
  if (ops && !ops.some((o) => glob(o, action.operation))) return false;
  if (rule.kind && rule.kind !== action.kind) return false;
  if (rule.when && !rule.when.every((c) => conditionHolds(c, action))) return false;
  return true;
}

export function matchingRules(rules: Rule[], action: Action): Rule[] {
  return rules.filter((r) => ruleMatches(r, action));
}
