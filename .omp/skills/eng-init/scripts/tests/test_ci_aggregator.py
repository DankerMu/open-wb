"""Render-time check for the CI aggregator job.

Field defect (pig, run 4): `ci.yml` shipped with no `all-checks-passed`
aggregator and no `if: always()`, and the checker passed it. `ci_aggregator_gate`
existed only as an audit-scoring criterion — nothing verified it at render time,
so the job landed in one render and silently vanished in the next. A criterion
with no mechanical check is a wish.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "check_rendered_harness", SCRIPTS / "check_rendered_harness.py"
)
crh = importlib.util.module_from_spec(_spec)
sys.modules["check_rendered_harness"] = crh
_spec.loader.exec_module(crh)

GOOD_AGGREGATOR = """
name: CI
on: [pull_request]
jobs:
  layer1-fast-checks:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
  layer2-unit-tests:
    needs: layer1-fast-checks
    runs-on: ubuntu-latest
    steps:
      - run: just test
  all-checks-passed:
    if: always()
    needs:
      - layer1-fast-checks
      - layer2-unit-tests
    runs-on: ubuntu-latest
    steps:
      - name: Fail on any failed, cancelled, or skipped required job
        env:
          NEEDS: ${{ toJSON(needs) }}
        run: |
          if echo "$NEEDS" | grep -Eq '"result": "(failure|cancelled|skipped)"'; then
            exit 1
          fi
"""

NO_AGGREGATOR = """
name: CI
on: [pull_request]
jobs:
  layer1-fast-checks:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
  layer2-unit-tests:
    needs: layer1-fast-checks
    runs-on: ubuntu-latest
    steps:
      - run: just test
"""

MISSING_ALWAYS = GOOD_AGGREGATOR.replace("    if: always()\n", "")

IGNORES_SKIPPED = GOOD_AGGREGATOR.replace(
    """'"result": "(failure|cancelled|skipped)"'""", """'"result": "failure"'"""
)


def repo_with_workflow(tmp_path: Path, content: str | None) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    if content is not None:
        wf = repo / ".github" / "workflows"
        wf.mkdir(parents=True)
        (wf / "ci.yml").write_text(content, encoding="utf-8")
    return repo


def test_proper_aggregator_passes(tmp_path):
    errors: list[str] = []
    crh.check_ci_aggregator(repo_with_workflow(tmp_path, GOOD_AGGREGATOR), errors)
    assert errors == [], errors


def test_missing_aggregator_is_rejected(tmp_path):
    """The exact pig render that slipped through."""
    errors: list[str] = []
    crh.check_ci_aggregator(repo_with_workflow(tmp_path, NO_AGGREGATOR), errors)
    assert any("aggregator" in e.lower() for e in errors), errors


def test_aggregator_without_always_is_rejected(tmp_path):
    """Without `if: always()` a dependency failure skips the aggregator, and
    GitHub counts a skipped required check as passing."""
    errors: list[str] = []
    crh.check_ci_aggregator(repo_with_workflow(tmp_path, MISSING_ALWAYS), errors)
    assert any("always()" in e for e in errors), errors


def test_aggregator_that_ignores_skipped_is_rejected(tmp_path):
    errors: list[str] = []
    crh.check_ci_aggregator(repo_with_workflow(tmp_path, IGNORES_SKIPPED), errors)
    assert any("skipped" in e for e in errors), errors


def test_repo_without_ci_is_not_penalised(tmp_path):
    """Skippable: no CI, no aggregator requirement."""
    errors: list[str] = []
    crh.check_ci_aggregator(repo_with_workflow(tmp_path, None), errors)
    assert errors == [], errors


@pytest.mark.parametrize("missing", ["needs"])
def test_aggregator_without_needs_is_rejected(tmp_path, missing):
    content = GOOD_AGGREGATOR.replace(
        "    needs:\n      - layer1-fast-checks\n      - layer2-unit-tests\n", "", 1
    )
    errors: list[str] = []
    crh.check_ci_aggregator(repo_with_workflow(tmp_path, content), errors)
    assert errors, "an aggregator with no needs gates nothing"


MANUAL_ONLY = """
name: Build single-exe
on:
  workflow_dispatch:
    inputs:
      targets:
        type: string
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - run: make plan
  build-linux:
    needs: plan
    runs-on: ubuntu-latest
    steps:
      - run: make build
  build-macos:
    needs: plan
    runs-on: macos-latest
    steps:
      - run: make build
"""


def repo_with_workflows(tmp_path: Path, **files: str) -> Path:
    repo = tmp_path / "repo"
    wf = repo / ".github" / "workflows"
    wf.mkdir(parents=True)
    for name, content in files.items():
        (wf / f"{name}.yml").write_text(content, encoding="utf-8")
    return repo


def test_one_conforming_aggregator_satisfies_the_repo(tmp_path):
    """`ci_aggregator_gate` is repository-scope: branch protection points at one
    check. A repo that has that check is compliant, whatever else exists."""
    repo = repo_with_workflows(tmp_path, ci=GOOD_AGGREGATOR, docs=NO_AGGREGATOR)
    errors: list[str] = []
    crh.check_ci_aggregator(repo, errors)
    assert errors == [], errors


def test_manual_only_workflow_is_not_required_to_aggregate(tmp_path):
    """Field false positive: a workflow_dispatch-only build workflow was failed
    for lacking an aggregator it has no reason to have."""
    repo = repo_with_workflows(tmp_path, ci=GOOD_AGGREGATOR, build_exe=MANUAL_ONLY)
    errors: list[str] = []
    crh.check_ci_aggregator(repo, errors)
    assert errors == [], errors


def test_repo_with_only_manual_workflows_is_not_penalised(tmp_path):
    """Nothing gates PRs, so there is no hole to close."""
    repo = repo_with_workflows(tmp_path, build_exe=MANUAL_ONLY)
    errors: list[str] = []
    crh.check_ci_aggregator(repo, errors)
    assert errors == [], errors
