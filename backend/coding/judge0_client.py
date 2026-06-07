"""
Thin async client for the Judge0 REST API.

Submits one program + stdin, polls until the sandbox finishes, and returns the
raw Judge0 result dict (stdout, stderr, compile_output, status, time, memory).

Judge0 reachable at $JUDGE0_URL (set to http://judge0-server:2358 inside the
compose network; defaults to localhost:2358 for local runs).
"""
import asyncio
import os

import httpx

from coding.driver import PYTHON3_LANGUAGE_ID

JUDGE0_URL = os.getenv("JUDGE0_URL", "http://localhost:2358")

# Judge0 status ids that mean "not finished yet".
_IN_QUEUE = 1
_PROCESSING = 2


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
    """Run `source_code` against `stdin` in Judge0; return the finished result dict."""
    payload = {
        "source_code": source_code,
        "language_id": language_id,
        "stdin": stdin,
        "cpu_time_limit": cpu_time_limit,
        "wall_time_limit": wall_time_limit,
        "memory_limit": memory_limit,
    }
    async with httpx.AsyncClient(base_url=JUDGE0_URL, timeout=timeout) as client:
        created = await client.post(
            "/submissions",
            params={"base64_encoded": "false", "wait": "false"},
            json=payload,
        )
        created.raise_for_status()
        token = created.json()["token"]

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            got = await client.get(
                f"/submissions/{token}",
                params={"base64_encoded": "false"},
            )
            got.raise_for_status()
            data = got.json()
            status_id = (data.get("status") or {}).get("id", 0)
            if status_id not in (_IN_QUEUE, _PROCESSING):
                return data
            await asyncio.sleep(poll_interval)

    raise TimeoutError("Judge0 submission did not finish in time")
