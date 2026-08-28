#!/usr/bin/env python3
"""Reference VDD acceptance control plane.

Run this tool outside candidate write authority. It validates the protected plan before
execution, runs against a point-in-time workspace snapshot, derives discovery and command
evidence, resolves prior attestations, and authenticates the result with an HMAC key.
"""
from __future__ import annotations

import argparse
import copy
import ctypes
import ctypes.util
import fcntl
import errno
import hashlib
import hmac
import json
import os
import platform
import re
import shutil
import shlex
import select
import signal
import stat
import subprocess
import sys
import sysconfig
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from jsonschema import Draft202012Validator

from vdd_lint import contract_fingerprint, load_json, validate_contract, validate_evidence

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_VALIDATOR = Draft202012Validator(load_json(ROOT / "schemas" / "contract.schema.json"))
EVIDENCE_VALIDATOR = Draft202012Validator(load_json(ROOT / "schemas" / "evidence.schema.json"))
ACCEPTANCE_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024
ISOLATION_POLICY_LIMIT_BYTES = ACCEPTANCE_OUTPUT_LIMIT_BYTES
DIRECT_SANDBOX_CLEANUP_GRACE_SECONDS = 1
GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024
GIT_COMMAND_TIMEOUT_SECONDS = 30
GIT_SYMLINK_TARGET_LIMIT_BYTES = 64 * 1024
CONTROL_PLANE_INPUT_LIMIT_BYTES = 8 * 1024 * 1024
SIGNING_KEY_LIMIT_BYTES = 1024 * 1024
SANDBOX_STARTUP_PROBE_TIMEOUT_SECONDS = 5
SANDBOX_STARTUP_PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024
_DISCOVERED_GIT_EXECUTABLE = shutil.which("git", path=os.defpath)
_PINNED_GIT_EXECUTABLE = (
    Path(_DISCOVERED_GIT_EXECUTABLE).resolve()
    if _DISCOVERED_GIT_EXECUTABLE is not None
    else None
)


def _git_executable_identity(status: os.stat_result) -> tuple[int, int, int, int, int, int]:
    if not stat.S_ISREG(status.st_mode):
        raise ValueError("source provenance git executable is not a regular file")
    return (
        status.st_dev,
        status.st_ino,
        status.st_mode,
        status.st_size,
        status.st_mtime_ns,
        status.st_ctime_ns,
    )


try:
    _PINNED_GIT_EXECUTABLE_IDENTITY = (
        _git_executable_identity(_PINNED_GIT_EXECUTABLE.stat(follow_symlinks=False))
        if _PINNED_GIT_EXECUTABLE is not None
        else None
    )
except (OSError, ValueError):
    _PINNED_GIT_EXECUTABLE_IDENTITY = None


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def canonical_digest(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_canonical_bytes(value)).hexdigest()}"


def qualification_contract_fingerprint(
    contract: dict[str, Any],
    oracle: dict[str, Any],
    *,
    qualification_basis: dict[str, Any] | None = None,
    covered_defeater_ids: list[str] | None = None,
) -> str:
    """Bind reuse to the contract facts that define an oracle's qualification."""
    oracle_id = oracle.get("id")
    qualification = oracle.get("qualification")
    if not isinstance(oracle_id, str) or not oracle_id or not isinstance(qualification, dict):
        raise ValueError("qualification fingerprint requires an identified oracle")
    basis = qualification_basis
    if basis is None:
        basis = qualification.get("qualification_basis")
    covered = covered_defeater_ids
    if covered is None:
        covered = qualification.get("covered_defeater_ids")
    linked_claims = [
        claim
        for claim in contract.get("claims", [])
        if isinstance(claim, dict) and oracle_id in claim.get("oracle_ids", [])
    ]
    linked_defeaters = [
        defeater
        for defeater in contract.get("defeaters", [])
        if isinstance(defeater, dict) and oracle_id in defeater.get("oracle_ids", [])
    ]
    return canonical_digest(
        {
            "intent": contract.get("intent"),
            "oracle": {
                key: oracle.get(key)
                for key in (
                    "id",
                    "type",
                    "owner",
                    "protected",
                    "revision",
                    "fingerprint",
                    "claims",
                    "failure_classes",
                    "quality",
                )
            },
            "qualification_basis": basis,
            "covered_defeater_ids": sorted(covered or []),
            "claims": linked_claims,
            "defeaters": linked_defeaters,
            "fixtures": contract.get("fixtures"),
            "environment": contract.get("environment"),
            "control_plane": contract.get("control_plane"),
            "scope": contract.get("scope"),
            "candidate_capabilities": contract.get("candidate_capabilities"),
            "roles": contract.get("roles"),
        }
    )


def _metadata_bytes_from_status(status: os.stat_result) -> bytes:
    return (
        f"type={stat.S_IFMT(status.st_mode):o};mode={stat.S_IMODE(status.st_mode):o}\0"
    ).encode("ascii")


def _required_open_flag(name: str) -> int:
    value = getattr(os, name, None)
    if not isinstance(value, int):
        raise ValueError(f"secure artifact reads require os.{name}")
    return value


def _open_regular_file_nofollow(path: Path) -> tuple[int, os.stat_result]:
    """Open one regular file without following a swapped ancestor or leaf."""
    absolute = Path(os.path.abspath(path))
    if absolute.name in {"", ".", ".."}:
        raise ValueError(f"artifact path is invalid: {path}")
    dir_fd = _open_directory_nofollow(absolute.parent)
    try:
        file_flags = os.O_RDONLY | _required_open_flag("O_NOFOLLOW")
        file_flags |= _required_open_flag("O_NONBLOCK") | _required_open_flag("O_CLOEXEC")
        file_fd = os.open(absolute.name, file_flags, dir_fd=dir_fd)
    finally:
        os.close(dir_fd)
    try:
        status = os.fstat(file_fd)
        if not stat.S_ISREG(status.st_mode):
            raise ValueError(f"artifact must be a regular file: {path}")
        return file_fd, status
    except Exception:
        os.close(file_fd)
        raise


def _hash_regular_file_fd(file_fd: int, status: os.stat_result) -> str:
    digest = hashlib.sha256()
    digest.update(_metadata_bytes_from_status(status))
    byte_length = 0
    try:
        while chunk := os.read(file_fd, 1024 * 1024):
            byte_length += len(chunk)
            digest.update(chunk)
        final_status = os.fstat(file_fd)
        if (
            byte_length != status.st_size
            or _stable_stat_identity(final_status) != _stable_stat_identity(status)
        ):
            raise ValueError("artifact changed while reading")
    finally:
        os.close(file_fd)
    return f"sha256:{digest.hexdigest()}"


def file_fingerprint(path: Path) -> str:
    file_fd, status = _open_regular_file_nofollow(path)
    return _hash_regular_file_fd(file_fd, status)


def _read_regular_file_bytes(
    path: Path,
    *,
    max_bytes: int,
) -> tuple[bytes, str]:
    file_fd, status = _open_regular_file_nofollow(path)
    chunks: list[bytes] = []
    byte_length = 0
    digest = hashlib.sha256()
    digest.update(_metadata_bytes_from_status(status))
    try:
        while chunk := os.read(file_fd, 65536):
            byte_length += len(chunk)
            if byte_length > max_bytes:
                raise ValueError(
                    f"artifact exceeded bounded input limit of {max_bytes} bytes: {path}"
                )
            chunks.append(chunk)
            digest.update(chunk)
        final_status = os.fstat(file_fd)
        if (
            byte_length != status.st_size
            or _stable_stat_identity(final_status) != _stable_stat_identity(status)
        ):
            raise ValueError(f"artifact changed while reading: {path}")
    finally:
        os.close(file_fd)
    return b"".join(chunks), f"sha256:{digest.hexdigest()}"


def _load_regular_json(
    path: Path,
    *,
    max_bytes: int = ACCEPTANCE_OUTPUT_LIMIT_BYTES,
) -> tuple[dict[str, Any], bytes, str]:
    payload, fingerprint = _read_regular_file_bytes(path, max_bytes=max_bytes)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON artifact: {path}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON artifact must be an object: {path}")
    return value, payload, fingerprint


def _assert_captured_json_not_replaced(
    path: Path,
    expected: dict[str, Any],
    message: str,
) -> None:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return
    try:
        observed, _, _ = _load_regular_json(path)
    except (OSError, ValueError) as exc:
        raise ValueError(message) from exc
    if observed != expected:
        raise ValueError(message)


def _filesystem_entry_fingerprint(path: Path) -> str:
    absolute = Path(os.path.abspath(path))
    if absolute.name in {"", ".", ".."}:
        raise ValueError(f"artifact path is invalid: {path}")
    dir_fd = _open_directory_nofollow(absolute.parent)
    try:
        status = os.lstat(absolute.name, dir_fd=dir_fd)
        digest = hashlib.sha256()
        digest.update(_metadata_bytes_from_status(status))
        if stat.S_ISLNK(status.st_mode):
            digest.update(os.readlink(absolute.name, dir_fd=dir_fd).encode("utf-8"))
        return f"sha256:{digest.hexdigest()}"
    finally:
        os.close(dir_fd)


def _validate_schema(
    value: dict[str, Any],
    validator: Draft202012Validator,
    label: str,
) -> None:
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.path))
    if errors:
        rendered = []
        for error in errors:
            location = ".".join(str(part) for part in error.path) or "<root>"
            rendered.append(f"{location}: {error.message}")
        raise ValueError(f"{label} schema validation failed: {'; '.join(rendered)}")


def _normalize_platform_system(system: str) -> str:
    mapping = {
        "Darwin": "macos",
        "Linux": "linux",
        "Windows": "windows",
    }
    return mapping.get(system, system.lower())


def _normalize_platform_machine(machine: str) -> str:
    mapping = {
        "aarch64": "arm64",
        "arm64": "arm64",
        "amd64": "x86_64",
        "x86_64": "x86_64",
    }
    return mapping.get(machine.lower(), machine.lower())


def runtime_platform_identity() -> dict[str, str]:
    """Canonical issuer runtime identity: system, machine, platform_id."""
    system = _normalize_platform_system(platform.system())
    machine = _normalize_platform_machine(platform.machine())
    return {
        "system": system,
        "machine": machine,
        "platform_id": f"{system}-{machine}",
    }


def _resolve_execution_executable(
    command: str,
    *,
    environment: dict[str, str],
    workspace: Path,
) -> Path | None:
    command_path = Path(command)
    try:
        if command_path.is_absolute():
            resolved = command_path.resolve()
        elif "/" in command or (os.altsep is not None and os.altsep in command):
            resolved = (workspace / command_path).resolve()
        else:
            search_path = environment.get("PATH")
            if search_path is None:
                return None
            found = shutil.which(command, path=search_path)
            resolved = Path(found).resolve() if found else Path()
    except OSError:
        return None
    return resolved if resolved.is_file() else None


def derive_environment_identity(
    environment: dict[str, str],
    plan: list[dict[str, Any]],
    workspace: Path,
) -> dict[str, Any]:
    executable_identities: dict[str, dict[str, str]] = {}
    for step in plan:
        argv = step.get("argv")
        if not isinstance(argv, list) or not argv or not isinstance(argv[0], str):
            raise ValueError("cannot derive environment identity from an invalid plan")
        command = argv[0]
        if (
            not Path(command).is_absolute()
            and "/" not in command
            and (os.altsep is None or os.altsep not in command)
            and "PATH" not in environment
        ):
            raise ValueError(
                f"acceptance executable requires allowlisted PATH: {command}"
            )
        resolved = _resolve_execution_executable(
            command,
            environment=environment,
            workspace=workspace,
        )
        if resolved is None:
            raise ValueError(f"acceptance executable cannot be resolved: {command}")
        executable_identities[command] = {
            "path": str(resolved),
            "fingerprint": file_fingerprint(resolved),
        }
    details = {
        "allowlisted_variables": {
            name: canonical_digest(value)
            for name, value in sorted(environment.items())
        },
        "executables": executable_identities,
        "runtime": {
            "implementation": platform.python_implementation(),
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            **runtime_platform_identity(),
        },
    }
    return {"digest": canonical_digest(details), "details": details}


def attestation_digest(attestation: dict[str, Any]) -> str:
    payload = copy.deepcopy(attestation)
    control_plane = payload.get("control_plane")
    if isinstance(control_plane, dict):
        control_plane.pop("signature", None)
        control_plane.pop("attestation_digest", None)
    return canonical_digest(payload)


def _signature_payload(attestation: dict[str, Any]) -> bytes:
    payload = copy.deepcopy(attestation)
    control_plane = payload.get("control_plane")
    if isinstance(control_plane, dict):
        control_plane.pop("signature", None)
    return _canonical_bytes(payload)


def sign_attestation(attestation: dict[str, Any], signing_key: bytes) -> str:
    if not signing_key:
        raise ValueError("signing key must be non-empty")
    digest = hmac.new(signing_key, _signature_payload(attestation), hashlib.sha256).hexdigest()
    return f"hmac-sha256:{digest}"


def verify_attestation_signature(attestation: dict[str, Any], signing_key: bytes) -> bool:
    control_plane = attestation.get("control_plane")
    if not isinstance(control_plane, dict):
        return False
    observed = control_plane.get("signature")
    observed_digest = control_plane.get("attestation_digest")
    if not isinstance(observed, str) or not observed.startswith("hmac-sha256:"):
        return False
    expected_digest = attestation_digest(attestation)
    if not isinstance(observed_digest, str) or not hmac.compare_digest(
        observed_digest, expected_digest
    ):
        return False
    expected = sign_attestation(attestation, signing_key)
    return hmac.compare_digest(observed, expected)

def _parse_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a timestamp")
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed


def _require_unexpired_residuals(
    attestation: dict[str, Any],
    verification_time: datetime,
) -> None:
    for index, residual in enumerate(attestation.get("residual_risks", [])):
        if not isinstance(residual, dict):
            continue
        expiry = _parse_timestamp(
            residual.get("expires_at"),
            f"residual_risks[{index}].expires_at",
        )
        if expiry <= verification_time:
            raise ValueError(
                f"residual risk {residual.get('defeater_id')} expired before verification"
            )


def _safe_workspace_path(workspace: Path, relative: str) -> Path:
    if not relative or Path(relative).is_absolute():
        raise ValueError(f"workspace path must be non-empty and relative: {relative!r}")
    root = workspace.resolve()
    resolved = (root / relative).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"workspace path escapes root: {relative}") from exc
    return resolved


def _string_list(value: Any, label: str, *, nonempty: bool = False) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ValueError(f"{label} must be a string array")
    if nonempty and not value:
        raise ValueError(f"{label} must be non-empty")
    return list(value)


def _path_is_declared(relative: str, declarations: list[str]) -> bool:
    candidate = Path(relative.rstrip("/"))
    return any(candidate == Path(item) or Path(item) in candidate.parents for item in declarations)


def _path_is_declared_or_ancestor(relative: str, declarations: list[str]) -> bool:
    candidate = Path(relative.rstrip("/"))
    return any(
        candidate == Path(item)
        or Path(item) in candidate.parents
        or candidate in Path(item).parents
        for item in declarations
    )


def _normalize_command_pattern(value: str, label: str) -> tuple[str, ...]:
    try:
        tokens = tuple(item for item in shlex.split(value) if item)
    except ValueError as exc:
        raise ValueError(f"{label} contains invalid shell-style quoting: {value!r}") from exc
    if not tokens:
        raise ValueError(f"{label} contains an empty command pattern")
    return tokens


def _command_token_is_path_like(value: str) -> bool:
    return Path(value).is_absolute() or value.startswith(".") or "/" in value


def _command_token_can_be_normalized(value: str) -> bool:
    path = Path(value)
    return path.is_absolute() or value.startswith("./")


def _argv_matches_pattern(
    argv: list[str],
    pattern: tuple[str, ...],
    *,
    workspace: Path,
    environment: dict[str, str],
) -> bool:
    if len(argv) < len(pattern):
        return False
    for index, (actual, expected) in enumerate(zip(argv, pattern)):
        if actual == expected:
            continue
        if index == 0:
            actual_resolved = _resolve_execution_executable(
                actual,
                environment=environment,
                workspace=workspace,
            )
            expected_resolved = _resolve_execution_executable(
                expected,
                environment=environment,
                workspace=workspace,
            )
            if actual_resolved is None or expected_resolved is None:
                return False
            if actual_resolved != expected_resolved:
                return False
            continue
        if not (
            _command_token_can_be_normalized(actual)
            or _command_token_can_be_normalized(expected)
        ):
            return False
        try:
            actual_path = Path(actual)
            expected_path = Path(expected)
            actual_resolved = (
                actual_path if actual_path.is_absolute() else workspace / actual_path
            ).resolve()
            expected_resolved = (
                expected_path if expected_path.is_absolute() else workspace / expected_path
            ).resolve()
            if actual_resolved != expected_resolved:
                return False
        except OSError:
            return False
    return True


def _validate_execution_capabilities(
    contract: dict[str, Any],
    plan: list[dict[str, Any]],
    *,
    workspace: Path,
    environment: dict[str, str],
) -> None:
    capabilities = contract.get("candidate_capabilities")
    if not isinstance(capabilities, dict):
        raise ValueError("contract.candidate_capabilities is required")
    allowed = [
        _normalize_command_pattern(value, "candidate_capabilities.allowed_commands")
        for value in _string_list(
            capabilities.get("allowed_commands"),
            "contract.candidate_capabilities.allowed_commands",
            nonempty=True,
        )
    ]
    denied = [
        _normalize_command_pattern(value, "candidate_capabilities.denied_commands")
        for value in _string_list(
            capabilities.get("denied_commands"),
            "contract.candidate_capabilities.denied_commands",
        )
    ]
    readable = _string_list(
        capabilities.get("readable_protected_paths"),
        "contract.candidate_capabilities.readable_protected_paths",
    )
    protected = _string_list(
        contract.get("scope", {}).get("protected"),
        "contract.scope.protected",
        nonempty=True,
    )
    for path in readable:
        _safe_workspace_path(workspace, path)
        if not _path_is_declared(path, protected):
            raise ValueError(
                "candidate_capabilities.readable_protected_paths must be within contract.scope.protected: "
                f"{path}"
            )
    for step in plan:
        argv = step["argv"]
        if any(
            _argv_matches_pattern(
                argv,
                pattern,
                workspace=workspace,
                environment=environment,
            )
            for pattern in denied
        ):
            raise ValueError(
                f"execution plan step {step['id']} matches a denied candidate command"
            )
        if not any(
            _argv_matches_pattern(
                argv,
                pattern,
                workspace=workspace,
                environment=environment,
            )
            for pattern in allowed
        ):
            raise ValueError(
                f"execution plan step {step['id']} is outside candidate allowed_commands"
            )


def _paths_overlap(left: str, right: str) -> bool:
    left_path = Path(left)
    right_path = Path(right)
    return (
        left_path == right_path
        or left_path in right_path.parents
        or right_path in left_path.parents
    )


def _workspace_manifest(workspace: Path) -> dict[str, str]:
    manifest: dict[str, str] = {}
    directory_flags = os.O_RDONLY | _required_open_flag("O_DIRECTORY")
    directory_flags |= _required_open_flag("O_CLOEXEC") | _required_open_flag("O_NOFOLLOW")
    file_flags = os.O_RDONLY | _required_open_flag("O_CLOEXEC")
    file_flags |= _required_open_flag("O_NOFOLLOW") | _required_open_flag("O_NONBLOCK")

    def validate_symlink_target(
        relative: PurePosixPath,
        target: str,
    ) -> None:
        target_path = PurePosixPath(target)
        if target_path.is_absolute():
            raise ValueError(f"workspace entry escapes root: {relative.as_posix()}")
        stack = list(relative.parent.parts)
        for component in target_path.parts:
            if component in {"", "."}:
                continue
            if component == "..":
                if not stack:
                    raise ValueError(
                        f"workspace entry escapes root: {relative.as_posix()}"
                    )
                stack.pop()
            else:
                stack.append(component)

    def walk(directory_fd: int, prefix: PurePosixPath) -> None:
        initial_directory_status = os.fstat(directory_fd)
        for name in sorted(os.listdir(directory_fd)):
            if not name or "/" in name or name in {".", ".."}:
                raise ValueError("workspace contains an invalid entry")
            relative = prefix / name
            relative_text = relative.as_posix()
            entry_status = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISLNK(entry_status.st_mode):
                target = os.readlink(name, dir_fd=directory_fd)
                final_status = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if _stable_stat_identity(final_status) != _stable_stat_identity(
                    entry_status
                ):
                    raise ValueError(f"workspace changed while reading: {relative_text}")
                validate_symlink_target(relative, target)
                manifest[relative_text] = "sha256:" + hashlib.sha256(
                    _metadata_bytes_from_status(entry_status) + target.encode("utf-8")
                ).hexdigest()
                continue
            if stat.S_ISDIR(entry_status.st_mode):
                child_fd = os.open(name, directory_flags, dir_fd=directory_fd)
                try:
                    child_status = os.fstat(child_fd)
                    if (child_status.st_dev, child_status.st_ino) != (
                        entry_status.st_dev,
                        entry_status.st_ino,
                    ):
                        raise ValueError(
                            f"workspace changed while reading: {relative_text}"
                        )
                    walk(child_fd, relative)
                    manifest[f"{relative_text}/"] = "sha256:" + hashlib.sha256(
                        _metadata_bytes_from_status(child_status)
                    ).hexdigest()
                finally:
                    os.close(child_fd)
                continue
            if not stat.S_ISREG(entry_status.st_mode):
                raise ValueError(f"unsupported workspace entry type: {relative_text}")
            file_fd = os.open(name, file_flags, dir_fd=directory_fd)
            try:
                file_status = os.fstat(file_fd)
                if (file_status.st_dev, file_status.st_ino) != (
                    entry_status.st_dev,
                    entry_status.st_ino,
                ):
                    raise ValueError(f"workspace changed while reading: {relative_text}")
                transferred_fd = file_fd
                file_fd = -1
                manifest[relative_text] = _hash_regular_file_fd(
                    transferred_fd,
                    file_status,
                )
            finally:
                if file_fd >= 0:
                    os.close(file_fd)
            final_status = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if _stable_stat_identity(final_status) != _stable_stat_identity(entry_status):
                raise ValueError(f"workspace changed while reading: {relative_text}")
        final_directory_status = os.fstat(directory_fd)
        if _stable_stat_identity(final_directory_status) != _stable_stat_identity(
            initial_directory_status
        ):
            raise ValueError("workspace changed while reading")

    root_fd = _open_directory_nofollow(workspace)
    try:
        walk(root_fd, PurePosixPath())
    except OSError as exc:
        raise ValueError("workspace changed while reading") from exc
    finally:
        os.close(root_fd)
    return manifest


def _copy_workspace_snapshot(
    source: Path,
    destination: Path,
    *,
    expected_manifest: dict[str, str],
) -> dict[str, str]:
    """Copy one workspace generation through no-follow directory descriptors."""
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"acceptance snapshot destination already exists: {destination}")
    destination.mkdir(mode=0o700)
    observed_manifest: dict[str, str] = {}
    directory_flags = os.O_RDONLY | _required_open_flag("O_DIRECTORY")
    directory_flags |= _required_open_flag("O_CLOEXEC") | _required_open_flag("O_NOFOLLOW")
    file_flags = os.O_RDONLY | _required_open_flag("O_CLOEXEC")
    file_flags |= _required_open_flag("O_NOFOLLOW") | _required_open_flag("O_NONBLOCK")

    def copy_directory(source_fd: int, destination_path: Path, prefix: PurePosixPath) -> None:
        initial_directory_status = os.fstat(source_fd)
        if not stat.S_ISDIR(initial_directory_status.st_mode):
            raise ValueError("acceptance snapshot source changed from directory")
        for name in sorted(os.listdir(source_fd)):
            if not name or "/" in name or name in {".", ".."}:
                raise ValueError("acceptance snapshot source contains an invalid entry")
            relative = prefix / name
            relative_text = relative.as_posix()
            entry_status = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            destination_entry = destination_path / name
            if stat.S_ISLNK(entry_status.st_mode):
                target = os.readlink(name, dir_fd=source_fd)
                final_status = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
                if _stable_stat_identity(final_status) != _stable_stat_identity(entry_status):
                    raise ValueError(
                        f"workspace changed while creating acceptance snapshot: {relative_text}"
                    )
                observed_manifest[relative_text] = "sha256:" + hashlib.sha256(
                    _metadata_bytes_from_status(entry_status) + target.encode("utf-8")
                ).hexdigest()
                os.symlink(target, destination_entry)
                continue
            if stat.S_ISDIR(entry_status.st_mode):
                child_fd = os.open(name, directory_flags, dir_fd=source_fd)
                try:
                    child_status = os.fstat(child_fd)
                    if (child_status.st_dev, child_status.st_ino) != (
                        entry_status.st_dev,
                        entry_status.st_ino,
                    ):
                        raise ValueError(
                            f"workspace changed while creating acceptance snapshot: {relative_text}"
                        )
                    destination_entry.mkdir(mode=0o700)
                    copy_directory(child_fd, destination_entry, relative)
                    os.chmod(destination_entry, stat.S_IMODE(child_status.st_mode))
                    observed_manifest[f"{relative_text}/"] = "sha256:" + hashlib.sha256(
                        _metadata_bytes_from_status(child_status)
                    ).hexdigest()
                finally:
                    os.close(child_fd)
                continue
            if not stat.S_ISREG(entry_status.st_mode):
                raise ValueError(f"unsupported workspace entry type: {relative_text}")
            source_file_fd = os.open(name, file_flags, dir_fd=source_fd)
            destination_file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            destination_file_flags |= _required_open_flag("O_CLOEXEC")
            destination_file_flags |= _required_open_flag("O_NOFOLLOW")
            destination_file_fd = -1
            try:
                source_file_status = os.fstat(source_file_fd)
                if (
                    not stat.S_ISREG(source_file_status.st_mode)
                    or (source_file_status.st_dev, source_file_status.st_ino)
                    != (entry_status.st_dev, entry_status.st_ino)
                ):
                    raise ValueError(
                        f"workspace changed while creating acceptance snapshot: {relative_text}"
                    )
                destination_file_fd = os.open(
                    destination_entry,
                    destination_file_flags,
                    0o600,
                )
                digest = hashlib.sha256()
                digest.update(_metadata_bytes_from_status(source_file_status))
                byte_length = 0
                source_handle = os.fdopen(source_file_fd, "rb")
                source_file_fd = -1
                try:
                    destination_handle = os.fdopen(destination_file_fd, "wb")
                    destination_file_fd = -1
                except BaseException:
                    source_handle.close()
                    raise
                with source_handle, destination_handle:
                    while chunk := source_handle.read(1024 * 1024):
                        byte_length += len(chunk)
                        digest.update(chunk)
                        destination_handle.write(chunk)
                    destination_handle.flush()
                    os.fchmod(
                        destination_handle.fileno(),
                        stat.S_IMODE(source_file_status.st_mode),
                    )
                final_status = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
                if (
                    byte_length != source_file_status.st_size
                    or _stable_stat_identity(final_status)
                    != _stable_stat_identity(source_file_status)
                ):
                    raise ValueError(
                        f"workspace changed while creating acceptance snapshot: {relative_text}"
                    )
                observed_manifest[relative_text] = f"sha256:{digest.hexdigest()}"
            finally:
                if source_file_fd >= 0:
                    os.close(source_file_fd)
                if destination_file_fd >= 0:
                    os.close(destination_file_fd)
        final_directory_status = os.fstat(source_fd)
        if _stable_stat_identity(final_directory_status) != _stable_stat_identity(
            initial_directory_status
        ):
            raise ValueError("workspace changed while creating acceptance snapshot")

    source_fd = _open_directory_nofollow(source)
    try:
        try:
            copy_directory(source_fd, destination, PurePosixPath())
        except OSError as exc:
            raise ValueError(
                "workspace changed while creating acceptance snapshot"
            ) from exc
    finally:
        os.close(source_fd)
    if observed_manifest != expected_manifest:
        raise ValueError("workspace changed while creating acceptance snapshot")
    return observed_manifest


def _verify_protected_assets(contract: dict[str, Any], workspace: Path) -> list[dict[str, str]]:
    control_plane = contract.get("control_plane")
    if not isinstance(control_plane, dict):
        raise ValueError("contract.control_plane is required")
    assets = control_plane.get("protected_assets")
    if not isinstance(assets, list) or not assets:
        raise ValueError("contract.control_plane.protected_assets must be non-empty")

    snapshot: list[dict[str, str]] = []
    entries: dict[str, dict[str, Any]] = {}
    expected_fingerprints: dict[str, str] = {}
    for index, raw in enumerate(assets):
        if not isinstance(raw, dict):
            raise ValueError(f"protected_assets[{index}] must be an object")
        relative = raw.get("path")
        expected = raw.get("fingerprint")
        if not isinstance(relative, str) or not isinstance(expected, str):
            raise ValueError(f"protected_assets[{index}] requires path and fingerprint")
        if relative in entries:
            raise ValueError(f"duplicate protected asset: {relative}")
        relative_path = PurePosixPath(relative)
        if (
            not relative
            or relative_path.is_absolute()
            or any(part in {"", ".", ".."} for part in relative_path.parts)
        ):
            raise ValueError(f"protected asset path is invalid: {relative}")
        try:
            entries[relative] = _observe_rooted_artifact(workspace, relative)
        except (OSError, ValueError) as exc:
            raise ValueError(f"protected asset is missing: {relative}") from exc
        expected_fingerprints[relative] = expected

    def protected_symlink_target(
        relative: str,
        observation: dict[str, Any],
    ) -> str | None:
        if observation.get("git_type") != "symlink":
            return None
        target = observation.get("symlink_target")
        if not isinstance(target, str):
            raise ValueError(f"protected symlink target is invalid: {relative}")
        target_path = PurePosixPath(target)
        if target_path.is_absolute():
            raise ValueError(f"protected symlink target escapes workspace: {relative}")
        stack: list[str] = []
        for component in (*PurePosixPath(relative).parent.parts, *target_path.parts):
            if component in {"", "."}:
                continue
            if component == "..":
                if not stack:
                    raise ValueError(
                        f"protected symlink target escapes workspace: {relative}"
                    )
                stack.pop()
                continue
            stack.append(component)
        if not stack:
            raise ValueError(f"protected symlink target is invalid: {relative}")
        return PurePosixPath(*stack).as_posix()

    for relative, observation in entries.items():
        observed = observation["fingerprint"]
        if not hmac.compare_digest(observed, expected_fingerprints[relative]):
            raise ValueError(f"protected asset fingerprint differs: {relative}")
        seen_links: set[str] = set()
        current_relative = relative
        current_observation = observation
        while True:
            target_relative = protected_symlink_target(
                current_relative,
                current_observation,
            )
            if target_relative is None:
                break
            if target_relative in seen_links:
                raise ValueError(f"protected symlink cycle: {relative}")
            seen_links.add(target_relative)
            target_observation = entries.get(target_relative)
            if target_observation is None:
                raise ValueError(
                    f"protected symlink target must be separately protected: {current_relative}"
                )
            current_observation = target_observation
            current_relative = target_relative
        snapshot.append({"path": relative, "fingerprint": observed})
    return snapshot


def _candidate_snapshot(
    contract: dict[str, Any], workspace: Path
) -> list[dict[str, str]]:
    control_plane = contract.get("control_plane")
    assert isinstance(control_plane, dict)
    paths = _string_list(
        control_plane.get("candidate_artifacts"),
        "contract.control_plane.candidate_artifacts",
        nonempty=True,
    )
    entries: dict[str, str] = {}

    def canonical_symlink_target(relative: str, target: str) -> str:
        target_path = PurePosixPath(target)
        if target_path.is_absolute():
            raise ValueError(f"candidate artifact symlink escapes workspace: {relative}")
        stack: list[str] = []
        for component in (*PurePosixPath(relative).parent.parts, *target_path.parts):
            if component in {"", "."}:
                continue
            if component == "..":
                if not stack:
                    raise ValueError(
                        f"candidate artifact symlink escapes workspace: {relative}"
                    )
                stack.pop()
            else:
                stack.append(component)
        if not stack:
            raise ValueError(f"candidate artifact symlink target is invalid: {relative}")
        return PurePosixPath(*stack).as_posix()

    def require_regular_target(
        relative: str,
        observation: dict[str, Any],
        seen: set[str],
    ) -> None:
        if observation["git_type"] == "file":
            return
        if relative in seen:
            raise ValueError(f"candidate artifact symlink cycle: {relative}")
        seen.add(relative)
        target = observation.get("symlink_target")
        if not isinstance(target, str):
            raise ValueError(f"candidate artifact symlink target is invalid: {relative}")
        target_relative = canonical_symlink_target(relative, target)
        target_observation = _observe_rooted_artifact(workspace, target_relative)
        require_regular_target(target_relative, target_observation, seen)

    directory_flags = os.O_RDONLY | _required_open_flag("O_DIRECTORY")
    directory_flags |= _required_open_flag("O_CLOEXEC") | _required_open_flag("O_NOFOLLOW")
    for relative in paths:
        relative_path = Path(relative)
        if (
            not relative
            or relative_path.is_absolute()
            or any(part in {"", ".", ".."} for part in relative_path.parts)
        ):
            raise ValueError(f"candidate artifact path must be canonical: {relative}")
        root_fd = _open_directory_nofollow(workspace)
        directory_stack: list[tuple[int, os.stat_result]] = [
            (root_fd, os.fstat(root_fd))
        ]
        current_fd = root_fd
        try:
            prefix = PurePosixPath()
            for component in relative_path.parts[:-1]:
                prefix /= component
                status = os.stat(
                    component,
                    dir_fd=current_fd,
                    follow_symlinks=False,
                )
                if stat.S_ISLNK(status.st_mode):
                    raise ValueError(
                        f"candidate artifact has a symlink ancestor: {relative}"
                    )
                if not stat.S_ISDIR(status.st_mode):
                    raise ValueError(f"candidate artifact is missing: {relative}")
                child_fd = os.open(component, directory_flags, dir_fd=current_fd)
                child_status = os.fstat(child_fd)
                if (child_status.st_dev, child_status.st_ino) != (
                    status.st_dev,
                    status.st_ino,
                ):
                    os.close(child_fd)
                    raise ValueError(
                        f"candidate artifact changed while reading: {relative}"
                    )
                directory_stack.append((child_fd, child_status))
                current_fd = child_fd
                entries[f"{prefix.as_posix()}/"] = "sha256:" + hashlib.sha256(
                    _metadata_bytes_from_status(child_status)
                ).hexdigest()
            observation = _observe_artifact_at(
                current_fd,
                relative_path.name,
                relative,
            )
            require_regular_target(relative, observation, set())
            entries[relative_path.as_posix()] = observation["fingerprint"]
            for directory_fd, status in reversed(directory_stack):
                if _stable_stat_identity(os.fstat(directory_fd)) != _stable_stat_identity(
                    status
                ):
                    raise ValueError(
                        f"candidate artifact changed while reading: {relative}"
                    )
        except OSError as exc:
            raise ValueError(f"candidate artifact is missing: {relative}") from exc
        finally:
            for directory_fd, _ in reversed(directory_stack):
                os.close(directory_fd)
    return [
        {"path": path, "fingerprint": fingerprint}
        for path, fingerprint in sorted(entries.items())
    ]


def _preflight_control_plane(
    contract: dict[str, Any], workspace: Path
) -> tuple[
    list[dict[str, Any]],
    list[str],
    dict[str, str],
    list[dict[str, str]],
    list[dict[str, str]],
    dict[str, str],
    dict[str, Any],
]:
    _validate_schema(contract, CONTRACT_VALIDATOR, "contract")
    contract_result = validate_contract(contract)
    if contract_result.errors:
        raise ValueError("contract validation failed: " + "; ".join(contract_result.errors))
    control_plane = contract.get("control_plane")
    if not isinstance(control_plane, dict):
        raise ValueError("contract.control_plane is required")

    candidates = _string_list(
        control_plane.get("candidate_artifacts"),
        "contract.control_plane.candidate_artifacts",
        nonempty=True,
    )
    if len(set(candidates)) != len(candidates):
        raise ValueError("candidate artifact paths must be unique")
    allowed_outputs = _string_list(
        control_plane.get("allowed_output_paths"),
        "contract.control_plane.allowed_output_paths",
    )
    if len(set(allowed_outputs)) != len(allowed_outputs):
        raise ValueError("allowed output paths must be unique")
    environment_allowlist = _string_list(
        control_plane.get("environment_allowlist"),
        "contract.control_plane.environment_allowlist",
    )
    if len(set(environment_allowlist)) != len(environment_allowlist):
        raise ValueError("environment allowlist entries must be unique")
    for name in environment_allowlist:
        if (
            not name.isascii()
            or not (name[0].isalpha() or name[0] == "_")
            or not all(character.isalnum() or character == "_" for character in name)
        ):
            raise ValueError(f"environment allowlist entry is invalid: {name}")
        if name not in os.environ:
            raise ValueError(f"allowlisted environment variable is unset: {name}")
    execution_environment = {
        name: os.environ[name]
        for name in environment_allowlist
    }
    candidate_resolved = [
        _safe_workspace_path(workspace, relative)
        for relative in candidates
    ]
    candidate_lexical = [
        workspace.resolve() / Path(relative)
        for relative in candidates
    ]
    output_resolved = [
        _safe_workspace_path(workspace, relative)
        for relative in allowed_outputs
    ]
    if len(set(candidate_lexical)) != len(candidate_lexical):
        raise ValueError("candidate artifacts have duplicate lexical paths")
    if len(set(output_resolved)) != len(output_resolved):
        raise ValueError("allowed outputs resolve to duplicate paths")

    editable = contract.get("scope", {}).get("editable")
    editable_paths = _string_list(editable, "contract.scope.editable", nonempty=True)
    for relative in editable_paths:
        _safe_workspace_path(workspace, relative)
    for relative in candidates:
        if not _path_is_declared(relative, editable_paths):
            raise ValueError(
                f"candidate artifact is outside contract.scope.editable: {relative}"
            )

    protected_declarations = _string_list(
        contract.get("scope", {}).get("protected"),
        "contract.scope.protected",
        nonempty=True,
    )
    for relative in protected_declarations:
        _safe_workspace_path(workspace, relative)

    protected_snapshot = _verify_protected_assets(contract, workspace)
    candidate_snapshot = _candidate_snapshot(contract, workspace)
    protected_paths = {item["path"] for item in protected_snapshot}
    protected_resolved = [
        _safe_workspace_path(workspace, relative)
        for relative in protected_paths
    ]
    if len(set(protected_resolved)) != len(protected_resolved):
        raise ValueError("protected assets resolve to duplicate paths")
    for relative in protected_paths:
        if not _path_is_declared(relative, protected_declarations):
            raise ValueError(
                f"protected asset is outside contract.scope.protected: {relative}"
            )
    for declaration in protected_declarations:
        if not any(_path_is_declared(relative, [declaration]) for relative in protected_paths):
            raise ValueError(
                f"contract.scope.protected lacks a protected asset identity: {declaration}"
            )
    if set(protected_resolved).intersection(candidate_resolved):
        raise ValueError("candidate artifacts and protected assets must be disjoint")
    editable_resolved = [
        _safe_workspace_path(workspace, relative) for relative in editable_paths
    ]
    for output, resolved_output in zip(allowed_outputs, output_resolved, strict=True):
        if any(
            _paths_overlap(str(resolved_output), str(item))
            for item in candidate_resolved + protected_resolved
        ):
            raise ValueError(f"allowed output overlaps candidate/protected scope: {output}")
        if any(
            _paths_overlap(str(resolved_output), str(item))
            for item in editable_resolved
        ):
            raise ValueError(f"allowed output overlaps editable scope: {output}")

    raw_plan = control_plane.get("execution_plan")
    if not isinstance(raw_plan, list) or not raw_plan:
        raise ValueError("contract.control_plane.execution_plan must be non-empty")
    plan: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(raw_plan):
        if not isinstance(raw, dict):
            raise ValueError(f"execution_plan[{index}] must be an object")
        command_id = raw.get("id")
        display = raw.get("display")
        argv = raw.get("argv")
        expected_exit_code = raw.get("expected_exit_code")
        expected_result = raw.get("result")
        timeout = raw.get("timeout_seconds", 120)
        if not isinstance(command_id, str) or not command_id or command_id in seen_ids:
            raise ValueError(f"execution_plan[{index}].id must be unique and non-empty")
        seen_ids.add(command_id)
        if not isinstance(display, str) or not display:
            raise ValueError(f"execution_plan[{index}].display must be non-empty")
        if not isinstance(argv, list) or not argv or not all(isinstance(part, str) for part in argv):
            raise ValueError(f"execution_plan[{index}].argv must be a non-empty string array")
        if isinstance(expected_exit_code, bool) or not isinstance(expected_exit_code, int):
            raise ValueError(f"execution_plan[{index}].expected_exit_code must be an integer")
        if expected_result not in {"pass", "expected_reject"}:
            raise ValueError(
                f"execution_plan[{index}].result must be pass or expected_reject"
            )
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
            raise ValueError(f"execution_plan[{index}].timeout_seconds must be positive")
        normalized = {
            "id": command_id,
            "display": display,
            "argv": list(argv),
            "expected_exit_code": expected_exit_code,
            "result": expected_result,
            "timeout_seconds": timeout,
            "write_paths": _string_list(
                raw.get("write_paths"), f"execution_plan[{index}].write_paths"
            ),
            "artifact_refs": _string_list(
                raw.get("artifact_refs"), f"execution_plan[{index}].artifact_refs"
            ),
            "claim_ids": _string_list(
                raw.get("claim_ids", []), f"execution_plan[{index}].claim_ids"
            ),
            "defeater_ids": _string_list(
                raw.get("defeater_ids", []), f"execution_plan[{index}].defeater_ids"
            ),
        }
        for path in normalized["write_paths"]:
            if path not in allowed_outputs:
                raise ValueError(
                    f"execution_plan[{index}].write_paths value '{path}' must be an allowed output"
                )
            if not _path_is_declared_or_ancestor(path, normalized["artifact_refs"]):
                raise ValueError(
                    f"execution_plan[{index}].write_paths value '{path}' must be declared in artifact_refs"
                )
            resolved = _safe_workspace_path(workspace, path)
            if any(
                _paths_overlap(str(resolved), str(item))
                for item in (
                    candidate_resolved + protected_resolved + editable_resolved
                )
            ):
                raise ValueError(
                    f"execution_plan[{index}].write_paths value '{path}' overlaps candidate/protected scope"
                )
        plan.append(normalized)

    # Bind Contract-owned expected rejection signals onto known-bad plan steps.
    expected_signals_by_defeater: dict[str, str] = {}
    has_fresh_qualification = False
    for oracle in contract.get("oracles", []):
        qualification = oracle.get("qualification", {})
        if not isinstance(qualification, dict):
            continue
        if qualification.get("status") == "fresh":
            has_fresh_qualification = True
        for case in qualification.get("known_bad_cases", []):
            if not isinstance(case, dict):
                continue
            defeater_id = case.get("defeater_id")
            signal = case.get("expected_rejection")
            if isinstance(defeater_id, str) and isinstance(signal, str) and signal:
                expected_signals_by_defeater[defeater_id] = signal
    for step in plan:
        if step["result"] != "expected_reject":
            continue
        signals = []
        missing_defeaters: list[str] = []
        for defeater_id in step["defeater_ids"]:
            signal = expected_signals_by_defeater.get(defeater_id)
            if isinstance(signal, str) and signal:
                signals.append(signal)
            else:
                missing_defeaters.append(defeater_id)
        if missing_defeaters and has_fresh_qualification:
            raise ValueError(
                f"expected_reject step {step['id']} lacks Contract expected_rejection "
                f"signal for: {missing_defeaters}"
            )
        if signals:
            # Require every associated Defeater signal; no partial credit.
            step["expected_rejection_signals"] = signals


    plan_by_id = {step["id"]: step for step in plan}
    plan_positions = {step["id"]: index for index, step in enumerate(plan)}
    non_stability_role_ids = {control_plane["discovery"]["command_id"]}
    metric_result_plan = control_plane.get("metric_result")
    if isinstance(metric_result_plan, dict):
        non_stability_role_ids.add(metric_result_plan["command_id"])
    for oracle in contract.get("oracles", []):
        qualification = oracle.get("qualification", {})
        if qualification.get("status") != "fresh":
            continue
        stability_ids = qualification.get("stability_command_ids", [])
        if not isinstance(stability_ids, list) or any(
            not isinstance(command_id, str) or not command_id
            for command_id in stability_ids
        ):
            raise ValueError(
                f"oracle {oracle.get('id')} stability_command_ids must be a string array"
            )
        if len(stability_ids) != len(set(stability_ids)):
            raise ValueError(
                f"oracle {oracle.get('id')} stability_command_ids must be unique"
            )
        overlapping_role_ids = sorted(
            set(stability_ids).intersection(non_stability_role_ids)
        )
        if overlapping_role_ids:
            raise ValueError(
                f"oracle {oracle.get('id')} stability_command_ids overlap "
                f"non-stability control-plane roles: {overlapping_role_ids}"
            )
        required_trials = qualification.get("required_no_change_trials", 0)
        if len(stability_ids) < required_trials:
            raise ValueError(
                f"oracle {oracle.get('id')} requires at least {required_trials} "
                "stability_command_ids"
            )
        restore_positions = [
            index
            for index, step in enumerate(plan)
            if step["display"] == qualification.get("restore_command")
            and step["id"] not in stability_ids
        ]
        if not restore_positions:
            raise ValueError(
                f"oracle {oracle.get('id')} restore command lacks a distinct plan step"
            )
        restoration_position = max(restore_positions)
        for command_id in stability_ids:
            step = plan_by_id.get(command_id)
            if step is None:
                raise ValueError(
                    f"oracle {oracle.get('id')} stability command {command_id} "
                    "does not reference a plan step"
                )
            if step["result"] != "pass":
                raise ValueError(
                    f"oracle {oracle.get('id')} stability command {command_id} "
                    "must expect pass"
                )
            if step["expected_exit_code"] != 0:
                raise ValueError(
                    f"oracle {oracle.get('id')} stability command {command_id} "
                    "must expect exit code 0"
                )
            if step["display"] != qualification.get("known_good_command"):
                raise ValueError(
                    f"oracle {oracle.get('id')} stability command {command_id} "
                    "must execute the known-good command"
                )
            if plan_positions[command_id] <= restoration_position:
                raise ValueError(
                    f"oracle {oracle.get('id')} stability command {command_id} "
                    "must run after restoration"
                )

    def _require_result_producer(plan_name: str, result_plan: dict[str, Any]) -> None:
        command_id = result_plan.get("command_id")
        result_path = result_plan.get("result_path")
        producer_path = result_plan.get("producer_path")
        if not isinstance(command_id, str) or command_id not in seen_ids:
            raise ValueError(
                f"contract.control_plane.{plan_name}.command_id must reference a plan step"
            )
        if not isinstance(result_path, str) or result_path not in allowed_outputs:
            raise ValueError(
                f"contract.control_plane.{plan_name}.result_path must be an allowed output"
            )
        step = plan_by_id[command_id]
        if step["result"] != "pass":
            raise ValueError(f"{plan_name} plan step must expect pass")
        if result_path not in step["artifact_refs"]:
            raise ValueError(
                f"{plan_name} plan step must declare its result path as an artifact"
            )
        if not _path_is_declared(result_path, step["write_paths"]):
            raise ValueError(
                f"{plan_name} producer step must own its result path in write_paths"
            )
        if not isinstance(producer_path, str) or not producer_path:
            raise ValueError(
                f"contract.control_plane.{plan_name}.producer_path is required"
            )
        if producer_path not in protected_paths:
            raise ValueError(
                f"{plan_name} producer_path must be a protected asset: {producer_path}"
            )
        # Producer must be the executed script/binary, not a passive argv operand.
        # Supports shell-free interpreter forms with common flags, e.g.:
        #   [python, '-I', '-u', 'runner.py', ...]
        #   [/usr/bin/env, 'python3', 'runner.py', ...]
        #   [./protected-tool, ...]
        producer_resolved = _safe_workspace_path(workspace, producer_path).resolve()
        argv = step["argv"]

        def _resolve_executable(part: str) -> Path | None:
            candidate = Path(part)
            try:
                if candidate.is_absolute():
                    resolved = candidate.resolve()
                elif "/" in part or (os.altsep is not None and os.altsep in part):
                    resolved = (workspace / candidate).resolve()
                else:
                    search_path = execution_environment.get("PATH")
                    found = shutil.which(part, path=search_path)
                    if found is None:
                        return None
                    resolved = Path(found).resolve()
            except OSError:
                return None
            return resolved if resolved.is_file() else None

        def _resolve_workspace_operand(part: str) -> Path | None:
            candidate = Path(part)
            try:
                if candidate.is_absolute():
                    return candidate.resolve()
                return (workspace / candidate).resolve()
            except OSError:
                return None

        def _basename(part: str | Path) -> str:
            return Path(part).name.lower()

        def _is_interpreter_name(name: str) -> bool:
            base = name.lower()
            if base in {
                "python",
                "python2",
                "python3",
                "pypy",
                "pypy3",
                "node",
                "nodejs",
                "ruby",
                "perl",
                "lua",
                "php",
                "bash",
                "sh",
                "zsh",
                "dash",
                "ksh",
            }:
                return True
            # Versioned interpreters only: python3.14, pypy3.10, nodejs18.
            # Reject attacker basenames like python-candidate / python_payload.
            for prefix in ("python", "pypy", "node", "nodejs", "ruby", "perl", "php"):
                if not base.startswith(prefix) or len(base) <= len(prefix):
                    continue
                suffix = base[len(prefix) :]
                if suffix and suffix[0].isdigit() and all(
                    part.isdigit() for part in suffix.split(".")
                ):
                    return True
            return False

        def _is_trusted_interpreter(resolved: Path | None) -> bool:
            """Interpreter role requires trusted identity, not basename alone.

            Candidate artifacts named python3/python3.14 must never unlock script
            producer parsing for a passive protected operand.
            """
            if resolved is None or not _is_interpreter_name(_basename(resolved)):
                return False
            resolved = resolved.resolve()
            # Candidate-controlled executables are never trusted interpreters.
            for item in candidate_resolved:
                try:
                    if resolved == item.resolve() or item.resolve() in resolved.parents:
                        return False
                except OSError:
                    continue
            workspace_root = workspace.resolve()
            try:
                resolved.relative_to(workspace_root)
            except ValueError:
                # Outside the acceptance workspace: system/PATH interpreter.
                return True
            # Inside the workspace only protected assets may be interpreters.
            for item in protected_resolved:
                try:
                    if resolved == item.resolve():
                        return True
                except OSError:
                    continue
            return False

        def _is_trusted_env(resolved: Path | None) -> bool:
            """env launcher must also be non-candidate trusted identity."""
            if resolved is None or _basename(resolved) != "env":
                return False
            resolved = resolved.resolve()
            for item in candidate_resolved:
                try:
                    if resolved == item.resolve() or item.resolve() in resolved.parents:
                        return False
                except OSError:
                    continue
            workspace_root = workspace.resolve()
            try:
                resolved.relative_to(workspace_root)
            except ValueError:
                return True
            for item in protected_resolved:
                try:
                    if resolved == item.resolve():
                        return True
                except OSError:
                    continue
            return False


        def _interpreter_script(
            interpreter: Path,
            argv: list[str],
            start: int,
        ) -> Path | None:
            """Resolve an executed script only for supported interpreter argv grammars."""
            interpreter_name = _basename(interpreter)
            python_like = interpreter_name.startswith(("python", "pypy"))
            index = start
            bare_flags = (
                {
                    "-i",
                    "-u",
                    "-O",
                    "-OO",
                    "-B",
                    "-s",
                    "-S",
                    "-E",
                    "-v",
                    "-V",
                    "-q",
                    "-x",
                    "-b",
                    "-bb",
                    "-P",
                }
                if python_like
                else set()
            )
            while index < len(argv):
                token = argv[index]
                if token == "--":
                    index += 1
                    break
                if token in {"-c", "-m"} or token.startswith(("-c", "-m")):
                    # Inline/module execution has no path producer owned by this format.
                    return None
                if token in {"-W", "-X"}:
                    if not python_like:
                        return None
                    index += 2
                    continue
                if token.startswith(("-W", "-X")):
                    if not python_like:
                        return None
                    index += 1
                    continue
                if token == "-I":
                    if not python_like:
                        return None
                    index += 1
                    continue
                if token in bare_flags:
                    index += 1
                    continue
                if token.startswith("-"):
                    # Unknown options may consume operands. Fail closed rather than
                    # mistaking such an operand for the protected producer.
                    return None
                break
            if index >= len(argv) or argv[index] == "-":
                return None
            return _resolve_workspace_operand(argv[index])

        executed_candidates: list[Path] = []
        if argv:
            binary = _resolve_executable(argv[0])
            if binary is not None:
                executed_candidates.append(binary)
                binary_name = _basename(binary)
                if binary_name == "env":
                    # Only a trusted system/protected env may introduce an interpreter
                    # script form. Candidate ./env that ignores operands is not trusted.
                    if _is_trusted_env(binary) and len(argv) >= 2:
                        interpreter = _resolve_executable(argv[1])
                        if _is_trusted_interpreter(interpreter):
                            script = _interpreter_script(interpreter, argv, 2)
                            if script is not None:
                                executed_candidates.append(script)
                elif _is_trusted_interpreter(binary):
                    script = _interpreter_script(binary, argv, 1)
                    if script is not None:
                        executed_candidates.append(script)

        if producer_resolved not in executed_candidates:
            raise ValueError(
                f"{plan_name} producer_path must appear in the producer step argv "
                "as the executed script or binary"
            )

    discovery = control_plane.get("discovery")
    if not isinstance(discovery, dict):
        raise ValueError("contract.control_plane.discovery is required")
    _require_result_producer("discovery", discovery)
    if contract.get("mode") == "improvement":
        metric_result_plan = control_plane.get("metric_result")
        if not isinstance(metric_result_plan, dict):
            raise ValueError(
                "improvement contract.control_plane.metric_result is required"
            )
        _require_result_producer("metric_result", metric_result_plan)
        if plan[-1]["id"] != metric_result_plan["command_id"]:
            raise ValueError("metric result plan step must be the final plan step")

    migration_context = contract.get("migration_context")
    migration_role = (
        migration_context.get("role")
        if isinstance(migration_context, dict)
        else None
    )
    if contract.get("migration_profile") == "large_equivalence" and migration_role == "bootstrap":
        inventory_result_plan = control_plane.get("migration_inventory_result")
        if not isinstance(inventory_result_plan, dict):
            raise ValueError(
                "large_equivalence bootstrap requires control_plane.migration_inventory_result"
            )
        _require_result_producer("migration_inventory_result", inventory_result_plan)
    if contract.get("migration_profile") == "large_equivalence" and migration_role == "batch":
        fencing_result_plan = control_plane.get("migration_fencing_result")
        if not isinstance(fencing_result_plan, dict):
            raise ValueError(
                "large_equivalence batch requires control_plane.migration_fencing_result"
            )
        _require_result_producer("migration_fencing_result", fencing_result_plan)
    if contract.get("migration_profile") == "large_equivalence" and migration_role == "completion":
        completion_result_plan = control_plane.get("migration_completion_result")
        if not isinstance(completion_result_plan, dict):
            raise ValueError(
                "large_equivalence completion requires control_plane.migration_completion_result"
            )
        _require_result_producer("migration_completion_result", completion_result_plan)
    if contract.get("mode") == "equivalence" and (
        contract.get("migration_profile") != "large_equivalence"
        or migration_role in {"cutover", "release"}
    ):
        cutover_result_plan = control_plane.get("cutover_result")
        if not isinstance(cutover_result_plan, dict):
            raise ValueError(
                "equivalence contract.control_plane.cutover_result is required"
            )
        _require_result_producer("cutover_result", cutover_result_plan)
    release_result_plan = control_plane.get("release_result")
    if contract.get("risk_profile") == "critical":
        if not isinstance(release_result_plan, dict):
            raise ValueError(
                "critical contract.control_plane.release_result is required"
            )
    if isinstance(release_result_plan, dict):
        _require_result_producer("release_result", release_result_plan)
        non_stability_role_ids.add(release_result_plan["command_id"])

    # Platform matrix protected producers (Critical).
    platform_results = control_plane.get("platform_results")
    if platform_results is not None and not isinstance(platform_results, dict):
        raise ValueError("contract.control_plane.platform_results must be an object")
    platform_results = platform_results if isinstance(platform_results, dict) else {}
    declared_matrix = [
        item
        for item in (contract.get("environment") or {}).get("matrix", [])
        if isinstance(item, str) and item
    ]
    if contract.get("risk_profile") == "critical":
        if not declared_matrix:
            raise ValueError(
                "critical contract environment.matrix must declare supported platforms"
            )
        if len(declared_matrix) != 1 or len(set(declared_matrix)) != 1:
            raise ValueError(
                "reference control plane supports exactly one Critical platform; "
                "multi-platform acceptance requires an external authenticated control plane"
            )
        if not platform_results:
            raise ValueError(
                "critical contract.control_plane.platform_results must declare "
                "one protected result plan per environment.matrix platform"
            )
        if len(platform_results) != 1:
            raise ValueError(
                "reference control plane supports exactly one Critical platform; "
                "multi-platform acceptance requires an external authenticated control plane"
            )
        missing_platform_plans = sorted(
            platform for platform in declared_matrix if platform not in platform_results
        )
        extra_platform_plans = sorted(
            platform for platform in platform_results if platform not in set(declared_matrix)
        )
        if missing_platform_plans:
            raise ValueError(
                "critical contract.control_plane.platform_results missing plans for: "
                f"{missing_platform_plans}"
            )
        if extra_platform_plans:
            raise ValueError(
                "critical contract.control_plane.platform_results has unknown platforms: "
                f"{extra_platform_plans}"
            )
        runtime_platform = runtime_platform_identity()["platform_id"]
        declared_platform = declared_matrix[0]
        if declared_platform != runtime_platform:
            raise ValueError(
                "critical platform key must equal actual issuer runtime platform_id "
                f"({runtime_platform}); got {declared_platform!r}"
            )
    seen_result_command_ids: set[str] = set()
    seen_result_paths: set[str] = set()
    for role_name in (
        "discovery", "metric_result", "cutover_result", "release_result",
        "migration_inventory_result", "migration_fencing_result", "migration_completion_result",
    ):
        plan_spec = control_plane.get(role_name)
        if isinstance(plan_spec, dict):
            command_id = plan_spec.get("command_id")
            result_path = plan_spec.get("result_path")
            if isinstance(command_id, str) and command_id:
                if command_id in seen_result_command_ids:
                    raise ValueError(
                        f"contract.control_plane.{role_name}.command_id must be unique "
                        "across protected result plans"
                    )
                seen_result_command_ids.add(command_id)
            if isinstance(result_path, str) and result_path:
                if result_path in seen_result_paths:
                    raise ValueError(
                        f"contract.control_plane.{role_name}.result_path must be unique "
                        "across protected result plans"
                    )
                seen_result_paths.add(result_path)
    for platform, plan_spec in platform_results.items():
        if not isinstance(platform, str) or not platform:
            raise ValueError("contract.control_plane.platform_results keys must be non-empty")
        if not isinstance(plan_spec, dict):
            raise ValueError(
                f"contract.control_plane.platform_results[{platform}] must be an object"
            )
        _require_result_producer(f"platform_results[{platform}]", plan_spec)
        command_id = plan_spec["command_id"]
        result_path = plan_spec["result_path"]
        if command_id in seen_result_command_ids:
            raise ValueError(
                f"contract.control_plane.platform_results[{platform}].command_id must be "
                "unique across protected result plans"
            )
        seen_result_command_ids.add(command_id)
        if result_path in seen_result_paths:
            raise ValueError(
                f"contract.control_plane.platform_results[{platform}].result_path must be "
                "unique across protected result plans"
            )
        seen_result_paths.add(result_path)
        non_stability_role_ids.add(command_id)

    write_owners: list[tuple[str, str]] = []
    for step in plan:
        for path in step["write_paths"]:
            for owner_id, owner_path in write_owners:
                if _paths_overlap(
                    str(_safe_workspace_path(workspace, path)),
                    str(_safe_workspace_path(workspace, owner_path)),
                ):
                    raise ValueError(
                        f"execution plan write path '{path}' for {step['id']} overlaps "
                        f"{owner_id} write path '{owner_path}'"
                    )
            write_owners.append((step["id"], path))

    _validate_execution_capabilities(
        contract,
        plan,
        workspace=workspace,
        environment=execution_environment,
    )

    environment_identity = derive_environment_identity(
        execution_environment,
        plan,
        workspace,
    )
    contract_environment = contract.get("environment")
    if (
        not isinstance(contract_environment, dict)
        or contract_environment.get("digest") != environment_identity["digest"]
    ):
        raise ValueError("contract environment identity differs from actual execution")


    manifest = _workspace_manifest(workspace)
    undeclared = sorted(
        relative
        for relative in manifest
        if not _path_is_declared_or_ancestor(
            relative,
            candidates + sorted(protected_paths) + allowed_outputs,
        )
    )
    if undeclared:
        raise ValueError(f"workspace files lack candidate/protected scope declaration: {undeclared}")
    return (
        plan,
        allowed_outputs,
        manifest,
        protected_snapshot,
        candidate_snapshot,
        execution_environment,
        environment_identity,
    )


def _path_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _sandbox_quote(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace('"', '\\"')


def _macos_dynamic_dependencies(
    paths: set[Path],
    *,
    deadline: float | None = None,
) -> set[Path]:
    if deadline is None:
        deadline = time.monotonic() + SANDBOX_STARTUP_PROBE_TIMEOUT_SECONDS
    pending_set: set[Path] = set()
    for path in paths:
        if path.is_file():
            pending_set.add(path)
        elif path.is_dir():
            directories = [path]
            while directories:
                directory = directories.pop()
                if time.monotonic() >= deadline:
                    raise ValueError(
                        "acceptance command timed out during sandbox startup"
                    )
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if time.monotonic() >= deadline:
                            raise ValueError(
                                "acceptance command timed out during sandbox startup"
                            )
                        if entry.is_dir(follow_symlinks=False):
                            directories.append(Path(entry.path))
                        elif entry.name.endswith((".so", ".dylib")) and entry.is_file():
                            pending_set.add(Path(entry.path))
    pending = sorted(pending_set, key=str)
    queued = set(pending)
    cursor = 0
    dependencies: set[Path] = set()
    while cursor < len(pending):
        batch = pending[cursor : cursor + 64]
        cursor += len(batch)
        command = ["otool", "-L", *(str(path) for path in batch)]
        probe_deadline = time.monotonic() + SANDBOX_STARTUP_PROBE_TIMEOUT_SECONDS
        probe_deadline = min(probe_deadline, deadline)
        if probe_deadline <= time.monotonic():
            raise ValueError("acceptance command timed out during sandbox startup")
        process: subprocess.Popen[bytes] | None = None
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={"PATH": os.defpath, "LC_ALL": "C", "LANG": "C"},
                close_fds=True,
                start_new_session=True,
            )
        except OSError:
            continue
        try:
            output, _ = _collect_bounded_step_output(
                process,
                command=command,
                deadline=probe_deadline,
                output_limit_bytes=SANDBOX_STARTUP_PROBE_OUTPUT_LIMIT_BYTES,
                output_label="sandbox runtime dependency probe",
            )
            if process.poll() is None:
                remaining = probe_deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, probe_deadline)
                process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            if process.returncode is None:
                _terminate_owned_sandbox(process)
            raise ValueError("sandbox runtime dependency probe timed out") from exc
        except BaseException:
            if process.returncode is None:
                _terminate_owned_sandbox(process)
            raise
        for line in output.decode("utf-8", errors="replace").splitlines():
            match = re.match(r"\s*(/[^\s]+)", line)
            if match is None:
                continue
            dependency = Path(match.group(1))
            if dependency.exists():
                dependency = dependency.resolve(strict=False)
                if dependency not in dependencies:
                    dependencies.add(dependency)
                    if dependency not in queued:
                        queued.add(dependency)
                        pending.append(dependency)
    return dependencies


def _runtime_read_roots(*, deadline: float | None = None) -> list[Path]:
    roots = {
        Path(sys.base_prefix).resolve(),
        Path(sys.prefix).resolve(),
        Path(sys.executable).resolve().parent,
    }
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        value = sysconfig.get_paths().get(key)
        if value:
            roots.add(Path(value).resolve())
    runtime_dependency_sources = set(roots)
    system_roots = (
        ("/System/Library", "/usr/lib", "/usr/share/locale")
        if sys.platform == "darwin"
        else ("/lib", "/lib64", "/usr/lib", "/usr/lib64")
    )
    system_files = (
        ("/etc/passwd", "/etc/group", "/etc/localtime")
        if sys.platform == "darwin"
        else ("/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group")
    )
    for value in (*system_roots, *system_files):
        path = Path(value)
        if path.exists():
            roots.add(path.resolve(strict=False))
    if sys.platform == "darwin":
        roots.update(
            _macos_dynamic_dependencies(
                runtime_dependency_sources,
                deadline=deadline,
            )
        )
    return sorted(roots)


def _bwrap_parent_directories(paths: list[Path]) -> list[Path]:
    parents: set[Path] = set()
    for path in paths:
        parent = path if path.is_dir() else path.parent
        while parent != Path("/"):
            parents.add(parent)
            parent = parent.parent
    return sorted(parents, key=lambda item: (len(item.parts), str(item)))


def _execution_readable_targets(
    workspace: Path,
    declarations: list[str],
) -> tuple[list[Path], list[Path]]:
    """Return exact files and recursive directories granted read authority."""
    files: list[Path] = []
    directories: list[Path] = []
    root = workspace.resolve()
    for relative in declarations:
        path = _safe_workspace_path(workspace, relative)
        lexical = root / Path(relative)
        if relative.endswith("/") or (path.exists() and path.is_dir() and not path.is_symlink()):
            if lexical.is_symlink():
                directories.extend([lexical, path.resolve()])
            else:
                directories.append(path.resolve())
        elif lexical.is_symlink():
            # bwrap must mount both the declared symlink node and its target so
            # snapshot argv retains the lexical path whose identity was bound.
            files.extend([lexical, path.resolve()])
        else:
            files.append(path.resolve())
    unique_files = list(dict.fromkeys(files))
    unique_directories = list(dict.fromkeys(directories))
    return (
        [path for path in unique_files if not any(directory in path.parents for directory in unique_directories)],
        unique_directories,
    )


def _execution_writable_targets(
    workspace: Path,
    allowed_outputs: list[str],
    candidate_paths: list[str],
    *,
    directory_outputs: set[str] | None = None,
) -> tuple[list[Path], list[Path]]:
    """Return (literal file write targets, directory write roots).

    File outputs receive exact-file write authority only. Directory authority is
    granted only to explicitly declared directory outputs (or still-present dirs).
    """
    declared_dirs = set(directory_outputs or set())
    file_targets: list[Path] = []
    dir_roots: list[Path] = []
    for relative in allowed_outputs + candidate_paths:
        path = _safe_workspace_path(workspace, relative)
        is_declared_dir = relative.rstrip("/") in {
            item.rstrip("/") for item in declared_dirs
        } or relative in declared_dirs
        if is_declared_dir or (
            path.exists() and path.is_dir() and not path.is_symlink()
        ):
            dir_roots.append(path.resolve())
            continue
        # File outputs/candidates: write only that exact path.
        file_targets.append(path.resolve())
    unique_files: list[Path] = []
    seen_files: set[Path] = set()
    for item in file_targets:
        if item in seen_files:
            continue
        seen_files.add(item)
        unique_files.append(item)
    unique_dirs: list[Path] = []
    seen_dirs: set[Path] = set()
    workspace_root = workspace.resolve()
    for item in dir_roots:
        if item in seen_dirs or item == workspace_root:
            continue
        seen_dirs.add(item)
        unique_dirs.append(item)
    return unique_files, unique_dirs





def _prepare_execution_environment(
    environment: dict[str, str],
    *,
    source_workspace: Path,
    snapshot_workspace: Path,
) -> dict[str, str]:
    source_root = source_workspace.resolve()
    snapshot_root = snapshot_workspace.resolve()
    prepared = dict(environment)
    # PATH remains allowlisted (external executables are fingerprinted).
    # PYTHONPATH / library paths must not import mutable external code.
    restricted_path_vars = ("PYTHONPATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH")
    for name in ("PATH",) + restricted_path_vars:
        raw = prepared.get(name)
        if raw is None:
            continue
        remapped: list[str] = []
        for entry in raw.split(os.pathsep):
            if not entry:
                continue
            path = Path(entry)
            if not path.is_absolute():
                remapped.append(str((snapshot_root / path).resolve()))
                continue
            resolved = path.resolve()
            if _path_under(resolved, source_root) or resolved == source_root:
                relative = resolved.relative_to(source_root)
                remapped.append(str((snapshot_root / relative).resolve()))
                continue
            if name in restricted_path_vars:
                raise ValueError(
                    f"acceptance environment {name} rejects external path entry: {entry}"
                )
            # PATH may retain external directories; binaries remain fingerprinted.
            remapped.append(str(resolved))
        prepared[name] = os.pathsep.join(remapped)
    return prepared




def _argv_path_operands(argument: str) -> list[str]:
    """Return explicit filesystem operands carried by one shell-free argv token."""
    if argument.startswith("--") and "=" in argument:
        _, value = argument.split("=", 1)
        return [value] if _command_token_is_path_like(value) else []
    for option in ("-I", "-r"):
        if argument.startswith(option) and len(argument) > len(option):
            value = argument[len(option) :]
            return [value] if _command_token_is_path_like(value) else []
    if argument.startswith("@") and len(argument) > 1:
        value = argument[1:]
        return [value] if _command_token_is_path_like(value) else []
    if argument.startswith("-") and _command_token_is_path_like(argument):
        raise ValueError(
            f"acceptance argv rejects unsupported path-bearing option: {argument}"
        )
    return [argument] if _command_token_is_path_like(argument) else []


def _fingerprint_or_reject_external_inputs(
    argv: list[str],
    *,
    source_workspace: Path,
    snapshot_workspace: Path,
) -> None:
    """Reject non-executable path operands that escape the immutable snapshot."""
    del source_workspace  # Absolute source paths are remapped before this boundary.
    snapshot_root = snapshot_workspace.resolve()
    for index, argument in enumerate(argv):
        operands = [argument] if index == 0 else _argv_path_operands(argument)
        for operand in operands:
            path = Path(operand)
            resolved = (path if path.is_absolute() else snapshot_root / path).resolve()
            if _path_under(resolved, snapshot_root) or resolved == snapshot_root:
                continue
            if index == 0:
                # Executable identity is already bound by derive_environment_identity.
                if not resolved.is_file():
                    raise ValueError(
                        f"acceptance executable cannot be resolved: {argument}"
                    )
                file_fingerprint(resolved)
                continue
            if path.is_absolute():
                raise ValueError(
                    f"acceptance argv rejects external absolute operand: {argument}"
                )
            raise ValueError(
                f"acceptance argv relative operand escapes workspace: {argument}"
            )



def _sandbox_command(
    argv: list[str],
    *,
    workspace: Path,
    readable_files: list[Path],
    readable_dirs: list[Path],
    writable_files: list[Path],
    writable_dirs: list[Path],
    temp_root: Path,
    deadline: float | None = None,
    runtime_roots: list[Path] | None = None,
) -> list[str]:
    if runtime_roots is None:
        runtime_roots = _runtime_read_roots(deadline=deadline)
    executable = Path(argv[0]).resolve()
    if not executable.is_file():
        raise ValueError(f"acceptance executable cannot be resolved: {argv[0]}")
    argv = [str(executable), *argv[1:]]
    runtime_files = [path for path in runtime_roots if path.is_file()]
    if executable not in runtime_files:
        runtime_files.append(executable)
    if sys.platform == "darwin":
        sandbox = shutil.which("sandbox-exec", path=os.defpath)
        if sandbox is None:
            raise ValueError(
                "protected execution isolation requires sandbox-exec on macOS"
            )
        # macOS literal root authority permits only traversal metadata, not recursive
        # descendant reads. The dynamic loader needs it before it can reach the explicit
        # runtime roots below; never replace this with a root subpath grant.
        null_device = Path(os.devnull).resolve()
        workspace_root = workspace.resolve()
        structural_read_literals = {workspace_root}
        for directory in readable_dirs:
            current = directory.resolve().parent
            while current != workspace_root:
                structural_read_literals.add(current)
                current = current.parent
        read_literals = [
            Path("/"),
            *sorted(structural_read_literals),
            null_device,
            *runtime_files,
            *readable_files,
            *writable_files,
        ]
        read_roots = [
            *(path for path in runtime_roots if path.is_dir()),
            *readable_dirs,
            *writable_dirs,
            temp_root.resolve(),
        ]
        read_rules = [
            f'(allow file-read* (literal "{_sandbox_quote(path)}"))'
            for path in read_literals
        ]
        read_rules.extend(
            f'(allow file-read* (subpath "{_sandbox_quote(root)}"))'
            for root in read_roots
        )
        # Precreate nested exact-file parents/placeholders so macOS literal write
        # authority works without granting parent-directory write subpaths.
        for path in writable_files:
            if path.exists() or path.is_symlink():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        write_rules = [
            f'(allow file-write* (literal "{_sandbox_quote(path)}"))'
            for path in [null_device, *writable_files]
        ]
        write_rules.extend(
            f'(allow file-write* (subpath "{_sandbox_quote(root.resolve())}"))'
            for root in [*writable_dirs, temp_root.resolve()]
        )
        profile = "\n".join(
            [
                "(version 1)",
                "(deny default)",
                # Single-process fail-closed: allow process* then deny process-fork.
                # sandbox-exec lacks PID namespaces; os.fork/posix_spawn return EPERM
                # under this profile while ordinary single-process plan steps still run.
                # Process-tree cleanup below remains defense-in-depth only.
                "(allow process*)",
                "(deny process-fork)",
                "(allow file-read-metadata)",
                "(allow sysctl-read)",
                *read_rules,
                *write_rules,
            ]
        )
        return [sandbox, "-p", profile, *argv]
    if sys.platform.startswith("linux"):
        bubblewrap = shutil.which("bwrap", path=os.defpath)
        if bubblewrap is None:
            raise ValueError("protected execution isolation requires bwrap on Linux")
        mount_paths = (
            runtime_roots
            + runtime_files
            + [temp_root.resolve(), *readable_dirs, *writable_dirs]
            + [path.parent for path in [*readable_files, *writable_files]]
        )
        command = [bubblewrap, "--unshare-all", "--die-with-parent", "--tmpfs", "/"]
        for parent in _bwrap_parent_directories(mount_paths):
            command.extend(["--dir", str(parent)])
        for root in runtime_roots:
            command.extend(["--ro-bind", str(root), str(root)])
        for path in runtime_files:
            if path not in runtime_roots:
                command.extend(["--ro-bind", str(path), str(path)])
        command.extend(["--bind", str(temp_root.resolve()), str(temp_root.resolve())])
        for root in readable_dirs:
            command.extend(["--ro-bind", str(root), str(root)])
        for path in readable_files:
            command.extend(["--ro-bind", str(path), str(path)])
        for root in writable_dirs:
            command.extend(["--bind", str(root), str(root)])
        for path in writable_files:
            if path.exists():
                command.extend(["--bind", str(path), str(path)])
            else:
                # Create empty placeholder so bind can succeed for new outputs.
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
                command.extend(["--bind", str(path), str(path)])
        command.extend(["--dev", "/dev", "--proc", "/proc", *argv])
        return command
    raise ValueError(
        f"protected execution isolation is unsupported on {sys.platform}"
    )



def _terminate_owned_sandbox(process: subprocess.Popen[Any]) -> None:
    """Kill and reap only the live process group created for one sandbox step.

    ``_run_isolated_step`` launches the sandbox root in a new session. Its PID is
    therefore its process-group ID until the direct child is reaped. Linux bwrap
    owns descendants through its PID namespace; macOS rejects process creation.
    Looking up host PIDs after that boundary is neither necessary nor safe, because
    numeric PIDs and PGIDs can be recycled after a child has been reaped.
    """
    if process.pid is None or getattr(process, "returncode", None) is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            pass
    try:
        process.wait(timeout=DIRECT_SANDBOX_CLEANUP_GRACE_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        pass


def _poll_readable(values: list[Any], timeout: float) -> list[Any]:
    """Poll arbitrary descriptor numbers without select(2)'s FD_SETSIZE cap."""
    poller = select.poll()
    by_fd: dict[int, Any] = {}
    for value in values:
        fd = value if isinstance(value, int) else value.fileno()
        by_fd[fd] = value
        poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    timeout_ms = max(0, int(timeout * 1000 + 0.999))
    return [
        by_fd[fd]
        for fd, events in poller.poll(timeout_ms)
        if events & (
            select.POLLIN | select.POLLHUP | select.POLLERR | select.POLLNVAL
        )
    ]


def _collect_bounded_step_output(
    process: subprocess.Popen[Any],
    *,
    command: list[str],
    deadline: float,
    output_limit_bytes: int = ACCEPTANCE_OUTPUT_LIMIT_BYTES,
    output_label: str = "acceptance command",
) -> tuple[bytes, bytes]:
    if process.stdout is None or process.stderr is None:
        raise ValueError(f"{output_label} pipes are unavailable")
    for pipe in (process.stdout, process.stderr):
        flags = fcntl.fcntl(pipe.fileno(), fcntl.F_GETFL)
        fcntl.fcntl(pipe.fileno(), fcntl.F_SETFL, flags | os.O_NONBLOCK)
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_size = 0
    stderr_size = 0
    stdout_open = True
    stderr_open = True

    def append_chunk(pipe: Any, chunk: bytes) -> None:
        nonlocal stdout_size, stderr_size
        if pipe is process.stdout:
            if stdout_size + len(chunk) > output_limit_bytes:
                raise ValueError(
                    f"{output_label} stdout exceeded bounded output limit of {output_limit_bytes} bytes"
                )
            stdout_chunks.append(chunk)
            stdout_size += len(chunk)
        else:
            if stderr_size + len(chunk) > output_limit_bytes:
                raise ValueError(
                    f"{output_label} stderr exceeded bounded output limit of {output_limit_bytes} bytes"
                )
            stderr_chunks.append(chunk)
            stderr_size += len(chunk)

    try:
        while stdout_open or stderr_open:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, deadline)
            readers = [pipe for pipe, is_open in ((process.stdout, stdout_open), (process.stderr, stderr_open)) if is_open]
            readable = _poll_readable(readers, min(0.05, remaining))
            for pipe in readable:
                try:
                    chunk = os.read(pipe.fileno(), 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    if pipe is process.stdout:
                        stdout_open = False
                    else:
                        stderr_open = False
                    continue
                append_chunk(pipe, chunk)
            if process.poll() is not None and not readable:
                for pipe, is_open in (
                    (process.stdout, stdout_open),
                    (process.stderr, stderr_open),
                ):
                    if not is_open:
                        continue
                    try:
                        chunk = os.read(pipe.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        if pipe is process.stdout:
                            stdout_open = False
                        else:
                            stderr_open = False
                    else:
                        append_chunk(pipe, chunk)
    finally:
        for pipe in (process.stdout, process.stderr):
            try:
                pipe.close()
            except OSError:
                pass
    return b"".join(stdout_chunks), b"".join(stderr_chunks)


def _write_private_file(path: Path, payload: bytes) -> None:
    """Persist one control-plane artifact without traversing symlink ancestors."""
    abs_destination = Path(os.path.abspath(str(path)))
    if abs_destination.name in {"", ".", ".."} or abs_destination == abs_destination.parent:
        raise ValueError(f"refusing to write to non-file path: {path}")
    dir_fd = _open_directory_nofollow(abs_destination.parent, create_missing=True)
    try:
        try:
            status = os.lstat(abs_destination.name, dir_fd=dir_fd)
        except FileNotFoundError:
            status = None
        if status is not None:
            raise ValueError(f"refusing to replace existing evidence artifact: {path}")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        fd = os.open(abs_destination.name, flags, 0o600, dir_fd=dir_fd)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            try:
                os.unlink(abs_destination.name, dir_fd=dir_fd)
            except OSError:
                pass
            raise
        try:
            os.fsync(dir_fd)
        except OSError:
            pass
    finally:
        os.close(dir_fd)


def _read_retained_regular_file(
    root: Path,
    relative: str,
    *,
    max_bytes: int,
) -> tuple[int, str, str]:
    """Hash one retained artifact through no-follow paths with a hard byte cap."""
    path = Path(relative)
    if not relative or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"retained output path is invalid: {relative!r}")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    file_flags = os.O_RDONLY | _required_open_flag("O_CLOEXEC")
    file_flags |= _required_open_flag("O_NOFOLLOW") | _required_open_flag("O_NONBLOCK")
    dir_fd = _open_directory_nofollow(root)
    try:
        for component in path.parts[:-1]:
            next_fd = os.open(component, directory_flags, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = next_fd
        file_fd = os.open(path.name, file_flags, dir_fd=dir_fd)
        try:
            status = os.fstat(file_fd)
            if not stat.S_ISREG(status.st_mode):
                raise ValueError(f"retained output is not a regular file: {relative}")
            if status.st_size > max_bytes:
                raise ValueError(f"retained output exceeds bounded size: {relative}")
            raw_digest = hashlib.sha256()
            fingerprint_digest = hashlib.sha256()
            fingerprint_digest.update(
                f"type={stat.S_IFMT(status.st_mode):o};mode={stat.S_IMODE(status.st_mode):o}\0".encode("ascii")
            )
            byte_length = 0
            with os.fdopen(file_fd, "rb") as handle:
                file_fd = -1
                while chunk := handle.read(min(1024 * 1024, max_bytes - byte_length + 1)):
                    byte_length += len(chunk)
                    if byte_length > max_bytes:
                        raise ValueError(f"retained output exceeds bounded size: {relative}")
                    raw_digest.update(chunk)
                    fingerprint_digest.update(chunk)
            final_status = os.stat(path.name, dir_fd=dir_fd, follow_symlinks=False)
            if (
                byte_length != status.st_size
                or _stable_stat_identity(final_status)
                != _stable_stat_identity(status)
            ):
                raise ValueError(f"retained output changed while reading: {relative}")
            return (
                byte_length,
                f"sha256:{raw_digest.hexdigest()}",
                f"sha256:{fingerprint_digest.hexdigest()}",
            )
        finally:
            if file_fd >= 0:
                os.close(file_fd)
    finally:
        os.close(dir_fd)


def _isolation_capture(command: list[str]) -> dict[str, Any]:
    """Return the non-secret sandbox policy artifact for one executed step."""
    executable = Path(command[0]).resolve()
    if sys.platform == "darwin":
        if len(command) < 3 or command[1] != "-p":
            raise ValueError("sandbox-exec command lacks an inline policy")
        policy_bytes = command[2].encode("utf-8")
        if len(policy_bytes) > ISOLATION_POLICY_LIMIT_BYTES:
            raise ValueError("sandbox policy exceeded bounded output limit")
        return {
            "provider": "sandbox-exec",
            "policy_format": "sandbox-profile",
            "policy_bytes": policy_bytes,
            "executable_fingerprint": file_fingerprint(executable),
        }
    if sys.platform.startswith("linux"):
        try:
            policy_end = command.index("--dev")
        except ValueError as exc:
            raise ValueError("bwrap command lacks a bounded policy prefix") from exc
        policy_bytes = _canonical_bytes(command[:policy_end])
        if len(policy_bytes) > ISOLATION_POLICY_LIMIT_BYTES:
            raise ValueError("sandbox policy exceeded bounded output limit")
        return {
            "provider": "bwrap",
            "policy_format": "bwrap-argv-prefix",
            # Do not retain candidate argv values: they can carry declared secret inputs.
            "policy_bytes": policy_bytes,
            "executable_fingerprint": file_fingerprint(executable),
        }
    raise ValueError(f"protected execution isolation is unsupported on {sys.platform}")


def _run_isolated_step(
    argv: list[str],
    *,
    workspace: Path,
    environment: dict[str, str],
    timeout_seconds: int,
    readable_files: list[Path],
    readable_dirs: list[Path],
    writable_files: list[Path],
    writable_dirs: list[Path],
    runtime_roots: list[Path] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    deadline = time.monotonic() + timeout_seconds
    with tempfile.TemporaryDirectory(prefix="vdd-accept-step-") as temp:
        temp_root = Path(temp)
        env = dict(environment)
        env["TMPDIR"] = str(temp_root)
        env["TEMP"] = str(temp_root)
        env["TMP"] = str(temp_root)
        command = _sandbox_command(
            argv,
            workspace=workspace,
            readable_files=readable_files,
            readable_dirs=readable_dirs,
            writable_files=writable_files,
            writable_dirs=writable_dirs,
            temp_root=temp_root,
            deadline=deadline,
            runtime_roots=runtime_roots,
        )
        process = subprocess.Popen(
            command,
            cwd=workspace,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        stdout = b""
        stderr = b""
        try:
            # Stream both pipes without allowing an acceptance step to exhaust the
            # verifier's memory before its wall-clock timeout expires.
            stdout, stderr = _collect_bounded_step_output(
                process,
                command=command,
                deadline=deadline,
            )
            if process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout_seconds)
                process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            if process.returncode is None:
                _terminate_owned_sandbox(process)
            raise ValueError(
                f"acceptance command timed out after {timeout_seconds}s"
            ) from exc
        except BaseException:
            if process.returncode is None:
                _terminate_owned_sandbox(process)
            raise
        return subprocess.CompletedProcess(
            args=command,
            returncode=process.returncode if process.returncode is not None else -1,
            stdout=stdout or b"",
            stderr=stderr or b"",
        )


def _snapshot_argv(
    argv: list[str],
    source_workspace: Path,
    snapshot_workspace: Path,
) -> list[str]:
    source_lexical_root = Path(os.path.abspath(source_workspace))
    source_root = source_workspace.resolve()
    snapshot_root = snapshot_workspace.resolve()
    source_text = str(source_lexical_root)
    normalized: list[str] = []
    for argument in argv:
        path = Path(argument)
        if path.is_absolute():
            lexical = Path(os.path.normpath(argument))
            resolved = lexical.resolve()
            try:
                resolved.relative_to(source_root)
            except ValueError:
                normalized.append(argument)
                continue
            try:
                relative = lexical.relative_to(source_lexical_root)
            except ValueError:
                try:
                    relative = lexical.relative_to(source_root)
                except ValueError:
                    relative = resolved.relative_to(source_root)
            normalized.append(str(snapshot_root / relative))
            continue
        if source_text in argument:
            raise ValueError(
                "acceptance argv embeds the mutable source workspace in a non-path argument"
            )
        normalized.append(argument)
    _fingerprint_or_reject_external_inputs(
        normalized,
        source_workspace=source_workspace,
        snapshot_workspace=snapshot_workspace,
    )
    return normalized


def _execute_plan(
    plan: list[dict[str, Any]],
    workspace: Path,
    environment: dict[str, str],
    *,
    source_workspace: Path,
    nonfatal_step_ids: set[str],
    allowed_outputs: list[str],
    candidate_paths: list[str],
    readable_protected_paths: list[str],
    executable_identities: dict[str, dict[str, str]] | None = None,
    producer_captures: dict[str, dict[str, Any]] | None = None,
    directory_outputs: set[str] | None = None,
    output_directory: Path | None = None,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    captures = producer_captures or {}
    prepared_environment = _prepare_execution_environment(
        environment,
        source_workspace=source_workspace,
        snapshot_workspace=workspace,
    )
    if executable_identities is None:
        executable_identities = derive_environment_identity(
            environment,
            plan,
            source_workspace,
        )["details"]["executables"]
    sealed_paths: set[Path] = set()
    declared_readable_files, declared_readable_dirs = _execution_readable_targets(
        workspace,
        candidate_paths + readable_protected_paths,
    )
    runtime_roots = _runtime_read_roots(
        deadline=time.monotonic() + SANDBOX_STARTUP_PROBE_TIMEOUT_SECONDS,
    )
    for step in plan:
        command_identity = executable_identities.get(step["argv"][0])
        if (
            not isinstance(command_identity, dict)
            or not isinstance(command_identity.get("fingerprint"), str)
        ):
            raise ValueError(
                f"acceptance executable identity is missing: {step['argv'][0]}"
            )
        argv = _snapshot_argv(step["argv"], source_workspace, workspace)
        executable = _resolve_execution_executable(
            argv[0],
            environment=prepared_environment,
            workspace=workspace,
        )
        if executable is None:
            raise ValueError(f"acceptance executable cannot be resolved: {argv[0]}")
        if not hmac.compare_digest(
            file_fingerprint(executable),
            command_identity["fingerprint"],
        ):
            raise ValueError(
                f"acceptance executable identity changed after preflight: {step['argv'][0]}"
            )
        argv = [str(executable), *argv[1:]]
        readable_files = list(dict.fromkeys([*declared_readable_files, executable]))
        readable_dirs = list(declared_readable_dirs)
        # Each protected step receives only its Contract-declared output authority.
        # Candidate artifacts belong to the implementer, never this acceptance process.
        step_writable_files, step_writable_dirs = _execution_writable_targets(
            workspace,
            step.get("write_paths", []),
            [],
            directory_outputs=directory_outputs,
        )
        step_writable_files = [
            path for path in step_writable_files if path not in sealed_paths
        ]
        completed = _run_isolated_step(
            argv,
            workspace=workspace,
            environment=prepared_environment,
            timeout_seconds=step["timeout_seconds"],
            readable_files=readable_files,
            readable_dirs=readable_dirs,
            writable_files=step_writable_files,
            writable_dirs=step_writable_dirs,
            runtime_roots=runtime_roots,
        )
        output_capture: dict[str, Any] | None = None
        if output_directory is not None:
            # Contract command IDs are arbitrary evidence labels, so never use one as
            # a filesystem component. The digest still gives every step a stable,
            # collision-resistant retained-output directory.
            step_token = hashlib.sha256(step["id"].encode("utf-8")).hexdigest()
            step_directory = output_directory / "commands" / step_token
            stdout_path = step_directory / "stdout.bin"
            stderr_path = step_directory / "stderr.bin"
            isolation_path = step_directory / "isolation-policy.bin"
            isolation = _isolation_capture(completed.args)
            _write_private_file(stdout_path, completed.stdout)
            _write_private_file(stderr_path, completed.stderr)
            _write_private_file(isolation_path, isolation.pop("policy_bytes"))
            output_capture = {
                "stdout": {
                    "path": str(stdout_path.relative_to(output_directory)),
                    "byte_length": len(completed.stdout),
                    "digest": f"sha256:{hashlib.sha256(completed.stdout).hexdigest()}",
                    "fingerprint": file_fingerprint(stdout_path),
                },
                "stderr": {
                    "path": str(stderr_path.relative_to(output_directory)),
                    "byte_length": len(completed.stderr),
                    "digest": f"sha256:{hashlib.sha256(completed.stderr).hexdigest()}",
                    "fingerprint": file_fingerprint(stderr_path),
                },
                "isolation": {
                    "path": str(isolation_path.relative_to(output_directory)),
                    "fingerprint": file_fingerprint(isolation_path),
                    **isolation,
                },
            }
        stdout_text = completed.stdout.decode("utf-8", errors="replace")
        stderr_text = completed.stderr.decode("utf-8", errors="replace")
        result = (
            step["result"]
            if completed.returncode == step["expected_exit_code"]
            else "fail"
        )
        expected_signals = step.get("expected_rejection_signals") or []
        if not expected_signals and step.get("expected_rejection_signal"):
            expected_signals = [step["expected_rejection_signal"]]
        if result == "expected_reject" and expected_signals:
            combined_output = f"{stdout_text}\n{stderr_text}"
            missing_signals = [
                signal for signal in expected_signals if signal not in combined_output
            ]
            if missing_signals:
                result = "fail"
                step["_missing_rejection_signals"] = missing_signals
        record: dict[str, Any] = {
            "id": step["id"],
            "command": step["display"],
            "exit_code": completed.returncode,
            "result": result,
            "claim_ids": list(step["claim_ids"]),
            "defeater_ids": list(step["defeater_ids"]),
            "artifact_refs": list(step["artifact_refs"]),
        }
        if output_capture is not None:
            record["output_capture"] = output_capture
        capture = captures.get(step["id"])
        if capture is not None and result == "pass":
            result_path = capture["result_path"]
            path = _safe_workspace_path(workspace, result_path)
            try:
                value, payload, digest = _load_regular_json(path)
            except (OSError, ValueError) as exc:
                raise ValueError(
                    f"protected {capture['role']} result missing after producer step "
                    f"{step['id']}: {result_path}"
                ) from exc
            platform = capture.get("platform")
            if isinstance(platform, str) and platform:
                if value.get("platform") != platform or value.get("passed") is not True:
                    raise ValueError(
                        f"protected platform result for {platform} must be "
                        f"{{'platform': {platform!r}, 'passed': true}}; got {value!r}"
                    )
            # Move the producer artifact into a sealed control-plane cache so later
            # candidate steps cannot replace the captured value even if the output
            # path remains writable under the sandbox.
            seal_dir = workspace / ".vdd-accept-sealed"
            step_token = hashlib.sha256(step["id"].encode("utf-8")).hexdigest()
            sealed_path = seal_dir / f"{step_token}__{Path(result_path).name}"
            _write_private_file(sealed_path, payload)
            record["captured_result"] = {
                "role": capture["role"],
                "path": result_path,
                "digest": digest,
                "value": value,
                "sealed_path": str(sealed_path.relative_to(workspace)),
            }
            # Remove the live output path from subsequent write authority.
            resolved = path.resolve()
            sealed_paths.add(resolved)
        records.append(record)
        if result == "fail" and step["id"] not in nonfatal_step_ids:
            detail = ""
            if step.get("_missing_rejection_signals"):
                detail = (
                    f"; missing expected rejection signal "
                    f"{step['_missing_rejection_signals']!r}"
                )
            elif step.get("expected_rejection_signals"):
                detail = (
                    f"; missing expected rejection signal "
                    f"{step['expected_rejection_signals']!r}"
                )
            elif step.get("expected_rejection_signal"):
                detail = (
                    f"; missing expected rejection signal "
                    f"{step['expected_rejection_signal']!r}"
                )
            raise ValueError(
                f"acceptance command {step['id']} exited {completed.returncode}; "
                f"expected {step['expected_exit_code']}{detail}"
            )
    return records
def _authenticate_parent(
    contract: dict[str, Any],
    proposal: dict[str, Any],
    parent: dict[str, Any] | None,
    signing_key: bytes,
    verification_time: datetime | None = None,
) -> tuple[dict[str, Any] | None, list[str] | None]:
    migration_profile = contract.get("migration_profile") == "large_equivalence"
    migration_stage = proposal.get("stage") in {"batch", "completion", "cutover", "release"}
    if migration_profile and migration_stage:
        if parent is not None:
            raise ValueError("migration issuance uses migration parent attestations, not legacy parent_attestation")
        return None, None
    if proposal.get("stage") != "release":
        if parent is not None:
            raise ValueError("parent attestation is only valid for release issuance")
        return None, None
    if parent is None:
        raise ValueError("release issuance requires an authenticated parent merge attestation")
    if not verify_attestation_signature(parent, signing_key):
        raise ValueError("parent merge attestation signature is invalid")
    _validate_schema(parent, EVIDENCE_VALIDATOR, "parent evidence")
    _require_unexpired_residuals(
        parent,
        verification_time or datetime.now(timezone.utc),
    )
    result = validate_evidence(parent, contract)
    if result.errors:
        raise ValueError("parent merge attestation validation failed: " + "; ".join(result.errors))
    expected_parent_stages = (
        {"bootstrap", "batch", "completion", "cutover", "merge"}
        if migration_profile and migration_stage
        else {"merge"}
    )
    if parent.get("stage") not in expected_parent_stages or parent.get("status") != "accepted":
        expected = ", ".join(sorted(expected_parent_stages))
        raise ValueError(f"parent attestation must be accepted at one of: {expected}")
    candidate = parent.get("candidate")
    if not isinstance(candidate, dict):
        raise ValueError("parent merge attestation lacks candidate identity")
    digest = attestation_digest(parent)
    reference = {
        "attestation_id": parent.get("attestation_id"),
        "digest": digest,
        "stage": parent.get("stage"),
        "status": "accepted",
        "contract_fingerprint": parent.get("contract", {}).get("fingerprint"),
        "candidate_revision": candidate.get("revision"),
    }
    return reference, list(candidate.get("artifact_digests", []))


def _require_migration_candidate_binding(
    evidence: dict[str, Any],
    *,
    label: str,
) -> None:
    """Bind profile evidence to the issuer-derived candidate snapshot identity."""
    migration = evidence.get("migration")
    candidate = evidence.get("candidate")
    if not isinstance(migration, dict) or not isinstance(candidate, dict):
        raise ValueError(f"{label} lacks migration or candidate identity")
    snapshot_digest = migration.get("candidate_snapshot_digest")
    candidate_revision = candidate.get("revision")
    if snapshot_digest != candidate_revision:
        raise ValueError(
            f"{label} migration candidate snapshot differs from candidate revision"
        )


def _authenticate_migration_parents(
    contract: dict[str, Any],
    proposal: dict[str, Any],
    parents: list[dict[str, Any]],
    signing_key: bytes,
    verification_time: datetime | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Resolve profile-only direct parents without changing legacy release ancestry."""
    if contract.get("migration_profile") != "large_equivalence":
        if parents:
            raise ValueError("migration parent attestations require large_equivalence profile")
        return [], []
    migration = proposal.get("migration")
    if not isinstance(migration, dict):
        raise ValueError("large_equivalence proposal requires migration evidence")
    stage = proposal.get("stage")
    expected_stages = {
        "bootstrap": set(),
        "batch": {"bootstrap", "batch"},
        "completion": {"bootstrap", "batch"},
        "cutover": {"completion"},
        "release": {"cutover"},
    }.get(stage)
    if expected_stages is None:
        raise ValueError("large_equivalence proposal has an invalid migration stage")
    if stage == "bootstrap":
        if parents:
            raise ValueError("migration bootstrap must not have parent attestations")
        return [], []
    if not parents:
        raise ValueError(f"migration {stage} issuance requires authenticated parents")
    if stage == "completion":
        parent_stages = [parent.get("stage") for parent in parents]
        if parent_stages.count("bootstrap") != 1 or "batch" not in parent_stages:
            raise ValueError(
                "migration completion issuance requires exactly one bootstrap "
                "parent and at least one batch parent"
            )

    resolved: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_digests: set[str] = set()
    candidate_digests: list[str] | None = None
    require_matching_parent_candidate = stage in {"cutover", "release"}
    for parent in parents:
        parent_id = parent.get("attestation_id")
        if not isinstance(parent_id, str) or not parent_id or parent_id in seen_ids:
            raise ValueError("migration parents require unique non-empty attestation IDs")
        digest = attestation_digest(parent)
        if digest in seen_digests:
            raise ValueError("migration parents must have unique attestation digests")
        seen_ids.add(parent_id)
        seen_digests.add(digest)
        if not verify_attestation_signature(parent, signing_key):
            raise ValueError(f"migration parent signature is invalid: {parent_id}")
        _validate_schema(parent, EVIDENCE_VALIDATOR, f"migration parent evidence {parent_id}")
        _require_unexpired_residuals(parent, verification_time or datetime.now(timezone.utc))
        parent_contract_fingerprint = parent.get("contract", {}).get("fingerprint")
        if (
            not isinstance(parent_contract_fingerprint, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", parent_contract_fingerprint)
        ):
            raise ValueError(f"migration parent lacks canonical contract fingerprint: {parent_id}")
        if parent.get("status") != "accepted" or parent.get("stage") not in expected_stages:
            expected = ", ".join(sorted(expected_stages))
            raise ValueError(f"migration {stage} parent must be accepted at: {expected}")
        parent_migration = parent.get("migration")
        if not isinstance(parent_migration, dict):
            raise ValueError(f"migration parent lacks migration evidence: {parent_id}")
        _require_migration_candidate_binding(parent, label=f"migration parent {parent_id}")
        for field in [
            "program_id", "program_generation", "dependency_graph_digest",
            "gap_inventory_digest", "source_reference",
        ]:
            if parent_migration.get(field) != migration.get(field):
                raise ValueError(f"migration parent {parent_id} {field} differs")
        if stage in {"cutover", "release"} and (
            parent_migration.get("candidate_snapshot_digest")
            != migration.get("candidate_snapshot_digest")
        ):
            raise ValueError(
                f"migration parent {parent_id} candidate_snapshot_digest differs"
            )
        batch_context = migration.get("batch")
        parent_candidate = parent.get("candidate")
        if stage == "batch" and (
            not isinstance(batch_context, dict)
            or not isinstance(parent_candidate, dict)
            or batch_context.get("candidate_base_digest")
            != parent_candidate.get("revision")
        ):
            raise ValueError(
                f"migration batch {parent_id} candidate_base_digest differs from bootstrap"
            )
        if parent_migration.get("source_inventory") != migration.get("source_inventory"):
            raise ValueError(f"migration parent {parent_id} source inventory differs")
        if parent_migration.get("migration_artifact") != migration.get("migration_artifact"):
            raise ValueError(f"migration parent {parent_id} artifact differs")
        if parent_migration.get("source_classification") != migration.get("source_classification"):
            raise ValueError(f"migration parent {parent_id} source classification differs")
        if parent_migration.get("impact_index") != migration.get("impact_index"):
            raise ValueError(f"migration parent {parent_id} impact index differs")
        candidate = parent.get("candidate")
        if not isinstance(candidate, dict):
            raise ValueError(f"migration parent lacks candidate identity: {parent_id}")
        parent_digests = candidate.get("artifact_digests")
        if not isinstance(parent_digests, list) or not all(isinstance(item, str) for item in parent_digests):
            raise ValueError(f"migration parent lacks candidate artifact digests: {parent_id}")
        if require_matching_parent_candidate:
            if candidate_digests is None:
                candidate_digests = list(parent_digests)
            elif candidate_digests != parent_digests:
                raise ValueError("migration parents bind different candidate artifacts")
        resolved.append(
            {
                "attestation_id": parent_id,
                "digest": digest,
                "stage": parent.get("stage"),
                "status": "accepted",
                "contract_fingerprint": parent.get("contract", {}).get("fingerprint"),
                "candidate_revision": candidate.get("revision"),
            }
        )
    proposal_parent_references = migration.get("parents")
    if not isinstance(proposal_parent_references, list):
        raise ValueError("proposal migration parents must be an array")
    observed_references = {
        item.get("attestation_id"): {
            "attestation_id": item.get("attestation_id"),
            "digest": item.get("digest"),
            "stage": item.get("stage"),
            "status": item.get("status"),
            "contract_fingerprint": item.get("contract_fingerprint"),
            "candidate_revision": item.get("candidate_revision"),
        }
        for item in proposal_parent_references
        if isinstance(item, dict) and isinstance(item.get("attestation_id"), str)
    }
    resolved_references = {item["attestation_id"]: item for item in resolved}
    if observed_references != resolved_references:
        raise ValueError("proposal migration parent references differ from authenticated parents")
    return resolved, candidate_digests or []


def _authenticate_reused_qualifications(
    contract: dict[str, Any],
    attestations: list[dict[str, Any]],
    signing_key: bytes,
    verification_time: datetime | None = None,
) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for attestation in attestations:
        attestation_id = attestation.get("attestation_id")
        if not isinstance(attestation_id, str) or not attestation_id:
            raise ValueError("qualification attestation requires attestation_id")
        if attestation_id in by_id:
            raise ValueError(f"duplicate qualification attestation: {attestation_id}")
        if not verify_attestation_signature(attestation, signing_key):
            raise ValueError(f"qualification attestation signature is invalid: {attestation_id}")
        _validate_schema(
            attestation,
            EVIDENCE_VALIDATOR,
            f"qualification evidence {attestation_id}",
        )
        _require_unexpired_residuals(
            attestation,
            verification_time or datetime.now(timezone.utc),
        )
        if attestation.get("status") != "accepted":
            raise ValueError(f"qualification attestation is not accepted: {attestation_id}")
        by_id[attestation_id] = attestation

    snapshots: list[dict[str, Any]] = []
    required_ids = {
        oracle.get("qualification", {}).get("prior_attestation_id")
        for oracle in contract.get("oracles", [])
        if oracle.get("qualification", {}).get("status") == "reused"
    }
    extra_ids = sorted(attestation_id for attestation_id in by_id if attestation_id not in required_ids)
    if extra_ids:
        raise ValueError(f"unreferenced qualification attestations: {extra_ids}")

    for oracle in contract.get("oracles", []):
        qualification = oracle.get("qualification", {})
        if qualification.get("status") != "reused":
            continue
        prior_id = qualification.get("prior_attestation_id")
        prior = by_id.get(prior_id)
        if prior is None:
            raise ValueError(f"reused oracle {oracle.get('id')} requires prior attestation {prior_id}")
        digest = attestation_digest(prior)
        if digest != qualification.get("prior_attestation_digest"):
            raise ValueError(f"reused oracle {oracle.get('id')} prior attestation digest differs")
        prior_oracle = next(
            (
                item
                for item in prior.get("oracles", [])
                if isinstance(item, dict) and item.get("id") == oracle.get("id")
            ),
            None,
        )
        if not isinstance(prior_oracle, dict) or prior_oracle.get("qualified") is not True:
            raise ValueError(f"prior attestation lacks qualified oracle {oracle.get('id')}")
        prior_trials = prior_oracle.get("no_change_trials")
        prior_flake_rate = prior_oracle.get("flake_rate")
        required_trials = qualification.get("required_no_change_trials")
        maximum_flake_rate = qualification.get("max_flake_rate")
        if (
            not isinstance(prior_trials, int)
            or isinstance(prior_trials, bool)
            or prior_trials < required_trials
        ):
            raise ValueError(
                f"prior oracle {oracle.get('id')} lacks required no-change trials"
            )
        if (
            not isinstance(prior_flake_rate, (int, float))
            or isinstance(prior_flake_rate, bool)
            or prior_flake_rate > maximum_flake_rate
        ):
            raise ValueError(
                f"prior oracle {oracle.get('id')} exceeds maximum flake rate"
            )
        for field in ["revision", "fingerprint"]:
            if prior_oracle.get(field) != oracle.get(field):
                raise ValueError(f"prior oracle {oracle.get('id')} {field} differs")
        prior_environment = prior.get("environment", {})
        contract_environment = contract.get("environment", {})
        if (
            not isinstance(prior_environment, dict)
            or not isinstance(contract_environment, dict)
            or prior_environment.get("digest") != contract_environment.get("digest")
        ):
            raise ValueError(
                f"reused oracle {oracle.get('id')} environment identity differs"
            )
        prior_fixtures = {
            item.get("name"): item.get("fingerprint")
            for item in prior.get("fixtures", [])
            if isinstance(item, dict)
        }
        contract_fixtures = {
            item.get("name"): item.get("fingerprint")
            for item in contract.get("fixtures", [])
            if isinstance(item, dict)
        }
        if prior_fixtures != contract_fixtures:
            raise ValueError(
                f"reused oracle {oracle.get('id')} fixture fingerprints differ"
            )
        current_qualification_fingerprint = qualification_contract_fingerprint(
            contract,
            oracle,
            qualification_basis=qualification.get("qualification_basis"),
            covered_defeater_ids=qualification.get("covered_defeater_ids"),
        )
        declared_qualification_fingerprint = qualification.get(
            "qualification_contract_fingerprint"
        )
        if declared_qualification_fingerprint != current_qualification_fingerprint:
            raise ValueError(
                f"reused oracle {oracle.get('id')} "
                "qualification_contract_fingerprint differs from current semantics"
            )
        if (
            prior_oracle.get("qualification_contract_fingerprint")
            != current_qualification_fingerprint
        ):
            raise ValueError(
                f"prior oracle {oracle.get('id')} "
                "qualification_contract_fingerprint differs"
            )
        covered = set(qualification.get("covered_defeater_ids", []))
        if not covered.issubset(set(prior_oracle.get("known_bad_rejections", []))):
            raise ValueError(f"prior oracle {oracle.get('id')} lacks inherited Defeater coverage")
        snapshots.append(
            {
                "no_change_trials": prior_trials,
                "flake_rate": prior_flake_rate,
                "oracle_id": oracle.get("id"),
                "attestation_id": prior_id,
                "digest": digest,
                "covered_defeater_ids": sorted(covered),
                "qualification_contract_fingerprint": current_qualification_fingerprint,
            }
        )
    return snapshots


class _PinnedWorkspace:
    """Own one open workspace generation across all provenance observations."""

    def __init__(self, path: Path):
        self.path = Path(os.path.abspath(path))
        self.fd = _open_directory_nofollow(self.path)
        if self.fd <= 2:
            original_fd = self.fd
            try:
                self.fd = fcntl.fcntl(
                    original_fd,
                    fcntl.F_DUPFD_CLOEXEC,
                    3,
                )
            finally:
                os.close(original_fd)

    def __enter__(self) -> _PinnedWorkspace:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        os.close(self.fd)
        self.fd = -1
        return False


def _workspace_path(workspace: Path | _PinnedWorkspace) -> Path:
    return workspace.path if isinstance(workspace, _PinnedWorkspace) else workspace


def _duplicate_workspace_fd(workspace: Path | _PinnedWorkspace) -> int:
    if isinstance(workspace, _PinnedWorkspace):
        return fcntl.fcntl(workspace.fd, fcntl.F_DUPFD_CLOEXEC, 3)
    return _open_directory_nofollow(workspace)


def _git_provenance_environment() -> dict[str, str]:
    """Return a Git environment insulated from checkout and user configuration."""
    environment = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith("GIT_")
        and name not in {"PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"}
    }
    environment.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_LITERAL_PATHSPECS": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_PAGER": "cat",
            "LC_ALL": "C",
            "LANG": "C",
            "GIT_CONFIG_COUNT": "5",
            "GIT_CONFIG_KEY_0": "core.fsmonitor",
            "GIT_CONFIG_VALUE_0": "",
            "GIT_CONFIG_KEY_1": "core.useBuiltinFSMonitor",
            "GIT_CONFIG_VALUE_1": "false",
            "GIT_CONFIG_KEY_2": "core.fileMode",
            "GIT_CONFIG_VALUE_2": "true",
            "GIT_CONFIG_KEY_3": "status.showUntrackedFiles",
            "GIT_CONFIG_VALUE_3": "all",
            "GIT_CONFIG_KEY_4": "diff.external",
            "GIT_CONFIG_VALUE_4": "",
        }
    )
    return environment


def _verify_git_executable_generation() -> None:
    if _PINNED_GIT_EXECUTABLE is None or _PINNED_GIT_EXECUTABLE_IDENTITY is None:
        raise ValueError("source provenance requires a trusted git executable")
    try:
        current_identity = _git_executable_identity(
            _PINNED_GIT_EXECUTABLE.stat(follow_symlinks=False)
        )
    except (OSError, ValueError) as exc:
        raise ValueError("source provenance git executable changed after startup") from exc
    if current_identity != _PINNED_GIT_EXECUTABLE_IDENTITY:
        raise ValueError("source provenance git executable changed after startup")


def _git_command(workspace: Path | _PinnedWorkspace, *args: str) -> list[str]:
    _verify_git_executable_generation()
    git_executable = str(_PINNED_GIT_EXECUTABLE)
    git_args = [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        *args,
    ]
    if isinstance(workspace, _PinnedWorkspace):
        return [
            sys.executable,
            "-I",
            "-S",
            "-c",
            (
                "import os,sys;"
                "fd=int(sys.argv[1]);"
                "os.fchdir(fd);"
                "exe=sys.argv[2];"
                "os.execv(exe,[exe,*sys.argv[3:]])"
            ),
            str(workspace.fd),
            git_executable,
            *git_args,
        ]
    return [git_executable, *git_args[:3], "-C", str(workspace), *git_args[3:]]


def _git_output(workspace: Path | _PinnedWorkspace, *args: str) -> str:
    try:
        return _git_bytes(workspace, *args).decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise ValueError("source provenance git check returned invalid UTF-8") from exc


def _git_bytes(
    workspace: Path | _PinnedWorkspace,
    *args: str,
    output_limit_bytes: int = GIT_OUTPUT_LIMIT_BYTES,
) -> bytes:
    if not isinstance(workspace, _PinnedWorkspace):
        with _PinnedWorkspace(workspace) as pinned_workspace:
            return _git_bytes(
                pinned_workspace,
                *args,
                output_limit_bytes=output_limit_bytes,
            )
    command = _git_command(workspace, *args)
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_git_provenance_environment(),
        start_new_session=True,
        close_fds=True,
        pass_fds=(workspace.fd,),
    )
    deadline = time.monotonic() + GIT_COMMAND_TIMEOUT_SECONDS
    try:
        stdout, stderr = _collect_bounded_step_output(
            process,
            command=command,
            deadline=deadline,
            output_limit_bytes=output_limit_bytes,
            output_label="source provenance git command",
        )
        if process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, GIT_COMMAND_TIMEOUT_SECONDS)
            process.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        if process.returncode is None:
            _terminate_owned_sandbox(process)
        raise ValueError(
            f"source provenance git command timed out after {GIT_COMMAND_TIMEOUT_SECONDS}s"
        ) from exc
    except BaseException:
        if process.returncode is None:
            _terminate_owned_sandbox(process)
        raise
    _verify_git_executable_generation()
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"source provenance git check failed: {detail or 'git command failed'}")
    return stdout


def _reject_hidden_git_index_entries(
    workspace: Path | _PinnedWorkspace,
) -> None:
    """Reject index flags that make worktree cleanliness non-observable."""
    assume_records = [
        record for record in _git_bytes(workspace, "ls-files", "-v", "-z").split(b"\0") if record
    ]
    skip_records = [
        record for record in _git_bytes(workspace, "ls-files", "-t", "-z").split(b"\0") if record
    ]
    if any(record[:1].islower() for record in assume_records) or any(
        record.startswith(b"S ") for record in skip_records
    ):
        raise ValueError(
            "source provenance rejects assume-unchanged or skip-worktree index flags"
        )


def _git_index_matches_revision(
    workspace: Path | _PinnedWorkspace,
    revision: str,
) -> bool:
    changed_paths = _git_bytes(
        workspace,
        "diff-index",
        "--cached",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--ignore-submodules=none",
        revision,
        "--",
    )
    return not changed_paths


def _git_worktree_matches_revision(
    workspace: Path | _PinnedWorkspace,
    revision: str,
    submodule_paths: list[str],
) -> bool:
    """Check only gitlink worktrees without touching regular-file diff drivers."""
    if not submodule_paths:
        return True
    changed_paths = _git_bytes(
        workspace,
        "diff-index",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--ignore-submodules=none",
        revision,
        "--",
        *submodule_paths,
    )
    return not changed_paths


def _git_tree_entries(
    workspace: Path | _PinnedWorkspace,
    revision: str,
) -> dict[str, dict[str, str]]:
    output = _git_bytes(
        workspace,
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        revision,
    )
    entries: dict[str, dict[str, str]] = {}
    for record in (item for item in output.split(b"\0") if item):
        metadata, separator, raw_path = record.partition(b"\t")
        parts = metadata.split()
        try:
            mode, object_type, object_id = (part.decode("ascii") for part in parts)
            relative = os.fsdecode(raw_path)
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("source provenance git tree contains an invalid entry") from exc
        relative_path = Path(relative)
        valid_blob = object_type == "blob" and mode in {
            "100644",
            "100755",
            "120000",
        }
        valid_gitlink = object_type == "commit" and mode == "160000"
        if (
            separator != b"\t"
            or len(parts) != 3
            or not (valid_blob or valid_gitlink)
            or not relative
            or relative_path.is_absolute()
            or any(part in {"", ".", ".."} for part in relative_path.parts)
            or relative in entries
        ):
            raise ValueError(f"source provenance git tree entry is invalid: {relative}")
        entries[relative] = {
            "git_type": (
                "submodule"
                if mode == "160000"
                else "symlink"
                if mode == "120000"
                else "file"
            ),
            "git_mode": mode,
            "git_object": object_id,
        }
    return entries


def _rooted_workspace_artifacts(
    root: Path | _PinnedWorkspace,
    *,
    tree_entries: dict[str, dict[str, str]] | None = None,
) -> dict[str, dict[str, Any] | None]:
    observations: dict[str, dict[str, Any] | None] = {}
    directory_flags = os.O_RDONLY | _required_open_flag("O_DIRECTORY")
    directory_flags |= _required_open_flag("O_CLOEXEC") | _required_open_flag("O_NOFOLLOW")

    def walk(directory_fd: int, prefix: PurePosixPath) -> None:
        status_before = os.fstat(directory_fd)
        for name in sorted(os.listdir(directory_fd)):
            if not prefix.parts and name == ".git":
                continue
            relative = (prefix / name).as_posix()
            status = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(status.st_mode):
                tree_entry = (tree_entries or {}).get(relative)
                if (
                    tree_entry is not None
                    and tree_entry.get("git_type") == "submodule"
                ):
                    observations[relative] = {
                        "git_type": "submodule",
                        "git_object": tree_entry["git_object"],
                    }
                    continue
                child_fd = os.open(name, directory_flags, dir_fd=directory_fd)
                try:
                    child_status = os.fstat(child_fd)
                    if (child_status.st_dev, child_status.st_ino) != (
                        status.st_dev,
                        status.st_ino,
                    ):
                        raise ValueError(
                            f"source provenance workspace changed while reading: {relative}"
                        )
                    walk(child_fd, prefix / name)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(status.st_mode) or stat.S_ISLNK(status.st_mode):
                observations[relative] = _observe_artifact_at(
                    directory_fd,
                    name,
                    relative,
                    initial_status=status,
                )
            else:
                observations[relative] = None
        status_after = os.fstat(directory_fd)
        if _stable_stat_identity(status_after) != _stable_stat_identity(status_before):
            raise ValueError("source provenance workspace changed while reading")

    root_fd = _duplicate_workspace_fd(root)
    try:
        walk(root_fd, PurePosixPath())
    finally:
        os.close(root_fd)
    return observations


def _source_workspace_is_clean(
    workspace: Path | _PinnedWorkspace,
    revision: str,
) -> bool:
    tree_entries = _git_tree_entries(workspace, revision)
    submodule_paths = sorted(
        relative
        for relative, entry in tree_entries.items()
        if entry["git_type"] == "submodule"
    )
    if not _git_worktree_matches_revision(
        workspace,
        revision,
        submodule_paths,
    ):
        return False
    observations = _rooted_workspace_artifacts(
        workspace,
        tree_entries=tree_entries,
    )
    if set(observations) != set(tree_entries):
        return False
    return all(
        observation is not None
        and _observation_matches_git_tree(observation, tree_entries[relative])
        for relative, observation in observations.items()
    )


def _capture_source_provenance(
    contract: dict[str, Any],
    source_workspace: Path | _PinnedWorkspace | None,
) -> dict[str, Any] | None:
    declaration = contract.get("source_provenance")
    if declaration is None:
        if source_workspace is not None:
            raise ValueError("source workspace requires contract.source_provenance")
        return None
    if not isinstance(declaration, dict):
        raise ValueError("contract.source_provenance must be an object")
    if source_workspace is None:
        raise ValueError("source provenance requires an existing source workspace")
    if not isinstance(source_workspace, _PinnedWorkspace):
        with _PinnedWorkspace(source_workspace) as pinned_workspace:
            return _capture_source_provenance(contract, pinned_workspace)
    repository = declaration.get("repository")
    revision = declaration.get("revision")
    require_clean = declaration.get("require_clean")
    if not isinstance(repository, str) or not repository:
        raise ValueError("source provenance repository must be non-empty")
    if not isinstance(revision, str) or not revision:
        raise ValueError("source provenance revision must be non-empty")
    if not isinstance(require_clean, bool):
        raise ValueError("source provenance require_clean must be boolean")
    observed_revision = _git_output(source_workspace, "rev-parse", "--verify", "HEAD^{commit}")
    if observed_revision != revision:
        raise ValueError("source provenance revision differs")
    observed_repository = _git_output(
        source_workspace,
        "config",
        "--local",
        "--no-includes",
        "--get",
        "remote.origin.url",
    )
    if observed_repository != repository:
        raise ValueError("source provenance repository differs")
    _reject_hidden_git_index_entries(source_workspace)
    clean = _git_index_matches_revision(
        source_workspace,
        observed_revision,
    ) and _source_workspace_is_clean(source_workspace, observed_revision)
    if require_clean and not clean:
        raise ValueError("source provenance workspace is dirty")
    return {
        "repository": repository,
        "revision": observed_revision,
        "clean": clean,
    }


def _git_tree_entry(
    workspace: Path | _PinnedWorkspace,
    revision: str,
    relative: str,
) -> dict[str, str]:
    """Return the exact Git-tree identity for one canonical candidate artifact."""
    if not relative or relative.endswith("/") or Path(relative).is_absolute():
        raise ValueError(f"source provenance candidate artifact path is invalid: {relative}")
    try:
        output = _git_bytes(workspace, "ls-tree", "-z", revision, "--", relative)
    except ValueError as exc:
        raise ValueError(
            f"source provenance candidate artifact is absent from pinned git tree: {relative}"
        ) from exc
    entries = [record for record in output.split(b"\0") if record]
    if len(entries) != 1:
        raise ValueError(
            f"source provenance candidate artifact is absent from pinned git tree: {relative}"
        )
    metadata, separator, entry_path = entries[0].partition(b"\t")
    parts = metadata.split()
    expected_path = relative.encode("utf-8")
    if separator != b"\t" or entry_path != expected_path or len(parts) != 3:
        raise ValueError(f"source provenance git tree entry is invalid: {relative}")
    mode, object_type, object_id = (part.decode("ascii") for part in parts)
    if object_type != "blob" or mode not in {"100644", "100755", "120000"}:
        raise ValueError(
            f"source provenance candidate artifact has unsupported git type: {relative}"
        )
    return {
        "git_type": "symlink" if mode == "120000" else "file",
        "git_mode": mode,
        "git_object": object_id,
    }


def _stable_stat_identity(status: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        status.st_dev,
        status.st_ino,
        status.st_mode,
        status.st_size,
        status.st_mtime_ns,
        status.st_ctime_ns,
    )


def _git_blob_digests(payload: bytes) -> tuple[str, str]:
    header = f"blob {len(payload)}\0".encode("ascii")
    return (
        hashlib.sha1(header + payload).hexdigest(),
        hashlib.sha256(header + payload).hexdigest(),
    )


def _observe_artifact_at(
    directory_fd: int,
    name: str,
    relative: str,
    *,
    initial_status: os.stat_result | None = None,
) -> dict[str, Any]:
    status_before = initial_status or os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if stat.S_ISLNK(status_before.st_mode):
        target_text = os.readlink(name, dir_fd=directory_fd)
        target = os.fsencode(target_text)
        status_after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if _stable_stat_identity(status_after) != _stable_stat_identity(status_before):
            raise ValueError(
                f"source provenance candidate artifact changed while reading: {relative}"
            )
        sha1_object, sha256_object = _git_blob_digests(target)
        return {
            "git_type": "symlink",
            "symlink_target": target_text,
            "mode": stat.S_IMODE(status_before.st_mode),
            "fingerprint": "sha256:"
            + hashlib.sha256(
                _metadata_bytes_from_status(status_before) + target
            ).hexdigest(),
            "git_object_sha1": sha1_object,
            "git_object_sha256": sha256_object,
        }
    if not stat.S_ISREG(status_before.st_mode):
        raise ValueError(
            f"source provenance candidate artifact is not a regular file or symlink: {relative}"
        )
    file_flags = os.O_RDONLY | _required_open_flag("O_CLOEXEC")
    file_flags |= _required_open_flag("O_NOFOLLOW") | _required_open_flag("O_NONBLOCK")
    file_fd = os.open(name, file_flags, dir_fd=directory_fd)
    try:
        status = os.fstat(file_fd)
        if (
            not stat.S_ISREG(status.st_mode)
            or (status.st_dev, status.st_ino)
            != (status_before.st_dev, status_before.st_ino)
        ):
            raise ValueError(
                f"source provenance candidate artifact is not a regular file or symlink: {relative}"
            )
        header = f"blob {status.st_size}\0".encode("ascii")
        fingerprint_digest = hashlib.sha256()
        fingerprint_digest.update(_metadata_bytes_from_status(status))
        git_sha1 = hashlib.sha1(header)
        git_sha256 = hashlib.sha256(header)
        byte_length = 0
        with os.fdopen(file_fd, "rb") as handle:
            file_fd = -1
            while chunk := handle.read(1024 * 1024):
                byte_length += len(chunk)
                fingerprint_digest.update(chunk)
                git_sha1.update(chunk)
                git_sha256.update(chunk)
        final_status = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            byte_length != status.st_size
            or _stable_stat_identity(final_status) != _stable_stat_identity(status)
        ):
            raise ValueError(
                f"source provenance candidate artifact changed while reading: {relative}"
            )
        return {
            "git_type": "file",
            "mode": stat.S_IMODE(status.st_mode),
            "fingerprint": f"sha256:{fingerprint_digest.hexdigest()}",
            "git_object_sha1": git_sha1.hexdigest(),
            "git_object_sha256": git_sha256.hexdigest(),
        }
    finally:
        if file_fd >= 0:
            os.close(file_fd)


def _observe_rooted_artifact(
    root: Path | _PinnedWorkspace,
    relative: str,
) -> dict[str, Any]:
    """Observe one lexical leaf once through a no-follow root descriptor."""
    relative_path = Path(relative)
    if (
        not relative
        or relative_path.is_absolute()
        or any(part in {"", ".", ".."} for part in relative_path.parts)
    ):
        raise ValueError(f"source provenance candidate artifact path is invalid: {relative}")
    directory_flags = os.O_RDONLY | _required_open_flag("O_DIRECTORY")
    directory_flags |= _required_open_flag("O_CLOEXEC") | _required_open_flag("O_NOFOLLOW")
    dir_fd = _duplicate_workspace_fd(root)
    try:
        for component in relative_path.parts[:-1]:
            next_fd = os.open(component, directory_flags, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = next_fd
        return _observe_artifact_at(dir_fd, relative_path.name, relative)
    except OSError as exc:
        raise ValueError(
            f"source provenance candidate artifact is not a regular file or symlink: {relative}"
        ) from exc
    finally:
        os.close(dir_fd)


def _observation_matches_git_tree(
    observation: dict[str, Any],
    tree_entry: dict[str, str],
) -> bool:
    if observation["git_type"] != tree_entry["git_type"]:
        return False
    if tree_entry["git_type"] == "submodule":
        return hmac.compare_digest(
            observation.get("git_object", ""),
            tree_entry["git_object"],
        )
    if tree_entry["git_type"] == "file":
        expected_executable = tree_entry["git_mode"] == "100755"
        if bool(observation["mode"] & stat.S_IXUSR) != expected_executable:
            return False
    object_id = tree_entry["git_object"]
    observed_object = observation[
        "git_object_sha256" if len(object_id) == 64 else "git_object_sha1"
    ]
    return hmac.compare_digest(observed_object, object_id)


def _git_symlink_target_path(
    workspace: Path | _PinnedWorkspace,
    relative: str,
    tree_entry: dict[str, str],
) -> str | None:
    """Return a pinned in-tree symlink target, rejecting links outside the source tree."""
    if tree_entry["git_type"] != "symlink":
        return None
    try:
        target = _git_bytes(
            workspace,
            "cat-file",
            "blob",
            tree_entry["git_object"],
            output_limit_bytes=GIT_SYMLINK_TARGET_LIMIT_BYTES,
        )
        target_text = target.decode("utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"source provenance symlink target is invalid: {relative}") from exc
    target_path = PurePosixPath(target_text)
    if target_path.is_absolute():
        raise ValueError(f"source provenance symlink target escapes workspace: {relative}")
    relative_parent = PurePosixPath(relative).parent
    stack: list[str] = []
    for part in (*relative_parent.parts, *target_path.parts):
        if part in {"", "."}:
            continue
        if part == "..":
            if not stack:
                raise ValueError(
                    f"source provenance symlink target escapes workspace: {relative}"
                )
            stack.pop()
            continue
        stack.append(part)
    if not stack:
        raise ValueError(f"source provenance symlink target is invalid: {relative}")
    return PurePosixPath(*stack).as_posix()


def _git_tree_artifact_closure(
    workspace: Path | _PinnedWorkspace,
    revision: str,
    artifacts: list[str],
    *,
    label: str,
) -> list[tuple[str, dict[str, str]]]:
    """Expand declared Git symlinks into their complete pinned in-tree target closure."""
    pending = list(artifacts)
    seen: dict[str, dict[str, str]] = {}
    while pending:
        relative = pending.pop()
        if relative in seen:
            continue
        tree_entry = _git_tree_entry(workspace, revision, relative)
        seen[relative] = tree_entry
        target = _git_symlink_target_path(workspace, relative, tree_entry)
        if target is not None:
            pending.append(target)
    return [(relative, seen[relative]) for relative in sorted(seen)]


def _bind_real_upstream_artifacts(
    contract: dict[str, Any],
    provenance: dict[str, Any] | None,
    *,
    source_workspace: Path | _PinnedWorkspace | None,
) -> list[dict[str, str]] | None:
    """Bind real-upstream test inputs to the same immutable Git tree as source."""
    workflow = contract.get("real_upstream_workflow")
    if workflow is None:
        return None
    if provenance is None or source_workspace is None:
        raise ValueError("real upstream workflow requires source provenance")
    if not isinstance(source_workspace, _PinnedWorkspace):
        with _PinnedWorkspace(source_workspace) as pinned_workspace:
            return _bind_real_upstream_artifacts(
                contract,
                provenance,
                source_workspace=pinned_workspace,
            )
    if not isinstance(workflow, dict):
        raise ValueError("contract.real_upstream_workflow must be an object")
    declared_artifacts = [
        *workflow.get("focused_artifacts", []),
        *workflow.get("broad_artifacts", []),
    ]
    if not declared_artifacts or not all(
        isinstance(item, str) and item for item in declared_artifacts
    ):
        raise ValueError("real upstream workflow artifacts must be non-empty paths")
    artifacts = _git_tree_artifact_closure(
        source_workspace,
        provenance["revision"],
        declared_artifacts,
        label="real upstream",
    )
    declared_paths = set(declared_artifacts)
    undeclared_targets = sorted(
        relative for relative, _ in artifacts if relative not in declared_paths
    )
    if undeclared_targets:
        raise ValueError(
            "real upstream symlink target must be declared in workflow: "
            f"{undeclared_targets}"
        )
    control_plane = contract.get("control_plane")
    protected_asset_records = (
        control_plane.get("protected_assets", [])
        if isinstance(control_plane, dict)
        else []
    )
    protected_assets = {
        item.get("path"): item.get("fingerprint")
        for item in protected_asset_records
        if isinstance(item, dict)
    }
    bound: list[dict[str, str]] = []
    for relative, tree_entry in artifacts:
        expected_fingerprint = protected_assets.get(relative)
        if not isinstance(expected_fingerprint, str):
            raise ValueError(f"real upstream artifact must be a protected asset: {relative}")
        path = Path(relative)
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise ValueError(f"real upstream artifact path is invalid: {relative}")
        try:
            observation = _observe_rooted_artifact(source_workspace, relative)
        except ValueError as exc:
            raise ValueError(
                f"real upstream artifact differs from pinned source: {relative}"
            ) from exc
        fingerprint = observation["fingerprint"]
        if fingerprint != expected_fingerprint or not _observation_matches_git_tree(
            observation, tree_entry
        ):
            raise ValueError(f"real upstream artifact differs from pinned source: {relative}")
        bound.append(
            {
                "path": relative,
                "fingerprint": fingerprint,
                **tree_entry,
            }
        )
    return bound


def _bind_source_candidate_artifacts(
    provenance: dict[str, Any] | None,
    *,
    source_workspace: Path | _PinnedWorkspace | None,
    candidate_snapshot: list[dict[str, str]],
    candidate_workspace: Path | None = None,
) -> dict[str, Any] | None:
    if provenance is None:
        return None
    assert source_workspace is not None
    if not isinstance(source_workspace, _PinnedWorkspace):
        with _PinnedWorkspace(source_workspace) as pinned_workspace:
            return _bind_source_candidate_artifacts(
                provenance,
                source_workspace=pinned_workspace,
                candidate_snapshot=candidate_snapshot,
                candidate_workspace=candidate_workspace,
            )
    candidate_root = None if candidate_workspace is None else candidate_workspace.resolve()
    snapshot_fingerprints = {
        item["path"]: item["fingerprint"]
        for item in candidate_snapshot
        if not item["path"].endswith("/")
    }
    if not snapshot_fingerprints:
        raise ValueError("source provenance lacks candidate artifact bindings")
    closure = _git_tree_artifact_closure(
        source_workspace,
        provenance["revision"],
        list(snapshot_fingerprints),
        label="candidate",
    )
    undeclared_targets = sorted(
        relative for relative, _ in closure if relative not in snapshot_fingerprints
    )
    if undeclared_targets:
        raise ValueError(
            "source provenance candidate symlink target must be separately declared: "
            f"{undeclared_targets}"
        )
    tree_entries = dict(closure)
    artifacts: list[dict[str, str]] = []
    for relative, snapshot_fingerprint in sorted(snapshot_fingerprints.items()):
        tree_entry = tree_entries[relative]
        relative_path = Path(relative)
        if any(part in {"", ".", ".."} for part in relative_path.parts):
            raise ValueError(f"source provenance candidate artifact path is invalid: {relative}")
        try:
            source_observation = _observe_rooted_artifact(source_workspace, relative)
        except ValueError as exc:
            raise ValueError(
                f"source provenance differs for candidate artifact: {relative}"
            ) from exc
        source_fingerprint = source_observation["fingerprint"]
        if not _observation_matches_git_tree(source_observation, tree_entry):
            raise ValueError(f"source provenance differs for candidate artifact: {relative}")
        if candidate_root is not None:
            try:
                candidate_observation = _observe_rooted_artifact(candidate_root, relative)
            except ValueError as exc:
                raise ValueError(
                    f"source provenance differs for candidate artifact: {relative}"
                ) from exc
            if candidate_observation["fingerprint"] != snapshot_fingerprint or not (
                _observation_matches_git_tree(candidate_observation, tree_entry)
            ):
                raise ValueError(f"source provenance differs for candidate artifact: {relative}")
        if source_observation["git_type"] != tree_entry["git_type"]:
            raise ValueError(f"source provenance git type differs for candidate artifact: {relative}")
        artifacts.append(
            {
                "path": relative,
                "fingerprint": snapshot_fingerprint,
                "source_fingerprint": source_fingerprint,
                **tree_entry,
            }
        )
    return {**provenance, "candidate_artifacts": artifacts}


def _rename_directory_noreplace(
    source_name: str,
    destination_name: str,
    *,
    parent_fd: int,
) -> None:
    """Publish a same-parent directory only when its final name is still absent."""
    if sys.platform == "darwin":
        library_path = ctypes.util.find_library("System")
        if library_path is None:
            raise ValueError("retained-output no-replace rename is unavailable")
        library = ctypes.CDLL(library_path, use_errno=True)
        renameatx_np = getattr(library, "renameatx_np", None)
        if renameatx_np is None:
            raise ValueError("retained-output no-replace rename is unavailable")
        renameatx_np.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameatx_np.restype = ctypes.c_int
        rename_excl = 0x00000004  # Darwin RENAME_EXCL from <sys/attr.h>.
        result = renameatx_np(
            parent_fd,
            os.fsencode(source_name),
            parent_fd,
            os.fsencode(destination_name),
            rename_excl,
        )
        if result == 0:
            return
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise ValueError(f"output directory already exists: {destination_name}")
        raise OSError(error, os.strerror(error))
    if sys.platform.startswith("linux"):
        library_path = ctypes.util.find_library("c")
        if library_path is None:
            raise ValueError("retained-output no-replace rename is unavailable")
        library = ctypes.CDLL(library_path, use_errno=True)
        renameat2 = getattr(library, "renameat2", None)
        if renameat2 is None:
            raise ValueError("retained-output no-replace rename is unavailable")
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        rename_noreplace = 1
        result = renameat2(
            parent_fd,
            os.fsencode(source_name),
            parent_fd,
            os.fsencode(destination_name),
            rename_noreplace,
        )
        if result == 0:
            return
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise ValueError(f"output directory already exists: {destination_name}")
        if error in {errno.ENOSYS, errno.EINVAL}:
            raise ValueError("retained-output no-replace rename is unavailable")
        raise OSError(error, os.strerror(error))
    raise ValueError("retained-output no-replace rename is unavailable")


class _RetainedOutputPublication:
    """Own one private retained-output staging directory until atomic publication."""

    def __init__(self, final_directory: Path) -> None:
        self.final_directory = Path(os.path.abspath(final_directory))
        self._parent_fd: int | None = None
        self._staging_name: str | None = None
        self._staging_identity: tuple[int, int] | None = None
        self._published = False

    @property
    def staging_directory(self) -> Path:
        if self._staging_name is None:
            raise RuntimeError("retained-output publication has not started")
        return self.final_directory.parent / self._staging_name

    def __enter__(self) -> "_RetainedOutputPublication":
        final_name = self.final_directory.name
        if final_name in {"", ".", ".."} or self.final_directory == self.final_directory.parent:
            raise ValueError(f"output directory must name a child directory: {self.final_directory}")
        parent_fd = _open_directory_nofollow(
            self.final_directory.parent,
            create_missing=True,
        )
        self._parent_fd = parent_fd
        try:
            fcntl.flock(parent_fd, fcntl.LOCK_EX)
            try:
                os.lstat(final_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            else:
                raise ValueError(
                    f"output directory already exists: {self.final_directory}"
                )
            name_digest = hashlib.sha256(final_name.encode("utf-8")).hexdigest()[:16]
            for _ in range(32):
                staging_name = (
                    f".vdd-accept-{name_digest}-{os.urandom(16).hex()}.staging"
                )
                try:
                    os.mkdir(staging_name, 0o700, dir_fd=parent_fd)
                except FileExistsError:
                    continue
                status = os.stat(
                    staging_name,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
                if not stat.S_ISDIR(status.st_mode):
                    raise ValueError("retained-output staging path is not a directory")
                self._staging_name = staging_name
                self._staging_identity = (status.st_dev, status.st_ino)
                return self
            raise ValueError("could not allocate a private retained-output staging directory")
        except Exception:
            self._release_parent_lock()
            raise

    def _assert_owned_staging(self) -> None:
        if (
            self._parent_fd is None
            or self._staging_name is None
            or self._staging_identity is None
        ):
            raise RuntimeError("retained-output publication has not started")
        status = os.stat(
            self._staging_name,
            dir_fd=self._parent_fd,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISDIR(status.st_mode)
            or (status.st_dev, status.st_ino) != self._staging_identity
        ):
            raise ValueError("retained-output staging directory changed during issuance")

    def publish(self) -> None:
        if self._published:
            raise RuntimeError("retained-output publication is already complete")
        self._assert_owned_staging()
        assert self._parent_fd is not None
        assert self._staging_name is not None
        try:
            os.lstat(self.final_directory.name, dir_fd=self._parent_fd)
        except FileNotFoundError:
            pass
        else:
            raise ValueError(
                f"output directory already exists: {self.final_directory}"
            )
        _rename_directory_noreplace(
            self._staging_name,
            self.final_directory.name,
            parent_fd=self._parent_fd,
        )
        self._published = True
        try:
            os.fsync(self._parent_fd)
        except OSError:
            pass

    def _discard_staging(self) -> None:
        if self._staging_name is None or self._parent_fd is None:
            return
        try:
            self._assert_owned_staging()
        except FileNotFoundError:
            return
        shutil.rmtree(self._staging_name, dir_fd=self._parent_fd)
        try:
            os.fsync(self._parent_fd)
        except OSError:
            pass

    def _release_parent_lock(self) -> None:
        if self._parent_fd is None:
            return
        try:
            fcntl.flock(self._parent_fd, fcntl.LOCK_UN)
        finally:
            os.close(self._parent_fd)
            self._parent_fd = None

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        try:
            if not self._published:
                self._discard_staging()
        finally:
            self._release_parent_lock()
        return False


def _issue_attestation(
    contract: dict[str, Any],
    proposal: dict[str, Any],
    *,
    workspace: Path,
    signing_key: bytes,
    run_id: str,
    parent_attestation: dict[str, Any] | None = None,
    parent_attestations: list[dict[str, Any]] | None = None,
    qualification_attestations: list[dict[str, Any]] | None = None,
    output_directory: Path | None = None,
    source_workspace: Path | _PinnedWorkspace | None = None,
    attested_output_directory: Path | None = None,
) -> dict[str, Any]:
    if not run_id:
        raise ValueError("run_id must be non-empty")
    if source_workspace is not None and not isinstance(source_workspace, _PinnedWorkspace):
        with _PinnedWorkspace(source_workspace) as pinned_workspace:
            return _issue_attestation(
                contract,
                proposal,
                workspace=workspace,
                signing_key=signing_key,
                run_id=run_id,
                parent_attestation=parent_attestation,
                parent_attestations=parent_attestations,
                qualification_attestations=qualification_attestations,
                output_directory=output_directory,
                source_workspace=pinned_workspace,
                attested_output_directory=attested_output_directory,
            )
    provenance_workspace = source_workspace
    source_workspace_path = (
        None if source_workspace is None else _workspace_path(source_workspace)
    )
    provenance = _capture_source_provenance(contract, provenance_workspace)
    source_workspace = Path(os.path.abspath(workspace))
    workspace = workspace.resolve()
    if not workspace.is_dir():
        raise ValueError(f"workspace is not a directory: {workspace}")
    retained_output_directory = None
    attested_retained_output_directory = None
    if output_directory is not None:
        retained_output_directory = Path(os.path.abspath(output_directory))
        attested_retained_output_directory = Path(
            os.path.abspath(
                output_directory
                if attested_output_directory is None
                else attested_output_directory
            )
        )
        output_dir_fd = _open_directory_nofollow(retained_output_directory)
        os.close(output_dir_fd)

    (
        plan,
        allowed_outputs,
        preflight_manifest,
        protected_snapshot_before,
        candidate_snapshot_before,
        execution_environment,
        environment_identity,
    ) = _preflight_control_plane(contract, workspace)
    source_provenance = None
    real_upstream_artifacts = _bind_real_upstream_artifacts(
        contract,
        provenance,
        source_workspace=provenance_workspace,
    )
    if source_workspace_path is not None and _path_under(workspace, source_workspace_path):
        raise ValueError("candidate workspace overlaps source workspace")
    migration_context = contract.get("migration_context")
    migration_role = (
        migration_context.get("role")
        if isinstance(migration_context, dict)
        else None
    )
    if proposal.get("stage") == "release" or contract.get("risk_profile") == "critical":
        release_result_plan = contract["control_plane"].get("release_result")
        if not isinstance(release_result_plan, dict):
            raise ValueError(
                "release/critical contract.control_plane.release_result is required"
            )
        # Producer identity and argv binding already validated in preflight.


    migration_parent_references, migration_parent_candidate_digests = _authenticate_migration_parents(
        contract, proposal, parent_attestations or [], signing_key
    )
    parent_reference, parent_candidate_digests = _authenticate_parent(
        contract, proposal, parent_attestation, signing_key
    )
    if migration_parent_references and parent_attestation is not None:
        raise ValueError("migration issuance uses migration parents, not legacy parent_attestation")
    if migration_parent_candidate_digests:
        parent_candidate_digests = migration_parent_candidate_digests
    qualification_snapshots = _authenticate_reused_qualifications(
        contract, qualification_attestations or [], signing_key
    )

    with tempfile.TemporaryDirectory(prefix="vdd-accept-") as tmp:
        snapshot_workspace = Path(tmp) / "workspace"
        copied_manifest = _copy_workspace_snapshot(
            workspace,
            snapshot_workspace,
            expected_manifest=preflight_manifest,
        )
        copied_protected_snapshot = _verify_protected_assets(contract, snapshot_workspace)
        copied_candidate_snapshot = _candidate_snapshot(contract, snapshot_workspace)
        if copied_protected_snapshot != protected_snapshot_before:
            raise ValueError("protected asset changed while creating acceptance snapshot")
        if copied_candidate_snapshot != candidate_snapshot_before:
            raise ValueError("candidate artifact changed while creating acceptance snapshot")
        source_provenance = _bind_source_candidate_artifacts(
            provenance,
            source_workspace=provenance_workspace,
            candidate_snapshot=copied_candidate_snapshot,
            candidate_workspace=snapshot_workspace,
        )
        if source_provenance is not None and real_upstream_artifacts is not None:
            source_provenance["real_upstream_artifacts"] = real_upstream_artifacts
        candidate_digests = [item["fingerprint"] for item in candidate_snapshot_before]
        candidate_revision = canonical_digest(candidate_snapshot_before)
        if parent_candidate_digests is not None and parent_candidate_digests != candidate_digests:
            raise ValueError(
                "parent merge candidate artifact identity differs from release snapshot"
            )
        if (
            parent_reference is not None
            and parent_reference.get("candidate_revision") != candidate_revision
        ):
            raise ValueError(
                "parent merge candidate revision differs from release snapshot"
            )
        directory_outputs: set[str] = set()
        for relative in allowed_outputs:
            output_path = _safe_workspace_path(snapshot_workspace, relative)
            if output_path.exists() and output_path.is_dir() and not output_path.is_symlink():
                directory_outputs.add(relative)
                # Clear directory contents but preserve the directory node itself.
                for child in sorted(output_path.rglob("*"), reverse=True):
                    if child.is_symlink() or child.is_file():
                        child.unlink()
                    elif child.is_dir():
                        try:
                            child.rmdir()
                        except OSError:
                            shutil.rmtree(child)
            elif output_path.exists() or output_path.is_symlink():
                output_path.unlink()
        before_manifest = _workspace_manifest(snapshot_workspace)
        nonfatal_stability_ids = {
            command_id
            for oracle in contract.get("oracles", [])
            if oracle.get("qualification", {}).get("status") == "fresh"
            for command_id in oracle.get("qualification", {}).get(
                "stability_command_ids", []
            )
        }
        producer_captures: dict[str, dict[str, Any]] = {}
        control_plane = contract["control_plane"]
        for role in (
            "discovery", "metric_result", "cutover_result", "release_result",
            "migration_inventory_result", "migration_fencing_result",
            "migration_completion_result",
        ):
            plan_spec = control_plane.get(role)
            if not isinstance(plan_spec, dict):
                continue
            command_id = plan_spec.get("command_id")
            result_path = plan_spec.get("result_path")
            if isinstance(command_id, str) and isinstance(result_path, str):
                producer_captures[command_id] = {
                    "result_path": result_path,
                    "role": role,
                }
        platform_results = control_plane.get("platform_results")
        if isinstance(platform_results, dict):
            for platform, plan_spec in platform_results.items():
                if not isinstance(plan_spec, dict):
                    continue
                command_id = plan_spec.get("command_id")
                result_path = plan_spec.get("result_path")
                if isinstance(command_id, str) and isinstance(result_path, str):
                    producer_captures[command_id] = {
                        "result_path": result_path,
                        "role": f"platform_result:{platform}",
                        "platform": platform,
                    }
        commands = _execute_plan(
            plan,
            snapshot_workspace,
            execution_environment,
            source_workspace=source_workspace,
            nonfatal_step_ids=nonfatal_stability_ids,
            allowed_outputs=allowed_outputs,
            candidate_paths=list(control_plane.get("candidate_artifacts", [])),
            readable_protected_paths=list(
                contract["candidate_capabilities"]["readable_protected_paths"]
            ),
            executable_identities=environment_identity["details"]["executables"],
            producer_captures=producer_captures,
            directory_outputs=directory_outputs,
            output_directory=retained_output_directory,
        )
        try:
            final_protected_snapshot = _verify_protected_assets(
                contract, snapshot_workspace
            )
        except ValueError as exc:
            raise ValueError(f"protected asset changed during acceptance: {exc}") from exc
        if final_protected_snapshot != protected_snapshot_before:
            raise ValueError("protected asset changed during acceptance")
        candidate_snapshot_after = _candidate_snapshot(contract, snapshot_workspace)
        if candidate_snapshot_after != candidate_snapshot_before:
            raise ValueError("candidate artifact changed during acceptance")
        after_manifest = _workspace_manifest(snapshot_workspace)
        changed_paths = sorted(
            path
            for path in set(before_manifest) | set(after_manifest)
            if before_manifest.get(path) != after_manifest.get(path)
        )
        forbidden_scope_diff = [
            path
            for path in changed_paths
            if not _path_is_declared_or_ancestor(
                path,
                allowed_outputs + [".vdd-accept-sealed"],
            )
        ]
        if forbidden_scope_diff:
            raise ValueError(
                f"forbidden scope changed during acceptance: {forbidden_scope_diff}"
            )

        captured_by_role = {
            record["captured_result"]["role"]: record["captured_result"]
            for record in commands
            if isinstance(record.get("captured_result"), dict)
        }
        if "discovery" not in captured_by_role:
            raise ValueError("protected discovery result was not captured at producer step")
        discovery = captured_by_role["discovery"]["value"]
        discovery_digest = captured_by_role["discovery"]["digest"]
        final_discovery_path = _safe_workspace_path(
            snapshot_workspace, captured_by_role["discovery"]["path"]
        )
        _assert_captured_json_not_replaced(
            final_discovery_path,
            discovery,
            "protected discovery result replaced after producer capture",
        )

        protected_metric_result = None
        if contract.get("mode") == "improvement":
            if "metric_result" not in captured_by_role:
                raise ValueError(
                    "protected metric result was not captured at producer step"
                )
            protected_metric_result = captured_by_role["metric_result"]["value"]
            metric_path = _safe_workspace_path(
                snapshot_workspace, captured_by_role["metric_result"]["path"]
            )
            _assert_captured_json_not_replaced(
                metric_path,
                protected_metric_result,
                "protected metric result replaced after producer capture",
            )

        protected_inventory_result = None
        if (
            contract.get("migration_profile") == "large_equivalence"
            and migration_role == "bootstrap"
        ):
            if "migration_inventory_result" not in captured_by_role:
                raise ValueError("protected migration inventory result was not captured")
            protected_inventory_result = captured_by_role["migration_inventory_result"]["value"]
            if (
                not isinstance(protected_inventory_result, dict)
                or set(protected_inventory_result) != {
                    "scan_digest", "expected", "discovered", "unit_ids"
                }
                or not isinstance(protected_inventory_result.get("scan_digest"), str)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", protected_inventory_result["scan_digest"])
                or any(
                    not isinstance(protected_inventory_result.get(field), int)
                    or isinstance(protected_inventory_result.get(field), bool)
                    or protected_inventory_result[field] < 0
                    for field in ("expected", "discovered")
                )
                or not isinstance(protected_inventory_result.get("unit_ids"), list)
                or not protected_inventory_result["unit_ids"]
                or any(
                    not isinstance(unit_id, str) or not unit_id
                    for unit_id in protected_inventory_result["unit_ids"]
                )
                or len(protected_inventory_result["unit_ids"])
                != len(set(protected_inventory_result["unit_ids"]))
                or protected_inventory_result["expected"]
                != len(protected_inventory_result["unit_ids"])
            ):
                raise ValueError(
                    "protected migration inventory result must contain only valid "
                    "scan_digest, expected, discovered, and unit_ids fields"
                )

        protected_fencing_result = None
        if (
            contract.get("migration_profile") == "large_equivalence"
            and migration_role == "batch"
        ):
            if "migration_fencing_result" not in captured_by_role:
                raise ValueError("protected migration fencing result was not captured")
            protected_fencing_result = captured_by_role["migration_fencing_result"]["value"]
            if (
                not isinstance(protected_fencing_result, dict)
                or set(protected_fencing_result)
                != {
                    "authority", "record_digest", "batch_id", "lease_generation",
                    "attempt", "candidate_base_digest", "submitted_snapshot_digest",
                }
                or not isinstance(protected_fencing_result.get("authority"), str)
                or not protected_fencing_result["authority"]
                or not isinstance(protected_fencing_result.get("batch_id"), str)
                or not protected_fencing_result["batch_id"]
                or any(
                    not isinstance(protected_fencing_result.get(field), str)
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}", protected_fencing_result[field])
                    for field in (
                        "record_digest",
                        "candidate_base_digest",
                        "submitted_snapshot_digest",
                    )
                )
                or any(
                    not isinstance(protected_fencing_result.get(field), int)
                    or isinstance(protected_fencing_result.get(field), bool)
                    or protected_fencing_result[field] < 1
                    for field in ("lease_generation", "attempt")
                )
            ):
                raise ValueError(
                    "protected migration fencing result must contain only valid "
                    "runtime fencing fields"
                )

        protected_completion_result = None
        if (
            contract.get("migration_profile") == "large_equivalence"
            and migration_role == "completion"
        ):
            if "migration_completion_result" not in captured_by_role:
                raise ValueError("protected migration completion result was not captured")
            protected_completion_result = captured_by_role["migration_completion_result"]["value"]
            if (
                not isinstance(protected_completion_result, dict)
                or protected_completion_result.get("disposition_digest")
                != canonical_digest(protected_completion_result.get("dispositions"))
                or set(protected_completion_result)
                != {
                    "expected", "accepted", "excluded", "blocked", "unresolved",
                    "unknown", "disposition_digest", "batch_attestations",
                    "impact_index_digest", "unresolved_impact_links",
                    "integration_snapshot_digest", "dispositions",
                }
                or any(
                    not isinstance(protected_completion_result.get(field), int)
                    or isinstance(protected_completion_result.get(field), bool)
                    or protected_completion_result[field] < 0
                    for field in (
                        "expected", "accepted", "excluded", "blocked", "unresolved",
                        "unknown", "unresolved_impact_links",
                    )
                )
                or any(
                    not isinstance(protected_completion_result.get(field), str)
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}", protected_completion_result[field])
                    for field in (
                        "disposition_digest",
                        "impact_index_digest",
                        "integration_snapshot_digest",
                    )
                )
                or not isinstance(protected_completion_result.get("batch_attestations"), list)
                or not protected_completion_result["batch_attestations"]
                or not isinstance(protected_completion_result.get("dispositions"), list)
                or not protected_completion_result["dispositions"]
                or any(
                    not isinstance(item, dict)
                    or set(item) != {"attestation_id", "digest"}
                    or not isinstance(item.get("attestation_id"), str)
                    or not item["attestation_id"]
                    or not isinstance(item.get("digest"), str)
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}", item["digest"])
                    for item in protected_completion_result["batch_attestations"]
                )
                or any(
                    not isinstance(item, dict)
                    or set(item) - {"unit_id", "status", "decision_ref", "decision_owner"}
                    or not isinstance(item.get("unit_id"), str)
                    or not item["unit_id"]
                    or item.get("status") not in {
                        "accepted",
                        "excluded",
                        "blocked",
                        "unresolved",
                        "unknown",
                    }
                    or (
                        item.get("status") == "excluded"
                        and (
                            not isinstance(item.get("decision_ref"), str)
                            or not item["decision_ref"]
                            or not isinstance(item.get("decision_owner"), str)
                            or not item["decision_owner"]
                        )
                    )
                    for item in protected_completion_result["dispositions"]
                )
            ):
                raise ValueError(
                    "protected migration completion result must contain only valid "
                    "reconciliation fields"
                )

        protected_cutover_result = None
        if contract.get("mode") == "equivalence" and (
            contract.get("migration_profile") != "large_equivalence"
            or migration_role in {"cutover", "release"}
        ):
            if "cutover_result" not in captured_by_role:
                raise ValueError(
                    "protected cutover result was not captured at producer step"
                )
            protected_cutover_result = captured_by_role["cutover_result"]["value"]
            cutover_path = _safe_workspace_path(
                snapshot_workspace, captured_by_role["cutover_result"]["path"]
            )
            _assert_captured_json_not_replaced(
                cutover_path,
                protected_cutover_result,
                "protected cutover result replaced after producer capture",
            )

        protected_release_result = None
        if any(
            item.get("role") == "release_result" for item in producer_captures.values()
        ):
            if "release_result" not in captured_by_role:
                raise ValueError(
                    "protected release result was not captured at producer step"
                )
            protected_release_result = captured_by_role["release_result"]["value"]
            release_path = _safe_workspace_path(
                snapshot_workspace, captured_by_role["release_result"]["path"]
            )
            _assert_captured_json_not_replaced(
                release_path,
                protected_release_result,
                "protected release result replaced after producer capture",
            )
        # Issuer-derived Critical matrix evidence (does not affect environment digest).
        platform_matrix_evidence: dict[str, str] = {}
        platform_results_plan = control_plane.get("platform_results")
        if isinstance(platform_results_plan, dict) and platform_results_plan:
            for platform, plan_spec in platform_results_plan.items():
                if not isinstance(plan_spec, dict):
                    continue
                command_id = plan_spec.get("command_id")
                role = f"platform_result:{platform}"
                if role not in captured_by_role:
                    raise ValueError(
                        f"protected platform result was not captured for: {platform}"
                    )
                captured_value = captured_by_role[role]["value"]
                if (
                    captured_value.get("platform") != platform
                    or captured_value.get("passed") is not True
                ):
                    raise ValueError(
                        f"protected platform result is missing or mismatched for: {platform}"
                    )
                if not isinstance(command_id, str) or not command_id:
                    raise ValueError(
                        f"platform_results[{platform}].command_id must be non-empty"
                    )
                platform_matrix_evidence[platform] = command_id
            environment_identity = copy.deepcopy(environment_identity)
            details = environment_identity.setdefault("details", {})
            if not isinstance(details, dict):
                raise ValueError("environment identity details must be an object")
            details["platform_matrix_evidence"] = platform_matrix_evidence




    attestation = copy.deepcopy(proposal)
    attestation["contract"] = {
        "revision": contract.get("revision", proposal.get("contract", {}).get("revision", "")),
        "fingerprint": contract_fingerprint(contract),
    }
    attestation["attestation_id"] = f"vdd_accept:{run_id}"
    candidate = attestation.setdefault("candidate", {})
    candidate["artifact_digests"] = candidate_digests
    candidate["revision"] = candidate_revision
    candidate["dirty"] = False
    attestation["commands"] = commands
    attestation["test_discovery"] = discovery
    attestation["forbidden_scope_diff"] = []
    attestation["environment"] = environment_identity
    if protected_inventory_result is not None:
        migration = attestation.get("migration")
        if not isinstance(migration, dict):
            raise ValueError("large_equivalence bootstrap proposal requires migration evidence")
        migration["source_inventory"] = copy.deepcopy(protected_inventory_result)
    if protected_fencing_result is not None:
        migration = attestation.get("migration")
        if not isinstance(migration, dict):
            raise ValueError("large_equivalence batch proposal requires migration evidence")
        batch = migration.get("batch")
        if not isinstance(batch, dict):
            raise ValueError("large_equivalence batch proposal requires batch evidence")
        batch["fencing"] = copy.deepcopy(protected_fencing_result)
        if protected_fencing_result.get("submitted_snapshot_digest") != candidate_revision:
            raise ValueError(
                "migration batch submitted_snapshot_digest differs from accepted candidate snapshot"
            )
        for field in ("id", "lease_generation", "attempt", "candidate_base_digest"):
            source_field = "batch_id" if field == "id" else field
            if batch.get(field) != protected_fencing_result.get(source_field):
                raise ValueError(
                    f"migration batch {field} differs from protected runtime fencing"
                )
    if protected_completion_result is not None:
        migration = attestation.get("migration")
        if not isinstance(migration, dict):
            raise ValueError("large_equivalence completion proposal requires migration evidence")
        if protected_completion_result.get("integration_snapshot_digest") != candidate_revision:
            raise ValueError(
                "migration completion integration_snapshot_digest differs from accepted candidate snapshot"
            )
        migration["completion"] = copy.deepcopy(protected_completion_result)

    if protected_metric_result is not None:
        mode_evidence = attestation.get("mode_evidence")
        if not isinstance(mode_evidence, dict):
            raise ValueError("improvement proposal requires mode_evidence")
        mode_evidence["metric_command"] = contract["control_plane"]["metric_result"][
            "command_id"
        ]
        mode_evidence["metric_result"] = protected_metric_result
    if protected_cutover_result is not None:
        mode_evidence = attestation.setdefault("mode_evidence", {})
        if not isinstance(mode_evidence, dict):
            raise ValueError("equivalence proposal requires mode_evidence")
        cutover_payload = copy.deepcopy(protected_cutover_result)
        cutover_payload["result_command"] = contract["control_plane"]["cutover_result"][
            "command_id"
        ]
        mode_evidence["cutover"] = cutover_payload
        merge = attestation.setdefault("merge", {})
        if not isinstance(merge, dict):
            raise ValueError("equivalence proposal requires merge evidence")
        merge["cutover_complete"] = bool(cutover_payload.get("cutover_complete"))
        merge["rollback_exercised"] = bool(cutover_payload.get("rollback_exercised"))
    if protected_release_result is not None:
        release_payload = copy.deepcopy(protected_release_result)
        attestation["release"] = {
            "canary_or_shadow": release_payload.get("canary_or_shadow"),
            "thresholds_passed": release_payload.get("thresholds_passed"),
            "rollback_trigger": release_payload.get("rollback_trigger"),
            "release_owner": release_payload.get("release_owner"),
            "result_command": contract["control_plane"]["release_result"]["command_id"],
        }

    if parent_reference is None:
        attestation.pop("parent_attestation", None)
    else:
        attestation["parent_attestation"] = parent_reference

    oracle_evidence = {
        item.get("id"): item
        for item in attestation.get("oracles", [])
        if isinstance(item, dict)
    }
    for oracle in contract.get("oracles", []):
        oracle_id = oracle.get("id")
        observed = oracle_evidence.get(oracle_id)
        if not isinstance(observed, dict):
            raise ValueError(f"proposal lacks oracle evidence {oracle_id}")
        observed["revision"] = oracle.get("revision")
        observed["fingerprint"] = oracle.get("fingerprint")
        qualification = oracle.get("qualification", {})
        if qualification.get("status") != "fresh":
            continue
        stability_ids = set(qualification.get("stability_command_ids", []))
        stability_runs = [
            command for command in commands if command.get("id") in stability_ids
        ]
        observed["no_change_trials"] = len(stability_runs)
        observed["flake_rate"] = (
            sum(command.get("result") != "pass" for command in stability_runs)
            / len(stability_runs)
            if stability_runs
            else 0.0
        )
        required_defeaters = {
            case.get("defeater_id")
            for case in qualification.get("known_bad_cases", [])
            if isinstance(case, dict)
        }
        observed_rejections = sorted(
            {
                defeater_id
                for command in commands
                if command.get("result") == "expected_reject"
                for defeater_id in command.get("defeater_ids", [])
                if defeater_id in required_defeaters
            }
        )
        observed["known_bad_rejections"] = observed_rejections
        qualification_basis = {
            key: value for key, value in qualification.items() if key != "status"
        }
        observed["qualification_contract_fingerprint"] = (
            qualification_contract_fingerprint(
                contract,
                oracle,
                qualification_basis=qualification_basis,
                covered_defeater_ids=sorted(required_defeaters),
            )
        )
        observed["qualified"] = (
            observed["no_change_trials"]
            >= qualification.get("required_no_change_trials", 0)
            and observed["flake_rate"] <= qualification.get("max_flake_rate", 0.0)
            and required_defeaters.issubset(set(observed_rejections))
        )

    for snapshot in qualification_snapshots:
        observed = oracle_evidence.get(snapshot["oracle_id"])
        if not isinstance(observed, dict):
            raise ValueError(f"proposal lacks reused oracle {snapshot['oracle_id']}")
        observed["qualified"] = True
        observed["qualification_attestation_id"] = snapshot["attestation_id"]
        observed["qualification_attestation_digest"] = snapshot["digest"]
        observed["qualification_contract_fingerprint"] = snapshot[
            "qualification_contract_fingerprint"
        ]
        observed["known_bad_rejections"] = snapshot["covered_defeater_ids"]
        observed["no_change_trials"] = snapshot["no_change_trials"]
        observed["flake_rate"] = snapshot["flake_rate"]

    roles = contract.get("roles")
    if not isinstance(roles, dict):
        raise ValueError("contract.roles is required")
    attestation["issued_by"] = {
        "identity": roles.get("acceptor"),
        "role": "acceptor",
        "independent_from_candidate": True,
    }
    attestation["issued_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    attestation["control_plane"] = {
        "issuer": "vdd_accept",
        "run_id": run_id,
        "protected_snapshot_before": protected_snapshot_before,
        "protected_snapshot_after": final_protected_snapshot,
        "candidate_snapshot_before": candidate_snapshot_before,
        "candidate_snapshot_after": candidate_snapshot_after,
        "discovery_digest": discovery_digest,
        "qualification_snapshots": [
            {
                "attestation_id": item["attestation_id"],
                "digest": item["digest"],
            }
            for item in qualification_snapshots
        ],
        "parent_snapshot": (
            None
            if parent_reference is None
            else {
                "attestation_id": parent_reference["attestation_id"],
                "digest": parent_reference["digest"],
            }
        ),
        "migration_parent_snapshots": [
            {"attestation_id": item["attestation_id"], "digest": item["digest"]}
            for item in migration_parent_references
        ],
        "output_directory": (
            None
            if attested_retained_output_directory is None
            else str(attested_retained_output_directory)
        ),
        "source_provenance": source_provenance,
        "attestation_digest": "",
        "signature": "pending",
    }

    if source_provenance is not None:
        final_provenance = _capture_source_provenance(contract, provenance_workspace)
        final_source_provenance = _bind_source_candidate_artifacts(
            final_provenance,
            source_workspace=provenance_workspace,
            candidate_snapshot=candidate_snapshot_before,
        )
        final_real_upstream_artifacts = _bind_real_upstream_artifacts(
            contract,
            final_provenance,
            source_workspace=provenance_workspace,
        )
        if final_source_provenance is not None and final_real_upstream_artifacts is not None:
            final_source_provenance["real_upstream_artifacts"] = final_real_upstream_artifacts
        if final_source_provenance != source_provenance:
            raise ValueError("source provenance changed during acceptance")

    result = validate_evidence(attestation, contract)
    if result.errors:
        raise ValueError("attestation validation failed: " + "; ".join(result.errors))
    attestation["control_plane"]["attestation_digest"] = attestation_digest(attestation)
    _validate_schema(attestation, EVIDENCE_VALIDATOR, "evidence")
    attestation["control_plane"]["signature"] = sign_attestation(attestation, signing_key)
    return attestation


def issue_attestation(
    contract: dict[str, Any],
    proposal: dict[str, Any],
    *,
    workspace: Path,
    signing_key: bytes,
    run_id: str,
    parent_attestation: dict[str, Any] | None = None,
    parent_attestations: list[dict[str, Any]] | None = None,
    qualification_attestations: list[dict[str, Any]] | None = None,
    output_directory: Path | None = None,
    source_workspace: Path | _PinnedWorkspace | None = None,
) -> dict[str, Any]:
    """Issue an attestation and atomically publish optional retained outputs."""
    if output_directory is None:
        return _issue_attestation(
            contract,
            proposal,
            workspace=workspace,
            signing_key=signing_key,
            run_id=run_id,
            parent_attestation=parent_attestation,
            parent_attestations=parent_attestations,
            qualification_attestations=qualification_attestations,
            source_workspace=source_workspace,
        )

    final_directory = Path(os.path.abspath(output_directory))
    workspace_path = Path(os.path.abspath(workspace)).resolve()
    source_workspace_path = (
        None
        if source_workspace is None
        else Path(os.path.abspath(_workspace_path(source_workspace))).resolve()
    )
    if _path_under(final_directory, workspace_path) or _path_under(
        workspace_path, final_directory
    ):
        raise ValueError("output directory overlaps workspace")
    if source_workspace_path is not None and (
        _path_under(final_directory, source_workspace_path)
        or _path_under(source_workspace_path, final_directory)
    ):
        raise ValueError("output directory overlaps source workspace")

    with _RetainedOutputPublication(final_directory) as publication:
        attestation = _issue_attestation(
            contract,
            proposal,
            workspace=workspace,
            signing_key=signing_key,
            run_id=run_id,
            parent_attestation=parent_attestation,
            parent_attestations=parent_attestations,
            qualification_attestations=qualification_attestations,
            output_directory=publication.staging_directory,
            source_workspace=source_workspace,
            attested_output_directory=final_directory,
        )
        publication.publish()
        return attestation


def verify_attestation_bundle(
    attestation: dict[str, Any],
    contract: dict[str, Any],
    signing_key: bytes,
    *,
    parent_attestation: dict[str, Any] | None = None,
    parent_attestations: list[dict[str, Any]] | None = None,
    qualification_attestations: list[dict[str, Any]] | None = None,
    verification_time: datetime | None = None,
    source_workspace: Path | None = None,
    output_directory: Path | None = None,
) -> None:
    if source_workspace is not None and not isinstance(source_workspace, _PinnedWorkspace):
        with _PinnedWorkspace(source_workspace) as pinned_workspace:
            return verify_attestation_bundle(
                attestation,
                contract,
                signing_key,
                parent_attestation=parent_attestation,
                parent_attestations=parent_attestations,
                qualification_attestations=qualification_attestations,
                verification_time=verification_time,
                source_workspace=pinned_workspace,
                output_directory=output_directory,
            )
    as_of = verification_time or datetime.now(timezone.utc)
    if as_of.tzinfo is None:
        raise ValueError("verification_time must include a timezone")
    _validate_schema(contract, CONTRACT_VALIDATOR, "contract")
    if not verify_attestation_signature(attestation, signing_key):
        raise ValueError("attestation signature or canonical digest is invalid")
    _validate_schema(attestation, EVIDENCE_VALIDATOR, "evidence")
    source_workspace_path = (
        None if source_workspace is None else _workspace_path(source_workspace)
    )
    provenance = _capture_source_provenance(contract, source_workspace)
    control_plane = attestation.get("control_plane")
    if not isinstance(control_plane, dict):
        raise ValueError("attestation.control_plane is required")
    observed_provenance = control_plane.get("source_provenance")
    if provenance is None:
        if observed_provenance is not None:
            raise ValueError("attestation source provenance differs from contract")
    else:
        if not isinstance(observed_provenance, dict) or observed_provenance.get("repository") != provenance["repository"] or observed_provenance.get("revision") != provenance["revision"] or observed_provenance.get("clean") != provenance["clean"]:
            raise ValueError("attestation source provenance differs from contract")
        artifacts = observed_provenance.get("candidate_artifacts")
        if not isinstance(artifacts, list):
            raise ValueError("attestation source provenance lacks candidate artifacts")
        candidate_snapshot = control_plane.get("candidate_snapshot_before")
        if not isinstance(candidate_snapshot, list):
            raise ValueError("attestation source provenance lacks candidate snapshot")
        expected_source_provenance = _bind_source_candidate_artifacts(
            provenance,
            source_workspace=source_workspace,
            candidate_snapshot=candidate_snapshot,
        )
        expected_real_upstream_artifacts = _bind_real_upstream_artifacts(
            contract,
            provenance,
            source_workspace=source_workspace,
        )
        if expected_source_provenance is not None and expected_real_upstream_artifacts is not None:
            expected_source_provenance["real_upstream_artifacts"] = expected_real_upstream_artifacts
        if observed_provenance != expected_source_provenance:
            raise ValueError("source provenance differs for candidate artifact")
    attested_output_directory = control_plane.get("output_directory")
    has_output_capture = any(
        isinstance(command, dict) and isinstance(command.get("output_capture"), dict)
        for command in attestation.get("commands", [])
    )
    if attested_output_directory is None and has_output_capture:
        raise ValueError("attestation command output capture requires output_directory")
    if attested_output_directory is not None:
        if not isinstance(attested_output_directory, str) or not attested_output_directory:
            raise ValueError("attestation output_directory must be an absolute non-empty path")
        if output_directory is None:
            raise ValueError("attestation verification requires output_directory")
        root = Path(os.path.abspath(output_directory))
        if not root.is_dir():
            raise ValueError("verification output directory is unavailable")
        if root != Path(attested_output_directory):
            raise ValueError("verification output directory differs from attestation")
        root_fd = _open_directory_nofollow(root)
        os.close(root_fd)
        for command in attestation.get("commands", []):
            if not isinstance(command, dict):
                continue
            capture = command.get("output_capture")
            if not isinstance(capture, dict):
                raise ValueError(
                    f"attestation command output capture is missing: {command.get('id')}"
                )
            for name in ("stdout", "stderr", "isolation"):
                item = capture.get(name)
                if not isinstance(item, dict):
                    raise ValueError(
                        f"attestation command output capture is missing {name}: {command.get('id')}"
                    )
                relative = item.get("path")
                if not isinstance(relative, str):
                    raise ValueError(
                        f"attestation command output path is invalid: {command.get('id')}"
                    )
                try:
                    byte_length, digest, fingerprint = _read_retained_regular_file(
                        root,
                        relative,
                        max_bytes=(
                            ISOLATION_POLICY_LIMIT_BYTES
                            if name == "isolation"
                            else ACCEPTANCE_OUTPUT_LIMIT_BYTES
                        ),
                    )
                except (OSError, ValueError) as exc:
                    raise ValueError(
                        f"attestation command output differs: {command.get('id')} {name}"
                    ) from exc
                if not hmac.compare_digest(fingerprint, item.get("fingerprint", "")):
                    raise ValueError(
                        f"attestation command output differs: {command.get('id')} {name}"
                    )
                if name == "isolation":
                    continue
                expected_length = item.get("byte_length")
                if not isinstance(expected_length, int) or byte_length != expected_length:
                    raise ValueError(
                        f"attestation command output length differs: {command.get('id')} {name}"
                    )
                expected_digest = item.get("digest")
                if not isinstance(expected_digest, str) or not hmac.compare_digest(
                    expected_digest, digest
                ):
                    raise ValueError(
                        f"attestation command output digest differs: {command.get('id')} {name}"
                    )
    result = validate_evidence(attestation, contract)
    if result.errors:
        raise ValueError("attestation validation failed: " + "; ".join(result.errors))
    _require_unexpired_residuals(attestation, as_of)
    migration_parent_references, _ = _authenticate_migration_parents(
        contract,
        attestation,
        parent_attestations or [],
        signing_key,
        as_of,
    )
    parent_reference, _ = _authenticate_parent(
        contract,
        attestation,
        parent_attestation,
        signing_key,
        as_of,
    )
    if migration_parent_references and parent_attestation is not None:
        raise ValueError("migration verification uses migration parents, not legacy parent_attestation")
    qualification_snapshots = _authenticate_reused_qualifications(
        contract,
        qualification_attestations or [],
        signing_key,
        as_of,
    )
    control_plane = attestation.get("control_plane")
    if not isinstance(control_plane, dict):
        raise ValueError("attestation.control_plane is required")
    expected_parent = (
        None
        if parent_reference is None
        else {
            "attestation_id": parent_reference["attestation_id"],
            "digest": parent_reference["digest"],
        }
    )
    if control_plane.get("parent_snapshot") != expected_parent:
        raise ValueError("authenticated parent snapshot differs from attestation")
    expected_migration_parents = sorted(
        (
            {"attestation_id": item["attestation_id"], "digest": item["digest"]}
            for item in migration_parent_references
        ),
        key=lambda item: item["attestation_id"],
    )
    observed_migration_parents = control_plane.get("migration_parent_snapshots", [])
    if not isinstance(observed_migration_parents, list) or sorted(
        observed_migration_parents, key=lambda item: item.get("attestation_id", "")
    ) != expected_migration_parents:
        raise ValueError("authenticated migration parent snapshots differ from attestation")
    expected_qualifications = sorted(
        (
            {
                "attestation_id": item["attestation_id"],
                "digest": item["digest"],
            }
            for item in qualification_snapshots
        ),
        key=lambda item: item["attestation_id"],
    )
    observed_qualifications = control_plane.get("qualification_snapshots")
    if not isinstance(observed_qualifications, list) or sorted(
        observed_qualifications, key=lambda item: item.get("attestation_id", "")
    ) != expected_qualifications:
        raise ValueError("authenticated qualification snapshots differ from attestation")




def _benign_root_symlinks() -> dict[Path, Path]:
    return {
        Path("/tmp"): Path("/private/tmp"),
        Path("/var"): Path("/private/var"),
        Path("/etc"): Path("/private/etc"),
    }


def _collapse_leading_system_symlinks(path: Path) -> tuple[Path, list[str]]:
    """Collapse pure leading system aliases; return base path + remaining components."""
    absolute = Path(os.path.abspath(str(path)))
    parts = absolute.parts
    if not parts:
        raise ValueError(f"refusing empty path: {path}")
    benign = _benign_root_symlinks()
    accumulated = Path(parts[0])
    index = 1
    while index < len(parts):
        candidate = accumulated / parts[index]
        try:
            status = os.lstat(candidate)
        except FileNotFoundError:
            break
        if stat.S_ISLNK(status.st_mode):
            target = Path(os.path.realpath(candidate))
            if candidate in benign and target == benign[candidate]:
                accumulated = target
                index += 1
                continue
            raise ValueError(f"refusing to write through symlink ancestor: {path}")
        break
    return accumulated, list(parts[index:])


def _open_directory_nofollow(path: Path, *, create_missing: bool = False) -> int:
    """Open a directory by walking every component with O_NOFOLLOW/O_DIRECTORY.

    Collapses leading system aliases (/tmp→/private/tmp), then openat-walks every
    later component so a concurrent intermediate symlink swap cannot be followed.
    """
    base, remaining = _collapse_leading_system_symlinks(path)
    flags = os.O_RDONLY
    directory_flag = getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    cloexec = getattr(os, "O_CLOEXEC", 0)
    flags |= directory_flag | cloexec
    start_parts = base.parts
    if not start_parts:
        raise ValueError(f"refusing empty directory path: {path}")
    dir_fd = os.open(start_parts[0], flags)
    try:
        for component in list(start_parts[1:]) + remaining:
            if component in ("", "."):
                continue
            if component == "..":
                raise ValueError(f"refusing unsafe path component: {path}")
            try:
                next_fd = os.open(component, flags | no_follow, dir_fd=dir_fd)
            except FileNotFoundError as exc:
                if not create_missing:
                    raise ValueError(
                        f"refusing to write through missing ancestor: {path}"
                    ) from exc
                try:
                    os.mkdir(component, 0o755, dir_fd=dir_fd)
                except FileExistsError:
                    pass
                except OSError as mkdir_exc:
                    raise ValueError(
                        f"refusing to write through non-directory ancestor: {path}"
                    ) from mkdir_exc
                try:
                    next_fd = os.open(component, flags | no_follow, dir_fd=dir_fd)
                except OSError as open_exc:
                    if getattr(open_exc, "errno", None) in {
                        getattr(errno, "ELOOP", None),
                        getattr(errno, "ENOTDIR", None),
                        getattr(errno, "EPERM", None),
                    }:
                        raise ValueError(
                            f"refusing to write through symlink ancestor: {path}"
                        ) from open_exc
                    raise ValueError(
                        f"refusing to write through non-directory ancestor: {path}"
                    ) from open_exc
            except OSError as exc:
                if getattr(exc, "errno", None) in {
                    getattr(errno, "ELOOP", None),
                    getattr(errno, "ENOTDIR", None),
                    getattr(errno, "EPERM", None),
                }:
                    raise ValueError(
                        f"refusing to write through symlink ancestor: {path}"
                    ) from exc
                raise ValueError(
                    f"refusing to write through non-directory ancestor: {path}"
                ) from exc
            os.close(dir_fd)
            dir_fd = next_fd
    except Exception:
        try:
            os.close(dir_fd)
        except OSError:
            pass
        raise
    return dir_fd


def _write_json(path: Path, value: dict[str, Any]) -> None:
    """Atomically write JSON without following symlink ancestors.

    Opens the parent via component-by-component openat(O_NOFOLLOW|O_DIRECTORY),
    creates same-directory temp with O_NOFOLLOW, fsyncs, then os.replace on dirfds.
    """
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    encoded = payload.encode("utf-8")
    abs_destination = Path(os.path.abspath(str(path)))
    if abs_destination.name in {"", ".", ".."} or abs_destination == abs_destination.parent:
        raise ValueError(f"refusing to write to non-file path: {path}")

    dir_fd = _open_directory_nofollow(abs_destination.parent, create_missing=True)
    tmp_name: str | None = None
    tmp_fd: int | None = None
    try:
        final_name = abs_destination.name
        try:
            status = os.lstat(final_name, dir_fd=dir_fd)
        except FileNotFoundError:
            status = None
        if status is not None and (
            stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode)
        ):
            raise ValueError(f"refusing to write through non-regular path: {path}")

        tmp_name = f".{final_name}.{os.getpid()}.{time.time_ns()}.tmp"
        create_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            create_flags |= os.O_NOFOLLOW
        if hasattr(os, "O_CLOEXEC"):
            create_flags |= os.O_CLOEXEC
        tmp_fd = os.open(tmp_name, create_flags, 0o600, dir_fd=dir_fd)
        try:
            with os.fdopen(tmp_fd, "wb") as handle:
                tmp_fd = None
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, final_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            tmp_name = None
            try:
                os.fsync(dir_fd)
            except OSError:
                pass
        except Exception:
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name, dir_fd=dir_fd)
                except OSError:
                    pass
            raise
    finally:
        try:
            os.close(dir_fd)
        except OSError:
            pass




def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Issue or verify VDD acceptance attestations")
    subparsers = parser.add_subparsers(dest="command", required=True)

    issue = subparsers.add_parser("issue", help="execute the protected plan and issue an attestation")
    issue.add_argument("--contract", type=Path, required=True)
    issue.add_argument("--proposal", type=Path, required=True)
    issue.add_argument("--workspace", type=Path, required=True)
    issue.add_argument("--key-file", type=Path, required=True)
    issue.add_argument("--run-id", required=True)
    issue.add_argument(
        "--output-directory",
        type=Path,
        help="Control-plane-owned directory for retained bounded step outputs and sandbox policies",
    )
    issue.add_argument(
        "--source-workspace",
        type=Path,
        help="Pinned source checkout required by contract.source_provenance",
    )
    issue.add_argument("--parent-attestation", type=Path)
    issue.add_argument("--migration-parent-attestation", type=Path, action="append", default=[])
    issue.add_argument("--qualification-attestation", type=Path, action="append", default=[])
    issue.add_argument("--output", type=Path, required=True)

    verify = subparsers.add_parser("verify", help="verify an attestation signature and contract binding")
    verify.add_argument("--contract", type=Path, required=True)
    verify.add_argument("--attestation", type=Path, required=True)
    verify.add_argument("--key-file", type=Path, required=True)
    verify.add_argument(
        "--source-workspace",
        type=Path,
        help="Pinned source checkout required by contract.source_provenance",
    )
    verify.add_argument(
        "--output-directory",
        type=Path,
        help="Verifier-owned retained-output directory required when the attestation captures command outputs",
    )
    verify.add_argument("--parent-attestation", type=Path)
    verify.add_argument("--migration-parent-attestation", type=Path, action="append", default=[])
    verify.add_argument("--qualification-attestation", type=Path, action="append", default=[])
    verify.add_argument("--as-of")
    return parser


def _load_control_plane_json(path: Path) -> dict[str, Any]:
    value, _, _ = _load_regular_json(
        path,
        max_bytes=CONTROL_PLANE_INPUT_LIMIT_BYTES,
    )
    return value


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        contract = _load_control_plane_json(args.contract)
        signing_key, _ = _read_regular_file_bytes(
            args.key_file,
            max_bytes=SIGNING_KEY_LIMIT_BYTES,
        )
        if args.command == "issue":
            if args.source_workspace is not None and _path_under(
                args.output, args.source_workspace
            ):
                raise ValueError("attestation output overlaps source workspace")
            proposal = _load_control_plane_json(args.proposal)
            parent = (
                _load_control_plane_json(args.parent_attestation)
                if args.parent_attestation
                else None
            )
            migration_parents = [
                _load_control_plane_json(path)
                for path in args.migration_parent_attestation
            ]
            qualifications = [
                _load_control_plane_json(path)
                for path in args.qualification_attestation
            ]
            attestation = issue_attestation(
                contract,
                proposal,
                workspace=args.workspace,
                signing_key=signing_key,
                run_id=args.run_id,
                parent_attestation=parent,
                parent_attestations=migration_parents,
                qualification_attestations=qualifications,
                output_directory=args.output_directory,
                source_workspace=args.source_workspace,
            )
            _write_json(args.output, attestation)
            print(f"ISSUED {args.output}")
            return 0

        attestation = _load_control_plane_json(args.attestation)
        parent = (
            _load_control_plane_json(args.parent_attestation)
            if args.parent_attestation
            else None
        )
        migration_parents = [
            _load_control_plane_json(path)
            for path in args.migration_parent_attestation
        ]
        qualifications = [
            _load_control_plane_json(path)
            for path in args.qualification_attestation
        ]
        verify_attestation_bundle(
            attestation,
            contract,
            signing_key,
            parent_attestation=parent,
            parent_attestations=migration_parents,
            qualification_attestations=qualifications,
            source_workspace=args.source_workspace,
            output_directory=args.output_directory,
            verification_time=(
                _parse_timestamp(args.as_of, "--as-of")
                if args.as_of
                else None
            ),
        )
        print(f"VERIFIED {args.attestation}")
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
