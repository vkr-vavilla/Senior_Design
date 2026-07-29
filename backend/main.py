from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from database import connect_db, close_db
from routers import auth, chat, interview, coding
from config import AI_BACKEND
import asyncio
import os
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
    cmd = [
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", VLLM_MODEL,
        "--port", str(VLLM_PORT),
        "--max-num-seqs", "4",
        "--gpu-memory-utilization", "0.90",
        "--enforce-eager",
        "--max-model-len", "32768",
        "--quantization", "bitsandbytes",
        "--load-format", "bitsandbytes",
    ]
    if os.path.isdir(LORA_ADAPTER_PATH):
        print(f"[vLLM] Loading LoRA adapter from {LORA_ADAPTER_PATH}")
        cmd += [
            "--enable-lora",
            "--max-lora-rank", "64",
            "--lora-modules", f"interview-adapter={LORA_ADAPTER_PATH}",
        ]
    vllm_process = subprocess.Popen(cmd)
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


async def ensure_piston_python():
    """Ensure Python is installed in the Piston sandbox container."""
    import httpx
    piston_url = os.getenv("PISTON_URL", "http://localhost:2000")
    code_executor = os.getenv("CODE_EXECUTOR", "local").lower()
    if code_executor != "piston":
        print(f"[Piston] CODE_EXECUTOR is '{code_executor}', skipping Piston check.")
        return

    print(f"[Piston] Checking/installing Python runtime at {piston_url}...")
    # Retry up to 30 times (30 seconds) in case Piston is booting up
    async with httpx.AsyncClient(base_url=piston_url) as client:
        for attempt in range(1, 31):
            try:
                # 1. Check if Python is already installed
                r = await client.get("/api/v2/runtimes", timeout=2.0)
                if r.status_code == 200:
                    runtimes = r.json()
                    python_installed = False
                    for rt in runtimes:
                        if rt.get("language") == "python":
                            python_installed = True
                            print(f"[Piston] Python {rt.get('version')} is already installed.")
                            break
                    
                    if python_installed:
                        return
                    
                    # 2. Python is not installed. Let's install it.
                    print("[Piston] Python is not installed. Installing python 3.12.0...")
                    install_resp = await client.post(
                        "/api/v2/packages",
                        json={"language": "python", "version": "3.12.0"},
                        timeout=30.0
                    )
                    if install_resp.status_code in (200, 201):
                        print("[Piston] Python 3.12.0 installed successfully.")
                        return
                    else:
                        print(f"[Piston] Install failed: {install_resp.status_code} - {install_resp.text}")
                        return
            except Exception as e:
                # Wait before retrying if Piston is not reachable yet
                if attempt == 30:
                    print(f"[Piston] Error ensuring Python in Piston after 30 attempts: {e}")
                await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()

    # Crash recovery: flush any interview snapshots a previously-crashed backend
    # left in Redis into Mongo, then clear them (best-effort; no-op if Redis down).
    try:
        from database import get_db
        from routers.chat import sweep_orphaned_interviews
        await sweep_orphaned_interviews(get_db())
    except Exception as e:
        print(f"[Redis] startup sweep skipped: {e}")

    vllm_autostart = os.getenv("VLLM_AUTOSTART", "true").lower() == "true"
    if AI_BACKEND not in ["gemini"] and vllm_autostart:
        await asyncio.to_thread(start_vllm)

    # Automatically install Python on Piston sandbox if running with Piston executor
    asyncio.create_task(ensure_piston_python())

    # Local Whisper STT is no longer pre-warmed here: the STT engine is now a
    # per-interview user choice (Groq "premium" vs faster-whisper "standard",
    # see routers/chat.py transcribe_audio), so most containers may never see a
    # "local" request. Pre-warming unconditionally would keep the model
    # resident in memory for every instance regardless of use — stt_local.py
    # already lazy-loads it on first actual "local" request instead.

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
    return {"message": "FinalRound API is running"}


@app.get("/config")
async def public_config():
    """What this deployment can actually do — asked by the frontend on load.

    The frontend used to infer this from NEXT_PUBLIC_DEPLOYMENT, which Next.js
    inlines at *build* time. The cloud image is built without that var, so the
    hosted site always rendered local mode and offered a local engine that
    isn't there. Reporting capability from the server can't drift like that:
    whatever engine this backend is configured for is the truth.
    """
    from config import AI_BACKEND, GEMINI_API_KEY
    local_engine = AI_BACKEND != "gemini"
    return {
        # "local" only when a local engine really is wired up.
        "deployment": "local" if local_engine else "cloud",
        "local_engine": local_engine,
        # Lets the UI say the key is optional instead of required.
        "gemini_key_configured": bool(GEMINI_API_KEY),
    }


@app.get("/health")
async def health():
    from database import client
    from fastapi.responses import JSONResponse
    try:
        await client.admin.command("ping")
        return {"status": "ok"}
    except Exception as e:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": str(e)})
