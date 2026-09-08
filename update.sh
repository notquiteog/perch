#!/usr/bin/env bash
# Update a perch install: fetch the latest code, rebuild the image, restart.
# Your .env, your tokens and your downloaded models are untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# Become root, but not with the invoking user's home.
#
# `sudo -E` alone preserves HOME, and podman reads ~/.config/containers/storage.conf
# to decide which storage it addresses. On a machine where the user has one —
# common, and the default on some desktops — root's podman then operates on
# that user's *rootless* store instead of the root store the installer built
# the containers in. Nothing errors: `up` cheerfully builds a second, parallel
# stack, `logs` and `status` report on containers that are not the ones
# serving, and the two sets fight over the same ports.
#
# -E is kept, because PERCH_* overrides passed on the command line should
# survive. HOME and the XDG variables that redirect container storage do not.
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null; then
  exec sudo -E env -u XDG_RUNTIME_DIR -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME=/root "$0" "$@"
fi
[ -f .env ] || { echo "No .env; run ./install.sh first." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yml}"
if command -v podman-compose >/dev/null 2>&1; then COMPOSE_CMD="podman-compose"; else COMPOSE_CMD="podman compose"; fi

# A working copy with local changes is not a broken install, it is somebody
# mid-edit — which is exactly when an update gets run to try the change. So a
# dirty tree skips the pull and carries on with what is on disk, rather than
# refusing to do the rest.
if [ -d .git ]; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "==> local changes here, so not fetching; building what is on disk"
  elif ! git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    echo "==> no upstream branch, so nothing to fetch"
  else
    echo "==> fetching"
    git pull --ff-only || { echo "git pull did not fast-forward; sort that out first." >&2; exit 1; }
  fi
fi

echo "==> rebuilding"
$COMPOSE_CMD --env-file "$ROOT/.env" build perch

echo "==> pulling images"
$COMPOSE_CMD --env-file "$ROOT/.env" pull || true

echo "==> starting anything that is not running"
$COMPOSE_CMD --env-file "$ROOT/.env" up -d

# The step that makes this an update rather than a no-op.
#
# `up -d` only recreates a container when the service's *configuration*
# changed. A rebuilt image under the same tag is not a configuration change, so
# without this the two commands above would report a successful update and
# leave every container running the code it was already running.
echo "==> recreating whatever is behind its image"
"$ROOT/bin/perch" refresh

# The host helper is a file on disk rather than a container, so a code update
# does not reach it until it is restarted.
if systemctl is-active perch-hostd.service >/dev/null 2>&1; then
  echo "==> restarting the host helper"
  systemctl restart perch-hostd.service
fi

echo "==> done"
"$ROOT/bin/perch" status || true
