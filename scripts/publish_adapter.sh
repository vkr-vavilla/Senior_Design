#!/usr/bin/env bash
# FinalRound — publish the fine-tuned interviewer adapter to the Hugging Face Hub.
#
# Run this ONCE per adapter version, on a build machine. It uploads BOTH formats
# from a single repo so either engine can pull the same adapter:
#
#   adapter_config.json + adapter_model.safetensors  -> vLLM  (NVIDIA/Linux)
#   interviewer-lora.gguf                            -> Ollama (Apple Silicon)
#
# We deliberately do NOT publish a base model. vLLM pulls the AWQ base from
# Qwen's own HF repo and Ollama pulls the stock qwen2.5 tag — hosting a 4.5 GB
# copy of a public model would buy nothing. Only the ~1.9 GB of weights we
# actually trained lives here.
#
# Requires: docker (the HF client runs in a container — this box has no pip),
# and a Hugging Face token with write access.
#
# Usage:
#   HF_TOKEN=hf_xxx scripts/publish_adapter.sh <namespace>/finalround-interviewer
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

REPO_ID="${1:-}"
[ -n "$REPO_ID" ] || { echo "usage: HF_TOKEN=hf_xxx $0 <namespace>/finalround-interviewer" >&2; exit 1; }
[ -n "${HF_TOKEN:-}" ] || { echo "ERROR: set HF_TOKEN (https://huggingface.co/settings/tokens, 'write' scope)" >&2; exit 1; }

ADAPTER="${ADAPTER_DIR:-training/artifacts/qwen2.5-7b-chatml-qlora-v2}"
LORA_GGUF="${LORA_GGUF:-ollama/models/interviewer-lora.gguf}"
IMG=ghcr.io/ggml-org/llama.cpp:full   # already has huggingface_hub

[ -f "$ADAPTER/adapter_model.safetensors" ] || { echo "ERROR: no PEFT adapter at $ADAPTER" >&2; exit 1; }
[ -f "$LORA_GGUF" ] || { echo "ERROR: no GGUF at $LORA_GGUF — run scripts/build_gguf.sh first" >&2; exit 1; }

echo "Publishing to https://huggingface.co/$REPO_ID"
echo "  PEFT adapter : $ADAPTER"
echo "  GGUF adapter : $LORA_GGUF"

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e HF_TOKEN="$HF_TOKEN" -e REPO_ID="$REPO_ID" \
  -v "$REPO_ROOT/$ADAPTER:/adapter:ro" \
  -v "$REPO_ROOT/$(dirname "$LORA_GGUF"):/gguf:ro" \
  --entrypoint python3 "$IMG" -c '
import os
from huggingface_hub import HfApi

api = HfApi(token=os.environ["HF_TOKEN"])
repo = os.environ["REPO_ID"]
api.create_repo(repo, repo_type="model", exist_ok=True)

# Only the adapter itself — skip checkpoints/, runs/ and other training debris,
# which are large and useless to consumers.
api.upload_folder(
    repo_id=repo, folder_path="/adapter",
    allow_patterns=["adapter_config.json", "adapter_model.safetensors",
                    "*.json", "*.txt", "*.jinja", "README.md"],
    ignore_patterns=["checkpoint-*/*", "runs/*"],
    commit_message="Publish interviewer QLoRA adapter (PEFT, for vLLM)",
)
api.upload_file(
    repo_id=repo, path_or_fileobj="/gguf/interviewer-lora.gguf",
    path_in_repo="interviewer-lora.gguf",
    commit_message="Publish interviewer LoRA in GGUF (for Ollama/Metal)",
)
print("published ->", f"https://huggingface.co/{repo}")
'

echo
echo "Done. Wire it up with:"
echo "  vLLM   : --lora-modules interviewer=$REPO_ID"
echo "  Ollama : ADAPTER pointing at the downloaded interviewer-lora.gguf"
