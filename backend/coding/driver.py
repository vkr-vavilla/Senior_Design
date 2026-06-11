"""
Python driver that bridges LeetCode's function-call format to Judge0's
stdin/stdout model.

LeetCode hands the candidate a method to fill in:

    class Solution:
        def twoSum(self, nums: List[int], target: int) -> List[int]:

Judge0 only runs a *program* (stdin -> stdout). So for every run we build:

    [ HEADER ]   typing + collections imports, ListNode / TreeNode defs
    [ USER CODE] the candidate's `class Solution`
    [ FOOTER ]   reads the test input from stdin, deserializes each argument
                 according to the problem's `meta_data`, calls the method, and
                 prints one normalized JSON line per test case.

The footer chunks stdin into groups of `len(params)` lines (LeetCode puts one
JSON value per line), so a single Judge0 submission grades *all* example cases.
Each case is wrapped in try/except, so one crash doesn't lose the other results.

`build_program(user_code, meta_data)` returns the full source string to send to
Judge0. `normalize_output(s)` canonicalizes a value for comparison.
"""
import json

# Judge0 language id for Python 3 (in the 1.13.x language table).
PYTHON3_LANGUAGE_ID = 71

# Sentinel a case prints when the user's code raised at runtime.
RUNTIME_ERROR_PREFIX = "__RUNTIME_ERROR__"


# Mirrors LeetCode's Python sandbox: typing + common libs pre-imported, and the
# ListNode / TreeNode classes defined so the candidate's code can reference them.
_HEADER = '''\
import sys, json
from typing import List, Optional, Dict, Tuple, Set, Any
from collections import deque, defaultdict, Counter, OrderedDict
import collections, heapq, bisect, math, functools, itertools, re, string


class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next


class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
'''


# Appended after the user's Solution. `__META_JSON_LITERAL__` is replaced by
# build_program() with a safe Python string literal of the problem metadata.
_FOOTER = '''
__META__ = json.loads(__META_JSON_LITERAL__)


def _build_list(arr):
    head = None
    for v in reversed(arr or []):
        head = ListNode(v, head)
    return head


def _list_to_arr(node):
    out = []
    while node:
        out.append(node.val)
        node = node.next
    return out


def _build_tree(arr):
    arr = arr or []
    if not arr:
        return None
    root = TreeNode(arr[0])
    q = deque([root])
    i = 1
    while q and i < len(arr):
        node = q.popleft()
        if i < len(arr):
            if arr[i] is not None:
                node.left = TreeNode(arr[i]); q.append(node.left)
            i += 1
        if i < len(arr):
            if arr[i] is not None:
                node.right = TreeNode(arr[i]); q.append(node.right)
            i += 1
    return root


def _tree_to_arr(root):
    if not root:
        return []
    out, q = [], deque([root])
    while q:
        node = q.popleft()
        if node:
            out.append(node.val)
            q.append(node.left)
            q.append(node.right)
        else:
            out.append(None)
    while out and out[-1] is None:
        out.pop()
    return out


def _parse(value, typ):
    if typ == 'ListNode':
        return _build_list(value)
    if typ == 'TreeNode':
        return _build_tree(value)
    if typ == 'ListNode[]':
        return [_build_list(v) for v in (value or [])]
    if typ == 'TreeNode[]':
        return [_build_tree(v) for v in (value or [])]
    return value


def _serialize(value, typ):
    if typ == 'ListNode':
        return _list_to_arr(value)
    if typ == 'TreeNode':
        return _tree_to_arr(value)
    return value


def _run():
    raw = sys.stdin.read().split('\\n')
    if raw and raw[-1] == '':
        raw.pop()  # drop a single trailing newline
    params = __META__.get('params', [])
    n = max(1, len(params))
    name = __META__['name']
    ret_type = (__META__.get('return') or {}).get('type', '')
    results = []
    for i in range(0, len(raw), n):
        chunk = raw[i:i + n]
        if len(chunk) < n:
            break
        try:
            args = []
            for cell, p in zip(chunk, params):
                cell = cell.strip()
                val = json.loads(cell) if cell != '' else None
                args.append(_parse(val, p.get('type', '')))
            result = getattr(Solution(), name)(*args)
            results.append(json.dumps(_serialize(result, ret_type), separators=(',', ':')))
        except Exception as exc:
            results.append('__RUNTIME_ERROR__ ' + repr(exc))
    sys.stdout.write('\\n'.join(results))


_run()
'''


def build_program(user_code: str, meta_data: dict) -> str:
    """Assemble the full Judge0 program: header + user Solution + driver footer."""
    meta_json = json.dumps(meta_data or {})
    footer = _FOOTER.replace("__META_JSON_LITERAL__", repr(meta_json))
    return _HEADER + "\n" + (user_code or "").strip() + "\n" + footer


def normalize_output(value: str) -> str:
    """Canonicalize a printed value (compact JSON) so comparisons ignore spacing."""
    value = (value or "").strip()
    try:
        return json.dumps(json.loads(value), separators=(",", ":"))
    except (ValueError, TypeError):
        return value
