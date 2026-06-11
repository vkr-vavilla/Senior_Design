"""
Synthesize multi-turn interview conversations from the ali-alkhars/interviews HuggingFace dataset.

The HF dataset contains interview *questions* only (no candidate answers).
This script:
  1. Loads the dataset and deduplicates questions by topic
  2. Selects the best ~100 questions across underrepresented topics
     (React, Vue, Angular, JS, Backend, Data Structures, System Design)
  3. Groups them into sessions of 5-7 questions each (~15 sessions total)
  4. Calls Groq to synthesize a realistic multi-turn interview per session:
     - Interviewer asks each seeded question, may add 1 natural follow-up
     - Candidate gives a realistic answer (good but not perfect, mid-senior level)
  5. Saves each session as a structured JSON in data/processed/structured/
     matching the format expected by convert_to_chatml.py --enrich

Run:
    python training/synthesize_hf_interviews.py
    python training/synthesize_hf_interviews.py --dry-run   # show plan, no API calls
"""

import argparse
import json
import os
import random
import time
from pathlib import Path

from datasets import load_dataset

REPO_ROOT = Path(__file__).parent.parent
OUTPUT_DIR = REPO_ROOT / "data" / "processed" / "structured"


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


# Topic buckets we want to cover — maps a label to a set of keywords
# that match against the "input" field of the HF dataset.
TOPIC_BUCKETS = {
    "react": ["react"],
    "vue": ["vue"],
    "angular": ["angular"],
    "javascript": ["javascript"],
    "backend": ["back-end", "backend"],
    "java": ["java"],
    "system_design": ["system design"],
    "data_structures": ["data structures", "algorithms"],
    "css_frontend": ["css", "front-end", "frontend", "html"],
    "devops": ["devops"],
    "database": ["database", "sql"],
    "general_swe": ["software engineering", "programming", "mock interview", "prepare me"],
}

# How many questions to pick per bucket (soft cap — deduped first)
BUCKET_QUOTAS = {
    "react": 15,
    "vue": 10,
    "angular": 10,
    "javascript": 15,
    "backend": 10,
    "java": 8,
    "system_design": 5,
    "data_structures": 5,
    "css_frontend": 5,
    "devops": 5,
    "database": 5,
    "general_swe": 7,
}

# How many questions to put in each synthesized session
SESSION_SIZE = 6

SYNTHESIS_SYSTEM = """You are generating high-quality training data for an AI interviewer model.

You will receive a list of interview questions on a specific topic. Your job is to write a REALISTIC multi-turn interview conversation between an interviewer and a candidate.

Rules:
1. The INTERVIEWER starts with a brief warm opener then asks the first question.
2. The CANDIDATE answers each question in a realistic, mid-to-senior-level way:
   - Correct but not textbook-perfect — they may miss minor details, use imprecise phrasing, or take a moment to think
   - 3-7 sentences per answer. Include concrete examples, specific tools, or tradeoffs where natural.
   - DO NOT write "CANDIDATE:" or role labels in the text — just the spoken words.
3. After each candidate answer, the INTERVIEWER either:
   - Asks a natural drill-down follow-up (if the answer touched something interesting), OR
   - Briefly acknowledges and moves to the next seeded question
   - 1-3 sentences per interviewer turn.
4. Cover ALL the seeded questions. You may add at most 1-2 follow-up sub-questions total across the whole session — don't bloat it.
5. The last interviewer turn should wrap up that topic naturally ("Got it, that covers it. Let's switch gears — ..." or similar).

Return a JSON object with this exact shape (no markdown):
{
  "summary": "One sentence describing what the candidate demonstrated in this session.",
  "turns": [
    {"speaker": "INTERVIEWER", "text": "..."},
    {"speaker": "EMPLOYEE", "text": "..."},
    ...
  ]
}

The turns array must strictly alternate INTERVIEWER / EMPLOYEE, starting with INTERVIEWER."""


def classify_question(input_field: str, buckets: dict) -> str | None:
    inp = input_field.lower()
    for bucket, keywords in buckets.items():
        if any(kw in inp for kw in keywords):
            return bucket
    return None


def build_question_pool(ds, quotas: dict, seed: int = 42) -> dict[str, list[str]]:
    """Return {bucket: [question, ...]} with deduplication and quota enforcement."""
    rng = random.Random(seed)
    by_bucket: dict[str, set] = {b: set() for b in quotas}

    for row in ds:
        bucket = classify_question(row["input"], TOPIC_BUCKETS)
        if bucket is None:
            continue
        q = row["response"].strip()
        if len(q) < 15 or "?" not in q:  # skip non-questions / garbage rows
            continue
        by_bucket[bucket].add(q)

    result = {}
    for bucket, quota in quotas.items():
        questions = list(by_bucket[bucket])
        rng.shuffle(questions)
        result[bucket] = questions[:quota]

    return result


def make_sessions(pool: dict[str, list[str]], session_size: int, seed: int = 42) -> list[dict]:
    """
    Group questions into sessions. Each session gets questions from ONE topic bucket
    so the conversation stays coherent.
    Returns list of {"topic": str, "questions": [str, ...]}
    """
    rng = random.Random(seed)
    sessions = []
    for topic, questions in pool.items():
        rng.shuffle(questions)
        for i in range(0, len(questions), session_size):
            chunk = questions[i : i + session_size]
            if len(chunk) < 3:  # skip tiny leftover chunks
                continue
            sessions.append({"topic": topic, "questions": chunk})
    rng.shuffle(sessions)
    return sessions


def call_groq(client, session: dict) -> dict:
    topic = session["topic"].replace("_", " ")
    questions_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(session["questions"]))
    user_prompt = (
        f"Topic: {topic}\n\n"
        f"Seeded questions to cover (in roughly this order):\n{questions_block}\n\n"
        f"Generate the interview conversation now. Return ONLY a JSON object."
    )

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYNTHESIS_SYSTEM},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.85,
        max_tokens=3000,
        response_format={"type": "json_object"},
    )
    text = (response.choices[0].message.content or "").strip()
    return json.loads(text)


def save_session(result: dict, topic: str, idx: int) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    video_id = f"hf_{topic}_{idx:03d}"
    structured = {
        "video_id": video_id,
        "summary": result.get("summary", ""),
        "quality_flags": [],
        "turns": result["turns"],
    }
    out_path = OUTPUT_DIR / f"{video_id}.json"
    out_path.write_text(json.dumps(structured, indent=2, ensure_ascii=False))
    return out_path


def validate_turns(turns: list) -> bool:
    if not turns or turns[0]["speaker"] != "INTERVIEWER":
        return False
    for i, t in enumerate(turns):
        expected = "INTERVIEWER" if i % 2 == 0 else "EMPLOYEE"
        if t["speaker"] != expected:
            return False
        if not t["text"].strip():
            return False
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Show plan without making API calls")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--session-size", type=int, default=SESSION_SIZE)
    args = parser.parse_args()

    load_env_file()

    print("Loading HuggingFace dataset...")
    ds = load_dataset("ali-alkhars/interviews", split="train")
    print(f"  {len(ds)} rows loaded")

    pool = build_question_pool(ds, BUCKET_QUOTAS, seed=args.seed)
    total_q = sum(len(v) for v in pool.values())
    print(f"\nQuestion pool ({total_q} questions across {len(pool)} topics):")
    for topic, qs in pool.items():
        print(f"  {topic:20s} {len(qs):3d} questions")

    sessions = make_sessions(pool, args.session_size, seed=args.seed)
    print(f"\nPlanned sessions: {len(sessions)}")
    for i, s in enumerate(sessions):
        print(f"  [{i+1:2d}] {s['topic']:20s} {len(s['questions'])} questions")

    if args.dry_run:
        print("\n--dry-run: stopping before API calls.")
        return

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not set. Check backend/.env")

    from groq import Groq
    client = Groq(api_key=api_key)

    # Build set of already-completed session filenames so we can skip them on resume
    already_done = {p.stem for p in OUTPUT_DIR.glob("hf_*.json")}
    if already_done:
        print(f"\nSkipping {len(already_done)} already-saved sessions: {sorted(already_done)}")

    saved = 0
    skipped = 0
    failed = 0
    topic_counters: dict[str, int] = {}

    for i, session in enumerate(sessions):
        topic = session["topic"]
        idx = topic_counters.get(topic, 0)
        topic_counters[topic] = idx + 1

        video_id = f"hf_{topic}_{idx:03d}"
        if video_id in already_done:
            print(f"\n[{i+1}/{len(sessions)}] {video_id} already exists, skipping.")
            skipped += 1
            continue

        print(f"\n[{i+1}/{len(sessions)}] {topic} session {idx} ({len(session['questions'])} questions)...")

        for attempt in range(3):
            try:
                result = call_groq(client, session)
                turns = result.get("turns", [])

                if not validate_turns(turns):
                    print(f"  Attempt {attempt+1}: invalid turn structure, retrying...")
                    time.sleep(2)
                    continue

                out_path = save_session(result, topic, idx)
                print(f"  Saved: {out_path.name} ({len(turns)} turns)")
                saved += 1
                break
            except json.JSONDecodeError as e:
                print(f"  Attempt {attempt+1}: JSON parse error: {e}, retrying...")
                time.sleep(3)
            except Exception as e:
                print(f"  Attempt {attempt+1}: error: {e}")
                if "rate_limit" in str(e).lower() or "429" in str(e):
                    print("  Rate limited — waiting 30s...")
                    time.sleep(30)
                else:
                    time.sleep(3)
        else:
            print(f"  FAILED after 3 attempts, skipping.")
            failed += 1

        # Polite pacing to stay under Groq rate limits
        time.sleep(2)

    print(f"\nDone. Saved: {saved}, Skipped: {skipped}, Failed: {failed}")
    print(f"Output: {OUTPUT_DIR}")
    print(f"\nNext step: run --enrich on these new files to bake in Alex persona + resume/JD:")
    print(f"  python training/convert_to_chatml.py --enrich --provider groq")


if __name__ == "__main__":
    main()
