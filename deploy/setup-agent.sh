#!/bin/zsh
# Offers the OKed agent instructions (deploy/agent-instructions.md) for a sandbox.
#
# Why: with only the reason code, Claude Code retries in one long shell call and
# stops after 8 to 9 minutes. With these lines it waits the full 10 minutes,
# one tool call per retry (measured with Claude Code 2.1, October 2026).
# Codex follows the reason codes without them.
#
# Usage: deploy/setup-agent.sh <sandbox> [--agent claude|codex] [--file path] [--yes] [--print]
#   --agent  claude (default) writes /sandbox/CLAUDE.md; codex writes /sandbox/AGENTS.md
#   --file   write this file in the sandbox instead
#   --yes    add the lines without a question
#   --print  only show the lines; change nothing
set -eu
HERE=${0:A:h}
INSTRUCTIONS=$HERE/agent-instructions.md
MARKER="<!-- oked-openshell: begin -->"
sandbox="" agent=claude target="" yes=0 print=0
while (( $# > 0 )); do
  case $1 in
    --agent) agent=$2; shift 2 ;;
    --file) target=$2; shift 2 ;;
    --yes) yes=1; shift ;;
    --print) print=1; shift ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) sandbox=$1; shift ;;
  esac
done
case $agent in
  claude) file=/sandbox/CLAUDE.md ;;
  codex) file=/sandbox/AGENTS.md ;;
  *) echo "--agent must be claude or codex" >&2; exit 2 ;;
esac
[[ -n $target ]] && file=$target

echo "These lines tell the agent how to read the OKed reason codes:"
echo
cat "$INSTRUCTIONS"
echo
if (( print )); then exit 0; fi
[[ -n $sandbox ]] || { echo "Name the sandbox: deploy/setup-agent.sh <sandbox>" >&2; exit 2; }
[[ $agent == codex ]] && echo "Note: Codex follows the reason codes without these lines. They are optional for Codex."

export PATH=/opt/homebrew/bin:$PATH
if openshell sandbox exec -n "$sandbox" --no-tty --timeout 60 -- grep -qF "$MARKER" "$file" < /dev/null 2>/dev/null; then
  echo "$file in sandbox $sandbox already has these lines. Nothing to do."
  exit 0
fi
if (( ! yes )); then
  read -q "reply?Add these lines to $file in sandbox $sandbox? [y/N] " || { echo; echo "Nothing changed."; exit 0; }
  echo
fi
{ echo; cat "$INSTRUCTIONS"; } | openshell sandbox exec -n "$sandbox" --no-tty --timeout 60 -- sh -c "cat >> $file"
echo "Added the lines to $file in sandbox $sandbox."
