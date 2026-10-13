#!/bin/zsh
# Starts oked-openshell in the foreground. The launchd agent runs this script.
# Usage: deploy/macos/run.sh [config.yaml]
#
# Secrets: put OKED_API_KEY and OKED_GITHUB_READ_TOKEN in ~/.config/oked-openshell/env
# (chmod 600, one NAME=value per line). Without OKED_API_KEY there, the script
# uses the key that `oked init` saved in ~/.oked/config.json.
set -eu
REPO=${0:A:h:h:h}
CONFIG=${1:-$REPO/examples/github-demo/oked-openshell.yaml}
ENV_FILE=${OKED_OPENSHELL_ENV:-$HOME/.config/oked-openshell/env}

if [[ -n ${OKED_NODE_DIR:-} ]]; then
  export PATH="$OKED_NODE_DIR:$PATH"
fi
if [[ -f $ENV_FILE ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
if [[ -z ${OKED_API_KEY:-} && -f $HOME/.oked/config.json ]]; then
  OKED_API_KEY=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).apiKey || "")' "$HOME/.oked/config.json")
  export OKED_API_KEY
fi

cd "$REPO"
exec node_modules/.bin/tsx src/server.ts "$CONFIG"
