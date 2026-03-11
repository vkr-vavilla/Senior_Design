from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException
from jose import JWTError, jwt
from google import genai
from datetime import datetime, timezone
from database import get_db
from config import GEMINI_API_KEY, JWT_SECRET, JWT_ALGORITHM
from models.chat import ChatMessage, FeedbackResponse
from bson import ObjectId
import json
import asyncio

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
    print("DEBUG: WebSocket accepted")

    history = []

    try:
        print("DEBUG: Creating Gemini chat session")
        chat_session = gemini_client.chats.create(model="gemini-2.5-flash", history=[])
        print("DEBUG: Chat session created")

        while True:
            print("DEBUG: Waiting for message...")
            data = await websocket.receive_text()
            print(f"DEBUG: Received data: {data[:100]}")
            message = json.loads(data).get("message", "")
            if not message:
                continue

            history.append({"role": "user", "text": message})

            # Run the sync Gemini streaming in a thread so it doesn't block the event loop
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def stream_sync():
                try:
                    print("DEBUG: Starting Gemini stream")
                    for chunk in chat_session.send_message_stream(message):
                        print(f"DEBUG chunk type: {type(chunk)}")
                        print(f"DEBUG chunk.text: {repr(chunk.text)}")
                        if chunk.text:
                            loop.call_soon_threadsafe(queue.put_nowait, chunk.text)
                    print("DEBUG: Gemini stream complete")
                except Exception as e:
                    print(f"DEBUG: Gemini stream error: {e}")
                    loop.call_soon_threadsafe(queue.put_nowait, f"__ERROR__:{e}")
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, None)

            loop.run_in_executor(None, stream_sync)

            full_reply = ""
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, str) and item.startswith("__ERROR__:"):
                    print(f"Gemini error: {item}")
                    break
                full_reply += item
                await websocket.send_text(json.dumps({"chunk": item, "done": False}))

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

    response = await asyncio.to_thread(
        gemini_client.models.generate_content,
        model="gemini-2.5-flash",
        contents=prompt
    )

    return FeedbackResponse(feedback=response.text)
