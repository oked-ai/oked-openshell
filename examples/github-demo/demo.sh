#!/bin/zsh
# GitHub demo: an agent in an OpenShell sandbox, on a
# throwaway repo OrenDor/oked-openshell-test, with OKed as the middleware.
#
# Usage: [AGENT=claude|codex] [SANDBOX=name] examples/github-demo/demo.sh <step>
#   AGENT=claude (default) runs Claude Code in `demo`.
#   AGENT=codex runs Codex in `demo-codex` (policy-codex.yaml).
#   check  show the setup: service, gateway registration, policy
#   1      list open issues             passes, no approval (fast path)
#   2      comment on issue #1          passes, logged as warning
#   3      open a PR from a new branch  one approval, for the PR only
#   4      merge that PR into main      approve it in Telegram
#   5      open and merge a second PR   approve the PR, deny the merge
#   6      re-send a used approval      curl; the second send needs a new approval
#   load   100 parallel reads through OpenShell and the middleware (T7 again)
#   times  timings from the service log
set -eu
export PATH=/opt/homebrew/bin:$PATH
HERE=${0:A:h}
AGENT=${AGENT:-claude}
case $AGENT in
  claude) SANDBOX=${SANDBOX:-demo} ;;
  codex) SANDBOX=${SANDBOX:-demo-codex} ;;
  *) echo "AGENT must be claude or codex" >&2; exit 2 ;;
esac
SLUG=${SLUG:-OrenDor/oked-openshell-test}
LOG=${OKED_LOG:-$HOME/Library/Logs/oked-openshell.log}
STATE_DIR=${STATE_DIR:-$HOME/.cache/oked-openshell-demo}
mkdir -p "$STATE_DIR"

# Codex calls the API with Python, so its prompt does not name curl.
if [[ $AGENT == codex ]]; then
  API="Use the GitHub REST API at https://api.github.com. The token is in the GITHUB_TOKEN environment variable. Do not use git or the gh CLI."
else
  API="Use only curl with the GitHub REST API at https://api.github.com. The token is in the GITHUB_TOKEN environment variable. Do not use git or the gh CLI."
fi

agent() {
  echo "== $(date '+%H:%M:%S') $AGENT prompt: $1"
  if [[ $AGENT == codex ]]; then
    openshell sandbox exec -n "$SANDBOX" --no-tty --timeout 900 -- \
      /sandbox/.npm-global/bin/codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
      -C /sandbox "$1 $API Tell me the result." < /dev/null
  else
    openshell sandbox exec -n "$SANDBOX" --no-tty --timeout 900 -- \
      env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 /sandbox/.npm-global/bin/claude -p "$1 $API Tell me the result." \
      --model sonnet --allowedTools 'Bash(curl:*)' 'Bash(sleep:*)' 'Bash(base64:*)' 'Bash(echo:*)' 'Bash(printf:*)' < /dev/null
  fi
  echo "== $(date '+%H:%M:%S') agent done"
}

# One curl from inside the sandbox. Prints the HTTP status and the reason_code, if any.
sandbox_post() {
  openshell sandbox exec -n "$SANDBOX" --no-tty --timeout 60 -- sh -c \
    "curl -sS -o /tmp/oked-demo-body -w '%{http_code}' -X POST -H \"Authorization: Bearer \$GITHUB_TOKEN\" -d '$2' https://api.github.com$1; echo; grep -o '\"reason_code\":\"[a-z0-9_]*\"' /tmp/oked-demo-body || true" < /dev/null
}

# Sends the same request until it passes or the approver denies it. At most 10 minutes.
send_until_done() {
  local api_path=$1 body=$2 deadline=$(( $(date +%s) + 600 )) out
  while (( $(date +%s) < deadline )); do
    out=$(sandbox_post "$api_path" "$body")
    echo "   $(date '+%H:%M:%S') $(echo $out | tr '\n' ' ')"
    case $out in
      2*) return 0 ;;
      *pending*) sleep 15 ;;
      *) return 1 ;;
    esac
  done
  return 1
}

case ${1:-} in
  check)
    lsof -nP -iTCP:50052 -sTCP:LISTEN || echo "oked-openshell is not running on 127.0.0.1:50052"
    grep -A6 'oked-approval' ~/.config/openshell/gateway.toml || echo "no oked-approval registration"
    openshell policy get "$SANDBOX" | head -5
    ;;
  1) agent "List the open issues in the repo $SLUG." ;;
  2) agent "Add the comment \"OKed demo: a comment\" to issue #1 in the repo $SLUG." ;;
  3)
    branch="oked-$AGENT-$(date +%H%M%S)"
    echo "$branch" > "$STATE_DIR/branch"
    agent "In the repo $SLUG, create a new branch named $branch from main. Add the file $branch.txt with the text \"OKed demo\" to that branch. Then open a pull request from $branch into main with the title \"OKed demo $branch\"."
    ;;
  4)
    branch=$(cat "$STATE_DIR/branch")
    agent "Merge the open pull request from the branch $branch into main in the repo $SLUG."
    ;;
  5)
    branch="oked-$AGENT-deny-$(date +%H%M%S)"
    agent "In the repo $SLUG, create a new branch named $branch from main. Add the file $branch.txt with the text \"OKed deny demo\" to that branch. Then open a pull request from $branch into main with the title \"OKed deny demo $branch\"."
    echo "Now deny the merge in Telegram."
    agent "Merge the open pull request from the branch $branch into main in the repo $SLUG."
    ;;
  6)
    body="{\"title\":\"OKed demo: single use $(date +%H%M%S)\"}"
    echo "First send. Approve it in Telegram."
    send_until_done "/repos/$SLUG/issues" "$body"
    echo "Second send of the same request. Expect a new approval (pending):"
    sandbox_post "/repos/$SLUG/issues" "$body"
    ;;
  load)
    openshell sandbox exec -n "$SANDBOX" --no-tty --timeout 300 -- sh -c \
      "seq 100 | xargs -P 100 -I{} curl -sS -o /dev/null -w '%{http_code} %{time_total}\\n' -H \"Authorization: Bearer \$GITHUB_TOKEN\" 'https://api.github.com/repos/$SLUG/issues?per_page=1&page={}' > /tmp/oked-load.txt 2>&1; cut -d' ' -f1 /tmp/oked-load.txt | sort | uniq -c; sort -k2 -n /tmp/oked-load.txt | tail -1" < /dev/null
    ;;
  times) node "$HERE/timings.mjs" "$LOG" ;;
  *) sed -n 2,18p "$0"; exit 2 ;;
esac
