"""Fixture tests for scripts/check_skill_content.py.

The content gate must reject a broken invariant, not merely pass on the
current tree — an accept-only gate is indistinguishable from no gate.
"""

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
CHECKER = SCRIPTS / "check_skill_content.py"
SKILL_ROOT = SCRIPTS.parent


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CHECKER), *args], capture_output=True, text=True
    )


def test_committed_invariants_pass():
    result = run()
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_case_covers_a_real_file():
    document = json.loads((SKILL_ROOT / "evals" / "content-checks.json").read_text())
    for case in document["cases"]:
        for check in case["checks"]:
            assert (SKILL_ROOT / check["file"]).exists(), (case["id"], check["file"])


def test_broken_invariant_is_rejected(tmp_path):
    """Red proof: an assertion whose content is absent must exit non-zero."""
    checks = tmp_path / "checks.json"
    checks.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "id": "FORCED",
                        "desc": "invariant that cannot hold",
                        "checks": [
                            {
                                "file": "SKILL.md",
                                "type": "contains",
                                "pattern": "__absent_invariant_marker__",
                            }
                        ],
                    }
                ]
            }
        )
    )
    result = run("--checks", str(checks))
    assert result.returncode == 1
    # Violations now follow the shared protocol: stderr, gate-named title line.
    combined = result.stdout + result.stderr
    assert "FORCED" in combined
    assert "check-skill-content:" in combined and "violation(s) found" in combined


def test_list_mode_does_not_gate():
    result = run("--list")
    assert result.returncode == 0
    assert "R1-ci-aggregator" in result.stdout + result.stderr


def test_absence_assertions_reject_a_reintroduced_pattern(tmp_path):
    """`not_regex` / `not_contains` exist so a defect fixed by DELETING something
    can be pinned. A presence-only oracle cannot express that."""
    checks = tmp_path / "checks.json"
    checks.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "id": "ABSENCE",
                        "desc": "a banned pattern must stay gone",
                        "checks": [
                            {
                                "file": "SKILL.md",
                                "type": "not_contains",
                                "pattern": "eng-init",
                            }
                        ],
                    }
                ]
            }
        )
    )
    result = run("--checks", str(checks))
    assert result.returncode == 1, "a present banned pattern must fail"
    assert "must be absent" in result.stdout + result.stderr


def test_absence_assertion_passes_when_pattern_is_gone(tmp_path):
    checks = tmp_path / "checks.json"
    checks.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "id": "ABSENCE-OK",
                        "desc": "banned pattern genuinely absent",
                        "checks": [
                            {
                                "file": "SKILL.md",
                                "type": "not_regex",
                                "pattern": "__pattern_that_is_not_there__",
                            }
                        ],
                    }
                ]
            }
        )
    )
    assert run("--checks", str(checks)).returncode == 0
