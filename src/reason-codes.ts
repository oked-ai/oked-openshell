// The only text that reaches the agent. OpenShell drops the free-text `reason`.
// The words control the agent: keep "retry ... every 60s up to 10m"
// in the pending code, or Claude Code stops and asks its user.

export const REASON_CODES = {
  pending: "oked_approval_pending_retry_same_request_every_60s_up_to_10m",
  denied: "oked_denied_by_reviewer_do_not_retry",
  timedOut: "oked_approval_timed_out_ask_your_user",
  unavailable: "oked_unavailable_request_blocked",
} as const;

export type ReasonCodes = { [K in keyof typeof REASON_CODES]: string };

const REASON_CODE_RE = /^[a-z][a-z0-9_]*$/;
const MAX_BYTES = 64;

// OpenShell counts an invalid code as a middleware failure. Check them all at startup.
export function validateReasonCodes(codes: ReasonCodes = REASON_CODES): void {
  for (const [name, code] of Object.entries(codes)) {
    const bytes = Buffer.byteLength(code, "utf8");
    if (bytes < 1 || bytes > MAX_BYTES || !REASON_CODE_RE.test(code)) {
      throw new Error(`reason code "${name}" must match ${REASON_CODE_RE} and be 1 to ${MAX_BYTES} bytes`);
    }
  }
}
