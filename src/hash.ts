// The request hash binds one approval to one exact request from one sandbox.

import { createHash } from "node:crypto";

export function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export type HashInput = {
  sandboxId: string;
  method: string;
  host: string;
  path: string;
  query: string;
  body: Uint8Array;
};

// sha256(sandboxId \n method \n host \n path \n query \n sha256(body)).
// The host is lowercased. The query keeps the order the agent sent.
export function requestHash(r: HashInput): string {
  return sha256hex(
    [r.sandboxId, r.method, r.host.toLowerCase(), r.path, r.query, sha256hex(r.body)].join("\n"),
  );
}
