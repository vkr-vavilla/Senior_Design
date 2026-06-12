"""
Adapter that maps a document from the `leetcode` collection (our stored problem
bank) into the internal shape the rest of the coding round expects.

The stored docs look like:
    { slug, title, difficulty: "Easy"|"Medium"|"Hard", tags: [...],
      description: "<plain text>", constraints: [...],
      examples: [ { input: "nums = [2,7,11,15], target = 9",
                    output: "[0,1]", explanation: "..." }, ... ] }

But the driver / grader / frontend were built around a richer shape with
`code_snippets.python3`, `meta_data` (function name + params), `content_html`,
`example_testcases` (stdin) and expected outputs. None of those are stored, so we
*derive* them here:

  - method name  <- camelCase(slug)        (LeetCode's own convention)
  - params       <- parsed from examples[0].input ("name = value, ...")
  - starter code <- `class Solution: def <name>(self, <params>): ...`
  - stdin tests  <- each example's values, one JSON value per line (what driver reads)
  - expected     <- each example's `output`
  - content_html <- description + examples + constraints, rendered to simple HTML

Linked-list / tree problems can't be driven this way (we'd need ListNode/TreeNode
typing that isn't in the data); selection.py filters those out by tag.
"""
import html
import json
import re

# Matches each "name =" marker in an example input like "nums = [...], target = 9".
_ASSIGN_RE = re.compile(r"([A-Za-z_]\w*)\s*=\s*")


def _method_name(slug: str) -> str:
    """LeetCode slug -> camelCase method name: 'two-sum' -> 'twoSum'."""
    parts = [p for p in (slug or "problem").split("-") if p]
    if not parts:
        return "solve"
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _split_input(input_str: str) -> list:
    """Parse 'nums = [2,7,11,15], target = 9' -> [('nums','[2,7,11,15]'), ('target','9')].

    We split on the `name =` markers (not commas) so commas inside arrays don't
    break parsing. Inputs with no `name =` are treated as a single argument.
    """
    text = input_str or ""
    matches = list(_ASSIGN_RE.finditer(text))
    if not matches:
        stripped = text.strip()
        return [("arg0", stripped)] if stripped else []
    pairs = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        value = text[start:end].strip().rstrip(",").strip()
        pairs.append((m.group(1), value))
    return pairs


def _infer_type(value_text: str) -> str:
    """Best-effort type label for display/metadata. The driver only special-cases
    ListNode/TreeNode (excluded upstream), so plain labels are cosmetic."""
    try:
        v = json.loads(value_text)
    except (ValueError, TypeError):
        return "string"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "double"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        if v and isinstance(v[0], list):
            return "integer[][]"
        if v and isinstance(v[0], str):
            return "string[]"
        return "integer[]"
    return "string"


def _json_line(value_text: str) -> str:
    """Normalize one input value into a compact JSON line for the driver's stdin."""
    try:
        return json.dumps(json.loads(value_text), separators=(",", ":"))
    except (ValueError, TypeError):
        return value_text


def _build_content_html(doc: dict) -> str:
    desc = html.escape(doc.get("description") or "").replace("\n", "<br/>")
    parts = [f"<p>{desc}</p>"] if desc else []
    for i, ex in enumerate(doc.get("examples") or [], 1):
        inp = html.escape(str(ex.get("input", "")))
        out = html.escape(str(ex.get("output", "")))
        block = (
            f"<p><strong>Example {i}:</strong></p>"
            f"<pre><strong>Input:</strong> {inp}\n<strong>Output:</strong> {out}"
        )
        if ex.get("explanation"):
            block += "\n<strong>Explanation:</strong> " + html.escape(str(ex["explanation"]))
        block += "</pre>"
        parts.append(block)
    constraints = doc.get("constraints")
    if constraints:
        if isinstance(constraints, list):
            items = "".join(f"<li>{html.escape(str(c))}</li>" for c in constraints)
            parts.append(f"<p><strong>Constraints:</strong></p><ul>{items}</ul>")
        else:
            parts.append(f"<p><strong>Constraints:</strong> {html.escape(str(constraints))}</p>")
    return "".join(parts)


def normalize_problem(doc: dict) -> dict:
    """Return `doc` enriched with the fields the driver/grader/frontend need.

    Idempotent: a doc that already carries a python starter + meta_data (e.g. from
    the scraper) is returned unchanged.
    """
    if not doc:
        return doc
    if (doc.get("code_snippets") or {}).get("python3") and (doc.get("meta_data") or {}).get("name"):
        return doc

    examples = doc.get("examples") or []
    first_pairs = _split_input(examples[0].get("input", "")) if examples else []
    name = _method_name(doc.get("slug"))
    ret_type = _infer_type(examples[0].get("output", "")) if examples else "integer"

    meta_data = {
        "name": name,
        "params": [{"name": n, "type": _infer_type(v)} for n, v in first_pairs],
        "return": {"type": ret_type},
    }

    stdin_lines = []
    for ex in examples:
        for _, value in _split_input(ex.get("input", "")):
            stdin_lines.append(_json_line(value))

    arg_list = ", ".join(n for n, _ in first_pairs) or "*args"
    starter = f"class Solution:\n    def {name}(self, {arg_list}):\n        "

    return {
        **doc,
        "difficulty": (doc.get("difficulty") or "").lower(),
        "topic_tags": doc.get("topic_tags") or doc.get("tags") or [],
        "content_html": doc.get("content_html") or _build_content_html(doc),
        "code_snippets": {"python3": starter},
        "meta_data": meta_data,
        "example_testcases": "\n".join(stdin_lines),
        "expected_outputs": [str(ex.get("output", "")) for ex in examples],
        "hints": doc.get("hints") or [],
    }
