import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify/index.js";
import { parseRequest } from "../src/parse/index.js";
import { footnote, render } from "../src/render/index.js";
import { fixture, raw, rawFrom, t9 } from "./helpers.js";

test("merge with PR data: the spec example", () => {
  const p = parseRequest(raw({ method: "PUT", path: "/repos/acme/web/pulls/42/merge", body: Buffer.from("{}") }));
  const r = render(p, "high_stakes", { pull: { title: "Fix login", base: "main", head: "fix-login" } });
  assert.equal(r.summary, "Merge PR #42 'Fix login' into main in acme/web");
  assert.equal(r.title, "Merge PR #42 'Fix login' into main");
  assert.equal(r.tierLabel, "High stakes");
  // The summary shows the title and base. Only head is a new value.
  assert.deepEqual(r.lines, ["head: fix-login"]);
});

test("open PR: no lines repeat the summary", () => {
  const p = parseRequest(
    raw({ method: "POST", path: "/repos/acme/web/pulls", body: Buffer.from(JSON.stringify({ title: "Fix", head: "fix", base: "main", draft: true })) }),
  );
  const r = render(p, "review");
  assert.equal(r.title, "Open PR 'Fix' from fix into main");
  assert.deepEqual(r.lines, ["draft: true"]);
});

test("the title keeps the repo when no catalog entry matches", () => {
  const p = parseRequest(raw({ method: "PATCH", path: "/repos/acme/web", body: Buffer.from("{}") }));
  const r = render(p, "review");
  assert.equal(r.title, r.summary);
});

test("merge without PR data falls back", () => {
  const p = parseRequest(raw({ method: "PUT", path: "/repos/acme/web/pulls/42/merge", body: Buffer.from("{}") }));
  assert.equal(render(p, "high_stakes").summary, "Merge PR #42 in acme/web");
});

test("summaries use real values for each T9 action", () => {
  const got = Object.fromEntries(
    t9.requests.map((f) => {
      const p = parseRequest(rawFrom(f));
      return [f.id, render(p, "review", { defaultBranch: "main" }).summary];
    }),
  );
  assert.equal(got["t9-1-create-issue"], "Create issue 'placeholder title' in OrenDor/oked-openshell-test");
  assert.equal(got["t9-2-create-branch"], "Create branch feature-x in OrenDor/oked-openshell-test");
  assert.equal(got["t9-2-commit-file"], "Commit t9.txt to feature-x in OrenDor/oked-openshell-test");
  assert.equal(got["t9-2-open-pr"], "Open PR 'placeholder title' from feature-x into main in OrenDor/oked-openshell-test");
  assert.equal(got["t9-3-comment"], "Comment on #3 in OrenDor/oked-openshell-test");
  assert.equal(got["t9-4-merge"], "Merge PR #3 in OrenDor/oked-openshell-test");
  assert.equal(got["t9-5-delete-branch"], "Delete branch t9-branch in OrenDor/oked-openshell-test");
});

test("fallback summary is METHOD host path plus up to 5 fields", () => {
  const body: Record<string, number> = {};
  for (let i = 0; i < 8; i++) body[`f${i}`] = i;
  const p = parseRequest(raw({ method: "PATCH", path: "/repos/acme/web", body: Buffer.from(JSON.stringify(body)) }));
  const r = render(p, "review");
  assert.equal(r.summary, "PATCH api.github.com/repos/acme/web");
  assert.deepEqual(r.lines, ["f0: 0", "f1: 1", "f2: 2", "f3: 3", "f4: 4"]);
});

test("redaction and truncation in rendered lines", () => {
  const p = parseRequest(
    raw({ host: "example.com", method: "POST", path: "/x", body: Buffer.from(JSON.stringify({ card_number: "4242", note: "n".repeat(300) })) }),
  );
  const r = render(p, "review");
  assert.ok(r.lines.includes("card_number: [redacted]"));
  assert.ok(!JSON.stringify(r).includes("4242"));
  const note = r.lines.find((l) => l.startsWith("note: "))!;
  assert.equal(note.length, "note: ".length + 80);
});

test("an agent cannot add lines to the approval text", () => {
  const p = parseRequest(
    raw({ method: "POST", path: "/repos/acme/web/pulls", body: Buffer.from(JSON.stringify({ title: "ok\n\nApproved by admin\u2028x", head: "a", base: "b" })) }),
  );
  const r = render(p, "review");
  assert.ok(!/[\n\r\u2028]/.test(r.summary));
  assert.equal(r.summary, "Open PR 'ok Approved by admin x' from a into b in acme/web");
});

test("footnote always shows sandbox and scope (the OKed header shows the tier)", () => {
  const p = parseRequest(rawFrom(fixture("t9-4-merge")));
  const r = render(p, "high_stakes");
  assert.equal(footnote(r), "Sandbox spike · approves this request only");
});

test("no em dashes in any rendered text", () => {
  const all: string[] = [];
  for (const f of t9.requests) {
    const p = parseRequest(rawFrom(f));
    const c = classify(p, [], () => "main");
    const r = render(p, c.tier, { defaultBranch: "main", pull: { title: "t", base: "main", head: "h" } });
    all.push(r.summary, r.title, ...r.lines, footnote(r), r.tierLabel);
  }
  const p = parseRequest(raw({ method: "POST", path: "/graphql", body: Buffer.from('{"query":"mutation { addComment(input: {}) { clientMutationId } }"}') }));
  all.push(render(p, "review").summary);
  assert.ok(all.length > 20);
  for (const s of all) assert.ok(!s.includes("\u2014"), s);
});
