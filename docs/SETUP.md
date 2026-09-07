# Setup

## Before you start

On the machine with the GPU:

- **podman** and **podman-compose** (or `podman compose`).
- **openssh-client** — the tunnel is ordinary `ssh`.
- **systemd**, for the tunnel and the host helper. Without it perch still
  works, but you run the tunnel yourself.
- For **NVIDIA**: the container toolkit with CDI configured.
  ```bash
  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
  ```
  The installer checks and tells you if it is missing.
- For **AMD**: a ROCm-capable card with `/dev/kfd` present. The installer
  switches to the ROCm image.

You also need SSH access to the machine Tern runs on, with sudo, once.

## Install

```bash
git clone https://github.com/notquiteog/perch.git
cd perch
sudo ./install.sh
```

The installer:

1. checks podman, ssh and systemd;
2. finds the GPU and how much VRAM it has;
3. sizes a model and a slot count from that;
4. creates the unprivileged `perch` account the tunnel runs as;
5. creates `/var/lib/perch`, shared between container and host helper;
6. writes `.env`;
7. installs and starts `perch-hostd`, and optionally the boot unit;
8. builds and starts the containers;
9. downloads the model;
10. prints a token.

It is safe to run again — your previous answers are the defaults, and nothing
is rebuilt or restarted unless it changed.

## Then the tunnel

Open `http://127.0.0.1:8099` and go to **Connect**.

1. **Generate a key.** It never leaves this machine.
2. **Type the SSH host** of the box Tern runs on. That is the only thing you
   need to know.
3. **Run the one command it shows you** on that box. It creates a locked-down
   account, installs the key with restrictions, teaches sshd to reap dead
   tunnels, and prints one line.
4. **Paste that line back.** Paste the whole terminal output if it is easier —
   perch finds the line in it. It then saves the address, writes the systemd
   unit, starts the tunnel, enables it at boot and mints a token.
5. **Copy the base URL and API key into Tern**, under Admin → AI model.

The pasted line is the only thing that travels between the two machines. The
address it carries belongs to the Tern box, and the tunnel key is restricted
to `nologin` so perch cannot ask for it over SSH — which is the point of the
restriction, and the reason for the paste.

If you would rather do it from a terminal, [REMOTE.md](REMOTE.md) has every
command written out.

## The console from another machine

By default the console answers only on the machine it runs on. To open it from
a laptop on your own network:

```bash
./bin/perch console-password
```

Then change `PERCH_CONSOLE_PORT`'s bind in `compose.yml` from `127.0.0.1` to
the LAN address you want, and `./bin/perch restart`.

Do not put the console on the internet. It is plain HTTP, and it is the thing
that can start and stop everything.

## Day to day

```bash
./bin/perch status          # a summary of everything
./bin/perch doctor          # check the things that usually go wrong
./bin/perch logs ollama     # follow a container's logs
./bin/perch models          # what is installed, what is loaded
./bin/perch pull-model qwen3.5:9b
./bin/perch token "second laptop"
./bin/perch tunnel restart
./bin/perch boot on
./bin/perch update
```

## Uninstall

```bash
sudo ./bin/perch down
sudo systemctl disable --now perch-hostd perch-tunnel perch
sudo rm /etc/systemd/system/perch{,-hostd,-tunnel}.service
sudo systemctl daemon-reload
sudo rm -rf /var/lib/perch        # tokens and the tunnel key
sudo userdel perch
podman volume rm perch_perch-models   # the downloaded models
```

And on the Tern box:

```bash
sudo bash tern-side-setup.sh --uninstall
```
