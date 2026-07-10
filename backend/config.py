from dotenv import load_dotenv
import os

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "prepai")
# Collection holding the LeetCode problem bank (statement, starter code, tests, meta).
PROBLEMS_COLLECTION = os.getenv("PROBLEMS_COLLECTION", "leetcode")
# Code-execution backend: "piston" (sandboxed) or "local" (subprocess, no isolation).
CODE_EXECUTOR = os.getenv("CODE_EXECUTOR", "local")
JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET environment variable is not set. Generate one with: openssl rand -hex 64")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
# Refresh-token flow is implemented to improve security.
# Access tokens are short-lived (15 min), refresh tokens are long-lived (30 days).
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 15))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", 30))
# Gemini API Key (Optional: can be supplied dynamically by the user on the frontend)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
# Groq API Key (Optional: browser Web Speech API replaces backend speech-to-text)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
# Speech-to-text backend: "groq" (cloud API, needs GROQ_API_KEY) or "local"
# (faster-whisper on CPU, no key, works offline). Defaults to groq when a key
# is configured, local otherwise — the downloadable package sets local explicitly.
STT_BACKEND = os.getenv("STT_BACKEND", "groq" if GROQ_API_KEY else "local").lower()
# Whisper size for STT_BACKEND=local: tiny/base/small/medium (bigger = better, slower).
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://localhost:8080/v1")
VLLM_MODEL = os.getenv("VLLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")
# Base (non-LoRA) model id, used ONLY for grading feedback. VLLM_MODEL points at
# the "interviewer" LoRA — a persona fine-tuned to be warm and encouraging — so
# using it to also grade the interview biases scores upward. vLLM serves the base
# checkpoint under this id alongside the LoRA adapter, so no extra deployment or
# model download is needed; just a different `model=` on the same server.
VLLM_BASE_MODEL = os.getenv("VLLM_BASE_MODEL", "Qwen/Qwen2.5-7B-Instruct-AWQ")
AI_BACKEND = os.getenv("AI_BACKEND", "gemini")  # "gemini" or "qwen"
# Redis: per-turn crash-safety snapshot of the live interview (best-effort; the
# interview still works if Redis is unreachable).
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
