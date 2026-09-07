# Contributing

Bug reports and patches welcome. perch is small on purpose — please read this
before adding to it.

## Running it locally

```bash
npm install
npm run dev:server     # console API on :8099, model endpoint on :11434
npm run dev:client     # the console UI on :5199, proxying /api
npm test
npm run typecheck
```

`PERCH_OLLAMA_URL` points at any Ollama, so you do not need the containers:

```bash
PERCH_OLLAMA_URL=http://127.0.0.1:11434 PERCH_STATE_DIR=./data npm run dev:server
```

## Things to keep true

**The server has no runtime dependencies.** It imports nothing but `node:*`.
This is the component exposed to a tunnel; a framework in it is a supply chain
in it. If you need a router, `server/src/http.ts` is sixty lines — extend it.

**The proxy never reads a body.** Not to log it, not to count tokens, not to
validate it. If you need a number out of a response, find a way to get it that
does not involve the content — `metrics.ts` counts newline bytes, and explains
why. A patch that parses a completion will not be merged.

**The bind-address rail stays in three places.** `tunnel.ts`, `perch-hostd`
and `tern-side-setup.sh` each independently refuse a non-private bind address.
That duplication is on purpose. Do not consolidate it.

**The container gets no podman access.** New privileged operations go in
`perch-hostd`'s `case` list as a named action with validated arguments. Do not
add a socket mount.

**Comments say why, not what.** The code says what. Where perch does something
that looks odd — `ExitOnForwardFailure`, counting newlines, a polling loop
instead of a socket — the comment should explain the failure it prevents.

## Tests

`npm test` runs the server suite. The proxy tests are the important ones: they
assert what is *refused*, not just what works. If you touch the route table,
auth, or the tunnel validation, add a case.

Shell scripts are checked with `shellcheck -S warning` in CI.

## Style

Two-space indent, single quotes, semicolons. British spelling in prose;
identifiers stay whatever they are. Plain language over jargon — the docs are
meant to be readable by someone setting this up at eleven at night.
