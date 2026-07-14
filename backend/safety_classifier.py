"""
safety_classifier.py
────────────────────
Two-stage prompt safety gate that runs BEFORE every user message reaches
the main LLM.

Stage 1 – Local heuristic pre-filter (zero-latency)
  A compact keyword + regex screen that instantly catches the most obvious
  unsafe inputs (slurs, explicit harm requests, prompt-injection attempts,
  etc.) without any network call.  If Stage 1 is clean, we proceed to
  Stage 2.

Stage 2 – Llama Guard 3 8B via Groq API (best small safety model available)
  Llama Guard 3 8B is Meta's purpose-built safety classifier.  It is one of
  the strongest *dedicated* safety models available and is served by Groq at
  very low latency.  Falls back to SAFE if Groq is unavailable so the main
  interview is never blocked by a classifier outage.

Usage
─────
    from safety_classifier import classify_prompt, SafetyResult

    result = await classify_prompt(user_message)
    if not result.is_safe:
        # block the message – return result.reason to the client
        ...
"""

from __future__ import annotations

import os
import re
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────

# Set SAFETY_CLASSIFIER_ENABLED=false to disable the gate entirely (dev only).
SAFETY_ENABLED: bool = os.getenv("SAFETY_CLASSIFIER_ENABLED", "true").lower() == "true"

# Groq API key (reused from config so no extra env var is needed).
_GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")

# Llama Guard 3 8B is Meta's dedicated, publicly available safety classifier.
# It is one of the best small safety models available and runs on Groq for
# very low latency inference.
_LLAMA_GUARD_MODEL = "llama-guard-3-8b"

# ── Result dataclass ───────────────────────────────────────────────────────────


@dataclass
class SafetyResult:
    is_safe: bool
    label: str          # "safe" | "unsafe"
    category: str       # Llama Guard hazard category, or "heuristic", or "ok"
    reason: str         # Human-readable explanation sent back to the user
    stage: str          # "heuristic" | "llama_guard" | "fallback"
    raw: dict = field(default_factory=dict)  # Raw classifier output for logging


_SAFE_RESULT = SafetyResult(
    is_safe=True,
    label="safe",
    category="ok",
    reason="",
    stage="fallback",
)

# ── Stage 1 – Local heuristic pre-filter ──────────────────────────────────────

# We only hard-block here on things that are *obviously* harmful and not
# ambiguous — this keeps false-positive rates very low.
_HEURISTIC_PATTERNS: list[tuple[re.Pattern, str]] = [
    (
        re.compile(
            r"\b(how\s+to|steps\s+to|guide\s+to|make|build|create|synthesize)\b.{0,60}"
            r"\b(bomb|explosive|bioweapon|chemical\s+weapon|nerve\s+agent|ricin|meth|fentanyl)\b",
            re.IGNORECASE,
        ),
        "Requests for instructions to create weapons or dangerous substances are not permitted.",
    ),
    (
        re.compile(
            r"\b(kill|murder|assassinate|stab|shoot)\b.{0,40}\b(someone|person|people|them|he|she|my)\b",
            re.IGNORECASE,
        ),
        "Messages that solicit or describe violence against individuals are not permitted.",
    ),
    (
        re.compile(
            r"\b(child|kid|minor|underage).{0,30}\b(sex|nude|naked|explicit|porn)\b",
            re.IGNORECASE,
        ),
        "Content involving minors in a sexual context is strictly prohibited.",
    ),
    (
        re.compile(
            r"\b(ignore|forget|disregard|override|bypass|jailbreak)\b.{0,60}"
            r"\b(previous\s+instructions?|system\s+prompt|rules?|guidelines?|constraints?)\b",
            re.IGNORECASE,
        ),
        "Prompt injection attempts are not permitted.",
    ),
    (
        re.compile(
            r"\b(you\s+are\s+now|pretend\s+you\s+are|act\s+as|roleplay\s+as|simulate)\b.{0,60}"
            r"\b(evil|unethical|no\s+rules?|no\s+restrictions?|unrestricted|DAN|jailbreak)\b",
            re.IGNORECASE,
        ),
        "Requests to adopt an unethical or unrestricted persona are not permitted.",
    ),
    (
        re.compile(
            r"\b(hack|exploit|sql\s+injection|xss|cross.site|remote\s+code\s+execution)\b.{0,60}"
            r"\b(steal|exfiltrate|pwn|own|compromise|bypass\s+auth)\b",
            re.IGNORECASE,
        ),
        "Requests for malicious hacking or cyberattack assistance are not permitted.",
    ),
]


def _heuristic_check(text: str) -> SafetyResult | None:
    """Return a SafetyResult only if the heuristic fires; None means clean."""
    for pattern, reason in _HEURISTIC_PATTERNS:
        if pattern.search(text):
            return SafetyResult(
                is_safe=False,
                label="unsafe",
                category="heuristic",
                reason=reason,
                stage="heuristic",
            )
    return None


# ── Stage 2 – Llama Guard 3 8B via Groq ───────────────────────────────────────

# Llama Guard uses a specific prompt template.  We send the user message as a
# single human turn and ask the model to classify it.
_LLAMA_GUARD_SYSTEM = (
    "You are a safety classifier. Classify whether the following message is "
    "safe or unsafe according to Meta's Llama Guard 3 policy. "
    "Respond with exactly one word: 'safe' or 'unsafe', optionally followed "
    "by a space and the hazard category code (e.g. 'unsafe S1')."
)

# Mapping of Llama Guard S-codes to human-readable categories.
_CATEGORY_MAP: dict[str, str] = {
    "S1": "Violent Crimes",
    "S2": "Non-Violent Crimes",
    "S3": "Sex-Related Crimes",
    "S4": "Child Sexual Exploitation",
    "S5": "Defamation",
    "S6": "Specialized Advice (medical/legal/financial)",
    "S7": "Privacy Violations",
    "S8": "Intellectual Property",
    "S9": "Indiscriminate Weapons (CBRN)",
    "S10": "Hate Speech",
    "S11": "Suicide/Self-Harm",
    "S12": "Sexual Content",
    "S13": "Elections",
    "S14": "Code Interpreter Abuse",
}

_UNSAFE_USER_MESSAGE = (
    "I'm sorry, but I can't respond to that message — it was flagged as "
    "potentially unsafe. Please keep the conversation focused on your "
    "interview preparation. If you believe this is a mistake, try rephrasing."
)


def _parse_llama_guard_response(raw_text: str) -> tuple[bool, str, str]:
    """
    Parse Llama Guard output into (is_safe, label, category).
    Llama Guard responds with 'safe' or 'unsafe [Sxx]'.
    """
    text = raw_text.strip().lower()
    if text.startswith("safe"):
        return True, "safe", "ok"

    if text.startswith("unsafe"):
        # Try to extract the S-code
        match = re.search(r"\bS(\d+)\b", raw_text, re.IGNORECASE)
        if match:
            code = f"S{match.group(1)}"
            category = _CATEGORY_MAP.get(code, f"Hazard {code}")
        else:
            category = "Unspecified"
        return False, "unsafe", category

    # Ambiguous — default to safe to avoid false positives
    logger.warning("[SafetyClassifier] Ambiguous Llama Guard response: %r", raw_text)
    return True, "safe", "ok"


async def _llama_guard_check(text: str) -> SafetyResult:
    """Call Llama Guard 3 8B on Groq.  Returns safe fallback on any error."""
    if not _GROQ_API_KEY:
        logger.debug("[SafetyClassifier] No GROQ_API_KEY — skipping Llama Guard check.")
        return _SAFE_RESULT

    try:
        from groq import AsyncGroq  # groq is already a project dependency

        client = AsyncGroq(api_key=_GROQ_API_KEY)
        response = await client.chat.completions.create(
            model=_LLAMA_GUARD_MODEL,
            messages=[
                {"role": "system", "content": _LLAMA_GUARD_SYSTEM},
                {"role": "user", "content": text},
            ],
            max_tokens=20,        # we only need one word + optional code
            temperature=0.0,      # deterministic — this is a classifier
        )
        raw_reply = response.choices[0].message.content or ""
        is_safe, label, category = _parse_llama_guard_response(raw_reply)

        logger.info(
            "[SafetyClassifier] Llama Guard result: label=%s category=%s raw=%r",
            label, category, raw_reply,
        )

        if is_safe:
            return SafetyResult(
                is_safe=True,
                label="safe",
                category=category,
                reason="",
                stage="llama_guard",
                raw={"reply": raw_reply},
            )
        else:
            return SafetyResult(
                is_safe=False,
                label="unsafe",
                category=category,
                reason=_UNSAFE_USER_MESSAGE,
                stage="llama_guard",
                raw={"reply": raw_reply},
            )

    except Exception as exc:
        # Never let classifier errors block a legitimate interview.
        logger.warning("[SafetyClassifier] Llama Guard call failed (%s) — defaulting to safe.", exc)
        return SafetyResult(
            is_safe=True,
            label="safe",
            category="ok",
            reason="",
            stage="fallback",
            raw={"error": str(exc)},
        )


# ── Public API ─────────────────────────────────────────────────────────────────


async def classify_prompt(text: str) -> SafetyResult:
    """
    Run the two-stage safety check on a user message.

    Returns a SafetyResult.  Callers should check `result.is_safe`.
    If False, send `result.reason` back to the user and skip the main LLM.

    This function NEVER raises — all errors default to safe so a classifier
    outage never blocks a legitimate interview session.
    """
    if not SAFETY_ENABLED:
        return _SAFE_RESULT

    if not text or not text.strip():
        return _SAFE_RESULT

    # Stage 1 – instant heuristic (no I/O)
    heuristic_result = _heuristic_check(text)
    if heuristic_result is not None:
        logger.info(
            "[SafetyClassifier] Heuristic blocked message: category=%s",
            heuristic_result.category,
        )
        return heuristic_result

    # Stage 2 – Llama Guard 3 8B (async API call)
    return await _llama_guard_check(text)
