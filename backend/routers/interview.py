from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException
from pydantic import BaseModel
from auth.jwt import get_current_user
from database import get_db
from bson import ObjectId, Binary
from datetime import datetime, timezone
import pdfplumber
import io

router = APIRouter(prefix="/interview", tags=["interview"])


class StartInterviewRequest(BaseModel):
    role: str
    interviewType: str = "behavioral"
    difficulty: str = "medium"


@router.post("/start")
async def start_interview(
    body: StartInterviewRequest,
    user_id: str = Depends(get_current_user),
):
    """Create a lightweight interview session without a resume (used for quick-start / behavioral interviews)."""
    db = get_db()
    doc = {
        "user_id": user_id,
        "role": body.role,
        "interview_type": body.interviewType,
        "difficulty": body.difficulty,
        "resume_pdf": None,
        "resume_filename": None,
        "resume_text": "",
        "job_description": "",
        "messages": [],
        "user_answers": [],
        "qa_pairs": [],
        "feedback": None,
        "created_at": datetime.now(timezone.utc),
    }
    result = await db.interviews.insert_one(doc)
    return {"interview_id": str(result.inserted_id)}


@router.post("/create")
async def create_interview(
    resume: UploadFile = File(...),
    job_description: str = Form(...),
    role: str = Form(...),
    interview_type: str = Form("technical"),
    difficulty: str = Form("medium"),
    user_id: str = Depends(get_current_user),
):
    """
    Create a new interview session.
    - Saves the raw resume PDF as binary in MongoDB
    - Extracts text from the PDF for Gemini context
    - Saves the job description
    - Returns the interview_id for the WebSocket chat
    """
    db = get_db()

    # Read the raw PDF bytes
    pdf_bytes = await resume.read()

    # Extract text from PDF for Gemini context
    resume_text = ""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    resume_text += page_text + "\n"
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {str(e)}")

    if not resume_text.strip():
        raise HTTPException(status_code=400, detail="Could not extract text from the resume PDF")

    # Save everything to MongoDB
    interview_doc = {
        "user_id": user_id,
        "resume_pdf": Binary(pdf_bytes),          # original PDF stored as-is
        "resume_filename": resume.filename,
        "resume_text": resume_text.strip(),        # extracted text for Gemini
        "job_description": job_description,
        "role": role,
        "interview_type": interview_type,
        "difficulty": difficulty,
        "messages": [],                            # chat messages will be added later
        "feedback": None,
        "created_at": datetime.now(timezone.utc),
    }

    result = await db.interviews.insert_one(interview_doc)
    interview_id = str(result.inserted_id)

    return {
        "interview_id": interview_id,
        "resume_filename": resume.filename,
        "resume_text_preview": resume_text[:200] + "..." if len(resume_text) > 200 else resume_text,
    }


@router.get("/sessions")
async def get_sessions(user_id: str = Depends(get_current_user)):
    """Get all interview sessions for the current user (without the PDF binary to keep response small)."""
    db = get_db()

    sessions = await db.interviews.find(
        {"user_id": user_id},
        {
            "resume_pdf": 0,       # exclude the binary PDF from list response
            "resume_text": 0,      # exclude full text too (long)
        }
    ).sort("created_at", -1).to_list(50)

    # Convert ObjectId to string
    for s in sessions:
        s["_id"] = str(s["_id"])

    return sessions


@router.get("/{interview_id}")
async def get_interview(interview_id: str, user_id: str = Depends(get_current_user)):
    """Get a single interview session (without PDF binary)."""
    db = get_db()

    session = await db.interviews.find_one(
        {"_id": ObjectId(interview_id), "user_id": user_id},
        {"resume_pdf": 0}
    )

    if not session:
        raise HTTPException(status_code=404, detail="Interview not found")

    session["_id"] = str(session["_id"])
    return session


@router.get("/{interview_id}/resume")
async def download_resume(interview_id: str, user_id: str = Depends(get_current_user)):
    """Download the original resume PDF."""
    db = get_db()

    session = await db.interviews.find_one(
        {"_id": ObjectId(interview_id), "user_id": user_id},
        {"resume_pdf": 1, "resume_filename": 1}
    )

    if not session or "resume_pdf" not in session:
        raise HTTPException(status_code=404, detail="Resume not found")

    from fastapi.responses import Response
    return Response(
        content=bytes(session["resume_pdf"]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{session.get("resume_filename", "resume.pdf")}"'
        }
    )
