"""
One-time LeetCode scraper -> MongoDB `problems` collection.

We only pull EASY and MEDIUM problems (the interview never uses LeetCode "hard"):
    - easy interview   -> 1 easy problem
    - medium interview -> 1 medium problem
    - hard interview   -> 1 easy + 1 medium problem

Run it once to seed the DB. It is idempotent (upserts by slug), so re-running
just refreshes / tops up the collection:

    cd backend
    python scripts/scrape_leetcode.py --per-difficulty 30

If LeetCode answers 403, grab the LEETCODE_SESSION and csrftoken cookies from a
logged-in browser (DevTools -> Application -> Cookies) and add them to backend/.env:
    LEETCODE_SESSION=...
    LEETCODE_CSRF=...

Stored schema (one document per problem):
{
  slug, title, difficulty,             # difficulty is "easy" | "medium"
  question_id, topic_tags: [...],
  content_html,                         # problem statement (raw HTML)
  code_snippets: { langSlug: code },    # starter code per language
  example_testcases, sample_test_case,  # VISIBLE example inputs only (no hidden judge tests)
  meta_data: {...},                     # function name + param/return types (needed by the Judge0 driver)
  hints: [...],
  scraped_at,
}
"""
import argparse
import json
import os
import time
from datetime import datetime, timezone

import certifi
import requests
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne

# Load backend/.env no matter where the script is launched from
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "prepai")
LEETCODE_SESSION = os.getenv("LEETCODE_SESSION", "")
LEETCODE_CSRF = os.getenv("LEETCODE_CSRF", "")

GRAPHQL_URL = "https://leetcode.com/graphql"

# Paginated list of problems for a given difficulty (metadata only).
LIST_QUERY = """
query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(
    categorySlug: $categorySlug
    limit: $limit
    skip: $skip
    filters: $filters
  ) {
    total: totalNum
    questions: data {
      title
      titleSlug
      difficulty
      isPaidOnly
      topicTags { slug }
    }
  }
}
"""

# Full detail for one problem (statement, starter code, example tests, metaData).
DETAIL_QUERY = """
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    title
    titleSlug
    difficulty
    isPaidOnly
    content
    codeSnippets { langSlug code }
    exampleTestcases
    sampleTestCase
    metaData
    hints
    topicTags { slug }
  }
}
"""


def _headers():
    headers = {
        "Content-Type": "application/json",
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://leetcode.com",
        "Origin": "https://leetcode.com",
    }
    if LEETCODE_CSRF:
        headers["x-csrftoken"] = LEETCODE_CSRF
    return headers


def _cookies():
    cookies = {}
    if LEETCODE_SESSION:
        cookies["LEETCODE_SESSION"] = LEETCODE_SESSION
    if LEETCODE_CSRF:
        cookies["csrftoken"] = LEETCODE_CSRF
    return cookies


def gql(query, variables, retries=3):
    """POST a GraphQL query with simple backoff; return the `data` object."""
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(
                GRAPHQL_URL,
                json={"query": query, "variables": variables},
                headers=_headers(),
                cookies=_cookies(),
                timeout=20,
            )
            if resp.status_code == 200:
                payload = resp.json()
                if payload.get("errors"):
                    raise RuntimeError(payload["errors"])
                return payload["data"]
            print(f"    HTTP {resp.status_code} (attempt {attempt}/{retries})")
            if resp.status_code in (403, 401):
                print("    -> looks like LeetCode wants auth; set LEETCODE_SESSION + LEETCODE_CSRF in .env")
        except Exception as exc:
            print(f"    request error: {exc} (attempt {attempt}/{retries})")
        time.sleep(2 * attempt)
    raise RuntimeError("GraphQL request failed after retries")


def list_slugs(difficulty, want, sleep):
    """Return up to `want` free-problem slugs for a difficulty ('EASY' | 'MEDIUM')."""
    slugs = []
    skip = 0
    page = 50
    while len(slugs) < want:
        data = gql(LIST_QUERY, {
            "categorySlug": "",
            "skip": skip,
            "limit": page,
            "filters": {"difficulty": difficulty},
        })
        questions = data["problemsetQuestionList"]["questions"]
        if not questions:
            break  # ran out of problems
        for q in questions:
            if q["isPaidOnly"]:
                continue  # premium problems return no content
            slugs.append(q["titleSlug"])
            if len(slugs) >= want:
                break
        skip += page
        time.sleep(sleep)
    return slugs


def fetch_detail(slug, sleep):
    """Fetch + normalize one problem into our schema. Returns None if unusable."""
    data = gql(DETAIL_QUERY, {"titleSlug": slug})
    time.sleep(sleep)
    q = data.get("question")
    if not q or q.get("isPaidOnly"):
        return None

    code_snippets = {cs["langSlug"]: cs["code"] for cs in (q.get("codeSnippets") or [])}
    try:
        meta = json.loads(q.get("metaData") or "{}")
    except (ValueError, TypeError):
        meta = {}

    return {
        "slug": q["titleSlug"],
        "title": q["title"],
        "difficulty": (q.get("difficulty") or "").lower(),  # "easy" | "medium"
        "question_id": q.get("questionId"),
        "topic_tags": [t["slug"] for t in (q.get("topicTags") or [])],
        "content_html": q.get("content") or "",
        "code_snippets": code_snippets,
        "example_testcases": q.get("exampleTestcases") or "",
        "sample_test_case": q.get("sampleTestCase") or "",
        "meta_data": meta,
        "hints": q.get("hints") or [],
        "scraped_at": datetime.now(timezone.utc),
    }


def main():
    parser = argparse.ArgumentParser(description="Seed MongoDB with EASY + MEDIUM LeetCode problems.")
    parser.add_argument("--per-difficulty", type=int, default=25,
                        help="how many EASY and how many MEDIUM problems to pull (default 25 each)")
    parser.add_argument("--sleep", type=float, default=1.0,
                        help="seconds to wait between LeetCode requests (be polite; default 1.0)")
    args = parser.parse_args()

    client = MongoClient(MONGODB_URI, tlsCAFile=certifi.where())
    problems = client[DB_NAME]["problems"]
    problems.create_index("slug", unique=True)
    problems.create_index("difficulty")

    total_saved = 0
    for difficulty in ("EASY", "MEDIUM"):
        print(f"\n=== {difficulty} ===")
        slugs = list_slugs(difficulty, args.per_difficulty, args.sleep)
        print(f"Found {len(slugs)} free {difficulty} problems")

        ops = []
        for i, slug in enumerate(slugs, 1):
            print(f"  [{i}/{len(slugs)}] {slug}")
            try:
                doc = fetch_detail(slug, args.sleep)
            except Exception as exc:
                print(f"      skipped: {exc}")
                continue
            if doc:
                ops.append(UpdateOne({"slug": doc["slug"]}, {"$set": doc}, upsert=True))

        if ops:
            result = problems.bulk_write(ops)
            saved = result.upserted_count + result.modified_count
            total_saved += saved
            print(f"  wrote {saved} {difficulty} problems")

    print(f"\nDone. {total_saved} problems written this run.")
    print(f"Total in {DB_NAME}.problems: {problems.count_documents({})}")
    client.close()


if __name__ == "__main__":
    main()
