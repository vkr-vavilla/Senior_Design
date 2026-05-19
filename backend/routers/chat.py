from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, File, UploadFile
from jose import JWTError, jwt
from groq import Groq
from datetime import datetime, timezone
from database import get_db
from config import GEMINI_API_KEY, VLLM_BASE_URL, VLLM_MODEL, AI_BACKEND, JWT_SECRET, JWT_ALGORITHM, GROQ_API_KEY
from models.chat import ChatMessage, FeedbackResponse
from bson import ObjectId
import json
import asyncio
import tempfile
import os

router = APIRouter(prefix="/chat", tags=["chat"])

groq_client = Groq(api_key=GROQ_API_KEY)

_kokoro = None
def get_kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        model_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "kokoro_models")
        _kokoro = Kokoro(
            os.path.join(model_dir, "kokoro-v1.0.onnx"),
            os.path.join(model_dir, "voices-v1.0.bin"),
        )
    return _kokoro

# LAZY IMPORTS: We only import these when actually needed to prevent crashes on laptops
def get_gemini_client():
    try:
        from google import genai
        return genai.Client(api_key=GEMINI_API_KEY)
    except ImportError:
        print("DEBUG: google-genai not installed. Gemini will be unavailable.")
        return None

def get_vllm_client():
    try:
        from openai import OpenAI
        return OpenAI(base_url=VLLM_BASE_URL, api_key="not-needed")
    except ImportError:
        print("DEBUG: openai library not installed. Local LLMs will be unavailable.")
        return None


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

        voice = request.get("voice", "am_michael")
        speed = float(request.get("speed", 1.3))

        # Frontend now sends short clauses, so synthesize as one shot — no resplitting.
        import re
        natural_text = re.sub(r"\s+", " ", text.strip())
        natural_text = natural_text.replace("—", ", ").replace(" - ", ", ")

        kokoro = await asyncio.to_thread(get_kokoro)
        samples, sample_rate = await asyncio.to_thread(
            kokoro.create, natural_text, voice=voice, speed=speed, lang="en-us"
        )

        import io, wave, numpy as np
        buf = io.BytesIO()
        pcm = (samples * 32767).astype(np.int16).tobytes()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm)

        from fastapi.responses import Response
        return Response(content=buf.getvalue(), media_type="audio/wav")

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
    print(f"DEBUG: WebSocket accepted. Preferred backend: {AI_BACKEND}")

    history = [] 
    db = get_db()
    
    # Context state
    system_prompt = (
        "You are Alex, a warm and experienced interviewer having a real conversation with the candidate. "
        "Talk like a person, not a checklist. Use natural fillers occasionally ('Got it.', 'Okay, interesting.', 'Hmm, that's fair.'), "
        "react to what they actually said before moving on, and let your personality show. "
        "Ask one focused question at a time. When an answer is vague or generic, gently push for specifics — "
        "ask for a story, an example, numbers, or what they personally did versus what their team did. "
        "Avoid sounding like a form. Vary your sentence length and openers."
    )

    if interview_id:
        try:
            interview = await db.interviews.find_one(
                {"_id": ObjectId(interview_id), "user_id": user_id},
                {"role": 1, "interview_type": 1, "difficulty": 1, "resume_text": 1, "job_description": 1}
            )
            if interview:
                role = interview.get("role", "Software Engineer")
                difficulty = interview.get("difficulty", "medium")
                int_type = interview.get("interview_type", "technical")
                resume = interview.get("resume_text", "") or ""
                jd = interview.get("job_description", "") or ""
                print(f"DEBUG: Loaded resume_text ({len(resume)} chars), jd ({len(jd)} chars)")
                if not resume.strip():
                    print("WARNING: resume_text is empty for this interview")

                system_prompt = f"""=== CANDIDATE RESUME (your primary source — read this carefully) ===
{resume}

=== JOB DESCRIPTION ===
{jd}

=== YOUR ROLE ===
You are Alex, a warm and experienced senior {role} running a {difficulty} {int_type} interview with the candidate above.

GROUNDING RULES (most important):
- Every question you ask MUST be tied to something concrete in the resume above OR to something the candidate just said. Do not pull generic questions from memory.
- Before asking about a skill, tool, or framework, scan the resume to confirm it's listed. If it isn't, do NOT ask about it. (Example: don't ask about Selenium, JUnit, or TestNG unless they appear in the resume.)
- When the candidate asks "is that on my resume?" — actually check. If it's not there, say so honestly and pivot to something that IS in the resume. Never claim something is on the resume when it isn't.
- Quote or paraphrase real items from the resume (project names, companies, tools, dates) so it's obvious you're reading it.

VOICE & STYLE:
- Talk like a real person across the table from them. Conversational, curious, engaged.
- React to what they actually said in a sentence or two — show you're listening — then ask your next question. Curiosity, not evaluation.
- Natural openers: "Walk me through...", "Tell me more about...", "Hmm, what do you mean by...", "Okay, so when you say X — what did that look like?", "Got it. And...".
- Vary length and energy. Some turns short, some longer when you're genuinely curious. Don't be robotic.
- Be warm but real. Don't fake-praise. Earn your reactions.

INTERVIEWING APPROACH:
- Ask ONE focused question per turn. Never stack multiple questions.
- When answers are vague or buzzwordy, dig: ask for a specific story, a number, a tradeoff, what THEY did vs the team.
- Move the conversation forward — don't paraphrase their answer back.

DON'T:
- Don't summarize with bullet points or numbered lists. You're a person.
- Don't walk through the job description, location, hours, or admin details.
- Don't act like they got the job — you're screening.
- Don't compliment the structure of an answer. Save evaluation for the post-interview report.

KICKOFF (first turn only):
- One short sentence introducing yourself as Alex, then ONE warm opening question tied to a specific project or experience FROM the resume above. Skip all preamble.
"""
        except Exception as e:
            print(f"DEBUG: Load context fail: {e}")

    # Standardized message format for fallback
    messages = [
        {"role": "system", "content": system_prompt}
    ]

    async def get_ai_response_stream(user_input: str):
        """Unified streamer with automatic fallback and lazy loading."""
        provider = AI_BACKEND
        
        messages.append({"role": "user", "content": user_input})
        
        try:
            if provider == "gemini":
                client = get_gemini_client()
                if not client: raise ImportError("Gemini client missing")
                
                gemini_history = []
                for m in messages[:-1]:
                    role = "user" if m["role"] in ["user", "system"] else "model"
                    gemini_history.append({"role": role, "parts": [{"text": m["content"]}]})
                
                chat = client.chats.create(model="gemini-2.5-flash", history=gemini_history)
                for chunk in chat.send_message_stream(user_input):
                    if chunk.text: yield chunk.text
            else:
                client = get_vllm_client()
                if not client: raise ImportError("vLLM client missing")
                
                stream = client.chat.completions.create(
                    model=VLLM_MODEL,
                    messages=messages,
                    stream=True,
                    max_tokens=400,
                    temperature=0.85,
                    top_p=0.9,
                    presence_penalty=0.6,
                    frequency_penalty=0.3,
                )
                for chunk in stream:
                    delta = chunk.choices[0].delta.content
                    if delta: yield delta
                    
        except Exception as e:
            yield f"__ERROR__: AI engine failed or library missing. Error: {e}"

    try:
        # Opening greeting
        full_opening = ""
        kickoff = (
            "Start the interview. In ONE short sentence introduce yourself as Alex, then "
            "immediately ask your first opening question. Do NOT walk through the job "
            "description, requirements, location, hours, eligibility, or any admin details — "
            "the candidate already knows those. Skip 'confirming' anything. Just briefly say hi "
            "and ask a real warm-up question (something like 'tell me a bit about yourself' or "
            "a light question tied to a specific project on their resume)."
        )
        async for chunk in get_ai_response_stream(kickoff):
            if chunk.startswith("__ERROR__"):
                await websocket.send_text(json.dumps({"chunk": chunk, "done": False}))
                break
            full_opening += chunk
            await websocket.send_text(json.dumps({"chunk": chunk, "done": False}))
        
        await websocket.send_text(json.dumps({"chunk": "", "done": True}))
        messages.append({"role": "assistant", "content": full_opening})
        history.append({"role": "model", "text": full_opening})

        # Main Loop
        while True:
            data = await websocket.receive_text()
            user_msg = json.loads(data).get("message", "")
            if not user_msg: continue

            history.append({"role": "user", "text": user_msg})
            
            full_reply = ""
            async for chunk in get_ai_response_stream(user_msg):
                if chunk.startswith("__ERROR__"):
                    await websocket.send_text(json.dumps({"chunk": chunk, "done": False}))
                    break
                full_reply += chunk
                await websocket.send_text(json.dumps({"chunk": chunk, "done": False}))
            
            messages.append({"role": "assistant", "content": full_reply})
            history.append({"role": "model", "text": full_reply})
            await websocket.send_text(json.dumps({"chunk": "", "done": True}))

    except WebSocketDisconnect:
        if history:
            if interview_id:
                await db.interviews.update_one({"_id": ObjectId(interview_id)}, {"$set": {"messages": history}})
            else:
                _id = client_session_id if client_session_id else str(ObjectId())
                await db.chat_sessions.insert_one({"_id": _id, "user_id": user_id, "messages": history, "created_at": datetime.now(timezone.utc)})


@router.post("/{session_id}/feedback", response_model=FeedbackResponse)
async def get_feedback(session_id: str):
    db = get_db()
    session = await db.interviews.find_one({"_id": ObjectId(session_id)})
    if not session:
        session = await db.chat_sessions.find_one({"_id": ObjectId(session_id)})
    
    if not session or not session.get("messages"):
        raise HTTPException(status_code=404, detail="Session not found")

    transcript = "\n".join([f"{msg['role'].upper()}: {msg['text']}" for msg in session["messages"]])
    prompt = f"Provide expert interview feedback for this transcript:\n\n{transcript}"

    async def get_feedback_text():
        if AI_BACKEND == "gemini":
            client = get_gemini_client()
            resp = await asyncio.to_thread(client.models.generate_content, model="gemini-2.5-flash", contents=prompt)
            return resp.text
        else:
            client = get_vllm_client()
            resp = await asyncio.to_thread(client.chat.completions.create, model=VLLM_MODEL, messages=[{"role": "user", "content": prompt}], max_tokens=1024)
            return resp.choices[0].message.content

    try:
        feedback_text = await get_feedback_text()
    except Exception as e:
        feedback_text = f"Feedback generation failed: {e}"

    await db.interviews.update_one({"_id": ObjectId(session_id)}, {"$set": {"feedback": feedback_text}})
    return FeedbackResponse(feedback=feedback_text)
