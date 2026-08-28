#!/usr/bin/env python3
"""Compare each documented claim against the artifact it describes.

Commit messages and prose assert things: a section was synced, a count is N, a
threshold is X. Nothing checks them, and this session shipped a "fix" commit
whose edit silently did not apply — `str.replace` returns its input unchanged
when the anchor is absent, so the file was untouched and the message said
otherwise (postmortem 0002, instance 9). Found by comparing claims to files
rather than to the commit log; that comparison lives here now instead of in a
throwaway script.

Design rule learned the hard way: **derive both sides, never hard-code one.** The
first version of this check pinned the literal "nine instances", and reported a
false failure the moment the count legitimately became ten. A consistency check
that has to be edited whenever the truth changes is a check that will be edited
to agree with whatever it finds.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate_output import report  # noqa: E402

WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
         7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve"}


def read(rel: str) -> str:
    path = SKILL / rel
    return path.read_text(encoding="utf-8") if path.exists() else ""


def postmortem_claims(errors: list[str]) -> None:
    """The instance count is stated in three places; all three must agree with the file."""
    pm = read("docs/postmortem/0002-verification-scope-overstated-four-times.md")
    index = read("docs/postmortem/README.md")
    if not pm or not index:
        return

    # Ground truth: the highest instance number the record actually documents.
    numbers = [int(n) for n in re.findall(r"^## Instances? (\d+)", pm, re.MULTILINE)]
    numbers += [int(b) for a, b in re.findall(r"^## Instances (\d+)[–-](\d+)", pm, re.MULTILINE)]
    if not numbers:
        errors.append("docs/postmortem/0002: no `## Instance N` sections found — cannot verify its own count")
        return
    actual = max(numbers)
    word = WORDS.get(actual, str(actual))

    title = pm.splitlines()[0]
    if f"overstated {word} times" not in title:
        errors.append(f"docs/postmortem/0002 title says something other than {word!r}, "
                      f"but the record documents instances up to {actual}: {title}")
    if f"overstated {word} times" not in index:
        errors.append(f"docs/postmortem/README.md index row disagrees with 0002's own count of {actual}")
    if f"{word} instances" not in index:
        errors.append(f"docs/postmortem/README.md status line disagrees with 0002's own count of {actual}")


def audit_claims(errors: list[str]) -> None:
    audit = read("docs/2026-08-10-first-principles-audit.md")
    if not audit:
        return
    if re.search(r"仍未动\**:建议 5[–-]11", audit):
        errors.append("docs/…-first-principles-audit.md still claims suggestions 5-11 are untouched; "
                      "5 and 6 shipped (see appendix B)")
    for suggestion, marker in [("5", "建议 **5**"), ("6", "建议 **6**")]:
        if marker not in audit:
            errors.append(f"audit appendix B does not record the disposition of suggestion {suggestion}")


def invariant_claims(errors: list[str]) -> None:
    cases = json.loads(read("evals/content-checks.json") or '{"cases": []}')["cases"]
    for case in cases:
        desc = case.get("desc", "")
        if "45 survived initially" in desc:
            errors.append(f"{case['id']}: desc still states an initial survivor count postmortem 0002 "
                          "ruled unverifiable")
        for path in {c["file"] for c in case["checks"]}:
            if not (SKILL / path).exists():
                errors.append(f"{case['id']}: pins {path}, which does not exist")


def guardrail_claims(errors: list[str]) -> None:
    """Every mechanism a postmortem names under Guardrails must be findable."""
    for name in ("0001-stale-bytecode-validated-deleted-code.md",
                 "0002-verification-scope-overstated-four-times.md"):
        text = read(f"docs/postmortem/{name}")
        section = text.split("## Guardrails added", 1)[1].split("\n## ", 1)[0] if "## Guardrails added" in text else ""
        for ref in re.findall(r"`(scripts/[\w./-]+|test_\w+)`", section):
            target = SKILL / ref if ref.startswith("scripts/") else None
            if target is not None and not target.exists():
                errors.append(f"postmortem {name}: names {ref}, which does not exist")
            elif target is None:
                found = any(ref in p.read_text(encoding="utf-8", errors="ignore")
                            for p in (SKILL / "scripts" / "tests").glob("test_*.py"))
                if not found:
                    errors.append(f"postmortem {name}: names {ref}, which no test defines")


def main() -> int:
    # This gate takes no arguments, but it still parses them: a typo'd flag in a
    # CI invocation must exit 2, not be silently ignored on the way to a green
    # run. The derived gate list in the test suite caught this one the moment it
    # was added, which is what deriving it was for.
    argparse.ArgumentParser(description="Verify documented claims against the artifacts").parse_args()

    errors: list[str] = []
    postmortem_claims(errors)
    audit_claims(errors)
    invariant_claims(errors)
    guardrail_claims(errors)
    return report("check-doc-claims", errors,
                  "documented claims agree with the artifacts they describe")


if __name__ == "__main__":
    raise SystemExit(main())
