#!/usr/bin/env python3
"""Build one sealed Missions v4 execution pack from approved code-migration artifacts."""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator

from jsonschema import Draft202012Validator

from validate_artifacts import (
    CLASSIFICATION_SCHEMA,
    MANIFEST_SCHEMA,
    MISSIONS_SAFE_ID,
    exclusion_errors,
    schema_errors,
    semantic_errors,
)


ROOT = Path(__file__).resolve().parents[1]
REQUEST_SCHEMA = ROOT / "schemas" / "missions-v4-pack-request.schema.json"
GATE_ARTIFACT_SCHEMA = ROOT / "schemas" / "missions-v4-gate-artifact.schema.json"
# Missions owns the approval-envelope contract and is being restructured, so its location is an
# input rather than a constant. Two earlier attempts here were both wrong: a hard-coded path
# bound this skill to one tree, and a filename list bound it to one point in a rename — and that
# second one was worse, because the filename and the contract version move together. The
# committed schema pins `missions.v4.approval.v1` and the renamed one pins
# `missions.approval.v1`, so picking a file by name can pair a new-generation envelope with an
# old-generation schema and fail as a confusing validation error instead of a clear miss.
#
# So resolve by *contract*, not by name: search bounded roots, read each candidate, and accept
# only the schema that pins the version this tool emits.
MISSIONS_ENVELOPE_SCHEMA_ENV = "MISSIONS_APPROVAL_ENVELOPE_SCHEMA"
MISSIONS_ENVELOPE_SCHEMA_DIR = "schemas"
APPROVAL_ENVELOPE_SCHEMA_VERSION = "missions.approval.v1"


def missions_approval_envelope_schema() -> Path:
    override = os.environ.get(MISSIONS_ENVELOPE_SCHEMA_ENV)
    if override:
        candidate = Path(override).expanduser()
        if not candidate.is_file():
            raise PackRequestError(
                f"{MISSIONS_ENVELOPE_SCHEMA_ENV} points at {candidate}, which is not a file"
            )
        # The override is a location escape hatch, not a contract escape hatch: it goes through
        # the same version gate as a discovered schema. Skipping it here would let the documented
        # workaround reintroduce the wrong-generation pairing this function exists to prevent.
        pinned = schema_pinned_version(candidate)
        if pinned != APPROVAL_ENVELOPE_SCHEMA_VERSION:
            raise PackRequestError(
                f"{MISSIONS_ENVELOPE_SCHEMA_ENV} points at {candidate}, which pins "
                f"{pinned!r}; this producer emits {APPROVAL_ENVELOPE_SCHEMA_VERSION}"
            )
        return candidate
    searched = 0
    mismatched: list[str] = []
    for missions in missions_root_candidates():
        directory = missions / MISSIONS_ENVELOPE_SCHEMA_DIR
        if not directory.is_dir():
            continue
        for candidate in sorted(directory.glob("approval-envelope*.schema.json")):
            searched += 1
            pinned = schema_pinned_version(candidate)
            if pinned == APPROVAL_ENVELOPE_SCHEMA_VERSION:
                return candidate
            if pinned is not None:
                mismatched.append(f"{candidate} pins {pinned}")
    detail = f"; rejected on version: {', '.join(mismatched)}" if mismatched else ""
    raise PackRequestError(
        "cannot locate a Missions approval-envelope schema pinning "
        f"{APPROVAL_ENVELOPE_SCHEMA_VERSION}. Set {MISSIONS_ENVELOPE_SCHEMA_ENV} to its path. "
        f"Read {searched} candidate schemas under {ROOT.parents[1]}{detail}"
    )


def schema_pinned_version(path: Path) -> str | None:
    """The `schemaVersion` const a candidate schema pins, or None if it pins none."""
    try:
        document = strict_json(path)
    except Exception:
        return None
    if not isinstance(document, dict):
        return None
    pinned = document.get("properties", {})
    if not isinstance(pinned, dict):
        return None
    version = pinned.get("schemaVersion")
    if isinstance(version, dict) and isinstance(version.get("const"), str):
        return version["const"]
    return None


def missions_root_candidates() -> Iterator[Path]:
    """Bounded, deterministic search for a Missions checkout.

    Deliberately not a recursive glob: `**/missions` under the skills directory also matches
    unrelated scaffolding such as `skills/*/.agents/missions`, and walking up past the
    repository root reaches directories outside it entirely. Search only the skills directory,
    the repository root, and the repository root's immediate children — which finds an archived
    or relocated checkout without naming any tree.
    """
    repository_root = ROOT.parents[1]
    yield ROOT.parent / "missions"
    yield repository_root / "missions"
    try:
        children = sorted(
            child
            for child in repository_root.iterdir()
            if child.is_dir() and not child.name.startswith(".")
        )
    except OSError:
        return
    for child in children:
        if child != ROOT.parent:
            yield child / "missions"
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_PLAN_BYTES = 8 * 1024 * 1024
MAX_PACK_BYTES = 32 * 1024 * 1024
MAX_PROGRAM_ARTIFACTS = 4096
# The Missions-safe identifier charset has one owner, `validate_artifacts.MISSIONS_SAFE_ID`,
# imported above. It used to be declared here as a byte-identical twin, which is two sources of
# truth for one rule with one reason to change.
ID_PATTERN = MISSIONS_SAFE_ID
ROUTE_ARTIFACTS: dict[str, dict[str, tuple[str, str]]] = {
    "structure-preserving-port": {
        "rulebook": ("RULEBOOK.md", "context/rulebook.md"),
        "gapInventory": ("gap-inventory.tsv", "context/gap-inventory.tsv"),
    },
    "same-stack-uplift": {
        "deltaCatalog": ("DELTA_CATALOG.md", "context/delta-catalog.md"),
    },
    "redesign-or-strangler": {
        "behaviorCatalog": ("BEHAVIOR_CATALOG.md", "context/behavior-catalog.md"),
        "targetArchitecture": ("TARGET_ARCHITECTURE.md", "context/target-architecture.md"),
    },
}
TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


class PackRequestError(ValueError):
    """The upstream migration request cannot produce a safe execution pack."""


def strict_json(path: Path) -> Any:
    return parse_strict_json(read_regular_path(path, MAX_JSON_BYTES, str(path)), str(path))


def parse_strict_json(content: bytes, label: str) -> Any:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PackRequestError(f"duplicate JSON key '{key}' in {label}")
            result[key] = value
        return result

    try:
        return json.loads(content.decode("utf-8"), object_pairs_hook=object_pairs)
    except UnicodeDecodeError as error:
        raise PackRequestError(f"{label} is not UTF-8: {error}") from error
    except json.JSONDecodeError as error:
        raise PackRequestError(
            f"invalid JSON in {label}: line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error


def strict_json_at(program: Path, artifact_ref: str, label: str) -> Any:
    artifact_ref = safe_relative_path(artifact_ref, label)
    return parse_strict_json(
        read_program_regular_file(program, artifact_ref, label, MAX_JSON_BYTES), label
    )


def read_regular_path(path: Path, limit: int, label: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR):
            raise PackRequestError(f"{label} must be a regular non-symlink file") from error
        raise PackRequestError(f"cannot read {label}: {error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise PackRequestError(f"{label} must be a regular non-symlink file")
        if metadata.st_size > limit:
            raise PackRequestError(f"{label} exceeds {limit} bytes")
        chunks: list[bytes] = []
        remaining = metadata.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise PackRequestError(f"{label} changed while it was being read")
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        if len(content) != metadata.st_size or os.fstat(descriptor).st_size != metadata.st_size:
            raise PackRequestError(f"{label} changed while it was being read")
        return content
    finally:
        os.close(descriptor)


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise PackRequestError(f"cannot canonicalize generated plan: {error}") from error


def sha256(value: bytes | str) -> str:
    payload = value.encode("utf-8") if isinstance(value, str) else value
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def safe_relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or value == "" or "\\" in value or value.startswith("/") or any(ord(char) < 32 for char in value):
        raise PackRequestError(f"{label} must be a safe relative path")
    path = PurePosixPath(value)
    if value != path.as_posix() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise PackRequestError(f"{label} must be a safe relative path")
    return value


def is_macos_system_alias(path: Path) -> bool:
    return sys.platform == "darwin" and path in (Path("/var"), Path("/tmp"), Path("/etc"))


def assert_no_path_symlink(path: Path, label: str) -> None:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        try:
            if current.is_symlink() and not is_macos_system_alias(current):
                raise PackRequestError(f"{label} path must not traverse a symlink")
        except OSError as error:
            raise PackRequestError(f"cannot inspect {label} path: {error}") from error


def declared_artifact_identity(identity: Any, label: str) -> tuple[str, str]:
    if not isinstance(identity, dict):
        raise PackRequestError(f"{label} artifact identity is invalid")
    if set(identity) != {"artifactRef", "digest"}:
        raise PackRequestError(f"{label} artifact identity fields are invalid")
    artifact_ref = safe_relative_path(identity["artifactRef"], f"{label}.artifactRef")
    expected_digest = identity["digest"]
    if not isinstance(expected_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest):
        raise PackRequestError(f"{label}.digest is invalid")
    return artifact_ref, expected_digest


def same_file_metadata(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        left.st_size,
        left.st_mtime_ns,
        left.st_ctime_ns,
    ) == (
        right.st_dev,
        right.st_ino,
        right.st_size,
        right.st_mtime_ns,
        right.st_ctime_ns,
    )


def open_program_regular_file(program: Path, artifact_ref: str, label: str) -> tuple[int, int, str]:
    program_fd = -1
    descriptor = -1
    try:
        program_fd = open_no_symlink_directory(program)
        descriptor = program_fd
        for part in PurePosixPath(artifact_ref).parts[:-1]:
            next_descriptor = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0),
                dir_fd=descriptor,
            )
            if descriptor != program_fd:
                os.close(descriptor)
            descriptor = next_descriptor
        file_fd = os.open(
            PurePosixPath(artifact_ref).name,
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0),
            dir_fd=descriptor,
        )
    except OSError as error:
        if descriptor != -1 and descriptor != program_fd:
            os.close(descriptor)
        if program_fd != -1:
            os.close(program_fd)
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR):
            raise PackRequestError(
                f"{label} must be a regular non-symlink file: {artifact_ref}"
            ) from error
        raise PackRequestError(f"cannot read {label} source '{artifact_ref}': {error}") from error
    if descriptor != program_fd:
        os.close(program_fd)
    return file_fd, descriptor, PurePosixPath(artifact_ref).name


def inspect_program_regular_file(program: Path, artifact_ref: str, label: str, limit: int) -> int:
    file_fd, parent_fd, name = open_program_regular_file(program, artifact_ref, label)
    try:
        metadata = os.fstat(file_fd)
        authority = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or not stat.S_ISREG(authority.st_mode)
            or not same_file_metadata(metadata, authority)
        ):
            raise PackRequestError(f"{label} source changed while it was being opened: {artifact_ref}")
        if metadata.st_size > limit:
            raise PackRequestError(f"{label} exceeds {limit} bytes: {artifact_ref}")
        return metadata.st_size
    finally:
        os.close(file_fd)
        os.close(parent_fd)


def read_program_regular_file(program: Path, artifact_ref: str, label: str, limit: int) -> bytes:
    file_fd, parent_fd, name = open_program_regular_file(program, artifact_ref, label)
    try:
        metadata = os.fstat(file_fd)
        authority = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or not stat.S_ISREG(authority.st_mode)
            or not same_file_metadata(metadata, authority)
        ):
            raise PackRequestError(f"{label} source changed while it was being opened: {artifact_ref}")
        if metadata.st_size > limit:
            raise PackRequestError(f"{label} exceeds {limit} bytes: {artifact_ref}")
        chunks: list[bytes] = []
        remaining = metadata.st_size
        while remaining:
            chunk = os.read(file_fd, min(1024 * 1024, remaining))
            if not chunk:
                raise PackRequestError(f"{label} source changed while reading: {artifact_ref}")
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        after = os.fstat(file_fd)
        final_authority = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            len(content) != metadata.st_size
            or not same_file_metadata(metadata, after)
            or not same_file_metadata(metadata, final_authority)
        ):
            raise PackRequestError(f"{label} source changed while reading: {artifact_ref}")
        return content
    finally:
        os.close(file_fd)
        os.close(parent_fd)


def read_declared_file(program: Path, identity: Any, label: str) -> tuple[str, bytes]:
    artifact_ref, expected_digest = declared_artifact_identity(identity, label)
    content = read_program_regular_file(program, artifact_ref, label, MAX_ARTIFACT_BYTES)
    if sha256(content) != expected_digest:
        raise PackRequestError(f"{label} digest does not match source: {artifact_ref}")
    return artifact_ref, content


def declared_file_size(program: Path, identity: Any, label: str) -> int:
    artifact_ref, _ = declared_artifact_identity(identity, label)
    return inspect_program_regular_file(program, artifact_ref, label, MAX_ARTIFACT_BYTES)


def unique_ids(values: list[Any], label: str) -> list[str]:
    if not all(isinstance(value, str) and ID_PATTERN.fullmatch(value) for value in values):
        raise PackRequestError(f"{label} must contain Missions-safe IDs")
    if len(set(values)) != len(values):
        raise PackRequestError(f"{label} contains duplicates")
    return values


def declared_artifact_count(request: dict[str, Any]) -> int:
    artifacts = request["migrationArtifacts"]
    count = 2 + len(artifacts["routeArtifacts"]) + 1
    if "pilotPlaybook" in artifacts:
        count += 1
    count += 2
    for unit in request["plan"]["units"]:
        count += len(unit["skillFiles"]) + len(unit["qaFlows"])
    return count


def validate_request(
    program: Path,
    manifest: dict[str, Any],
    classification: dict[str, Any],
    request: Any,
    repository: dict[str, str],
) -> dict[str, Any]:
    schema = strict_json(REQUEST_SCHEMA)
    errors = [
        f"pack request schema error at {json_location(list(error.absolute_path))}: {error.message}"
        for error in sorted(
            Draft202012Validator(schema).iter_errors(request),
            key=lambda item: (list(item.absolute_path), item.message),
        )
    ]
    if errors:
        raise PackRequestError("; ".join(errors))
    assert isinstance(request, dict)
    if request["migrationId"] != manifest["migrationId"] or request["migrationId"] != classification["migrationId"]:
        raise PackRequestError("pack request migration ID must match manifest and source classification")
    if request["repository"] != repository:
        raise PackRequestError("pack request repository binding does not match the target worktree")
    if declared_artifact_count(request) > MAX_PROGRAM_ARTIFACTS:
        raise PackRequestError(f"pack request declares more than {MAX_PROGRAM_ARTIFACTS} artifacts")

    plan = request["plan"]
    assert isinstance(plan, dict)
    unit_obligations = plan["units"]
    unit_ids = unique_ids([unit["id"] for unit in unit_obligations], "plan.units IDs")
    manifest_units = {unit["id"]: unit for unit in manifest["units"]}
    missing_units = [unit_id for unit_id in unit_ids if unit_id not in manifest_units]
    if missing_units:
        raise PackRequestError(f"plan.units has unknown migration units: {', '.join(missing_units)}")
    for unit_id in unit_ids:
        if unit_id == "judge-qualification" or unit_id.startswith("validator."):
            raise PackRequestError(f"plan.units cannot use reserved Feature ID {unit_id}")
    for obligation in unit_obligations:
        unit_id = obligation["id"]
        skill_name = obligation["skillName"]
        skill_files = obligation["skillFiles"]
        if skill_name is not None:
            prefix = f"skills/{skill_name}/"
            refs = [identity["artifactRef"] for identity in skill_files]
            if f"{prefix}SKILL.md" not in refs:
                raise PackRequestError(f"unit {unit_id} must declare {prefix}SKILL.md")
            if any(not ref.startswith(prefix) for ref in refs):
                raise PackRequestError(f"unit {unit_id} skill files must stay under {prefix}")
            skill_root = program / "skills" / skill_name
            try:
                actual_refs = []
                for candidate in skill_root.rglob("*"):
                    if candidate.is_symlink():
                        raise PackRequestError(f"unit {unit_id} skill directory contains a symlink")
                    if candidate.is_file():
                        actual_refs.append(candidate.relative_to(program).as_posix())
                        if len(actual_refs) > MAX_PROGRAM_ARTIFACTS:
                            raise PackRequestError(
                                f"unit {unit_id} skill directory exceeds {MAX_PROGRAM_ARTIFACTS} files"
                            )
            except OSError as error:
                raise PackRequestError(f"cannot inspect unit {unit_id} skill directory: {error}") from error
            if set(refs) != set(actual_refs):
                raise PackRequestError(f"unit {unit_id} must declare every regular file under {prefix}")
        if obligation["verification"]["mode"] != "steps":
            raise PackRequestError(f"unit {unit_id} verification must use steps mode")
        unique_ids([step["id"] for step in obligation["verification"]["steps"]], f"unit {unit_id} verification step IDs")
        unique_ids([flow["id"] for flow in obligation["qaFlows"]], f"unit {unit_id} QA flow IDs")
        for flow in obligation["qaFlows"]:
            unique_ids(
                [criterion["id"] for criterion in flow["passCriteria"]],
                f"unit {unit_id} QA flow {flow['id']} pass criteria IDs",
            )
            artifact_ref = flow["artifact"]["artifactRef"]
            if not artifact_ref.startswith("qa/"):
                raise PackRequestError(f"unit {unit_id} QA flow {flow['id']} artifact must be below qa/")
    for unit_id in unit_ids:
        unit = manifest_units[unit_id]
        blockers = unit.get("blockedBy", [])
        if blockers:
            raise PackRequestError(
                f"migration unit {unit_id} is blocked by: {', '.join(blockers)}"
            )
        if len(set(unit["targetPaths"])) != len(unit["targetPaths"]):
            raise PackRequestError(f"migration unit {unit_id} has duplicate target paths")
        for index, left in enumerate(unit["targetPaths"]):
            for right in unit["targetPaths"][index + 1 :]:
                if left.startswith(f"{right}/") or right.startswith(f"{left}/"):
                    raise PackRequestError(f"migration unit {unit_id} has overlapping target paths")
        if len(set(unit["classificationIds"])) != len(unit["classificationIds"]):
            raise PackRequestError(f"migration unit {unit_id} has duplicate classification IDs")
        if len(set(unit["dependencies"])) != len(unit["dependencies"]):
            raise PackRequestError(f"migration unit {unit_id} has duplicate dependencies")
        missing_dependencies = [
            dependency
            for dependency in unit["dependencies"]
            if dependency not in unit_ids
        ]
        if missing_dependencies:
            raise PackRequestError(
                f"plan.units omits dependencies of {unit_id}: {', '.join(missing_dependencies)}"
            )

    unique_ids(
        [flow["id"] for obligation in unit_obligations for flow in obligation["qaFlows"]],
        "plan.units QA flow IDs",
    )

    review_policy = plan["reviewPolicy"]
    checklist_ids = unique_ids([item["id"] for item in review_policy["checklist"]], "reviewPolicy.checklist IDs")
    del checklist_ids
    if review_policy["scrutiny"] == "required" and not review_policy["checklist"]:
        raise PackRequestError("required scrutiny must have a non-empty checklist")
    if review_policy["scrutiny"] == "not_applicable" and review_policy["checklist"]:
        raise PackRequestError("not_applicable scrutiny must have an empty checklist")

    judge = request["g1JudgeQualification"]
    assert isinstance(judge, dict)
    step_ids = unique_ids(
        [judge["knownGood"]["id"], judge["knownBad"]["id"], judge["restoration"]["id"]],
        "G1 verification step IDs",
    )
    del step_ids
    if judge["knownGood"]["expectedExit"] != "zero":
        raise PackRequestError("G1 known-good step must expect zero exit")
    # The known-bad step may be either a direct judge invocation against a known-bad
    # candidate (expected exit nonzero -- the candidate is rejected) or an aggregate
    # discrimination harness whose declared successful outcome is zero (success means
    # every internal mutant run was rejected as intended). The G1 record's command
    # contract is authoritative; both exit conventions are schema-valid step outcomes.
    if judge["knownBad"]["expectedExit"] not in ("zero", "nonzero"):
        raise PackRequestError("G1 known-bad step must expect zero or nonzero exit")
    if judge["restoration"]["expectedExit"] != "zero":
        raise PackRequestError("G1 restoration step must expect zero exit")

    approval = request["g2Approval"]
    assert isinstance(approval, dict)
    if not TIMESTAMP_PATTERN.fullmatch(approval["approvedAt"]) or not is_rfc3339(approval["approvedAt"]):
        raise PackRequestError("G2 approval timestamp must be RFC 3339 with timezone")

    artifacts = request["migrationArtifacts"]
    assert isinstance(artifacts, dict)
    route_artifacts = artifacts["routeArtifacts"]
    assert isinstance(route_artifacts, dict)
    required_route_artifacts = ROUTE_ARTIFACTS[manifest["variant"]]
    if set(route_artifacts) != set(required_route_artifacts):
        raise PackRequestError(
            f"migration variant {manifest['variant']} requires exact route artifacts: {', '.join(required_route_artifacts)}"
        )
    artifact_refs = [identity["artifactRef"] for identity in route_artifacts.values()]
    if len(set(artifact_refs)) != len(artifact_refs):
        raise PackRequestError("route artifacts must not reuse an artifactRef")
    for role, (expected_ref, _) in required_route_artifacts.items():
        if route_artifacts[role]["artifactRef"] != expected_ref:
            raise PackRequestError(f"route artifact {role} must bind {expected_ref}")

    expected_refs = {
        "manifest": "manifest.json",
        "sourceClassification": "source-classification.json",
    }
    for name, expected_ref in expected_refs.items():
        identity = artifacts[name]
        if identity["artifactRef"] != expected_ref:
            raise PackRequestError(f"migrationArtifacts.{name} must bind {expected_ref}")

    # Every upstream document that can authorize or constrain the sealed pack is copied by
    # identity. Migration policy and VDD bindings remain opaque to Missions, while G1/G2 are
    # strict code-migration gate attestations that must bind the exact current request.
    _, g1_bytes = read_declared_file(program, judge["artifact"], "G1 judge qualification")
    _, g2_bytes = read_declared_file(program, approval["artifact"], "G2 approval")
    _, manifest_bytes = read_declared_file(program, artifacts["manifest"], "migration manifest")
    _, classification_bytes = read_declared_file(
        program, artifacts["sourceClassification"], "source classification"
    )
    if parse_json_bytes(manifest_bytes, "migration manifest") != manifest:
        raise PackRequestError("migration manifest changed while producing the pack")
    if parse_json_bytes(classification_bytes, "source classification") != classification:
        raise PackRequestError("source classification changed while producing the pack")
    route_artifact_bytes: dict[str, bytes] = {}
    for role, identity in route_artifacts.items():
        route_artifact_bytes[role] = read_declared_file(program, identity, f"route artifact {role}")[1]
    read_declared_file(program, artifacts["vddBinding"], "VDD binding")
    if "pilotPlaybook" in artifacts:
        read_declared_file(program, artifacts["pilotPlaybook"], "pilot playbook")

    # Full-manifest exclusion validation: every excluded unit's decisionRef must name a
    # real rulebook revision, independent of which units this pack selects. Selected
    # excluded units are then rejected as unschedulable.
    rulebook_text = route_artifact_bytes.get("rulebook")
    errors = exclusion_errors(manifest, rulebook_text.decode("utf-8") if rulebook_text is not None else None)
    if errors:
        raise PackRequestError("; ".join(errors))
    for unit_id in unit_ids:
        unit = manifest_units[unit_id]
        if unit.get("excluded"):
            decision = unit["excluded"].get("decisionRef", "<unnamed decision>")
            raise PackRequestError(
                f"migration unit {unit_id} is excluded from migration/scheduling by {decision} and cannot be scheduled"
            )

    g1 = validate_gate_artifact(
        g1_bytes, "G1 judge qualification", "code-migration.g1-judge-qualification.v2"
    )
    g2 = validate_gate_artifact(g2_bytes, "G2 approval", "code-migration.g2-plan-approval.v2")
    assert_exact_gate_binding(request, g1, g2)
    return request


def parse_json_bytes(content: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(content.decode("utf-8"), object_pairs_hook=lambda pairs: no_duplicate_object(pairs, label))
    except (UnicodeDecodeError, json.JSONDecodeError, PackRequestError) as error:
        raise PackRequestError(f"{label} must be strict UTF-8 JSON: {error}") from error
    if not isinstance(value, dict):
        raise PackRequestError(f"{label} must be a JSON object")
    return value


def no_duplicate_object(pairs: list[tuple[str, Any]], label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PackRequestError(f"duplicate JSON key '{key}' in {label}")
        result[key] = value
    return result


def validate_gate_artifact(content: bytes, label: str, expected_schema_version: str) -> dict[str, Any]:
    artifact = parse_json_bytes(content, label)
    schema = strict_json(GATE_ARTIFACT_SCHEMA)
    errors = [
        f"{label} schema error at {json_location(list(error.absolute_path))}: {error.message}"
        for error in sorted(
            Draft202012Validator(schema).iter_errors(artifact),
            key=lambda item: (list(item.absolute_path), item.message),
        )
    ]
    if errors:
        raise PackRequestError("; ".join(errors))
    if artifact["schemaVersion"] != expected_schema_version:
        raise PackRequestError(f"{label} has the wrong gate artifact type")
    for timestamp_field in ("qualifiedAt", "approvedAt"):
        if timestamp_field in artifact and not is_rfc3339(artifact[timestamp_field]):
            raise PackRequestError(f"{label}.{timestamp_field} must be RFC 3339 with timezone")
    return artifact


def assert_exact_gate_binding(request: dict[str, Any], g1: dict[str, Any], g2: dict[str, Any]) -> None:
    artifacts = request["migrationArtifacts"]
    expected_shared = {
        "migrationId": request["migrationId"],
        "repository": request["repository"],
        "manifestDigest": artifacts["manifest"]["digest"],
        "sourceClassificationDigest": artifacts["sourceClassification"]["digest"],
        "routeArtifacts": artifacts["routeArtifacts"],
        "vddBindingDigest": artifacts["vddBinding"]["digest"],
    }
    for field, expected in expected_shared.items():
        if g1[field] != expected:
            raise PackRequestError(f"G1 judge qualification does not bind current {field}")
        if g2[field] != expected:
            raise PackRequestError(f"G2 approval does not bind current {field}")
    judge = request["g1JudgeQualification"]
    for field, expected in (
        ("knownGood", judge["knownGood"]),
        ("knownBad", judge["knownBad"]),
        ("restoration", judge["restoration"]),
    ):
        if g1[field] != expected:
            raise PackRequestError(f"G1 judge qualification does not bind current {field} step")
    if g2["g1JudgeQualificationDigest"] != judge["artifact"]["digest"]:
        raise PackRequestError("G2 approval does not bind the G1 judge qualification")
    if parse_rfc3339(g2["approvedAt"]) < parse_rfc3339(g1["qualifiedAt"]):
        raise PackRequestError("G2 approval must not precede G1 qualification")
    if g2["approvedBy"] != request["g2Approval"]["approvedBy"] or g2["approvedAt"] != request["g2Approval"]["approvedAt"]:
        raise PackRequestError("G2 approval identity does not match the pack request")
    if g2["plan"] != request["plan"]:
        raise PackRequestError("G2 approval does not bind the current selected plan")
    expected_playbook = artifacts.get("pilotPlaybook", {}).get("digest")
    if g2["pilotPlaybookDigest"] != expected_playbook:
        raise PackRequestError("G2 approval does not bind the current pilot playbook")


def json_location(parts: list[Any]) -> str:
    location = "$"
    for part in parts:
        location += f"[{part}]" if isinstance(part, int) else f".{part}"
    return location


def parse_rfc3339(value: str):
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PackRequestError("timestamp must be RFC 3339 with timezone") from error


def is_rfc3339(value: str) -> bool:
    try:
        parse_rfc3339(value)
    except PackRequestError:
        return False
    return True


def topological_units(manifest: dict[str, Any], selected: list[str]) -> list[dict[str, Any]]:
    selected_set = set(selected)
    for unit in manifest["units"]:
        if unit["id"] in selected_set and unit.get("excluded"):
            decision = unit["excluded"].get("decisionRef", "<unnamed decision>")
            raise PackRequestError(
                f"migration unit {unit['id']} is excluded from migration/scheduling by {decision} and cannot be scheduled"
            )
    units = [unit for unit in manifest["units"] if unit["id"] in selected_set]
    completed: set[str] = set()
    ordered: list[dict[str, Any]] = []
    while len(ordered) != len(units):
        ready = next(
            (
                unit
                for unit in units
                if unit["id"] not in completed
                and all(dependency in completed for dependency in unit["dependencies"])
            ),
            None,
        )
        if ready is None:
            raise PackRequestError("selected migration units cannot be ordered by dependency")
        ordered.append(ready)
        completed.add(ready["id"])
    return ordered


def v4_risk(value: str) -> str:
    return "high" if value == "critical" else value


def route_context_refs(variant: str) -> dict[str, str]:
    return {role: target_ref for role, (_, target_ref) in ROUTE_ARTIFACTS[variant].items()}


def context_inputs(variant: str, include_playbook: bool) -> list[str]:
    artifacts = [
        "approval/execution-approval.json",
        "context/g2-plan-approval.json",
        "context/judge-qualification.json",
        "context/migration-manifest.json",
        "context/source-classification.json",
        *route_context_refs(variant).values(),
        "context/vdd-binding.json",
    ]
    if include_playbook:
        artifacts.append("context/pilot-playbook.md")
    return artifacts


def artifact_declaration(kind: str, artifact_ref: str, content: bytes) -> dict[str, Any]:
    return {
        "kind": kind,
        "artifactRef": artifact_ref,
        "digest": sha256(content),
        "byteLength": len(content),
    }


def approval_subject(plan: dict[str, Any]) -> dict[str, Any]:
    subject = {key: value for key, value in plan.items() if key != "contentDigest"}
    approval_ref = plan["approval"]["approvalArtifactRef"]
    subject["artifacts"] = [
        {"kind": artifact["kind"], "artifactRef": artifact["artifactRef"]}
        if artifact["artifactRef"] == approval_ref
        else artifact
        for artifact in plan["artifacts"]
    ]
    return subject


def approval_subject_digest(plan: dict[str, Any]) -> str:
    return sha256(canonical_json(approval_subject(plan)))


def approval_envelope(plan: dict[str, Any]) -> bytes:
    approval = plan["approval"]
    repository = plan["repository"]
    envelope = {
        "schemaVersion": APPROVAL_ENVELOPE_SCHEMA_VERSION,
        "approvedBy": approval["approvedBy"],
        "approvedAt": approval["approvedAt"],
        "subject": {
            "planId": plan["planId"],
            "revision": plan["revision"],
            "repository": {
                "canonicalRealPath": repository["canonicalRealPath"],
                "baselineCommit": repository["baselineCommit"],
            },
            "subjectDigest": approval_subject_digest(plan),
        },
    }
    schema_path = missions_approval_envelope_schema()
    schema = strict_json(schema_path)
    errors = [
        f"generated approval envelope schema error at {json_location(list(error.absolute_path))}: {error.message}"
        for error in sorted(
            Draft202012Validator(schema).iter_errors(envelope),
            key=lambda item: (list(item.absolute_path), item.message),
        )
    ]
    if errors:
        raise PackRequestError("; ".join(errors))
    return f"{canonical_json(envelope)}\n".encode("utf-8")


def declared_pack_sources(request: dict[str, Any]) -> list[tuple[str, Any]]:
    artifacts = request["migrationArtifacts"]
    sources = [
        ("G2 approval", request["g2Approval"]["artifact"]),
        ("G1 judge qualification", request["g1JudgeQualification"]["artifact"]),
        ("migration manifest", artifacts["manifest"]),
        ("source classification", artifacts["sourceClassification"]),
        *[
            (f"route artifact {role}", identity)
            for role, identity in artifacts["routeArtifacts"].items()
        ],
        ("VDD binding", artifacts["vddBinding"]),
    ]
    if "pilotPlaybook" in artifacts:
        sources.append(("pilot playbook", artifacts["pilotPlaybook"]))
    for obligation in request["plan"]["units"]:
        unit_id = obligation["id"]
        sources.extend(
            (f"unit {unit_id} skill file", identity)
            for identity in obligation["skillFiles"]
        )
        sources.extend(
            (f"unit {unit_id} QA flow {flow['id']}", flow["artifact"])
            for flow in obligation["qaFlows"]
        )
    return sources


def preflight_pack_size(program: Path, request: dict[str, Any]) -> None:
    total = 0
    for label, identity in declared_pack_sources(request):
        total += declared_file_size(program, identity, label)
        if total > MAX_PACK_BYTES:
            raise PackRequestError(f"generated pack exceeds aggregate {MAX_PACK_BYTES} byte limit")


def build_plan(
    program: Path,
    manifest: dict[str, Any],
    classification: dict[str, Any],
    request: dict[str, Any],
) -> tuple[dict[str, Any], list[tuple[str, bytes]]]:
    plan_request = request["plan"]
    migration_artifacts = request["migrationArtifacts"]
    judge = request["g1JudgeQualification"]
    approval = request["g2Approval"]
    include_playbook = "pilotPlaybook" in migration_artifacts

    # Reject a pack whose declared source sizes already exceed the output budget before
    # materializing any source bytes. This keeps the request boundary bounded even when a
    # declared artifact is slow, unreadable, or adversarially large.
    preflight_pack_size(program, request)

    route_artifacts = migration_artifacts["routeArtifacts"]
    sources = [
        ("context", "context/g2-plan-approval.json", "G2 approval", approval["artifact"]),
        ("context", "context/judge-qualification.json", "G1 judge qualification", judge["artifact"]),
        ("context", "context/migration-manifest.json", "migration manifest", migration_artifacts["manifest"]),
        ("context", "context/source-classification.json", "source classification", migration_artifacts["sourceClassification"]),
        *[
            ("context", target_ref, f"route artifact {role}", route_artifacts[role])
            for role, target_ref in route_context_refs(manifest["variant"]).items()
        ],
        ("context", "context/vdd-binding.json", "VDD binding", migration_artifacts["vddBinding"]),
    ]
    if include_playbook:
        sources.append(("context", "context/pilot-playbook.md", "pilot playbook", migration_artifacts["pilotPlaybook"]))
    for obligation in plan_request["units"]:
        unit_id = obligation["id"]
        for identity in obligation["skillFiles"]:
            sources.append(("skill", identity["artifactRef"], f"unit {unit_id} skill file", identity))
        for flow in obligation["qaFlows"]:
            identity = flow["artifact"]
            sources.append(("qa", identity["artifactRef"], f"unit {unit_id} QA flow {flow['id']}", identity))
    source_refs = [target_ref for _, target_ref, _, _ in sources]
    if len(source_refs) != len(set(source_refs)):
        raise PackRequestError("pack artifact declarations contain duplicate artifact refs")

    pack_files: list[tuple[str, bytes]] = []
    declarations: list[dict[str, Any]] = []
    for kind, target_ref, label, identity in sources:
        _, content = read_declared_file(program, identity, label)
        pack_files.append((target_ref, content))
        declarations.append(artifact_declaration(kind, target_ref, content))

    classifications = {entry["id"]: entry for entry in classification["behaviors"]}
    expected_inputs = context_inputs(manifest["variant"], include_playbook)
    features: list[dict[str, Any]] = [
        {
            "id": "judge-qualification",
            "title": "Qualify the migration judge",
            "description": "Record the approved known-good, known-bad, and restoration judge obligations.",
            "milestone": plan_request["milestone"],
            "dependsOn": [],
            "expectedBehavior": [
                {
                    "id": "judge-is-discriminating",
                    "text": "The bound VDD judge accepts known-good input, rejects the known-bad candidate, and accepts the restored candidate.",
                }
            ],
            "kind": "validation",
            "allowedPaths": [],
            "skillName": None,
            "inputArtifacts": expected_inputs,
            "verification": {
                "mode": "steps",
                "steps": [judge["knownGood"], judge["knownBad"], judge["restoration"]],
            },
            "qaFlows": [],
            "risk": "high",
        }
    ]
    obligations = {unit["id"]: unit for unit in plan_request["units"]}
    for unit in topological_units(manifest, list(obligations)):
        obligation = obligations[unit["id"]]
        behavior_items: list[dict[str, str]] = []
        for behavior_id in unit["classificationIds"]:
            behavior = classifications[behavior_id]
            if not ID_PATTERN.fullmatch(behavior_id):
                raise PackRequestError(f"classification ID {behavior_id} is not a Missions-safe ID")
            behavior_items.append(
                {
                    "id": behavior_id,
                    "text": f"{behavior['statement']} Target obligation: {behavior['targetObligation']}",
                }
            )
        features.append(
            {
                "id": unit["id"],
                "title": f"Migrate {unit['id']}",
                "description": f"Implement the approved migration unit {unit['id']} owned by {unit['sharedSeamOwner']}.",
                "milestone": plan_request["milestone"],
                "dependsOn": ["judge-qualification", *unit["dependencies"]],
                "expectedBehavior": behavior_items,
                "kind": "repository_change",
                "allowedPaths": unit["targetPaths"],
                "skillName": obligation["skillName"],
                "inputArtifacts": expected_inputs,
                "verification": obligation["verification"],
                "qaFlows": [
                    {
                        "id": flow["id"],
                        "artifactRef": flow["artifact"]["artifactRef"],
                        "digest": flow["artifact"]["digest"],
                        "passCriteria": flow["passCriteria"],
                    }
                    for flow in obligation["qaFlows"]
                ],
                "risk": v4_risk(unit["risk"]),
            }
        )

    approval_artifact_ref = "approval/execution-approval.json"
    plan = {
        "schemaVersion": "missions",
        "planId": plan_request["id"],
        "revision": plan_request["revision"],
        "approval": {
            "approvedBy": approval["approvedBy"],
            "approvedAt": approval["approvedAt"],
            "approvalArtifactRef": approval_artifact_ref,
        },
        "repository": {
            **request["repository"],
            "dirtyStatePolicy": "preserve_and_reject_overlap",
        },
        "features": features,
        "reviewPolicy": plan_request["reviewPolicy"],
        "budgets": plan_request["budgets"],
        # The approval envelope binds the Plan subject while deliberately omitting this
        # declaration's self-dependent digest and size. Fill its identity only after
        # serializing the envelope, then bind the final Plan with contentDigest.
        "artifacts": [
            {"kind": "approval", "artifactRef": approval_artifact_ref, "digest": "sha256:" + "0" * 64, "byteLength": 0},
            *declarations,
        ],
    }
    envelope = approval_envelope(plan)
    if len(envelope) > MAX_ARTIFACT_BYTES:
        raise PackRequestError(f"generated approval envelope exceeds {MAX_ARTIFACT_BYTES} byte limit")
    plan["artifacts"][0] = artifact_declaration("approval", approval_artifact_ref, envelope)
    pack_files.append((approval_artifact_ref, envelope))
    plan["contentDigest"] = sha256(canonical_json(plan))
    return plan, pack_files


def inspect_repository(repository: Path) -> dict[str, str]:
    environment = dict(os.environ)
    for key in list(environment):
        if key.startswith("GIT_"):
            environment.pop(key)
    environment.update(
        {
            "PATH": "/usr/bin:/bin",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    try:
        assert_no_path_symlink(repository, "repository")
        canonical = repository.resolve(strict=True)
    except OSError as error:
        raise PackRequestError(f"repository does not exist: {repository}") from error
    if not canonical.is_dir() or canonical.is_symlink():
        raise PackRequestError("repository must be a regular directory")
    git_directory = canonical / ".git"
    try:
        metadata = git_directory.lstat()
    except OSError as error:
        raise PackRequestError("repository must use a plain .git directory worktree") from error
    if not stat.S_ISDIR(metadata.st_mode) or git_directory.is_symlink():
        raise PackRequestError("repository must use a plain .git directory worktree")
    command = [
        "/usr/bin/git",
        "--no-pager",
        f"--git-dir={git_directory}",
        f"--work-tree={canonical}",
        "-c", "include.path=/dev/null",
        "-c", "core.attributesFile=/dev/null",
        "-c", "core.hooksPath=/dev/null",
        "-c", "credential.helper=",
    ]
    top_level = run_git([*command, "rev-parse", "--show-toplevel"], canonical, environment, "repository root")
    try:
        if Path(top_level).resolve(strict=True) != canonical:
            raise PackRequestError("repository must be its Git worktree root")
    except OSError as error:
        raise PackRequestError("repository Git root is unavailable") from error
    baseline = run_git([*command, "rev-parse", "HEAD"], canonical, environment, "repository baseline")
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", baseline):
        raise PackRequestError("repository baseline is not a lowercase Git object ID")
    return {"canonicalRealPath": str(canonical), "baselineCommit": baseline}


def run_git(command: list[str], cwd: Path, environment: dict[str, str], label: str) -> str:
    import subprocess

    result = subprocess.run(command, cwd=cwd, env=environment, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise PackRequestError(f"cannot inspect {label}: {result.stderr.strip()}")
    return result.stdout.strip()


def write_at(directory_fd: int, relative_path: str, content: bytes) -> None:
    parts = PurePosixPath(relative_path).parts
    descriptor = directory_fd
    opened: list[int] = []
    try:
        for part in parts[:-1]:
            try:
                next_descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=descriptor)
                next_descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            opened.append(next_descriptor)
            descriptor = next_descriptor
        file_descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        try:
            offset = 0
            while offset < len(content):
                offset += os.write(file_descriptor, content[offset:])
            os.fsync(file_descriptor)
        finally:
            os.close(file_descriptor)
    finally:
        for opened_descriptor in reversed(opened):
            os.close(opened_descriptor)


def open_no_symlink_directory(path: Path) -> int:
    absolute = path.absolute()
    descriptor = os.open(absolute.anchor, os.O_RDONLY | os.O_DIRECTORY)
    current = Path(absolute.anchor)
    try:
        for part in absolute.parts[1:]:
            current = current / part
            flags = os.O_RDONLY | os.O_DIRECTORY
            if not is_macos_system_alias(current):
                flags |= os.O_NOFOLLOW
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def same_directory(descriptor: int, path: Path) -> bool:
    try:
        descriptor_metadata = os.fstat(descriptor)
        path_metadata = os.stat(path, follow_symlinks=True)
    except OSError:
        return False
    return (descriptor_metadata.st_dev, descriptor_metadata.st_ino) == (path_metadata.st_dev, path_metadata.st_ino)


def remove_tree_at(parent_fd: int, name: str, expected: os.stat_result | None = None) -> None:
    try:
        authority = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (
        expected is not None
        and (
            not stat.S_ISDIR(authority.st_mode)
            or (authority.st_dev, authority.st_ino) != (expected.st_dev, expected.st_ino)
        )
    ):
        return
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        return
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (authority.st_dev, authority.st_ino)
        ):
            return
        for entry in os.listdir(descriptor):
            metadata = os.stat(entry, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                remove_tree_at(descriptor, entry, metadata)
            else:
                os.unlink(entry, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) == (authority.st_dev, authority.st_ino):
        os.rmdir(name, dir_fd=parent_fd)


def rename_no_replace(parent_fd: int, source: str, target: str) -> None:
    library = ctypes.CDLL(None, use_errno=True)
    try:
        if sys.platform == "darwin":
            result = library.renameatx_np(parent_fd, source.encode(), parent_fd, target.encode(), 0x0004)
        elif sys.platform.startswith("linux"):
            result = library.renameat2(parent_fd, source.encode(), parent_fd, target.encode(), 1)
        else:
            raise PackRequestError("atomic no-replace output publication is unavailable on this platform")
    except AttributeError as error:
        raise PackRequestError("atomic no-replace output publication is unavailable on this platform") from error
    if result != 0:
        error = ctypes.get_errno()
        if error == 17:
            raise PackRequestError(f"output pack path already exists: {target}")
        raise OSError(error, os.strerror(error))


def write_pack(output: Path, repository: Path, plan: dict[str, Any], files: list[tuple[str, bytes]]) -> None:
    plan_bytes = f"{json.dumps(plan, ensure_ascii=False, indent=2)}\n".encode("utf-8")
    if len(plan_bytes) > MAX_PLAN_BYTES:
        raise PackRequestError(f"generated approved plan exceeds {MAX_PLAN_BYTES} byte limit")
    handoff_bytes = render_handoff(output, plan).encode("utf-8")
    total_bytes = len(plan_bytes) + len(handoff_bytes) + sum(len(content) for _, content in files)
    if total_bytes > MAX_PACK_BYTES:
        raise PackRequestError(f"generated pack exceeds aggregate {MAX_PACK_BYTES} byte limit")
    assert_no_path_symlink(output, "output")
    canonical_output = output.resolve(strict=False)
    if canonical_output == repository or repository in canonical_output.parents:
        raise PackRequestError("output pack must be outside the target repository")
    parent = output.parent
    try:
        parent_fd = open_no_symlink_directory(parent)
    except OSError as error:
        raise PackRequestError(f"output parent must be a regular directory: {parent}") from error
    temporary_name = f".{output.name}.tmp-{secrets.token_hex(16)}"
    temporary_authority: os.stat_result | None = None
    try:
        try:
            metadata = os.stat(output.name, dir_fd=parent_fd, follow_symlinks=False)
            if metadata:
                raise PackRequestError(f"output pack path already exists: {output}")
        except FileNotFoundError:
            pass
        os.mkdir(temporary_name, 0o700, dir_fd=parent_fd)
        temporary_authority = os.stat(temporary_name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(temporary_authority.st_mode):
            raise PackRequestError("temporary output pack is not a regular directory")
        temporary_fd = os.open(temporary_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            opened = os.fstat(temporary_fd)
            if (opened.st_dev, opened.st_ino) != (temporary_authority.st_dev, temporary_authority.st_ino):
                raise PackRequestError("temporary output pack changed while being opened")
            for artifact_ref, content in files:
                write_at(temporary_fd, artifact_ref, content)
            write_at(temporary_fd, "approved-plan.json", plan_bytes)
            write_at(temporary_fd, "MISSION_HANDOFF.md", handoff_bytes)
            os.fsync(temporary_fd)
        finally:
            os.close(temporary_fd)
        current_temporary = os.stat(temporary_name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISDIR(current_temporary.st_mode)
            or (current_temporary.st_dev, current_temporary.st_ino)
            != (temporary_authority.st_dev, temporary_authority.st_ino)
        ):
            raise PackRequestError("temporary output pack changed while producing the pack")
        if not same_directory(parent_fd, parent):
            raise PackRequestError("output parent changed while producing the pack")
        rename_no_replace(parent_fd, temporary_name, output.name)
        os.fsync(parent_fd)
    except Exception:
        remove_tree_at(parent_fd, temporary_name, temporary_authority)
        raise
    finally:
        os.close(parent_fd)


def render_handoff(output: Path, plan: dict[str, Any]) -> str:
    contexts = [artifact for artifact in plan["artifacts"] if artifact["kind"] == "context"]
    lines = [
        "# Migration Execution Pack Index",
        "",
        "## Sealed pack",
        "",
        f"- Path: `{output}`",
        f"- Plan: `{plan['planId']}` revision `{plan['revision']}`",
        f"- Content digest: `{plan['contentDigest']}`",
        f"- Approval: `{plan['approval']['approvedBy']}` at `{plan['approval']['approvedAt']}`",
        "",
        "## Bound migration context",
        "",
    ]
    for artifact in contexts:
        lines.append(f"- `{artifact['artifactRef']}` — `{artifact['digest']}` ({artifact['byteLength']} bytes)")
    lines.extend(
        [
            "",
            "## Limitations",
            "",
            "- This derived index is not a Missions execution input.",
            "- Mission execution closure is not VDD migration acceptance, inventory completion, cutover, or release acceptance.",
            "- A material amendment requires a new approved execution pack and Mission.",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build one sealed Missions v4 pack from approved code-migration artifacts.")
    parser.add_argument("--program", type=Path, required=True, help="Migration program directory")
    parser.add_argument("--output", type=Path, required=True, help="New execution-pack directory")
    parser.add_argument("--repository", type=Path, required=True, help="Canonical Git worktree root")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        assert_no_path_symlink(args.program, "program")
        program = args.program.resolve(strict=True)
        if not program.is_dir() or program.is_symlink():
            raise PackRequestError("program must be a regular directory")
        manifest = strict_json_at(program, "manifest.json", "manifest.json")
        classification = strict_json_at(program, "source-classification.json", "source-classification.json")
        request = strict_json_at(
            program,
            "missions-v4-pack-request.json",
            "missions-v4-pack-request.json",
        )
        errors = schema_errors(manifest, MANIFEST_SCHEMA, "manifest")
        errors.extend(schema_errors(classification, CLASSIFICATION_SCHEMA, "source classification"))
        if errors:
            raise PackRequestError("; ".join(errors))
        assert isinstance(manifest, dict) and isinstance(classification, dict)
        errors = semantic_errors(manifest, classification)
        if errors:
            raise PackRequestError("; ".join(errors))
        repository = inspect_repository(args.repository)
        request = validate_request(program, manifest, classification, request, repository)
        plan, files = build_plan(program, manifest, classification, request)
        # Resolved here, before the pack is written, and only reported afterwards. The resolver
        # is deterministic and build_plan has already succeeded through it, so this restates a
        # settled fact — but a failure path must not sit after an irreversible side effect: a
        # raise below write_pack would exit non-zero with a sealed pack on disk and no packPath
        # on stdout, telling a caller the build failed when it did not.
        envelope_schema = missions_approval_envelope_schema()
        if inspect_repository(args.repository) != repository:
            raise PackRequestError("target repository changed while producing the pack")
        write_pack(args.output.absolute(), Path(repository["canonicalRealPath"]), plan, files)
        print(
            json.dumps(
                {
                    "ok": True,
                    "schemaVersion": "missions",
                    "packPath": str(args.output.absolute()),
                    "planId": plan["planId"],
                    "contentDigest": plan["contentDigest"],
                    "approvalEnvelopeSchema": str(envelope_schema),
                }
            )
        )
        return 0
    except PackRequestError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
