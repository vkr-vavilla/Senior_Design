# ⚡ FinalRound — AI Mock Interview Platform

An advanced, AI-powered mock interview platform that simulates real-world engineering interviews. Built with **Next.js**, **FastAPI**, **MongoDB**, and a novel **Hybrid AI Architecture** supporting both Cloud and Local LLMs.

> **UTA CSE Senior Design Project — Team Final Round**

---

## 🌟 Demo Highlights (What makes this special?)

1. **Hybrid AI Engine:** The backend is environment-aware. Run on a lightweight laptop using lighting-fast Cloud APIs (Google Gemini 1.5 Flash), or switch to a lab machine with `vLLM` to run open-source models (like Qwen or Gemma) entirely locally for privacy and cost-efficiency.
2. **Speech-to-Speech Interaction:** Users speak to the AI via microphone using **Groq Whisper** (near-zero latency STT), and the AI replies verbally using **Groq Orpheus** TTS with smart chunking to bypass standard API limits. 
3. **Context-Aware:** The interviewer doesn't just ask leetcode questions; it parses your uploaded resume and the specific job description to ask highly targeted questions.
4. **Actionable Feedback:** At the end of the session, the AI acts as an interview coach, generating a structured post-mortem grading the candidate's performance.

---

## 🛠 Tech Stack

| Component | Technology |
|---|---|
| **Frontend** | Next.js 14, React 18, TypeScript, TailwindCSS, WebSockets |
| **Backend** | Python 3.12+, FastAPI, Uvicorn, PyJWT |
| **Database** | MongoDB Atlas / Local MongoDB via motor (Async) |
| **Cloud AI (Primary)**| Google Gemini 1.5 Flash (via `google-genai`) |
| **Local AI (Fallback)**| Qwen/Gemma running on local GPU via `vLLM` & OpenAI SDK |
| **Audio Pipeline** | Groq API (`whisper-large-v3`, `orpheus-v1-english`) |

---

## 📦 Prerequisites

Ensure you have the following installed before starting:

- **Node.js**: v18+ (`node -v`)
- **Python**: v3.10+ (`python3 --v`)
- **Git**

### Obtaining API Keys
1. **Google Gemini API Key:** Get free access at [aistudio.google.com](https://aistudio.google.com/apikey).
2. **Groq API Key:** Get free access at [console.groq.com/keys](https://console.groq.com/keys). 
   - *Note: To use the TTS engine, go to the Groq Playground, select the `canopylabs/orpheus-v1-english` model, and accept the Terms of Service.*

### Setting up MongoDB Atlas (Free Cloud Database)
1. Go to [cloud.mongodb.com](https://cloud.mongodb.com) and create a free account.
2. Click **Build a Database** and select the **M0 Free** tier.
3. Under Security -> Database Access, create a user and set a strong password. **Save this password.**
4. Under Security -> Network Access, add `0.0.0.0/0` (Allow access from anywhere) so your local app can connect.
5. Go to Database -> Connect -> "Connect your application" and copy the connection string.
   - It will look like: `mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority`
   - Replace `<password>` with the password you created in step 3.

---

## 🚀 Getting Started

### 1. Clone the Repository
```bash
git clone https://github.com/vkr-vavilla/Senior_Design.git
cd Senior_Design
```

### 2. Backend Setup
```bash
# Navigate to the backend directory
cd backend

# Create and activate a Python virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install the Python dependencies (includes everything needed for Cloud + Local)
pip install -r requirements.txt

# Create your environment file
cp .env.example .env
```

Open `backend/.env` and fill in your keys and settings:
```env
MONGODB_URI=mongodb+srv://your-user:your-password@cluster0.abcde.mongodb.net/
DB_NAME=FinalRound
JWT_SECRET=super_secret_string_123
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
GEMINI_API_KEY=your_gemini_key_here
GROQ_API_KEY=your_groq_key_here

# ⚡ HYBRID ENGINE SWITCH ⚡
# "gemini" -> Runs via Google Cloud (Perfect for Laptops)
# "vllm" -> Looks for a local GPU instance (Perfect for Lab Machines)
AI_BACKEND=gemini
VLLM_BASE_URL=http://localhost:8000/v1
VLLM_MODEL=Qwen/Qwen2.5-7B-Instruct
```

### 3. Frontend Setup
Open a new terminal window:
```bash
# Navigate to frontend directory
cd frontend

# Install Node dependencies
npm install
```

Ensure `frontend/.env.local` exists and contains:
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000
```

---

## 🏃‍♂️ Running the Application

You will need two terminal windows running side-by-side.

### Terminal A: The Backend (FastAPI)
```bash
cd backend
source venv/bin/activate
uvicorn main:app --reload --port 8000
```
*You should see the message: `Connected to MongoDB: FinalRound` and `DEBUG: WebSocket accepted. Preferred backend: gemini` (when a connection is made).*

### Terminal B: The Frontend (Next.js)
```bash
cd frontend
npm run dev
```

Right-click/CMD-click the URL provided in the terminal (usually `http://localhost:3000`) to open the app in your browser!

---

## 🧭 Project Navigation (Code Structure)

- `backend/main.py`: Entrypoint. Contains lifespan logic that smartly avoids launching `vllm` hardware checks if running in "gemini" mode.
- `backend/routers/chat.py`: The core of the interview logic. Handles Real-Time WebSockets, System Promts, Audio transcription/synthesis, and houses the Hybrid Lazy-Loading AI architecture.
- `frontend/src/hooks/useInterviewChat.ts`: Manages the frontend WebSocket state, connecting to the backend to stream AI responses seamlessly.
- `frontend/src/hooks/useTextToSpeech.ts`: Implements a queueing system to play back Groq audio blobs, automatically reverting to standard browser voices if Groq rate limits are hit.

---

## 👥 Team
**Final Round** — UTA CSE Senior Design, Spring 2026
