from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any
from groq import Groq, RateLimitError, APIStatusError
from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / "backend" / ".env"
load_dotenv(dotenv_path=ENV_PATH)


def extract_json(text: str) -> dict[str, Any]:
    """Extract JSON object from model text response."""
    cleaned = text.strip()

    if cleaned.startswith("```"):
        import re
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(cleaned[start : end + 1])


def split_transcript_into_chunks(transcript_text: str, max_chars_per_chunk: int) -> list[str]:
    if len(transcript_text) <= max_chars_per_chunk:
        return [transcript_text]

    lines = transcript_text.splitlines()
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for line in lines:
        line = line.strip()
        if not line:
            continue

        line_len = len(line) + 1
        if current and current_len + line_len > max_chars_per_chunk:
            chunks.append("\n".join(current))
            current = [line]
            current_len = line_len
        else:
            current.append(line)
            current_len += line_len

    if current:
        chunks.append("\n".join(current))

    if not chunks:
        chunks = [transcript_text[i : i + max_chars_per_chunk] for i in range(0, len(transcript_text), max_chars_per_chunk)]

    return chunks


def build_prompt(video_id: str, transcript_text: str, chunk_index: int, total_chunks: int) -> str:
    return f"""
You clean and structure transcript data for AI interviewer training.

Context:
- video_id: {video_id}
- chunk: {chunk_index}/{total_chunks}

Requirements:
1) Remove noise/filler words (uh, um, uhh, hmm, repeated stutters).
2) Correct grammar/punctuation lightly WITHOUT changing meaning.
3) Remove non-content lines ([Music], promos/outros, obvious duplicates).
4) Decide speaker labels per turn: INTERVIEWER, EMPLOYEE, or UNKNOWN.
5) Return ONLY valid JSON.

Output schema (simple):
{{
    "video_id": "{video_id}",
    "summary": "short summary",
    "quality_flags": ["remaining issues if any"],
    "turns": [
        {{"speaker": "INTERVIEWER|EMPLOYEE|UNKNOWN", "text": "cleaned utterance"}}
    ],
    "training_pairs": [
        {{
            "question": "interviewer question text",
            "answer": "employee answer text",
            "follow_up": "follow-up question text OR NONE"
        }}
    ]
}}

Rules for training_pairs:
- Use this exact 3-field shape: question, answer, follow_up.
- follow_up must be either a question string or the exact string "NONE".
- Do not build linked lists or references.
- If topic changes, start a new training pair naturally.
- Produce 3-12 high-quality pairs for this chunk when transcript allows.

Raw transcript:
{transcript_text}
""".strip()


def merge_chunk_results(video_id: str, chunk_results: list[dict[str, Any]]) -> dict[str, Any]:
    quality_flags: list[str] = []
    turns: list[dict[str, Any]] = []
    training_pairs: list[dict[str, Any]] = []
    summaries: list[str] = []

    for result in chunk_results:
        if result.get("summary"):
            summaries.append(str(result["summary"]).strip())

        for flag in result.get("quality_flags", []):
            flag_s = str(flag).strip()
            if flag_s and flag_s not in quality_flags:
                quality_flags.append(flag_s)

        for turn in result.get("turns", []):
            if isinstance(turn, dict) and turn.get("text"):
                turns.append(turn)

        for pair in result.get("training_pairs", []):
            if not isinstance(pair, dict):
                continue
            question = str(pair.get("question", "")).strip()
            answer = str(pair.get("answer", "")).strip()
            follow_up = str(pair.get("follow_up", "NONE")).strip() or "NONE"
            if question and answer:
                training_pairs.append(
                    {
                        "question": question,
                        "answer": answer,
                        "follow_up": follow_up,
                    }
                )

    summary = " ".join(summaries[:3]).strip()
    if not summary:
        summary = "Cleaned and structured transcript chunks."

    return {
        "video_id": video_id,
        "summary": summary,
        "quality_flags": quality_flags,
        "turns": turns,
        "training_pairs": training_pairs,
    }


def groq_generate_json(
    client: Groq,
    model: str,
    prompt: str,
    max_retries: int = 3,
    base_backoff_sec: float = 5.0,
) -> dict[str, Any]:
    attempt = 0
    while True:
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=4096,
            )
            text = response.choices[0].message.content
            if not text:
                raise RuntimeError("Empty response from Groq")
            return extract_json(text)

        except RateLimitError as exc:
            if attempt >= max_retries:
                raise RuntimeError(f"Groq rate-limited after {max_retries} retries: {exc}") from exc
            wait_sec = base_backoff_sec * (2 ** attempt)
            print(f"[rate-limit] Groq 429; retrying in {wait_sec:.1f}s (attempt {attempt + 1}/{max_retries})")
            time.sleep(wait_sec)
            attempt += 1

        except APIStatusError as exc:
            raise RuntimeError(f"Groq API error {exc.status_code}: {exc.message}") from exc


def write_json(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0

    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with open(path, "a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def process_file(
    txt_path: Path,
    output_structured_dir: Path,
    output_jsonl_path: Path,
    client: Groq,
    model: str,
    overwrite: bool,
    delay_sec: float,
    max_retries: int,
    base_backoff_sec: float,
    max_chars_per_chunk: int,
) -> tuple[bool, int]:
    video_id = txt_path.stem
    structured_out = output_structured_dir / f"{video_id}.json"

    if structured_out.exists() and not overwrite:
        print(f"[skip] {video_id}: structured json already exists")
        return True, 0

    transcript_text = txt_path.read_text(encoding="utf-8", errors="ignore").strip()
    if not transcript_text:
        print(f"[skip] {video_id}: empty transcript")
        return True, 0

    chunks = split_transcript_into_chunks(transcript_text, max_chars_per_chunk=max_chars_per_chunk)
    chunk_results: list[dict[str, Any]] = []

    for i, chunk_text in enumerate(chunks, start=1):
        prompt = build_prompt(video_id=video_id, transcript_text=chunk_text, chunk_index=i, total_chunks=len(chunks))
        result = groq_generate_json(
            client=client,
            model=model,
            prompt=prompt,
            max_retries=max_retries,
            base_backoff_sec=base_backoff_sec,
        )
        chunk_results.append(result)
        if delay_sec > 0:
            time.sleep(delay_sec)

    result = merge_chunk_results(video_id=video_id, chunk_results=chunk_results)
    result["video_id"] = video_id
    write_json(structured_out, result)

    training_pairs = result.get("training_pairs", [])
    written = append_jsonl(output_jsonl_path, training_pairs)

    print(f"[ok] {video_id}: {len(chunks)} chunk(s), wrote structured json, appended {written} training pairs")

    return True, written


def parse_args() -> argparse.Namespace:
    default_in = Path(__file__).resolve().parent.parent / "data" / "raw"
    default_out = Path(__file__).resolve().parent.parent / "data" / "processed"

    parser = argparse.ArgumentParser(
        description="Clean raw transcript txt files with Groq and export training-grade structured data."
    )
    parser.add_argument("--input-dir", type=Path, default=default_in)
    parser.add_argument("--output-dir", type=Path, default=default_out)
    parser.add_argument("--model", default="llama-3.3-70b-versatile", help="Groq model name")
    parser.add_argument("--limit", type=int, default=0, help="Process only first N files (0 = all)")
    parser.add_argument("--overwrite", action="store_true", help="Reprocess files even if output already exists")
    parser.add_argument("--delay-sec", type=float, default=0.5, help="Delay between API calls")
    parser.add_argument("--max-retries", type=int, default=3, help="Retries on rate limits")
    parser.add_argument("--base-backoff-sec", type=float, default=5.0, help="Base backoff seconds for retries")
    parser.add_argument("--max-chars-per-chunk", type=int, default=8000, help="Max transcript chars per request")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Missing GROQ_API_KEY in environment. Add it to backend/.env")

    client = Groq(api_key=api_key)

    input_dir: Path = args.input_dir
    output_dir: Path = args.output_dir
    structured_dir = output_dir / "structured"
    sft_jsonl = output_dir / "training_pairs.jsonl"

    txt_files = sorted(input_dir.glob("*.txt"))
    if args.limit > 0:
        txt_files = txt_files[: args.limit]

    if not txt_files:
        print(f"No .txt files found in {input_dir}")
        return

    ok_count = 0
    fail_count = 0
    sft_rows = 0

    for txt_path in txt_files:
        try:
            ok, rows = process_file(
                txt_path=txt_path,
                output_structured_dir=structured_dir,
                output_jsonl_path=sft_jsonl,
                client=client,
                model=args.model,
                overwrite=args.overwrite,
                delay_sec=args.delay_sec,
                max_retries=args.max_retries,
                base_backoff_sec=args.base_backoff_sec,
                max_chars_per_chunk=args.max_chars_per_chunk,
            )
            if ok:
                ok_count += 1
                sft_rows += rows
        except Exception as exc:
            fail_count += 1
            print(f"[err] {txt_path.name}: {exc}")

    print("\nDone")
    print(f"  input_dir: {input_dir}")
    print(f"  output_dir: {output_dir}")
    print(f"  processed_ok: {ok_count}")
    print(f"  failed: {fail_count}")
    print(f"  training_pairs_written: {sft_rows}")


if __name__ == "__main__":
    main()
