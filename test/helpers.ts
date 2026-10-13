// Shared test helpers: fixtures as raw requests.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawRequest } from "../src/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type Fixture = {
  id: string;
  method: string;
  path: string;
  query: string;
  content_type: string;
  body: unknown;
  expect: { operation: string; kind: string; resource: string | null };
};

export const t9 = JSON.parse(readFileSync(join(FIXTURES, "t9-requests.json"), "utf8")) as {
  sandbox_id: string;
  sandbox: string;
  requests: Fixture[];
};

export function fixture(id: string): Fixture {
  const f = t9.requests.find((r) => r.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
}

export function rawFrom(f: Fixture, over: Partial<RawRequest> = {}): RawRequest {
  return {
    sandboxId: t9.sandbox_id,
    sandbox: t9.sandbox,
    scheme: "https",
    host: "api.github.com",
    port: 443,
    method: f.method,
    path: f.path,
    query: f.query,
    headers: f.content_type ? [{ name: "content-type", value: f.content_type }] : [],
    body: f.body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(f.body)),
    ...over,
  };
}

export function raw(over: Partial<RawRequest>): RawRequest {
  return {
    sandboxId: "sbx-1",
    sandbox: "demo",
    scheme: "https",
    host: "api.github.com",
    port: 443,
    method: "GET",
    path: "/",
    query: "",
    headers: [],
    body: Buffer.alloc(0),
    ...over,
  };
}
