// Find the body format from the bytes. Never trust content-type:
// `curl -d` sends JSON with the form content type.
// Order: JSON, then form-encoded, then opaque.

export type Sniffed =
  | { kind: "empty" }
  | { kind: "json"; value: unknown }
  | { kind: "form"; params: [string, string][] }
  | { kind: "opaque" } // binary, or text that is not JSON or form
  | { kind: "malformed" }; // looks like JSON but does not parse

const FORM_RE = /^[^=&\s]+(=[^&\s]*)?(&[^=&\s]+(=[^&\s]*)?)*$/;

export function sniffBody(body: Uint8Array): Sniffed {
  if (body.length === 0) return { kind: "empty" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { kind: "opaque" };
  }
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  try {
    return { kind: "json", value: JSON.parse(trimmed) };
  } catch {
    if (/^[{[]/.test(trimmed)) return { kind: "malformed" };
  }
  if (FORM_RE.test(trimmed)) return { kind: "form", params: parseForm(trimmed) };
  return { kind: "opaque" };
}

export function parseForm(text: string): [string, string][] {
  return text
    .split("&")
    .filter((p) => p.length > 0)
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [decode(p), ""] : [decode(p.slice(0, i)), decode(p.slice(i + 1))];
    });
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

// A JSON object body, or the form params as an object. Anything else gives {}.
export function bodyObject(s: Sniffed): Record<string, unknown> {
  if (s.kind === "json" && s.value && typeof s.value === "object" && !Array.isArray(s.value)) {
    return s.value as Record<string, unknown>;
  }
  if (s.kind === "form") return Object.fromEntries(s.params);
  return {};
}
