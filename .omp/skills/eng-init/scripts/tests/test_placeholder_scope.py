"""Placeholder scanning must be scoped to the artifacts eng-init writes.

Field defect (pig, 425-file Go repo): scanning the whole target repository
reported 94 false failures — Go composite literals `[]T{{...}}` in product
code and the repo's own HTML export templates `{{CSS}}` / `{{JS}}` — while the
12 real failures drowned in the noise. A checker that cannot be run on a real
repository is not a gate.
"""

import importlib.util
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "check_rendered_harness", SCRIPTS / "check_rendered_harness.py"
)
crh = importlib.util.module_from_spec(_spec)
sys.modules["check_rendered_harness"] = crh
_spec.loader.exec_module(crh)


def build_repo(tmp_path: Path) -> Path:
    """A repo with product source that legitimately contains {{...}}."""
    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "internal" / "export").mkdir(parents=True)
    # Go composite literal — the `{{` is Go syntax, not a placeholder.
    (repo / "pkg" / "cases_test.go").write_text(
        'var cases = []T{{Name: "a", Want: 1}, {Name: "b", Want: 2}}\n', encoding="utf-8"
    )
    # The product's own HTML template engine.
    (repo / "internal" / "export" / "template.html").write_text(
        "<style>{{CSS}}</style><script>{{JS}}</script>{{SESSION_DATA}}\n", encoding="utf-8"
    )
    return repo


def test_product_source_placeholders_are_not_reported(tmp_path):
    repo = build_repo(tmp_path)
    errors: list[str] = []
    crh.check_no_unresolved(repo, errors)
    assert errors == [], f"false positives on product source: {errors}"


def test_unresolved_placeholder_in_written_justfile_is_reported(tmp_path):
    """The real defect must still be caught: eng-init left {{MAX_FILE_LINES}} literal."""
    repo = build_repo(tmp_path)
    (repo / "justfile").write_text("size-check:\n    max={{MAX_FILE_LINES}}\n", encoding="utf-8")
    errors: list[str] = []
    crh.check_no_unresolved(repo, errors)
    assert any("MAX_FILE_LINES" in e for e in errors), errors


def test_unresolved_placeholder_in_written_agents_md_is_reported(tmp_path):
    repo = build_repo(tmp_path)
    (repo / "AGENTS.md").write_text("# AGENTS\n\nProfile: {{PROFILE_LEVEL}}\n", encoding="utf-8")
    errors: list[str] = []
    crh.check_no_unresolved(repo, errors)
    assert any("PROFILE_LEVEL" in e for e in errors), errors


def test_module_level_agents_md_is_still_scanned(tmp_path):
    repo = build_repo(tmp_path)
    (repo / "pkg" / "AGENTS.md").write_text("Owner: {{OWNER_1}}\n", encoding="utf-8")
    errors: list[str] = []
    crh.check_no_unresolved(repo, errors)
    assert any("OWNER_1" in e for e in errors), errors


def test_binary_files_are_not_scanned(tmp_path):
    """A compiled binary embedding {{CSS}} must not be read as text."""
    repo = build_repo(tmp_path)
    (repo / ".github").mkdir()
    (repo / ".github" / "blob.bin").write_bytes(b"\x7fELF\x00\x00{{CSS}}\x00binary")
    errors: list[str] = []
    crh.check_no_unresolved(repo, errors)
    assert errors == [], errors
