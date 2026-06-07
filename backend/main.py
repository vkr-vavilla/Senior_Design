from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from database import connect_db, close_db
from routers import auth, chat, interview, coding
from config import AI_BACKEND
import asyncio
import subprocess
import requests
import time
import os

VLLM_MODEL = os.getenv("VLLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")
VLLM_PORT = int(os.getenv("VLLM_PRIMARY_PORT", "8080"))

vllm_process = None


def start_vllm():
    global vllm_process
    print(f"[vLLM] Starting {VLLM_MODEL} on port {VLLM_PORT}...")
    vllm_process = subprocess.Popen([
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", VLLM_MODEL,
        "--port", str(VLLM_PORT),
        "--max-num-seqs", "64",
        "--gpu-memory-utilization", "0.95",
        "--enforce-eager",
        "--max-model-len", "4096",
    ])
    for _ in range(180):
        try:
            r = requests.get(f"http://localhost:{VLLM_PORT}/v1/models", timeout=2)
            if r.ok:
                print(f"[vLLM] Ready at http://localhost:{VLLM_PORT}/v1")
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("vLLM failed to start within 180 seconds")


def stop_vllm():
    global vllm_process
    if vllm_process and vllm_process.poll() is None:
        print("[vLLM] Shutting down...")
        vllm_process.terminate()
        try:
            vllm_process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            vllm_process.kill()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    vllm_autostart = os.getenv("VLLM_AUTOSTART", "true").lower() == "true"
    if AI_BACKEND not in ["gemini"] and vllm_autostart:
        await asyncio.to_thread(start_vllm)

    # Pre-warm Kokoro TTS so the first synthesize request doesn't pay the load cost
    try:
        from routers.chat import get_kokoro
        await asyncio.to_thread(get_kokoro)
        print("[Kokoro] Pre-warmed.")
    except Exception as e:
        print(f"[Kokoro] Pre-warm skipped: {e}")

    yield
    await close_db()
    if vllm_process:
        stop_vllm()


app = FastAPI(title="FinalRound", lifespan=lifespan)

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(interview.router)
app.include_router(coding.router)


@app.get("/")
async def root():
    return {"message": "PrepAI API is running"}
