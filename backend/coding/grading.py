"""
Grade a candidate's code against a problem's VISIBLE example test cases.

Flow:
  1. parse_expected_outputs() pulls the "Output: ..." values out of the problem's
     HTML statement (we only have the visible examples — LeetCode's hidden judge
     suite is not exposed via GraphQL).
  2. build_program() wraps the user's Solution with the driver.
  3. Judge0 runs it once with the example inputs as stdin; the driver prints one
     line per case.
  4. compare_results() diffs the printed lines against the expected outputs,
     normalizing JSON so spacing/format differences don't cause false failures.

NOTE: parse_expected_outputs is a heuristic over LeetCode's HTML. It handles the
common array/number/boolean outputs well; odd string-formatted answers may need
the reference-solution approach later. String outputs and "any valid answer"
problems are the known soft spots.
"""
import html
import re

from coding.driver import (
    PYTHON3_LANGUAGE_ID,
    RUNTIME_ERROR_PREFIX,
    build_program,
    normalize_output,
)

# Capture the value after "Output:" up to the end of the line (or next HTML tag).
_OUTPUT_RE = re.compile(
    r"Output:?\s*(?:</(?:strong|b|span|em|p)>)?\s*([^\n<]+)",
    re.IGNORECASE,
)


def parse_expected_outputs(content_html: str) -> list:
    """Extract the example expected outputs, in order, from a problem's HTML."""
    outputs = []
    for match in _OUTPUT_RE.finditer(content_html or ""):
        outputs.append(html.unescape(match.group(1)).strip())
    return outputs


def compare_results(actual_lines: list, expected_lines: list) -> list:
    """Diff per-case actual vs expected; return a list of case result dicts."""
    cases = []
    total = max(len(actual_lines), len(expected_lines))
    for i in range(total):
        actual = actual_lines[i] if i < len(actual_lines) else ""
        expected = expected_lines[i] if i < len(expected_lines) else ""
        runtime_error = actual.startswith(RUNTIME_ERROR_PREFIX)
        passed = (
            not runtime_error
            and bool(expected)
            and normalize_output(actual) == normalize_output(expected)
        )
        cases.append({
            "index": i,
            "passed": passed,
            "expected": expected,
            "actual": actual,
            "runtime_error": runtime_error,
        })
    return cases


async def grade_submission(
    problem: dict,
    user_code: str,
    language_id: int = PYTHON3_LANGUAGE_ID,
) -> dict:
    """Run + grade `user_code` for a problem doc against its example test cases."""
    # Imported lazily so the pure parser/compare helpers don't require httpx.
    from coding.judge0_client import run_program

    program = build_program(user_code, problem.get("meta_data") or {})
    stdin = problem.get("example_testcases") or ""

    result = await run_program(program, stdin, language_id)

    stdout = result.get("stdout") or ""
    expected = parse_expected_outputs(problem.get("content_html") or "")
    actual_lines = stdout.split("\n") if stdout else []
    cases = compare_results(actual_lines, expected)
    passed = sum(1 for c in cases if c["passed"])

    return {
        "status": (result.get("status") or {}).get("description"),
        "passed": passed,
        "total": len(cases),
        "all_passed": len(cases) > 0 and passed == len(cases),
        "cases": cases,
        "stdout": stdout,
        "stderr": result.get("stderr") or "",
        "compile_output": result.get("compile_output") or "",
        "time": result.get("time"),
        "memory": result.get("memory"),
    }
