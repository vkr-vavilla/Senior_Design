"""
Execution-backend dispatcher.

`grade_submission` calls `run_program` from here; this module forwards to the
backend chosen by the `CODE_EXECUTOR` env var:

    CODE_EXECUTOR=local    -> coding.local_executor  (subprocess; default)
    CODE_EXECUTOR=judge0   -> coding.judge0_client    (Judge0 REST; needs cgroup v1)

All backends share the same signature and return the same result dict shape, so
swapping them needs no other code changes. Default is `local` because Judge0's
isolate sandbox can't run on a cgroup v2 host.
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
    else:
        from coding.local_executor import run_program as _run
    return await _run(source_code, stdin, language_id, **kwargs)
