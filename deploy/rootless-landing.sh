#!/usr/bin/env bash
# =============================================================================
# Run this on the machine that runs the app, BEFORE tern-side-setup.sh, when
# that machine runs its containers under ROOTLESS podman.
#
#   sudo bash rootless-landing.sh --key "ssh-ed25519 AAAA... perch@yourbox" \
#                                 --port 11434,8080,8880
#
# Why this exists:
#
#   The tunnel has to land on an address the app's container can reach.
#   tern-side-setup.sh works that out from the podman bridge, and that is
#   right when podman runs as root: the bridge is an interface on the host,
#   so sshd can bind it.
#
#   Under ROOTLESS podman it is not. The bridge lives inside the rootless
#   network namespace, so the gateway address does not exist on the host at
#   all, and sshd — root, in the host namespace — cannot bind it. The symptom
#   is `ssh -R` failing with "Cannot assign requested address" for an address
#   the app's own documentation told you to use.
#
#   Nor is there an existing address to borrow. host.containers.internal is
#   169.254.1.2 under podman 5+ with pasta, which forwards only to host
#   listeners bound to 0.0.0.0 and which sensible clients refuse outright,
#   because that range is where cloud instance metadata lives. The host's own
#   public address is worse: pasta gives the rootless namespace that same
#   address, so a container dialling it reaches itself.
#
#   What does work is an address the host holds that pasta has no reason to
#   shadow. This script makes one: a dummy interface carrying a private
#   address, persisted as a unit so it survives a reboot. sshd can bind it,
#   the container can route to it, and it exists on no public interface.
#
# What it does:
#   1. Refuses an address that collides with anything already routed here, or
#      with a podman network belonging to the store user.
#   2. Creates the interface and a unit that recreates it at boot.
#   3. With --key, hands off to tern-side-setup.sh with --bind already set,
#      so the account, the restricted key and the sshd drop-in are that
#      script's job rather than a second copy of it here.
#
# Everything is reversible: --uninstall takes the interface and the unit back
# out, and with --key or --purge it undoes the tunnel account as well.
# =============================================================================
set -euo pipefail

ADDR="10.199.0.1/24"
IFACE="perch0"
PUBKEY=""
TUNNEL_USER="perch"
PORT="11434"
SETUP_SCRIPT=""
STORE_USER=""
USER_SET=0
PORT_SET=0
MODE="install"
PURGE=0
RAW="https://raw.githubusercontent.com/notquiteog/perch/main/deploy/tern-side-setup.sh"

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Options:
  --key "<ssh-ed25519 ...>"  the public key of the perch CONNECTION this box
                             serves. Asked for if not given, which is the
                             better habit: perch mints one key per connection.
                             Paste the whole "Run one command on ..." line
                             from perch's console and --user and --port are
                             read from it too.
  --addr <ip[/len]>          the landing address (default: 10.199.0.1/24)
  --iface <name>             the dummy interface (default: perch0)
  --user <name>              tunnel account, passed through (default: perch)
  --port <n>[,<n>...]        port(s) the endpoints land on (default: 11434)
  --store-user <name>        the user whose rootless podman runs the app. Only
                             used to check the landing address does not
                             collide with one of its networks.
  --setup-script <path>      a local copy of tern-side-setup.sh, rather than
                             fetching it.
  --check                    report what is in place and exit.
  --uninstall                remove the interface and its unit. With --key,
                             also remove that one key from the tunnel account.
                             With --purge, remove the account entirely.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) PUBKEY="${2:-}"; shift 2 ;;
    --addr) ADDR="${2:-}"; shift 2 ;;
    --iface) IFACE="${2:-}"; shift 2 ;;
    --user) TUNNEL_USER="${2:-}"; USER_SET=1; shift 2 ;;
    --port) PORT="${2:-}"; PORT_SET=1; shift 2 ;;
    --store-user) STORE_USER="${2:-}"; shift 2 ;;
    --setup-script) SETUP_SCRIPT="${2:-}"; shift 2 ;;
    --check) MODE="check"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --purge) PURGE=1; shift ;;
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

# ---------- the address ----------
IP="${ADDR%%/*}"
LEN="24"
case "$ADDR" in */*) LEN="${ADDR#*/}" ;; esac
[[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "--addr wants an IPv4 address, optionally with /length."
[[ $LEN =~ ^[0-9]{1,2}$ ]] && [ "$LEN" -ge 8 ] && [ "$LEN" -le 32 ] || die "--addr prefix length must be between 8 and 32."
[[ $IFACE =~ ^[a-z][a-z0-9_-]{0,14}$ ]] || die "--iface is not a valid interface name."
[[ $TUNNEL_USER =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--user is not a valid account name."
IFS=',' read -ra PORT_LIST <<< "$PORT"
for p in "${PORT_LIST[@]}"; do
  [[ "$p" =~ ^[0-9]{2,5}$ ]] || die "--port takes port numbers, comma separated for more than one."
done

# The same rail tern-side-setup.sh and perch-hostd both apply, minus two
# ranges that pass "is it private" but cannot serve as a landing address:
# 127/8 is the container's own loopback rather than the host's, and
# 169.254/16 is the metadata range that clients refuse.
case "$IP" in
  10.*|192.168.*) ;;
  172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
  127.*) die "127.0.0.0/8 is loopback: inside a container that is the container, not this host." ;;
  169.254.*) die "169.254.0.0/16 is where instance metadata lives, and clients refuse it. Pick a 10.x address." ;;
  *) die "refusing $IP: the landing address must be private, or the endpoint ends up on the internet." ;;
esac

IP_BIN="$(command -v ip || true)"
[ -n "$IP_BIN" ] || die "no 'ip' command found; install iproute2."
UNIT="/etc/systemd/system/perch-landing-${IFACE}.service"
# Earlier documentation had people write this unit by hand under a name with
# no interface in it. Uninstall cleans that up too rather than leaving a unit
# that recreates an interface nothing uses.
LEGACY_UNIT="/etc/systemd/system/perch-landing.service"

# ---------- helpers ----------
ip2int() {
  local a b c d; IFS=. read -r a b c d <<< "$1"
  printf '%s' "$(( (a << 24) + (b << 16) + (c << 8) + d ))"
}

# Do two CIDRs share any address? Compared at the shorter prefix, which is the
# only comparison that catches a /16 containing our /24.
overlaps() {
  local a="${1%%/*}" alen="${1#*/}" b="${2%%/*}" blen="${2#*/}" short mask
  [[ $a =~ ^[0-9.]+$ && $b =~ ^[0-9.]+$ ]] || return 1
  [[ $alen =~ ^[0-9]+$ ]] || alen=32
  [[ $blen =~ ^[0-9]+$ ]] || blen=32
  short=$(( alen < blen ? alen : blen ))
  [ "$short" -eq 0 ] && return 0
  mask=$(( 0xFFFFFFFF << (32 - short) & 0xFFFFFFFF ))
  [ $(( $(ip2int "$a") & mask )) -eq $(( $(ip2int "$b") & mask )) ]
}

# The subnets of every podman network belonging to the user who runs the app.
# Rootless networks are invisible to root's podman, which is the whole reason
# this script exists, so ask as that user — and ask through their runtime
# directory, without which podman invents one under /tmp and reports nothing.
rootless_subnets() {
  local u="$1" uid nets n
  uid="$(id -u "$u" 2>/dev/null || true)"
  [ -n "$uid" ] || { warn "no such user: $u — skipping the network collision check"; return 0; }
  nets="$(sudo -u "$u" env XDG_RUNTIME_DIR="/run/user/$uid" podman network ls --format '{{.Name}}' 2>/dev/null || true)"
  [ -n "$nets" ] || return 0
  for n in $nets; do
    sudo -u "$u" env XDG_RUNTIME_DIR="/run/user/$uid" \
      podman network inspect "$n" --format '{{range .Subnets}}{{.Subnet}}
{{end}}' 2>/dev/null || true
  done
}

have_addr() { $IP_BIN -4 -o addr show dev "$IFACE" 2>/dev/null | grep -qF " $IP/"; }

show_listeners() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -F "$IP:" || echo "    (nothing listening on $IP yet)"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -F "$IP:" || echo "    (nothing listening on $IP yet)"
  else
    echo "    (install iproute2 to list listeners)"
  fi
}

fetch_setup() {
  local dest="$1"
  if [ -n "$SETUP_SCRIPT" ]; then
    [ -f "$SETUP_SCRIPT" ] || die "no such file: $SETUP_SCRIPT"
    cp "$SETUP_SCRIPT" "$dest"
  else
    command -v curl >/dev/null 2>&1 || die "curl not found; pass --setup-script with a local copy."
    curl -fsSL "$RAW" -o "$dest" || die "could not fetch tern-side-setup.sh; pass --setup-script with a local copy."
  fi
  [ -s "$dest" ] || die "the setup script came back empty."
}

# ---------- check ----------
if [ "$MODE" = check ]; then
  step "The landing address"
  if have_addr; then ok "$IP/$LEN is up on $IFACE"
  else warn "$IP is not on $IFACE"; fi
  if [ -f "$UNIT" ]; then
    ok "$UNIT exists ($(systemctl is-enabled "$(basename "$UNIT")" 2>/dev/null || echo 'not enabled'), $(systemctl is-active "$(basename "$UNIT")" 2>/dev/null || echo inactive))"
  else
    warn "no unit at $UNIT — the address will not survive a reboot"
  fi
  [ -f "$LEGACY_UNIT" ] && note "a hand-written $LEGACY_UNIT is also present"
  step "Listening on it"
  show_listeners
  note "A listener appears only while the tunnel is connected."
  exit 0
fi

# ---------- uninstall ----------
if [ "$MODE" = uninstall ]; then
  if [ -n "$PUBKEY" ] || [ "$PURGE" = 1 ]; then
    step "The tunnel account"
    TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
    fetch_setup "$TMP"
    if [ "$PURGE" = 1 ]; then
      bash "$TMP" --uninstall --user "$TUNNEL_USER" || warn "tern-side-setup.sh --uninstall reported a problem"
    else
      bash "$TMP" --uninstall --user "$TUNNEL_USER" --key "$PUBKEY" || warn "tern-side-setup.sh --uninstall reported a problem"
    fi
  fi

  step "The landing address"
  for u in "$UNIT" "$LEGACY_UNIT"; do
    [ -f "$u" ] || continue
    # The legacy name is not ours by definition, so only take it if it is this
    # interface it manages.
    if [ "$u" = "$LEGACY_UNIT" ] && ! grep -qE "(^|[[:space:]])$IFACE([[:space:]]|\$)" "$u"; then
      note "leaving $u alone: it does not manage $IFACE"
      continue
    fi
    b="$(basename "$u")"
    systemctl disable --now "$b" >/dev/null 2>&1 || true
    rm -f "$u"
    ok "removed $u"
  done
  systemctl daemon-reload 2>/dev/null || true
  if $IP_BIN link show "$IFACE" >/dev/null 2>&1; then
    $IP_BIN link del "$IFACE" && ok "removed the $IFACE interface"
  else
    ok "no $IFACE interface to remove"
  fi
  note "Nothing else on this machine was touched."
  [ "$PURGE" = 1 ] || [ -n "$PUBKEY" ] || note "The tunnel account is untouched. Re-run with --purge to remove it too."
  exit 0
fi

# ---------- the key ----------
#
# perch mints a key PER CONNECTION. The wrong one fails as "Permission denied
# (publickey)" thirty seconds at a time on the far end, with nothing on this
# box saying which key it expected — a tedious thing to debug and an easy
# thing to get wrong when a box has served more than one connection.
#
# So the key is asked for rather than assumed, the whole setup command from
# perch's console is accepted as well as a bare key, and the key's COMMENT is
# printed back. That comment names the connection, which is the one check that
# catches a key from the wrong one before it costs you an evening.
#
# Read from /dev/tty rather than stdin: the documented way to run this is
# `curl ... | sudo bash`, where stdin is the script itself.
#
# Both of these end in "|| true" and mean it: this script runs under pipefail,
# where a grep that matches nothing fails the whole pipeline, and a failing
# command substitution under set -e ends the script. Not finding a key in a
# line is the normal case — it is how the loop below knows to read another —
# so it must not be fatal.
key_in() {
  printf '%s' "$1" \
    | grep -oE 'ssh-(ed25519|rsa|dss|ecdsa[a-z0-9-]*)[[:space:]]+[A-Za-z0-9+/=]+([[:space:]]+[^"'"'"'[:cntrl:]]*)?' \
    | head -1 | sed 's/[[:space:]]*$//' || true
}
opt_in() { printf '%s' "$2" | grep -oE -- "--$1[[:space:]]+$3" | head -1 | awk '{print $2}' || true; }

ask_for_key() {
  [ -r /dev/tty ] || { note "not a terminal, so no key was asked for"; return 0; }
  cat <<EOF

  Open perch's console, go to the connection for this box, and copy either
  its ${B}Run one command on ...${N} line or just the key under ${B}Its key${N}.
  Paste it here. A blank line sets up the address only.

EOF
  local line buf="" key=""
  printf '  paste: '
  while IFS= read -r line < /dev/tty; do
    [ -z "$line" ] && break
    buf="$buf$line
"
    key="$(key_in "$buf")"
    [ -n "$key" ] && break
  done
  [ -n "$key" ] || { note "nothing pasted; setting up the address only"; return 0; }
  PUBKEY="$key"
  # A pasted command already names the ports perch configured for this
  # connection. Trusting it beats retyping a list that has to match.
  if [ "$USER_SET" = 0 ]; then
    # An if rather than "[ -n ] && assign": under set -e a false test as the
    # last command of an if-block is the block's exit status, and the script
    # dies there — silently, because the paste worked and nothing printed yet.
    local u; u="$(opt_in user "$buf" '[a-z_][a-z0-9_-]*')"
    if [ -n "$u" ]; then TUNNEL_USER="$u"; fi
  fi
  if [ "$PORT_SET" = 0 ]; then
    local pl; pl="$(opt_in port "$buf" '[0-9][0-9,]*')"
    if [ -n "$pl" ]; then
      PORT="$pl"
      IFS=',' read -ra PORT_LIST <<< "$PORT"
    fi
  fi
}

# ---------- install ----------
if [ -z "$PUBKEY" ]; then
  step "The key for this connection"
  ask_for_key
fi

if [ -n "$PUBKEY" ]; then
  # Validated here rather than at the handoff: a typo should not cost you an
  # interface and a unit first.
  [ -n "$(key_in "$PUBKEY")" ] || die "that does not look like an SSH public key."
  PUBKEY="$(key_in "$PUBKEY")"
  KEY_COMMENT="$(printf '%s' "$PUBKEY" | awk '{print $3}')"
  if [ -n "$KEY_COMMENT" ]; then
    ok "key for ${B}$KEY_COMMENT${N}"
    note "that name is the perch connection this key belongs to — check it is this box's"
  else
    ok "key accepted"
    warn "it carries no comment, so it does not say which perch connection it is from"
  fi
  note "account $TUNNEL_USER, port(s) ${PORT_LIST[*]}"
fi

step "Checking the address is free"

# Already ours is fine and idempotent; on some other interface is not, because
# taking it over would break whatever put it there.
EXISTING="$($IP_BIN -4 -o addr show 2>/dev/null | awk -v ip="$IP/" '$4 ~ "^" ip {print $2}' | head -1 || true)"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$IFACE" ]; then
  die "$IP is already on $EXISTING. Pick another --addr."
fi

# A route for this prefix through something else means containers here would
# send the traffic there instead, and the tunnel would look connected while
# answering nothing.
ROUTE="$($IP_BIN -4 route show 2>/dev/null | awk -v want="$IP/$LEN" '$1 == want {print}' | grep -v "dev $IFACE" || true)"
[ -n "$ROUTE" ] && die "something already routes $IP/$LEN: ${ROUTE}. Pick another --addr."

if [ -n "$STORE_USER" ]; then
  while read -r sn; do
    [ -n "$sn" ] || continue
    if overlaps "$IP/$LEN" "$sn"; then
      die "$IP/$LEN overlaps $STORE_USER's podman network $sn. A container would route this to its own bridge and never reach the host. Pick another --addr."
    fi
  done < <(rootless_subnets "$STORE_USER")
  ok "no collision with $STORE_USER's podman networks"
else
  note "no --store-user given, so podman's own networks were not checked"
fi
ok "$IP/$LEN is free"

# sshd is checked BEFORE anything is created: tern-side-setup.sh stops rather
# than editing sshd_config, and finding that out after making an interface is
# a worse order to discover it in.
if [ -n "$PUBKEY" ]; then
  step "sshd"
  if [ ! -d /etc/ssh/sshd_config.d ] || ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then
    warn "this sshd does not read /etc/ssh/sshd_config.d/*.conf"
    note "add this line to the TOP of /etc/ssh/sshd_config, then run this again:"
    note "  Include /etc/ssh/sshd_config.d/*.conf"
    die "stopping before anything was created."
  fi
  ok "sshd reads the drop-in directory"
fi

step "The landing address"

# Earlier documentation had people write this unit by hand, under a name with
# no interface in it. Two units managing one interface both run at boot and
# fight over it, so the hand-written one is retired here — but only when it is
# this interface it manages, never somebody else's.
if [ -f "$LEGACY_UNIT" ] && grep -qE "(^|[[:space:]])$IFACE([[:space:]]|\$)" "$LEGACY_UNIT"; then
  systemctl disable --now "$(basename "$LEGACY_UNIT")" >/dev/null 2>&1 || true
  rm -f "$LEGACY_UNIT"
  systemctl daemon-reload 2>/dev/null || true
  ok "retired the hand-written $LEGACY_UNIT, which managed $IFACE"
  note "$IFACE goes away with it and comes back below; a connected tunnel will reconnect."
fi

# ExecStartPre with a leading - so a stale interface from a crash does not
# stop the unit; ExecStop so `systemctl stop` leaves nothing behind.
cat > "$UNIT" <<EOF
# Written by perch's rootless-landing.sh. One dummy interface holding the
# address the tunnel lands on, because the app here runs under rootless
# podman and its bridge does not exist in this namespace.
# https://github.com/notquiteog/perch
[Unit]
Description=perch tunnel landing address ($IP on $IFACE)
Documentation=https://github.com/notquiteog/perch/blob/main/docs/REMOTE.md
After=network-pre.target
Before=network.target ssh.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-$IP_BIN link del $IFACE
ExecStart=$IP_BIN link add $IFACE type dummy
ExecStart=$IP_BIN addr add $IP/$LEN dev $IFACE
ExecStart=$IP_BIN link set $IFACE up
ExecStop=-$IP_BIN link del $IFACE

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT"
ok "wrote $UNIT"

systemctl daemon-reload
# The dummy driver is usually built in; on a stripped kernel it is a module
# that nothing has needed yet.
modprobe dummy 2>/dev/null || true
if ! systemctl enable --now "$(basename "$UNIT")" >/dev/null 2>&1; then
  systemctl status "$(basename "$UNIT")" --no-pager -l 2>&1 | tail -20 >&2 || true
  die "the unit failed to start. The output above says why."
fi
have_addr || die "the unit started but $IP is not on $IFACE. Check: systemctl status $(basename "$UNIT")"
ok "$IP/$LEN is up on $IFACE, and will be again after a reboot"

if [ -n "$PUBKEY" ]; then
  step "Handing over to tern-side-setup.sh"
  TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
  fetch_setup "$TMP"
  note "running it with --bind $IP"
  bash "$TMP" --key "$PUBKEY" --user "$TUNNEL_USER" --port "$PORT" --bind "$IP"
else
  cat <<EOF

$B  The address is ready. The tunnel account is not.$N

  Run tern-side-setup.sh next, or re-run this with --key to do both:

    ${C}sudo bash tern-side-setup.sh --key "ssh-ed25519 AAAA... perch@yourbox" \\
      --user $TUNNEL_USER --port $PORT --bind $IP${N}
EOF
fi

cat <<EOF

$B  Where the app should look$N

EOF
for p in "${PORT_LIST[@]}"; do
  printf '    %shttp://%s:%s%s\n' "$C" "$IP" "$p" "$N"
done
cat <<EOF

  Use those literal addresses. perch's console will offer
  http://host.containers.internal:PORT instead, which is correct for a root
  podman host and wrong here — under rootless podman that name resolves into
  the metadata range, which clients refuse.

  To check it from inside the app's container, once the tunnel is up:

    ${D}podman exec <container> node -e "fetch('http://$IP:${PORT_LIST[0]}/healthz').then(r=>r.text()).then(console.log)"${N}

  /healthz needs no token. Every other path does: make one in perch's console,
  on this connection, and paste it into the app's API key field.

EOF
