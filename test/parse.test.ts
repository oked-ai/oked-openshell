import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest } from "../src/parse/index.js";
import { sniffBody } from "../src/parse/sniff.js";
import { fixture, raw, rawFrom, t9 } from "./helpers.js";

test("each T9 request maps to the right operation, kind and resource", () => {
  for (const f of t9.requests) {
    const { action } = parseRequest(rawFrom(f));
    assert.equal(action.operation, f.expect.operation, f.id);
    assert.equal(action.kind, f.expect.kind, f.id);
    assert.equal(action.resource, f.expect.resource, f.id);
    assert.equal(action.sandboxId, t9.sandbox_id);
    assert.equal(action.sandbox, "spike");
    assert.match(action.requestHash, /^[0-9a-f]{64}$/);
  }
});

test("JSON sent with the form content type is read as JSON", () => {
  const f = fixture("t9-2-open-pr");
  assert.equal(f.content_type, "application/x-www-form-urlencoded");
  const { action } = parseRequest(rawFrom(f));
  assert.equal(action.protocol, "rest");
  assert.deepEqual(action.fields, { title: "placeholder title", head: "feature-x", base: "main" });
});

test("sniff ignores content type: JSON, then form, then opaque", () => {
  assert.equal(sniffBody(Buffer.from('{"a":1}')).kind, "json");
  assert.equal(sniffBody(Buffer.from("  [1,2]  ")).kind, "json");
  assert.deepEqual(sniffBody(Buffer.from("title=Fix+login&base=main")), {
    kind: "form",
    params: [
      ["title", "Fix login"],
      ["base", "main"],
    ],
  });
  assert.equal(sniffBody(Buffer.from("hello world")).kind, "opaque");
  assert.equal(sniffBody(Buffer.from([0xff, 0xfe, 0x00])).kind, "opaque");
  assert.equal(sniffBody(Buffer.from('{"title": "x"')).kind, "malformed");
  assert.equal(sniffBody(Buffer.alloc(0)).kind, "empty");
});

test("a form-encoded body gives fields too", () => {
  const { action } = parseRequest(
    raw({ method: "POST", path: "/repos/acme/web/pulls", body: Buffer.from("title=Fix+login&head=fx&base=main") }),
  );
  assert.equal(action.operation, "github.pulls.create");
  assert.deepEqual(action.fields, { title: "Fix login", head: "fx", base: "main" });
});

test("a malformed body becomes an opaque action with kind unknown", () => {
  const { action } = parseRequest(
    raw({ method: "POST", path: "/repos/acme/web/issues", body: Buffer.from('{"title": "x"') }),
  );
  assert.equal(action.protocol, "opaque");
  assert.equal(action.kind, "unknown");
  assert.equal(action.operation, "http.POST");
});

test("GraphQL query is a read, mutation is a write", () => {
  const q = parseRequest(
    raw({ method: "POST", path: "/graphql", body: Buffer.from(JSON.stringify({ query: "query Viewer { viewer { login } }" })) }),
  );
  assert.equal(q.action.protocol, "graphql");
  assert.equal(q.action.kind, "read");
  assert.equal(q.action.operation, "github.graphql.Viewer");

  const shorthand = parseRequest(raw({ method: "POST", path: "/graphql", body: Buffer.from('{"query":"{ viewer { login } }"}') }));
  assert.equal(shorthand.action.kind, "read");
  assert.equal(shorthand.action.operation, "github.graphql.viewer");

  const m = parseRequest(
    raw({
      method: "POST",
      path: "/graphql",
      body: Buffer.from(
        JSON.stringify({
          query: "mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }",
          variables: { input: { pullRequestId: "PR_abc", mergeMethod: "SQUASH" } },
        }),
      ),
    }),
  );
  assert.equal(m.action.kind, "write");
  assert.equal(m.action.operation, "github.graphql.mergePullRequest");
  assert.equal(m.action.fields["input.pullRequestId"], "PR_abc");
  assert.equal(m.action.fields.operation_type, "mutation");
});

test("a GraphQL document with any mutation is a write, even if a query is selected", () => {
  const { action } = parseRequest(
    raw({
      method: "POST",
      path: "/graphql",
      body: Buffer.from(
        JSON.stringify({
          query: "query A { viewer { login } } mutation B { deleteRef(input: {refId: \"x\"}) { clientMutationId } }",
          operationName: "A",
        }),
      ),
    }),
  );
  assert.equal(action.kind, "write");
  assert.equal(action.operation, "github.graphql.B");
});

test("a POST to /graphql that is not GraphQL is unknown", () => {
  const { action } = parseRequest(raw({ method: "POST", path: "/graphql", body: Buffer.from('{"nope":1}') }));
  assert.equal(action.kind, "unknown");
});

test("opaque: method gives the kind, other writes are http.<METHOD>", () => {
  const get = parseRequest(raw({ host: "example.com", method: "GET", path: "/x" })).action;
  assert.deepEqual([get.operation, get.kind, get.protocol], ["http.GET", "read", "opaque"]);
  const del = parseRequest(raw({ host: "example.com", method: "DELETE", path: "/x" })).action;
  assert.deepEqual([del.operation, del.kind], ["http.DELETE", "delete"]);
  const patch = parseRequest(raw({ method: "PATCH", path: "/repos/acme/web", body: Buffer.from('{"private":false}') })).action;
  assert.deepEqual([patch.operation, patch.kind, patch.resource], ["http.PATCH", "write", null]);
  assert.equal(patch.fields.private, false);
  // Only exact read methods are reads.
  assert.equal(parseRequest(raw({ method: "get", path: "/x" })).action.kind, "write");
});

test("an MCP JSON-RPC body falls to opaque", () => {
  const { action } = parseRequest(
    raw({
      host: "api.githubcopilot.com",
      method: "POST",
      path: "/mcp/",
      body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "merge_pull_request" } })),
    }),
  );
  assert.equal(action.protocol, "opaque");
  assert.equal(action.kind, "write");
});

test("the host is lowercased and catalog paths tolerate case and a trailing slash", () => {
  const { action } = parseRequest(raw({ host: "API.GitHub.com", method: "PUT", path: "/Repos/acme/web/pulls/7/merge/" }));
  assert.equal(action.host, "api.github.com");
  assert.equal(action.operation, "github.pulls.merge");
  assert.equal(action.resource, "acme/web#7");
});

test("branch names with slashes and percent-encoding", () => {
  const del = parseRequest(raw({ method: "DELETE", path: "/repos/acme/web/git/refs/heads/feature/login-fix" })).action;
  assert.equal(del.resource, "acme/web@feature/login-fix");
  const put = parseRequest(
    raw({ method: "PUT", path: "/repos/acme/web/contents/docs/my%20file.md", body: Buffer.from('{"message":"m","content":"","branch":"fx"}') }),
  ).action;
  assert.equal(put.fields.path, "docs/my file.md");
});

test("fields are redacted, truncated and limited to 10", () => {
  const body: Record<string, unknown> = { api_token: "ghp_secret", Password: "p", title: "t".repeat(200) };
  for (let i = 0; i < 20; i++) body[`f${i}`] = i;
  const { action } = parseRequest(raw({ host: "example.com", method: "POST", path: "/x", body: Buffer.from(JSON.stringify(body)) }));
  assert.equal(action.fields.api_token, "[redacted]");
  assert.equal(action.fields.Password, "[redacted]");
  assert.equal(String(action.fields.title).length, 80);
  assert.equal(Object.keys(action.fields).length, 10);
  assert.ok(!JSON.stringify(action).includes("ghp_secret"));
});

test("a parse error never throws", () => {
  const { action } = parseRequest(raw({ method: "POST", path: "/graphql", body: Buffer.from("{".repeat(100000)) }));
  assert.equal(action.kind, "unknown");
});
