"""
Pick the coding problem(s) for an interview session, per the difficulty rule:

    easy interview   -> 1 easy problem
    medium interview -> 1 medium problem
    hard interview   -> 1 easy + 1 medium problem   (never LeetCode "hard")

Only technical / mixed interviews get a coding round. The chosen problem ids are
persisted on the interview doc (`coding_problem_ids`) so the selection is stable
across page reloads.
"""
from bson import ObjectId

from config import PROBLEMS_COLLECTION
from coding.normalize import normalize_problem

DIFFICULTY_PLAN = {
    "easy": ["easy"],
    "medium": ["medium"],
    "hard": ["easy", "medium"],
}

CODING_INTERVIEW_TYPES = {"technical", "mixed"}

# Problems the Python function driver can't run:
#  - linked-list / tree: need ListNode/TreeNode typing the stored docs don't carry
#  - database / shell / concurrency: SQL / Bash / threading problems, not Python functions
_UNSUPPORTED_TAGS = [
    "linked-list", "doubly-linked-list",
    "tree", "binary-tree", "binary-search-tree", "n-ary-tree",
    "database", "shell", "concurrency",
]


def _gradeable_match(difficulty: str) -> dict:
    # Stored docs use capitalized difficulty ("Easy"/"Medium"); match case-insensitively.
    # A problem is gradeable if it has examples we can derive a signature + tests from
    # (leetcode collection) OR already carries a python starter (scraped docs).
    return {
        "difficulty": {"$regex": f"^{difficulty}$", "$options": "i"},
        "tags": {"$nin": _UNSUPPORTED_TAGS},
        # Premium problems (🔒) have inconsistent/missing example data; skip them.
        "title": {"$not": {"$regex": "🔒"}},
        "$or": [
            {"examples.0": {"$exists": True}},
            {"code_snippets.python3": {"$exists": True, "$ne": ""}},
        ],
    }


async def _sample_problem(db, difficulty: str, exclude_ids: list):
    """Randomly pick one gradeable problem of a difficulty, avoiding exclude_ids."""
    match = _gradeable_match(difficulty)
    if exclude_ids:
        match["_id"] = {"$nin": exclude_ids}
    docs = await db[PROBLEMS_COLLECTION].aggregate(
        [{"$match": match}, {"$sample": {"size": 1}}]
    ).to_list(1)
    return normalize_problem(docs[0]) if docs else None


def ids_filter(values) -> dict:
    """Build `{"_id": {"$in": [...]}}` matching a problem id however the collection
    keys it. The `leetcode` collection keys by INTEGER LeetCode number, but ids
    travel as strings (JSON / persisted on the interview doc); also tolerate
    ObjectId-keyed collections. So for "1850" we match both 1850 and "1850"."""
    candidates = []
    for v in (values if isinstance(values, (list, tuple)) else [values]):
        candidates.append(v)
        if isinstance(v, str):
            if v.lstrip("-").isdigit():
                candidates.append(int(v))
            try:
                candidates.append(ObjectId(v))
            except Exception:
                pass
    return {"_id": {"$in": candidates}}


async def select_problems_for_session(db, session: dict) -> list:
    """Return the coding problems for a session (selecting + persisting if needed)."""
    interview_type = (session.get("interview_type") or "").lower()
    if interview_type not in CODING_INTERVIEW_TYPES:
        return []

    # Reuse a previous selection so reloads stay stable.
    existing = session.get("coding_problem_ids") or []
    if existing:
        docs = await db[PROBLEMS_COLLECTION].find(ids_filter(existing)).to_list(len(existing))
        by_id = {str(d["_id"]): d for d in docs}
        ordered = [normalize_problem(by_id[str(v)]) for v in existing if str(v) in by_id]
        if ordered:
            return ordered

    # Fresh selection following the difficulty plan.
    difficulty = (session.get("difficulty") or "medium").lower()
    plan = DIFFICULTY_PLAN.get(difficulty, ["medium"])

    chosen, chosen_ids = [], []
    for diff in plan:
        doc = await _sample_problem(db, diff, chosen_ids)
        if doc:
            chosen.append(doc)
            chosen_ids.append(doc["_id"])

    if chosen_ids:
        await db.interviews.update_one(
            {"_id": session["_id"]},
            {"$set": {"coding_problem_ids": [str(oid) for oid in chosen_ids]}},
        )
    return chosen
