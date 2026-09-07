#!/usr/bin/env bash
# Update a perch install: fetch the latest code, rebuild the image, restart.
# Your .env, your tokens and your downloaded models are untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null; then exec sudo -E "$0" "$@"; fi
[ -f .env ] || { echo "No .env; run ./install.sh first." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yml}"
if command -v podman-compose >/dev/null 2>&1; then COMPOSE_CMD="podman-compose"; else COMPOSE_CMD="podman compose"; fi

if [ -d .git ]; then
  echo "==> fetching"
  git pull --ff-only || { echo "git pull did not fast-forward; sort that out first." >&2; exit 1; }
fi

echo "==> rebuilding"
$COMPOSE_CMD --env-file "$ROOT/.env" build perch

echo "==> pulling the Ollama image"
$COMPOSE_CMD --env-file "$ROOT/.env" pull ollama || true

echo "==> restarting"
$COMPOSE_CMD --env-file "$ROOT/.env" up -d

# The host helper is a file on disk rather than a container, so a code update
# does not reach it until it is restarted.
if systemctl is-active perch-hostd.service >/dev/null 2>&1; then
  echo "==> restarting the host helper"
  systemctl restart perch-hostd.service
fi

echo "==> done"
"$ROOT/bin/perch" status || true
