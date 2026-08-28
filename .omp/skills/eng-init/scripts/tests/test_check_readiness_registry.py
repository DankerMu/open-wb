"""Fixture tests for scripts/check_readiness_registry.py.

The registry is the skill's machine-readable contract, so its validator must
reject malformed rows rather than shrug at them. Each rejection test builds
the one violation it names; the accept test proves the committed registry is
still valid, so the rejections cannot be satisfied by a validator that fails
everything.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
SKILL_ROOT = SCRIPTS.parent
REGISTRY = SKILL_ROOT / "references" / "readiness-registry.yaml"

_spec = importlib.util.spec_from_file_location(
    "check_readiness_registry", SCRIPTS / "check_readiness_registry.py"
)
crr = importlib.util.module_from_spec(_spec)
sys.modules["check_readiness_registry"] = crr
_spec.loader.exec_module(crr)


def registry_copy(tmp_path: Path, old: str, new: str, count: int = 1) -> Path:
    text = REGISTRY.read_text(encoding="utf-8")
    assert old in text, f"fixture assumption broke: {old!r} absent"
    path = tmp_path / "readiness-registry.yaml"
    path.write_text(text.replace(old, new, count), encoding="utf-8")
    return path


def test_committed_registry_is_valid():
    errors, _ = crr.validate(REGISTRY)
    assert errors == []


@pytest.mark.parametrize(
    "old,new,expected",
    [
        ("    scope: repository\n", "    scope: not_a_scope\n", "invalid scope"),
        ("    fixability: A\n", "    fixability: Z\n", "invalid fixability"),
        ("    layer: Memory\n", "    layer: Nowhere\n", "invalid layer"),
        ("    level: 2\n", "    level: 9\n", "level must be 1..5"),
        ("    skippable: false\n", "    skippable: maybe\n", "skippable must be"),
    ],
    ids=["scope", "fixability", "layer", "level", "skippable"],
)
def test_invalid_enum_values_are_rejected(tmp_path, old, new, expected):
    errors, _ = crr.validate(registry_copy(tmp_path, old, new))
    assert any(expected in error for error in errors), errors


def test_duplicate_criterion_id_is_rejected(tmp_path):
    errors, _ = crr.validate(
        registry_copy(tmp_path, "  - id: agents_md\n", "  - id: readme\n")
    )
    assert any("duplicate criterion id" in error for error in errors), errors


def test_unknown_field_is_rejected(tmp_path):
    """A typo'd or invented key must not pass as machine-readable contract.

    Silently accepting extra keys means a misspelled `fixabilty:` alongside a
    stale `fixability:` reads as valid while carrying dead metadata.
    """
    errors, _ = crr.validate(
        registry_copy(tmp_path, "  - id: agents_md\n", "  - id: agents_md\n    fixabilty: A\n")
    )
    assert any("unknown field" in error for error in errors), errors


# ---------------------------------------------------------------------------
# Audit gap: the --criteria-reference cross-check (the reason selfcheck passes
# that flag at all) had zero tests. Structural validation was covered; the
# missing/extra branches that keep the registry and the markdown criteria table
# in sync were never exercised in either direction.
# ---------------------------------------------------------------------------

REF_HEADER = (
    "## Repository-scope criteria\n\n"
    "| ID | Lvl | Skip | Check | Maps to |\n"
    "|----|-----|------|-------|---------|\n"
)
REF_FOOTER = "\n## Application-scope criteria\n\n| ID |\n|----|\n\n## How this feeds Stage 2\n"


def write_pair(tmp_path, registry_ids, reference_ids):
    reg = tmp_path / "registry.yaml"
    rows = "".join(
        f"  - id: {cid}\n    level: 2\n    scope: repository\n    skippable: false\n"
        f"    fixability: A\n    layer: Memory\n    artifact: AGENTS.md\n"
        f"    validator: it exists\n    rescore_evidence: {cid}=1/1 when present\n"
        for cid in registry_ids
    )
    reg.write_text(
        "schema_version: 1\nscoring:\n  repo_scope_denominator: 1\n"
        "control_plane_layers:\n  - Memory\ncriteria:\n" + rows,
        encoding="utf-8",
    )
    ref = tmp_path / "criteria.md"
    body = "".join(f"| `{cid}` | 2 | no | it exists | AGENTS.md |\n" for cid in reference_ids)
    ref.write_text(REF_HEADER + body + REF_FOOTER, encoding="utf-8")
    return reg, ref


IDS = [f"criterion_{i:02d}" for i in range(14)]


def test_cross_reference_accepts_matching_sets(tmp_path):
    """Clean side first: identical id sets must produce no errors."""
    reg, ref = write_pair(tmp_path, IDS, IDS)
    errors, notes = crr.validate(reg, ref)
    assert errors == [], errors
    assert any("coverage: 14/14" in n for n in notes), notes


def test_cross_reference_rejects_a_criterion_missing_from_the_registry(tmp_path):
    """A criterion documented in the markdown table but never registered."""
    reg, ref = write_pair(tmp_path, IDS, IDS + ["criterion_only_in_docs"])
    errors, _ = crr.validate(reg, ref)
    assert any("registry missing criteria from reference" in e and "criterion_only_in_docs" in e
               for e in errors), errors


def test_cross_reference_rejects_a_criterion_missing_from_the_reference(tmp_path):
    """A registered criterion that no documented table row describes."""
    reg, ref = write_pair(tmp_path, IDS + ["criterion_only_in_registry"], IDS)
    errors, _ = crr.validate(reg, ref)
    assert any("registry has criteria not in reference" in e and "criterion_only_in_registry" in e
               for e in errors), errors
