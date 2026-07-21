"""
Execution-backend dispatcher.

`grade_submission` calls `run_program` from here; this module forwards to the
backend chosen by the `CODE_EXECUTOR` env var:

    CODE_EXECUTOR=judge0   -> coding.judge0_client     (Judge0 REST; sandboxed)
    CODE_EXECUTOR=piston   -> coding.piston_client     (Piston REST; sandboxed)
    CODE_EXECUTOR=local    -> coding.local_executor    (subprocess; no isolation)

All backends share the same signature and return the same result dict shape, so
swapping them needs no other code changes. The code default is `local` so a bare
`uvicorn` dev run works without any external service — but `local` runs code
in-process with no isolation, so it is for trusted/demo use only. Production
deployments should set `judge0` or `piston` (real sandboxes).
"""
import os

from coding.driver import PYTHON3_LANGUAGE_ID


async def run_program(
    source_code: str,
    stdin: str,
    language_id: int = PYTHON3_LANGUAGE_ID,
    **kwargs,
) -> dict:
    backend = os.getenv("CODE_EXECUTOR", "local").lower()
    if backend == "judge0":
        from coding.judge0_client import run_program as _run
    elif backend == "piston":
        from coding.piston_client import run_program as _run
    else:
        from coding.local_executor import run_program as _run
    return await _run(source_code, stdin, language_id, **kwargs)
