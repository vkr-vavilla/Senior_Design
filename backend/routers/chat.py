from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, File, UploadFile
from jose import JWTError, jwt
from groq import Groq
from openai import OpenAI
from google import genai
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

        voice = request.get("voice", "am_michael")
        speed = float(request.get("speed", 1.3))

        # Frontend now sends short clauses, so synthesize as one shot — no resplitting.
        import re
        natural_text = re.sub(r"\s+", " ", text.strip())
        natural_text = natural_text.replace("—", ", ").replace(" - ", ", ")

        kokoro = await asyncio.to_thread(_get_kokoro)
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
    print(f"DEBUG: WebSocket accepted. Preferred backend: {AI_BACKEND}")

    selected_model_source = _normalize_model_source(model_source)
    last_source_used = selected_model_source
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

                if int_type == "behavioral":
                    interview_type_guidance = (
                        "You are running a BEHAVIORAL interview. Focus entirely on how the candidate worked with people, "
                        "handled challenges, and grew as a professional. Ask about: teamwork and collaboration, leadership moments, "
                        "conflict resolution, times they failed and what they learned, handling pressure or ambiguity, and what they "
                        "contributed beyond just writing code. Use STAR in your head to probe — if an answer is vague, ask for the "
                        "specific situation or what they personally did. Do NOT ask technical questions about how systems work, "
                        "algorithms, or code internals. Keep it human and experience-focused."
                    )
                    interview_rotation_focus = "team situations, leadership moments, and challenges from their work history"
                elif int_type == "technical":
                    interview_type_guidance = (
                        "You are running a TECHNICAL interview. Focus on the systems, technologies, code, and architecture "
                        "behind the candidate's work. Ask about: how specific features were built, why certain technologies were "
                        "chosen over alternatives, how they handled scale or performance issues, debugging approaches, system design "
                        "tradeoffs, and depth of knowledge in the tools they listed. Probe for specifics — not just 'I used Redis' "
                        "but why Redis, how it was configured, what problems it solved. Do NOT ask behavioral or soft-skill questions."
                    )
                    interview_rotation_focus = "specific technologies, system design decisions, and technical tradeoffs"
                else:
                    interview_type_guidance = (
                        "You are running a MIXED interview. Balance between technical depth and behavioral questions. "
                        "Cover both how they built things (technical depth, tradeoffs, architecture) and how they worked with others, "
                        "led, or overcame challenges (behavioral). Alternate naturally between the two throughout the conversation."
                    )
                    interview_rotation_focus = "technical topics, system decisions, team situations, and leadership moments"

                system_prompt = f"""=== CANDIDATE RESUME (your primary source — read this carefully) ===
{resume}

=== JOB DESCRIPTION ===
{jd}

=== YOUR ROLE ===
You are Alex, a warm and experienced senior {role} running a {difficulty} {int_type} interview with the candidate above.

GROUNDING RULES (most important):
- Every question you ask MUST be tied to something concrete in the resume above OR to something the candidate just said. Do not pull generic questions from memory.
- Before asking about a skill, tool, or framework, scan the resume to confirm it's listed. If it isn't, do NOT ask about it.
- When the candidate asks "is that on my resume?" — actually check. If it's not there, say so honestly and pivot to something that IS in the resume. Never claim something is on the resume when it isn't.
- Quote or paraphrase real items from the resume (project names, companies, tools, dates) so it's obvious you're reading it.

COVERAGE RULES (critical):
- The resume has multiple projects, jobs, technologies, and experiences. You MUST explore ALL of them across the interview — not just one.
- After covering one project or job, move to a completely different area: a different company, a different project, or a different technology stack listed on the resume.
- Actively ask about the specific technologies the candidate has listed (languages, frameworks, databases, cloud tools, etc.) — probe their depth on each.
- Use varied, natural transitions when moving topics — never repeat the same one twice. Options: "I want to move to something different —", "Actually, I noticed on your resume —", "Tell me about your time at [Company] —", "One more area I want to cover —", "Moving on —", "I also saw you worked with X —", "Let me ask you about [different project/role] —", "Switching topics —". Pick a different one each time.
- Think of the resume as a map with many destinations. Navigate across all of it, not back and forth on one spot.

VOICE & STYLE:
- Talk like a real person across the table from them. Conversational, curious, engaged.
- React substantively to what they actually said — pick out a specific detail, share a brief reaction or related thought (2-4 sentences), THEN ask your next question. This is a real conversation, not an interrogation.
- Vary your opener — do NOT start consecutive turns with the same phrase. Avoid filler like "That sounds like a lot of fun" or "Okay, that sounds interesting" more than once per interview.
- Natural openers: "Walk me through...", "Hmm, when you say X — what did that look like in practice?", "Got it. And on the [specific thing they mentioned]...", "Interesting — I'd want to understand [specific detail] better.", "Okay, so [paraphrase one technical point]. What was the tradeoff there?"
- Vary length and energy. Most turns should be 3-5 sentences of real engagement before the question. Be warm but real. Don't fake-praise.

INTERVIEWING APPROACH:
- Ask ONE focused question per turn. Never stack multiple questions.
- DIG IN on technical specifics. When they say "I used FreeRTOS" — ask about task priorities, IPC mechanism, the worst race condition. When they say "improved accuracy 30%" — ask what the baseline was, how they measured it, what changed.
- Avoid surface-level follow-ups like "did you learn that on the project?" or "was that a team effort?" — go technical instead.
- Move the conversation forward — don't paraphrase their answer back as your whole turn.

INTERVIEWING APPROACH — CRITICAL:
- Ask EXACTLY ONE question per turn. One question, one "?", then stop.
- Your entire response must be under 40 words. If you are going over, cut it down.
- Never ask a question with multiple sub-parts ("...and also tell me... and also how..."). Pick one angle only.
- When answers are vague, ask one short follow-up, then move on.
- Move the conversation forward — do not paraphrase their answer back.
- Rotate between: work experiences, personal projects, and {interview_rotation_focus}.

DON'T — these are hard rules, no exceptions:
- Do NOT give any feedback, evaluation, scoring, or assessment during the interview. Ever. That happens after.
- Do NOT say: "Great answer", "That's a solid approach", "Good point", "Excellent", "That makes sense", "Impressive", "Nice", or any phrase that judges their answer — positive or negative.
- Do NOT summarize what they just said back to them.
- Do NOT use bullet points or numbered lists. You're a person, not a document.
- Do NOT walk through the job description, location, hours, or admin details.
- Do NOT loop back to the same project or job you already covered. Move forward.

KICKOFF (first turn only):
- One short sentence introducing yourself as Alex, then ONE warm opening question tied to a specific project or experience FROM the resume above. Skip all preamble.
"""
        except Exception as e:
            print(f"DEBUG: Load context fail: {e}")

    # Standardized message format for fallback
    messages = [
        {"role": "system", "content": system_prompt}
    ]

    loop = asyncio.get_running_loop()

    def _run_stream(stream_messages, max_tokens, temperature):
        """Run _stream_with_fallback in a thread, yielding chunks via a queue."""
        queue: asyncio.Queue = asyncio.Queue()

        def worker():
            nonlocal last_source_used
            try:
                source_used = {"value": selected_model_source}
                for delta in _stream_with_fallback(
                    stream_messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
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

        loop.run_in_executor(None, worker)
        return queue

    try:
        # Opening greeting
        opening_reply = ""
        kickoff = (
            "Begin the interview. Your response must have exactly two parts:\n"
            "1. A greeting: introduce yourself as Alex in one short warm sentence (e.g. 'Hi, I'm Alex — good to meet you.').\n"
            "2. Ask the candidate to briefly introduce themselves — who they are, their background, and what they're looking for. "
            "question tied to a specific project or experience from THEIR resume above. "
            "Keep it natural and conversational, like a real interviewer would open.\n"
            "Do not add anything else — no agenda, no mention of duration or format, no list of what you'll cover."
        )

        queue = _run_stream(messages + [{"role": "user", "content": kickoff}], max_tokens=2048, temperature=0.7)
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, str) and item.startswith("__ERROR__:"):
                await websocket.send_text(json.dumps({"chunk": f"AI Error: {item}", "done": False}))
                break
            delta = item["delta"]
            source = item.get("source", selected_model_source)
            opening_reply += delta
            await websocket.send_text(json.dumps({"chunk": delta, "done": False, "source": source}))

        await websocket.send_text(json.dumps({"chunk": "", "done": True, "source": last_source_used}))
        messages.append({"role": "assistant", "content": opening_reply})
        history.append({"role": "model", "text": opening_reply})

        # Main Loop
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

            full_reply = ""
            queue = _run_stream(messages, max_tokens=8192, temperature=0.8)
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, str) and item.startswith("__ERROR__:"):
                    await websocket.send_text(json.dumps({"chunk": f"AI Error: {item}", "done": False}))
                    break
                delta = item["delta"]
                source = item.get("source", selected_model_source)
                full_reply += delta
                await websocket.send_text(json.dumps({"chunk": delta, "done": False, "source": source}))

            messages.append({"role": "assistant", "content": full_reply})
            history.append({"role": "model", "text": full_reply})
            await websocket.send_text(json.dumps({"chunk": "", "done": True, "source": last_source_used}))

    except WebSocketDisconnect:
        if history:
            user_answers = [m["text"] for m in history if m["role"] == "user"]
            # Build Q&A pairs: model turn followed by user turn
            qa_pairs = []
            for i, msg in enumerate(history):
                if msg["role"] == "model" and i + 1 < len(history) and history[i + 1]["role"] == "user":
                    qa_pairs.append({"question": msg["text"], "answer": history[i + 1]["text"]})

            if interview_id:
                await db.interviews.update_one(
                    {"_id": ObjectId(interview_id)},
                    {"$set": {"messages": history, "model_source": selected_model_source, "user_answers": user_answers, "qa_pairs": qa_pairs}}
                )
            else:
                _id = client_session_id if client_session_id else str(ObjectId())
                await db.chat_sessions.insert_one({
                    "_id": _id,
                    "user_id": user_id,
                    "messages": history,
                    "model_source": selected_model_source,
                    "user_answers": user_answers,
                    "qa_pairs": qa_pairs,
                    "created_at": datetime.now(timezone.utc),
                })


@router.post("/{session_id}/feedback", response_model=FeedbackResponse)
async def get_feedback(session_id: str):
    db = get_db()
    session = await db.interviews.find_one({"_id": ObjectId(session_id)})
    if not session:
        session = await db.chat_sessions.find_one({"_id": ObjectId(session_id)})

    if not session or not session.get("messages"):
        raise HTTPException(status_code=404, detail="Session not found or no messages recorded")

    # Pull context
    resume_text = session.get("resume_text", "")
    job_description = session.get("job_description", "")
    role = session.get("role", "Software Engineer")
    interview_type = session.get("interview_type", "general")
    difficulty = session.get("difficulty", "medium")

    # Resolve candidate name from the user record
    candidate_name = "the candidate"
    user_id = session.get("user_id")
    if user_id:
        user_doc = await db.users.find_one({"_id": ObjectId(user_id)}, {"name": 1})
        if user_doc and user_doc.get("name"):
            candidate_name = user_doc["name"].split()[0]  # first name only

    # Use pre-extracted Q&A pairs if available, otherwise derive from messages
    qa_pairs = session.get("qa_pairs") or []
    if not qa_pairs:
        messages = session.get("messages", [])
        for i, msg in enumerate(messages):
            if msg["role"] == "model" and i + 1 < len(messages) and messages[i + 1]["role"] == "user":
                qa_pairs.append({"question": msg["text"], "answer": messages[i + 1]["text"]})

    if not qa_pairs:
        raise HTTPException(status_code=400, detail="No candidate answers found to evaluate")

    # Save user answers to DB if not already there
    if not session.get("user_answers"):
        user_answers = [qa["answer"] for qa in qa_pairs]
        await db.interviews.update_one(
            {"_id": ObjectId(session_id)},
            {"$set": {"user_answers": user_answers, "qa_pairs": qa_pairs}},
        )

    qa_text = "\n\n".join(
        f"Q{i + 1}: {qa['question']}\nA{i + 1}: {qa['answer']}"
        for i, qa in enumerate(qa_pairs)
    )

    context = ""
    if resume_text:
        context += f"\n\n=== CANDIDATE RESUME ===\n{resume_text.strip()}"
    if job_description:
        context += f"\n\n=== JOB DESCRIPTION ===\n{job_description.strip()}"

    # Pre-build the per-question skeleton with actual questions already inserted
    breakdown_skeleton = "\n".join(
        f'- **Q{i + 1} — {qa["question"][:80].strip()}**: [how your answer landed — was it specific or vague? what worked, what fell short, and what a stronger answer would have included]'
        for i, qa in enumerate(qa_pairs)
    )

    # Coding round (if the candidate solved live problems): feed the code + results
    # to the model and add a Coding Round section to the output. Both strings stay
    # empty for interviews with no coding attempts, so the prompt is unchanged then.
    coding_attempts = session.get("coding_attempts") or []
    coding_block = ""
    coding_output_section = ""
    if coding_attempts:
        attempt_texts = []
        for i, attempt in enumerate(coding_attempts, 1):
            verdict = (
                "all example tests passed"
                if attempt.get("all_passed")
                else f"passed {attempt.get('passed', 0)}/{attempt.get('total', 0)} example tests"
            )
            attempt_texts.append(
                f"--- Problem {i}: {attempt.get('title', 'Untitled')} "
                f"({attempt.get('difficulty', '?')}) ---\n"
                f"Result: {verdict}\n"
                f"Language: {attempt.get('language', 'python3')}\n"
                f"Their solution:\n```\n{(attempt.get('code') or '').strip()}\n```"
            )
        coding_block = (
            "\n\n=== CODING ROUND (live problems the candidate solved) ===\n"
            + "\n\n".join(attempt_texts)
            + "\n\nWeigh this coding round alongside the spoken answers in the overall "
            "score, strengths, and weaknesses."
        )
        coding_output_section = f"""

**Coding Round**
[Assess their actual code: did it pass the example tests, and is the approach sound? Comment on time/space complexity, edge cases, and whether the code is clean and readable enough for a {role}. Reference what they actually wrote; if a solution failed its tests, say what likely went wrong and how to fix it.]"""

    prompt = f"""You are an experienced hiring manager who just finished a {difficulty} {interview_type} interview for a {role} role. You're writing honest, personal feedback addressed directly to the candidate, whose first name is {candidate_name}. Judge them the way you actually would as the hiring manager for THIS role — measure every answer against what the {role} position and its job description require.{context}

=== INTERVIEW Q&A (what you asked and how they answered) ===
{qa_text}{coding_block}

=== HOW TO WRITE THIS ===
Write the way a thoughtful hiring manager actually talks after an interview — warm but honest, specific, and human. Address the candidate directly as "you" (you can use their name once for warmth, but do not keep referring to them in the third person).

Two rules matter most:
1. Tie your judgement to the role. When something is a strength or a gap, say what it means for someone doing THIS job, and reference the job description / role requirements where relevant.
2. Every sentence must say something real about THIS interview. Never write a label and then just restate it.

BAD — robotic, says nothing (never write like this):
- **Clear**: Your communication was clear.
- **Concise**: Your communication was concise.

GOOD — specific and tied to the role (write like this):
- When I asked about scaling the service, you jumped straight to "add caching" without naming the actual bottleneck — for a role that owns production systems, I want to see you diagnose before you optimise.
- You walked through your fraud-detection project really clearly, which is exactly the kind of ownership this position needs.

Output using this exact structure (** for section headers, - for bullets):

**Overall Score: [X]/10**
[Two or three honest sentences talking to them: how did they do overall against what this role needs, and what's the headline takeaway?]

**Answer-by-Answer Breakdown**
{breakdown_skeleton}{coding_output_section}

**Strengths**
- [A specific moment that worked and why it matters for this role — reference what you actually said.]
- [Another, if there is one.]

**Weaknesses**
- [A specific shortcoming in how you answered — what was missing, wrong, or too shallow for what this role expects.]
- [Another, if there is one.]

**Areas for Improvement**
- [Concrete, actionable guidance to close the gaps above — what to practise and what a stronger answer would have sounded like.]
- [Another, if there is one.]

**Key Takeaways**
- [2-3 headline points to remember before a real interview for this kind of role, each tied to something that actually happened above.]

Rules:
- Fill in every line of the Answer-by-Answer Breakdown with a real evaluation — no placeholders.
- Quote or closely paraphrase what the candidate actually said; no generic advice that could apply to anyone.
- Frame strengths and gaps in terms of fit for this specific {role} role and its job description.
- Keep Weaknesses (what fell short) and Areas for Improvement (how to fix it) distinct — do not just repeat the same points.
- If their resume lists skills they never demonstrated in the interview, say so honestly.
- Be honest with the score: 9-10 exceptional, 7-8 solid, 5-6 needs work, below 5 significant gaps."""

    async def generate_feedback() -> str:
        if AI_BACKEND == "gemini" and gemini_client:
            resp = await asyncio.to_thread(
                gemini_client.models.generate_content,
                model=GEMINI_MODEL,
                contents=prompt,
            )
            return resp.text
        else:
            resp = await asyncio.to_thread(
                vllm_client.chat.completions.create,
                model=VLLM_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=2600,
                temperature=0.6,
            )
            return resp.choices[0].message.content

    try:
        feedback_text = await generate_feedback()
    except Exception as e:
        feedback_text = f"Feedback generation failed: {e}"

    await db.interviews.update_one(
        {"_id": ObjectId(session_id)},
        {"$set": {"feedback": feedback_text}},
    )
    return FeedbackResponse(feedback=feedback_text)
