from pydantic import BaseModel
from typing import List


class ChatMessage(BaseModel):
    role: str  # "user" or "model"
    text: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = []


class ChatResponse(BaseModel):
    reply: str
