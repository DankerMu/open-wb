#!/usr/bin/env python3
"""Sweep every failable branch in eng-init's checkers and report which are untested.

Each `fail(...)` / `errors.append(...)` / `require(...)` / `fail_if(...)` statement is
an invariant this skill promises to enforce. This neuters them one at a time and
runs the suite: a mutation nothing catches is an invariant with no proof it rejects
anything — the phantom enforcement gate-quality-contract.md § Self-proof describes.

Usage:
  python3 scripts/mutation_sweep.py            # sweep everything
  python3 scripts/mutation_sweep.py --file check_rendered_harness.py
  python3 scripts/mutation_sweep.py --limit 20 # first N mutations (smoke)

Exit 0 when every mutation is caught; 1 when any survives.
"""
from __future__ import annotations

import argparse
import atexit
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import os
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent


def pathlib_unlink(name: str) -> None:
    """One temp backup per mutation adds up over a hundred of them."""
    try:
        os.unlink(name)
    except OSError:
        pass

# Derived, not transcribed. The hand-written version of this list went stale the
# day a new gate was added: check_doc_claims.py shipped with ten failable
# branches, no tests, and no place in this inventory — a gate written to catch
# unproven claims, itself unproven. A list that must be remembered will be
# forgotten; deriving it means the next gate is covered the moment it exists.
#
# Scope bound, stated because a coverage number reads as exhaustive unless it
# says what it excludes: a result of "N/N" means every fail/append/require/
# fail_if site in the gates matched below, never "every rejection eng-init can
# perform". check_skill_content.py rejects through a different shape and stays
# outside; that exclusion is deliberate and named.
_GATE_PREFIXES = ("check_", "score_", "validate_")
_NOT_A_GATE = {"check_skill_content.py"}  # rejects via a different call shape


def discover_targets() -> list[str]:
    return sorted(
        p.name for p in (SKILL / "scripts").glob("*.py")
        if p.name.startswith(_GATE_PREFIXES) and p.name not in _NOT_A_GATE
    )


TARGETS = discover_targets()
FAILABLE = re.compile(r"^(\s*)(fail\(errors|errors\.append\(|require\(|fail_if\()")


# A mutated source must never outlive the process. `finally` covers exceptions
# but not SIGTERM/SIGINT, and a killed sweep did leave `pass  # MUTATED` behind in
# a committed checker. Every mutation registers its restore here first.
_PENDING_RESTORE: dict[str, str] = {}


def _restore_all(*_args) -> None:
    for target, backup in list(_PENDING_RESTORE.items()):
        try:
            shutil.copyfile(backup, target)
        except OSError:
            pass
        _PENDING_RESTORE.pop(target, None)


atexit.register(_restore_all)
for _sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(_sig, lambda s, f: (_restore_all(), sys.exit(130)))


def clear_caches() -> None:
    # A same-length edit inside one second leaves a .pyc CPython still accepts,
    # so the suite would grade the previous mutation. Found the hard way.
    for cache in SKILL.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)


def run_suite() -> tuple[int, list[str]]:
    clear_caches()
    proc = subprocess.run(
        [sys.executable, "-B", "-m", "pytest", "scripts/tests", "-q", "--no-header", "--tb=no"],
        cwd=SKILL, capture_output=True, text=True)
    return proc.returncode, re.findall(r"FAILED (\S+)", proc.stdout + proc.stderr)


def single_statement(lines: list[str], index: int) -> bool:
    """True when the failable call is one physical line (balanced parens)."""
    line = lines[index]
    return line.count("(") == line.count(")") and line.rstrip().endswith(")")


def mutation_sites(path: Path) -> list[tuple[int, str]]:
    lines = path.read_text().splitlines(keepends=True)
    sites = []
    for i, line in enumerate(lines):
        if FAILABLE.match(line) and single_statement(lines, i):
            sites.append((i, line.strip()[:96]))
    return sites


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", action="append", default=None)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    targets = args.file or TARGETS
    rc, _ = run_suite()
    if rc != 0:
        print("baseline suite is not green — fix that first")
        return 2
    print("baseline: green\n")

    survivors: list[tuple[str, int, str]] = []
    skipped: list[tuple[str, int]] = []
    caught = 0
    done = 0

    for name in targets:
        path = SKILL / "scripts" / name
        original = path.read_text()
        lines = original.splitlines(keepends=True)
        sites = mutation_sites(path)
        total_calls = sum(1 for line in lines if FAILABLE.match(line))
        skipped.extend((name, i) for i in range(total_calls - len(sites)))
        print(f"== {name}: {len(sites)} single-line sites ({total_calls - len(sites)} multi-line skipped)")

        for index, text in sites:
            if args.limit is not None and done >= args.limit:
                break
            done += 1
            backup = tempfile.NamedTemporaryFile("w", delete=False, suffix=".bak")
            backup.write(original)
            backup.close()
            _PENDING_RESTORE[str(path)] = backup.name
            try:
                indent = re.match(r"^(\s*)", lines[index]).group(1)
                mutated = list(lines)
                mutated[index] = f"{indent}pass  # MUTATED\n"
                path.write_text("".join(mutated))
                rc, failed = run_suite()
                if rc == 0:
                    print(f"  SURVIVED  L{index + 1}: {text}")
                    survivors.append((name, index + 1, text))
                else:
                    caught += 1
            finally:
                shutil.copyfile(backup.name, str(path))
                _PENDING_RESTORE.pop(str(path), None)
                pathlib_unlink(backup.name)

    _restore_all()
    leftover = [name for name in targets
                if "# MUTATED" in (SKILL / "scripts" / name).read_text()]
    if leftover:
        print(f"\nFATAL: mutation residue left in {', '.join(leftover)} — restore from git before trusting anything")
        return 2
    rc, _ = run_suite()
    print(f"\nrestored: suite {'green' if rc == 0 else 'NOT GREEN — INVESTIGATE'}")
    print(f"caught {caught}/{caught + len(survivors)} mutations; {len(survivors)} survived")
    if survivors:
        print("\nUNTESTED INVARIANTS (each is a promise with no proof it rejects anything):")
        for name, line, text in survivors:
            print(f"  {name}:{line}  {text}")
    return 1 if survivors or rc != 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
