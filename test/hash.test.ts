import { test } from "node:test";
import assert from "node:assert/strict";
import { requestHash, sha256hex, type HashInput } from "../src/hash.js";
import { REASON_CODES, validateReasonCodes } from "../src/reason-codes.js";

const base: HashInput = {
  sandboxId: "400e804a-b9e4-4faa-a5f1-a5dbe5f4c9cf",
  method: "PUT",
  host: "api.github.com",
  path: "/repos/acme/web/pulls/42/merge",
  query: "",
  body: Buffer.from("{}"),
};

test("hash is stable and matches the spec formula", () => {
  const h = requestHash(base);
  assert.equal(h, requestHash({ ...base, body: Buffer.from("{}") }));
  const expected = sha256hex(
    [base.sandboxId, "PUT", "api.github.com", base.path, "", sha256hex(Buffer.from("{}"))].join("\n"),
  );
  assert.equal(h, expected);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("hash lowercases the host", () => {
  assert.equal(requestHash(base), requestHash({ ...base, host: "API.GitHub.com" }));
});

test("hash changes with every part, including sandboxId", () => {
  const h = requestHash(base);
  const variants: Partial<HashInput>[] = [
    { sandboxId: "other-sandbox" },
    { method: "POST" },
    { host: "uploads.github.com" },
    { path: "/repos/acme/web/pulls/43/merge" },
    { query: "a=1" },
    { body: Buffer.from('{"merge_method":"squash"}') },
    { body: Buffer.alloc(0) },
  ];
  for (const v of variants) assert.notEqual(requestHash({ ...base, ...v }), h, JSON.stringify(Object.keys(v)));
});

test("hash keeps the query order", () => {
  assert.notEqual(requestHash({ ...base, query: "a=1&b=2" }), requestHash({ ...base, query: "b=2&a=1" }));
});

test("all reason codes are valid", () => {
  validateReasonCodes();
  assert.equal(REASON_CODES.pending.length, 60);
  assert.equal(REASON_CODES.denied.length, 36);
  assert.equal(REASON_CODES.timedOut.length, 37);
  assert.equal(REASON_CODES.unavailable.length, 32);
});

test("an invalid reason code fails validation", () => {
  assert.throws(() => validateReasonCodes({ ...REASON_CODES, denied: "Denied-By-Reviewer" }));
  assert.throws(() => validateReasonCodes({ ...REASON_CODES, pending: "a".repeat(65) }));
  assert.throws(() => validateReasonCodes({ ...REASON_CODES, timedOut: "" }));
  assert.throws(() => validateReasonCodes({ ...REASON_CODES, unavailable: "9_starts_with_digit" }));
});
