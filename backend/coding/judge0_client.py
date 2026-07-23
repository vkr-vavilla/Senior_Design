"""
Async client for Judge0 (RapidAPI-hosted or self-hosted).

Judge0 runs each submission in its own `isolate` sandbox (cgroups + namespaces),
so like `piston_client` (and unlike `local_executor`) this is safe for untrusted
code. Reachable at $JUDGE0_URL — defaults to the RapidAPI-hosted instance, which
needs $JUDGE0_API_KEY (RapidAPI key) and $JUDGE0_API_HOST. A self-hosted Judge0
instead sets JUDGE0_URL to its own host and, if configured with auth, JUDGE0_AUTH_TOKEN.

Returns the SAME result dict shape as piston_client / local_executor
(stdout / stderr / compile_output / status{id,description} / time / memory), so
the grader and frontend need no changes. Which backend is used is decided by the
`CODE_EXECUTOR` env var (see `coding/executor.py`).

Judge0's numeric language ids and status ids ARE the convention this whole
result shape already follows (id 3 = Accepted, 5 = TLE, 6 = Compilation Error,
11 = Runtime Error, 13 = Internal Error) — this client is close to a pass-through.

NOTE: the LeetCode driver harness (`coding/driver.py`) is Python-only, so only
Python submissions GRADE correctly today. Other languages execute fine here but
need their own driver before they can be graded.
"""
import base64
import os

import httpx

from coding.driver import PYTHON3_LANGUAGE_ID

JUDGE0_URL = os.getenv("JUDGE0_URL", "https://judge0-ce.p.rapidapi.com")
JUDGE0_API_KEY = os.getenv("JUDGE0_API_KEY", "")
JUDGE0_API_HOST = os.getenv("JUDGE0_API_HOST", "judge0-ce.p.rapidapi.com")
JUDGE0_AUTH_TOKEN = os.getenv("JUDGE0_AUTH_TOKEN", "")


def _headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if JUDGE0_API_KEY:
        # RapidAPI-hosted Judge0.
        headers["X-RapidAPI-Key"] = JUDGE0_API_KEY
        headers["X-RapidAPI-Host"] = JUDGE0_API_HOST
    if JUDGE0_AUTH_TOKEN:
        # Self-hosted Judge0 with X-Auth-Token enabled.
        headers["X-Auth-Token"] = JUDGE0_AUTH_TOKEN
    return headers


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


def _b64(s: str | None) -> str | None:
    if s is None:
        return None
    return base64.b64decode(s).decode("utf-8", errors="replace")


def _to_result(data: dict) -> dict:
    return {
        "stdout": _b64(data.get("stdout")),
        "stderr": _b64(data.get("stderr")),
        "compile_output": _b64(data.get("compile_output")),
        "status": data.get("status") or {"id": 13, "description": "Internal Error"},
        "time": float(data["time"]) if data.get("time") is not None else None,
        "memory": data.get("memory"),
        "token": data.get("token"),
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
    """Run `source_code` against `stdin` on Judge0; return the standard result shape."""
    payload = {
        "source_code": base64.b64encode((source_code or "").encode()).decode(),
        "stdin": base64.b64encode((stdin or "").encode()).decode(),
        "language_id": language_id,
        "cpu_time_limit": cpu_time_limit,
        "wall_time_limit": wall_time_limit,
        "memory_limit": memory_limit,
    }

    async with httpx.AsyncClient(base_url=JUDGE0_URL, headers=_headers(), timeout=timeout) as client:
        try:
            resp = await client.post(
                "/submissions",
                params={"base64_encoded": "true", "wait": "true"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            return _err(f"Judge0 returned {exc.response.status_code}: {exc.response.text[:300]}")
        except httpx.HTTPError as exc:
            return _err(f"Could not reach Judge0 at {JUDGE0_URL}: {exc}")

        # wait=true isn't guaranteed on every host ("may not scale well" per the
        # Judge0 docs) — if it comes back still queued, poll the token instead.
        status_id = (data.get("status") or {}).get("id")
        token = data.get("token")
        if status_id in (1, 2) and token:  # 1=In Queue, 2=Processing
            import asyncio
            elapsed = 0.0
            while elapsed < timeout:
                await asyncio.sleep(poll_interval)
                elapsed += poll_interval
                r = await client.get(f"/submissions/{token}", params={"base64_encoded": "true"})
                r.raise_for_status()
                data = r.json()
                if (data.get("status") or {}).get("id") not in (1, 2):
                    break

        return _to_result(data)
