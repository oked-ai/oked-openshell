// A readable live feed of the oked-openshell log, for the demo recording.
// It shows each write the middleware sees, each approval, and each decision.
// Reads stay out: they pass on the fast path. No values beyond the summary.
// Usage: node examples/github-demo/feed.mjs [log file]

import { createReadStream, statSync, watch } from "node:fs";
import { homedir } from "node:os";

const file = process.argv[2] ?? `${homedir()}/Library/Logs/oked-openshell.log`;
const TIER = { safe: "safe", warning: "warning", review: "review", high_stakes: "high stakes" };
const CODE = {
  oked_approval_pending_retry_same_request_every_60s_up_to_10m: "pending: retry in 60 s",
  oked_denied_by_reviewer_do_not_retry: "denied: do not retry",
  oked_approval_timed_out_ask_your_user: "timed out: ask the user",
  oked_unavailable_request_blocked: "OKed unavailable: blocked",
};
const color = (c, s) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const time = (ts) => color("2", ts.slice(11, 19));

function show(e) {
  if (e.event === "evaluate" && e.kind !== "read") {
    const what = `${e.operation} ${e.resource ?? ""}`.trim();
    if (e.decision === "allow") {
      const why = e.approvalId ? `approved, receipt ${e.receiptId ?? "-"}` : TIER[e.tier];
      console.log(`${time(e.ts)}  ${color("32;1", "ALLOW")}  ${what}  ${color("2", `(${why})`)}`);
    } else {
      console.log(`${time(e.ts)}  ${color("31;1", "DENY ")}  ${what}  ${color("2", `(${CODE[e.reasonCode] ?? e.reasonCode})`)}`);
    }
  } else if (e.event === "approval_requested") {
    console.log(`${time(e.ts)}  ${color("33;1", "ASK  ")}  ${e.summary}  ${color("2", `(${TIER[e.tier]}, sent to Telegram)`)}`);
  } else if (e.event === "approval_decided") {
    const c = e.decision === "approved" ? "32" : "31";
    console.log(`${time(e.ts)}  ${color(c, "HUMAN")}  ${e.decision}  ${color("2", e.receiptId ? `receipt ${e.receiptId}` : "")}`);
  }
}

let pos = statSync(file).size;
let rest = "";
function readNew() {
  const size = statSync(file).size;
  if (size <= pos) return;
  const stream = createReadStream(file, { start: pos, end: size - 1, encoding: "utf8" });
  pos = size;
  stream.on("data", (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) {
      try {
        show(JSON.parse(l));
      } catch {
        // not a JSON line
      }
    }
  });
}
watch(file, readNew);
setInterval(readNew, 500);
