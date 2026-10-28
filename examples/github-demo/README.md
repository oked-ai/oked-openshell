# GitHub demo

Files for one sandbox that can call the GitHub REST API, with OKed on `api.github.com`. The [root README](../../README.md) has the full quickstart, the config reference, and the OpenShell 0.1.6 notes.

| File | Role |
|---|---|
| `oked-openshell.yaml` | Service config. Secrets stay in the environment. |
| `gateway.toml` | Block to add to the gateway config. Restart the gateway after you add it. |
| `policy.yaml` | Base policy for a Claude Code sandbox named `demo`. |
| `policy-codex.yaml` | Base policy for a Codex sandbox named `demo-codex`. It allows `/usr/bin/python3.11` to `api.github.com`, because Codex uses Python `urllib`. |
| `profile-github.yaml` | Provider profile `github-test`. REST and GraphQL with `access: full`. No `git push`. |

OpenShell 0.1.6 does not ship profiles in the gateway. Import this one, then create a provider of type `github-test` and attach it to the sandbox. The profile reads `GITHUB_TOKEN` or `GH_TOKEN`. Provider commands are in the [OpenShell profile guide](https://docs.nvidia.com/openshell/v0.1.6/how-it-works/providers/profiles).

```bash
openshell profile import -f examples/github-demo/profile-github.yaml
openshell policy set demo --policy examples/github-demo/policy.yaml --wait
```

`openshell policy update` cannot change middleware. For the Codex policy, use `policy-codex.yaml` and the sandbox name you created.

`deploy/setup-agent.sh demo` writes the reason-code instructions into the sandbox. Codex follows the reason codes without that file.
