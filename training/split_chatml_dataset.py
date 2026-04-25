import argparse
import json
import random
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministically split ChatML JSONL into train/val files.")
    parser.add_argument("--input", required=True, help="Path to source JSONL (each line has {'messages': [...]})")
    parser.add_argument("--train-out", required=True, help="Output path for training JSONL")
    parser.add_argument("--val-out", required=True, help="Output path for validation JSONL")
    parser.add_argument("--val-ratio", type=float, default=0.1, help="Validation ratio (default: 0.1)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for deterministic split")
    args = parser.parse_args()

    input_path = Path(args.input)
    train_out = Path(args.train_out)
    val_out = Path(args.val_out)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    records = []
    with input_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if "messages" not in obj:
                continue
            records.append(obj)

    if len(records) < 2:
        raise ValueError("Need at least 2 records to split train/val")

    rng = random.Random(args.seed)
    rng.shuffle(records)

    val_count = max(1, int(len(records) * args.val_ratio))
    val_records = records[:val_count]
    train_records = records[val_count:]

    train_out.parent.mkdir(parents=True, exist_ok=True)
    val_out.parent.mkdir(parents=True, exist_ok=True)

    with train_out.open("w", encoding="utf-8") as f:
        for r in train_records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    with val_out.open("w", encoding="utf-8") as f:
        for r in val_records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"Total: {len(records)}")
    print(f"Train: {len(train_records)} -> {train_out}")
    print(f"Val:   {len(val_records)} -> {val_out}")


if __name__ == "__main__":
    main()
