# Changelog

## 0.1.0 (2026-10-21)

First tagged release. Early preview.

- OpenShell supervisor middleware for action-specific human approval through OKed.
- Covers the GitHub REST API. Routine actions pass. High-stakes actions (for example a merge into `main`) wait for a person's approval.
- The middleware denies a held request with a `reason_code`. The agent sends it again, and the retry passes after approval.
- A local state file keeps retry state across restarts, so a restart never creates a second approval.
- Tested with OpenShell 0.1.2 and 0.1.3.

Known limits: `git push` is not covered, and OpenShell has no "pending" result ([NVIDIA/OpenShell#4406](https://github.com/NVIDIA/OpenShell/issues/4406)).
