# Changelog

## Unreleased

Documentation only. No change to the service.

- Reviewed the vendored middleware proto against OpenShell `v0.1.6` (2026-10-27). `extension.proto` matches. `supervisor_middleware.proto` matches `v0.1.2` and `v0.1.3`. The `v0.1.4` through `v0.1.6` copies add a comment and do not change the messages. Live runs recorded for 0.1.0 remain OpenShell 0.1.2 and 0.1.3.
- Replaced the docs link. `https://docs.nvidia.com/openshell/0.1.2/` returns 404. The versioned docs live under `https://docs.nvidia.com/openshell/v0.1.6/`.
- Documented signup at `https://oked.ai/signup` (no waitlist), Telegram and the web dashboard as the live approval surfaces, and the iPhone app as coming soon.
- Documented Ed25519 receipt checks with `npx @oked/verify` and `https://oked.ai/docs/#verify`.
- Matched the classification order to the code: a matching config rule is applied before the GitHub catalog.
- Noted that OpenShell 0.1.6 does not ship provider profiles in the gateway, and that the demo profile is imported with `openshell profile import -f`.

## 0.1.0 (2026-10-21)

First tagged release. Early preview.

- OpenShell supervisor middleware for action-specific human approval through OKed.
- Covers the GitHub REST API. Routine actions pass. High-stakes actions (for example a merge into `main`) wait for a person's approval.
- The middleware denies a held request with a `reason_code`. The agent sends it again, and the retry passes after approval.
- A local state file keeps retry state across restarts, so a restart never creates a second approval.
- Tested with OpenShell 0.1.2 and 0.1.3.

Known limits at this release: `git push` is not covered, and OpenShell has no "pending" result ([NVIDIA/OpenShell#4406](https://github.com/NVIDIA/OpenShell/issues/4406)).
