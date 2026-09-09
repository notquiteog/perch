#!/usr/bin/env bash
# =============================================================================
# perch installer. Safe to run again: every answer you gave last time is the
# default next time, and nothing is rebuilt or restarted unless it changed.
#
#   sudo ./install.sh              walk through it
#   sudo ./install.sh --yes        take the defaults, no questions
#   sudo ./install.sh --no-build   skip the container build
#   sudo ./install.sh --help
# =============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"
NONINTERACTIVE=0
SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --yes|-y) NONINTERACTIVE=1 ;;
    --no-build) SKIP_BUILD=1 ;;
    --help|-h) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else B=; D=; G=; Y=; R=; C=; N=; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
have() { command -v "$1" >/dev/null 2>&1; }

ask() {
  local var="$1" prompt="$2" def="${3:-}" cur="${!1:-}" ans
  [ -n "$cur" ] && def="$cur"
  if [ "$NONINTERACTIVE" = 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  if [ -n "$def" ]; then read -r -p "  $prompt [$def]: " ans || true
  else read -r -p "  $prompt: " ans || true; fi
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_yn() {
  local var="$1" prompt="$2" def="${3:-y}" ans
  if [ "$NONINTERACTIVE" = 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "  $prompt [$( [ "$def" = y ] && echo 'Y/n' || echo 'y/N')]: " ans || true
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) printf -v "$var" 'y' ;; *) printf -v "$var" 'n' ;; esac
}

[ "$(id -u)" -eq 0 ] || die "run this with sudo — it installs systemd units and creates a service account."
# Root, with root's own container storage. `sudo -E ./install.sh` would keep the
# invoking user's HOME, and podman reads ~/.config/containers/storage.conf from
# it — which would build this install into that user's rootless store while
# every later `sudo ./bin/perch` looked in root's. See the note in bin/perch.
export HOME=/root
unset XDG_RUNTIME_DIR XDG_DATA_HOME XDG_CONFIG_HOME

printf '\n%s  perch%s  %sa perch for your model%s\n' "$B" "$N" "$D" "$N"

# ---------- 1. what is already here ----------
step "Checking this machine"
have podman || die "podman is not installed. On Debian/Ubuntu: apt install podman"
ok "podman $(podman --version | awk '{print $3}')"
if have podman-compose; then COMPOSE_CMD="podman-compose"
elif podman compose version >/dev/null 2>&1; then COMPOSE_CMD="podman compose"
else die "neither podman-compose nor 'podman compose' is available. On Debian/Ubuntu: apt install podman-compose"; fi
ok "using $COMPOSE_CMD"
have ssh || die "the openssh client is not installed; the tunnel needs it. apt install openssh-client"
have ssh-keygen || die "ssh-keygen is missing (openssh-client)."
ok "ssh $(ssh -V 2>&1 | awk '{print $1}')"
have systemctl || warn "no systemd here; the tunnel and the host helper will have to be run by hand."
# Not required, but worth saying: if Tor is already here, the tunnel can use
# it, and the Connect page is where that is switched on.
if ss -lnt 2>/dev/null | grep -q '127.0.0.1:9050'; then
  ok "Tor is running on 127.0.0.1:9050"
  note "the tunnel can dial out through it — Connect → advanced settings"
fi

RAM_KB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
RAM_GB=$(( RAM_KB / 1024 / 1024 ))
ok "${RAM_GB} GB of memory, $(nproc) cores"

# ---------- 2. the GPU ----------
#
# There are two ways to give a container an NVIDIA GPU, and only one of them
# needs software installed.
#
#   CDI      the NVIDIA container toolkit generates a spec and podman hands
#            over the whole device. Tidy, and the right answer if the toolkit
#            is there.
#   devices  pass the /dev/nvidia* nodes straight through and bind-mount the
#            driver libraries over the top. The ollama image already carries
#            LD_LIBRARY_PATH=/usr/local/nvidia/lib64 for exactly this, so it
#            needs nothing installed at all.
#
# The second is written off too readily. A machine with a working driver and
# no container toolkit is a very common setup, and falling back to the CPU
# there — on a box someone bought a GPU for — is the wrong answer.

# Write a compose overlay that passes the devices and the driver libraries
# through by hand. The library filenames carry the driver version, so this has
# to be generated on the machine rather than shipped.
#
#   $1     the file to write, under deploy/generated
#   $2...  the compose services to hand the GPU to
#
# The service list is an argument because an overlay may only mention services
# that exist: naming `comfy` in a file used by an install without the video
# overlay would create a second, image-less service and fail the whole `up`.
# Only the services actually switched on are ever named.

# Which image a service runs, read from the compose file that defines it
# rather than repeated here. The overlays write `image: ${VAR:-default}`, so
# the default and any override in .env both resolve the same way they will
# when compose reads it — a second copy of these defaults in this script would
# be one more thing to get out of step.
compose_image_for() {
  local svc="$1" file raw resolved
  case "$svc" in
    ollama)  file="compose.yml" ;;
    whisper) file="compose.voice.yml" ;;
    comfy)   file="compose.video.yml" ;;
    kokoro)  file="compose.audio.yml" ;;
    *)       return 0 ;;
  esac
  [ -f "$INSTALL_DIR/$file" ] || return 0
  raw=$(awk -v want="  $svc:" '
    $0 == want { inside = 1; next }
    inside && /^  [a-z]/ { exit }
    inside && /^ *image:/ { sub(/^ *image: */, ""); print; exit }
  ' "$INSTALL_DIR/$file")
  [ -n "$raw" ] || return 0
  # Only ${VAR:-default} is expanded, and the result has to look like an image
  # reference before it is used for anything.
  case "$raw" in *'`'*|*'$('*) return 0 ;; esac
  resolved=$(eval "printf '%s' \"$raw\"" 2>/dev/null) || return 0
  case "$resolved" in
    [A-Za-z0-9]*) printf '%s' "$resolved" ;;
    *) return 0 ;;
  esac
}

# Where a container's loader already looks, so the driver libraries can be put
# somewhere it will find them.
#
# Mounting them under /usr/local/nvidia/lib64 is only half the job: it works
# for the ollama image because that image puts the directory on
# LD_LIBRARY_PATH, and it does nothing at all for an image that sets its own —
# ComfyUI ships a long LD_LIBRARY_PATH of torch's bundled CUDA libraries, and
# the mounted driver is invisible beside it. The container then reports "found
# no NVIDIA driver" on a machine whose driver is fine, and restart-loops.
#
# So the path is read from the image and prepended to, rather than assumed or
# replaced. An image that is not pulled yet has nothing to read, and the
# directory alone is right for that case — no image that sets the variable is
# missing at this point, because compose pulls before this is used.
image_library_path() {
  local image="$1" existing
  existing=$(podman image inspect "$image" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^LD_LIBRARY_PATH=//p' | head -1)
  if [ -n "$existing" ]; then printf '/usr/local/nvidia/lib64:%s' "$existing"
  else printf '/usr/local/nvidia/lib64'; fi
}

generate_device_overlay() {
  local out="$INSTALL_DIR/deploy/generated/$1"; shift
  local libdir dev lib target svc found=0 image
  mkdir -p "$INSTALL_DIR/deploy/generated"
  libdir=$(dirname "$(ls -1 /usr/lib/*/libcuda.so.[0-9]* /usr/lib64/libcuda.so.[0-9]* 2>/dev/null | head -1)" 2>/dev/null)
  [ -n "$libdir" ] && [ -d "$libdir" ] || return 1

  {
    echo "# Generated by install.sh on $(date -Is). Do not edit; re-run the installer."
    echo "#"
    echo "# Hands the GPU to a container without the NVIDIA container toolkit: the"
    echo "# device nodes go through directly, and the host's driver libraries are"
    echo "# mounted where the CUDA runtime inside already looks for them."
    echo "services:"
    for svc in "$@"; do
      echo "  $svc:"
      echo "    security_opt:"
      echo "      - label=disable"
      # The image each service runs, so its own loader path can be read.
      image=$(compose_image_for "$svc")
      if [ -n "$image" ]; then
        echo "    environment:"
        echo "      LD_LIBRARY_PATH: $(image_library_path "$image")"
      fi
      echo "    devices:"
      for dev in /dev/nvidia[0-9]* /dev/nvidiactl /dev/nvidia-modeset /dev/nvidia-uvm /dev/nvidia-uvm-tools; do
        [ -e "$dev" ] && echo "      - $dev:$dev"
      done
      echo "    volumes:"
      # soname => the name the loader actually asks for. libcuda and nvidia-ml
      # are the two that matter; the rest are needed by newer CUDA runtimes.
      for pair in "libcuda.so:1" "libnvidia-ml.so:1" "libnvidia-ptxjitcompiler.so:1" "libnvidia-nvvm.so:4" "libnvidia-cfg.so:1"; do
        lib="${pair%%:*}"; target="${pair##*:}"
        src=$(ls -1 "$libdir/$lib".[0-9]* 2>/dev/null | head -1)
        [ -n "$src" ] || continue
        echo "      - $src:/usr/local/nvidia/lib64/$lib.$target:ro"
        found=1
      done
      # libcuda.so with no soname suffix, which some builds link against.
      src=$(ls -1 "$libdir/libcuda.so".[0-9]* 2>/dev/null | head -1)
      [ -n "$src" ] && echo "      - $src:/usr/local/nvidia/lib64/libcuda.so:ro"
    done
  } > "$out"

  [ "$found" = 1 ] || { rm -f "$out"; return 1; }
  echo "$out"
}

# The same, for the ways of handing over a GPU that need no generated paths.
# Written rather than shipped for the reason above: it may only name the
# optional services this install actually has.
write_media_gpu_overlay() {
  local out="$INSTALL_DIR/deploy/generated/compose.gpu-media.yml" svc
  mkdir -p "$INSTALL_DIR/deploy/generated"
  {
    echo "# Generated by install.sh on $(date -Is). Do not edit; re-run the installer."
    echo "#"
    echo "# The optional services generate on the GPU too — an image model on the CPU"
    echo "# is minutes per picture and a video model is hours per clip."
    echo "services:"
    for svc in "$@"; do
      echo "  $svc:"
      echo "    security_opt:"
      echo "      - label=disable"
      case "$GPU_KIND" in
        nvidia)
          echo "    devices:"
          echo "      - nvidia.com/gpu=all" ;;
        amd)
          echo "    devices:"
          echo "      - /dev/kfd"
          echo "      - /dev/dri"
          echo "    group_add:"
          echo "      - video"
          echo "      - render" ;;
      esac
    done
  } > "$out"
  echo "$out"
}

step "Looking for a GPU"
GPU_KIND="none"; VRAM_MB=0; GPU_MODE=""
if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  GPU_KIND="nvidia"
  ok "$GPU_NAME with ${VRAM_MB} MB"
  if [ -f /etc/cdi/nvidia.yaml ] || [ -f /var/run/cdi/nvidia.yaml ]; then
    GPU_MODE="cdi"
    ok "the NVIDIA container toolkit is configured"
  elif [ -e /dev/nvidiactl ] && OVERLAY=$(generate_device_overlay compose.gpu-devices.yml ollama); then
    GPU_MODE="devices"
    ok "no container toolkit here, so passing the devices and driver libraries through directly"
    note "wrote $(basename "$OVERLAY")"
    note "if you later install the toolkit, re-run this and it will use it instead"
  else
    warn "the driver is installed but the GPU cannot be handed to a container"
    note "either install the NVIDIA container toolkit and run:"
    note "  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"
    note "or check that /dev/nvidia* exist and the driver libraries are readable"
    ask_yn USE_GPU_ANYWAY "Carry on with the CPU for now?" y
    [ "$USE_GPU_ANYWAY" = y ] || die "stopping so you can sort the GPU out first."
    GPU_KIND="none"
  fi
elif [ -e /dev/kfd ]; then
  GPU_KIND="amd"
  for f in /sys/class/drm/card*/device/mem_info_vram_total; do
    [ -r "$f" ] && VRAM_MB=$(( $(cat "$f") / 1048576 )) && break
  done
  ok "an AMD GPU with ${VRAM_MB} MB (ROCm)"
else
  warn "no GPU found — the model will run on the CPU, which is slow but works"
fi

# ---------- 3. sizing ----------
step "Sizing"
if [ "$VRAM_MB" -gt 1024 ]; then USABLE_MB=$(( VRAM_MB * 9 / 10 )); BASIS="the GPU"
else USABLE_MB=$(( RAM_KB / 1024 * 2 / 3 )); BASIS="system memory"; fi
# ---------- The floor ----------
#
# The memory a machine needs before it can run a model the CLIENTS' features
# are built and tested against: qwen3.5:9b or gemma4:12b for chat, plus
# qwen3-embedding:4b for meaning search. perch has no AI features of its own;
# it hosts models for Tern, cryptostore and roost, and this is the line under
# which those go quietly wrong rather than slowly.
#
# Quietly is the word that matters. A model below this does not answer more
# slowly — it answers questions perfectly well and never calls the tool that
# sets the alert, files the draft or writes the entry, with no error anywhere
# for anyone to find.
#
# It is a warning, never a wall: pick_model still goes all the way down, every
# model stays installable, and somebody who wants a small model on a small box
# is making a decision that is theirs to make. What the floor governs is what a
# FEATURE may assume, not what an operator may install.
#
# 9400 = qwen3.5:9b's needsBytes in server/src/system.ts (FLOOR_BYTES), which is
# the 6.59 GB download plus room for the context window and a second slot.
# services.ts reads the same figure from FLOOR_BYTES rather than repeating it;
# this copy exists because the installer runs before there is any TypeScript to
# ask. Change one, change both.
FLOOR_MB=9400
FLOOR_EMBED_MB=3400   # qwen3-embedding:4b, resident, beside the chat model

# Mirrors MODELS in server/src/system.ts — keep the two in step. The
# thresholds are "needs to run well", which is the download plus room for the
# context window, not the download alone.
pick_model() {
  local mb=$1
  if   [ "$mb" -ge 25400 ]; then echo "gemma4:31b"
  elif [ "$mb" -ge 22800 ]; then echo "qwen3.8:27b"
  elif [ "$mb" -ge 10600 ]; then echo "gemma4:12b"
  elif [ "$mb" -ge "$FLOOR_MB" ]; then echo "qwen3.5:9b"
  elif [ "$mb" -ge 5600  ]; then echo "qwen3.5:4b"
  else echo "qwen3.5:2b"; fi
}
SUGGESTED_MODEL=$(pick_model "$USABLE_MB")
note "${USABLE_MB} MB usable, judged from $BASIS"
ok "suggested model: $SUGGESTED_MODEL"
# Said plainly, and then the install carries on and offers it anyway.
if [ "$USABLE_MB" -lt "$FLOOR_MB" ]; then
  warn "$SUGGESTED_MODEL is below the floor the clients' AI features are tested against"
  note "that floor is qwen3.5:9b or gemma4:12b, which want about ${FLOOR_MB} MB"
  note "$SUGGESTED_MODEL will answer questions. It will NOT reliably call tools, so"
  note "features that act — alerts, drafts saved for you, agent steps — may silently"
  note "do nothing rather than report an error"
  note "nothing here stops you: install it, try it, and point a client at a bigger"
  note "model later without reinstalling. perch can also front a hosted API instead"
  note "(PERCH_CHAT_UPSTREAM_API), which has no floor at all"
fi
# One slot per ~6 GB of usable memory, because each slot costs a context
# window of KV cache; never fewer than one, and past four the GPU is the limit
# rather than the slot count.
SLOTS=$(( USABLE_MB / 6000 )); [ "$SLOTS" -lt 1 ] && SLOTS=1; [ "$SLOTS" -gt 4 ] && SLOTS=4
ok "$SLOTS request slot(s)"

# ---------- 4. settings ----------
step "Settings"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; note "keeping what you chose last time as the defaults"; }

PERCH_STATE_DIR="${PERCH_STATE_DIR:-/var/lib/perch}"
# The optional services' ports, defaulted here rather than where .env is
# written, because the port check below reads them and runs first. Left until
# then, the first switched-on optional service ended the install with
# `!var: unbound variable`. These match the defaults in the compose overlays.
PERCH_VOICE_PORT="${PERCH_VOICE_PORT:-8080}"
PERCH_VIDEO_PORT="${PERCH_VIDEO_PORT:-8188}"
PERCH_AUDIO_PORT="${PERCH_AUDIO_PORT:-8880}"
ask PERCH_CONSOLE_PORT "Console port (on 127.0.0.1)" "${PERCH_CONSOLE_PORT:-8099}"
ask PERCH_PROXY_PORT   "Model endpoint port (on 127.0.0.1)" "${PERCH_PROXY_PORT:-11434}"
ask OLLAMA_NUM_PARALLEL "Requests answered at once" "${OLLAMA_NUM_PARALLEL:-$SLOTS}"
ask AI_MODEL "Model to download now (blank to choose later in the console)" "${AI_MODEL:-$SUGGESTED_MODEL}"

# The embedding model, which is a separate question because it is a separate
# claim on the same card: it loads BESIDE the language model rather than
# instead of it, and stays loaded while anything is searching.
#
# It was not asked at all until the floor was written down, which meant every
# client wanting meaning search had to find the console and know what to pull.
# qwen3-embedding:4b is what their meaning search is built and tested against;
# below it, retrieval gets worse on exactly the paraphrases the feature exists
# to catch, which is a failure nobody sees as a failure.
EMBED_HEADROOM=$(( USABLE_MB - FLOOR_MB ))
if [ "$EMBED_HEADROOM" -ge "$FLOOR_EMBED_MB" ]; then
  EMBED_SUGGESTED="qwen3-embedding:4b"
else
  # Not the floor, and said so below. all-minilm is 384-wide with a 512-token
  # window, so only the opening of a long document reaches the vector.
  EMBED_SUGGESTED="all-minilm"
fi
ask AI_EMBED_MODEL "Embedding model for clients' meaning search (blank to skip)" "${AI_EMBED_MODEL:-$EMBED_SUGGESTED}"
if [ "$AI_EMBED_MODEL" = "all-minilm" ] || [ "$AI_EMBED_MODEL" = "nomic-embed-text" ]; then
  warn "$AI_EMBED_MODEL is below the embedding floor (qwen3-embedding:4b)"
  note "meaning search will work and will retrieve worse on wording that shares no"
  note "words with what it is searching, which is the case the feature is for"
fi
# Worth saying once, here, because it is the one model change that is not free
# on the client side.
if [ -n "$AI_EMBED_MODEL" ]; then
  note "changing this later re-indexes every client that uses it: vectors made by"
  note "one embedding model are not comparable with another's"
fi

# The two optional services. Both cost memory on the same card the chat model
# is using, so they are off unless asked for, and the numbers are stated rather
# than discovered later when generation mysteriously halves in speed.
step "Optional services"
note "Both are off by default. Each is a second claim on the same GPU."
ask_yn VOICE_ENABLED "Add dictation (whisper.cpp, ~0.4-1 GB, runs fine on the CPU)?" "${VOICE_ENABLED:-n}"
if [ "$VOICE_ENABLED" = y ]; then
  # Same RAM check as the chat model: base fits anywhere, small is better on
  # accents and names.
  if [ "$RAM_GB" -ge 8 ]; then WHISPER_DEFAULT=small; else WHISPER_DEFAULT=base; fi
  ask WHISPER_MODEL "Whisper model (base or small)" "${WHISPER_MODEL:-$WHISPER_DEFAULT}"
fi
# One check, used by each of the generating services: does this and a chat
# model fit on the card at the same time? Stated here rather than discovered
# later, when generation mysteriously halves the speed of everything else.
warn_if_tight() {
  local need="$1" what="$2"
  # "a chat model" here means one at the floor — see FLOOR_MB above. It was a
  # bare 9400 with no name on it, which is the same number arrived at twice.
  [ "$USABLE_MB" -lt $(( need + FLOOR_MB )) ] || return 0
  warn "this card has ${USABLE_MB} MB usable; a chat model plus $what wants about $(( need + FLOOR_MB )) MB"
  note "they will not both stay resident — whichever was used last will hold the card"
  note "the console's Services panel shows the running total"
}

# One question for three families, because one container runs all of them.
# An image model here is 4-10 GB and a video model 8-30, and the warning is
# about the video end because that is the one that will not fit beside a chat
# model on a 16 GB card.
ask_yn VIDEO_ENABLED "Add image, video and music generation (ComfyUI, 4-30 GB on the card)?" "${VIDEO_ENABLED:-n}"
if [ "$VIDEO_ENABLED" = y ]; then
  warn_if_tight 12000 "a video model"
  note "one container runs Stable Diffusion checkpoints, FLUX, video and ACE-Step"
  note "images also get a plain OpenAI endpoint: POST /v1/images/generations"
  note "models are files rather than tags: the console's Models page lists them,"
  note "and ./bin/perch fetch <model> downloads one"
fi

ask_yn AUDIO_ENABLED "Add audio generation (Kokoro text to speech, ~1.5 GB)?" "${AUDIO_ENABLED:-n}"
if [ "$AUDIO_ENABLED" = y ]; then
  # The CPU build, unless the card is one the GPU build's torch was actually
  # built for. Kokoro is 82M parameters and generates faster than real time on
  # a few cores, so the CPU build is not a compromise — while the GPU build on
  # a card newer than its torch loads the model and then dies on the first
  # kernel with "no kernel image is available for execution on the device",
  # which is a long way from its cause and restart-loops for ever.
  #
  # Compute capability is what decides it: a prebuilt wheel carries kernels for
  # the architectures it was compiled against, and a newer card is not one of
  # them. 12.0 is Blackwell, which wants CUDA 12.8 at the earliest.
  KOKORO_IMAGE="ghcr.io/remsky/kokoro-fastapi-cpu:latest"
  if [ "$GPU_KIND" = nvidia ]; then
    cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' .')"
    if [ -n "$cap" ] && [ "$cap" -ge 120 ] 2>/dev/null; then
      note "this card is too new for the GPU build's CUDA, so the CPU build — which for 82M parameters is the right one anyway"
    else
      KOKORO_IMAGE="ghcr.io/remsky/kokoro-fastapi-gpu:latest"
    fi
  else
    note "no NVIDIA GPU, so the CPU build — which is the right one for a model this small"
  fi
fi

PERCH_SERVICES="chat"
[ "$VOICE_ENABLED" = y ] && PERCH_SERVICES="$PERCH_SERVICES,voice"
[ "$VIDEO_ENABLED" = y ] && PERCH_SERVICES="$PERCH_SERVICES,video"
[ "$AUDIO_ENABLED" = y ] && PERCH_SERVICES="$PERCH_SERVICES,audio"
ok "services: $PERCH_SERVICES"

# Every service wants a port on loopback, and a machine that already runs
# containers may well be using one. Finding that out at `up` time means a
# container that will not start and an error a long way from its cause, so the
# check happens here and moves to the next free port instead.
# A port already given to an earlier service in this same run counts as taken
# too. Only asking the kernel would hand the same number to two services
# whenever their defaults met — an .env from an older install has the
# dictation port where video's default now is — and one of the two containers
# would then fail to start.
CLAIMED=""
port_taken() {
  case " $CLAIMED " in *" $1 "*) return 0 ;; esac
  ss -lntH 2>/dev/null | grep -q "127.0.0.1:$1 \|0.0.0.0:$1 \|\*:$1 "
}
next_free() {
  local p="$1"
  while port_taken "$p"; do p=$(( p + 1 )); done
  printf '%s' "$p"
}
for spec in "PERCH_CONSOLE_PORT console" "PERCH_PROXY_PORT chat" "PERCH_VOICE_PORT dictation" \
            "PERCH_VIDEO_PORT video" "PERCH_AUDIO_PORT audio"; do
  var="${spec%% *}"; label="${spec##* }"
  case "$label" in
    dictation) [ "$VOICE_ENABLED" = y ] || continue ;;
    video)     [ "$VIDEO_ENABLED" = y ] || continue ;;
    audio)     [ "$AUDIO_ENABLED" = y ] || continue ;;
  esac
  current="${!var}"
  if port_taken "$current"; then
    replacement="$(next_free $(( current + 1 )))"
    warn "port $current is already spoken for, so $label would not start"
    note "using $replacement instead; change $var in .env if you would rather move the other thing"
    printf -v "$var" '%s' "$replacement"
    current="$replacement"
  fi
  CLAIMED="$CLAIMED $current"
done
port_summary="console $PERCH_CONSOLE_PORT, chat $PERCH_PROXY_PORT"
[ "$VOICE_ENABLED" = y ] && port_summary="$port_summary, dictation $PERCH_VOICE_PORT"
[ "$VIDEO_ENABLED" = y ] && port_summary="$port_summary, video $PERCH_VIDEO_PORT"
[ "$AUDIO_ENABLED" = y ] && port_summary="$port_summary, audio $PERCH_AUDIO_PORT"
ok "ports: $port_summary"

COMPOSE_FILE="compose.yml"
[ "$VOICE_ENABLED" = y ] && COMPOSE_FILE="$COMPOSE_FILE:compose.voice.yml"
[ "$VIDEO_ENABLED" = y ] && COMPOSE_FILE="$COMPOSE_FILE:compose.video.yml"
[ "$AUDIO_ENABLED" = y ] && COMPOSE_FILE="$COMPOSE_FILE:compose.audio.yml"
# The GPU overlay is appended, never assigned. Assigning here is what used to
# drop every optional service from COMPOSE_FILE on any machine with a GPU —
# which is every machine perch is meant for, and the symptom was a dictation
# endpoint configured in .env with no container behind it.
case "$GPU_KIND" in
  nvidia)
    case "$GPU_MODE" in
      cdi)     COMPOSE_FILE="$COMPOSE_FILE:compose.gpu.yml" ;;
      devices) COMPOSE_FILE="$COMPOSE_FILE:deploy/generated/compose.gpu-devices.yml" ;;
    esac ;;
  amd) COMPOSE_FILE="$COMPOSE_FILE:compose.rocm.yml" ;;
esac

# The optional services want the card as much as Ollama does, and until now
# nothing gave it to them: image generation on a CPU is minutes per picture,
# and video is hours per clip. The overlay is generated because it may only
# name the services this install actually has.
MEDIA_GPU_SERVICES=""
[ "$VIDEO_ENABLED" = y ] && MEDIA_GPU_SERVICES="$MEDIA_GPU_SERVICES comfy"
[ "$AUDIO_ENABLED" = y ] && [ "$GPU_KIND" = nvidia ] && MEDIA_GPU_SERVICES="$MEDIA_GPU_SERVICES kokoro"
if [ -n "$MEDIA_GPU_SERVICES" ] && [ "$GPU_KIND" != none ]; then
  # shellcheck disable=SC2086
  case "$GPU_MODE" in
    devices) MEDIA_OVERLAY=$(generate_device_overlay compose.gpu-media.yml $MEDIA_GPU_SERVICES || true) ;;
    *)       MEDIA_OVERLAY=$(write_media_gpu_overlay $MEDIA_GPU_SERVICES) ;;
  esac
  if [ -n "${MEDIA_OVERLAY:-}" ]; then
    COMPOSE_FILE="$COMPOSE_FILE:deploy/generated/compose.gpu-media.yml"
    ok "the GPU goes to$MEDIA_GPU_SERVICES as well as ollama"
  else
    warn "could not hand the GPU to$MEDIA_GPU_SERVICES; they will generate on the CPU"
  fi
fi
ok "compose overlays: $COMPOSE_FILE"

# ---------- 5. the service account ----------
step "The tunnel account on this machine"
# The tunnel runs unprivileged. Only this account can read the key.
if id perch >/dev/null 2>&1; then
  ok "the perch account already exists"
else
  useradd --system --no-create-home --home-dir "$PERCH_STATE_DIR" --shell /usr/sbin/nologin perch 2>/dev/null \
    || useradd --system --no-create-home --home-dir "$PERCH_STATE_DIR" --shell /sbin/nologin perch
  ok "created the perch account (no shell, no password)"
fi

# ---------- 6. the state directory ----------
step "State"
# 711, not 750. Three different identities need to reach into this directory:
# the console container (uid 1000, the owner), the host helper (root), and the
# unprivileged account the tunnel runs as — which is none of those and cannot
# traverse a 750 directory owned by somebody else. It failed as "Identity file
# not accessible", which reads like a missing key rather than a missing +x.
install -d -m 711 "$PERCH_STATE_DIR"
# 711: the tunnel account owns the private keys and only it can read them,
# but the console container (a different uid) must be able to traverse here to
# read a public key back. See do_keygen in deploy/perch-hostd.
install -d -m 711 "$PERCH_STATE_DIR/ssh"
install -d -m 755 "$PERCH_STATE_DIR/host"
install -d -m 733 "$PERCH_STATE_DIR/host/requests"
install -d -m 755 "$PERCH_STATE_DIR/host/results"
# The container runs as uid 1000; the host helper runs as root. Both need the
# directory, so it belongs to 1000 with the perch account's group.
chown -R 1000:1000 "$PERCH_STATE_DIR" 2>/dev/null || true
chown -R perch "$PERCH_STATE_DIR/ssh" 2>/dev/null || true
ok "$PERCH_STATE_DIR"

# ---------- 7. .env ----------
step "Writing .env"
cat > "$ENV_FILE" <<EOF
# Written by install.sh. Run it again to change any of this; it keeps your
# answers as the defaults.

# Where the console and the model endpoint listen. Both on 127.0.0.1 — the
# tunnel picks the endpoint up from there, and nothing needs a router change.
PERCH_CONSOLE_PORT=$PERCH_CONSOLE_PORT
PERCH_PROXY_PORT=$PERCH_PROXY_PORT
PERCH_STATE_DIR=$PERCH_STATE_DIR
PERCH_MAX_CONCURRENT=$(( OLLAMA_NUM_PARALLEL + 2 ))
# Which endpoints listen at all. A machine that only writes email should not
# have an image generator on a port.
PERCH_SERVICES=$PERCH_SERVICES
PERCH_VOICE_PORT=$PERCH_VOICE_PORT
PERCH_VIDEO_PORT=$PERCH_VIDEO_PORT
PERCH_AUDIO_PORT=$PERCH_AUDIO_PORT
WHISPER_MODEL=${WHISPER_MODEL:-base}
PERCH_LOG_LEVEL=info
PERCH_VERSION=0.1.0

# How big each container may be. A ceiling, not a reservation: nothing is
# taken until it is used, and past its ceiling a container is killed rather
# than slowed — so these have to clear what each one actually needs. Empty
# means no limit; the console's System page is where to change them.
PERCH_MEM_LIMIT=${PERCH_MEM_LIMIT:-256m}
PERCH_CPUS=${PERCH_CPUS:-0}
OLLAMA_MEM_LIMIT=${OLLAMA_MEM_LIMIT:-}
OLLAMA_CPUS=${OLLAMA_CPUS:-0}
WHISPER_MEM_LIMIT=${WHISPER_MEM_LIMIT:-2g}
WHISPER_CPUS=${WHISPER_CPUS:-0}
COMFY_MEM_LIMIT=${COMFY_MEM_LIMIT:-24g}
COMFY_CPUS=${COMFY_CPUS:-0}
KOKORO_MEM_LIMIT=${KOKORO_MEM_LIMIT:-4g}
KOKORO_CPUS=${KOKORO_CPUS:-0}
${KOKORO_IMAGE:+KOKORO_IMAGE=$KOKORO_IMAGE}

# Ollama. These are read when it starts, so change them here (or in the
# console) and restart.
OLLAMA_NUM_PARALLEL=$OLLAMA_NUM_PARALLEL
# Two: a chat model and an embedding model stay resident together, so search
# does not evict what you are talking to. Ollama keeps the second only if it
# fits.
OLLAMA_MAX_LOADED_MODELS=2
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_MAX_QUEUE=32
OLLAMA_KEEP_ALIVE=10m

# The model install.sh downloaded, for reference. The console is where you
# change which one is in use.
AI_MODEL=$AI_MODEL
AI_EMBED_MODEL=$AI_EMBED_MODEL

# Compose overlays, colon separated.
COMPOSE_FILE=$COMPOSE_FILE
EOF
chmod 600 "$ENV_FILE"
ok "$ENV_FILE"

# ---------- 8. systemd ----------
step "systemd units"
render() {
  sed -e "s|__PERCH_DIR__|$INSTALL_DIR|g" -e "s|__STATE_DIR__|$PERCH_STATE_DIR|g" \
      -e "s|__PERCH_UID__|1000|g" -e "s|__PERCH_GID__|1000|g" "$1" > "$2"
  chmod 644 "$2"
}
if have systemctl; then
  render deploy/perch-hostd.service.tmpl /etc/systemd/system/perch-hostd.service
  render deploy/perch.service.tmpl /etc/systemd/system/perch.service
  systemctl daemon-reload
  systemctl enable --now perch-hostd.service >/dev/null 2>&1 && ok "perch-hostd is running" \
    || warn "perch-hostd did not start; see: journalctl -u perch-hostd"
  ask_yn BOOT "Start perch when this machine boots?" y
  if [ "$BOOT" = y ]; then systemctl enable perch.service >/dev/null 2>&1 && ok "it will start at boot"
  else systemctl disable perch.service >/dev/null 2>&1 || true; note "it will not start at boot"; fi
else
  warn "no systemd; skipping the host helper and the boot unit"
fi

# ---------- 9. build and start ----------
step "Containers"
export COMPOSE_FILE
compose() { $COMPOSE_CMD --env-file "$ENV_FILE" "$@"; }
if [ "$SKIP_BUILD" = 0 ]; then
  note "building the perch image (a minute or two the first time)"
  compose build perch >/dev/null || die "the build failed. Run: $COMPOSE_CMD build perch"
  ok "image built"
fi
compose up -d || die "could not start the containers. Run: $COMPOSE_CMD up -d"
ok "containers started"

# Re-running the installer is meant to be safe and to leave nothing stale, and
# `up -d` alone does not manage that: it recreates a container when the
# service's *configuration* changed, and a rebuilt image under the same tag is
# not a configuration change. Without this, a re-run on an install whose only
# change is new code rebuilds the image and then leaves the old container
# running — while saying it started the containers.
if [ "$SKIP_BUILD" = 0 ]; then
  "$INSTALL_DIR/bin/perch" refresh || warn "some containers are still on their previous image; see above"
fi

printf '  waiting for perch to answer'
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PERCH_PROXY_PORT/healthz" >/dev/null 2>&1; then READY=1; break; fi
  printf '.'; sleep 1
done
printf '\n'
[ "${READY:-0}" = 1 ] && ok "perch is up" || warn "perch is not answering yet; check ./bin/perch logs perch"

# ---------- 10. the model ----------
if [ -n "$AI_MODEL" ]; then
  step "Downloading $AI_MODEL"
  note "this is a few gigabytes and takes as long as your line takes"
  compose exec -T ollama ollama pull "$AI_MODEL" || warn "the download did not finish; you can retry from the console"
fi
if [ -n "$AI_EMBED_MODEL" ]; then
  step "Downloading $AI_EMBED_MODEL"
  compose exec -T ollama ollama pull "$AI_EMBED_MODEL" || warn "the download did not finish; you can retry from the console"
fi

# ---------- 11. a token ----------
step "A token for Tern"
TOKEN_JSON=$(curl -fsS --max-time 10 -X POST "http://127.0.0.1:$PERCH_CONSOLE_PORT/api/tokens" \
  -H 'Content-Type: application/json' -d '{"name":"Tern","scopes":["use","manage"]}' 2>/dev/null || true)
TOKEN=$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

cat <<EOF

$B  perch is installed.$N

  Console        ${C}http://127.0.0.1:$PERCH_CONSOLE_PORT${N}
  Model endpoint 127.0.0.1:$PERCH_PROXY_PORT  ${D}(loopback only, for the tunnel)${N}
EOF
[ "$VOICE_ENABLED" = y ] && printf '  Dictation      127.0.0.1:%s\n' "$PERCH_VOICE_PORT"
[ "$VIDEO_ENABLED" = y ] && printf '  Images, video  127.0.0.1:%s\n' "$PERCH_VIDEO_PORT"
[ "$AUDIO_ENABLED" = y ] && printf '  Audio          127.0.0.1:%s\n' "$PERCH_AUDIO_PORT"
if [ "$VIDEO_ENABLED" = y ]; then
  printf '\n  %sImage and video models are files rather than tags: the console'"'"'s Models%s\n' "$D" "$N"
  printf '  %spage lists them, and ./bin/perch fetch <model> downloads one.%s\n' "$D" "$N"
fi
if [ -n "$TOKEN" ]; then
  cat <<EOF

  A token for Tern — copy it now, it is not shown again:

    ${C}$TOKEN${N}
EOF
else
  note "make a token in the console under Settings."
fi
cat <<EOF

  ${B}Next:${N} open the console and go to ${B}Connect${N}. It walks through
  generating a key, authorising it on the box Tern runs on, starting the
  tunnel, and gives you the two settings Tern needs.

  ${D}./bin/perch help   for everything you can do from a terminal${D}${N}

EOF
