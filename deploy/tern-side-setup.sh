#!/usr/bin/env bash
# =============================================================================
# Run this on the machine that runs Tern. It is the other half of the tunnel.
#
#   sudo bash tern-side-setup.sh --key "ssh-ed25519 AAAA... perch@yourbox"
#
# The perch console generates the exact command with your key already in it —
# Connect → "On the Tern box, run this". This file is that command's script,
# kept in the repo so you can read it before you paste it, which is a habit
# worth keeping for anything that asks for sudo.
#
# What it does:
#   1. Creates a locked-down "perch" account whose only ability is to hold
#      open one reverse port forward. No shell, no password, no file access.
#   2. Installs your perch box's public key with restrictions, so that key can
#      bind one address and one port and do nothing else.
#   3. Teaches sshd to hang up on tunnels that died, so the port is free when
#      the tunnel comes back.
#   4. Works out the address Tern's container can reach, and prints the base
#      URL to paste into Tern's Admin → AI model page.
#
# What it is careful about:
#   * It never binds a public address. If the address it works out is not a
#     private one, it stops rather than putting your model endpoint on the
#     internet.
#   * It validates the sshd configuration with `sshd -t` before asking sshd to
#     read it, and it reloads rather than restarts, so an existing SSH session
#     — the one you are typing in — survives either way.
#   * Everything it writes is a separate file it owns. Your sshd_config is not
#     edited.
# =============================================================================
set -euo pipefail

PUBKEY=""
TUNNEL_USER="perch"
PORT="11434"
BIND=""
NETWORK=""
ASSUME_HOST=0

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Options:
  --key "<ssh-ed25519 ...>"  the perch box's public key (required)
  --user <name>              account to create for the tunnel (default: perch)
  --port <n>                 port the model endpoint lands on here (default: 11434)
  --bind <ip>                address to bind, if you would rather choose it
  --network <name>           Tern's podman network (default: detected)
  --host-tern                Tern runs on the host, not in a container
  --uninstall                remove the account, its key and the sshd drop-in
USAGE
}

UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --key) PUBKEY="${2:-}"; shift 2 ;;
    --user) TUNNEL_USER="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --bind) BIND="${2:-}"; shift 2 ;;
    --network) NETWORK="${2:-}"; shift 2 ;;
    --host-tern) ASSUME_HOST=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else B=; D=; G=; Y=; R=; C=; N=; fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

SSHD_DROPIN="/etc/ssh/sshd_config.d/50-perch.conf"

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  step "Removing the perch tunnel account and configuration"
  rm -f "$SSHD_DROPIN" && ok "removed $SSHD_DROPIN"
  if id "$TUNNEL_USER" >/dev/null 2>&1; then
    userdel -r "$TUNNEL_USER" 2>/dev/null || userdel "$TUNNEL_USER" 2>/dev/null || true
    ok "removed the $TUNNEL_USER account"
  fi
  if sshd -t 2>/dev/null; then systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true; ok "sshd reloaded"; fi
  exit 0
fi

[ -n "$PUBKEY" ] || die "--key is required. Copy it from the perch console, under Connect."
case "$PUBKEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) ;;
  *) die "that does not look like an SSH public key." ;;
esac
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "--port must be a port number."
[[ "$TUNNEL_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--user is not a valid account name."

# ---------- work out where the tunnel should land ----------
#
# Tern runs in a podman container, so a port bound to this machine's 127.0.0.1
# is not reachable from inside it: loopback in a container is the container.
# The address that is reachable is the host's own address on the podman bridge
# Tern's containers are attached to — the same one they know as
# host.containers.internal.

is_private_ip() {
  local ip="$1"
  case "$ip" in
    127.*|10.*|192.168.*|169.254.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_network() {
  [ -n "$NETWORK" ] && { echo "$NETWORK"; return; }
  local n
  # Tern's compose project makes a network named after its directory.
  for n in $(podman network ls --format '{{.Name}}' 2>/dev/null); do
    case "$n" in *tern*) echo "$n"; return ;; esac
  done
  echo ""
}

detect_gateway() {
  local net="$1" gw=""
  [ -n "$net" ] || return 1
  # podman 4/5
  gw=$(podman network inspect "$net" --format '{{ (index .Subnets 0).Gateway }}' 2>/dev/null || true)
  [ -n "$gw" ] && [ "$gw" != "<no value>" ] && { echo "$gw"; return 0; }
  # older layouts
  gw=$(podman network inspect "$net" 2>/dev/null | grep -oE '"gateway"[[:space:]]*:[[:space:]]*"[0-9.]+"' | head -1 | grep -oE '[0-9.]+' || true)
  [ -n "$gw" ] && { echo "$gw"; return 0; }
  return 1
}

detect_from_container() {
  # The most trustworthy answer: ask a running Tern container what
  # host.containers.internal means to it.
  local cid ip
  cid=$(podman ps --format '{{.Names}}' 2>/dev/null | grep -iE '(^|[_-])(tern[_-])?app([_-]|$)|tern' | head -1 || true)
  [ -n "$cid" ] || return 1
  ip=$(podman exec "$cid" getent hosts host.containers.internal 2>/dev/null | awk '{print $1}' | head -1 || true)
  [ -n "$ip" ] && { echo "$ip"; return 0; }
  return 1
}

step "Working out where the tunnel should land"
USE_NAME=""
if [ "$ASSUME_HOST" = 1 ]; then
  BIND="${BIND:-127.0.0.1}"
  note "Tern runs on the host, so loopback is right."
elif [ -z "$BIND" ]; then
  if ! command -v podman >/dev/null 2>&1; then
    warn "podman not found; assuming Tern runs on the host."
    BIND="127.0.0.1"
  else
    NET="$(detect_network)"
    [ -n "$NET" ] && note "Tern's podman network looks like: $NET"
    FROM_CONTAINER="$(detect_from_container || true)"
    FROM_GATEWAY="$(detect_gateway "$NET" || true)"
    if [ -n "$FROM_CONTAINER" ]; then
      BIND="$FROM_CONTAINER"
      note "a Tern container resolves host.containers.internal to $BIND"
      [ -n "$FROM_GATEWAY" ] && [ "$FROM_GATEWAY" = "$BIND" ] && USE_NAME="host.containers.internal"
    elif [ -n "$FROM_GATEWAY" ]; then
      BIND="$FROM_GATEWAY"
      note "the bridge gateway for $NET is $BIND"
      USE_NAME="host.containers.internal"
    else
      die "could not work out the podman bridge address. Start Tern, then run this again, or pass --bind <ip>."
    fi
  fi
fi

# The safety rail. A public address here would publish the model endpoint to
# the internet, which is the one thing this whole design exists to avoid.
if ! is_private_ip "$BIND"; then
  die "refusing to bind $BIND: it is not a private address. The tunnel must land on loopback or a podman bridge, never a public interface."
fi
ok "the tunnel will land on $BIND:$PORT"

# ---------- the account ----------
step "The tunnel account"
if id "$TUNNEL_USER" >/dev/null 2>&1; then
  ok "$TUNNEL_USER already exists"
else
  useradd --system --create-home --home-dir "/var/lib/$TUNNEL_USER" \
          --shell /usr/sbin/nologin --comment "perch reverse tunnel" "$TUNNEL_USER" 2>/dev/null \
    || useradd --system --create-home --home-dir "/var/lib/$TUNNEL_USER" \
               --shell /sbin/nologin --comment "perch reverse tunnel" "$TUNNEL_USER"
  ok "created $TUNNEL_USER (no shell, no password)"
fi
# A locked password, so the account can never be logged into with one.
passwd -l "$TUNNEL_USER" >/dev/null 2>&1 || true

HOME_DIR="$(getent passwd "$TUNNEL_USER" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || die "could not find $TUNNEL_USER's home directory."
install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "$HOME_DIR/.ssh"

# The restrictions are the point of this line:
#   restrict        turn everything off — no agent forwarding, no X11, no pty,
#                   no user rc, and no port forwarding either.
#   port-forwarding turn just forwarding back on.
#   permitlisten    ...and only for this one address and port. The key cannot
#                   ask for any other listener, so a stolen key cannot be used
#                   to open a door somewhere else on this machine.
#   command=        anything that does ask for a session gets nologin.
AUTH_LINE="restrict,port-forwarding,permitlisten=\"$BIND:$PORT\",command=\"/usr/sbin/nologin\" $PUBKEY"
AUTH_FILE="$HOME_DIR/.ssh/authorized_keys"
KEY_BODY="$(printf '%s' "$PUBKEY" | awk '{print $2}')"
if [ -f "$AUTH_FILE" ] && grep -qF "$KEY_BODY" "$AUTH_FILE" 2>/dev/null; then
  # Replace the existing line rather than adding a second one with different
  # restrictions — two lines for one key is how a permitlisten gets bypassed.
  grep -vF "$KEY_BODY" "$AUTH_FILE" > "$AUTH_FILE.new" || true
  mv "$AUTH_FILE.new" "$AUTH_FILE"
  note "replaced the existing entry for this key"
fi
printf '%s\n' "$AUTH_LINE" >> "$AUTH_FILE"
chown "$TUNNEL_USER:$TUNNEL_USER" "$AUTH_FILE"
chmod 600 "$AUTH_FILE"
ok "installed the key, restricted to listening on $BIND:$PORT"

# ---------- sshd ----------
step "sshd"
if [ ! -d /etc/ssh/sshd_config.d ] || ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then
  warn "this sshd does not read /etc/ssh/sshd_config.d/*.conf"
  note "add this line to the TOP of /etc/ssh/sshd_config, then run this script again:"
  note "  Include /etc/ssh/sshd_config.d/*.conf"
  die "stopping rather than editing your sshd_config."
fi
mkdir -p /etc/ssh/sshd_config.d

# Two things are needed here, and both are scoped to the tunnel account so
# nothing about how you log in changes.
#
#   GatewayPorts clientspecified — by default sshd forces every remote forward
#     onto loopback, whatever the client asks for, which would put the port
#     somewhere Tern's container cannot reach. "clientspecified" lets the
#     client name the address; permitlisten in authorized_keys is what stops
#     it naming a different one.
#
#   ClientAlive* — when the tunnel's connection dies badly (a home router
#     reboot, a laptop closing), sshd keeps the session and its listening port
#     for as long as TCP takes to notice, which can be hours. The returning
#     tunnel then cannot bind the port, exits, retries, and fails the same way
#     until the old one finally dies. Probing every 30 seconds means the dead
#     session is gone inside two minutes and the port is free.
#
# The trailing "Match all" matters: on most distributions the Include sits at
# the top of sshd_config, and a Match block that is never closed would apply
# the rest of the main file to this user only.
cat > "$SSHD_DROPIN" <<EOF
# Written by perch's tern-side-setup.sh. Scoped to the tunnel account only.
# https://github.com/notquiteog/perch
Match User $TUNNEL_USER
    AllowTcpForwarding remote
    GatewayPorts clientspecified
    PermitOpen none
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    ForceCommand /usr/sbin/nologin
    ClientAliveInterval 30
    ClientAliveCountMax 3
Match all
EOF
chmod 644 "$SSHD_DROPIN"
ok "wrote $SSHD_DROPIN"

if ! sshd -t 2>/tmp/perch-sshd-test.$$; then
  cat /tmp/perch-sshd-test.$$ >&2 || true
  rm -f "$SSHD_DROPIN" /tmp/perch-sshd-test.$$
  die "sshd rejected the configuration, so it was removed and nothing was changed."
fi
rm -f /tmp/perch-sshd-test.$$
ok "sshd accepts the configuration"

# Reload, never restart: a reload leaves your current session alone.
if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; then
  ok "sshd reloaded (your current session is untouched)"
else
  warn "could not reload sshd automatically; run: sudo systemctl reload ssh"
fi

# ---------- hand the answer back ----------
#
# The bridge address is the one thing perch cannot work out for itself: it is
# a property of this machine, and the tunnel key is restricted to nologin so
# perch cannot ask. Rather than have somebody read an IP address off a
# terminal and retype it, this prints one line to paste back, and perch does
# the rest from it.
TERN_HOST="${USE_NAME:-$BIND}"
BASE_URL="http://$TERN_HOST:$PORT"
cat <<EOF

$B  Done. The Tern box is ready.$N

  Copy this line into perch, under Connect:

    ${C}perch-pair:v1:$BIND:$PORT${N}

EOF
note "perch will fill in the rest, start the tunnel and give you the two"
note "settings for Tern. (For reference, Tern's base URL will be $BASE_URL.)"
