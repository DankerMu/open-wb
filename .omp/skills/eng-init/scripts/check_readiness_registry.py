#!/usr/bin/env python3
"""Validate eng-init's machine-readable readiness registry without third-party deps."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gate_output import report  # noqa: E402

REQUIRED_TOP_LEVEL = [
    "schema_version:",
    "scoring:",
    "control_plane_layers:",
    "criteria:",
]
REQUIRED_FIELDS = [
    "id",
    "level",
    "scope",
    "skippable",
    "fixability",
    "layer",
    "artifact",
    "validator",
    "rescore_evidence",
]
# Keys a criterion row may carry beyond REQUIRED_FIELDS.
OPTIONAL_FIELDS: set[str] = set()
VALID_SCOPE = {"repository", "application"}
VALID_FIXABILITY = {"A", "B", "C", "D", "A_or_C", "B_or_C"}
VALID_LAYERS = {
    "Memory",
    "Invariant",
    "Protocol",
    "Permission",
    "Sensorium",
    "Evaluation / GC",
    "Governance",
}


def parse_scalar(value: str) -> str:
    return value.strip().strip('"').strip("'")


def load_criteria(text: str) -> list[dict[str, str]]:
    criteria: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("  - id: "):
            if current is not None:
                criteria.append(current)
            current = {"id": parse_scalar(line.split(":", 1)[1])}
            continue
        if current is None:
            continue
        match = re.match(r"^    ([a-z_]+):\s*(.*)$", line)
        if match:
            current[match.group(1)] = parse_scalar(match.group(2))
    if current is not None:
        criteria.append(current)
    return criteria


def load_reference_ids(path: Path) -> set[str]:
    text = path.read_text()
    sections: list[str] = []
    if "## Repository-scope criteria" in text and "## Application-scope criteria" in text:
        sections.append(text.split("## Repository-scope criteria", 1)[1].split("## Application-scope criteria", 1)[0])
        sections.append(text.split("## Application-scope criteria", 1)[1].split("## How this feeds", 1)[0])
    else:
        sections.append(text)
    ids: set[str] = set()
    for section in sections:
        ids.update(re.findall(r"^\| `([a-z0-9_]+)` \|", section, flags=re.MULTILINE))
    return ids


def validate(path: Path, criteria_reference: Path | None = None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    notes: list[str] = []
    if not path.exists():
        return [f"missing registry: {path}"], notes
    text = path.read_text()
    for token in REQUIRED_TOP_LEVEL:
        if token not in text:
            errors.append(f"missing top-level field {token}")
    criteria = load_criteria(text)
    if len(criteria) < 12:
        errors.append(f"expected at least 12 criteria, found {len(criteria)}")
    seen: set[str] = set()
    for i, criterion in enumerate(criteria, start=1):
        cid = criterion.get("id", f"<row {i}>")
        if cid in seen:
            errors.append(f"duplicate criterion id: {cid}")
        seen.add(cid)
        if not re.match(r"^[a-z0-9_]+$", cid):
            errors.append(f"invalid criterion id: {cid}")
        for field in REQUIRED_FIELDS:
            if not criterion.get(field):
                errors.append(f"{cid}: missing {field}")
        # Reject unknown keys: a typo'd field would otherwise pass as valid
        # contract while carrying metadata nothing reads.
        for field in sorted(set(criterion) - set(REQUIRED_FIELDS) - OPTIONAL_FIELDS):
            errors.append(f"{cid}: unknown field {field!r}")
        level = criterion.get("level", "")
        if not level.isdigit() or not (1 <= int(level) <= 5):
            errors.append(f"{cid}: level must be 1..5")
        if criterion.get("scope") not in VALID_SCOPE:
            errors.append(f"{cid}: invalid scope {criterion.get('scope')!r}")
        if criterion.get("skippable") not in {"true", "false"}:
            errors.append(f"{cid}: skippable must be true/false")
        if criterion.get("fixability") not in VALID_FIXABILITY:
            errors.append(f"{cid}: invalid fixability {criterion.get('fixability')!r}")
        if criterion.get("layer") not in VALID_LAYERS:
            errors.append(f"{cid}: invalid layer {criterion.get('layer')!r}")
        if "placeholder" in criterion.get("rescore_evidence", "").lower():
            errors.append(f"{cid}: rescore_evidence must not be placeholder text")
    if criteria_reference is not None:
        expected = load_reference_ids(criteria_reference)
        actual = {criterion.get("id", "") for criterion in criteria}
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing:
            errors.append(f"registry missing criteria from reference: {', '.join(missing)}")
        if extra:
            errors.append(f"registry has criteria not in reference: {', '.join(extra)}")
        notes.append(f"coverage: {len(actual & expected)}/{len(expected)} reference criteria")
    return errors, notes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate eng-init readiness registry")
    parser.add_argument("registry", nargs="?", default="references/readiness-registry.yaml")
    parser.add_argument("--criteria-reference", help="Markdown criteria reference whose table IDs must match the registry")
    args = parser.parse_args(argv[1:])

    errors, notes = validate(Path(args.registry), Path(args.criteria_reference) if args.criteria_reference else None)
    if errors:
        return report("check-readiness-registry", errors, "")
    for note in notes:
        print(note)
    return report("check-readiness-registry", [],
                  f"{args.registry}: registry contract valid")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
