// Prints the demo timings from the oked-openshell log (one JSON line per event):
// - first request to notification: the first deny to "approval_created", which
//   OKed sends after it has sent the Telegram message;
// - decision to request: "approval_decided" to the "evaluate" line that allowed it.
// Usage: node examples/github-demo/timings.mjs [log file]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const file = process.argv[2] ?? `${homedir()}/Library/Logs/oked-openshell.log`;
const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l));

const byHash = new Map();
for (const l of lines) {
  if (!l.requestHash) continue;
  const list = byHash.get(l.requestHash) ?? [];
  list.push(l);
  byHash.set(l.requestHash, list);
}

const secs = (a, b) => (a && b ? ((Date.parse(b.ts) - Date.parse(a.ts)) / 1000).toFixed(1) + " s" : "-");

for (const events of byHash.values()) {
  const requested = events.find((e) => e.event === "approval_requested");
  if (!requested) continue;
  const firstDeny = events.find((e) => e.event === "evaluate" && e.decision === "deny");
  const created = events.find((e) => e.event === "approval_created" && e.approvalId) ?? events.find((e) => e.event === "approval_created");
  const decided = events.find((e) => e.event === "approval_decided");
  const allowed = decided && events.find((e) => e.event === "evaluate" && e.decision === "allow" && e.ts >= decided.ts);
  const denies = events.filter((e) => e.event === "evaluate" && e.decision === "deny").length;
  console.log(`${requested.ts}  ${requested.summary}`);
  console.log(`  tier ${requested.tier}, decision ${decided?.decision ?? "none"}, approval ${decided?.approvalId ?? created?.approvalId ?? "-"}`);
  console.log(`  first request -> notification sent: ${secs(firstDeny, created)}`);
  console.log(`  decision -> request allowed:        ${secs(decided, allowed)}`);
  console.log(`  denied evaluations: ${denies}, receipt ${allowed?.receiptId ?? "-"}`);
}
