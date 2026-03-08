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


class FeedbackResponse(BaseModel):
    feedback: str
