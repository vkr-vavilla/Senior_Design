"""Kokoro-82M text-to-speech, running on this machine's CPU via ONNX Runtime.

Why it's back: the downloadable package has no Google credentials, so
tts_google fails on every request and voice degrades to the browser's speech
synthesis — which the Tauri/WebKitGTK desktop build doesn't implement at all,
leaving the interviewer completely silent. Kokoro needs no key and no network
once cached, so local installs get a real voice.

Kokoro was the original engine and was replaced in 406d791 because the ~2 GB it
keeps resident caused Cloud Run OOM kills. That is a hosted-runtime constraint,
not a local one, so this module is opt-in via TTS_BACKEND=kokoro (set by
docker-compose.local.yml) and the hosted deploy stays on Cloud TTS.

Weights (~353 MB) are not shipped inside the installer — desktop/bundle-runtime.mjs
strips them to keep it small. They download once into KOKORO_MODEL_DIR, which the
local compose bind-mounts from the host, so the fetch survives image rebuilds.
"""
import asyncio
import io
import os
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor

from config import KOKORO_MODEL_DIR
from tts import TTSUnavailable

_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
_ASSETS = {
    "kokoro-v1.0.onnx": f"{_RELEASE}/kokoro-v1.0.onnx",
    "voices-v1.0.bin": f"{_RELEASE}/voices-v1.0.bin",
}

# Synthesis is a blocking ONNX call, so it runs off the event loop. Two workers
# overlap the next queued clause with the one playing; more would multiply
# per-call working memory for no gain, since the model itself is shared.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="kokoro-tts")

_kokoro = None
_lock = asyncio.Lock()
_unavailable_reason: str | None = None

# The voice ids the frontend already sends. These are Kokoro's own names — the
# Google engine maps them onto Cloud voices, here they're used directly.
_DEFAULT_VOICE = "am_michael"


def _fetch(url: str, dest: str) -> None:
    """Download to a .part file, then rename into place.

    Writing straight to `dest` means an interrupted first run (closed laptop,
    killed container) leaves a truncated file that every later run treats as
    complete, and Kokoro then fails to load forever with no way back except
    manually deleting it. The rename is atomic, so `dest` only ever exists whole.
    """
    tmp = dest + ".part"
    try:
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, dest)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _load():
    """Fetch the weights if absent and build the ONNX session. Blocking."""
    try:
        from kokoro_onnx import Kokoro
    except ImportError as e:
        raise TTSUnavailable(
            "TTS_BACKEND=kokoro but kokoro-onnx isn't installed. It ships in "
            "backend/requirements-local.txt (installed by backend/Dockerfile); "
            "the hosted image builds without it and should use TTS_BACKEND=google."
        ) from e

    os.makedirs(KOKORO_MODEL_DIR, exist_ok=True)
    paths = {}
    for name, url in _ASSETS.items():
        path = os.path.join(KOKORO_MODEL_DIR, name)
        if not os.path.exists(path):
            print(f"[Kokoro] downloading {name} (first run only)...", flush=True)
            try:
                _fetch(url, path)
            except Exception as e:
                raise TTSUnavailable(
                    f"Couldn't download the Kokoro voice model ({name}): {e}. "
                    "The interview works without it — voice falls back to the "
                    "browser. It will retry on the next request."
                ) from e
        paths[name] = path

    return Kokoro(paths["kokoro-v1.0.onnx"], paths["voices-v1.0.bin"])


async def _instance():
    """The shared Kokoro session, loaded on first use.

    Unlike the pre-406d791 version this is never loaded at import or startup
    unless something actually asks for audio, so a container that never
    synthesizes never pays the memory.
    """
    global _kokoro, _unavailable_reason
    if _kokoro is not None:
        return _kokoro
    async with _lock:
        if _kokoro is None:
            # A previous failure is not cached: unlike missing Google
            # credentials (permanently fatal), the usual cause here is a failed
            # download, which the next request can legitimately retry.
            _kokoro = await asyncio.to_thread(_load)
            _unavailable_reason = None
    return _kokoro


def _create(kokoro, text: str, voice: str, speed: float):
    try:
        return kokoro.create(text, voice, speed, "en-us")
    except Exception:
        # Unknown voice id — e.g. a Google voice name reaching us from a cached
        # older client build. Don't drop the whole utterance over the name.
        if voice == _DEFAULT_VOICE:
            raise
        print(f"[Kokoro] unknown voice {voice!r}, using {_DEFAULT_VOICE}", flush=True)
        return kokoro.create(text, _DEFAULT_VOICE, speed, "en-us")


def _to_wav(samples, sample_rate: int) -> bytes:
    """Float samples -> a complete 16-bit mono WAV, the shape the client expects."""
    import numpy as np

    # Clip before the int16 cast: Kokoro can emit slightly over +/-1.0, and
    # numpy wraps rather than saturates, turning a loud syllable into a burst
    # of noise at the opposite polarity.
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


async def synthesize(text: str, voice: str = _DEFAULT_VOICE, speed: float = 1.0) -> bytes:
    """Return a complete WAV file's bytes for `text`."""
    kokoro = await _instance()
    loop = asyncio.get_running_loop()
    samples, sample_rate = await loop.run_in_executor(
        _executor, _create, kokoro, text, voice, max(0.25, min(4.0, speed))
    )
    return _to_wav(samples, sample_rate)


async def prewarm() -> None:
    """Download the weights and build the session ahead of the first request.

    Called as a background task from main.py's lifespan so the first spoken
    question isn't stuck behind a ~353 MB download mid-interview.
    """
    await _instance()
