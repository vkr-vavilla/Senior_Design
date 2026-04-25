from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, File, UploadFile
from jose import JWTError, jwt
from groq import Groq
from openai import OpenAI
from google import genai
from datetime import datetime, timezone
from database import get_db
from config import JWT_SECRET, JWT_ALGORITHM, GROQ_API_KEY, GEMINI_API_KEY
from models.chat import ChatMessage, FeedbackResponse
from bson import ObjectId
import json
import asyncio
import tempfile
import os

router = APIRouter(prefix="/chat", tags=["chat"])

groq_client = Groq(api_key=GROQ_API_KEY)

VLLM_BASE_URL = os.getenv("VLLM_PRIMARY_URL", "http://localhost:8000/v1")
_LORA_ADAPTER_PATH = os.path.join(os.path.dirname(__file__), "../../training/artifacts/qwen2.5-7b-chatml-qlora-8192")
VLLM_MODEL = (
    "interview-adapter"
    if os.path.isdir(_LORA_ADAPTER_PATH)
    else os.getenv("VLLM_PRIMARY_MODEL", "Qwen/Qwen2.5-7B-Instruct")
)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

vllm_client = OpenAI(base_url=VLLM_BASE_URL, api_key="not-needed")
gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


def _normalize_model_source(source: str | None) -> str:
    if source in {"local", "api"}:
        return source
    return "local"


def _ordered_sources(preferred: str) -> list[str]:
    normalized = _normalize_model_source(preferred)
    if normalized == "api":
        return ["api", "local"]
    return ["local", "api"]


def _is_identity_question(text: str) -> bool:
    t = text.lower()
    asks_model = any(k in t for k in ["what model", "which model", "gemini", "qwen", "api or local", "local or api"])
    asks_identity = any(k in t for k in ["are you", "is this", "who are you", "model are you"])
    return asks_model or asks_identity


def _identity_answer(source: str) -> str:
    if source == "api":
        return f"This response is using API mode: {GEMINI_MODEL} (Gemini)."
    return f"This response is using Local mode: {VLLM_MODEL} (Qwen via vLLM)."


def _gemini_contents(messages: list[dict]) -> tuple[list[dict], str]:
    contents: list[dict] = []
    system_parts: list[str] = []

    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        if not content:
            continue

        if role == "system":
            system_parts.append(content)
            continue

        if role == "assistant":
            mapped_role = "model"
        elif role == "user":
            mapped_role = "user"
        else:
            continue

        contents.append({"role": mapped_role, "parts": [{"text": content}]})

    return contents, "\n\n".join(system_parts)


def _stream_with_fallback(
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    preferred_source: str,
    source_used: dict | None = None,
):
    errors: list[str] = []
    for source in _ordered_sources(preferred_source):
        if source == "local":
            try:
                if source_used is not None:
                    source_used["value"] = "local"
                stream = vllm_client.chat.completions.create(
                    model=VLLM_MODEL,
                    messages=messages,
                    stream=True,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                for chunk in stream:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        yield delta
                return
            except Exception as vllm_error:
                print(f"[ModelSelect] local(vLLM) failed: {vllm_error}")
                errors.append(f"local(vLLM): {vllm_error}")
                continue

        if source == "api":
            if not gemini_client:
                errors.append("api(Gemini): GEMINI_API_KEY is not configured")
                continue

            try:
                if source_used is not None:
                    source_used["value"] = "api"
                contents, system_instruction = _gemini_contents(messages)
                config = {
                    "temperature": temperature,
                    "max_output_tokens": max_tokens,
                }
                if system_instruction:
                    config["system_instruction"] = system_instruction

                stream = gemini_client.models.generate_content_stream(
                    model=GEMINI_MODEL,
                    contents=contents,
                    config=config,
                )
                for chunk in stream:
                    text = getattr(chunk, "text", None)
                    if text:
                        yield text
                return
            except Exception as gemini_error:
                print(f"[ModelSelect] api(Gemini) failed: {gemini_error}")
                errors.append(f"api(Gemini): {gemini_error}")
                continue

    raise RuntimeError("All model providers failed: " + " | ".join(errors))


def _single_with_fallback(messages: list[dict], max_tokens: int, temperature: float, preferred_source: str) -> str:
    errors: list[str] = []
    for source in _ordered_sources(preferred_source):
        if source == "local":
            try:
                response = vllm_client.chat.completions.create(
                    model=VLLM_MODEL,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                return response.choices[0].message.content or ""
            except Exception as vllm_error:
                print(f"[ModelSelect] local(vLLM) failed: {vllm_error}")
                errors.append(f"local(vLLM): {vllm_error}")
                continue

        if source == "api":
            if not gemini_client:
                errors.append("api(Gemini): GEMINI_API_KEY is not configured")
                continue

            try:
                contents, system_instruction = _gemini_contents(messages)
                config = {
                    "temperature": temperature,
                    "max_output_tokens": max_tokens,
                }
                if system_instruction:
                    config["system_instruction"] = system_instruction

                response = gemini_client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=contents,
                    config=config,
                )
                return (getattr(response, "text", "") or "").strip()
            except Exception as gemini_error:
                print(f"[ModelSelect] api(Gemini) failed: {gemini_error}")
                errors.append(f"api(Gemini): {gemini_error}")
                continue

    raise RuntimeError("All model providers failed: " + " | ".join(errors))


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


def _get_kokoro():
    """Lazy-load Kokoro so it doesn't block startup. Auto-downloads model on first use."""
    from kokoro_onnx import Kokoro
    import os
    import urllib.request
    model_dir = os.path.join(os.path.dirname(__file__), "../kokoro_models")
    os.makedirs(model_dir, exist_ok=True)
    model_path = os.path.join(model_dir, "kokoro-v1.0.onnx")
    voices_path = os.path.join(model_dir, "voices-v1.0.bin")
    if not os.path.exists(model_path):
        print(f"[Kokoro] Downloading model to {model_path}...")
        urllib.request.urlretrieve(
            "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
            model_path,
        )
    if not os.path.exists(voices_path):
        print(f"[Kokoro] Downloading voices to {voices_path}...")
        urllib.request.urlretrieve(
            "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
            voices_path,
        )
    return Kokoro(model_path, voices_path)

_kokoro_instance = None
_kokoro_lock = asyncio.Lock()

@router.post("/synthesize")
async def synthesize_speech(request: dict):
    try:
        text = request.get("text", "").strip()
        if not text:
            from fastapi.responses import Response
            return Response(content=b"", status_code=400)

        global _kokoro_instance
        async with _kokoro_lock:
            if _kokoro_instance is None:
                _kokoro_instance = await asyncio.to_thread(_get_kokoro)

        kokoro = _kokoro_instance
        samples, sample_rate = await asyncio.to_thread(
            kokoro.create, text, voice="af_sky", speed=1.0, lang="en-us"
        )

        import io
        import soundfile as sf
        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format="WAV")
        buf.seek(0)

        from fastapi.responses import Response
        return Response(content=buf.read(), media_type="audio/wav")

    except Exception as e:
        print(f"Synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/ws")
async def chat_ws(
    websocket: WebSocket,
    token: str,
    interview_id: str = "",
    client_session_id: str = "",
    model_source: str = "local",
):
    try:
        user_id = verify_token(token)
    except ValueError:
        await websocket.close(code=4001)
        return

    await websocket.accept()

    selected_model_source = _normalize_model_source(model_source)
    last_source_used = selected_model_source
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

                if int_type == "technical":
                    mode_block = f"""YOU ARE CONDUCTING A TECHNICAL INTERVIEW. THIS IS NON-NEGOTIABLE.

ABSOLUTELY FORBIDDEN QUESTIONS — DO NOT ASK ANY OF THESE OR ANYTHING SIMILAR:
- "Tell me about yourself" / "Walk me through your background"
- "What's your current role" / "Walk me through your current project" (in generic terms)
- "How do you stay updated with new technologies"
- "What makes a good software engineer"
- "What are your strengths/weaknesses"
- "Tell me about a difficult bug you fixed" (in generic terms)
- "Do you have experience with X?" — this is a yes/no question, not a real technical question
- Any open-ended "tell me about your experience with..." filler
- Any question that could be answered by reading the resume aloud

REQUIRED QUESTION TYPES — every question MUST fall into one of these categories:
1. SYSTEM DESIGN: "Design a system that handles X with constraints Y. Walk me through your architecture, database choices, and how you'd scale to Z users."
2. DEEP TECHNICAL DRILL: pick a specific technology from their resume and probe internals. Example: "You list Redis on your resume. Walk me through what happens when a Redis instance hits its maxmemory limit with allkeys-lru policy. What are the tradeoffs vs. volatile-lru?"
3. ARCHITECTURE DECISIONS: "On your [specific project from resume], why did you choose [technology]? What were the tradeoffs vs alternatives? What would you change now?"
4. DEBUGGING / PROBLEM SCENARIOS: "Your service is returning 504s for 1% of requests, only between 2am-4am. Walk me through how you'd diagnose this."
5. CODING / ALGORITHMS: present a concrete coding problem. Example: "Given a stream of integers, design a data structure that returns the median in O(log n). Walk me through your approach and analyze the complexity."
6. CONCURRENCY / DISTRIBUTED SYSTEMS: "You have two services updating the same row in a database. How do you prevent race conditions? Compare optimistic vs pessimistic locking with concrete examples."

DIFFICULTY: {difficulty}
- easy: focus on fundamentals, single-component design, basic algorithms
- medium: multi-component systems, performance tradeoffs, common distributed patterns
- hard: novel system designs, deep CS theory, scaling to millions, edge cases in distributed systems"""
                else:
                    mode_block = """YOU ARE CONDUCTING A BEHAVIORAL INTERVIEW.
- Use the STAR method (Situation, Task, Action, Result).
- Reference specific roles, projects, and companies from the resume.
- Probe for: leadership, conflict resolution, ownership, cross-team work, dealing with ambiguity.
- After each answer, ask a sharp follow-up that probes WHY they made a specific decision or what they'd do differently."""

                system_prompt = f"""You are a SENIOR {role.upper()} INTERVIEWER at a top-tier tech company. You are sharp, precise, and demanding. Your job is to assess whether this candidate can actually do the job — not to make them feel comfortable.

CANDIDATE RESUME:
{resume_text}

JOB DESCRIPTION:
{job_desc}

{mode_block}

INTERVIEW FLOW:
- Greet the candidate by name (if available) in ONE short sentence, then immediately ask question #1.
- Plan to cover 5-7 distinct topic areas drawn from the resume and job description.
- After each answer, ALWAYS ask a follow-up that drills deeper — never accept a vague answer:
  * If they describe a project: ask about a specific technical decision and why they made it
  * If they mention a technology: ask about its internals, tradeoffs, or failure modes
  * If they give a high-level answer: ask for concrete numbers (latency, throughput, complexity)
  * If they say "we did X": ask "what was YOUR specific contribution?"
- After 2-3 follow-ups on a topic, smoothly transition to a new topic with a phrase like "Got it, let's switch gears."
- NEVER repeat a topic or technology you've already discussed.
- Sound like a real human interviewer — use natural transitions ("Got it.", "Interesting.", "Let me push on that —"), not robotic question lists.

WRAP-UP:
- Once you've covered ~6 topic areas with depth, end the interview gracefully:
  "Great, I have a strong sense of your background. We'll be in touch about next steps. Do you have any questions for me?"
- After they ask their question (or say no), say goodbye and STOP asking interview questions.

CRITICAL OUTPUT RULES:
- Ask ONE question per turn. Wait for the answer.
- Tie EVERY question to something specific in the resume or job description.
- NO generic filler questions. NO behavioral questions during a technical interview."""
        except Exception as e:
            print(f"Could not load interview context: {e}")

    try:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "I am ready. Please start the interview."}
        ]

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def send_opening():
            nonlocal last_source_used
            try:
                source_used = {"value": selected_model_source}
                for delta in _stream_with_fallback(
                    messages,
                    max_tokens=2048,
                    temperature=0.7,
                    preferred_source=selected_model_source,
                    source_used=source_used,
                ):
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        {"delta": delta, "source": source_used.get("value", selected_model_source)},
                    )
                last_source_used = source_used.get("value", selected_model_source)
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
            delta = item["delta"] if isinstance(item, dict) else str(item)
            source = item.get("source", selected_model_source) if isinstance(item, dict) else selected_model_source
            opening_reply += delta
            await websocket.send_text(json.dumps({"chunk": delta, "done": False, "source": source}))

        await websocket.send_text(json.dumps({"chunk": "", "done": True, "source": last_source_used}))
        messages.append({"role": "assistant", "content": opening_reply})
        history.append({"role": "model", "text": opening_reply})

        while True:
            data = await websocket.receive_text()
            message = json.loads(data).get("message", "")
            if not message:
                continue

            if _is_identity_question(message):
                deterministic = _identity_answer(last_source_used)
                history.append({"role": "user", "text": message})
                history.append({"role": "model", "text": deterministic})
                messages.append({"role": "user", "content": message})
                messages.append({"role": "assistant", "content": deterministic})
                await websocket.send_text(json.dumps({"chunk": deterministic, "done": False, "source": last_source_used}))
                await websocket.send_text(json.dumps({"chunk": "", "done": True, "source": last_source_used}))
                continue

            history.append({"role": "user", "text": message})
            messages.append({"role": "user", "content": message})

            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def stream_sync():
                nonlocal last_source_used
                try:
                    source_used = {"value": selected_model_source}
                    for delta in _stream_with_fallback(
                        messages,
                        max_tokens=8192,
                        temperature=0.8,
                        preferred_source=selected_model_source,
                        source_used=source_used,
                    ):
                        loop.call_soon_threadsafe(
                            queue.put_nowait,
                            {"delta": delta, "source": source_used.get("value", selected_model_source)},
                        )
                    last_source_used = source_used.get("value", selected_model_source)
                except Exception as e:
                    print(f"stream error: {e}")
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
                    await websocket.send_text(json.dumps({"chunk": f"AI Error: {item}", "done": False}))
                    break
                delta = item["delta"] if isinstance(item, dict) else str(item)
                source = item.get("source", selected_model_source) if isinstance(item, dict) else selected_model_source
                full_reply += delta
                await websocket.send_text(json.dumps({"chunk": delta, "done": False, "source": source}))

            messages.append({"role": "assistant", "content": full_reply})
            history.append({"role": "model", "text": full_reply})
            await websocket.send_text(json.dumps({"chunk": "", "done": True, "source": last_source_used}))

    except WebSocketDisconnect:
        if history:
            if interview_id:
                await db.interviews.update_one(
                    {"_id": ObjectId(interview_id)},
                    {"$set": {"messages": history, "model_source": selected_model_source}}
                )
            else:
                _id = client_session_id if client_session_id else str(ObjectId())
                await db.chat_sessions.insert_one({
                    "_id": _id,
                    "user_id": user_id,
                    "messages": history,
                    "model_source": selected_model_source,
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

    preferred_source = _normalize_model_source(session.get("model_source", "local"))

    def generate_feedback():
        return _single_with_fallback(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1024,
            temperature=0.7,
            preferred_source=preferred_source,
        )

    feedback_text = await asyncio.to_thread(generate_feedback)

    await db.interviews.update_one(
        {"_id": ObjectId(session_id)},
        {"$set": {"feedback": feedback_text}}
    )

    return FeedbackResponse(feedback=feedback_text)
