# FinalRound Local Package — run everything on your own machine

The local package is a fully self-contained deployment of FinalRound: the AI
interviewer model, speech-to-text, text-to-speech, database, and coding sandbox
all run on your computer. Nothing is metered and no cloud account is required
(except optionally Gemini, for machines without a GPU).

## What runs where

| Component | Local package | Notes |
|---|---|---|
| LLM (interviewer) | Qwen2.5-7B + fine-tuned LoRA via vLLM | needs an NVIDIA GPU (~10 GB VRAM); no GPU → Gemini API with your own free key |
| Speech-to-text | faster-whisper (`STT_BACKEND=local`) | CPU, offline, no API key |
| Text-to-speech | Kokoro-82M ONNX (`TTS_BACKEND=kokoro`) | CPU, offline, no API key; ~353 MB of weights download on first boot into `backend/kokoro_models/` |
| Database | MongoDB 7 container | data persists in the `mongo-data` Docker volume |
| Coding sandbox | Piston | Python runtime auto-installed on first boot |
| Crash-safety cache | Redis | per-turn interview snapshots |

## Requirements

- **Docker** with Docker Compose v2
- **GPU mode**: an NVIDIA GPU with ~10–12 GB VRAM + the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- **API mode** (no GPU): a free Gemini API key from https://aistudio.google.com
- Disk: ~20 GB in GPU mode (model weights + images), ~6 GB in API mode

## Quick start

On a machine that doesn't have the code yet, clone it first:

```bash
git clone https://github.com/vkr-vavilla/Senior_Design.git
cd Senior_Design
./setup_local.sh
```

That's it. The script detects whether you have an NVIDIA GPU, generates
`backend/.env` with a fresh JWT secret, starts the stack from
`docker-compose.local.yml`, waits for it to come up, and seeds the
coding-problem bank. Then open **http://localhost:3000**.

Force a mode explicitly:

```bash
./setup_local.sh --gpu     # local Qwen model via vLLM (NVIDIA GPU required)
./setup_local.sh --ollama  # local Qwen model via Ollama (Mac/AMD/CPU; needs ./ollama/models GGUFs — see below)
./setup_local.sh --api     # Gemini API mode (add your key to backend/.env)
```

The script is idempotent — re-run it after a reboot or a `git pull` and it
will reuse the existing `.env`, volumes, and problem bank.

### Ollama mode: getting the GGUF models

`--ollama` needs two GGUF files in `./ollama/models/` that are **not** in git
(model weights don't belong in a git repo): the quantized Qwen2.5-7B-Instruct
base and the small `interviewer-lora.gguf` adapter. Build them once with:

```bash
scripts/build_gguf.sh   # needs a llama.cpp checkout; see the script header
```

This converts+quantizes the base (~15 GB peak, reclaimed after quantizing) and
converts the LoRA adapter already in `training/artifacts/`. It's a one-time,
several-GB, several-minute step per machine.

## Desktop app (native window)

The stack above serves the app at http://localhost:3000 in any browser. The
`desktop/` Tauri shell wraps that in a native window and brings the compose
stack up for you. It needs **Rust** and **Node** on top of the requirements
above (plus WebKitGTK on Linux):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

cd desktop
npm install
npm run dev      # native window
npm run build    # installers instead: .deb + .AppImage
```

The icon set is committed under `desktop/src-tauri/icons/`, so there is no
icon-generation step. The first `npm run dev` compiles the Rust shell once
(a few minutes, ~3 GB in `src-tauri/target/`); every run after that is quick.

The Linux webview (WebKitGTK) ships no Web Speech API, so voice **input** is
unavailable in the native window — it degrades quietly, and spoken answers
still work in a browser. Voice output (Kokoro TTS) works in both.

## Updating to the latest code

`git pull` is the whole update path — there is no bundle to re-download.
`docker-compose.local.yml` bind-mounts the source (`./backend:/app`,
`./frontend:/app`) and both services run dev servers with hot reload, so pulled
changes hit the running stack immediately.

```bash
git pull
```

Only these cases need more than a pull:

| What changed | What to run |
|---|---|
| `.py` / `.ts` / `.tsx` code | nothing — backend (`WatchFiles`) and frontend (`next dev`) reload themselves |
| `requirements.txt` or `package.json` (new dependency) | `docker compose -f docker-compose.local.yml --profile gpu up -d --build` |
| `docker-compose.local.yml` | `docker compose -f docker-compose.local.yml --profile gpu up -d` |
| `desktop/src-tauri/**.rs` | restart `npm run dev` (recompiles the shell) |

Drop `--profile gpu` in API mode. `./setup_local.sh` is idempotent, so
re-running it after a pull is always safe.

## Day-to-day commands

```bash
# start / stop (GPU mode)
docker compose -f docker-compose.local.yml --profile gpu up -d
docker compose -f docker-compose.local.yml --profile gpu down

# start / stop (API mode)
AI_BACKEND=gemini docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml down

# logs
docker compose -f docker-compose.local.yml logs -f backend
docker compose -f docker-compose.local.yml logs -f vllm
```

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `AI_BACKEND` | `qwen` | `qwen` (local model) or `gemini` (cloud API) |
| `WHISPER_MODEL` | `small` | local STT size: `tiny` / `base` / `small` / `medium` — bigger is more accurate but slower on CPU |
| `STT_BACKEND` | `local` (in this compose) | set `groq` + `GROQ_API_KEY` in `backend/.env` to use cloud STT instead |
| `TTS_BACKEND` | `kokoro` (in this compose) | on-device voice, no key. Set `google` + `GOOGLE_APPLICATION_CREDENTIALS` for Cloud TTS instead. If neither can serve audio the app falls back to your browser's built-in voice |

Example: `WHISPER_MODEL=base ./setup_local.sh` on a weaker CPU.

## Where your data lives

Everything stays on your machine in named Docker volumes: `mongo-data`
(accounts, interviews, transcripts, feedback), `hf-cache` (model weights),
`piston-packages`, and `redis-data`. Interviews and résumés never leave your
computer in GPU mode; in API mode only the interview text goes to Gemini.

## Uninstall

```bash
docker compose -f docker-compose.local.yml --profile gpu down -v   # -v deletes all data
```

## Troubleshooting

- **`backend/.env` missing / JWT error** — run `./setup_local.sh` once; it generates the file.
- **vLLM won't start** — confirm `nvidia-smi` works inside Docker
  (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`);
  otherwise use `./setup_local.sh --api`.
- **First spoken answer is slow** — the Whisper model downloads on first backend
  boot; watch `docker compose -f docker-compose.local.yml logs -f backend` for
  `[Whisper] Pre-warmed.`
- **Coding round never appears** — only **technical** and **mixed** interviews get
  one; a behavioral interview never does. The difficulty rule is: `easy` → 1 easy
  problem, `medium` → 1 medium, `hard` → 1 easy + 1 medium (never a LeetCode "hard").
- **Coding round empty** — re-run `./setup_local.sh` (it seeds only when the
  problem bank is empty), or seed manually:
  `docker compose -f docker-compose.local.yml exec backend python -m scripts.scrape_leetcode --per-difficulty 25 --sleep 1.0`
