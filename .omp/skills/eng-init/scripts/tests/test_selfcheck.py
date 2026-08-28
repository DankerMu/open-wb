"""Fixture tests for scripts/selfcheck.sh.

The aggregate gate is only worth running if it can fail: these tests copy the
skill, break exactly one invariant in the copy, and require a non-zero exit.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[2]
SELFCHECK = SKILL_ROOT / "scripts" / "selfcheck.sh"


def clone_skill(tmp_path: Path) -> Path:
    """Copy the skill as a disposable fixture.

    This test file is excluded from the copy on purpose: selfcheck runs the
    pytest suite, so a clone containing these clone-and-run tests would
    recurse without bound.
    """
    dest = tmp_path / "eng-init"
    shutil.copytree(
        SKILL_ROOT,
        dest,
        ignore=shutil.ignore_patterns(
            "__pycache__", ".pytest_cache", Path(__file__).name
        ),
    )
    return dest


def run_selfcheck(root: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(root / "scripts" / "selfcheck.sh")],
        capture_output=True,
        text=True,
        cwd=str(root),
    )


def test_selfcheck_passes_on_a_pristine_clone(tmp_path):
    """Green baseline.

    Runs against a clone rather than the live tree: selfcheck runs the pytest
    suite, so invoking it on the real tree from inside that same suite would
    recurse. The clone is faithful except for this file (see clone_skill).
    """
    result = run_selfcheck(clone_skill(tmp_path))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "selfcheck PASSED" in result.stdout


def test_selfcheck_fails_when_a_content_invariant_is_broken(tmp_path):
    """Red proof: deleting a pinned rule from SKILL.md must turn the gate red."""
    clone = clone_skill(tmp_path)
    skill_md = clone / "SKILL.md"
    text = skill_md.read_text(encoding="utf-8")
    marker = "self-skip"
    assert marker in text, "fixture assumption broke: pinned marker absent"
    skill_md.write_text(text.replace(marker, "REMOVED"), encoding="utf-8")

    result = run_selfcheck(clone)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FAIL skill content invariants" in result.stdout
    assert "selfcheck FAILED" in result.stdout


def test_selfcheck_fails_when_the_registry_breaks(tmp_path):
    """Red proof: an invalid registry must be caught, not shrugged off."""
    clone = clone_skill(tmp_path)
    registry = clone / "references" / "readiness-registry.yaml"
    registry.write_text(
        registry.read_text(encoding="utf-8").replace(
            "    scope: repository\n", "    scope: not_a_valid_scope\n", 1
        ),
        encoding="utf-8",
    )
    result = run_selfcheck(clone)
    assert result.returncode == 1, result.stdout + result.stderr


@pytest.mark.parametrize("missing", ["pytest"])
def test_missing_prerequisite_exits_127_not_green(tmp_path, missing):
    """A gate that cannot run has not passed."""
    clone = clone_skill(tmp_path)
    shim = tmp_path / "bin"
    shim.mkdir()
    # A python3 that refuses to import pytest, so the prerequisite probe fails.
    # The shim execs the real interpreter by absolute path: resolving through
    # PATH would find the shim again and loop forever.
    (shim / "python3").write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "-c" ] && [[ "$2" == *"import pytest"* ]]; then exit 1; fi\n'
        f'exec {sys.executable} "$@"\n',
        encoding="utf-8",
    )
    (shim / "python3").chmod(0o755)
    env = {"PATH": f"{shim}:/usr/bin:/bin", "HOME": str(tmp_path)}
    result = subprocess.run(
        ["bash", str(clone / "scripts" / "selfcheck.sh")],
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 127, result.stdout + result.stderr
    assert "missing prerequisite" in result.stdout
