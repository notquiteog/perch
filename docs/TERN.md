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

Tern's drafting work is: write a reply in a thread, rewrite a paragraph, fix
grammar, shorten, expand, suggest a subject line, and answer incoming mail as
a suggested draft. That is instruction-following on short text, which is a
much easier job than it sounds — you do not need a large model to do it well.

| Model | Wants | Notes |
|---|---|---|
| `qwen3.5:2b` | 4.8 GB | Runs anywhere, no GPU needed. Shipped at Q8, so less lossy than its size suggests. Tidying text rather than drafting. |
| `qwen3.5:4b` | 5.6 GB | The smallest that writes a whole email without wandering. A 6–8 GB card. |
| `qwen3.5:9b` | 9.4 GB | The floor for drafts you would send after a glance. 262k context, so a whole thread fits untrimmed. |
| `gemma4:12b` | 10.6 GB | **The pick for a 12–16 GB card.** A true 12B in 7.6 GB — smaller on disk than `gemma4:e4b` and considerably better. |
| `gemma4:e4b` | 13.0 GB | A nested build: ~4B parameters active out of a 9.6 GB file. Fast, but `gemma4:12b` beats it in a smaller file. |
| `qwen3.8:27b` | 22.8 GB | Newest Qwen, and it ships only at 27b — under 24 GB there is no build of this generation, so `qwen3.5:9b` remains the current answer. |
| `gemma4:31b` | 25.3 GB | A 32 GB card. The largest dense Gemma of this generation. |

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
