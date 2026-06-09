# PrepAI · FinalRound — AI-Powered Mock Interview Platform

PrepAI (internally **FinalRound**) is a full-stack web app that runs realistic, voice-driven mock interviews end to end: it talks to you, listens to your answers, runs a live coding round, and then writes you honest, role-specific feedback — the way a real hiring manager would.

It can run entirely on a **cloud LLM (Google Gemini)** with zero GPU, or fully **self-hosted** on your own GPU using a fine-tuned **Qwen2.5-7B** interviewer model served by vLLM.

---

## ✨ Features

- **Conversational, voice-first interviews** over a WebSocket — speak your answers, hear the interviewer reply.
  - **Speech-to-text** via Groq Whisper.
  - **Text-to-speech** via Kokoro (ONNX, runs locally).
- **Resume- and job-description-aware questioning.** Upload a PDF résumé + paste a JD; the interviewer tailors questions to *your* background and the role.
- **Three interview modes:** behavioral, technical, and mixed, each at easy / medium / hard difficulty.
- **Live coding round** (technical/mixed interviews):
  - Problems sourced from LeetCode and cached in MongoDB.
  - In-browser **Monaco** editor.
  - **Run** against visible example tests, then **Submit** to save your attempt.
  - **Finish & View Feedback** ends the round and routes you straight to feedback.
- **AI feedback report** rendered as swipeable cards — overall score, answer-by-answer breakdown, a dedicated **Coding Round** slide, strengths, weaknesses, and concrete areas to improve.
- **Session history** — every interview, transcript, and feedback report is saved and re-openable.
- **Pluggable AI backend:** flip a single env var between **Gemini (cloud)** and **Qwen + vLLM (local GPU)**.
- **Pluggable code executor:** a simple **local subprocess** runner (default, works anywhere) or a sandboxed **Judge0** stack.

---

## 🏗️ Architecture

```
                         ┌──────────────────────────┐
   Browser (Next.js) ───▶│  FastAPI backend (8080)   │
   - dashboard           │                           │
   - voice interview ◀──▶│  /auth   /interview       │
   - Monaco coding round │  /chat (WebSocket + STT/  │
   - feedback cards      │         TTS)  /coding     │
                         └────────────┬──────────────┘
                                      │
        ┌─────────────────────────────┼───────────────────────────────┐
        ▼                             ▼                                ▼
  MongoDB (Atlas/local)      LLM backend                       Code execution
  - users                    ├─ Gemini 2.5 Flash (cloud)       ├─ local subprocess (default)
  - interviews               └─ vLLM → Qwen2.5-7B-Instruct-AWQ  └─ Judge0 sandbox (optional)
  - leetcode (problem bank)        + "interviewer" LoRA adapter
```

### Tech stack

| Layer            | Technology |
|------------------|------------|
| Frontend         | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Monaco Editor, Framer Motion, Three.js / Spline |
| Backend          | FastAPI, Uvicorn, Motor (async MongoDB), Pydantic |
| Auth             | JWT (python-jose) + bcrypt password hashing (passlib) |
| LLM              | Google Gemini 2.5 Flash **or** vLLM serving Qwen2.5-7B-Instruct-AWQ + QLoRA adapter |
| Speech-to-text   | Groq Whisper |
| Text-to-speech   | Kokoro ONNX |
| Résumé parsing   | pdfplumber |
| Coding sandbox   | Local subprocess runner / Judge0 (Postgres + Redis) |
| Database         | MongoDB |
| Orchestration    | Docker Compose |

---

## 📁 Repository layout

```
.
├── backend/                     # FastAPI service
│   ├── main.py                  # App entrypoint, CORS, lifespan, optional vLLM autostart
│   ├── config.py                # Env-driven config (DB, JWT, AI backend, executor…)
│   ├── database.py              # Async MongoDB (Motor) connection
│   ├── auth/jwt.py              # Password hashing + JWT create/verify, get_current_user dep
│   ├── models/                  # Pydantic models (user.py, chat.py)
│   ├── routers/
│   │   ├── auth.py              # /auth     register / login / me
│   │   ├── interview.py         # /interview  create sessions, list history, résumé download
│   │   ├── chat.py              # /chat     WebSocket interview, STT, TTS, feedback generation
│   │   └── coding.py            # /coding   problems, run, submit
│   ├── coding/                  # Coding-round engine
│   │   ├── selection.py         # Picks problems per difficulty/type
│   │   ├── normalize.py         # Adapts stored LeetCode docs → internal shape
│   │   ├── driver.py            # Wraps Solution-method code for stdin/stdout execution
│   │   ├── grading.py           # Runs code vs example tests, returns pass/fail
│   │   ├── executor.py          # Dispatches to local or judge0
│   │   ├── local_executor.py    # Subprocess runner (default)
│   │   └── judge0_client.py     # Judge0 sandbox client
│   ├── scripts/scrape_leetcode.py  # Seeds MongoDB with LeetCode problems
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                    # Next.js app
│   └── src/
│       ├── app/
│       │   ├── (auth)/login, register
│       │   └── (main)/dashboard, interview, interview/[id]/code,
│       │              interview/[id]/feedback, history, history/[id]
│       ├── components/          # auth, chat, coding, dashboard, feedback, layout, ui
│       ├── contexts/AuthContext.tsx
│       ├── lib/api.ts           # Typed API client
│       └── types/
├── training/                    # Fine-tuning artifacts (LoRA adapter; weights gitignored)
├── docker-compose.yml           # Full local stack (backend + vLLM + frontend + Judge0)
├── docker-compose.prod.yml
└── judge0.conf                  # Judge0 sandbox config
```

---

## 🚀 Getting started

### Prerequisites

- **Docker** & **Docker Compose** (recommended path)
- A **MongoDB** instance (MongoDB Atlas free tier works great)
- A **Groq API key** (for speech-to-text) — https://console.groq.com
- One of:
  - A **Google Gemini API key** (cloud LLM, no GPU needed) — https://aistudio.google.com, **or**
  - An **NVIDIA GPU** (for the local Qwen/vLLM path)

### 1. Clone

```bash
git clone https://github.com/vkr-vavilla/Senior_Design.git
cd Senior_Design
```

### 2. Configure environment

Copy the example env and fill in your values:

```bash
cp backend/.env.example backend/.env
```

```dotenv
# backend/.env
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/FinalRound?appName=FinalRound
DB_NAME=FinalRound

# Auth — CHANGE THIS to a long random string before deploying anywhere
JWT_SECRET=your-secret-key-here
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=10080      # 7 days (no refresh-token flow)

# AI backend: "gemini" (cloud, no GPU) or "qwen" (local vLLM)
AI_BACKEND=gemini
GEMINI_API_KEY=your-gemini-api-key-here

# Speech-to-text
GROQ_API_KEY=your-groq-api-key-here

# Coding round executor: "local" (subprocess, default) or "judge0" (needs cgroup v1)
CODE_EXECUTOR=local
PROBLEMS_COLLECTION=leetcode

# Local LLM (only used when AI_BACKEND=qwen)
VLLM_BASE_URL=http://localhost:8001/v1
VLLM_MODEL=interviewer

# CORS
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

> **TTS note:** The Kokoro voice model files (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) are large and gitignored. Place them in `backend/kokoro_models/` for text-to-speech to work; the app degrades gracefully if they're missing.

### 3. Run with Docker (recommended)

```bash
# Cloud LLM (Gemini) — no GPU required
AI_BACKEND=gemini docker compose up backend frontend judge0-server judge0-workers judge0-db judge0-redis

# OR the full local stack incl. the Qwen vLLM service (needs an NVIDIA GPU)
AI_BACKEND=qwen docker compose up
```

Then open:

- **Frontend:** http://localhost:3000
- **API:** http://localhost:8080 · interactive docs at http://localhost:8080/docs

### 4. Seed the coding-problem bank

The coding round needs problems in MongoDB. Seed them once:

```bash
docker compose exec backend python -m scripts.scrape_leetcode --per-difficulty 25 --sleep 1.0
```

(Only **easy** and **medium** problems are stored; difficulty rules: easy interview → 1 easy, medium → 1 medium, hard → 1 easy + 1 medium.)

---

## 🧑‍💻 Running locally without Docker

**Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

**Frontend**

```bash
cd frontend
npm install
# point the browser client at your backend
echo "NEXT_PUBLIC_API_URL=http://localhost:8080" > .env.local
echo "NEXT_PUBLIC_WS_URL=ws://localhost:8080"   >> .env.local
npm run dev
```

---

## 🔌 API overview

All protected routes expect an `Authorization: Bearer <token>` header.

### Auth — `/auth`
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Create an account |
| POST | `/auth/login` | Get a JWT access token |
| GET  | `/auth/me` | Current user profile |

### Interviews — `/interview`
| Method | Path | Description |
|--------|------|-------------|
| POST | `/interview/start` | Create a lightweight session (no résumé) |
| POST | `/interview/create` | Create a session with résumé PDF + job description (multipart) |
| GET  | `/interview/sessions` | List the user's sessions |
| GET  | `/interview/{id}` | Fetch one session (messages, feedback, metadata) |
| GET  | `/interview/{id}/resume` | Download the stored résumé PDF |

### Interview chat — `/chat`
| Method | Path | Description |
|--------|------|-------------|
| WS   | `/chat/ws` | Real-time interview loop (streamed LLM responses) |
| POST | `/chat/transcribe` | Speech → text (Groq Whisper) |
| POST | `/chat/synthesize` | Text → speech (Kokoro) |
| POST | `/chat/{session_id}/feedback` | Generate the AI feedback report |

### Coding round — `/coding`
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/coding/problems/{problem_id}` | Problem statement + starter code |
| GET  | `/coding/sessions/{id}/problems` | Problems selected for a session |
| POST | `/coding/run` | Grade code against example tests (not persisted) |
| POST | `/coding/submit` | Grade **and** save the attempt to the session |

---

## 🔄 How an interview flows

1. **Sign up / log in** → JWT stored client-side.
2. **Dashboard:** pick a role, type, and difficulty; optionally upload a résumé + paste a JD.
3. **Interview:** the WebSocket drives a back-and-forth — your speech is transcribed (Groq Whisper), the LLM (Gemini or Qwen) responds, and the reply is voiced (Kokoro). No feedback is given *during* the interview.
4. **Coding round** (technical/mixed): solve LeetCode-style problems in Monaco, **Run** to test, **Submit** to save, then **Finish & View Feedback**.
5. **Feedback:** the model writes a structured, role-specific report — overall score, per-answer breakdown, a Coding Round slide, strengths, weaknesses, and improvements.
6. **History:** revisit any past session, transcript, and report.

---

## ⚙️ Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONGODB_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `DB_NAME` | `prepai` / `FinalRound` | Database name |
| `JWT_SECRET` | `changeme` | **Set a strong secret** — signs auth tokens |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `10080` | Token lifetime (7 days; no refresh flow) |
| `AI_BACKEND` | `gemini` | `gemini` (cloud) or `qwen` (local vLLM) |
| `GEMINI_API_KEY` | — | Required when `AI_BACKEND=gemini` |
| `GROQ_API_KEY` | — | Required for speech-to-text |
| `CODE_EXECUTOR` | `local` | `local` subprocess or `judge0` sandbox |
| `PROBLEMS_COLLECTION` | `leetcode` | MongoDB collection holding the problem bank |
| `VLLM_BASE_URL` | `http://localhost:8001/v1` | vLLM OpenAI-compatible endpoint |
| `VLLM_MODEL` | `interviewer` | Served model / LoRA adapter name |
| `ALLOWED_ORIGINS` | `localhost:3000` | Comma-separated CORS origins |

---

## 🧪 The two execution backends

### Code executor
- **`local` (default):** runs candidate code in a Python subprocess with a wall-clock timeout and CPU rlimit. Works on any host (incl. cgroup v2). Not a hardened sandbox — fine for trusted/demo use, not untrusted production.
- **`judge0`:** runs code in the isolated Judge0 sandbox. **Requires the host to use cgroup v1.** On Ubuntu 22.04+/24.04 (cgroup v2) enable it via GRUB:
  ```
  # /etc/default/grub  →  GRUB_CMDLINE_LINUX
  systemd.unified_cgroup_hierarchy=0
  sudo update-grub && sudo reboot
  ```

### LLM backend
- **`gemini`:** calls Gemini 2.5 Flash. No GPU, simplest path.
- **`qwen`:** vLLM serves `Qwen2.5-7B-Instruct-AWQ` with the fine-tuned **`interviewer`** QLoRA adapter from `training/artifacts/`. Needs an NVIDIA GPU; the `vllm` service in `docker-compose.yml` handles it.

---

## 🛠️ Troubleshooting

- **`401 Unauthorized` on `/interview/create`:** your token expired. Tokens now last 7 days (`ACCESS_TOKEN_EXPIRE_MINUTES=10080`); restart the backend after changing `.env` and log in again. The frontend auto-redirects expired sessions to the login page.
- **Coding round is empty:** seed problems with `scripts.scrape_leetcode` and confirm `PROBLEMS_COLLECTION` matches your data.
- **Judge0 submissions error out:** the host is on cgroup v2 — either switch to `CODE_EXECUTOR=local` or enable cgroup v1 (see above).
- **No voice / TTS silent:** place the Kokoro model files in `backend/kokoro_models/`.
- **vLLM won't start:** confirm an NVIDIA GPU + drivers, or switch to `AI_BACKEND=gemini`.

---

## 🔐 Security notes

- Change `JWT_SECRET` to a long random value before any non-local deployment.
- `backend/.env` is gitignored — never commit real secrets.
- The `local` code executor is **not** a security sandbox; use `judge0` for untrusted input in production.

---

## 📄 License & attribution

Senior Design project. LeetCode problem content is fetched via an unofficial endpoint and cached locally for educational use — review LeetCode's Terms of Service before redistributing. Built with FastAPI, Next.js, vLLM, Qwen, Gemini, Groq Whisper, Kokoro, and Judge0.
