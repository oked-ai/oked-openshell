import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, type DefaultBranchLookup } from "../src/classify/index.js";
import { parseConfig, type Rule } from "../src/config.js";
import { parseRequest } from "../src/parse/index.js";
import { fixture, raw, rawFrom } from "./helpers.js";

const known: DefaultBranchLookup = (repo) => (repo === "orendor/oked-openshell-test" || repo === "acme/web" ? "main" : null);
const unknown: DefaultBranchLookup = () => null;

function tierOf(r: ReturnType<typeof raw>, lookup = known, rules: Rule[] = []) {
  return classify(parseRequest(r), rules, lookup);
}

function rulesFrom(yaml: string): Rule[] {
  return parseConfig(`approvers: { default: g }\nrules:\n${yaml}`, { OKED_API_KEY: "k" }).config.rules;
}

test("fast path: a read with no matching rule is safe", () => {
  for (const id of ["t9-2-read-main-ref", "t9-3-list-prs", "t9-4-list-prs-by-base"]) {
    const c = classify(parseRequest(rawFrom(fixture(id))), [], () => {
      throw new Error("the fast path must not look up the default branch");
    });
    assert.deepEqual([c.tier, c.source], ["safe", "fast_path"], id);
  }
  const gql = tierOf(raw({ method: "POST", path: "/graphql", body: Buffer.from('{"query":"{ viewer { login } }"}') }));
  assert.equal(gql.tier, "safe");
});

test("feature-branch setup writes are warning, so opening a PR needs one approval", () => {
  const tiers = ["t9-2-read-main-ref", "t9-2-create-branch", "t9-2-commit-file", "t9-2-open-pr"].map(
    (id) => classify(parseRequest(rawFrom(fixture(id))), [], known).tier,
  );
  assert.deepEqual(tiers, ["safe", "warning", "warning", "review"]);
});

test("the same setup writes on the default branch are review", () => {
  const ref = rawFrom(fixture("t9-2-create-branch"), { body: Buffer.from('{"ref":"refs/heads/main","sha":"0"}') });
  assert.equal(tierOf(ref).tier, "review");
  const put = rawFrom(fixture("t9-2-commit-file"), { body: Buffer.from('{"message":"m","content":"","branch":"main"}') });
  assert.equal(tierOf(put).tier, "review");
  // No branch: GitHub commits to the default branch.
  const noBranch = rawFrom(fixture("t9-2-commit-file"), { body: Buffer.from('{"message":"m","content":""}') });
  assert.equal(tierOf(noBranch).tier, "review");
});

test("an unknown default branch uses the stricter tier", () => {
  const ref = tierOf(rawFrom(fixture("t9-2-create-branch")), unknown);
  assert.deepEqual([ref.tier, ref.defaultBranchUnknown], ["review", true]);
  const put = tierOf(rawFrom(fixture("t9-2-commit-file")), unknown);
  assert.deepEqual([put.tier, put.defaultBranchUnknown], ["review", true]);
  const del = tierOf(rawFrom(fixture("t9-5-delete-branch")), unknown);
  assert.deepEqual([del.tier, del.defaultBranchUnknown], ["high_stakes", true]);
});

test("merge is high_stakes, comment is warning, issue and PR are review", () => {
  assert.equal(tierOf(rawFrom(fixture("t9-4-merge"))).tier, "high_stakes");
  assert.equal(tierOf(rawFrom(fixture("t9-4-merge")), unknown).tier, "high_stakes");
  assert.equal(tierOf(rawFrom(fixture("t9-3-comment"))).tier, "warning");
  assert.equal(tierOf(rawFrom(fixture("t9-1-create-issue"))).tier, "review");
  assert.equal(tierOf(rawFrom(fixture("t9-2-open-pr"))).tier, "review");
});

test("branch delete is review, or high_stakes on the default branch", () => {
  assert.equal(tierOf(rawFrom(fixture("t9-5-delete-branch"))).tier, "review");
  assert.equal(tierOf(raw({ method: "DELETE", path: "/repos/acme/web/git/refs/heads/main" })).tier, "high_stakes");
});

test("a tag is not a setup write", () => {
  const tag = raw({ method: "POST", path: "/repos/acme/web/git/refs", body: Buffer.from('{"ref":"refs/tags/v1","sha":"0"}') });
  assert.equal(tierOf(tag).tier, "review");
});

test("defaults: unknown write is review, delete is high_stakes", () => {
  assert.equal(tierOf(raw({ method: "PATCH", path: "/repos/acme/web", body: Buffer.from('{"private":false}') })).tier, "review");
  assert.equal(tierOf(raw({ method: "DELETE", path: "/repos/acme/web" })).tier, "high_stakes");
  assert.equal(tierOf(raw({ method: "POST", path: "/repos/acme/web/issues", body: Buffer.from("{bad") })).tier, "review");
  assert.equal(tierOf(raw({ host: "example.com", method: "POST", path: "/x" })).tier, "review");
});

test("OKed classifier adapter: a destructive GraphQL mutation is high_stakes", () => {
  const del = tierOf(
    raw({ method: "POST", path: "/graphql", body: Buffer.from('{"query":"mutation { deleteRef(input: {refId: \\"x\\"}) { clientMutationId } }"}') }),
  );
  assert.deepEqual([del.tier, del.source], ["high_stakes", "oked"]);
  // A write never goes below review, also when the verb looks harmless.
  const mark = tierOf(
    raw({ method: "POST", path: "/graphql", body: Buffer.from('{"query":"mutation { markPullRequestReadyForReview(input: {}) { clientMutationId } }"}') }),
  );
  assert.equal(mark.tier, "review");
});

test("rules: field conditions, and the highest matching tier wins", () => {
  const rules = rulesFrom(`
  - name: protect-main
    host: api.github.com
    when: [{ field: base, op: eq, value: main }]
    tier: high_stakes
  - name: prs-review
    operation: "github.pulls.*"
    tier: review
  - name: quiet-markdown
    method: POST
    path: "^/markdown$"
    tier: safe
`);
  const pr = tierOf(rawFrom(fixture("t9-2-open-pr")), known, rules);
  assert.deepEqual([pr.tier, pr.source, pr.rules], ["high_stakes", "rule", ["protect-main", "prs-review"]]);
  const prDev = tierOf(raw({ method: "POST", path: "/repos/acme/web/pulls", body: Buffer.from('{"title":"t","head":"a","base":"dev"}') }), known, rules);
  assert.deepEqual([prDev.tier, prDev.rules], ["review", ["prs-review"]]);
  const md = tierOf(raw({ method: "POST", path: "/markdown", body: Buffer.from('{"text":"x"}') }), known, rules);
  assert.equal(md.tier, "safe");
});

test("rules: in, regex, gt, lt, kind, and a rule that matches a read", () => {
  const rules = rulesFrom(`
  - name: big
    host: example.com
    when: [{ field: amount, op: gt, value: 100 }, { field: currency, op: in, value: [usd, eur] }]
    tier: high_stakes
  - name: small
    host: example.com
    when: [{ field: amount, op: lt, value: 10 }]
    tier: warning
  - name: secret-reads
    kind: read
    path: "^/repos/acme/secret/"
    tier: review
  - name: refs
    host: "*.example.com"
    when: [{ field: ref, op: regex, value: "^release/" }]
    tier: high_stakes
`);
  const body = (o: unknown) => Buffer.from(JSON.stringify(o));
  assert.equal(tierOf(raw({ host: "example.com", method: "POST", path: "/pay", body: body({ amount: 500, currency: "usd" }) }), known, rules).tier, "high_stakes");
  assert.equal(tierOf(raw({ host: "example.com", method: "POST", path: "/pay", body: body({ amount: 500, currency: "jpy" }) }), known, rules).tier, "review");
  assert.equal(tierOf(raw({ host: "example.com", method: "POST", path: "/pay", body: body({ amount: 5 }) }), known, rules).tier, "warning");
  assert.equal(tierOf(raw({ path: "/repos/acme/secret/contents/a" }), known, rules).tier, "review");
  assert.equal(tierOf(raw({ host: "api.example.com", method: "POST", path: "/x", body: body({ ref: "release/1" }) }), known, rules).tier, "high_stakes");
});
