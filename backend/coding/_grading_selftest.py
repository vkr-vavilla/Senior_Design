"""
Local proof for the HTML output parser + comparison (no Judge0 needed).

    cd backend && python3 -m coding._grading_selftest
"""
from coding.grading import compare_results, parse_expected_outputs

# Realistic LeetCode-style HTML (note the deliberate space in "[0, 1]" to prove
# JSON normalization makes it still match the driver's compact "[0,1]").
TWO_SUM_HTML = """
<p>Given an array <code>nums</code> ...</p>
<p><strong class="example">Example 1:</strong></p>
<pre><strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0, 1]
<strong>Explanation:</strong> nums[0] + nums[1] == 9.
</pre>
<p><strong class="example">Example 2:</strong></p>
<pre><strong>Input:</strong> nums = [3,2,4], target = 6
<strong>Output:</strong> [1,2]
</pre>
<p><strong class="example">Example 3:</strong></p>
<pre><strong>Input:</strong> nums = [3,3], target = 6
<strong>Output:</strong> [0,1]
</pre>
"""


def check(label, ok):
    print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    return ok


def main():
    ok = True

    expected = parse_expected_outputs(TWO_SUM_HTML)
    ok &= check(f"parser extracts 3 outputs -> {expected}", expected == ["[0, 1]", "[1,2]", "[0,1]"])

    # All correct (driver prints compact JSON; spacing normalized away).
    cases = compare_results(["[0,1]", "[1,2]", "[0,1]"], expected)
    ok &= check("all 3 cases pass (spacing normalized)", all(c["passed"] for c in cases))

    # One wrong answer.
    cases = compare_results(["[0,1]", "[9,9]", "[0,1]"], expected)
    ok &= check("wrong answer on case 2 is detected", [c["passed"] for c in cases] == [True, False, True])

    # A runtime error on a case is flagged, not counted as pass.
    cases = compare_results(["[0,1]", "__RUNTIME_ERROR__ IndexError()", "[0,1]"], expected)
    flagged = cases[1]["runtime_error"] and not cases[1]["passed"]
    ok &= check("runtime error on case 2 is flagged", flagged)

    print()
    print("ALL PASSED" if ok else "SOME FAILED")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
