"""
Local proof that the driver works — no Judge0, no DB required.

    python3 backend/coding/_selftest.py

Builds the full program for several representative problem shapes (int arrays,
linked list, binary tree, string/bool), runs each with the real Python
interpreter, and checks the printed output matches the expected example results.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from driver import build_program  # noqa: E402

# (label, meta_data, user_code, stdin, expected_lines)
CASES = [
    (
        "Two Sum (integer[] + integer -> integer[])",
        {
            "name": "twoSum",
            "params": [
                {"name": "nums", "type": "integer[]"},
                {"name": "target", "type": "integer"},
            ],
            "return": {"type": "integer[]"},
        },
        "class Solution:\n"
        "    def twoSum(self, nums: List[int], target: int) -> List[int]:\n"
        "        seen = {}\n"
        "        for i, x in enumerate(nums):\n"
        "            if target - x in seen:\n"
        "                return [seen[target - x], i]\n"
        "            seen[x] = i\n",
        "[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6",
        ["[0,1]", "[1,2]", "[0,1]"],
    ),
    (
        "Add Two Numbers (ListNode + ListNode -> ListNode)",
        {
            "name": "addTwoNumbers",
            "params": [
                {"name": "l1", "type": "ListNode"},
                {"name": "l2", "type": "ListNode"},
            ],
            "return": {"type": "ListNode"},
        },
        "class Solution:\n"
        "    def addTwoNumbers(self, l1, l2):\n"
        "        dummy = ListNode()\n"
        "        cur, carry = dummy, 0\n"
        "        while l1 or l2 or carry:\n"
        "            s = (l1.val if l1 else 0) + (l2.val if l2 else 0) + carry\n"
        "            carry, d = divmod(s, 10)\n"
        "            cur.next = ListNode(d); cur = cur.next\n"
        "            l1 = l1.next if l1 else None\n"
        "            l2 = l2.next if l2 else None\n"
        "        return dummy.next\n",
        "[2,4,3]\n[5,6,4]",
        ["[7,0,8]"],
    ),
    (
        "Invert Binary Tree (TreeNode -> TreeNode)",
        {
            "name": "invertTree",
            "params": [{"name": "root", "type": "TreeNode"}],
            "return": {"type": "TreeNode"},
        },
        "class Solution:\n"
        "    def invertTree(self, root):\n"
        "        if not root:\n"
        "            return None\n"
        "        root.left, root.right = self.invertTree(root.right), self.invertTree(root.left)\n"
        "        return root\n",
        "[4,2,7,1,3,6,9]",
        ["[4,7,2,9,6,3,1]"],
    ),
    (
        "Valid Anagram (string + string -> boolean)",
        {
            "name": "isAnagram",
            "params": [
                {"name": "s", "type": "string"},
                {"name": "t", "type": "string"},
            ],
            "return": {"type": "boolean"},
        },
        "class Solution:\n"
        "    def isAnagram(self, s: str, t: str) -> bool:\n"
        "        return Counter(s) == Counter(t)\n",
        '"anagram"\n"nagaram"\n"rat"\n"car"',
        ["true", "false"],
    ),
]


def main():
    all_ok = True
    for label, meta, code, stdin, expected in CASES:
        program = build_program(code, meta)
        proc = subprocess.run(
            [sys.executable, "-c", program],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=10,
        )
        actual = proc.stdout.split("\n")
        ok = actual == expected
        all_ok = all_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {label}")
        if not ok:
            print(f"        expected: {expected}")
            print(f"        actual:   {actual}")
            if proc.stderr.strip():
                print(f"        stderr:   {proc.stderr.strip()}")

    print()
    print("ALL PASSED" if all_ok else "SOME FAILED")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
