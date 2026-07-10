#!/usr/bin/env bash
# PrepAI — produce the GGUF artifacts + Ollama models for the cross-platform
# (Ollama) inference path. Run this ONCE on a build machine; the outputs are what
# the desktop bundle / `ollama create` consume. Not part of end-user first-run.
#
# Pipeline:
#   1. Fetch the base model  Qwen/Qwen2.5-7B-Instruct (fp16, from HF).
#   2. base HF  -> GGUF (f16) -> quantize q4_K_M         (~4.5 GB).
#   3. LoRA adapter -> GGUF                                (small).
#   4. `ollama create` the two tags from ollama/Modelfile.*:
#        - qwen2.5-7b-instruct  (base, for grading)       = VLLM_BASE_MODEL
#        - interviewer          (base + LoRA adapter)      = VLLM_MODEL
#
# The ADAPTER approach keeps one resident base + a small adapter (see the
# Modelfiles). If adapter-on-quantized quality is poor, set MERGE=1 to instead
# merge the LoRA into fp16 and quantize a standalone `interviewer` GGUF.
#
# Requirements (build machine only): git, python3, and llama.cpp checked out with
# its Python deps installed; ollama installed if CREATE_OLLAMA=1 (default).
#
# Usage:
#   scripts/build_gguf.sh                     # full pipeline, adapter mode
#   MERGE=1 scripts/build_gguf.sh             # merge LoRA into base instead
#   CREATE_OLLAMA=0 scripts/build_gguf.sh     # produce GGUFs only, skip ollama
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
REPO_ROOT="$(pwd)"

# ── Config (override from the environment) ───────────────────────────────────
BASE_REPO="${BASE_REPO:-Qwen/Qwen2.5-7B-Instruct}"
ADAPTER_DIR="${ADAPTER_DIR:-training/artifacts/qwen2.5-7b-chatml-qlora-v2}"
QUANT="${QUANT:-Q4_K_M}"
OUT_DIR="${OUT_DIR:-ollama/models}"
# Path to a llama.cpp checkout (has convert_hf_to_gguf.py, convert_lora_to_gguf.py,
# and a built llama-quantize). Auto-cloned into .cache/ if unset and absent.
LLAMA_CPP="${LLAMA_CPP:-}"
MERGE="${MERGE:-0}"
CREATE_OLLAMA="${CREATE_OLLAMA:-1}"

BASE_TAG="${PREPAI_OLLAMA_BASE_TAG:-qwen2.5-7b-instruct}"
INTERVIEWER_TAG="${PREPAI_INTERVIEWER_TAG:-interviewer}"

die() { echo "build_gguf: ERROR: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v git >/dev/null 2>&1 || die "git is required"
[ -d "$ADAPTER_DIR" ] || die "adapter dir not found: $ADAPTER_DIR"

mkdir -p "$OUT_DIR"

# ── 0. Ensure llama.cpp is available ─────────────────────────────────────────
if [ -z "$LLAMA_CPP" ]; then
  LLAMA_CPP="$REPO_ROOT/.cache/llama.cpp"
  if [ ! -d "$LLAMA_CPP" ]; then
    step "Cloning llama.cpp into $LLAMA_CPP"
    git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_CPP"
  fi
fi
CONVERT_HF="$LLAMA_CPP/convert_hf_to_gguf.py"
CONVERT_LORA="$LLAMA_CPP/convert_lora_to_gguf.py"
[ -f "$CONVERT_HF" ] || die "convert_hf_to_gguf.py not found under $LLAMA_CPP"
[ -f "$CONVERT_LORA" ] || die "convert_lora_to_gguf.py not found under $LLAMA_CPP"

# llama-quantize binary (built) — look in common spots.
QUANT_BIN="$(command -v llama-quantize || true)"
for cand in "$LLAMA_CPP/build/bin/llama-quantize" "$LLAMA_CPP/llama-quantize"; do
  [ -z "$QUANT_BIN" ] && [ -x "$cand" ] && QUANT_BIN="$cand"
done
[ -n "$QUANT_BIN" ] || die "llama-quantize not found — build llama.cpp first (cmake -B build && cmake --build build -j)"

# ── 1. Fetch the base model ──────────────────────────────────────────────────
BASE_HF_DIR="$REPO_ROOT/.cache/hf/$(echo "$BASE_REPO" | tr '/' '_')"
if [ ! -d "$BASE_HF_DIR" ]; then
  step "Downloading base model $BASE_REPO"
  python3 - "$BASE_REPO" "$BASE_HF_DIR" <<'PY'
import sys
from huggingface_hub import snapshot_download
repo, dest = sys.argv[1], sys.argv[2]
snapshot_download(repo_id=repo, local_dir=dest,
                  allow_patterns=["*.json","*.txt","*.safetensors","*.model","tokenizer*"])
print("downloaded ->", dest)
PY
fi

# ── 2. base -> GGUF f16 -> quantize ──────────────────────────────────────────
BASE_F16="$OUT_DIR/qwen2.5-7b-instruct.f16.gguf"
BASE_Q="$OUT_DIR/qwen2.5-7b-instruct.${QUANT}.gguf"
if [ ! -f "$BASE_Q" ]; then
  step "Converting base to GGUF (f16)"
  python3 "$CONVERT_HF" "$BASE_HF_DIR" --outfile "$BASE_F16" --outtype f16
  step "Quantizing base -> $QUANT"
  "$QUANT_BIN" "$BASE_F16" "$BASE_Q" "$QUANT"
  rm -f "$BASE_F16"   # reclaim ~15 GB; keep only the quantized base
fi
echo "base GGUF: $BASE_Q"

# ── 3a. LoRA adapter -> GGUF (default: keep as a separate adapter) ───────────
LORA_GGUF="$OUT_DIR/interviewer-lora.gguf"
if [ "$MERGE" = "0" ]; then
  if [ ! -f "$LORA_GGUF" ]; then
    step "Converting LoRA adapter to GGUF"
    python3 "$CONVERT_LORA" "$ADAPTER_DIR" --base "$BASE_HF_DIR" --outfile "$LORA_GGUF"
  fi
  echo "LoRA GGUF: $LORA_GGUF"
else
  # ── 3b. Alternative: merge LoRA into fp16, quantize a standalone interviewer ─
  step "MERGE=1: merging LoRA into base (fp16) then quantizing"
  MERGED_DIR="$REPO_ROOT/.cache/merged-interviewer"
  python3 - "$BASE_REPO" "$ADAPTER_DIR" "$MERGED_DIR" <<'PY'
import sys, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
base, adapter, out = sys.argv[1], sys.argv[2], sys.argv[3]
m = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float16)
m = PeftModel.from_pretrained(m, adapter)
m = m.merge_and_unload()
m.save_pretrained(out); AutoTokenizer.from_pretrained(adapter).save_pretrained(out)
print("merged ->", out)
PY
  MERGED_F16="$OUT_DIR/interviewer.f16.gguf"
  INTERVIEWER_Q="$OUT_DIR/interviewer.${QUANT}.gguf"
  python3 "$CONVERT_HF" "$MERGED_DIR" --outfile "$MERGED_F16" --outtype f16
  "$QUANT_BIN" "$MERGED_F16" "$INTERVIEWER_Q" "$QUANT"
  rm -f "$MERGED_F16"
  echo "interviewer (merged) GGUF: $INTERVIEWER_Q"
fi

# ── 4. Register with Ollama ──────────────────────────────────────────────────
if [ "$CREATE_OLLAMA" = "1" ]; then
  command -v ollama >/dev/null 2>&1 || die "ollama not found (set CREATE_OLLAMA=0 to skip)"
  step "Creating Ollama model: $BASE_TAG"
  # Rewrite the placeholder FROM in the base Modelfile to the produced GGUF.
  sed "s|^FROM .*|FROM $REPO_ROOT/$BASE_Q|" ollama/Modelfile.base \
    | ollama create "$BASE_TAG" -f -

  step "Creating Ollama model: $INTERVIEWER_TAG"
  if [ "$MERGE" = "0" ]; then
    # base + adapter
    sed -e "s|^FROM .*|FROM $REPO_ROOT/$BASE_Q|" \
        -e "s|^ADAPTER .*|ADAPTER $REPO_ROOT/$LORA_GGUF|" ollama/Modelfile.interviewer \
      | ollama create "$INTERVIEWER_TAG" -f -
  else
    # standalone merged model: drop the ADAPTER line, point FROM at merged GGUF
    sed -e "s|^FROM .*|FROM $REPO_ROOT/$INTERVIEWER_Q|" \
        -e "/^ADAPTER /d" ollama/Modelfile.interviewer \
      | ollama create "$INTERVIEWER_TAG" -f -
  fi
  echo
  echo "Ollama models ready: $BASE_TAG, $INTERVIEWER_TAG"
  ollama list | grep -E "$BASE_TAG|$INTERVIEWER_TAG" || true
fi

step "Done"
echo "GGUF artifacts in: $OUT_DIR"
