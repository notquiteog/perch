# perch

**A perch for your models.** Run them on the machine that has the GPU, and
reach them from anywhere you trust — over an SSH tunnel, with nothing exposed
to the internet.

Language models, embeddings, speech in and out, images, video and music: each
is a separate authenticated endpoint, each is off until you ask for it, and one
outbound SSH session carries whichever you enable.

perch is also the companion to [Tern](https://github.com/notquiteog/tern),
which is where it started. Tern runs on a VPS; VPSs do not have GPUs. The
desktop in your spare room does, and it is idle most of the day. perch is the
small piece that connects the two — and, being a plain HTTP API with a bearer
token, everything else on your network too.

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

**Four endpoints, three of them optional.** Chat and embeddings (Ollama) are
always on; dictation (whisper.cpp), images and video and music (ComfyUI, which
runs all three because they are all diffusion graphs) and speech synthesis
(Kokoro) are off until you ask for them. Each is a separate port with its own
allowlist, and one SSH session carries whichever you enable. They share a GPU,
so the console adds up what they want and tells you when the set will not fit
— see [docs/SERVICES.md](docs/SERVICES.md).

**A model endpoint anything can use.** An API that requires a bearer token,
exposing exactly the endpoints a client actually calls and refusing everything
else. Chat answers all three shapes a client is likely to be written against —
Ollama's own, OpenAI's `/v1`, and Anthropic's `/v1/messages` — and the other
services speak the OpenAI shapes their clients already expect, including
`POST /v1/images/generations` for pictures, so nothing has to learn ComfyUI's
graph format to ask for one. Streaming passes straight through, so answers
still appear token by token; the Anthropic and images routes are the
exceptions and are translated rather than piped, which
[docs/SERVICES.md](docs/SERVICES.md) explains in full.

**Somebody else's models, behind your front door.** The chat service does not
have to be the Ollama on this box. Point it at any OpenAI-compatible service —
OpenAI, Groq, OpenRouter, Together, Fireworks, NanoGPT, a vLLM in your own
rack — or at Anthropic, and perch becomes an authenticated, allowlisted,
optionally Tor-routed front door for that instead. Clients keep working
unchanged: a composer written against Ollama's API still gets Ollama's API,
because the endpoints the upstream does not serve are translated rather than
removed. The provider key is perch's, not the caller's, so it rotates here
without touching a single client and a leaked perch token cannot be replayed
against the provider. Two things are refused rather than faked — pulling or
deleting a model, because there is no file here to fetch or remove, and
embeddings on Anthropic, because that API has none. Empty is the default and
means Ollama, where nothing is translated at all.

**A proxy per service, if you want one.** Each of the four services has its own
upstream address and its own proxy field. Empty is a direct connection;
`socks5h://127.0.0.1:9150` routes that one service through Tor and leaves the
others alone — which is the point, since a chat model on a rented box and a
whisper container one bridge away are not the same journey. A URL rather than a
switch, so perch holds no opinion about which port Tor listens on and the same
field covers a jump host. A proxy that will not parse is refused rather than
ignored, because falling back to a direct connection would succeed and say
nothing about it. The SOCKS5 client is ninety lines of `node:net` — see below
on runtime dependencies.

**Containers you can size.** Each one has a memory and CPU ceiling you set from
the console. They are written into `.env`, which compose reads when it
*creates* a container — so the console applies a change by recreating it, and
shows what a running container actually has beside what has been asked for.

**A console for the machine.** A small web UI on `127.0.0.1:8099`:

- **Live monitors** — system RAM, VRAM, GPU utilisation, temperature and power,
  and tokens per second, moving once a second with a minute and a half of
  history behind each.
- **Models** — language models and embedding models, downloaded with a
  progress bar, deleted, loaded and unloaded, with a note on what each one is
  actually like. The list is read from Ollama every few seconds, so it shows
  what is on the machine rather than what the console last remembered; a
  download is a job on the console, so closing the page or reloading does not
  stop one, and the bar is the whole download rather than whichever layer is
  in flight. Below that, the models with no such API: whisper's voice models,
  which are a setting and a restart, and the image, video and audio models,
  which are weight files — the console lists them with their real sizes, says
  whether the backend can see them, and gives you the one command that fetches
  one.
- **Connect** — one entry per machine running Tern, added with a button. Each
  gets its own account over there, its own key and its own service here, so
  removing one leaves the others alone. Setup per connection is: a key, one
  command to run on that box, and one line pasted back.
- **System** — start, stop and restart the containers, set how much memory and
  how many cores each may have, turn on starting at boot, tune Ollama's memory
  settings, read logs.
- **Activity** — what came through the endpoints, so that when a client says
  the model is unreachable you can tell whether the request arrived at all.
- **Settings** — issue and revoke tokens, set a console password, choose
  whether the model is dropped from memory when idle.

**Optionally over Tor.** The tunnel can dial out through a SOCKS proxy, so the
Tern box never learns your home address — and if its SSH host is an `.onion`,
the VPS needs no public SSH port at all. perch adjusts the timeouts to suit,
which matters more than it sounds: the default 15-second connect timeout is not
long enough to reach a hidden service, and the result is a tunnel that retries
forever without ever connecting. See [docs/REMOTE.md](docs/REMOTE.md#over-tor).

**As many connections as you have machines.** A VPS and a laptop can share one
GPU. Two connections to the same host may not claim the same port
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

## Before you start

On the machine with the GPU:

- **podman** and **podman-compose** (or `podman compose`)
- **openssh-client** — the tunnel is ordinary `ssh`
- **systemd**, for the tunnel and the host helper

For an **NVIDIA** card, either is fine and the installer picks whichever it
finds:

- the NVIDIA container toolkit with CDI configured, or
- nothing at all — the installer passes the `/dev/nvidia*` nodes through and
  bind-mounts the driver libraries, which works because the ollama image
  already carries `LD_LIBRARY_PATH=/usr/local/nvidia/lib64`

For an **AMD** card, a ROCm-capable GPU with `/dev/kfd` present.

You also need SSH access, with sudo, to each machine running Tern — once, to
authorise a key.

## Install

```bash
git clone https://github.com/notquiteog/perch.git
cd perch
sudo ./install.sh
```

It finds the GPU and how to hand it to a container, sizes a model from the
VRAM and downloads it (`gemma4:12b` on a 16 GB card), creates the unprivileged
account the tunnel runs as, writes `.env`, installs the host helper, starts the
containers, and prints an API token.

**Copy that token.** perch stores only a hash and cannot show it again — though
you can always make another.

Running it again is safe: your previous answers are the defaults, and nothing
is rebuilt or restarted unless it changed.

## Connect it to Tern

Open `http://127.0.0.1:8099` and press **Add a connection**. Add one per
machine running Tern.

1. **Name it and give the SSH host** of the box Tern runs on. A key is
   generated for that connection alone.
2. **Open it** and run the one command it shows you on that box. It creates a
   locked-down account, installs the key with restrictions so it can hold one
   port open and do nothing else, teaches sshd to reap dead tunnels, and prints
   a single line.
3. **Paste that line back.** Paste the whole terminal output if it is easier —
   perch finds the line in it. It then saves the address, writes the systemd
   unit, starts the tunnel and enables it at boot.
4. **Copy the base URL and API key** into Tern's **Admin → AI model**, with the
   provider set to Ollama, and press **Test connection**.

That pasted line is the only thing you carry between the machines, and it is
one value perch cannot work out for itself: the address belongs to the Tern
box, and the tunnel key is deliberately restricted to `nologin`, so there is
nothing perch can ask.

## Check it worked

```bash
./bin/perch doctor
```

It checks the endpoint, Ollama, whether a model is downloaded, the keys, the
host helper, every connection, and — the usual culprit for "why is this so
slow" — whether the container can actually see the GPU.

`./bin/perch connections` lists what exists and whether each tunnel is up. And
the console's **Activity** page answers the question that matters when Tern
says the model is unreachable: did the request arrive here at all? If it shows
up as a 401 the tunnel is fine and the token is wrong; if nothing appears, the
problem is between Tern and the tunnel.

When something does not work, [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
starts from the symptom.

## A note on the console

The console is bound to `127.0.0.1` and, running in a container, perch cannot
tell a request forwarded from the host apart from one off your network — the
port publish is what keeps it private. It says so on screen until you set a
password:

```bash
./bin/perch console-password
```

Set one and the protection stops depending on a compose file nobody re-reads.
You need one anyway to open the console from a laptop on your own network.

## Removing a connection

**Remove** deletes the service, the key and the settings here, then shows a
command to run on the far side. perch cannot run it: the tunnel key can hold a
port open and nothing else, and a credential here that could clean up remotely
could also run anything on your mail server. The command is scoped to that
connection's key, so another perch using the same server keeps working, and it
is safe to run twice.

Uninstalling perch entirely is in [docs/SETUP.md](docs/SETUP.md#uninstall).

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

Each connection gets its own account, key and unit, so several machines can
share one GPU and removing one leaves the others alone.

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
| [SERVICES.md](docs/SERVICES.md) | Chat, dictation, images, video and speech: what each exposes, and why they share one app |
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
