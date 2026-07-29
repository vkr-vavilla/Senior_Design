#!/usr/bin/env bash
# FinalRound — inference-engine auto-detection.
#
# Inspects the host (OS, CPU arch, GPU vendor + VRAM, total RAM) and picks the
# best local inference engine, then prints a shell-eval-able block of the env
# vars the backend needs. The backend itself never branches on engine type — it
# only reads VLLM_BASE_URL / VLLM_MODEL / VLLM_BASE_MODEL / AI_BACKEND (see
# backend/routers/chat.py:28) — so "add an engine" lives entirely here.
#
# Engine matrix — local inference is GPU-only by policy. A 7B model decoded on
# CPU runs at single-digit tokens/s, which turns a spoken interview into dead
# air between turns, so there is deliberately NO CPU fallback: a machine that
# can't accelerate the model uses the cloud API instead of running it badly.
#
#   NVIDIA GPU + Linux, >=10 GB VRAM  -> vllm   (AWQ base + interviewer LoRA)
#   Apple Silicon                     -> ollama (native on the host, Metal)
#   anything else                     -> gemini (cloud, BYO key)
#
# Apple Silicon note: Ollama must run natively on macOS, NOT in Docker. Docker
# Desktop's Linux VM has no Metal passthrough, so a containerised Ollama on a
# Mac silently decodes on CPU inside the VM — the exact failure this matrix
# exists to prevent. Hence the host URL below rather than a compose service.
#
# Usage:
#   eval "$(scripts/detect_engine.sh)"     # export the chosen env into the shell
#   scripts/detect_engine.sh --explain     # human-readable reasoning on stderr
#   scripts/detect_engine.sh --engine E    # force vllm|ollama|gemini, skip probing
#
# Notes vars are printed to stdout as `KEY=value` lines (eval-friendly);
# diagnostics go to stderr so `eval "$(...)"` stays clean.
set -euo pipefail

# ── Tunables (override from the environment) ─────────────────────────────────
# Min VRAM (GiB) required to run the model locally at all. Below this we go to
# the cloud rather than thrash between VRAM and system RAM.
MIN_VLLM_VRAM_GB="${PREPAI_MIN_VLLM_VRAM_GB:-10}"
# Min unified memory (GiB) on Apple Silicon before the 7B GGUF stops fitting
# comfortably alongside the OS and we fall back to the cloud.
MIN_APPLE_RAM_GB="${PREPAI_MIN_APPLE_RAM_GB:-16}"
# Where each engine listens. Overridable so the same detection works whether the
# engine runs as a native sidecar (localhost) or a compose service (service name).
# Ollama is always native-on-host, so the backend (in a container) reaches it
# through host.docker.internal rather than a compose service name.
OLLAMA_URL="${PREPAI_OLLAMA_HOST_URL:-http://host.docker.internal:11434/v1}"
VLLM_URL="${PREPAI_VLLM_URL:-http://localhost:8001/v1}"
# Model names/tags. These MUST match what the engines actually serve:
#   - vLLM: --lora-modules interviewer=... (docker-compose.local.yml) and the
#     AWQ base id used for grading.
#   - Ollama: the two tags produced by scripts/build_gguf.sh from the Modelfiles.
INTERVIEWER_TAG="${PREPAI_INTERVIEWER_TAG:-interviewer}"
VLLM_BASE_ID="${PREPAI_VLLM_BASE_ID:-Qwen/Qwen2.5-7B-Instruct-AWQ}"
OLLAMA_BASE_TAG="${PREPAI_OLLAMA_BASE_TAG:-qwen2.5-7b-instruct}"

FORCED_ENGINE=""
EXPLAIN=0
for arg in "$@"; do
  case "$arg" in
    --explain) EXPLAIN=1 ;;
    --engine) shift; FORCED_ENGINE="${1:-}" ;;
    --engine=*) FORCED_ENGINE="${arg#*=}" ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ;;
  esac
done

log() { [ "$EXPLAIN" -eq 1 ] && echo "detect_engine: $*" >&2 || true; }

# ── Probes ───────────────────────────────────────────────────────────────────
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

is_apple_silicon() {
  [ "$OS" = "Darwin" ] && { [ "$ARCH" = "arm64" ] || \
    [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; }
}

# Largest single-GPU VRAM in GiB, or empty if no NVIDIA GPU / no nvidia-smi.
nvidia_vram_gb() {
  command -v nvidia-smi >/dev/null 2>&1 || return 0
  nvidia-smi >/dev/null 2>&1 || return 0
  local mib
  mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
          | tr -d ' ' | sort -n | tail -1)"
  [ -n "$mib" ] && echo $(( mib / 1024 )) || true
}

# Total system RAM in GiB (Linux + macOS).
total_ram_gb() {
  if [ "$OS" = "Darwin" ]; then
    local b; b="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    echo $(( b / 1024 / 1024 / 1024 ))
  elif [ -r /proc/meminfo ]; then
    awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo
  else
    echo 0
  fi
}

# ── Decide ───────────────────────────────────────────────────────────────────
ENGINE="$FORCED_ENGINE"
if [ -n "$ENGINE" ]; then
  log "engine forced to '$ENGINE' — skipping probes"
else
  VRAM_GB="$(nvidia_vram_gb || true)"
  RAM_GB="$(total_ram_gb || echo 0)"
  log "OS=$OS ARCH=$ARCH nvidia_vram_gb=${VRAM_GB:-none} ram_gb=$RAM_GB"

  # A host GPU is necessary but NOT sufficient: vLLM runs in a container, so
  # Docker also needs the NVIDIA Container Toolkit. Without it `--profile gpu`
  # dies with 'could not select device driver "nvidia"'. The caller (the desktop
  # supervisor) probes Docker and passes the answer in, because it knows how to
  # reach Docker; when unset we assume yes and preserve the old behaviour.
  DOCKER_GPU="${PREPAI_DOCKER_GPU:-1}"

  if [ "$OS" = "Linux" ] && [ -n "${VRAM_GB:-}" ] && [ "${VRAM_GB:-0}" -ge "$MIN_VLLM_VRAM_GB" ] \
     && [ "$DOCKER_GPU" != "0" ]; then
    ENGINE="vllm"
    log "NVIDIA GPU with ${VRAM_GB} GiB VRAM on Linux -> vllm"
  elif [ "$OS" = "Linux" ] && [ -n "${VRAM_GB:-}" ] && [ "${VRAM_GB:-0}" -ge "$MIN_VLLM_VRAM_GB" ]; then
    # GPU present, but Docker can't use it. Falling back beats a hard failure.
    ENGINE="gemini"
    log "NVIDIA GPU found but Docker lacks the NVIDIA Container Toolkit -> gemini"
  elif is_apple_silicon && [ "${RAM_GB:-0}" -ge "$MIN_APPLE_RAM_GB" ]; then
    ENGINE="ollama"
    log "Apple Silicon with ${RAM_GB} GiB unified memory -> ollama on the host (Metal)"
  else
    # Everything else — CPU-only, AMD, low-VRAM NVIDIA, Intel Macs, Windows
    # without WSL2+CUDA — would decode on CPU. Too slow for a live conversation,
    # so use the cloud instead of shipping a bad local experience.
    ENGINE="gemini"
    log "no supported local accelerator (need NVIDIA >=${MIN_VLLM_VRAM_GB} GiB VRAM on Linux, or Apple Silicon with >=${MIN_APPLE_RAM_GB} GiB) -> gemini"
  fi
fi

# ── Emit env for the chosen engine ───────────────────────────────────────────
case "$ENGINE" in
  vllm)
    echo "INFERENCE_ENGINE=vllm"
    echo "AI_BACKEND=qwen"
    echo "VLLM_BASE_URL=$VLLM_URL"
    echo "VLLM_MODEL=$INTERVIEWER_TAG"
    echo "VLLM_BASE_MODEL=$VLLM_BASE_ID"
    echo "COMPOSE_PROFILES=gpu"
    ;;
  ollama)
    echo "INFERENCE_ENGINE=ollama"
    echo "AI_BACKEND=qwen"          # backend's local (OpenAI-compatible) path
    echo "VLLM_BASE_URL=$OLLAMA_URL"
    echo "VLLM_MODEL=$INTERVIEWER_TAG"
    echo "VLLM_BASE_MODEL=$OLLAMA_BASE_TAG"
    # No profile: Ollama runs natively on macOS for Metal access, so compose
    # starts only the supporting services (see the note at the top of this file).
    echo "COMPOSE_PROFILES="
    ;;
  gemini)
    echo "INFERENCE_ENGINE=gemini"
    echo "AI_BACKEND=gemini"
    ;;
  *)
    echo "detect_engine: unknown engine '$ENGINE' (want vllm|ollama|gemini)" >&2
    exit 1
    ;;
esac
