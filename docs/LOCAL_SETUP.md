# PrepAI Local Package — run everything on your own machine

The local package is a fully self-contained deployment of PrepAI: the AI
interviewer model, speech-to-text, text-to-speech, database, and coding sandbox
all run on your computer. Nothing is metered and no cloud account is required
(except optionally Gemini, for machines without a GPU).

## What runs where

| Component | Local package | Notes |
|---|---|---|
| LLM (interviewer) | Qwen2.5-7B + fine-tuned LoRA via vLLM | needs an NVIDIA GPU (~10 GB VRAM); no GPU → Gemini API with your own free key |
| Speech-to-text | faster-whisper (`STT_BACKEND=local`) | CPU, offline, no API key |
| Text-to-speech | Kokoro ONNX | CPU, offline, bundled in the backend image |
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

```bash
./setup_local.sh
```

That's it. The script detects whether you have an NVIDIA GPU, generates
`backend/.env` with a fresh JWT secret, starts the stack from
`docker-compose.local.yml`, waits for it to come up, and seeds the
coding-problem bank. Then open **http://localhost:3000**.

Force a mode explicitly:

```bash
./setup_local.sh --gpu    # local Qwen model (NVIDIA GPU required)
./setup_local.sh --api    # Gemini API mode (add your key to backend/.env)
```

The script is idempotent — re-run it after a reboot or a `git pull` and it
will reuse the existing `.env`, volumes, and problem bank.

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
- **Coding round empty** — re-run `./setup_local.sh` (it seeds only when the
  problem bank is empty), or seed manually:
  `docker compose -f docker-compose.local.yml exec backend python -m scripts.scrape_leetcode --per-difficulty 25 --sleep 1.0`
