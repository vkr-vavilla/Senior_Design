from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime


class ChatMessage(BaseModel):
    role: str  # "user" or "model"
    text: str


class ChatSession(BaseModel):
    user_id: str
    messages: List[ChatMessage]
    created_at: datetime
    ended_at: Optional[datetime] = None


class SkillRatings(BaseModel):
    """SWE-focused rating axes. Feedback stored before this set existed has
    clarity/depth/structure/examples/confidence/conciseness instead — the
    frontend renders whichever keys are present."""
    correctness: int
    depth: int
    clarity: int
    examples: int
    resume_knowledge: int


class FeedbackJudgment(BaseModel):
    """Schema the judge model is forced to emit (Gemini response_schema / vLLM
    guided JSON). report_markdown comes FIRST so the numeric scores are generated
    after — and therefore conditioned on — the full written analysis."""
    report_markdown: str
    overall_score: int
    skill_ratings: SkillRatings


class FeedbackResponse(BaseModel):
    feedback: str
    # Structured scores + objective computed stats. None for feedback generated
    # before this existed — the frontend falls back to parsing the markdown.
    metrics: Optional[dict] = None
