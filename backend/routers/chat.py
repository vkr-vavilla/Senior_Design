from fastapi import APIRouter, Depends, HTTPException
from google import genai
from google.genai import types
from config import GEMINI_API_KEY
from auth.jwt import get_current_user
from models.chat import ChatRequest, ChatResponse

router = APIRouter(prefix="/chat", tags=["chat"])

client = genai.Client(api_key=GEMINI_API_KEY)


@router.post("/", response_model=ChatResponse)
async def chat(request: ChatRequest, user_id: str = Depends(get_current_user)):
    history = [
        types.Content(
            role=msg.role,
            parts=[types.Part(text=msg.text)]
        )
        for msg in request.history
    ]

    chat_session = client.chats.create(model="gemini-2.5-flash", history=history)

    try:
        response = chat_session.send_message(request.message)
        return ChatResponse(reply=response.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
