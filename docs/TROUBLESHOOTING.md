# When it does not work

Start here:

```bash
./bin/perch doctor
```

It checks the endpoint, Ollama, whether a model is downloaded, the key, the
host helper, the tunnel, and — the usual culprit — whether the container can
actually see the GPU.

## Tern says the model is unreachable

Work outwards from perch.

**1. Is perch listening at home?**
```bash
curl -s http://127.0.0.1:11434/healthz
```
Expect `{"ok":true,"service":"perch"}`. If not, `./bin/perch up`.

**2. Is the tunnel up?**
```bash
./bin/perch tunnel status
./bin/perch tunnel logs
```

**3. Is the port there on the Tern box?**
```bash
ss -lntp | grep 11434
curl -s http://10.89.0.1:11434/healthz
```

**4. Can Tern's container reach it?** This is the test that matters:
```bash
podman exec -it tern_app_1 wget -qO- http://host.containers.internal:11434/healthz
```

**5. Did the request arrive?** perch's **Activity** page. If Tern's test shows
up there as a 401, the tunnel is fine and the token is wrong. If nothing shows
up at all, the problem is between Tern and the tunnel.

## The tunnel keeps restarting

Almost always the remote port is still held by a previous session.

```bash
./bin/perch tunnel logs
```

`Warning: remote port forwarding failed for listen port 11434` means exactly
that. `ExitOnForwardFailure` is doing its job — exiting rather than pretending
to work. On the Tern box:

```bash
sudo ss -lntp | grep 11434     # find the stale sshd
sudo pkill -u perch sshd       # drop the tunnel account's sessions
```

If it happens repeatedly, `ClientAliveInterval` is not set on the Tern box —
re-run `tern-side-setup.sh`, which adds it.

## "Permission denied (publickey)"

- The key was not installed: re-run `tern-side-setup.sh` with the key from the
  Connect page.
- Wrong account: the tunnel logs in as `perch`, not you.
- Home directory permissions: sshd refuses `authorized_keys` if the directory
  is group-writable. `chmod 700 ~perch/.ssh && chmod 600 ~perch/.ssh/authorized_keys`.

Test by hand from the perch box:

```bash
sudo -u perch ssh -i /var/lib/perch/ssh/id_ed25519 -p 22 perch@your-vps
```

You should be disconnected immediately — that is the forced `nologin` working.
"Permission denied" is a different problem.

## Everything is very slow

The model is on the CPU. Check:

```bash
./bin/perch doctor
```

If it reports the container cannot see the GPU:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
./bin/perch restart
```

The Status page confirms it: a loaded model shows **100%** under "On GPU" when
it is really on the card, and **CPU** when it is not.

Also check the model actually fits. If it is bigger than your VRAM, Ollama
splits it and part runs on the CPU — much slower than either alone. The Models
page greys out anything that will not fit.

## Downloads fail part way

Usually disk. The Status page shows what is free where the models live. Ollama
resumes, so run the download again.

## The console will not open

- From the machine itself, check it is running: `./bin/perch status`.
- From another machine, you need a password: `./bin/perch console-password`.
  Without one the console refuses every non-loopback request by design.

## The GPU panel is empty

The host helper is not running:

```bash
sudo systemctl status perch-hostd
sudo ./bin/perch hostd-install
```

perch works without it — you just lose GPU telemetry and the container and
tunnel controls in the UI.

## A token stopped working

Check **Settings**: it may have been revoked, or **Allow model management**
may be off while the token is being used for a pull. The Activity page
distinguishes them — 401 is an unknown or revoked token, 403 is a scope.

## Starting over

```bash
sudo ./bin/perch down
sudo rm /var/lib/perch/state.json     # tokens and settings; keeps models and the key
sudo ./bin/perch up
```
