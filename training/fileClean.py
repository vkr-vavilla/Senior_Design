from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

import google.generativeai as genai
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

    import re
    sentences = re.split(r'(?<=[.!?])\s+', transcript_text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for sentence in sentences:
        sentence_len = len(sentence) + 1
        if current and current_len + sentence_len > max_chars_per_chunk:
            chunks.append(" ".join(current))
            current = [sentence]
            current_len = sentence_len
        else:
            current.append(sentence)
            current_len += sentence_len

    if current:
        chunks.append(" ".join(current))

    if not chunks:
        chunks = [transcript_text[i : i + max_chars_per_chunk]
                  for i in range(0, len(transcript_text), max_chars_per_chunk)]

    return chunks


def build_prompt(video_id: str, transcript_text: str, chunk_index: int, total_chunks: int) -> str:
    return f"""You clean and structure raw interview transcript data for AI interviewer training.

Context:
- video_id: {video_id}
- chunk: {chunk_index}/{total_chunks}

YOUR PRIMARY RULE: Change as little wording as possible. Keep every word of the transcript VERBATIM.
Only remove these specific things:
- Filler sounds: uh, um, uhh, hmm, uh-huh (when used as filler)
- Half-words / aborted words before a self-correction (e.g. "I was — we were" → "we were")
- Exact repeated-word stutters (e.g. "we we had" → "we had", "the the" → "the")
- Non-content lines: [Music], [Applause], promo/outro text, sponsor mentions

DO NOT paraphrase. DO NOT summarize. DO NOT condense or shorten any answer. Keep all the original wording.

Identify speaker labels based on context:
- INTERVIEWER: the person asking questions / giving feedback
- EMPLOYEE: the candidate / interviewee answering
- UNKNOWN: narrator, host, viewer commentary not part of the actual interview

For training_pairs:
- Include a pair for EVERY question-answer exchange in the transcript (not just highlights)
- question: the INTERVIEWER's question, verbatim (fillers removed)
- answer: the EMPLOYEE's FULL answer, verbatim (fillers removed) — do NOT shorten it
- follow_up: the very next INTERVIEWER question after this answer, verbatim, OR the string "NONE"

Return ONLY valid JSON matching this schema exactly:
{{
    "video_id": "{video_id}",
    "summary": "one paragraph summary of the interview topic and participants",
    "quality_flags": ["any remaining issues"],
    "turns": [
        {{"speaker": "INTERVIEWER|EMPLOYEE|UNKNOWN", "text": "full verbatim text with fillers removed"}}
    ],
    "training_pairs": [
        {{
            "question": "interviewer question verbatim",
            "answer": "employee full answer verbatim",
            "follow_up": "next interviewer question verbatim OR NONE"
        }}
    ]
}}

Raw transcript chunk:
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
        summary = "Cleaned and structured transcript."

    return {
        "video_id": video_id,
        "summary": summary,
        "quality_flags": quality_flags,
        "turns": turns,
        "training_pairs": training_pairs,
    }


def gemini_generate_json(
    model: genai.GenerativeModel,
    prompt: str,
) -> dict[str, Any]:
    try:
        response = model.generate_content(prompt)
        text = response.text if response.text else ""
        if not text:
            raise RuntimeError("Empty response from Gemini")
        return extract_json(text)
    except Exception as exc:
        raise RuntimeError(f"Gemini API error: {exc}") from exc


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
    model: genai.GenerativeModel,
    overwrite: bool,
    delay_sec: float,
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
        print(f"  chunk {i}/{len(chunks)} ({len(chunk_text)} chars)...")
        prompt = build_prompt(video_id=video_id, transcript_text=chunk_text, chunk_index=i, total_chunks=len(chunks))
        result = gemini_generate_json(model=model, prompt=prompt)
        chunk_results.append(result)
        if delay_sec > 0 and i < len(chunks):
            time.sleep(delay_sec)

    result = merge_chunk_results(video_id=video_id, chunk_results=chunk_results)
    result["video_id"] = video_id
    write_json(structured_out, result)

    training_pairs = result.get("training_pairs", [])
    written = append_jsonl(output_jsonl_path, training_pairs)

    print(f"[ok] {video_id}: {len(chunks)} chunk(s), {len(result['turns'])} turns, {written} training pairs")
    return True, written


def parse_args() -> argparse.Namespace:
    default_in = Path(__file__).resolve().parent.parent / "data" / "raw"
    default_out = Path(__file__).resolve().parent.parent / "data" / "processed"

    parser = argparse.ArgumentParser(
        description="Clean raw transcript txt files with Gemini and export structured training data."
    )
    parser.add_argument("--input-dir", type=Path, default=default_in)
    parser.add_argument("--output-dir", type=Path, default=default_out)
    parser.add_argument("--model", default="gemini-1.5-flash", help="Gemini model ID")
    parser.add_argument("--limit", type=int, default=0, help="Process only first N files (0 = all)")
    parser.add_argument("--overwrite", action="store_true", help="Reprocess files even if output already exists")
    parser.add_argument("--delay-sec", type=float, default=1.0, help="Delay between API calls in seconds")
    parser.add_argument("--max-chars-per-chunk", type=int, default=20000, help="Max transcript chars per request")
    parser.add_argument("--file", type=str, default="", help="Process a single specific file by video ID (e.g. yJBXunVOWC4)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "Missing GEMINI_API_KEY in environment. "
            "Add it to backend/.env as: GEMINI_API_KEY=..."
        )

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(args.model)

    input_dir: Path = args.input_dir
    output_dir: Path = args.output_dir
    structured_dir = output_dir / "structured"
    sft_jsonl = output_dir / "training_pairs.jsonl"

    if args.file:
        txt_files = [input_dir / f"{args.file}.txt"]
        txt_files = [f for f in txt_files if f.exists()]
        if not txt_files:
            print(f"File not found: {input_dir / args.file}.txt")
            return
    else:
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
        print(f"\nProcessing {txt_path.name}...")
        try:
            ok, rows = process_file(
                txt_path=txt_path,
                output_structured_dir=structured_dir,
                output_jsonl_path=sft_jsonl,
                model=model,
                overwrite=args.overwrite,
                delay_sec=args.delay_sec,
                max_chars_per_chunk=args.max_chars_per_chunk,
            )
            if ok:
                ok_count += 1
                sft_rows += rows
        except Exception as exc:
            fail_count += 1
            print(f"[err] {txt_path.name}: {exc}")

    print("\n=== Done ===")
    print(f"  input_dir:              {input_dir}")
    print(f"  output_dir:             {output_dir}")
    print(f"  processed_ok:           {ok_count}")
    print(f"  failed:                 {fail_count}")
    print(f"  training_pairs_written: {sft_rows}")


if __name__ == "__main__":
    main()
