from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, File, UploadFile
from jose import JWTError, jwt
from groq import Groq
from datetime import datetime, timezone
from auth.jwt import get_current_user
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
async def transcribe_audio(file: UploadFile = File(...), user_id: str = Depends(get_current_user)):
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
async def synthesize_speech(request: dict, user_id: str = Depends(get_current_user)):
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
async def chat_ws(websocket: WebSocket, token: str = "", interview_id: str = "", client_session_id: str = ""):
    await websocket.accept()

    # Auth: prefer a {"token": ...} first message so the JWT stays out of the URL
    # (query strings end up in proxy/access logs); the query param remains as a
    # fallback for older clients.
    try:
        if not token:
            first = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            token = json.loads(first).get("token", "")
        user_id = verify_token(token)
    except Exception:
        await websocket.close(code=4001)
        return
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
                    max_tokens=500,
                    temperature=0.85,
                    top_p=0.9,
                    presence_penalty=0.8,
                    frequency_penalty=0.6,
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
            "You are Alex, the interviewer. Begin the interview now. Greet the candidate by name "
            "in one short sentence (e.g. 'Hi Vamshi, I'm Alex.'), then ask THEM your first warm-up "
            "question tied to a specific project or experience from THEIR resume above. "
            "Do NOT introduce yourself in long form. Do NOT walk through the job description, "
            "requirements, location, hours, or admin details. Do NOT ask Alex anything — YOU ARE "
            "Alex. The candidate is the person whose resume is above; address them directly."
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
            user_answers = [m["text"] for m in history if m["role"] == "user"]
            # Build Q&A pairs: model turn followed by user turn
            qa_pairs = []
            for i, msg in enumerate(history):
                if msg["role"] == "model" and i + 1 < len(history) and history[i + 1]["role"] == "user":
                    qa_pairs.append({"question": msg["text"], "answer": history[i + 1]["text"]})

            if interview_id:
                await db.interviews.update_one(
                    {"_id": ObjectId(interview_id)},
                    {"$set": {"messages": history, "user_answers": user_answers, "qa_pairs": qa_pairs}},
                )
            else:
                _id = client_session_id if client_session_id else str(ObjectId())
                await db.chat_sessions.insert_one({
                    "_id": _id,
                    "user_id": user_id,
                    "messages": history,
                    "user_answers": user_answers,
                    "qa_pairs": qa_pairs,
                    "created_at": datetime.now(timezone.utc),
                })


@router.post("/{session_id}/feedback", response_model=FeedbackResponse)
async def get_feedback(session_id: str, user_id: str = Depends(get_current_user)):
    db = get_db()
    collection = db.interviews
    session = None
    try:
        oid = ObjectId(session_id)
    except Exception:
        oid = None
    if oid is not None:
        session = await collection.find_one({"_id": oid, "user_id": user_id})
    if not session:
        # Sessionless chats are stored in chat_sessions with a string _id.
        session = await db.chat_sessions.find_one({"_id": session_id, "user_id": user_id})
        if session:
            collection = db.chat_sessions

    if not session or not session.get("messages"):
        raise HTTPException(status_code=404, detail="Session not found or no messages recorded")

    session_filter = {"_id": session["_id"]}

    # Reuse stored feedback unless a coding attempt landed after it was written;
    # regenerating on every page view costs an LLM call and rewrites the report.
    existing_feedback = session.get("feedback")
    feedback_at = session.get("feedback_generated_at")
    last_attempt_at = max(
        (a.get("submitted_at") for a in session.get("coding_attempts") or [] if a.get("submitted_at")),
        default=None,
    )
    stale = last_attempt_at is not None and (feedback_at is None or last_attempt_at > feedback_at)
    if existing_feedback and not stale:
        return FeedbackResponse(feedback=existing_feedback)

    # Pull context
    resume_text = session.get("resume_text", "")
    job_description = session.get("job_description", "")
    role = session.get("role", "Software Engineer")
    interview_type = session.get("interview_type", "general")
    difficulty = session.get("difficulty", "medium")

    # Resolve candidate name from the user record
    candidate_name = "the candidate"
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
        await collection.update_one(
            session_filter,
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
        if AI_BACKEND == "gemini":
            client = get_gemini_client()
            resp = await asyncio.to_thread(
                client.models.generate_content,
                model="gemini-2.5-flash",
                contents=prompt,
            )
            return resp.text
        else:
            client = get_vllm_client()
            resp = await asyncio.to_thread(
                client.chat.completions.create,
                model=VLLM_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=2600,
                temperature=0.6,
            )
            return resp.choices[0].message.content

    try:
        feedback_text = await generate_feedback()
    except Exception as e:
        # Don't persist the failure text — a later retry should regenerate.
        print(f"Feedback generation error: {e}")
        raise HTTPException(status_code=502, detail="Feedback generation failed; please try again.")

    await collection.update_one(
        session_filter,
        {"$set": {"feedback": feedback_text, "feedback_generated_at": datetime.now(timezone.utc)}},
    )
    return FeedbackResponse(feedback=feedback_text)
