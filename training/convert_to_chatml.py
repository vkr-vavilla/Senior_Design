"""
Convert structured interview JSONs into ChatML training data.

Two modes:
  1. --plain  (default): straight INTERVIEWER -> assistant, EMPLOYEE -> user mapping.
              Fast, no API calls. Produces the same output as the original script.

  2. --enrich: use an LLM to enrich each conversation:
              - Fabricate a plausible candidate resume + job description
              - Rewrite each INTERVIEWER turn into warm Alex-style
                (3-5 sentences, react to specifics, drill technically)
              - Keep all EMPLOYEE turns exactly as-is (they're the real candidate data)

Usage:
    python training/convert_to_chatml.py --plain
    python training/convert_to_chatml.py --enrich --provider gemini
    python training/convert_to_chatml.py --enrich --provider groq

Provider keys (GEMINI_API_KEY or GROQ_API_KEY) are read from backend/.env or env.
"""

import argparse
import glob
import json
import os
import sys
import re
import time
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
DEFAULT_INPUT_DIR = REPO_ROOT / "data" / "processed" / "structured"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "processed" / "chatml_training_data.jsonl"

# Original plain-mode system prompt (kept for backward compat)
PLAIN_SYSTEM_PROMPT = (
    "You are an expert Senior Software Engineer at a top-tier tech company conducting a technical interview. "
    "Your objective is to assess the candidate's technical depth, problem-solving skills, and real-world experience. "
    "Keep probing with follow-up questions to fully gauge the candidate's depth on the current topic. "
    "When a topic has been sufficiently explored, transition naturally to a new topic and continue probing. "
    "Acknowledge the candidate's responses naturally before asking your next question. "
    "Continue the interview until the candidate or the session concludes. "
    "Keep your tone conversational, professional, and human. Do not break character."
)

# Enrich-mode persona injected into the final system prompt
ALEX_PERSONA = """=== YOUR ROLE ===
You are Alex, a warm and experienced senior engineer running this interview.

VOICE & STYLE:
- React substantively (2-3 sentences) to a specific detail the candidate just said — quote a number, tool, project, or tradeoff they mentioned.
- THEN ask one focused, drilling follow-up question. Go technical.
- Never use filler openers like "That sounds great" or "Interesting." Vary your openers.
- Each turn should be 3-5 sentences, not one-liners.

GROUNDING:
- Every question must tie to the resume above OR something the candidate just said.
- Don't ask about skills not on the resume."""


def load_env_file():
    env_path = REPO_ROOT / "backend" / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k and k not in os.environ:
            os.environ[k] = v.strip().strip('"').strip("'")


def collect_clean_turns(file_path: Path) -> list[dict] | None:
    """Read a structured JSON and return the cleaned INTERVIEWER/EMPLOYEE turn list."""
    try:
        with file_path.open() as f:
            data = json.load(f)
    except Exception as e:
        print(f"  ERROR reading {file_path.name}: {e}")
        return None

    turns = data.get("turns", [])
    clean = []
    for t in turns:
        speaker = t.get("speaker")
        text = (t.get("text") or "").strip()
        if speaker in ("INTERVIEWER", "EMPLOYEE") and text:
            clean.append({"speaker": speaker, "text": text})
    if len(clean) < 2 or clean[0]["speaker"] != "INTERVIEWER":
        return None
    return clean


def turns_to_plain_chatml(turns: list[dict]) -> dict:
    messages = [{"role": "system", "content": PLAIN_SYSTEM_PROMPT}]
    for t in turns:
        role = "assistant" if t["speaker"] == "INTERVIEWER" else "user"
        messages.append({"role": role, "content": t["text"]})
    return {"messages": messages}


# --- Enrich mode ---

ENRICH_INSTRUCTIONS = """You are reshaping a real interview transcript into high-quality training data for an AI interviewer named "Alex".

You will receive a list of interview turns labeled INTERVIEWER and EMPLOYEE. Your job:

1. Read the conversation and infer what kind of role/domain the candidate fits (e.g. "backend SWE", "ML engineer", "PM").

2. Fabricate a REALISTIC RESUME for the candidate that matches what they discuss. Include name, contact, skills, 2-3 work experiences with bullets, 2-3 projects, education. Keep it plausible — the projects/skills they mention in the transcript should appear on this resume.

3. Fabricate a REALISTIC JOB DESCRIPTION the candidate is interviewing for (one that fits the conversation).

4. REWRITE each INTERVIEWER turn so it sounds like Alex — a warm senior engineer:
   - 3-5 sentences per turn (not the short clinical "Yeah continue" style from the source)
   - REACT substantively to a specific detail the EMPLOYEE just said (quote a number, tool, tradeoff)
   - Then ASK one drilling follow-up question (technical, specific, grounded in resume or what they said)
   - Vary openers: "Walk me through...", "Hmm, when you say X...", "Got it. And...", "Wait, that's interesting — why...?"
   - NO filler like "That sounds great", "Interesting"

5. KEEP every EMPLOYEE turn EXACTLY as-is. Do not modify candidate text. Those are real and valuable.

6. The conversation should preserve the same topic flow as the original. Don't add or remove turns — only rewrite the interviewer's wording.

Return a JSON object with this exact shape (no markdown, no commentary):

{
  "resume": "...full fabricated resume text...",
  "job_description": "...full fabricated JD text...",
  "interviewer_turns": [
     "rewritten Alex turn 1 (3-5 sentences)",
     "rewritten Alex turn 2 (3-5 sentences)",
     ...
  ]
}

The interviewer_turns array must have EXACTLY the same length as the number of INTERVIEWER turns in my input, in the same order."""


def _build_transcript(turns: list[dict]) -> tuple[str, int]:
    lines = []
    for i, t in enumerate(turns):
        lines.append(f"[{t['speaker']}_{i}] {t['text']}")
    transcript = "\n\n".join(lines)
    interviewer_count = sum(1 for t in turns if t["speaker"] == "INTERVIEWER")
    return transcript, interviewer_count


def call_gemini_enrich(client, turns: list[dict]) -> dict:
    """Send turns to Gemini, get back resume+jd+rewritten interviewer turns."""
    from google.genai import types as genai_types

    transcript, interviewer_count = _build_transcript(turns)
    user_prompt = (
        f"Here is the source interview transcript:\n\n{transcript}\n\n"
        f"Generate the enriched output now. The \"interviewer_turns\" array must have exactly "
        f"{interviewer_count} entries."
    )

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=user_prompt,
        config=genai_types.GenerateContentConfig(
            system_instruction=ENRICH_INSTRUCTIONS,
            temperature=0.85,
            max_output_tokens=8000,
            response_mime_type="application/json",
        ),
    )
    text = (response.text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
    return json.loads(text.strip())


def _groq_call_raw(client, turns: list[dict], extra_user_context: str = "") -> dict:
    """One Groq call. Returns parsed JSON dict with resume, job_description, interviewer_turns."""
    transcript, interviewer_count = _build_transcript(turns)
    user_prompt = (
        f"{extra_user_context}"
        f"Here is the source interview transcript:\n\n{transcript}\n\n"
        f"Generate the enriched output now. The \"interviewer_turns\" array must have exactly "
        f"{interviewer_count} entries. Return ONLY a JSON object."
    )

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": ENRICH_INSTRUCTIONS},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.85,
        max_tokens=5000,
        response_format={"type": "json_object"},
    )
    text = (response.choices[0].message.content or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
    return json.loads(text.strip())


def _chunk_turns(turns: list[dict], max_chars_per_chunk: int) -> list[list[dict]]:
    """Split turns into roughly equal chunks under the char limit. Splits only at turn boundaries."""
    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for t in turns:
        t_chars = len(t["text"])
        if current and current_chars + t_chars > max_chars_per_chunk:
            chunks.append(current)
            current = []
            current_chars = 0
        current.append(t)
        current_chars += t_chars
    if current:
        chunks.append(current)
    return chunks


def call_groq_enrich(client, turns: list[dict]) -> dict:
    """Enrich a conversation. For oversized transcripts, chunk and stitch.

    The first chunk fabricates the resume + JD. Subsequent chunks receive that
    context and only contribute their slice of rewritten interviewer turns.
    """
    transcript_chars = sum(len(t["text"]) for t in turns)
    # ~24k chars ≈ 6000 input tokens; plus 3500 instruction tokens and 5000 max_tokens
    # leaves headroom under 12k TPM.
    SAFE_CHUNK_CHARS = 18000

    if transcript_chars <= SAFE_CHUNK_CHARS:
        return _groq_call_raw(client, turns)

    chunks = _chunk_turns(turns, SAFE_CHUNK_CHARS)
    print(f"  Chunking: {transcript_chars} chars → {len(chunks)} chunks")

    # First chunk produces resume + JD + first slice of interviewer turns
    first_result = _groq_call_raw(client, chunks[0])
    resume = first_result["resume"]
    jd = first_result["job_description"]
    all_interviewer_turns = list(first_result["interviewer_turns"])

    # Subsequent chunks: reuse the resume/JD as context so style stays consistent
    for ci, chunk in enumerate(chunks[1:], 2):
        # Brief pause between chunk calls to spread out TPM usage
        time.sleep(3)
        context_note = (
            f"CONTEXT: This is chunk {ci} of {len(chunks)} of the same interview. "
            f"Use the SAME fabricated resume and JD throughout (do not invent new ones). "
            f"Resume already chosen: {resume[:500]}...\n"
            f"JD already chosen: {jd[:300]}...\n\n"
        )
        chunk_result = _groq_call_raw(client, chunk, extra_user_context=context_note)
        all_interviewer_turns.extend(chunk_result["interviewer_turns"])

    return {
        "resume": resume,
        "job_description": jd,
        "interviewer_turns": all_interviewer_turns,
    }


def build_enriched_messages(turns: list[dict], enrichment: dict) -> dict:
    """Combine original EMPLOYEE turns with model-rewritten INTERVIEWER turns + new system prompt."""
    interviewer_idx = 0
    rewritten = enrichment["interviewer_turns"]

    system_content = (
        f"=== CANDIDATE RESUME ===\n{enrichment['resume']}\n\n"
        f"=== JOB DESCRIPTION ===\n{enrichment['job_description']}\n\n"
        f"{ALEX_PERSONA}"
    )

    interviewer_count_in_transcript = sum(1 for t in turns if t["speaker"] == "INTERVIEWER")

    # Hard fail only if the model produced fewer turns than the transcript needs.
    if len(rewritten) < interviewer_count_in_transcript:
        raise ValueError(
            f"model returned {len(rewritten)} interviewer turns but transcript needs {interviewer_count_in_transcript}"
        )

    # If the model produced MORE turns than needed (common off-by-one or chunk overshoot),
    # silently use the first N — drop the extras.
    messages = [{"role": "system", "content": system_content}]
    for t in turns:
        if t["speaker"] == "INTERVIEWER":
            messages.append({"role": "assistant", "content": rewritten[interviewer_idx].strip()})
            interviewer_idx += 1
        else:
            messages.append({"role": "user", "content": t["text"]})

    return {"messages": messages}


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plain", action="store_true", help="Straight conversion (default).")
    mode.add_argument("--enrich", action="store_true", help="Use Gemini to rewrite interviewer turns + add resume/JD.")
    parser.add_argument("--input-dir", default=str(DEFAULT_INPUT_DIR))
    parser.add_argument("--out", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--provider", choices=["gemini", "groq"], default="gemini",
                        help="LLM provider for --enrich mode")
    parser.add_argument("--rate-limit", type=float, default=2.5,
                        help="Seconds between API calls (default 2.5 = ~24/min)")
    parser.add_argument("--max-retries", type=int, default=2)
    args = parser.parse_args()

    # Default to plain if neither flag given
    if not args.plain and not args.enrich:
        args.plain = True

    files = sorted(Path(args.input_dir).glob("*.json"))
    print(f"Found {len(files)} JSON files in {args.input_dir}")

    client = None
    enrich_fn = None
    out_name = None
    if args.enrich:
        load_env_file()
        if args.provider == "gemini":
            api_key = os.environ.get("GEMINI_API_KEY")
            if not api_key:
                print("ERROR: GEMINI_API_KEY missing (not in env or backend/.env)", file=sys.stderr)
                sys.exit(1)
            from google import genai
            client = genai.Client(api_key=api_key)
            enrich_fn = call_gemini_enrich
            out_name = "chatml_enriched.jsonl"
        elif args.provider == "groq":
            api_key = os.environ.get("GROQ_API_KEY")
            if not api_key:
                print("ERROR: GROQ_API_KEY missing (not in env or backend/.env)", file=sys.stderr)
                sys.exit(1)
            from groq import Groq
            client = Groq(api_key=api_key)
            enrich_fn = call_groq_enrich
            out_name = "chatml_enriched.jsonl"

    out_path = Path(args.out)
    if out_name and out_path == DEFAULT_OUTPUT:
        out_path = REPO_ROOT / "data" / "processed" / out_name
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Resume support: match existing output entries to source files by candidate turn content.
    # This handles the case where some entries got filtered/removed and gaps exist.
    done_files: set[str] = set()
    file_mode = "w"
    if args.enrich and out_path.exists() and out_path.stat().st_size > 0:
        # Build map of first candidate text -> source filename
        source_map: dict[str, str] = {}
        for fp in files:
            t = collect_clean_turns(fp)
            if not t:
                continue
            first_emp = next((x["text"] for x in t if x["speaker"] == "EMPLOYEE"), None)
            if first_emp:
                source_map[first_emp[:200].strip()] = fp.name

        with out_path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ex = json.loads(line)
                except Exception:
                    continue
                # Find first user turn in this conversation
                for m in ex.get("messages", []):
                    if m.get("role") == "user":
                        key = m.get("content", "")[:200].strip()
                        if key in source_map:
                            done_files.add(source_map[key])
                        break

        if done_files:
            file_mode = "a"
            print(f"Resume: {len(done_files)} source files already enriched in {out_path.name}, skipping those.")

    successes = 0
    skipped = 0
    failures = 0

    with out_path.open(file_mode) as out_f:
        for i, file_path in enumerate(files):
            if args.enrich and file_path.name in done_files:
                # Already enriched in a previous run
                continue

            turns = collect_clean_turns(file_path)
            if not turns:
                print(f"  SKIP: {file_path.name}")
                skipped += 1
                continue

            if args.plain:
                example = turns_to_plain_chatml(turns)
                out_f.write(json.dumps(example, ensure_ascii=False) + "\n")
                successes += 1
                print(f"[{i+1}/{len(files)}] OK (plain) — {file_path.name}")
            else:
                # call_groq_enrich now auto-chunks large transcripts, so no size
                # cutoff is needed. Skip the plain-mode fallback entirely.

                attempt = 0
                while attempt <= args.max_retries:
                    try:
                        enrichment = enrich_fn(client, turns)
                        example = build_enriched_messages(turns, enrichment)
                        out_f.write(json.dumps(example, ensure_ascii=False) + "\n")
                        out_f.flush()
                        successes += 1
                        print(f"[{i+1}/{len(files)}] OK (enriched) — {file_path.name}")
                        break
                    except Exception as e:
                        err_str = str(e)
                        # Detect Groq TPM/RPM rate limit and parse the "try again in Xs" hint.
                        # Handles formats: "1h18m38s", "78m38s", "30s", "10ms"
                        retry_after = None
                        m_h = re.search(r"try again in (\d+)h(\d+)m([\d.]+)s", err_str)
                        m = re.search(r"try again in (\d+)m([\d.]+)s", err_str)
                        m_ms = re.search(r"try again in (\d+)ms", err_str)
                        m_s = re.search(r"try again in ([\d.]+)s", err_str)
                        if m_h:
                            retry_after = int(m_h.group(1)) * 3600 + int(m_h.group(2)) * 60 + float(m_h.group(3)) + 5
                        elif m:
                            retry_after = int(m.group(1)) * 60 + float(m.group(2)) + 5
                        elif m_ms:
                            retry_after = 2.0
                        elif m_s:
                            retry_after = float(m_s.group(1)) + 5

                        # Daily quota hit (long wait). Don't fall back to plain — stop the script
                        # cleanly so the user can swap in a fresh API key and resume.
                        if retry_after and retry_after > 600:
                            print()
                            print("=" * 60)
                            print(f"DAILY GROQ QUOTA EXHAUSTED on file {file_path.name}.")
                            print(f"Wait time would be {retry_after:.0f}s ({retry_after/60:.1f} min).")
                            print(f"Swap in a fresh GROQ_API_KEY in backend/.env and re-run:")
                            print(f"  python training/convert_to_chatml.py --enrich --provider groq")
                            print(f"The resume logic will skip the {len(done_files) + successes} files already done.")
                            print("=" * 60)
                            sys.exit(0)

                        attempt += 1
                        if retry_after:
                            print(f"[{i+1}/{len(files)}] rate-limited, sleeping {retry_after:.0f}s and retrying (attempt {attempt})")
                            time.sleep(retry_after)
                            attempt -= 1   # don't count the wait as a retry
                            continue
                        print(f"[{i+1}/{len(files)}] attempt {attempt} failed: {e}")
                        if attempt > args.max_retries:
                            failures += 1
                        else:
                            time.sleep(3 * attempt)
                if i < len(files) - 1:
                    time.sleep(args.rate_limit)

    print("\n" + "=" * 60)
    print(f"Done. Wrote {successes} conversations to {out_path}")
    print(f"Skipped: {skipped}, failed: {failures}")
    print("=" * 60)
    if args.enrich:
        print("\nNext: re-split train/val:")
        print(f"  python training/split_chatml_dataset.py --input {out_path}")


if __name__ == "__main__":
    main()
