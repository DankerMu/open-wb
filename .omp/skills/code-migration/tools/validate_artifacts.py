#!/usr/bin/env python3
"""Validate code-migration artifact schemas and cross-document invariants."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_SCHEMA = ROOT / "schemas" / "migration-manifest.schema.json"
CLASSIFICATION_SCHEMA = ROOT / "schemas" / "source-classification.schema.json"


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ValueError(
            f"invalid JSON in {path}: line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error


def json_location(parts: list[Any]) -> str:
    location = "$"
    for part in parts:
        location += f"[{part}]" if isinstance(part, int) else f".{part}"
    return location


def schema_errors(document: Any, schema_path: Path, label: str) -> list[str]:
    schema = load_json(schema_path)
    validator = Draft202012Validator(schema)
    return [
        f"{label} schema error at {json_location(list(error.absolute_path))}: {error.message}"
        for error in sorted(
            validator.iter_errors(document),
            key=lambda item: (list(item.absolute_path), item.message),
        )
    ]


def duplicate_errors(values: list[str], label: str) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return [f"duplicate {label} ID '{value}'" for value in sorted(duplicates)]


def is_canonical_relative_path(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        bool(path.parts)
        and value != "."
        and "\\" not in value
        and not any(
            ord(character) < 32 or 127 <= ord(character) <= 159
            for character in value
        )
        and not (len(value) >= 2 and value[0].isalpha() and value[1] == ":")
        and not path.is_absolute()
        and value == path.as_posix()
        and all(part not in ("", ".", "..") for part in path.parts)
    )


def is_canonical_root_path(value: str) -> bool:
    return value == "." or is_canonical_relative_path(value)


def path_is_within(value: str, parent: str) -> bool:
    if parent == ".":
        return True
    value_parts = PurePosixPath(value).parts
    parent_parts = PurePosixPath(parent).parts
    return value_parts[: len(parent_parts)] == parent_parts


def path_overlap(left: str, right: str) -> bool:
    return path_is_within(left, right) or path_is_within(right, left)


def validate_paths(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    owned_paths: list[tuple[str, str, str, str]] = []
    roots = {system: manifest[system]["root"] for system in ("source", "target")}
    scoped_paths = {
        system: manifest["scope"][system] for system in ("source", "target")
    }

    for system, root in roots.items():
        if not is_canonical_root_path(root):
            errors.append(f"{system} root value '{root}' must be a canonical relative path or '.'")
        for field in ("includes", "excludes"):
            for value in scoped_paths[system][field]:
                if not is_canonical_relative_path(value):
                    errors.append(
                        f"scope.{system}.{field} value '{value}' must be a canonical relative path"
                    )

    canonical_scopes = {
        system: {
            field: [
                value
                for value in scoped_paths[system][field]
                if is_canonical_relative_path(value)
            ]
            for field in ("includes", "excludes")
        }
        for system in ("source", "target")
    }
    for system, root in roots.items():
        if not is_canonical_root_path(root):
            continue
        for field, values in canonical_scopes[system].items():
            for value in values:
                if not path_is_within(value, root):
                    errors.append(
                        f"scope.{system}.{field} value '{value}' is not contained by "
                        f"{system} root '{root}'"
                    )
    for unit in manifest["units"]:
        unit_id = unit["id"]
        for system, field in (("source", "sourcePaths"), ("target", "targetPaths")):
            for value in unit[field]:
                if not is_canonical_relative_path(value):
                    errors.append(
                        f"unit '{unit_id}' {field} value '{value}' must be a canonical relative path"
                    )
                    continue
                root = roots[system]
                if is_canonical_root_path(root) and not path_is_within(value, root):
                    errors.append(
                        f"unit '{unit_id}' {field} value '{value}' is not contained by "
                        f"{system} root '{root}'"
                    )
                includes = canonical_scopes[system]["includes"]
                excludes = canonical_scopes[system]["excludes"]
                if not any(path_is_within(value, include) for include in includes):
                    errors.append(
                        f"unit '{unit_id}' {field} value '{value}' is outside {system} scope includes"
                    )
                if any(path_overlap(value, exclude) for exclude in excludes):
                    errors.append(
                        f"unit '{unit_id}' {field} value '{value}' is excluded from {system} scope"
                    )
                owned_paths.append((unit_id, system, field, value))

    for index, (left_unit, left_system, left_field, left_path) in enumerate(owned_paths):
        for right_unit, right_system, right_field, right_path in owned_paths[index + 1 :]:
            if left_unit == right_unit or not path_overlap(left_path, right_path):
                continue
            errors.append(
                f"path '{left_path}' ({left_unit}.{left_field}) overlaps across units with "
                f"'{right_path}' ({right_unit}.{right_field})"
            )
    return errors


def dependency_cycle(units: list[dict[str, Any]], unit_ids: set[str]) -> list[str] | None:
    dependencies = {
        unit["id"]: [dependency for dependency in unit["dependencies"] if dependency in unit_ids]
        for unit in units
    }
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(unit_id: str) -> list[str] | None:
        state[unit_id] = 1
        stack.append(unit_id)
        for dependency in dependencies[unit_id]:
            if dependency == unit_id:
                continue
            if state.get(dependency, 0) == 0:
                cycle = visit(dependency)
                if cycle:
                    return cycle
            elif state.get(dependency) == 1:
                start = stack.index(dependency)
                return stack[start:] + [dependency]
        stack.pop()
        state[unit_id] = 2
        return None

    for unit_id in dependencies:
        if state.get(unit_id, 0) == 0:
            cycle = visit(unit_id)
            if cycle:
                return cycle
    return None


def exclusion_errors(manifest: dict[str, Any], rulebook: str | None) -> list[str]:
    """Validate excluded units' decisionRef against the rulebook revision headings.

    The excluded disposition is defined only for the structure-preserving-port
    route, whose named decisions live in RULEBOOK.md as `### rulebook@N`
    headings. A decisionRef must name a heading present in the rulebook; an
    excluded unit without a resolvable decision is an unverified "named
    decision" and is rejected. A rulebook that contains no revision headings
    makes every exclusion unverifiable.
    """
    excluded_units = [unit for unit in manifest["units"] if unit.get("excluded")]
    if not excluded_units:
        return []
    if manifest.get("variant") != "structure-preserving-port":
        return [
            f"unit '{unit['id']}' declares excluded but the excluded disposition is only "
            f"defined for the structure-preserving-port route (manifest variant "
            f"'{manifest.get('variant')}')"
            for unit in excluded_units
        ]
    if rulebook is None:
        return [
            f"unit '{unit['id']}' declares excluded but no rulebook was provided to verify "
            f"its decisionRef '{unit['excluded'].get('decisionRef', '<unnamed decision>')}'"
            for unit in excluded_units
        ]
    revisions = set(
        match.group(1)
        # Accept any heading whose token is followed by a separator or line end:
        # `### rulebook@3`, `### rulebook@3: title`, `### rulebook@3 — title`, and a
        # final heading with no trailing newline. Requiring trailing whitespace made
        # colon-style headings silently unresolvable.
        for match in re.finditer(r"^###\s+(rulebook@\d+)(?![\w@])", rulebook, re.MULTILINE)
    )
    if not revisions:
        return [
            f"rulebook contains no revision headings; cannot verify excluded units "
            f"{', '.join(sorted(unit['id'] for unit in excluded_units))}"
        ]
    errors: list[str] = []
    for unit in excluded_units:
        decision = unit["excluded"].get("decisionRef", "<unnamed decision>")
        if decision not in revisions:
            errors.append(
                f"unit '{unit['id']}' excluded by unknown rulebook revision {decision} "
                f"(known revisions: {', '.join(sorted(revisions))})"
            )
    return errors


# The pack producer enforces this charset too. Checking it only at pack time means a manifest
# validates cleanly and then fails after the plan is approved, so the same rule runs here, at
# the gate the workflow actually tells people to run. Reserved *names* stay with the producer,
# which owns the Feature-ID namespace and reports them in its own terms.
MISSIONS_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def identifier_errors(values: list[str], label: str) -> list[str]:
    # fullmatch, not match: `$` also matches before a trailing newline, so `match` would
    # accept "U-1\n" here and let the producer reject it later — the very split this check
    # exists to close. The producer uses fullmatch against the same pattern.
    return [
        f"{label} id '{value}' is not Missions-safe: must match "
        f"[A-Za-z0-9][A-Za-z0-9._-]{{0,127}} (no spaces or slashes)"
        for value in values
        if not MISSIONS_SAFE_ID.fullmatch(value)
    ]


def semantic_errors(manifest: dict[str, Any], classification: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    units = manifest["units"]
    behaviors = classification["behaviors"]
    unit_ids = [unit["id"] for unit in units]
    behavior_ids = [behavior["id"] for behavior in behaviors]
    unique_unit_ids = set(unit_ids)
    unique_behavior_ids = set(behavior_ids)

    errors.extend(duplicate_errors(unit_ids, "unit"))
    errors.extend(duplicate_errors(behavior_ids, "behavior"))
    errors.extend(identifier_errors(unit_ids, "unit"))
    errors.extend(identifier_errors(behavior_ids, "behavior"))
    errors.extend(identifier_errors([manifest["migrationId"]], "migration"))

    if manifest["migrationId"] != classification["migrationId"]:
        errors.append(
            "migration IDs differ: manifest has "
            f"'{manifest['migrationId']}' and classification has '{classification['migrationId']}'"
        )

    source_revision = manifest["source"].get("revision")
    if source_revision != classification["referenceRevision"]:
        errors.append(
            "manifest source revision does not match classification reference revision: "
            f"'{source_revision}' != '{classification['referenceRevision']}'"
        )

    assigned_behavior_ids: set[str] = set()
    for unit in units:
        if not unit["classificationIds"] and not unit.get("blockedBy"):
            errors.append(
                f"unit '{unit['id']}' without classification IDs must declare a static blocker"
            )

        unit_id = unit["id"]
        for duplicate in duplicate_errors(unit["dependencies"], f"unit '{unit_id}' dependency"):
            errors.append(duplicate)
        for dependency in unit["dependencies"]:
            if dependency == unit_id:
                errors.append(f"unit '{unit_id}' has a self dependency")
            elif dependency not in unique_unit_ids:
                errors.append(f"unit '{unit_id}' has unresolved dependency '{dependency}'")
        for classification_id in unit["classificationIds"]:
            if classification_id not in unique_behavior_ids:
                errors.append(
                    f"unit '{unit_id}' has unresolved classification ID '{classification_id}'"
                )
            else:
                assigned_behavior_ids.add(classification_id)

    for behavior_id in sorted(unique_behavior_ids - assigned_behavior_ids):
        errors.append(f"behavior '{behavior_id}' is not assigned to a migration unit")

    excluded_unit_ids = {unit["id"] for unit in units if unit.get("excluded")}
    for unit in units:
        if unit.get("excluded") and unit.get("blockedBy"):
            errors.append(
                f"unit '{unit['id']}' declares both excluded and blockedBy; "
                "excluded is a final scope disposition, blockedBy is a static blocker"
            )
    for unit in units:
        if unit["id"] in excluded_unit_ids:
            continue
        for dependency in unit["dependencies"]:
            if dependency in excluded_unit_ids:
                errors.append(
                    f"unit '{unit['id']}' depends on excluded unit '{dependency}'"
                )

    cycle = dependency_cycle(units, unique_unit_ids)
    if cycle:
        errors.append(
            "dependency cycle "
            f"{' -> '.join(cycle)} must be modeled as one explicit scc unit instead"
        )

    errors.extend(validate_paths(manifest))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate code-migration manifest and source-classification artifacts."
    )
    parser.add_argument("--manifest", required=True, type=Path, help="Path to manifest.json")
    parser.add_argument(
        "--classification",
        required=True,
        type=Path,
        help="Path to source-classification.json",
    )
    parser.add_argument(
        "--rulebook",
        type=Path,
        help="Path to RULEBOOK.md (required when any unit declares an exclusion)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = load_json(args.manifest)
        classification = load_json(args.classification)
        errors = schema_errors(manifest, MANIFEST_SCHEMA, "manifest")
        errors.extend(
            schema_errors(classification, CLASSIFICATION_SCHEMA, "source classification")
        )
        if not errors:
            errors.extend(semantic_errors(manifest, classification))
            rulebook = (
                args.rulebook.read_text(encoding="utf-8")
                if args.rulebook is not None
                else None
            )
            errors.extend(exclusion_errors(manifest, rulebook))
    except (ValueError, OSError) as error:
        errors = [str(error)]

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    print("Artifact validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
