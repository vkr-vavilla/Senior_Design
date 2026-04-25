# Qwen QLoRA Training Pipeline (ChatML)

This pipeline is tuned for your selected setup:
- Base model: `Qwen/Qwen2.5-7B-Instruct`
- Method: `QLoRA 4-bit`
- Context length: `4096`
- Split: `90/10`
- Single GPU `<=24GB`
- Output artifact: `LoRA adapter`
- Tracking: `W&B + TensorBoard`

## 1) Install training dependencies

```bash
cd training
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-qlora.txt
```

## 2) Split dataset deterministically

```bash
cd /home/aiinterviewer/Desktop/Senior_Design
source training/.venv/bin/activate
python training/split_chatml_dataset.py \
  --input data/processed/chatml_training_data.jsonl \
  --train-out data/processed/chatml_train.jsonl \
  --val-out data/processed/chatml_val.jsonl \
  --val-ratio 0.1 \
  --seed 42
```

## 3) Start training

```bash
cd /home/aiinterviewer/Desktop/Senior_Design
source training/.venv/bin/activate
export WANDB_PROJECT=finalround-qwen-chatml
# export WANDB_API_KEY=...   # set if needed

python training/train_qlora_chatml.py \
  --train-file data/processed/chatml_train.jsonl \
  --val-file data/processed/chatml_val.jsonl \
  --base-model Qwen/Qwen2.5-7B-Instruct \
  --output-dir training/artifacts/qwen2.5-7b-chatml-qlora \
  --max-length 8192 \
  --epochs 8 \
  --train-batch-size 1 \
  --eval-batch-size 1 \
  --grad-accum 16 \
  --lr 2e-4 \
  --run-name qwen2.5-7b-chatml-qlora-long
```

## 4) Serve the adapter

If your serving path supports PEFT adapters, load the adapter on top of the base model.

If not, merge adapter weights first (optional step you can add later).

## Notes

- Current dataset size is small (around a few dozen conversations), so overfitting is likely.
- Best improvement will come from adding more labeled conversations and cleaning repetitive boilerplate turns.
- Your current inference stack is not locked to full FP16. vLLM auto-selects dtype unless `--dtype` is specified.
- 4-bit is recommended for training on <=24GB VRAM (QLoRA), and can also be used for inference via quantized checkpoints.
