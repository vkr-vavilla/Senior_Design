"""Text-to-speech dispatch: one engine per deployment, chosen by TTS_BACKEND.

  "google" — Cloud TTS. The hosted deploy, where credentials come free from the
             Cloud Run service account and nothing may hold a model resident.
  "kokoro" — Kokoro-82M on CPU via ONNX. The downloadable package, which has no
             Google credentials and must work offline.

Both engines raise `TTSUnavailable` when this machine can't do server-side
voice at all. /chat/synthesize turns that into a 503 the client treats as
"voice off", falling back to the browser's own speech synthesis — so the
interview never depends on either engine being present.

The exception lives here rather than in an engine module so the router can
catch one type regardless of which engine is configured.
"""
from config import TTS_BACKEND


class TTSUnavailable(RuntimeError):
    """Server-side voice can't run here (no credentials, no weights, no deps).

    Normal on local/desktop installs, not an error worth a 500 — the caller
    downgrades it to a 503 and the interview continues without spoken audio.
    """


async def synthesize(text: str, voice: str, speed: float = 1.0) -> bytes:
    """Return a complete WAV file's bytes for `text`, via the configured engine."""
    # Imported per call, not at module load: each engine's SDK is installed in
    # only one of the two images (kokoro-onnx is absent from the hosted build,
    # by design), so importing both eagerly would break whichever image is
    # missing one — even when TTS_BACKEND never selects it.
    try:
        if TTS_BACKEND == "kokoro":
            from tts_kokoro import synthesize as _synthesize
        else:
            from tts_google import synthesize as _synthesize
    except ImportError as e:
        # A misconfigured TTS_BACKEND for this image. Surface it as "no voice
        # here" (503 -> browser fallback) rather than a 500 on every turn.
        raise TTSUnavailable(
            f"TTS_BACKEND={TTS_BACKEND!r} but its dependencies aren't installed "
            f"in this image: {e}"
        ) from e
    return await _synthesize(text, voice, speed)
