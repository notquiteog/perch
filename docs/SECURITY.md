# Security

perch takes a machine with a GPU on your home network and makes part of it
reachable from a server somewhere else. That is worth being careful about.
This is what it does, and what it does not do.

## What is exposed

One TCP port, on the VPS's podman bridge, reachable by containers on that box
and by root on that box. Nothing on your home network is reachable from
outside, and nothing on the VPS's public interface is added.

To get to your GPU, an attacker needs either the tunnel's private key (on your
home machine, readable only by the `perch` service account) or an API token
*and* a foothold on the VPS.

## The endpoint

Every request needs `Authorization: Bearer <token>`.

- Tokens are 32 random bytes, base64url, prefixed `perch_`.
- Stored as SHA-256. perch cannot show you a token again; it can only replace
  it.
- Compared in constant time.
- Two scopes: `use` (generate, embed, read) and `manage` (pull, delete). A
  token for Tern usually has both, so Tern's admin page can manage models;
  drop `manage` if you would rather it could not, and there is a master switch
  in Settings that overrides every token.
- Ten wrong tokens from one address in fifteen minutes and that address is
  refused entirely for fifteen minutes.

### The allowlist

The proxy has a table of method-and-path pairs. Anything not in it returns 404
regardless of token — the same answer whether the path is unknown to Ollama or
merely not permitted here, because there is nothing to gain from helping a
scanner tell the difference.

Not in the table, deliberately:

| | |
|---|---|
| `POST /api/create` | Writes a model onto your machine from a Modelfile. |
| `POST /api/push` | Uploads a model *off* your machine. |
| `POST /api/copy` | Duplicates models. |
| `/api/blobs/*` | Raw blob upload. |

Ollama has no authentication of its own and publishes no port in perch's
compose file, so the allowlist is the whole of its exposure.

## What perch never sees

The proxy streams request and response bodies through without parsing,
buffering or logging them. There is no place in the code where a prompt or a
completion is read.

The Activity page records: time, method, path, status, duration, bytes,
token name, peer address. It is in memory, capped, and gone when perch
restarts. It never touches disk.

Throughput is measured by counting newline bytes in the response stream —
Ollama emits one JSON object per token, so newlines are tokens. perch learns
the rate without learning the content. This is not a claim you have to take on
trust; `server/src/proxy.test.ts` asserts it, and it matches Ollama's own
`eval_count`.

Logs never contain message content, at any log level.

## The console

On `127.0.0.1:8099` by default.

- With no password, it serves only loopback and returns 403 to everything
  else, with an explanation. There is no configuration in which it is
  reachable and open.
- With a password (scrypt, per-password salt), it serves a session cookie —
  `HttpOnly`, `SameSite=Strict`, twelve hours, held in memory so a restart
  signs everyone out. A wrong password costs a deliberate 750 ms.
- The console is plain HTTP. That is fine on loopback. If you expose it on
  your LAN, put it behind something that does TLS; perch will not stop you,
  but do not do it over the internet.
- Static responses carry a strict CSP with `frame-ancestors 'none'`.

## Privilege separation

The console can start containers, enable boot units and drive the tunnel. All
of that needs root — and the console lives in the same process as the
internet-facing proxy.

So the container does not have it. Mounting the podman socket would have been
three lines of compose, and would also mean that a bug in the proxy is root on
your desktop. Instead:

- `perch-hostd` runs on the host as a systemd service.
- perch writes a request file into a shared directory; the helper reads it,
  matches the action against a literal `case` list, and writes a result back.
- Actions take no free-form arguments. Service names are matched against
  `perch|ollama`; environment keys against a fixed list with a pattern per
  key; request ids must match `^[A-Za-z0-9_-]{6,64}$` before becoming a
  filename.
- An action that is not in the list cannot be performed, whatever the
  container asks for.

The worst a compromised perch container can do through this channel is restart
containers and change Ollama tuning values.

## The tunnel key

Generated on your machine with `ssh-keygen -t ed25519`, private half mode 600
owned by the `perch` service account, never transmitted.

At the far end it is restricted with `restrict,port-forwarding,permitlisten=`
and a forced `nologin` — it can hold one port open on one address and do
nothing else. Not a shell, not a file transfer, not a different port.

The tunnel unit runs as an unprivileged account under a systemd sandbox:
`ProtectSystem=strict`, `ProtectHome`, empty `CapabilityBoundingSet`,
`SystemCallFilter=@system-service`, `MemoryDenyWriteExecute`.

Host keys are trust-on-first-use (`StrictHostKeyChecking=accept-new`) into a
known_hosts file of perch's own. Compare the fingerprint the first time if you
want certainty about the first connection.

## The bind-address rail

A tunnel told to land on a public address would publish your model endpoint to
the internet. It is checked three times, independently:

- `server/src/tunnel.ts` — refuses anything that is not loopback or RFC 1918.
- `deploy/perch-hostd` — refuses again before writing the unit file.
- `deploy/tern-side-setup.sh` — refuses again on the far side.

Each has tests or an equivalent check. Three implementations of one rule is
deliberate.

## What perch does not protect against

- **A compromised Tern box.** Anything that can read Tern's settings has the
  token and can use your GPU. Revoke the token; that is what scopes and
  per-token revocation are for.
- **A compromised home machine.** perch is not a sandbox for Ollama.
- **Someone with root on the perch box.** They have the key and the state file.
- **Traffic analysis.** SSH hides content, not the fact that a connection
  exists or roughly how much went over it.
- **Model output.** perch does not filter what the model writes. Tern has its
  own checks before anything is sent.

## Reporting something

Open an issue at https://github.com/notquiteog/perch/issues. If it is
sensitive, say so in the issue without details and a private channel can be
arranged.
