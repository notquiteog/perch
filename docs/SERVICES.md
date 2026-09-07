# Services

perch began as a proxy in front of Ollama. It now fronts up to three model
servers on the same machine, and they differ in only three things: which port
they listen on, where they forward to, and which endpoints they are allowed to
expose.

Everything else is shared — the bearer token, the allowlist discipline, the
streaming pipe, the concurrency backstop, the activity ring — because the
security properties should not vary by which model happens to be behind the
socket.

| Service | Port | Behind it | Tern uses it for |
|---|---|---|---|
| **Chat** | 11434 | Ollama | Drafting, replies, rewrites, subject lines |
| **Dictation** | 11435 | whisper.cpp | The dictation key |
| **Images** | 11436 | Stable Diffusion | Nothing — see below |

Chat is always on. The other two are off unless you ask for them, because each
is another claim on the same GPU.

## Why one app rather than three

The tunnel, the host helper, the token store, the console and the installer are
the hard parts, and they are identical for all three. A separate app per model
would duplicate all of that and then need its own tunnel — meaning a second
account and a second key on the far side, for no gain. One SSH session carries
every service instead:

```
-R 10.89.0.1:11434:127.0.0.1:11434   # chat
-R 10.89.0.1:11435:127.0.0.1:11435   # dictation
-R 10.89.0.1:11436:127.0.0.1:11436   # images
```

The far-side ports are consecutive from the chat port because every one of them
must be named in that machine's `permitlisten`. Three consecutive numbers is
one thing to check; three arbitrary ones is three.

The other reason is memory, and it is the stronger one. These share a card.
Two independent apps would compete for it with no coordination and silently
spill into system memory — which is the failure that makes people conclude
local models are useless. One process can see the whole picture.

## They do not all fit

This is the part worth reading before switching everything on. Rough resident
cost:

| | |
|---|---|
| `gemma4:12b` | 8.1 GB |
| whisper `base` | 0.4 GB, or nothing if you run it on the CPU |
| whisper `small` | ~1 GB |
| Stable Diffusion 1.5 | ~4 GB |
| SDXL | ~10 GB |

On a 16 GB card, chat plus dictation is comfortable. Chat plus SD 1.5 is tight
but works. Chat plus SDXL does not fit, and the failure is not an error — it is
minutes per image while the model runs from system memory.

The console's **Settings → Services** panel adds up what you have enabled and
says so. Ollama's keep-alive and perch's "drop the model when idle" setting are
the levers for making two things share one card: whichever was used last holds
it, and the other pays a load.

**Dictation runs perfectly well on the CPU.** For clips of a sentence or two,
on a machine with cores to spare, that is the right answer — it leaves the
whole card for the writing model.

## Dictation

whisper.cpp behind its bundled server, told by `--inference-path` to serve at
`/v1/audio/transcriptions` — the same shape as OpenAI's, which is what Tern
posts to. So perch's allowlist for it is a single endpoint, and Tern needs no
adapter.

Switch it on by re-running `sudo ./install.sh` and saying yes, or by adding
`compose.voice.yml` to `COMPOSE_FILE` and `voice` to `PERCH_SERVICES` in `.env`.

In Tern it goes under **Admin → AI model → Dictation → Transcriber address**,
which is a separate setting from the writing model precisely because Tern
already expects the transcriber to live on a different machine.

No audio is written to disk on either side. perch streams it through without
reading it, exactly as it does chat.

## Images

Stable Diffusion behind an A1111-compatible API. perch exposes generation and
the read-only queries needed to drive it:

```
POST /sdapi/v1/txt2img       POST /sdapi/v1/img2img
GET  /sdapi/v1/sd-models     GET  /sdapi/v1/samplers
GET  /sdapi/v1/progress      GET  /sdapi/v1/memory
```

The rest of that API is mostly concerned with reconfiguring the server —
changing checkpoints, reloading, running scripts — and none of it is something
a token from another machine should be able to do, so none of it is routable.

**Nothing in Tern uses this.** Tern is an email client and has no
image-generation feature. It is here because the machinery was already built
and a local image model is useful to have on the same box; if you want it for
something else on your network, the endpoint is a normal HTTP API with a bearer
token.

The container image is community-maintained — upstream publishes none — so pin
a digest in `SD_IMAGE` if that matters to you.

## Adding another

A service is a `ServiceDef` in `server/src/services.ts`: an id, a port, an
upstream, and a route list. Add one there, add a compose overlay for its
container, and it inherits the token check, the allowlist enforcement, the
streaming, the tunnel and the console.

The route list is the security boundary, so it is worth being mean with it.
Every endpoint you add is one a leaked token can reach. Ask what the worst call
in the API can do — write a file, load a model from a URL, run a script — and
leave those out.
