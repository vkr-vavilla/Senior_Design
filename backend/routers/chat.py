from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, File, UploadFile
from jose import JWTError, jwt
from groq import Groq
from openai import OpenAI
from datetime import datetime, timezone
from database import get_db
from config import JWT_SECRET, JWT_ALGORITHM, GROQ_API_KEY
from models.chat import ChatMessage, FeedbackResponse
from bson import ObjectId
import json
import asyncio
import tempfile
import os

router = APIRouter(prefix="/chat", tags=["chat"])

groq_client = Groq(api_key=GROQ_API_KEY)

VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://localhost:8000/v1")
VLLM_MODEL = os.getenv("VLLM_MODEL", "google/gemma-7b-it")

vllm_client = OpenAI(base_url=VLLM_BASE_URL, api_key="not-needed")


def verify_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise ValueError("No user id in token")
        return user_id
    except JWTError:
        raise ValueError("Invalid token")


@router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            with open(tmp_path, "rb") as audio_file:
                transcription = groq_client.audio.transcriptions.create(
                    file=(file.filename, audio_file.read()),
                    model="whisper-large-v3",
                    response_format="json",
                    language="en",
                    temperature=0.0
                )
            return {"text": transcription.text}
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    except Exception as e:
        print(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/synthesize")
async def synthesize_speech(request: dict):
    try:
        text = request.get("text")
        if not text:
            from fastapi.responses import Response
            return Response(content="Empty text", status_code=400)

        # Groq Orpheus has a 200 char limit per request. 
        # We split text into chunks just in case, though frontend usually sends sentences.
        def split_text(t, limit=200):
            return [t[i:i + limit] for i in range(0, len(t), limit)]

        chunks = split_text(text)
        combined_audio = b""
        
        for chunk in chunks:
            response = groq_client.audio.speech.create(
                model="canopylabs/orpheus-v1-english",
                voice="troy",
                input=chunk,
                response_format="wav"
            )
            # For wav, we should ideally strip headers for subsequent chunks, 
            # but for now we'll just take the content.
            combined_audio += response.read()

        from fastapi.responses import Response
        return Response(content=combined_audio, media_type="audio/wav")

    except Exception as e:
        print(f"Synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/ws")
async def chat_ws(websocket: WebSocket, token: str, interview_id: str = "", client_session_id: str = ""):
    try:
        user_id = verify_token(token)
    except ValueError:
        await websocket.close(code=4001)
        return

    await websocket.accept()
    print("DEBUG: WebSocket accepted")

    history = []
    db = get_db()
    system_prompt = "You are a professional interviewer. Be conversational, professional, ask one question at a time, and push back on vague answers."

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

                system_prompt = f"""# ROLE
You are a senior {role} interviewer. Your goal is to conduct a professional {difficulty} {int_type} interview.

# CANDIDATE CONTEXT
- **Role**: {role}
- **Experience Level**: {difficulty}
- **Interview Type**: {int_type}
- **Resume Information**: {resume_text}
- **Job Description**: {job_desc}

# CONVERSATION RULES
1. **ASK ONE QUESTION AT A TIME**. This is critical.
2. Be conversational but professional. Act like a senior engineer.
3. Push back on vague answers. Ask for implementation details or specific STAR examples.
4. Do not provide feedback during the interview. Save it for the end.
5. If the interview type is 'technical', focus on system design, coding patterns, and specific technologies from the resume.
6. If 'behavioral', focus on leadership, conflict resolution, and teamwork.

# FORMATTING
- Do not write out the candidate's responses.
- Do not explain your AI nature. Just stay in character.
- Start by greeting the candidate by name if available, or just a professional greeting, and ask your first question.
"""
                print(f"DEBUG: Loaded interview context for {interview_id}")
        except Exception as e:
            print(f"DEBUG: Could not load interview context: {e}")

    try:
        # Prime the conversation with system instructions
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "I am ready. Please start the interview."}
        ]

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def send_opening():
            try:
                stream = vllm_client.chat.completions.create(
                    model=VLLM_MODEL,
                    messages=messages,
                    stream=True,
                    max_tokens=256,
                    temperature=0.7,
                )
                for chunk in stream:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        loop.call_soon_threadsafe(queue.put_nowait, delta)
            except Exception as e:
                loop.call_soon_threadsafe(queue.put_nowait, f"__ERROR__:{e}")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, send_opening)

        opening_reply = ""
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, str) and item.startswith("__ERROR__:"):
                await websocket.send_text(json.dumps({"chunk": f"AI Error: {item}", "done": False}))
                break
            opening_reply += item
            await websocket.send_text(json.dumps({"chunk": item, "done": False}))

        await websocket.send_text(json.dumps({"chunk": "", "done": True}))
        messages.append({"role": "assistant", "content": opening_reply})
        history.append({"role": "model", "text": opening_reply})

        while True:
            print("DEBUG: Waiting for message...")
            data = await websocket.receive_text()
            print(f"DEBUG: Received data: {data[:100]}")
            message = json.loads(data).get("message", "")
            if not message:
                continue

            history.append({"role": "user", "text": message})
            messages.append({"role": "user", "content": message})

            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def stream_sync():
                try:
                    print("DEBUG: Starting vLLM stream")
                    stream = vllm_client.chat.completions.create(
                        model=VLLM_MODEL,
                        messages=messages,
                        stream=True,
                        max_tokens=256,
                        temperature=0.6,
                    )
                    for chunk in stream:
                        delta = chunk.choices[0].delta.content
                        if delta:
                            loop.call_soon_threadsafe(queue.put_nowait, delta)
                    print("DEBUG: vLLM stream complete")
                except Exception as e:
                    print(f"DEBUG: vLLM stream error: {e}")
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
                    print(f"vLLM error: {item}")
                    await websocket.send_text(json.dumps({"chunk": f"AI Error: {item}", "done": False}))
                    break
                full_reply += item
                await websocket.send_text(json.dumps({"chunk": item, "done": False}))

            messages.append({"role": "assistant", "content": full_reply})
            history.append({"role": "model", "text": full_reply})
            await websocket.send_text(json.dumps({"chunk": "", "done": True}))

    except WebSocketDisconnect:
        if history:
            if interview_id:
                await db.interviews.update_one(
                    {"_id": ObjectId(interview_id)},
                    {"$set": {"messages": history}}
                )
            else:
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

    try:
        session = await db.interviews.find_one(
            {"_id": ObjectId(session_id)},
            {"resume_pdf": 0}
        )
    except Exception:
        pass

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

    def generate_feedback():
        response = vllm_client.chat.completions.create(
            model=VLLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1024,
            temperature=0.7,
        )
        return response.choices[0].message.content

    feedback_text = await asyncio.to_thread(generate_feedback)

    await db.interviews.update_one(
        {"_id": ObjectId(session_id)},
        {"$set": {"feedback": feedback_text}}
    )

    return FeedbackResponse(feedback=feedback_text)
