// Redaction and truncation for every value that an approver or a log can see.

import type { FieldValue } from "../types.js";

export const SECRET_KEY_RE = /token|secret|password|key|auth|card|ssn/i;
export const MAX_VALUE_CHARS = 80;
export const MAX_FIELDS = 10;
export const REDACTED = "[redacted]";

// One line, at most 80 characters. Control characters and line breaks become
// spaces, so an agent cannot add fake lines to the approval text.
export function truncate(value: string, max = MAX_VALUE_CHARS): string {
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 3).trimEnd() + "..." : line;
}

export function displayValue(key: string, value: unknown): FieldValue | null {
  if (SECRET_KEY_RE.test(key)) return REDACTED;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    return truncate(value.join(", "));
  }
  return null;
}

// Keep scalar values only, redact secret keys, truncate, and keep at most `max` fields.
export function redactFields(
  entries: Iterable<[string, unknown]>,
  max = MAX_FIELDS,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  let n = 0;
  for (const [rawKey, value] of entries) {
    if (n >= max) break;
    const key = truncate(rawKey, 40);
    if (key === "" || key in out) continue;
    const shown = displayValue(key, value);
    if (shown === null) continue;
    out[key] = shown;
    n++;
  }
  return out;
}
