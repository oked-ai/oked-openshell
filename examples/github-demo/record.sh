#!/bin/zsh
# Records demo steps 3 to 5 from a real run, then makes a GIF.
# Needs asciinema and agg (brew install asciinema agg), and you at the phone:
# approve the PR, approve the merge, approve the second PR, deny its merge.
#
# Usage: [AGENT=claude|codex] [STEPS="3 4 5"] examples/github-demo/record.sh [output.gif]
set -eu
export PATH=/opt/homebrew/bin:$PATH
HERE=${0:A:h}
AGENT=${AGENT:-claude}
OUT=${1:-$HERE/demo-$AGENT.gif}
CAST=${OUT:r}.cast

if [[ ${OKED_RECORDING:-} != 1 ]]; then
  OKED_RECORDING=1 asciinema rec --headless --overwrite --window-size 140x36 --command "zsh $0 $OUT" "$CAST"
  agg --idle-time-limit 2 --speed 1.5 --font-size 16 "$CAST" "$OUT"
  echo "GIF: $OUT"
  exit 0
fi

# Inside the recording. A headless recording has no TERM.
export TERM=${TERM:-xterm-256color} FORCE_COLOR=1
printf '\033[2J\033[H'
print -P "%BOKed x OpenShell: action approval for an agent ($AGENT)%b"
echo "Live feed: what the OKed middleware decides. Lines with > show the task and the agent's answer."
echo
node "$HERE/feed.mjs" &
feed=$!
trap 'kill $feed 2>/dev/null' EXIT
for step in ${=STEPS:-3 4 5}; do
  AGENT=$AGENT "$HERE/demo.sh" $step 2>&1 | grep -v '^Now deny' | sed -E 's/^== [0-9:]+ [a-z]+ prompt: /\n> /; /^== [0-9:]+ agent done/d'
  echo
done
sleep 3
