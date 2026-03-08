from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException
from jose import JWTError, jwt
from google import genai
from datetime import datetime, timezone
from database import get_db
from config import GEMINI_API_KEY, JWT_SECRET, JWT_ALGORITHM
from models.chat import ChatMessage, FeedbackResponse
from bson import ObjectId
import json

router = APIRouter(prefix="/chat", tags=["chat"])

gemini_client = genai.Client(api_key=GEMINI_API_KEY)


def verify_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise ValueError("No user id in token")
        return user_id
    except JWTError:
        raise ValueError("Invalid token")


@router.websocket("/ws")
async def chat_ws(websocket: WebSocket, token: str):
    # Validate JWT before accepting connection
    try:
        user_id = verify_token(token)
    except ValueError:
        await websocket.close(code=4001)
        return

    await websocket.accept()

    history = []
    chat_session = gemini_client.chats.create(model="gemini-2.5-flash", history=[])

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data).get("message", "")
            if not message:
                continue

            history.append({"role": "user", "text": message})

            # Stream response token by token
            full_reply = ""
            for chunk in chat_session.send_message_stream(message):
                if chunk.text:
                    full_reply += chunk.text
                    await websocket.send_text(json.dumps({"chunk": chunk.text, "done": False}))

            history.append({"role": "model", "text": full_reply})
            await websocket.send_text(json.dumps({"chunk": "", "done": True}))

    except WebSocketDisconnect:
        # Save session to MongoDB on disconnect
        db = get_db()
        if history:
            await db.chat_sessions.insert_one({
                "user_id": user_id,
                "messages": history,
                "created_at": datetime.now(timezone.utc),
            })


@router.post("/{session_id}/feedback", response_model=FeedbackResponse)
async def get_feedback(session_id: str):
    db = get_db()
    session = await db.chat_sessions.find_one({"_id": ObjectId(session_id)})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    transcript = "\n".join(
        f"{msg['role'].upper()}: {msg['text']}" for msg in session["messages"]
    )

    prompt = f"""You are an expert interview coach. Based on the following mock interview transcript,
provide detailed feedback on the candidate's performance. Cover: strengths, areas for improvement,
communication clarity, and an overall score out of 10.

TRANSCRIPT:
{transcript}"""

    response = gemini_client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt
    )

    return FeedbackResponse(feedback=response.text)
