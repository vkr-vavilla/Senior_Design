"""
End-to-end Phase 2 smoke test: grade a real seeded problem through live Judge0.

Run INSIDE the backend container (so httpx, JUDGE0_URL and the DB are available),
after the scraper has seeded `two-sum` and Judge0 is up:

    docker compose exec backend python -m coding._judge0_smoketest

Expect: "passed: 3 / 3" with status Accepted.
"""
import asyncio
import os

import certifi
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from coding.grading import grade_submission  # noqa: E402

# A correct Two Sum solution to grade against the real scraped problem.
TWO_SUM_SOLUTION = (
    "class Solution:\n"
    "    def twoSum(self, nums, target):\n"
    "        seen = {}\n"
    "        for i, x in enumerate(nums):\n"
    "            if target - x in seen:\n"
    "                return [seen[target - x], i]\n"
    "            seen[x] = i\n"
)


def main():
    uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    db_name = os.getenv("DB_NAME", "prepai")
    problems = MongoClient(uri, tlsCAFile=certifi.where())[db_name]["problems"]

    problem = problems.find_one({"slug": "two-sum"})
    if not problem:
        print("two-sum not found in DB — run scripts/scrape_leetcode.py first.")
        return

    result = asyncio.run(grade_submission(problem, TWO_SUM_SOLUTION))
    print(f"status: {result['status']}")
    print(f"passed: {result['passed']} / {result['total']}")
    for case in result["cases"]:
        mark = "ok" if case["passed"] else "XX"
        print(f"  [{mark}] expected={case['expected']!r} actual={case['actual']!r}")
    if result["stderr"]:
        print("stderr:", result["stderr"])


if __name__ == "__main__":
    main()
