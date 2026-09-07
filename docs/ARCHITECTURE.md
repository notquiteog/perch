# Architecture

## The pieces

```
┌─ your machine ───────────────────────────────────────────────┐
│                                                              │
│  ┌── podman ──────────────────────────┐                      │
│  │  ollama            perch           │                      │
│  │  (no ports)  ◀───  :8099 console   │                      │
│  │                    :11434 endpoint │                      │
│  └────────────────────────┬───────────┘                      │
│                           │ /var/lib/perch (shared)          │
│                    perch-hostd ── podman, systemd, nvidia-smi │
│                           │                                  │
│                    perch-tunnel.service ── ssh -N -R ────────┼──▶ VPS
└──────────────────────────────────────────────────────────────┘
```

**ollama** — the model runtime. Publishes no port; reachable only from the
perch container over the compose network.

**perch** — one Node process, two listeners:

- the *console* on 8099: the web UI and its API, loopback only;
- the *model endpoint* on 11434: the token-authenticated Ollama proxy, which
  is what the tunnel carries.

They are separate sockets so that exposing the second never exposes the first.

**perch-hostd** — a bash systemd service on the host. Publishes telemetry the
container cannot see and performs a fixed list of privileged actions. See
below.

**perch-tunnel.service** — `ssh -N -R`, owned by systemd so it survives
reboots and dropped lines.

## Why the host helper exists

Two things the container genuinely cannot do:

1. **See the machine.** The perch container does not have the GPU — Ollama
   does — so `nvidia-smi` is not available to it, and inside a container
   `/proc/meminfo` and `df` describe the container.
2. **Control podman and systemd.** Starting containers and enabling units
   needs root on the host.

Mounting the podman socket into the container solves both in three lines of
compose, and makes a bug in the internet-facing proxy into root on the
machine. So instead the helper runs on the host and perch asks it for things
by name.

### The channel

Files in `/var/lib/perch/host/`:

- `status.json` — rewritten every second: memory, CPU, GPUs, disk, containers,
  and the state of the boot and tunnel units. perch reads it and streams it to
  the browser as server-sent events. A timestamp older than fifteen seconds is
  how the console knows the helper has stopped, which is different from it
  never having been installed.
- `requests/<id>.req` — two lines, `action=` and `arg=`. Written by perch to a
  temporary name and renamed in, so the helper never reads a half-written one.
- `results/<id>.json` — the outcome. Cleaned up after two minutes.

A polling loop rather than a socket: no RPC to get wrong, no permissions to
mis-set, and every request is a file you can read while debugging. It costs
about half a second of latency on a button press, which is fine for
"restart the containers".

## The proxy

`server/src/proxy.ts`. A fixed table of method-and-path pairs, each with a
required scope. A request is checked against the table, then the token, then
the concurrency backstop, and is then piped to Ollama with `http.request`.

It is a pipe, not a parser. Bodies stream in both directions untouched — which
is what keeps `/api/chat` answering token by token, and means perch never
holds anyone's email in memory.

Two details that are easy to get wrong and matter:

- **Client hang-up cancels the upstream.** When the caller goes away
  mid-generation, `res.on('close')` destroys the upstream request. Without it
  Ollama keeps generating into a socket nobody is reading and the GPU stays
  busy on an answer no one will see.
- **The caller's `Authorization` is not forwarded.** Ollama has no
  authentication; passing the token on would put it in a second process's
  memory for nothing.

## State

One JSON file, `/var/lib/perch/state.json`, mode 600: tokens (hashed), the
console password hash, the tunnel's settings, and three behaviour flags.
Written by writing a temporary file, `fsync`, and `rename`, so a crash
mid-write leaves the previous state rather than a truncated one.

Not a database. Everything in it is small, changes rarely, and should be
fixable with a text editor at three in the morning when the tunnel is down.

## No runtime dependencies

The server imports nothing but `node:*`. The router is sixty lines in
`server/src/http.ts`.

This is a deliberate trade for the component that faces a tunnel: fewer moving
parts to audit, no transitive supply chain, no framework CVE to chase. The
console UI is React, but that is build-time only — what ships is static files.

## Layout

```
server/src/
  index.ts     both listeners, static files, the idle watcher
  proxy.ts     the model endpoint: allowlist, auth, streaming
  api.ts       the console API
  auth.ts      tokens, scopes, sessions, refusing repeat guessers
  state.ts     the JSON state file
  host.ts      the client side of the host-helper channel
  tunnel.ts    tunnel settings, key, generated commands, status
  ollama.ts    the console's Ollama client (management, not generation)
  system.ts    sizing and the model catalogue
  metrics.ts   throughput, measured without reading bodies
  activity.ts  the in-memory request ring
  http.ts      the router
deploy/
  perch-hostd              the host helper
  tern-side-setup.sh       run on the Tern box
  *.service.tmpl           systemd units
client/src/
  pages/       Status, Models, Connect, System, Activity, Settings
  components/  the live stream hook and the small UI kit
```
