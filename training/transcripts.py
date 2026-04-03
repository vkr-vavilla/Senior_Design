from pathlib import Path
import json
import re
from html import unescape
from youtube_transcript_api import YouTubeTranscriptApi
import yt_dlp

raw_dir = Path("../data/raw")
raw_dir.mkdir(parents=True, exist_ok=True)

YOUTUBE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")


def clean_caption_text(text):
    """Clean text from captions"""
    text = unescape(text)
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def json3_to_text(json3_file):
    """Convert yt-dlp JSON3 subtitle file to plain text"""
    with open(json3_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    events = data.get("events", [])
    lines = []

    for event in events:
        segs = event.get("segs")
        if not segs:
            continue

        line = "".join(seg.get("utf8", "") for seg in segs)
        line = clean_caption_text(line)
        if line:
            lines.append(line)

    # Group subtitle fragments into readable turns
    turns = []
    current_turn = ""

    for line in lines:
        if line.startswith(">>"):
            if current_turn:
                turns.append(current_turn.strip())
            current_turn = line
        else:
            if current_turn:
                current_turn = f"{current_turn} {line}".strip()
            else:
                current_turn = line

    if current_turn:
        turns.append(current_turn.strip())

    # Remove immediate duplicates
    deduped_turns = []
    for turn in turns:
        if not deduped_turns or deduped_turns[-1] != turn:
            deduped_turns.append(turn)

    transcript_text = "\n".join(deduped_turns).strip()
    return transcript_text


def process_video(video_id):
    """Process a single video: try manual transcript first, fall back to auto-captions"""
    video_id = video_id.strip()
    if not YOUTUBE_ID_PATTERN.match(video_id):
        print(f"Invalid YouTube video ID: {video_id}")
        return

    video_url = f"https://www.youtube.com/watch?v={video_id}"
    output_file = raw_dir / f"{video_id}.txt"

    # Skip if already processed
    if output_file.exists():
        print(f"Already processed: {video_id}")
        return

    # Step 1: Try youtube-transcript-api (manual transcripts if available)
    try:
        transcript = YouTubeTranscriptApi.get_transcript(video_id)
        transcript_text = " ".join([entry["text"] for entry in transcript])
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(transcript_text)
        print(f"✓ {video_id}: Manual transcript saved")
        return
    except Exception as e:
        print(f"  {video_id}: No manual transcript ({type(e).__name__}), trying auto-captions...")

    # Step 2: Fall back to yt-dlp auto-captions (JSON3 format)
    try:
        ydl_opts = {
            'skip_download': True,
            'writeautomaticsub': True,
            'writesubtitles': True,
            'subtitleslangs': ['en'],
            'subtitlesformat': 'json3',
            'outtmpl': str(raw_dir / f"{video_id}"),
            'quiet': True,
            'no_warnings': True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])

        # Find the JSON3 file that was downloaded
        subtitle_files = sorted(raw_dir.glob(f"{video_id}*.json3"))
        if not subtitle_files:
            print(f"✗ {video_id}: Subtitles downloaded but no JSON3 file found")
            return

        # Convert JSON3 to text
        transcript_text = json3_to_text(subtitle_files[0])
        if not transcript_text:
            print(f"✗ {video_id}: JSON3 file was empty")
            return

        with open(output_file, "w", encoding="utf-8") as f:
            f.write(transcript_text)

        print(f"✓ {video_id}: Auto-captions saved")

    except Exception as e:
        print(f"✗ {video_id}: Failed - {e}")


if __name__ == "__main__":
    video_ids = [
        "sa41eWwM7iI",
        "c3TE7h9gA4g",
        "GxCD7Q_qDpU",
        "_K-eupuDVEc",
        "NHqdG-aZxOk",
        "Zvr-ffhvw0Y",
        "3yW856jAbZA",
        "4_qu1F9BXow",
        "hqa2sfoGRlI",
        "ICu8g9auh8E",
        "efaBYHvNvbA",
        "a5rABvMQ53U",
        "VvZf7lISfgs",
        "39eAITqeu7g",
        "1xV5WI0OFkg",
        "KYExYE_9nIY",
        "NtMvNh0WFVM",
        "Z-0g_aJL5Fw",
        "nSdR-Xa6u1Y",
        "WfgOJay48Ms",
        "kLBrHG4HIA0",
        "5lHerlOo5N8",
        "Rt1jS3MnVFg",
        "g-FwmMoEFXw",
        "rxSaAn_G1II",
        "UWyUGFcbynE",
        "sOL64q1E9Bk",
        "lyGosx9OuJQ",
        "vX9w2acQWGs",
        "ulXErb8Fxu0",
        "2y7ncwfyfMU",
        "R_KXuSVE3U4",
        "AN8pXy23HBA",
        "JmEPycPMUyk",
        "ts0KUrz5it8",
        "_ERkaO72yJM",
        "rdphm7NB2MY",
        "cUQpQiX5jcE",
        "NmWvXZmJfVc",
        "6ncshuA-jqo",
        "-5XD9OH4w-4",
        "KM4J5XuXUzE",
        "yJBXunVOWC4",
        "CJVpg4enHPA",
        "wL-Gx5XE9XE",
    ]

    for video_id in video_ids:
        process_video(video_id)

    print(f"\n✓ Done! Transcripts saved to {raw_dir}/")
