#!/bin/sh
set -eu

DIR="${NETPILOT_DIR:-/opt/netpilot}"
BRANCH="${NETPILOT_BRANCH:-main}"

if [ ! -d "$DIR/.git" ]; then
  echo "NetPilot repository not found at $DIR (set NETPILOT_DIR)." >&2
  exit 1
fi

cd "$DIR"
echo ">>> fetching latest code ($BRANCH)"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo ">>> rebuilding and restarting"
docker compose up -d --build

docker image prune -f >/dev/null 2>&1 || true

echo ">>> done"
docker compose ps
