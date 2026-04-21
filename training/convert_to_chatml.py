import json
import os
import glob

# Paths
INPUT_DIR = "/home/saad/FinalRound/Senior_Design/data/processed/structured/"
OUTPUT_FILE = "/home/saad/FinalRound/Senior_Design/data/processed/chatml_training_data.jsonl"

# The System Prompt to ground the model's persona
SYSTEM_PROMPT = (
    "You are an expert Senior Software Engineer at a top-tier tech company conducting a technical interview. "
    "Your objective is to assess the candidate's technical depth, problem-solving skills, and real-world experience. "
    "Keep probing with follow-up questions to fully gauge the candidate's depth on the current topic. "
    "When a topic has been sufficiently explored, transition naturally to a new topic and continue probing. "
    "Acknowledge the candidate's responses naturally before asking your next question. "
    "Continue the interview until the candidate or the session concludes. "
    "Keep your tone conversational, professional, and human. Do not break character."
)

def process_data():
    files = sorted(glob.glob(os.path.join(INPUT_DIR, "*.json")))
    print(f"Found {len(files)} JSON files in {INPUT_DIR}")

    chatml_data = []
    total_examples = 0
    skipped_files = 0

    for file_path in files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            turns = data.get("turns", [])
            if not turns:
                print(f"  SKIP (no turns): {os.path.basename(file_path)}")
                skipped_files += 1
                continue

            # Filter to only INTERVIEWER and EMPLOYEE turns
            clean_turns = [t for t in turns if t.get("speaker") in ("INTERVIEWER", "EMPLOYEE")]

            # Build full-conversation chatml examples.
            # Each example is one complete interview conversation as a message list.
            # Format: system, then alternating assistant (INTERVIEWER) / user (EMPLOYEE).
            # We emit one example per file (the full conversation).
            messages = [{"role": "system", "content": SYSTEM_PROMPT}]

            for turn in clean_turns:
                speaker = turn.get("speaker")
                text = turn.get("text", "").strip()
                if not text:
                    continue
                if speaker == "INTERVIEWER":
                    messages.append({"role": "assistant", "content": text})
                elif speaker == "EMPLOYEE":
                    messages.append({"role": "user", "content": text})

            # Need at least one assistant+user exchange
            non_system = [m for m in messages if m["role"] != "system"]
            if len(non_system) < 2:
                print(f"  SKIP (too few turns): {os.path.basename(file_path)}")
                skipped_files += 1
                continue

            # Ensure conversation starts with assistant (INTERVIEWER asks first)
            if non_system[0]["role"] != "assistant":
                print(f"  SKIP (doesn't start with INTERVIEWER): {os.path.basename(file_path)}")
                skipped_files += 1
                continue

            chatml_data.append({"messages": messages})
            total_examples += 1

        except Exception as e:
            print(f"  ERROR processing {os.path.basename(file_path)}: {e}")
            skipped_files += 1

    # Write to target JSONL file
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as out_f:
        for item in chatml_data:
            out_f.write(json.dumps(item, ensure_ascii=False) + '\n')

    print("\n=== CONVERSION COMPLETE ===")
    print(f"Converted {total_examples} conversations into ChatML format.")
    print(f"Skipped {skipped_files} files.")
    print(f"Output saved to: {OUTPUT_FILE}")

    if chatml_data:
        sample = chatml_data[0]
        sample_msgs = sample["messages"]
        print(f"\n--- SAMPLE (first file, {len(sample_msgs)-1} turns) ---")
        for m in sample_msgs[:5]:
            preview = m["content"][:120].replace('\n', ' ')
            print(f"  [{m['role']}] {preview}...")

if __name__ == "__main__":
    process_data()
