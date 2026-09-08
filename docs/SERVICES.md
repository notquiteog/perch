# Services

perch began as a proxy in front of Ollama. It now fronts up to five model
servers on the same machine, and they differ in only three things: which port
they listen on, where they forward to, and which endpoints they are allowed to
expose.

Everything else is shared — the bearer token, the allowlist discipline, the
streaming pipe, the concurrency backstop, the activity ring — because the
security properties should not vary by which model happens to be behind the
socket.

| Service | Port on this machine | Behind it | What it does | Tern uses it for |
|---|---|---|---|---|
| **Chat** | 11434 | Ollama | Text and embeddings | Drafting, replies, rewrites, subject lines, search |
| **Dictation** | 8080 | whisper.cpp | Speech to text | The dictation key |
| **Images** | 7860 | Stable Diffusion | Images from a prompt | Nothing — see below |
| **Video** | 8188 | ComfyUI | Video, and the newer image and music models | Nothing |
| **Audio** | 8880 | Kokoro | Text to speech | Nothing |

Each is the port that service is conventionally found on when it is run by
hand, so a client already written against a local Ollama, whisper.cpp or
ComfyUI needs no new number — it needs a token. What is listening there is
perch rather than the backend: the backend containers publish nothing at all,
and keep these same numbers on the compose network where only perch can reach
them. If something on this machine already holds one, the installer publishes
that service one port along and says so.

Chat is always on. The other four are off unless you ask for them, because each
is another claim on the same GPU.

Three of the five have no use in Tern at all, and that is the point rather than
an oversight: perch is a model host that Tern happens to be a client of. The
endpoints are ordinary HTTP with a bearer token, and the shapes are the ones a
client is likely to be written against already — Ollama's and OpenAI's.

## Why one app rather than five

The tunnel, the host helper, the token store, the console and the installer are
the hard parts, and they are identical for all of them. A separate app per
model would duplicate all of that and then need its own tunnel — meaning a
second account and a second key on the far side, for no gain. One SSH session
carries every service instead:

```
-R 10.89.0.1:11434:127.0.0.1:11434   # chat
-R 10.89.0.1:11435:127.0.0.1:8080    # dictation
-R 10.89.0.1:11436:127.0.0.1:7860    # images
-R 10.89.0.1:11437:127.0.0.1:8188    # video
-R 10.89.0.1:11438:127.0.0.1:8880    # audio
```

The two sides are numbered independently, and the block above is the clearest
statement of why. Here, each service sits where that service is normally
found. On the far side they run consecutively from the chat port, because
every one of them must be named in that machine's `permitlisten`: a run of
numbers is one thing to check, and five scattered ones is five. Neither
constraint has anything to say about the other.

Each service's offset is its position in that fixed list, not its position in
what you ticked — so switching video on later does not renumber the port
dictation was already using on the far side. A connection carrying only chat
and audio therefore uses 11434 and 11438, with a gap.

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
| Kokoro | ~1.5 GB, and happier on the CPU |
| Stable Diffusion 1.5 | ~4 GB |
| SDXL | ~10 GB |
| LTX-Video 2B | ~8 GB |
| Wan 2.2 TI2V 5B | ~14 GB |
| FLUX.1 schnell | ~18 GB |

On a 16 GB card, chat plus dictation is comfortable. Chat plus SD 1.5 is tight
but works. Chat plus SDXL does not fit, and the failure is not an error — it is
minutes per image while the model runs from system memory. Video is the one
that does not share: a 5B video model and its text encoder want the card to
themselves, and the honest way to run both is to let the chat model unload
while a clip renders.

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

### Choosing the speech model

Unlike Ollama, whisper.cpp has no model API: it is started with one model file
and will not list, fetch or remove anything over HTTP. So the console's
**Models → Dictation** card is deliberately not shaped like the Ollama cards
above it. What it does have:

- which model the container was started with, read from the environment
  compose gave it rather than from a value the console remembers;
- whether the transcriber is answering, polled;
- a way to change it, which writes `WHISPER_MODEL` to `.env` and recreates the
  container.

That last step is also the only progress signal there is. `whisper-server`
does not open its port until the model file is on disk, so after a change a
refused connection *is* the download — the card says so, rather than showing a
red badge on a container doing exactly what it should. `base` is 150 MB,
`small` 500 MB and better on accents and names, `large-v3-turbo` 1.6 GB and
close to the best whisper.cpp publishes. The container's own log is where the
byte-level progress exists; the card has a button for it.

Changing the model needs `perch-hostd`, because writing `.env` and recreating
a container are host operations. Without the helper the card still reports
which model is in use and whether it is answering, and says the change has to
be made on the host.

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

## Video

ComfyUI, which is a different shape from everything else here. It does not take
a prompt and return a file — it takes a *workflow*, a graph of nodes naming the
weights it wants, and returns whatever the graph produced. There is therefore
no "video model" setting the way there is for whisper: what runs is decided by
whoever queues the job.

```
POST /prompt        GET /history      GET /queue     POST /interrupt
GET  /view          GET /object_info  GET /system_stats
POST /upload/image
```

Deliberately absent: `/api/manager/*`, which installs custom nodes from the
internet, and `/userdata/*`, which reads and writes arbitrary files under the
user directory. The websocket is not proxied either — progress is read by
polling `/history`, which is a fair trade for not having to reason about
authenticating an upgrade.

`POST /upload/image` is the one write in that list, and it is there because
image-to-video has no other way in. It writes into ComfyUI's input directory
and nowhere else; `PERCH_MAX_BODY_BYTES` is what stops it being a way to fill
the disk.

The same container is what runs FLUX for images and ACE-Step for music, because
they are diffusion graphs too — Stable Diffusion's web UI cannot load either.
So switching video on adds three families of model rather than one, and the
console says beside each entry which container it needs.

## Audio

Kokoro behind its FastAPI server, speaking OpenAI's shape:

```
POST /v1/audio/speech    GET /v1/audio/voices    GET /v1/models    GET /health
```

The mirror image of dictation, and the same bet: a client already written
against OpenAI's text-to-speech needs an address and a key changed, not an
adapter written.

Kokoro is 82M parameters and generates faster than real time on a handful of
cores, so on a box whose card is busy the CPU is the right place for it —
`install.sh` picks the `-cpu` image when there is no NVIDIA GPU. The voices
ship inside the image, so there is nothing to download and nothing to choose.

## Models that are files rather than tags

Ollama has an API for its models: list, pull, delete, progress. None of the
other backends do. They read a directory when they start, and there is no HTTP
call that will put a file in it.

So the console does not pretend to. **Models → Image / Video / Audio
generation** is a catalogue: every file, its real size read from the registry
rather than remembered, what the model wants on the card, and whether the
backend can currently see it — which is asked of the backend, so a file you
copied in by hand shows up too. Installing one is:

```bash
sudo ./bin/perch fetch ltxv-2b
```

which asks the console for that model's files and writes them into the right
container's volume. It resumes a partial download, skips a file that is already
there, and is safe to run twice. `./bin/perch fetch` with no arguments lists
what there is.

perch does not do this itself, for the same reason it does not run podman: the
console container has no business writing into another container's storage.

## How big each container may be

Six containers at most, on one machine, sharing one pool of system memory.
Left alone they each take whatever they can get, which is fine until ComfyUI
decodes a long clip, the kernel picks a process to kill, and the thing it picks
is Ollama halfway through somebody's sentence.

**System → Container sizes** sets a memory and CPU ceiling for each. The values
are written into `.env`, because that is where compose reads them — which is
also why applying one is a *recreate* rather than a restart: compose fixes a
container's resources when it creates it, so a restart would leave the new
number in the file doing nothing.

Two figures are shown per container, and the gap between them is the point.
*Configured* is what `.env` asks for, read from the environment compose handed
the console. *Running with* is what the container actually has, read from
podman by the host helper. They differ exactly when a change has been written
and not yet applied.

A memory limit is a ceiling, not a reservation: nothing is claimed until it is
used, so the limits may safely add up to more than the machine has. But past
its limit a container is **killed, not slowed** — so each ceiling has to clear
what that container really needs, and the console refuses a value below the
floor for that container and tells you the number. Ollama's floor is not a
constant: on a box with no GPU the weights live in system memory, so it rises
to the size of the model the sizing recommends.

None of this touches video memory. What shares the card is decided by which
models are loaded, which is what the sizes above and the Services panel are
about.

## Adding another

A service is a `ServiceDef` in `server/src/services.ts`: an id, a port, an
upstream, a container name and a route list. Add one there, add a compose
overlay for its container and a `ContainerDef` in `server/src/containers.ts`,
and it inherits the token check, the allowlist enforcement, the streaming, the
tunnel, the size control and the console.

The route list is the security boundary, so it is worth being mean with it.
Every endpoint you add is one a leaked token can reach. Ask what the worst call
in the API can do — write a file, load a model from a URL, run a script — and
leave those out.
