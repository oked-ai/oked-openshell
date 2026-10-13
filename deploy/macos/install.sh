#!/bin/zsh
# Installs and loads the launchd agent for oked-openshell.
# Usage: deploy/macos/install.sh [config.yaml]
# Remove: launchctl bootout gui/$(id -u)/ai.oked.openshell && rm ~/Library/LaunchAgents/ai.oked.openshell.plist
set -eu
REPO=${0:A:h:h:h}
CONFIG=${1:-$REPO/examples/github-demo/oked-openshell.yaml}
CONFIG=${CONFIG:A}
NODE=$(command -v node) || { echo "node is not on PATH" >&2; exit 1; }
DEST=$HOME/Library/LaunchAgents/ai.oked.openshell.plist

sed -e "s|__REPO__|$REPO|g" -e "s|__CONFIG__|$CONFIG|g" -e "s|__NODE_DIR__|${NODE:h}|g" -e "s|__HOME__|$HOME|g" \
  "$REPO/deploy/macos/ai.oked.openshell.plist" > "$DEST"
plutil -lint "$DEST"
JOB="gui/$(id -u)/ai.oked.openshell"
# bootout returns before the old job is gone. A bootstrap before that fails with error 5.
launchctl bootout "$JOB" 2>/dev/null || true
for i in {1..20}; do
  launchctl print "$JOB" >/dev/null 2>&1 || break
  sleep 0.5
done
for i in {1..3}; do
  launchctl bootstrap "gui/$(id -u)" "$DEST" && break
  (( i == 3 )) && { echo "launchctl bootstrap failed" >&2; exit 1; }
  sleep 2
done
echo "Loaded ai.oked.openshell. Log: ~/Library/Logs/oked-openshell.log"
