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

DIFFICULTY_PLAN = {
    "easy": ["easy"],
    "medium": ["medium"],
    "hard": ["easy", "medium"],
}

CODING_INTERVIEW_TYPES = {"technical", "mixed"}


def _gradeable_match(difficulty: str) -> dict:
    # Only function-style problems with a Python starter + parsed metadata are runnable.
    return {
        "difficulty": difficulty,
        "code_snippets.python3": {"$exists": True, "$ne": ""},
        "meta_data.name": {"$exists": True, "$ne": ""},
    }


async def _sample_problem(db, difficulty: str, exclude_ids: list):
    """Randomly pick one gradeable problem of a difficulty, avoiding exclude_ids."""
    match = _gradeable_match(difficulty)
    if exclude_ids:
        match["_id"] = {"$nin": exclude_ids}
    docs = await db.problems.aggregate(
        [{"$match": match}, {"$sample": {"size": 1}}]
    ).to_list(1)
    return docs[0] if docs else None


def _valid_oids(ids) -> list:
    out = []
    for value in ids or []:
        try:
            out.append(ObjectId(value))
        except Exception:
            continue
    return out


async def select_problems_for_session(db, session: dict) -> list:
    """Return the coding problems for a session (selecting + persisting if needed)."""
    interview_type = (session.get("interview_type") or "").lower()
    if interview_type not in CODING_INTERVIEW_TYPES:
        return []

    # Reuse a previous selection so reloads stay stable.
    existing = _valid_oids(session.get("coding_problem_ids"))
    if existing:
        docs = await db.problems.find({"_id": {"$in": existing}}).to_list(len(existing))
        by_id = {d["_id"]: d for d in docs}
        ordered = [by_id[oid] for oid in existing if oid in by_id]
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
