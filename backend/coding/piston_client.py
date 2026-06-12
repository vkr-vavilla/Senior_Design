"""
Async client for a self-hosted Piston code-execution sandbox.

Piston runs each submission in an isolated sandbox (its own cgroup + namespace),
so unlike `local_executor` (which runs code in the backend process) this is safe
for untrusted code, and it runs on a stock cgroup v2 host with no kernel changes.
Reachable at $PISTON_URL (http://piston:2000 inside the compose network).

Returns the SAME result dict shape as local_executor
(stdout / stderr / compile_output / status{id,description} / time / memory), so the
grader and frontend need no changes. Which backend is used is decided by the
`CODE_EXECUTOR` env var (see `coding/executor.py`).

NOTE: the LeetCode driver harness (`coding/driver.py`) is Python-only, so only
Python submissions GRADE correctly today. Other languages execute fine here but
need their own driver before they can be graded.
"""
import os

import httpx

from coding.driver import PYTHON3_LANGUAGE_ID

PISTON_URL = os.getenv("PISTON_URL", "http://localhost:2000")

# Numeric language id -> (Piston language name, source filename).
# The runtime version is resolved from /api/v2/runtimes so we never pin one that
# may not be installed.
_LANG: dict[int, tuple[str, str]] = {
    71: ("python", "main.py"),       # Python 3
    63: ("javascript", "main.js"),   # Node
    74: ("typescript", "main.ts"),
    50: ("c", "main.c"),
    54: ("c++", "main.cpp"),
    62: ("java", "Main.java"),
    60: ("go", "main.go"),
    73: ("rust", "main.rs"),
}

# language/alias -> installed version, filled once from /api/v2/runtimes.
_runtimes_cache: dict[str, str] = {}


def _err(msg: str) -> dict:
    return {
        "stdout": None,
        "stderr": msg,
        "compile_output": None,
        "status": {"id": 13, "description": "Internal Error"},
        "time": None,
        "memory": None,
        "token": None,
    }


async def _resolve_version(client: httpx.AsyncClient, language: str) -> str:
    """Return an installed Piston version for `language` (cached)."""
    if not _runtimes_cache:
        r = await client.get("/api/v2/runtimes")
        r.raise_for_status()
        for rt in r.json():
            for name in (rt["language"], *rt.get("aliases", [])):
                _runtimes_cache.setdefault(name, rt["version"])
    return _runtimes_cache.get(language, "")


def _to_result(data: dict) -> dict:
    """Translate a Piston /execute response into the standard result dict shape."""
    compile_stage = data.get("compile") or {}
    run_stage = data.get("run") or {}

    # Compiled languages: a non-zero compile stage is a compilation error.
    if compile_stage and compile_stage.get("code", 0) != 0:
        return {
            "stdout": None,
            "stderr": compile_stage.get("stderr"),
            "compile_output": compile_stage.get("output") or compile_stage.get("stderr"),
            "status": {"id": 6, "description": "Compilation Error"},
            "time": None, "memory": None, "token": None,
        }

    code = run_stage.get("code", 0)
    signal = run_stage.get("signal")
    stdout = run_stage.get("stdout", "")
    stderr = run_stage.get("stderr", "")

    if signal == "SIGKILL":
        # Piston kills on timeout / memory overrun.
        status = {"id": 5, "description": "Time Limit Exceeded"}
    elif code != 0:
        status = {"id": 11, "description": "Runtime Error (NZEC)"}
    else:
        status = {"id": 3, "description": "Accepted"}

    return {
        "stdout": stdout,
        "stderr": stderr,
        "compile_output": None,
        "status": status,
        "time": None, "memory": None, "token": None,
    }


async def run_program(
    source_code: str,
    stdin: str,
    language_id: int = PYTHON3_LANGUAGE_ID,
    *,
    cpu_time_limit: float = 5.0,
    wall_time_limit: float = 10.0,
    memory_limit: int = 256000,
    poll_interval: float = 0.4,
    timeout: float = 30.0,
) -> dict:
    """Run `source_code` against `stdin` in Piston; return the standard result shape."""
    entry = _LANG.get(language_id)
    if not entry:
        return _err(f"Piston backend has no language mapping for language_id={language_id}.")
    language, filename = entry

    async with httpx.AsyncClient(base_url=PISTON_URL, timeout=timeout) as client:
        try:
            version = await _resolve_version(client, language)
        except httpx.HTTPError as exc:
            return _err(f"Could not reach Piston at {PISTON_URL}: {exc}")
        if not version:
            return _err(
                f"Piston has no installed runtime for '{language}'. "
                f"Install it, e.g.: POST {PISTON_URL}/api/v2/packages "
                f'{{\"language\":\"{language}\",\"version\":\"...\"}}'
            )

        payload = {
            "language": language,
            "version": version,
            "files": [{"name": filename, "content": source_code or ""}],
            "stdin": stdin or "",
            "compile_timeout": int(wall_time_limit * 1000),
            "run_timeout": int(wall_time_limit * 1000),
        }
        resp = await client.post("/api/v2/execute", json=payload)
        resp.raise_for_status()
        return _to_result(resp.json())
