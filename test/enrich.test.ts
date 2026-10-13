import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { GithubEnricher } from "../src/enrich/github.js";
import { GITHUB_TOKEN, startMockGithub, type MockGithub } from "./mock-github.js";

let gh: MockGithub;
const events: unknown[] = [];

before(async () => {
  gh = await startMockGithub();
});
after(() => gh.close());
beforeEach(() => {
  gh.calls.length = 0;
  gh.delayMs = 0;
  gh.fail = false;
  events.length = 0;
});

function enricher(token: string | null = GITHUB_TOKEN, timeoutMs = 2000, now?: () => number) {
  return new GithubEnricher({ apiUrl: gh.url, token, timeoutMs, now, onLookup: (e) => events.push(e) });
}

test("success: PR title, base and head; default branch; both cached", async () => {
  gh.pulls[42] = { title: "Fix login", base: "main", head: "fix-login" };
  const e = enricher();
  assert.deepEqual(await e.pull("acme", "web", 42), { title: "Fix login", base: "main", head: "fix-login" });
  assert.deepEqual(await e.pull("acme", "web", 42), { title: "Fix login", base: "main", head: "fix-login" });
  assert.equal(e.cachedDefaultBranch("acme/web"), null);
  assert.equal(await e.defaultBranch("Acme", "Web"), "main");
  assert.equal(e.cachedDefaultBranch("acme/web"), "main");
  assert.deepEqual(gh.calls, ["/repos/acme/web/pulls/42", "/repos/Acme/Web"]);
});

test("cache: default branch for 10 minutes, PR data for 1 minute", async () => {
  let t = 0;
  gh.pulls[7] = { title: "t", base: "main", head: "h" };
  const e = enricher(GITHUB_TOKEN, 2000, () => t);
  await e.defaultBranch("acme", "web");
  await e.pull("acme", "web", 7);
  t += 59_000;
  await e.defaultBranch("acme", "web");
  await e.pull("acme", "web", 7);
  assert.equal(gh.calls.length, 2);
  t += 2_000;
  await e.pull("acme", "web", 7);
  assert.equal(gh.calls.length, 3);
  t += 10 * 60_000;
  // Expired: a new lookup. (cachedDefaultBranch would also use the last known value.)
  await e.defaultBranch("acme", "web");
  assert.equal(gh.calls.length, 4);
});

test("parallel lookups for the same repo make one call", async () => {
  gh.delayMs = 50;
  const e = enricher();
  const all = await Promise.all([e.defaultBranch("a", "b"), e.defaultBranch("a", "b"), e.defaultBranch("A", "B")]);
  assert.deepEqual(all, ["main", "main", "main"]);
  assert.equal(gh.calls.length, 1);
});

test("timeout falls back to unknown within the time limit", async () => {
  gh.delayMs = 500;
  const e = enricher(GITHUB_TOKEN, 100);
  const t0 = Date.now();
  assert.equal(await e.pull("acme", "web", 1), null);
  assert.ok(Date.now() - t0 < 400, "stops at the timeout");
  assert.equal(await e.defaultBranch("acme", "web2"), null);
});

test("failure falls back to unknown", async () => {
  gh.fail = true;
  const e = enricher();
  assert.equal(await e.defaultBranch("acme", "web"), null);
  assert.equal(await e.pull("acme", "web", 1), null);
  assert.equal(await e.pull("acme", "web", 999), null);
});

test("no token: no network call, unknown", async () => {
  const e = enricher(null);
  e.warmDefaultBranch("acme", "web");
  assert.equal(await e.defaultBranch("acme", "web"), null);
  assert.equal(await e.pull("acme", "web", 1), null);
  assert.equal(gh.calls.length, 0);
  assert.equal(e.enabled, false);
});

test("the token never appears in lookup events", async () => {
  gh.fail = true;
  const e = enricher();
  await e.defaultBranch("acme", "web");
  gh.fail = false;
  await e.defaultBranch("acme", "other");
  assert.ok(events.length >= 2);
  assert.ok(!JSON.stringify(events).includes(GITHUB_TOKEN));
});

test("after 10 minutes the last known default branch is used while it refreshes, up to 24 hours", async () => {
  let t = 0;
  const e = enricher(GITHUB_TOKEN, 2000, () => t);
  await e.defaultBranch("acme", "web");
  assert.equal(gh.calls.length, 1);
  t += 11 * 60_000;
  assert.equal(e.cachedDefaultBranch("acme/web"), "main", "stale but usable");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gh.calls.length, 2, "a background refresh started");
  assert.equal(e.cachedDefaultBranch("acme/web"), "main");
  assert.equal(gh.calls.length, 2, "fresh again: no second refresh");

  // A failed refresh does not erase the last known value.
  t += 11 * 60_000;
  gh.fail = true;
  assert.equal(e.cachedDefaultBranch("acme/web"), "main");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(e.cachedDefaultBranch("acme/web"), "main");

  t += 25 * 60 * 60_000;
  assert.equal(e.cachedDefaultBranch("acme/web"), null, "older than 24 hours: unknown");
});
