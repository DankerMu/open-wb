#!/usr/bin/env python3
"""Gate this skill's own content invariants.

eng-init tells target repos that every mechanically checkable promise gets a
command that exits non-zero. This is that command for eng-init itself: it
asserts the content invariants recorded in `evals/content-checks.json` —
each rule, template, and criterion that a change could silently drop.

Usage:
    python3 scripts/check_skill_content.py [--checks PATH] [--list]

Exit code is the gate: 0 when every case passes, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate_output import report  # noqa: E402

SKILL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CHECKS = SKILL_ROOT / "evals" / "content-checks.json"


def run_check(check: dict, skill_root: Path) -> tuple[bool, str]:
    """Evaluate one assertion. Returns (passed, evidence-or-reason)."""
    path = skill_root / check["file"]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"unreadable {check['file']}: {exc}"
    pattern = check["pattern"]
    kind = check["type"]
    flags = re.MULTILINE | (re.IGNORECASE if "i" in check.get("flags", "") else 0)
    if kind == "contains":
        return pattern in text, pattern
    if kind == "regex":
        return re.search(pattern, text, flags) is not None, pattern
    # Absence assertions: some invariants are about a bad pattern staying gone.
    # A defect that was fixed by deleting something can only be pinned this way.
    if kind == "not_contains":
        return pattern not in text, f"must be absent: {pattern}"
    if kind == "not_regex":
        return re.search(pattern, text, flags) is None, f"must be absent: {pattern}"
    raise ValueError(f"unknown check type {kind!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checks", type=Path, default=DEFAULT_CHECKS)
    parser.add_argument("--list", action="store_true", help="print case ids and exit 0")
    args = parser.parse_args()

    document = json.loads(args.checks.read_text(encoding="utf-8"))
    cases = document["cases"] if isinstance(document, dict) else document

    if args.list:
        for case in cases:
            print(f"{case['id']}: {case['desc']}")
        return 0

    errors: list[str] = []
    for case in cases:
        misses = [
            f"[{check['type']}] {info[:70]}"
            for check in case["checks"]
            for passed, info in [run_check(check, SKILL_ROOT)]
            if not passed
        ]
        if misses:
            errors.append(
                f"{case['id']}: {case['desc']}\n"
                + "\n".join(f"    missing {m}" for m in misses)
                + "\n    restore the rule, or update this check in the same change that intentionally removed it"
            )
    return report("check-skill-content", errors,
                  f"{len(cases)} content invariants hold")


if __name__ == "__main__":
    sys.exit(main())
