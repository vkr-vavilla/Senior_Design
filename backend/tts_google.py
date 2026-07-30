"""
Google Cloud Text-to-Speech client — the engine for the hosted deploy
(TTS_BACKEND=google, the default).

Used here instead of the self-hosted Kokoro model, which held ~2GB of the
container's memory resident for its entire lifetime (loaded at startup, never
freed) — the direct cause of repeated Cloud Run OOM kills during live
interviews. This is a stateless API call instead: no model in memory, nothing
to pre-warm or crash.

That memory ceiling is a hosted-runtime constraint, so the downloadable package
still runs Kokoro locally (TTS_BACKEND=kokoro, see tts_kokoro.py) where there
are no Google credentials to authenticate with.

Auth: Application Default Credentials. On Cloud Run this is automatic via the
attached service account — no key file needed — as long as the "Cloud
Text-to-Speech API" is enabled on the project and the Cloud Run service
account has the "Cloud Text-to-Speech API User" role. For local dev, run
`gcloud auth application-default login` once.

Free tier: 4M characters/month free for Standard and WaveNet voices (no
expiration), which is what `_VOICE_MAP` below uses.
"""
import asyncio

from google.cloud import texttospeech

# Shared with tts_kokoro so routers/chat.py catches one type whichever engine
# TTS_BACKEND selects. Re-exported here because callers used to import it from
# this module. Local/desktop installs have no service account and most users
# will never run `gcloud auth application-default login`, so raising it is the
# normal state there — see tts.py. Those installs should set TTS_BACKEND=kokoro,
# which needs no credentials at all.
from tts import TTSUnavailable  # noqa: F401

_client = None
_unavailable_reason: str | None = None


def _get_client() -> texttospeech.TextToSpeechClient:
    global _client, _unavailable_reason
    if _unavailable_reason is not None:
        raise TTSUnavailable(_unavailable_reason)
    if _client is None:
        try:
            _client = texttospeech.TextToSpeechClient()
        except Exception as e:
            # Cache it: without credentials this fails identically every turn,
            # and retrying per request adds latency to every single reply.
            _unavailable_reason = (
                "Voice needs Google Cloud Text-to-Speech credentials, which this "
                "install doesn't have. The interview works normally without it. "
                "To enable voice, run `gcloud auth application-default login` or "
                "set GOOGLE_APPLICATION_CREDENTIALS to a service-account key."
            )
            raise TTSUnavailable(_unavailable_reason) from e
    return _client


# Kokoro voice names (e.g. "am_michael") the frontend already sends -> Google
# Standard voices (free-tier eligible). Extend as needed.
_VOICE_MAP = {
    "am_michael": "en-US-Standard-D",
    "af_heart": "en-US-Standard-F",
}
_DEFAULT_VOICE = "en-US-Standard-D"


def _synthesize_sync(text: str, voice: str, speed: float) -> bytes:
    client = _get_client()
    input_text = texttospeech.SynthesisInput(text=text)
    voice_params = texttospeech.VoiceSelectionParams(
        language_code="en-US",
        name=_VOICE_MAP.get(voice, _DEFAULT_VOICE),
    )
    # LINEAR16 returns a complete WAV file (header + PCM) — same shape the
    # frontend already expects from Kokoro, so no response handling changes.
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.LINEAR16,
        speaking_rate=max(0.25, min(4.0, speed)),
    )
    response = client.synthesize_speech(
        input=input_text, voice=voice_params, audio_config=audio_config
    )
    return response.audio_content


async def synthesize(text: str, voice: str = _DEFAULT_VOICE, speed: float = 1.0) -> bytes:
    """Return a complete WAV file's bytes for `text`."""
    return await asyncio.to_thread(_synthesize_sync, text, voice, speed)
