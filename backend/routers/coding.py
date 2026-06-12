"""
Coding-round endpoints.

  GET  /coding/problems/{problem_id}  -> problem to display (statement + starter code)
  POST /coding/run                    -> grade code against example tests (no persist)
  POST /coding/submit                 -> grade + persist the attempt on the interview

Grading runs through coding.grading.grade_submission, which wraps the user's code
with the driver and executes it in the Piston sandbox.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth.jwt import get_current_user
from bson import ObjectId
from config import PROBLEMS_COLLECTION
from database import get_db
from coding.grading import grade_submission
from coding.normalize import normalize_problem
from coding.selection import ids_filter, select_problems_for_session

router = APIRouter(prefix="/coding", tags=["coding"])

# Supported languages -> numeric language id. Python only for now.
LANGUAGE_IDS = {"python3": 71}


class RunRequest(BaseModel):
    problem_id: str
    language: str = "python3"
    code: str


class SubmitRequest(RunRequest):
    session_id: str


def _oid(value: str, label: str) -> ObjectId:
    try:
        return ObjectId(value)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid {label} id")


async def _load_problem(problem_id: str) -> dict:
    db = get_db()
    # Problems are keyed by integer LeetCode number in the `leetcode` collection,
    # so match by id type rather than forcing an ObjectId (which 400'd on "1850").
    problem = await db[PROBLEMS_COLLECTION].find_one(ids_filter(problem_id))
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")
    return normalize_problem(problem)


def _language_id(language: str) -> int:
    lang_id = LANGUAGE_IDS.get(language)
    if lang_id is None:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")
    return lang_id


def _problem_public(problem: dict) -> dict:
    """Shape a problem doc for the client (statement + starter code, no internals)."""
    return {
        "id": str(problem["_id"]),
        "slug": problem.get("slug"),
        "title": problem.get("title"),
        "difficulty": problem.get("difficulty"),
        "topic_tags": problem.get("topic_tags", []),
        "content_html": problem.get("content_html", ""),
        "code_snippets": problem.get("code_snippets", {}),
        "hints": problem.get("hints", []),
    }


@router.get("/problems/{problem_id}")
async def get_problem(problem_id: str, user_id: str = Depends(get_current_user)):
    """Return a problem's statement + starter code for the coding page."""
    problem = await _load_problem(problem_id)
    return _problem_public(problem)


@router.get("/sessions/{session_id}/problems")
async def get_session_problems(session_id: str, user_id: str = Depends(get_current_user)):
    """Select (or return the already-assigned) coding problems for an interview."""
    db = get_db()
    session = await db.interviews.find_one(
        {"_id": _oid(session_id, "session"), "user_id": user_id}
    )
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")
    problems = await select_problems_for_session(db, session)
    return [_problem_public(p) for p in problems]


@router.post("/run")
async def run_code(body: RunRequest, user_id: str = Depends(get_current_user)):
    """Grade code against the visible example tests. Nothing is persisted."""
    lang_id = _language_id(body.language)
    problem = await _load_problem(body.problem_id)
    try:
        return await grade_submission(problem, body.code, lang_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Code execution service error: {exc}")


@router.post("/submit")
async def submit_code(body: SubmitRequest, user_id: str = Depends(get_current_user)):
    """Grade code and record the attempt on the interview session (for feedback)."""
    db = get_db()
    lang_id = _language_id(body.language)
    problem = await _load_problem(body.problem_id)

    session_oid = _oid(body.session_id, "session")
    session = await db.interviews.find_one({"_id": session_oid, "user_id": user_id})
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")

    try:
        result = await grade_submission(problem, body.code, lang_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Code execution service error: {exc}")

    attempt = {
        "problem_id": str(problem["_id"]),
        "slug": problem.get("slug"),
        "title": problem.get("title"),
        "difficulty": problem.get("difficulty"),
        "language": body.language,
        "code": body.code,
        "passed": result["passed"],
        "total": result["total"],
        "all_passed": result["all_passed"],
        "submitted_at": datetime.now(timezone.utc),
    }
    await db.interviews.update_one(
        {"_id": session_oid, "user_id": user_id},
        {"$push": {"coding_attempts": attempt}},
    )
    return result
