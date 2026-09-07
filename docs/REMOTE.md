# The tunnel

perch's whole job is getting a model on your desktop to a Tern install
somewhere else, without asking you to open anything on your home network.
This is how, and why it is built the way it is.

## The problem

Your home machine has the GPU. Tern is on a VPS. For Tern to use the model,
something has to connect from the VPS to your house — and home connections do
not accept incoming connections. Your router does NAT, and if your ISP uses
CGNAT you do not have a public address at all. Port forwarding is either
impossible or means opening a hole in your home network and keeping a
certificate and a dynamic DNS record alive so it stays usable.

## The answer: reverse the direction

Outbound connections always work. So the home machine dials out to the VPS and
asks, over that same connection, for a listening port on the far end that
pipes everything back down the tunnel:

```
Home                                              VPS
  Ollama :11434 (container, no published port)
      ▲
   perch :11434 (loopback)
      │
      └── ssh -N -R 10.89.0.1:11434:127.0.0.1:11434 ──▶ port opens on the VPS
                    (outbound, port 22)                  Tern connects to it
```

Nothing listens on your home connection. Nothing is published on the VPS's
public interface either — the forwarded port exists only on an address that
containers on that box can reach.

## The container wrinkle

The obvious command binds loopback:

```bash
ssh -N -R 127.0.0.1:11434:127.0.0.1:11434 perch@vps
```

That works if Tern runs directly on the VPS. It does not work when Tern runs
in a container, which it does: `127.0.0.1` inside a container is the
*container*, not the host, so Tern would look for the model inside itself and
find nothing.

The address that a container *can* reach is the host's own address on the
podman bridge its network is attached to — the same address the container
knows as `host.containers.internal`, usually something like `10.89.0.1`. So
that is what the tunnel binds:

```bash
ssh -N -R 10.89.0.1:11434:127.0.0.1:11434 perch@vps
```

Two things have to be true for that to be allowed:

1. **`GatewayPorts clientspecified`** on the VPS. By default sshd forces every
   remote forward onto loopback whatever the client asks for. `clientspecified`
   lets the client name an address instead.
2. **`permitlisten="10.89.0.1:11434"`** in the tunnel key's `authorized_keys`
   line, so that having named an address once, the key cannot name a different
   one later.

`deploy/tern-side-setup.sh` sets both, scoped to the tunnel account with a
`Match User` block so nothing about how *you* log in changes.

### Why not just bind 0.0.0.0

Because on a VPS that is the public internet. The setup script, the host
helper and the console all refuse any bind address that is not loopback or
RFC 1918 — three separate checks, because it is the one mistake in this design
that would actually be bad.

## The far side, in full

This is what `tern-side-setup.sh` does, if you would rather do it by hand.

```bash
# 1. an account that can do nothing but hold a port open
sudo useradd --system --create-home --home-dir /var/lib/perch \
             --shell /usr/sbin/nologin perch
sudo passwd -l perch

# 2. the key, with restrictions
sudo -u perch mkdir -p ~perch/.ssh && sudo -u perch chmod 700 ~perch/.ssh
echo 'restrict,port-forwarding,permitlisten="10.89.0.1:11434",command="/usr/sbin/nologin" ssh-ed25519 AAAA... perch@yourbox' \
  | sudo tee -a ~perch/.ssh/authorized_keys
sudo chmod 600 ~perch/.ssh/authorized_keys
sudo chown perch:perch ~perch/.ssh/authorized_keys
```

What each keyword buys you:

| | |
|---|---|
| `restrict` | Turns everything off — agent forwarding, X11, pty, user rc, *and* port forwarding. The safe default to start from. |
| `port-forwarding` | Turns only forwarding back on. |
| `permitlisten="addr:port"` | And only for that one address and port. A stolen key cannot open a listener anywhere else. |
| `command="/usr/sbin/nologin"` | Anything that asks for a session gets nothing. With `-N` no session is requested at all, so this is belt and braces. |

```bash
# 3. sshd, scoped to that account only
sudo tee /etc/ssh/sshd_config.d/50-perch.conf >/dev/null <<'EOF'
Match User perch
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

sudo sshd -t && sudo systemctl reload ssh
```

Two details worth not skipping:

- **`sshd -t` before reloading.** Validate first. A broken sshd config on a
  remote box is how people lose access to a VPS.
- **The trailing `Match all`.** On most distributions the `Include` for
  `sshd_config.d` sits at the *top* of `sshd_config`, so a `Match` block left
  open would apply the rest of the main file to this user only. `Match all`
  closes it.

### Why ClientAlive matters

When the tunnel's connection dies badly — a router reboot, a laptop lid, an
ISP blip — sshd keeps the session and its listening port for as long as TCP
takes to notice, which can be hours. The returning tunnel then cannot bind the
port, exits, retries, and fails the same way until the old session finally
dies. Probing every thirty seconds means the dead one is reaped inside two
minutes and the port is free when the tunnel comes back.

## The near side

```bash
ssh -NT \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o IdentitiesOnly=yes -o BatchMode=yes \
  -i /var/lib/perch/ssh/id_ed25519 \
  -R 10.89.0.1:11434:127.0.0.1:11434 \
  perch@your-vps
```

| Option | Why |
|---|---|
| `-N` | Ask for no command, only the forward. |
| `-T` | No terminal. |
| `ExitOnForwardFailure=yes` | **The important one.** Without it ssh stays happily connected when the remote port cannot be bound, and you get a live session carrying nothing while Tern reports the model is down. With it, ssh exits, systemd restarts it, and it retries until the forward takes. |
| `ServerAlive*` | A home connection drops without telling anyone, and TCP alone will sit on a dead socket for hours. Three missed probes at thirty seconds means a dead tunnel is noticed in ninety and restarted. |
| `IdentitiesOnly=yes` | Offer only this key, not every key an agent knows about. |
| `BatchMode=yes` | Never prompt. There is nobody there to answer. |

perch runs this under systemd (`deploy/perch-tunnel.service.tmpl`) with
`Restart=always` and `StartLimitIntervalSec=0`. The second is deliberate:
systemd's default is to give up after five restarts in ten seconds and stay
given up, which would mean coming home to a tunnel that stopped trying during
an outage hours earlier.

The unit is otherwise locked down — `ProtectSystem=strict`, an empty
`CapabilityBoundingSet`, a syscall filter — because it needs exactly one
private key and one socket, and nothing else on the machine is its business.

## Checking it

On the perch box:

```bash
./bin/perch tunnel status
./bin/perch tunnel logs
```

On the Tern box:

```bash
ss -lntp | grep 11434                      # is the forwarded port there?
curl -s http://10.89.0.1:11434/healthz     # does it answer?
```

`/healthz` needs no token and reports nothing but that perch is listening, so
it is safe to use for exactly this.

Then, from inside a Tern container, which is the test that actually matters:

```bash
podman exec -it tern_app_1 wget -qO- http://host.containers.internal:11434/healthz
```

If that works and Tern still cannot reach the model, the problem is the token,
not the tunnel — and perch's Activity page will show the 401.
