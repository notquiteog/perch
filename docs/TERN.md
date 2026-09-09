# Pointing Tern at perch

## The two settings

In Tern, open **Admin → AI model**:

| Field | Value |
|---|---|
| Provider | **Ollama** |
| Base URL | `http://host.containers.internal:11434` |
| API key | the token from perch's console |

Then **Test connection**.

`host.containers.internal` is the name Tern's container has for the podman
bridge — the address the tunnel lands on. If Tern cannot resolve it, use the
address directly (`http://10.89.0.1:11434`); perch's Connect page shows both.

## Choosing a model

### The floor

**Chat: `qwen3.5:9b` or `gemma4:12b`. Embeddings: `qwen3-embedding:4b`.**

This table is the measured one and the other projects deliberately point at it
rather than keeping copies, so the floor is stated here too. It is not "what
fits" — it is what a client's *features* are allowed to depend on.

Tern's drafting work is: write a reply in a thread, rewrite a paragraph, fix
grammar, shorten, expand, suggest a subject line, and answer incoming mail as
a suggested draft. That is instruction-following on short text, and a small
model does it well. But the moment a client wants the model to *act* — set an
alert, save a draft on its own, take an agent step — the failure below the
floor is not a worse answer, it is no action and no error:

| below the floor | what the operator sees |
|---|---|
| no reliable `tools` capability | it answers perfectly and never calls the tool. Nothing in any log. |
| small context | the thread it was given is the thread it ignores, and it invents |
| weak instruction following | the format the client asked for becomes a suggestion |
| 384- or 768-wide embeddings | search misses exactly the paraphrases it exists to catch |

**The floor is a warning, never a wall.** Every model below is installable,
`./bin/perch pull-model` takes any tag at all, and the installer offers a
sub-floor model rather than refusing — it just says what will not work first.
What the floor governs is what a **feature** may assume, not what an **operator**
may install. If you want `qwen3:1.7b` on a 4 GB box to see how far it gets,
that is a decision that belongs to you.

| Model | Wants | Notes |
|---|---|---|
| `qwen3.5:2b` | 4.8 GB | Runs anywhere, no GPU needed. Shipped at Q8, so less lossy than its size suggests. Tidying text rather than drafting. Well below the floor. |
| `qwen3.5:4b` | 5.6 GB | The smallest that writes a whole email without wandering. A 6–8 GB card. Below the floor: fine for drafting, unreliable at calling tools. |
| **`qwen3.5:9b`** | **9.4 GB** | **The floor.** Drafts you would send after a glance, and reliable enough at tools to build a feature on. 262k context, so a whole thread fits untrimmed. |
| **`gemma4:12b`** | **10.6 GB** | **The floor, and the pick for a 12–16 GB card.** A true 12B in 7.6 GB — smaller on disk than `gemma4:e4b` and considerably better. |
| `gemma4:e4b` | 13.0 GB | A nested build: ~4B parameters active out of a 9.6 GB file. Fast, but `gemma4:12b` beats it in a smaller file. |
| `qwen3.8:27b` | 22.8 GB | Newest Qwen, and it ships only at 27b — under 24 GB there is no build of this generation, so `qwen3.5:9b` remains the current answer. |
| `gemma4:31b` | 25.3 GB | A 32 GB card. The largest dense Gemma of this generation. |

### The embedding model is a second, separate claim

It loads **beside** the language model, not instead of it, and stays resident
while anything is searching — so budget `qwen3-embedding:4b`'s ~3.4 GB on top
of whatever the chat model wants, not out of it. A 16 GB card running
`gemma4:12b` has room; a 12 GB card is choosing between them.

`server/src/system.ts` carries the full list with widths and input windows.
The one cost worth knowing before you pick: **changing the embedding model
re-indexes every client that uses it.** Vectors made by one model are not
comparable with another's, so the old ones are not wrong, they are unusable.

### The other end: frontier models with thinking

The floor is where features must *work*. It is not where they should stop.

perch will front somebody else's API as well as a local Ollama — set
`PERCH_CHAT_UPSTREAM_API` and the token, allowlist, per-service proxy and
activity ring all sit in front of a hosted model exactly as they do in front of
a local one. A client pointed at perch pointed at a frontier model with
thinking enabled gets **more** out of the same features, and nothing in perch
truncates, flattens or hides that: reasoning is translated as its own channel
in `shapes.ts` rather than folded into the answer, and a model that spends a
minute deliberating before its first token is a supported shape, not a timeout.

That path has no floor at all. It is also the intended production setup — see
the README.

### Uncensored variants

Abliterated builds have the refusal direction ablated out of the weights. Worth
having when a stock model declines something ordinary — a firm complaint, a
debt letter, a frank review.

| Model | Wants | Notes |
|---|---|---|
| `huihui_ai/qwen3.5-abliterated:9b` | 9.4 GB | Same size and quantisation as stock. The lightest of these on 16 GB. |
| `huihui_ai/gemma-4-abliterated:12b` | 10.6 GB | True 12B, newest generation. Best quality per gigabyte here on 16 GB. |
| `huihui_ai/qwen3-abliterated:14b` | 12.3 GB | The largest true parameter count that fits 16 GB with context headroom. |
| `huihui_ai/gemma-4-abliterated:e4b` | 13.0 GB | Nested, ~4B active. Fast; the 12b above is better. |
| `huihui_ai/mistral-small-abliterated:24b` | 18.7 GB | Wants 24 GB. On 16 GB the weights alone are 14.3 GB and leave nothing for context. |

Two things to weigh. Ablation can soften instruction-following and make a model
slightly likelier to invent detail, so compare against the stock model on your
own mail rather than assuming an upgrade. And if you run a Tern AI responder in
send mode, the model's own refusals were the last check before an odd prompt
became an odd sent email — keep responders on the review queue while judging
one.

"Wants" is the download plus room to run: roughly 20% overhead and another
1.5 GB for the context window and a second request slot. A model whose weights
merely fit will spill into system memory on the first long thread.

Every tag above was checked against the Ollama registry. Sizes are measured;
the ranking by quality is worth testing on your own mail, because a newer model
at a smaller size often beats an older larger one — which is why the
recommendation prefers the current generation over whatever is biggest, and why
nested builds are never auto-recommended despite their larger files.

perch's Models page greys out anything that will not fit and marks the one it
recommends for your hardware.

For **meaning search**, Tern uses a separate, much smaller embedding model —
`all-minilm` by default. Download it on perch too if anyone will use search.

## Settings on the Tern side worth knowing

- **Keep model loaded** — Tern's keep-alive is passed through to Ollama. Long
  keeps mean fast first replies and a model sitting in VRAM; short ones free
  the card. perch has its own "drop when idle" switch that is stricter.
- **Requests at once** — Tern will not send more concurrent generations than
  Ollama has slots. Set `OLLAMA_NUM_PARALLEL` on the perch side (System page)
  and tell Tern the same number.
- **Thinking** — reasoning models answer in two parts and Tern wants the
  reply. It is off unless an admin turns it on. Over a tunnel it also means
  paying latency for tokens you discard.
- **Context window** — bigger contexts cost KV cache per slot. perch's Status
  page shows what is left.

## Model management from Tern

If perch's token has the `manage` scope, Tern's Admin → AI model page can
download and delete models on your home machine directly — the pull streams
progress back over the tunnel.

Convenient, and also the most destructive thing a leaked token could do. To
turn it off, either issue the token without `manage`, or switch
**Allow model management over the tunnel** off in perch's Settings, which
overrides every token.

## What happens when the tunnel is down

Tern treats the model as unavailable: drafting is unavailable and everything
else — mail, sequences, rules — carries on. Nothing in Tern's mail path
depends on perch.

Tern's automated sending has a hard filter in front of it that holds anything
containing an unresolved merge field, a placeholder or an "as an AI" line.
That runs on the Tern side and is unaffected by where the model lives.
