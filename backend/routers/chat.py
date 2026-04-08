from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException
from jose import JWTError, jwt
from google import genai
from openai import OpenAI
from datetime import datetime, timezone
from database import get_db
from config import GEMINI_API_KEY, VLLM_BASE_URL, VLLM_MODEL, AI_BACKEND, JWT_SECRET, JWT_ALGORITHM
from models.chat import ChatMessage, FeedbackResponse
from bson import ObjectId
import json
import asyncio

router = APIRouter(prefix="/chat", tags=["chat"])

gemini_client = genai.Client(api_key=GEMINI_API_KEY)
qwen_client = OpenAI(base_url=VLLM_BASE_URL, api_key="token-abc123")


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
async def chat_ws(websocket: WebSocket, token: str, interview_id: str = "", client_session_id: str = ""):
    # Validate JWT before accepting connection
    try:
        user_id = verify_token(token)
    except ValueError:
        await websocket.close(code=4001)
        return

    await websocket.accept()
    print("DEBUG: WebSocket accepted")

    history = []
    db = get_db()
    interview_context = ""

    # If an interview_id was provided, fetch the resume + job description
    if interview_id:
        try:
            interview = await db.interviews.find_one(
                {"_id": ObjectId(interview_id), "user_id": user_id},
                {"resume_text": 1, "job_description": 1, "role": 1, "interview_type": 1, "difficulty": 1}
            )
            if interview:
                resume_text = interview.get("resume_text", "")
                job_desc = interview.get("job_description", "")
                role = interview.get("role", "Software Engineer")
                int_type = interview.get("interview_type", "technical")
                difficulty = interview.get("difficulty", "medium")

                interview_context = f"""You are an expert interviewer conducting a {difficulty} {int_type} interview for a {role} position.

CANDIDATE'S RESUME:
{resume_text}

JOB DESCRIPTION:
{job_desc}

INSTRUCTIONS:
- Ask questions that are relevant to BOTH the candidate's resume AND the job description.
- For technical interviews: ask about technologies and projects mentioned in the resume, system design, and coding concepts relevant to the job.
- For behavioral interviews: ask about specific experiences from their resume using the STAR method.
- For mixed interviews: alternate between technical and behavioral questions.
- Start by greeting the candidate and asking your first question.
- Ask one question at a time, wait for the answer, then follow up or move to the next question.
- Be conversational but professional, like a real senior engineer interviewer.
- Push back on vague answers and ask for specifics.
"""
                print(f"DEBUG: Loaded interview context for {interview_id}")
        except Exception as e:
            print(f"DEBUG: Could not load interview context: {e}")

    try:
        # --- Gemini setup ---
        gemini_history = []
        if AI_BACKEND == "gemini":
            print("DEBUG: Creating Gemini chat session")
            if interview_context:
                gemini_history = [
                    {"role": "user", "parts": [{"text": interview_context}]},
                    {"role": "model", "parts": [{"text": "Understood. I will conduct this interview based on the candidate's resume and the job description provided. I'm ready to begin when the candidate is."}]},
                ]
            chat_session = gemini_client.chats.create(model="gemini-2.5-flash", history=gemini_history)
            print("DEBUG: Chat session created")

        # --- Qwen/vLLM setup ---
        qwen_messages = []
        if AI_BACKEND == "qwen":
            print("DEBUG: Starting Qwen/vLLM chat session")
            if interview_context:
                qwen_messages.append({"role": "system", "content": interview_context})

        while True:
            print("DEBUG: Waiting for message...")
            data = await websocket.receive_text()
            print(f"DEBUG: Received data: {data[:100]}")
            message = json.loads(data).get("message", "")
            if not message:
                continue

            history.append({"role": "user", "text": message})

            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            if AI_BACKEND == "gemini":
                def stream_sync():
                    try:
                        print("DEBUG: Starting Gemini stream")
                        for chunk in chat_session.send_message_stream(message):
                            if chunk.text:
                                loop.call_soon_threadsafe(queue.put_nowait, chunk.text)
                        print("DEBUG: Gemini stream complete")
                    except Exception as e:
                        print(f"DEBUG: Gemini stream error: {e}")
                        loop.call_soon_threadsafe(queue.put_nowait, f"__ERROR__:{e}")
                    finally:
                        loop.call_soon_threadsafe(queue.put_nowait, None)
            else:
                qwen_messages.append({"role": "user", "content": message})
                def stream_sync(msgs=list(qwen_messages)):
                    try:
                        print("DEBUG: Starting Qwen stream")
                        stream = qwen_client.chat.completions.create(
                            model=VLLM_MODEL,
                            messages=msgs,
                            stream=True,
                        )
                        for chunk in stream:
                            text = chunk.choices[0].delta.content
                            if text:
                                loop.call_soon_threadsafe(queue.put_nowait, text)
                        print("DEBUG: Qwen stream complete")
                    except Exception as e:
                        print(f"DEBUG: Qwen stream error: {e}")
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
                    await websocket.send_text(json.dumps({"chunk": f"AI Error: {item}", "done": False}))

                    break
                full_reply += item
                await websocket.send_text(json.dumps({"chunk": item, "done": False}))

            history.append({"role": "model", "text": full_reply})
            if AI_BACKEND == "qwen":
                qwen_messages.append({"role": "assistant", "content": full_reply})
            await websocket.send_text(json.dumps({"chunk": "", "done": True}))

    except WebSocketDisconnect:
        # Save messages on disconnect
        if history:
            if interview_id:
                # Update the existing interview document with chat messages
                await db.interviews.update_one(
                    {"_id": ObjectId(interview_id)},
                    {"$set": {"messages": history}}
                )
            else:
                # Fallback: save as a standalone chat session using client_session_id
                _id = client_session_id if client_session_id else str(ObjectId())
                await db.chat_sessions.insert_one({
                    "_id": _id,
                    "user_id": user_id,
                    "messages": history,
                    "created_at": datetime.now(timezone.utc),
                })


@router.post("/{session_id}/feedback", response_model=FeedbackResponse)
async def get_feedback(session_id: str):
    db = get_db()
    session = None

    # Try the interviews collection first (new flow)
    try:
        session = await db.interviews.find_one(
            {"_id": ObjectId(session_id)},
            {"resume_pdf": 0}  # exclude binary
        )
    except Exception:
        pass

    # Fallback to legacy chat_sessions collection using string id or object id
    if not session:
        session = await db.chat_sessions.find_one({"_id": session_id})
        if not session:
            try:
                session = await db.chat_sessions.find_one({"_id": ObjectId(session_id)})
            except Exception:
                pass

    if not session or not session.get("messages"):
        raise HTTPException(status_code=404, detail="Session not found or has no messages")

    transcript = "\n".join(
        f"{msg['role'].upper()}: {msg['text']}" for msg in session["messages"]
    )

    # Build a richer prompt with context if available
    context_info = ""
    if session.get("role"):
        context_info += f"\nRole: {session['role']}"
    if session.get("interview_type"):
        context_info += f"\nInterview Type: {session['interview_type']}"
    if session.get("difficulty"):
        context_info += f"\nDifficulty: {session['difficulty']}"
    if session.get("job_description"):
        context_info += f"\nJob Description: {session['job_description'][:500]}"

    prompt = f"""You are an expert interview coach. Based on the following mock interview transcript,
provide detailed feedback on the candidate's performance.
{context_info}

Cover the following in your feedback:
1. Overall Score (out of 10)
2. Technical Accuracy (if applicable)
3. Communication Clarity
4. Strengths — what the candidate did well
5. Areas for Improvement — specific, actionable suggestions
6. Key Takeaways — 2-3 things to focus on before the real interview

TRANSCRIPT:
{transcript}"""

    if AI_BACKEND == "gemini":
        response = await asyncio.to_thread(
            gemini_client.models.generate_content,
            model="gemini-2.5-flash",
            contents=prompt
        )
        feedback_text = response.text
    else:
        response = await asyncio.to_thread(
            qwen_client.chat.completions.create,
            model=VLLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
        )
        feedback_text = response.choices[0].message.content

    # Save the feedback to the session
    await db.interviews.update_one(
        {"_id": ObjectId(session_id)},
        {"$set": {"feedback": feedback_text}}
    )

    return FeedbackResponse(feedback=feedback_text)
