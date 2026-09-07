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
| `qwen3.5:2b` | 4.8 GB | Runs anywhere, including with no GPU. Good for tidying up text you wrote; not for drafting unsupervised. |
| `qwen3.5:4b` | 5.6 GB | The smallest that writes a whole email without wandering. Comfortable on a 6–8 GB card. |
| `qwen3.5:9b` | 9.4 GB | **The sensible floor for drafts you would send after a glance.** The sweet spot on a 12–16 GB card, and its long context means a whole thread fits. |
| `gemma3:12b` | 11.3 GB | A step up for a 16 GB card if you prefer Gemma's register. |
| `phi4:14b` | 12.4 GB | Follows an instruction exactly, which suits rewriting and shortening. Only 16k of context, so long threads get trimmed. |
| `mistral-small:24b` | 18.7 GB | Wants a 24 GB card. Too tight on 16 GB — the weights leave nothing for context. |
| `qwen3.5:27b` | 22.4 GB | For a 24–32 GB card. Where drafts often need no edit at all. |

"Wants" is the download plus room to run: roughly 20% overhead and another
1.5 GB for the context window and a second request slot. A model whose weights
merely fit will spill into system memory on the first long thread and generate
at a fraction of the speed.

Sizes above were read from the Ollama registry, not remembered. The ranking by
quality is a different matter and worth testing on your own mail — a newer
model at a smaller size often beats an older larger one, which is why the
recommendation prefers the current generation over whatever is biggest.

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
