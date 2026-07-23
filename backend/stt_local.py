"""Local speech-to-text via faster-whisper (Whisper on CTranslate2, CPU).

Used when the user picks the "standard" STT engine at interview setup
(routers/chat.py transcribe_audio, engine="local") so transcription works with
no API key and no network. The model downloads to the Hugging Face cache and
loads once per process, lazily on first "local" request — not pre-warmed at
startup, since most containers may never see one (Groq is the default engine).
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor

from config import WHISPER_MODEL

# Single worker: whisper saturates the CPU per request, so queuing beats thrashing.
_whisper_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper-stt")

_whisper_instance = None
_whisper_lock = asyncio.Lock()


def _load_whisper():
    from faster_whisper import WhisperModel
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")


async def get_whisper_instance():
    global _whisper_instance
    if _whisper_instance is None:
        async with _whisper_lock:
            if _whisper_instance is None:
                _whisper_instance = await asyncio.to_thread(_load_whisper)
    return _whisper_instance


def _transcribe_sync(model, path: str) -> str:
    segments, _info = model.transcribe(path, language="en", vad_filter=True)
    return " ".join(seg.text.strip() for seg in segments).strip()


async def transcribe_file(path: str) -> str:
    model = await get_whisper_instance()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_whisper_executor, _transcribe_sync, model, path)
