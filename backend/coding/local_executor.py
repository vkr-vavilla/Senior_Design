"""
Local Python executor — a drop-in alternative to the Piston client.

This executor runs the generated program in a plain subprocess, so code execution
works with no extra services (handy for a bare `uvicorn` dev run).

It returns the SAME result dict shape as `piston_client.run_program`
(stdout / stderr / compile_output / status{id,description} / time / memory), so
the grader and frontend need no changes. Which backend is used is decided by the
`CODE_EXECUTOR` env var (see `coding/executor.py`).

SECURITY NOTE: this runs candidate code with the backend process's privileges
(inside the backend container) — there is no real sandbox. A wall-clock timeout
and a CPU-time rlimit guard against runaway code, but this is intended for a
trusted/demo setting. For untrusted users, use the Piston backend.
"""
import asyncio
import os
import resource
import sys
import tempfile

from coding.driver import PYTHON3_LANGUAGE_ID


def _make_limits(cpu_time_limit: float):
    """Return a preexec_fn that caps child CPU time (best-effort, Linux)."""
    def _apply():
        try:
            cpu = max(1, int(cpu_time_limit) + 1)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        except (ValueError, OSError):
            pass
    return _apply


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
    """Run `source_code` against `stdin` in a local subprocess; standard result shape."""
    if language_id != PYTHON3_LANGUAGE_ID:
        return {
            "stdout": None,
            "stderr": f"Local executor only supports Python 3 (got language_id={language_id}).",
            "compile_output": None,
            "status": {"id": 13, "description": "Internal Error"},
            "time": None,
            "memory": None,
            "token": None,
        }

    # Write the program to a temp file; feed the test input on its stdin.
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(source_code or "")
        script_path = fh.name

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, script_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            preexec_fn=_make_limits(cpu_time_limit),
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate((stdin or "").encode()),
                timeout=wall_time_limit,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {
                "stdout": None,
                "stderr": None,
                "compile_output": None,
                "status": {"id": 5, "description": "Time Limit Exceeded"},
                "time": wall_time_limit,
                "memory": None,
                "token": None,
            }
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    stdout = out.decode("utf-8", errors="replace")
    stderr = err.decode("utf-8", errors="replace")

    if proc.returncode == 0:
        status = {"id": 3, "description": "Accepted"}
    elif "SyntaxError" in stderr or "IndentationError" in stderr:
        # Surface syntax problems as a compilation error (status id 6).
        return {
            "stdout": stdout,
            "stderr": stderr,
            "compile_output": stderr,
            "status": {"id": 6, "description": "Compilation Error"},
            "time": None,
            "memory": None,
            "token": None,
        }
    else:
        status = {"id": 11, "description": "Runtime Error (NZEC)"}

    return {
        "stdout": stdout,
        "stderr": stderr,
        "compile_output": None,
        "status": status,
        "time": None,
        "memory": None,
        "token": None,
    }
