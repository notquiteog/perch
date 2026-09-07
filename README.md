# perch

**A perch for your model.** Run a language model on the machine that has the
GPU, and let [Tern](https://github.com/notquiteog/tern) use it for writing
email — over an SSH tunnel, with nothing exposed to the internet.

Tern runs on a VPS. VPSs do not have GPUs. The desktop in your spare room
does, and it is idle most of the day. perch is the small piece that connects
the two.

```
   your home                                        your VPS
┌──────────────────────┐                      ┌──────────────────────┐
│  ██ GPU              │                      │                      │
│  Ollama              │                      │   Tern               │
│    ▲                 │                      │     │                │
│  perch  ─────────────┼── ssh -R (outbound) ─┼──▶ :11434            │
│  console :8099       │                      │   (loopback only)    │
└──────────────────────┘                      └──────────────────────┘
   no open ports                                 nothing published
```

Your home machine dials out. No port forwarding, no dynamic DNS, nothing
listening on your home connection, and no third party in the middle.

---

## What you get

**A model endpoint Tern can use.** An Ollama-compatible API that requires a
bearer token, exposing exactly the fourteen endpoints Tern actually calls and
refusing everything else. Streaming passes straight through, so drafts still
appear token by token.

**A console for the machine.** A small web UI on `127.0.0.1:8099`:

- **Live monitors** — system RAM, VRAM, GPU utilisation, temperature and power,
  and tokens per second, moving once a second with a minute and a half of
  history behind each.
- **Models** — download with a progress bar, delete, load and unload, see what
  is resident and how much of it is on the GPU, and a short list of models
  worth using for email with a note on what each is actually like.
- **Connect** — one entry per machine running Tern, added with a button. Each
  gets its own account over there, its own key and its own service here, so
  removing one leaves the others alone. Setup per connection is: a key, one
  command to run on that box, and one line pasted back.
- **System** — start, stop and restart the containers, turn on starting at
  boot, tune Ollama's memory settings, read logs.
- **Activity** — what came through the endpoint, so that when Tern says the
  model is unreachable you can tell whether the request arrived at all.
- **Settings** — issue and revoke tokens, set a console password, choose
  whether the model is dropped from memory when idle.

**Optionally over Tor.** The tunnel can dial out through a SOCKS proxy, so the
Tern box never learns your home address — and if its SSH host is an `.onion`,
the VPS needs no public SSH port at all. perch adjusts the timeouts to suit,
which matters more than it sounds: the default 15-second connect timeout is not
long enough to reach a hidden service, and the result is a tunnel that retries
forever without ever connecting. See [docs/REMOTE.md](docs/REMOTE.md#over-tor).

**As many connections as you have machines.** A VPS's Tern and a laptop's Tern
can share one GPU. Two connections to the same host may not claim the same port
there, which perch refuses rather than letting them fight over it. Removing one
deletes its service, its key and its settings here, and hands you a
key-scoped, idempotent command for the far side — perch cannot run that
itself, because the tunnel key is deliberately restricted to holding a port
open and nothing else.

**A tunnel that stays up.** systemd owns it, with `ExitOnForwardFailure` so a
half-open forward is retried rather than sat on, keepalives so a dead home
connection is noticed in ninety seconds, and no restart limit so an overnight
ISP outage does not leave it given up by morning.

---

## Install

On the machine with the GPU:

```bash
git clone https://github.com/notquiteog/perch.git
cd perch
sudo ./install.sh
```

It finds your GPU, works out how big a model will fit, downloads one, starts
the containers and prints a token. Then open `http://127.0.0.1:8099` and go to
**Connect**.

Setting up the tunnel is three things: type the SSH host of the Tern box, run
the one command it gives you over there, and paste back the single line that
command prints. perch works out the rest — the address, the systemd unit,
starting the tunnel, enabling it at boot, and a token — and finishes by showing
the base URL and API key to paste into Tern's **Admin → AI model** page.

That one line back is the only thing you carry between the machines. perch
cannot work it out for itself: the address belongs to the Tern box, and the
tunnel key is deliberately restricted to `nologin`, so there is nothing perch
can ask.

Requires podman, podman-compose and the openssh client. For an NVIDIA card you
also need the container toolkit with CDI configured; the installer checks and
tells you if it is missing.

---

## How the tunnel works

Your home machine cannot accept incoming connections — NAT, and increasingly
CGNAT, where you have no public address at all. So it does not try to. It
makes an outbound SSH connection to the VPS and asks for a port on the far
end that pipes back down it:

```bash
ssh -N -R 10.89.0.1:11434:127.0.0.1:11434 perch@your-vps
```

Tern then talks to what looks to it like a local Ollama.

The address is the podman bridge on the VPS rather than `127.0.0.1`, because
Tern runs in a container, and loopback inside a container is the container.
`deploy/tern-side-setup.sh` works that out for you, along with creating a
locked-down account whose key may do nothing but hold that one port open.

Only private addresses are ever accepted — checked in the console, in the host
helper and in the setup script — so a typo cannot put your model endpoint on
the internet.

[docs/REMOTE.md](docs/REMOTE.md) has the whole thing written out, including
what each SSH option is for and what breaks without it.

---

## What perch does not do

**It does not read your mail.** The proxy is a pipe: request and response
bodies stream through without being parsed, buffered or logged. The Activity
page records that a request happened — endpoint, status, duration — and never
what was in it.

Throughput is measured without breaking that. Ollama streams one JSON object
per line, so perch counts newline bytes: it learns the rate without learning a
word of the content. (Verified against Ollama's own `eval_count`.)

**It does not phone home.** No telemetry, no update checks, no analytics.

**It does not expose Ollama.** Ollama publishes no port of its own; the only
way in is through perch, with a token.

---

## Security posture

- **Tokens** are shown once and stored as a SHA-256 hash. Each carries scopes —
  `use` for generating, `manage` for downloading and deleting models — and can
  be revoked individually.
- **The allowlist is a list, not a filter.** `/api/create`, `/api/push` and the
  blob endpoints can write a model onto your machine or ship one off it. They
  are not in the table, so they return 404 whatever token is presented.
- **The console never leaves the machine** unless you give it a password, and
  refuses non-loopback requests until you do.
- **The container never gets podman access.** Container control and GPU
  telemetry go through a host helper that accepts a fixed list of actions by
  name — so a bug in the internet-facing proxy cannot become root on your
  desktop.
- **The tunnel key is restricted at the far end** with `restrict`,
  `permitlisten` and a forced `nologin`: it can hold one port open on one
  address, and do nothing else.
- **No runtime dependencies.** The server is plain `node:http`. The thing
  facing the tunnel carries no framework it does not use.

[docs/SECURITY.md](docs/SECURITY.md) goes through the threat model properly,
including what perch does *not* protect against.

---

## Documentation

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | Installing, in more detail than the installer gives you |
| [REMOTE.md](docs/REMOTE.md) | The tunnel: how it works, how to do it by hand, why each option is there |
| [TERN.md](docs/TERN.md) | Pointing Tern at perch, and choosing a model for email |
| [SECURITY.md](docs/SECURITY.md) | Threat model, what is exposed, what is not |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit, and why the host helper exists |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | When it does not work |

---

## Development

```bash
npm install
npm run dev:server     # console API and the model endpoint
npm run dev:client     # the console UI, on :5199
npm test               # server tests
npm run typecheck
```

`PERCH_OLLAMA_URL` points at any Ollama; you do not need the containers to
work on the console.

## Licence

[GNU AGPL v3](LICENSE) or later. If you run a modified perch as a service for
other people, publish your changes.

perch is a companion to Tern but does not require it: anything that speaks the
Ollama API can use it.
