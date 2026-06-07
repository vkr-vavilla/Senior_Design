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
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
    set_seed,
)


class BF16LossTrainer(Trainer):
    """
    Memory-efficient trainer for Qwen2.5-7B QLoRA on a single 24 GB GPU.

    The core problem: backward through the LM head matmul
    (hidden_states @ lm_head.weight → logits) requires materializing
    d_loss/d_logits, which at seq=8192 and vocab=152K is 4.64 GiB in fp32.
    No amount of CE chunking avoids this — the gradient exists regardless.

    The solution: use Liger's fused LM head + CE kernel, which computes the
    loss IN CHUNKS internally, never materializing the full (B, T, V) logits
    tensor or its gradient. Only hidden_states (B, T, hidden=3584) flows
    through the graph, whose gradient is ~235 MiB — fits easily.

    We run the transformer layers (with LoRA adapters active) to get
    hidden_states, then hand those + lm_head.weight directly to Liger.
    """

    def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
        from liger_kernel.transformers.fused_linear_cross_entropy import (
            LigerFusedLinearCrossEntropyLoss,
        )

        labels = inputs.pop("labels")
        unwrapped = self.accelerator.unwrap_model(model)

        # Run the transformer layers (LoRA-modified) WITHOUT the LM head.
        # For PEFT-wrapped Qwen2ForCausalLM:
        #   unwrapped          = PeftModelForCausalLM
        #   unwrapped.model    = Qwen2ForCausalLM
        #   unwrapped.model.model = Qwen2Model (transformer layers + embed + norm)
        #   unwrapped.model.lm_head = Linear(hidden, vocab, bias=False)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            transformer_outputs = unwrapped.model.model(
                input_ids=inputs.get("input_ids"),
                attention_mask=inputs.get("attention_mask"),
                return_dict=True,
            )

        hidden_states = transformer_outputs.last_hidden_state  # (B, T, D) bf16
        lm_head_weight = unwrapped.model.lm_head.weight       # (V, D)

        # Shift for next-token prediction (same as standard CLM)
        shift_hidden = hidden_states[..., :-1, :].contiguous()   # (B, T-1, D)
        shift_labels = labels[..., 1:].contiguous().reshape(-1)  # (B*(T-1),)
        shift_hidden_2d = shift_hidden.reshape(-1, shift_hidden.size(-1))  # (B*(T-1), D)

        # Fused: computes lm_head_weight @ hidden.T + CE in chunks internally.
        # Never allocates the full (B*T, V) logits tensor or its fp32 gradient.
        fused_loss_fn = LigerFusedLinearCrossEntropyLoss(ignore_index=-100)
        loss = fused_loss_fn(lm_head_weight, shift_hidden_2d, shift_labels)

        if return_outputs:
            # Trainer eval path expects (loss, outputs). Return a lightweight
            # placeholder — we don't need logits since prediction_loss_only=True.
            from transformers.modeling_outputs import CausalLMOutputWithPast
            dummy_outputs = CausalLMOutputWithPast(loss=loss)
            return loss, dummy_outputs

        return loss


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
    """
    Tokenize a chat record with ASSISTANT-ONLY label masking.

    For every turn, we compute its token range inside the fully-rendered chat,
    then:
      - system / user turns -> labels = -100 (no gradient)
      - assistant turns -> labels = input_ids for the response content + <|im_end|>,
                            but the "<|im_start|>assistant\\n" header is also masked
                            so the model isn't trained to emit the role tag itself.
    """
    messages = record["messages"]
    input_ids: List[int] = []
    labels: List[int] = []

    for i, msg in enumerate(messages):
        # Tokens for the conversation BEFORE this turn
        if i == 0:
            prefix_len = 0
        else:
            prefix_text = tokenizer.apply_chat_template(
                messages[:i], tokenize=False, add_generation_prompt=False
            )
            prefix_len = len(tokenizer(prefix_text, add_special_tokens=False)["input_ids"])

        # Tokens INCLUDING this turn
        full_text = tokenizer.apply_chat_template(
            messages[: i + 1], tokenize=False, add_generation_prompt=False
        )
        full_ids = tokenizer(full_text, add_special_tokens=False)["input_ids"]

        turn_ids = full_ids[prefix_len:]
        input_ids.extend(turn_ids)

        if msg["role"] == "assistant":
            # Where does the "<|im_start|>assistant\n" header end and content begin?
            # apply_chat_template with add_generation_prompt=True on messages[:i]
            # gives us exactly "...prior turns...<|im_start|>assistant\n".
            header_text = tokenizer.apply_chat_template(
                messages[:i], tokenize=False, add_generation_prompt=True
            )
            header_total_len = len(tokenizer(header_text, add_special_tokens=False)["input_ids"])
            header_only_len = header_total_len - prefix_len  # tokens added by the assistant header

            # Mask the header tokens, train on the content + <|im_end|>
            labels.extend([-100] * header_only_len)
            labels.extend(turn_ids[header_only_len:])
        else:
            # No gradient for system / user turns
            labels.extend([-100] * len(turn_ids))

    # Truncate (keeping input_ids and labels aligned)
    input_ids = input_ids[:max_length]
    labels = labels[:max_length]

    # Sanity guard: if truncation killed every assistant token, drop the example
    # by returning empty labels. Trainer's data loader will still accept it but
    # the loss won't propagate. Better to warn the user upstream though.
    if not any(l != -100 for l in labels):
        print(f"WARNING: example has no unmasked assistant tokens after truncation — increase --max-length")

    return {
        "input_ids": input_ids,
        "attention_mask": [1] * len(input_ids),
        "labels": labels,
    }


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

    # IMPORTANT: DataCollatorForLanguageModeling overwrites labels with input_ids,
    # which would undo our assistant-only masking. DataCollatorForSeq2Seq pads
    # input_ids/attention_mask with the pad token and labels with -100 separately.
    collator = DataCollatorForSeq2Seq(
        tokenizer=tokenizer,
        padding=True,
        label_pad_token_id=-100,
        return_tensors="pt",
    )

    # Use the chunked BF16LossTrainer instead of vanilla — Liger's fusion
    # is unreliable through PEFT wrapping, so we do our own bf16+chunked CE
    # to keep peak VRAM under 24 GB at seq_len=8192.
    trainer = BF16LossTrainer(
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
