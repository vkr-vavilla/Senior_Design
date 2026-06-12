from dotenv import load_dotenv
import os

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "prepai")
# Collection holding the LeetCode problem bank (statement, starter code, tests, meta).
PROBLEMS_COLLECTION = os.getenv("PROBLEMS_COLLECTION", "leetcode")
# Code-execution backend: "piston" (sandboxed) or "local" (subprocess, no isolation).
CODE_EXECUTOR = os.getenv("CODE_EXECUTOR", "local")
JWT_SECRET = os.getenv("JWT_SECRET", "changeme")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
# No refresh-token flow exists, so tokens must outlast a full session
# (login -> set up resume/JD -> create interview). Default: 7 days.
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 10080))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://localhost:8080/v1")
VLLM_MODEL = os.getenv("VLLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")
AI_BACKEND = os.getenv("AI_BACKEND", "gemini")  # "gemini" or "qwen"
