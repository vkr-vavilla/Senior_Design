import argparse
import os
from pathlib import Path
from typing import Any, Dict, List

import torch
import torch.nn.functional as F
from datasets import load_dataset
from liger_kernel.transformers import apply_liger_kernel_to_qwen2
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
    set_seed,
)


class BF16LossTrainer(Trainer):
    """Bypasses accelerate's convert_to_fp32 output wrapper to keep logits in
    bfloat16.  Without this, Qwen2.5's 152K vocab x 8192 seq len = 4.64 GiB
    fp32 allocation kills a 24 GB GPU before our code even sees the outputs."""

    def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
        labels = inputs.pop("labels")
        # Unwrap accelerate's forward wrapper so logits stay in bfloat16.
        unwrapped = self.accelerator.unwrap_model(model)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            outputs = unwrapped(**inputs)
        logits = outputs.logits  # (B, T, V) bfloat16 -- 2.32 GiB, not 4.64 GiB
        shift_logits = logits[..., :-1, :].contiguous()
        shift_labels = labels[..., 1:].contiguous().to(logits.device)
        loss = F.cross_entropy(
            shift_logits.view(-1, shift_logits.size(-1)),
            shift_labels.view(-1),
            ignore_index=-100,
        )
        return (loss, outputs) if return_outputs else loss


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Qwen with QLoRA using ChatML JSONL data.")
    parser.add_argument("--train-file", required=True)
    parser.add_argument("--val-file", required=True)
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-7B-Instruct")
    parser.add_argument("--output-dir", default="training/artifacts/qwen2.5-7b-chatml-qlora")
    parser.add_argument("--max-length", type=int, default=4096)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--warmup-ratio", type=float, default=0.05)
    parser.add_argument("--train-batch-size", type=int, default=1)
    parser.add_argument("--eval-batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=16)
    parser.add_argument("--save-total-limit", type=int, default=3)
    parser.add_argument("--eval-steps", type=int, default=0, help="0 means evaluate each epoch")
    parser.add_argument("--logging-steps", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--lora-r", type=int, default=64)
    parser.add_argument("--lora-alpha", type=int, default=128)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--run-name", default="qwen-chatml-qlora")
    parser.add_argument("--gradient-checkpointing", action="store_true", default=True)
    parser.add_argument("--disable-gradient-checkpointing", dest="gradient_checkpointing", action="store_false")
    parser.add_argument("--use-wandb", action="store_true", default=True)
    parser.add_argument("--no-wandb", dest="use_wandb", action="store_false")
    parser.add_argument("--tensorboard", action="store_true", default=True)
    parser.add_argument("--no-tensorboard", dest="tensorboard", action="store_false")
    return parser.parse_args()


def detect_compute_dtype() -> torch.dtype:
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16


def build_report_targets(args: argparse.Namespace) -> List[str]:
    targets: List[str] = []
    if args.tensorboard:
        targets.append("tensorboard")
    if args.use_wandb:
        targets.append("wandb")
    return targets


def to_chat_text(messages: List[Dict[str, Any]], tokenizer: AutoTokenizer) -> str:
    return tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=False,
    )


def tokenize_record(record: Dict[str, Any], tokenizer: AutoTokenizer, max_length: int) -> Dict[str, Any]:
    text = to_chat_text(record["messages"], tokenizer)
    toks = tokenizer(
        text,
        truncation=True,
        max_length=max_length,
        padding=False,
    )
    toks["labels"] = toks["input_ids"].copy()
    return toks


def main() -> None:
    args = parse_args()
    set_seed(args.seed)

    compute_dtype = detect_compute_dtype()
    print(f"Using compute dtype: {compute_dtype}")

    if not Path(args.train_file).exists() or not Path(args.val_file).exists():
        raise FileNotFoundError("Train/val files not found. Run split_chatml_dataset.py first.")

    # Patch Qwen2 to use chunked fused cross-entropy — eliminates the
    # 8192 x 152K logit fp32 upcast that OOMs on 24 GB with large vocab.
    apply_liger_kernel_to_qwen2(fused_linear_cross_entropy=True)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, use_fast=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=compute_dtype,
    )

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
    )
    model.config.use_cache = False

    model = prepare_model_for_kbit_training(model)

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        task_type="CAUSAL_LM",
        bias="none",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    dataset = load_dataset(
        "json",
        data_files={"train": args.train_file, "validation": args.val_file},
    )

    train_size = len(dataset["train"])
    val_size = len(dataset["validation"])
    print(f"Train examples: {train_size}, Val examples: {val_size}")

    if train_size < 100:
        print("Warning: dataset is very small for 7B SFT. Expect overfitting; consider adding more data.")

    tokenized = dataset.map(
        lambda row: tokenize_record(row, tokenizer, args.max_length),
        remove_columns=dataset["train"].column_names,
        desc="Tokenizing ChatML dataset",
    )

    report_to = build_report_targets(args)

    eval_strategy = "epoch" if args.eval_steps == 0 else "steps"
    save_strategy = "epoch" if args.eval_steps == 0 else "steps"

    # Transformers renamed/standardized this field across versions.
    eval_key = "eval_strategy" if "eval_strategy" in TrainingArguments.__dataclass_fields__ else "evaluation_strategy"

    training_kwargs = dict(
        output_dir=args.output_dir,
        run_name=args.run_name,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        weight_decay=args.weight_decay,
        warmup_ratio=args.warmup_ratio,
        per_device_train_batch_size=args.train_batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        gradient_accumulation_steps=args.grad_accum,
        logging_steps=args.logging_steps,
        save_strategy=save_strategy,
        eval_steps=args.eval_steps if args.eval_steps > 0 else None,
        save_steps=args.eval_steps if args.eval_steps > 0 else None,
        save_total_limit=args.save_total_limit,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        bf16=compute_dtype == torch.bfloat16,
        fp16=compute_dtype == torch.float16,
        gradient_checkpointing=args.gradient_checkpointing,
        report_to=report_to,
        dataloader_num_workers=2,
        optim="paged_adamw_8bit",
        lr_scheduler_type="cosine",
        seed=args.seed,
    )
    training_kwargs[eval_key] = eval_strategy

    training_args = TrainingArguments(**training_kwargs)

    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized["train"],
        eval_dataset=tokenized["validation"],
        data_collator=collator,
        processing_class=tokenizer,
    )

    trainer.train()

    # Save adapter-only checkpoint (as requested)
    trainer.model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    metrics = trainer.evaluate()
    print("Final eval metrics:", metrics)


if __name__ == "__main__":
    main()
