from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from database import connect_db, close_db
from routers import auth, chat, interview
import asyncio
import subprocess
import requests
import time

VLLM_MODEL = "Qwen/Qwen2.5-7B-Instruct"
VLLM_PORT = 8000

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
    await asyncio.to_thread(start_vllm)
    yield
    await close_db()
    stop_vllm()


app = FastAPI(title="PrepAI API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(interview.router)


@app.get("/")
async def root():
    return {"message": "PrepAI API is running"}
