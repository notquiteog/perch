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
| **Video and images** | 8188 | ComfyUI | Images, video and music from a prompt | Nothing — see below |
| **Audio** | 8880 | Kokoro | Text to speech | Nothing |

Each is the port that service is conventionally found on when it is run by
hand, so a client already written against a local Ollama, whisper.cpp or
ComfyUI needs no new number — it needs a token. What is listening there is
perch rather than the backend: the backend containers publish nothing at all,
and keep these same numbers on the compose network where only perch can reach
them. If something on this machine already holds one, the installer publishes
that service one port along and says so.

Chat is always on. The other three are off unless you ask for them, because
each is another claim on the same GPU.

Two of the four have no use in Tern at all, and that is the point rather than
an oversight: perch is a model host that Tern happens to be a client of. The
endpoints are ordinary HTTP with a bearer token, and the shapes are the ones a
client is likely to be written against already — Ollama's, OpenAI's and
Anthropic's.

## Why one app rather than four

The tunnel, the host helper, the token store, the console and the installer are
the hard parts, and they are identical for all of them. A separate app per
model would duplicate all of that and then need its own tunnel — meaning a
second account and a second key on the far side, for no gain. One SSH session
carries every service instead:

```
-R 10.89.0.1:11434:127.0.0.1:11434   # chat
-R 10.89.0.1:8080:127.0.0.1:8080     # dictation
-R 10.89.0.1:8188:127.0.0.1:8188     # images and video
-R 10.89.0.1:8880:127.0.0.1:8880     # audio
```

Each service keeps its number at both ends, so what Tern dials is the port
that service is normally found on. That is the whole reason for the numbering
and it is worth nothing if it stops at this machine: Tern talks to the far
side, so the far side is where a familiar number actually saves somebody a
setting.

Chat is the exception and takes whatever port the connection was given. The
machine Tern runs on may well have an Ollama of its own on 11434, and this one
has to go somewhere else when it does. Nothing else has a conflict like that
to dodge.

These used to run consecutively from the chat port, on the grounds that a run
of numbers is one thing to name in the far side's `permitlisten` and five
scattered ones is five. It did not survive contact with the setup script,
which takes the ports as a list and writes one `permitlisten` line per port,
and always did — so a range was never the thing being checked.

Ticking a service still cannot move another one's port, which the consecutive
scheme took an offset into a fixed list to guarantee. Here it falls out of the
ports not being derived from each other at all.

What it does cost: two connections to the same machine cannot both carry the
same service, because both would try to bind that one port over there. Chat
can be moved out of the way and the rest cannot, so perch refuses the second
one when it is set up rather than letting it fail at connect time.

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

## Chat

Ollama, behind the token. It answers three wire shapes, because a client is
almost always already written against one of them:

| Shape | Paths |
|---|---|
| Ollama's own | `/api/chat`, `/api/generate`, `/api/embed`, `/api/tags`, `/api/show`, `/api/ps`, `/api/version` |
| OpenAI's | `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models` |
| Anthropic's | `/v1/messages`, `/v1/messages/count_tokens` |

The first two are Ollama's own doing — it serves both, so perch pipes them
through and never looks inside. The third is not: Ollama does not speak the
Messages API, so `server/src/anthropic.ts` translates it.

### What the translated route costs, and what it does not

`proxy.ts` opens by saying it is a pipe and not a parser, and every privacy
property it claims follows from that: bodies stream through, so perch never
holds anybody's prompt. A translator cannot keep that promise — it has to read
the request to rewrite it. So the promise is narrowed rather than quietly
broken, and the narrowing is worth stating plainly:

- Only `/v1/messages` and `/v1/messages/count_tokens` are affected. Everything
  else on this service, and all four other services, are still piped.
- The request body is read under a hard ceiling and dropped when the response
  ends. Nothing is written anywhere and nothing is logged: the activity ring
  records the path and the byte count exactly as it does for a piped request.
- The **response** is still streamed. Ollama's lines are translated one at a
  time as they arrive, so a long generation still arrives token by token and
  the whole answer is never assembled in memory.
- The token, the scope, the block list, the size ceiling and the concurrency
  backstop all run first, unchanged. A translated route is marked `translated`
  in the route table in `server/src/services.ts` so this is a list rather than
  something to remember.

### What does not survive the crossing

- **`count_tokens` is an estimate.** Ollama exposes no tokeniser, so there is
  nothing to proxy. Answering approximately beats answering 404: a client uses
  this to decide whether a conversation still fits, and one that cannot ask
  usually assumes it does and fails on the real request instead.
- **Server-side tools are dropped.** `web_search` and friends are Anthropic's
  to run, and this is not Anthropic. Defining one for the model would give it a
  tool nothing can answer and deadlock the conversation on a result that never
  comes; a dropped one just means the model does not call it.
- **Image blocks must be base64.** A URL source is not something Ollama can
  fetch, so it is not forwarded as though it were.

Everything else crosses: the system prompt (lifted back into the message list),
tool definitions and tool results, `max_tokens` as `num_predict`, temperature,
top-p, top-k, stop sequences, and `thinking` as Ollama's `think`.

## Putting the chat service in front of somebody else's models

Everything above assumes the upstream is the Ollama on this box, which is the
default and what every install has until it is changed. It does not have to be.

```
PERCH_CHAT_UPSTREAM_API=openai        # or anthropic; empty means Ollama
PERCH_CHAT_UPSTREAM_URL=https://api.groq.com/openai/v1
PERCH_CHAT_UPSTREAM_KEY=gsk_...
```

or the same three fields in **Settings → Services → Chat** in the console,
which take effect on the next request rather than on the next restart.

### Why a host gains a "which provider" setting

Everything valuable about perch is the front door: one bearer token, one port
per service, a route table that is the whole of what can be reached, a proxy
per service, a concurrency backstop, and a console that says what has been
asked. None of that is about Ollama — and an operator who wanted those
properties in front of OpenAI, Groq, OpenRouter, Together, Fireworks, NanoGPT
or Anthropic could not have them, because the upstream was assumed to speak
Ollama's API.

The provider key is **perch's**, not the caller's. A client on the far end of
the tunnel holds a perch token and never sees the OpenAI key, so the key can be
rotated, scoped and revoked here without touching a single client — and a
leaked perch token cannot be replayed against OpenAI directly.

### What happens to each route

Decided by the pair (what the client is speaking, what the upstream serves) in
`planFor` in `server/src/chatUpstream.ts`:

| | Ollama upstream | OpenAI-compatible upstream | Anthropic upstream |
|---|---|---|---|
| Ollama-shaped routes | pipe | translate | translate |
| OpenAI-shaped routes | pipe | **pipe** | translate |
| `/v1/messages` | translate | translate | **pipe** |
| `/api/pull`, `/api/delete` | pipe | **501** | **501** |
| `/api/embed`, `/v1/embeddings` | pipe | translate | **501** |
| `/api/ps` | pipe | `{models: []}` | `{models: []}` |

Two things worth reading off that table. A hosted upstream still **pipes the
shape it already speaks**, which is the common reason to put perch in front of
one at all — the token and the allowlist with no translation. And the refusals
are refusals: pulling a model onto a hosted API is meaningless, and Anthropic
has no embeddings endpoint, so both answer 501 naming the setting rather than
an empty list or an empty vector. A plausible lie is worse than an error here —
an empty model list reads as "you have no models", and an empty vector reads as
a successful embedding and gets indexed against.

`/api/ps` is the exception that answers rather than refusing, because an empty
list is *true*: nothing is resident on this machine. A polling client reads an
error as "the server is broken" and an empty list as "nothing loaded", which is
what has actually happened.

### Everything goes through Ollama's shape

Three shapes talking to three shapes is nine conversions and nine places for
one to be subtly wrong. `server/src/shapes.ts` converts through a hub instead,
and the hub is Ollama's shape — because perch already speaks it everywhere, and
because on the default configuration it is also the upstream, so the common
case converts nothing at all.

The cost is honest: a client speaking Anthropic to an upstream speaking OpenAI
is converted twice, and anything neither shape carries is lost at the first hop
rather than the second. What is lost is listed against each function in that
file. The traps worth knowing without reading it:

- **Ollama-only sampling knobs are never forwarded.** `top_k`, `min_p`,
  `repeat_penalty`, `num_ctx` and `keep_alive` are dropped, because real OpenAI
  answers 400 to a parameter it does not know — and that failure looks like a
  bad prompt rather than a bad translation.
- **`temperature` is withheld from current Anthropic models.** It was removed
  on that generation and sending it is a 400, not an ignored field. An
  allowlist decides, so a model released after this was written is treated as
  not taking it — the safe direction.
- **Tool arguments change form in both directions.** OpenAI sends them as a
  JSON string and Ollama wants an object; a string left unparsed reaches the
  model as a quoted blob and the tool is called with nothing.
- **A `tool` message without the id of the call it answers is demoted to a
  user turn** rather than sent as a 400 both OpenAI and Anthropic would return.
- **Remote image URLs are dropped, not fetched.** perch would be the thing
  making that request, from inside your network, at the direction of whoever
  wrote the prompt.
- **`/api/show` answers with its fields empty.** A hosted catalogue publishes
  no parameter count, quantisation or context length, and inventing one would
  let a client size a window from a guess.

The parsing cost is the same one the Anthropic route already pays, and the same
bounds hold: nothing is written or logged, the body is read under the same
ceiling, and the response is still streamed event by event.

## Reaching an upstream through a proxy

Each service has its own upstream address — `PERCH_OLLAMA_URL`,
`PERCH_WHISPER_URL`, `PERCH_COMFY_URL`, `PERCH_TTS_URL` — because they are four
different servers, usually four different containers. Each also has its own
**proxy field**, which is the other half of "how do we reach it":

| Service | Upstream | Proxy |
|---|---|---|
| Chat | `PERCH_OLLAMA_URL` | `PERCH_CHAT_PROXY` |
| Dictation | `PERCH_WHISPER_URL` | `PERCH_VOICE_PROXY` |
| Video and images | `PERCH_COMFY_URL` | `PERCH_VIDEO_PROXY` |
| Audio | `PERCH_TTS_URL` | `PERCH_AUDIO_PROXY` |

Empty is a direct connection, which is the default and what a machine hosting
its own models wants. Set one to `socks5h://127.0.0.1:9150` and that service —
and only that service — reaches its upstream through Tor.

**Why a proxy URL and not a "use Tor" switch.** A switch would have to be
paired with an address somewhere, and perch would then own an opinion about
which port Tor listens on: 9050 for the C daemon, 9150 for Arti, something else
again for a proxy in another container. A field holding
`socks5h://127.0.0.1:9150` says the same thing without the opinion, in a form
already familiar from every other tool that takes one — and it generalises for
free to a jump host or any other SOCKS proxy.

**Prefer `socks5h://` to `socks5://`.** The `h` means the *proxy* resolves the
hostname. That is the only way an `.onion` address works at all, and for an
ordinary hostname it stops this machine's resolver — and therefore its network
— being told which upstream is about to be contacted while the bytes travel
through the proxy. Routing the traffic and leaking the name is most of the cost
and none of the benefit. `socks5://`, `socks4a://` and `socks4://` are honoured
as written, because somebody who typed one meant it.

**Per service, because the journeys differ.** A chat model on a rented box
across the internet and a whisper container one bridge away are not the same
journey. One setting for the whole box would force an operator to route the
near one the way the far one needs — either a leak or pointless latency,
depending which way they resolved it.

**A proxy that will not parse is refused, not ignored.** The service answers
502 naming the setting, and nothing reaches the upstream. Falling back to a
direct connection would send traffic somewhere the operator specifically said
not to and say nothing about it — and it would succeed, which is what makes
that failure mode so much worse than an error.

The setting is read per request, so changing it in the console takes effect on
the next call rather than the next restart. That matters most for exactly this
setting: a wrong proxy is a service that has stopped answering.

The SOCKS5 client is hand-written in `server/src/upstream.ts` against
`node:net`. `socks-proxy-agent` would have been four lines instead of ninety
and also the first runtime dependency in a component whose whole design is not
having any — see CONTRIBUTING.md.

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

## Video and images

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

The same container runs every diffusion model perch offers — SD 1.5 and SDXL
checkpoints, FLUX, video, and ACE-Step for music — because they are all graphs.
So switching this on adds three families of model rather than one.

### Images, without building a graph

A workflow is the right interface for video, where the job genuinely differs
each time. It is a poor one for "give me a picture of a heron", and it is not
what any image client is written against. So images also get the OpenAI shape,
translated on the way through:

```
POST /v1/images/generations
GET  /v1/models
```

`POST /v1/images/generations` takes OpenAI's fields — `prompt`, `model`, `n`,
`size` — and builds the graph itself: load the checkpoint, encode the prompt,
sample, decode, return the picture as `b64_json`. `GET /v1/models` lists the
checkpoints ComfyUI can see, which is how a caller learns what to put in
`model`; a name is matched loosely, so `dreamshaper` finds
`DreamShaper_8_pruned.safetensors`.

Four fields are extensions to that API, because every image client wants them
and OpenAI's has none of them: `negative_prompt`, `steps`, `cfg_scale` and
`seed`. A request that sets none of them behaves like the stock ComfyUI
text-to-image workflow.

Two things are worth knowing before the first call:

- **`size` defaults to 1024×1024**, which is OpenAI's default and the right one
  for SDXL and FLUX. An **SD 1.5 checkpoint wants `"512x512"`** — above about
  768 it produces doubled figures and repeated horizons. Pass `size`.
- **`response_format: "url"` is refused.** perch has nowhere to host a
  generated image, so the endpoint always answers `b64_json`, and says so
  rather than returning a body with no `url` in it.

These two routes are the only ones on any service where perch reads a request
body rather than piping it — `/v1/messages` on chat is the other. What that
costs, and what bounds it, is written at the top of `server/src/images.ts`.

**Nothing in Tern uses this.** Tern is an email client and has no
image-generation feature. It is here because the machinery was already built
and a local image model is useful to have on the same box.

> There used to be a second container here: Stable Diffusion's web UI, on port
> 7860, behind its A1111 API. It installed its Python dependencies at runtime
> from the live package index on every start, which meant it could not be
> pinned — an image digest fixes the layers, not what pip resolves inside them
> — and one morning a build dependency dropped a module and it stopped starting
> at all, with nothing on the machine having changed. ComfyUI loads the same
> checkpoint files, so the models moved across and the container went away.

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

## Ollama's tuning knobs

**System → Ollama tuning** sets the handful of values Ollama reads when it
starts: how many requests it answers at once, how many models stay resident,
how its context cache is stored, how deep its queue goes.

The same rule as the sizes governs these, for the same reason. They are
written into `.env`, and compose hands a container its environment when it
*creates* it — so a restart gives Ollama back the values it already had and
the new one sits in the file doing nothing. Each knob therefore has two
buttons: **Set** writes it and says so, and **Set and recreate Ollama** writes
it and creates the container again so that something actually reads it.

And, as with the sizes, each knob shows two figures: what `.env` asks for,
which is the value in the box, and what Ollama is *running* with, read from
the container itself. While those disagree the knob is marked **written, not
applied**, and the second button changes to **Recreate Ollama** — there is
nothing left to write, only something left to apply.

Recreating Ollama drops whatever model is resident and interrupts anything
generating at that moment; the next request loads the model again. That is why
it is a separate button and why the console asks before doing it, rather than
applying every change the moment it is typed.

Elsewhere in the console and in `./bin/perch`, **restart** means a restart and
nothing more: the same container, started again, with the environment it was
created with. Anything that has to reach a container through `.env` — a size,
a tuning knob, the speech model — asks for a recreate instead.

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
