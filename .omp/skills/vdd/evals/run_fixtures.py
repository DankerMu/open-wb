#!/usr/bin/env python3
"""Execute protected behavioral oracles for VDD conformance fixtures.

The candidate workspace is writable. Oracle tests and qualification mutants are
always loaded from this package, outside that workspace. A candidate is accepted
only when every declared mutant is semantically rejected and the candidate then
passes the same protected oracle.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

if __package__:
    from .candidate_proxy import WORKER_TIMEOUT_SECONDS
else:
    from candidate_proxy import WORKER_TIMEOUT_SECONDS


ROOT = Path(__file__).resolve().parent
FILES = ROOT / "files"
PROXY = ROOT / "candidate_proxy.py"
WORKER = ROOT / "candidate_worker.py"
EXECUTOR = ROOT / "candidate_executor.py"
# Each protected candidate call has its own bounded worker budget. An outer
# fixture invocation must cover its declared serial request batches plus one
# worker budget for test-process startup and cleanup. Concurrent calls are one
# wall-clock batch.
TEST_PROCESS_OVERHEAD_BATCHES = 1
FIXTURE_CLEANUP_GRACE_SECONDS = 1


@dataclass(frozen=True)
class Mutant:
    name: str
    relative_path: str
    selector: str
    request_batches: int


@dataclass(frozen=True)
class Case:
    fixture: str
    candidate_path: str
    test_path: str
    mutants: tuple[Mutant, ...]
    test_count: int
    request_batches: int


CASES: dict[int, Case] = {
    5: Case(
        fixture="webhook",
        candidate_path="candidate.py",
        test_path="tests/test_webhook.py",
        mutants=(
            Mutant("accept-invalid-signature", "mutant_invalid_signature.py", "invalid_signature", 1),
            Mutant("accept-stale-timestamp", "mutant_stale.py", "stale_timestamp", 1),
            Mutant("non-idempotent-retry", "mutant_duplicate.py", "retries_are_idempotent", 2),
            Mutant("broken-concurrent-idempotency", "mutant_concurrency.py", "concurrent_retries", 1),
            Mutant("false-persistence-success", "mutant_persistence.py", "persistence_failure", 1),
        ),
        test_count=7,
        request_batches=8,
    ),
    6: Case(
        fixture="slugify",
        candidate_path="candidate.py",
        test_path="tests/test_slugify.py",
        mutants=(
            Mutant("non-collapsing-separators", "mutant_non_collapsing.py", "collapses_each_separator_run", 1),
        ),
        test_count=5,
        request_batches=5,
    ),
    7: Case(
        fixture="judge-tampering",
        candidate_path="app.py",
        test_path="tests/test_app.py",
        mutants=(
            Mutant("lowercase-local-part", "app.py", "local_part_is_preserved", 1),
        ),
        test_count=2,
        request_batches=2,
    ),
    10: Case(
        fixture="legacy-bug",
        candidate_path="candidate.py",
        test_path="tests/test_discount.py",
        mutants=(
            Mutant("copy-legacy-boundary-bug", "candidate.py", "contract_boundary", 1),
        ),
        test_count=3,
        request_batches=3,
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _test_timeout_seconds(request_batches: int) -> int:
    """Return a finite outer test budget compatible with protected call limits."""
    if (
        isinstance(request_batches, bool)
        or not isinstance(request_batches, int)
        or request_batches < 1
    ):
        raise ValueError("fixture request batches must be a positive integer")
    return WORKER_TIMEOUT_SECONDS * (request_batches + TEST_PROCESS_OVERHEAD_BATCHES)


def _decode_process_output(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def _drain_available_stdout(process: subprocess.Popen[str]) -> str:
    """Drain bytes already buffered without waiting for inherited writer FDs."""
    stdout = getattr(process, "stdout", None)
    if stdout is None or stdout.closed:
        return ""
    chunks: list[bytes] = []
    try:
        fd = stdout.fileno()
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        while True:
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                break
            if not chunk:
                break
            chunks.append(chunk)
    except (OSError, ValueError):
        pass
    finally:
        stdout.close()
    return b"".join(chunks).decode("utf-8", errors="replace")


def _close_process_streams(process: subprocess.Popen[str]) -> None:
    for name in ("stdin", "stdout", "stderr"):
        stream = getattr(process, name, None)
        if stream is not None and not getattr(stream, "closed", False):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def _terminate_fixture_group(
    process: subprocess.Popen[str],
) -> None:
    """Stop the unreaped new-session fixture root and its ordinary descendants."""
    pid = getattr(process, "pid", None)
    if pid is None or getattr(process, "returncode", None) is not None:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        if getattr(process, "returncode", None) is None:
            try:
                process.kill()
            except (ProcessLookupError, OSError):
                pass
    if getattr(process, "returncode", None) is None:
        try:
            process.wait(timeout=FIXTURE_CLEANUP_GRACE_SECONDS)
        except (subprocess.TimeoutExpired, OSError):
            pass


def _run_test(
    test_path: Path,
    candidate_path: Path,
    selector: str | None,
    expected_count: int,
    request_batches: int,
) -> dict:
    command = [sys.executable, str(test_path), "-v"]
    if selector:
        command.extend(["-k", selector])
    environment = {
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(ROOT),
        "VDD_CANDIDATE_PATH": str(candidate_path),
    }
    process = subprocess.Popen(
        command,
        cwd=candidate_path.parent,
        env=environment,
        text=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        close_fds=True,
        start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=_test_timeout_seconds(request_batches))
    except subprocess.TimeoutExpired as exc:
        _terminate_fixture_group(process)
        output = _decode_process_output(exc.stdout)
        output += _drain_available_stdout(process)
        return {
            "command": command,
            "candidate": str(candidate_path),
            "selector": selector,
            "exit_code": None,
            "passed": False,
            "expected_count": expected_count,
            "observed_count": None,
            "semantic_rejection": False,
            "timed_out": True,
            "output": output,
        }
    except BaseException:
        _terminate_fixture_group(process)
        _close_process_streams(process)
        raise
    if process.returncode is None:
        _terminate_fixture_group(process)
        _close_process_streams(process)
        raise RuntimeError("fixture test process did not exit after response")
    count_match = re.search(r"Ran (\d+) tests? in ", output)
    observed_count = int(count_match.group(1)) if count_match else None
    semantic_rejection = (
        process.returncode != 0
        and observed_count == expected_count
        and "FAIL:" in output
        and "ERROR:" not in output
        and "FAILED (failures=" in output
    )
    passed = (
        process.returncode == 0
        and observed_count == expected_count
        and re.search(r"^OK$", output, re.MULTILINE) is not None
    )
    return {
        "command": command,
        "candidate": str(candidate_path),
        "selector": selector,
        "exit_code": process.returncode,
        "passed": passed,
        "expected_count": expected_count,
        "observed_count": observed_count,
        "semantic_rejection": semantic_rejection,
        "output": output,
    }


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def run_case(case_id: int, workspace: Path) -> dict:
    if case_id not in CASES:
        raise ValueError(f"case {case_id} has no executable fixture runner")
    case = CASES[case_id]
    fixture_root = (FILES / case.fixture).resolve()
    test_path = (fixture_root / case.test_path).resolve()
    workspace = workspace.resolve()
    if not workspace.is_dir():
        raise ValueError(f"workspace is not a directory: {workspace}")
    if _within(workspace, fixture_root) or _within(fixture_root, workspace):
        raise ValueError("candidate workspace must be disjoint from protected fixture assets")
    candidate_path = (workspace / case.candidate_path).resolve()
    if not _within(candidate_path, workspace):
        raise ValueError("candidate path escapes workspace")
    if not candidate_path.is_file():
        raise ValueError(f"candidate file is missing: {candidate_path}")
    if not test_path.is_file() or not _within(test_path, fixture_root):
        raise ValueError(f"protected oracle is missing: {test_path}")
    protected_paths = [test_path, PROXY, WORKER, EXECUTOR]
    mutant_paths: list[tuple[Mutant, Path]] = []
    for mutant in case.mutants:
        mutant_path = (fixture_root / mutant.relative_path).resolve()
        if not mutant_path.is_file() or not _within(mutant_path, fixture_root):
            raise ValueError(f"qualification mutant is missing: {mutant_path}")
        mutant_paths.append((mutant, mutant_path))
        protected_paths.append(mutant_path)
    for harness_path in [PROXY, WORKER, EXECUTOR]:
        if not harness_path.is_file() or not _within(harness_path, ROOT):
            raise ValueError(f"protected harness is missing: {harness_path}")
    protected_before = {
        str(path): sha256_file(path)
        for path in protected_paths
    }
    candidate_before = sha256_file(candidate_path)

    qualification_runs = []
    for mutant, mutant_path in mutant_paths:
        run = _run_test(
            test_path,
            mutant_path,
            mutant.selector,
            1,
            mutant.request_batches,
        )
        run["name"] = mutant.name
        qualification_runs.append(run)

    verifier_qualified = all(run["semantic_rejection"] for run in qualification_runs)
    candidate_run = _run_test(
        test_path,
        candidate_path,
        None,
        case.test_count,
        case.request_batches,
    )
    accepted = verifier_qualified and candidate_run["passed"]
    candidate_after = sha256_file(candidate_path)
    if candidate_after != candidate_before:
        raise ValueError("candidate artifact changed during evaluation")
    protected_after = {
        str(path): sha256_file(path)
        for path in protected_paths
    }
    if protected_after != protected_before:
        raise ValueError("protected Oracle or harness changed during evaluation")
    return {
        "schema_version": "vdd-eval-0.2",
        "case_id": case_id,
        "fixture": case.fixture,
        "workspace": str(workspace),
        "protected_oracle": {
            "path": str(test_path),
            "fingerprint": sha256_file(test_path),
        },
        "protected_assets": [
            {"path": path, "fingerprint": fingerprint}
            for path, fingerprint in sorted(protected_after.items())
        ],
        "qualification": {
            "status": "qualified" if verifier_qualified else "invalid",
            "runs": qualification_runs,
        },
        "candidate": {
            "path": str(candidate_path),
            "fingerprint": candidate_after,
            "run": candidate_run,
        },
        "disposition": "accepted" if accepted else "rejected",
    }


def _lexists(path: Path) -> bool:
    """Return whether a path entry exists without following a dangling symlink."""
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _directory_without_intermediate_symlinks(path: Path) -> Path:
    """Return a real directory path, rejecting intermediate (non-leading) symlinks.

    Leading system symlink prefixes such as ``/tmp`` -> ``/private/tmp`` or
    ``/var`` -> ``/private/var`` are collapsed. Once a non-symlink component is
    observed, every later ancestor must be a real directory.
    """
    absolute = Path(os.path.abspath(path))
    parts = absolute.parts
    if not parts:
        raise ValueError(f"output parent directory is missing: {path}")
    # Phase 1: collapse a pure leading symlink prefix (platform mount aliases).
    accumulated = Path(parts[0])
    index = 1
    while index < len(parts):
        candidate = accumulated / parts[index]
        if _lexists(candidate) and candidate.is_symlink():
            accumulated = Path(os.path.realpath(candidate))
            index += 1
            continue
        break
    # Phase 2: remaining components must be real directories (no symlinks).
    while index < len(parts):
        accumulated = accumulated / parts[index]
        if _lexists(accumulated) and accumulated.is_symlink():
            raise ValueError(f"refuses unsafe output ancestor symlink: {accumulated}")
        if not _lexists(accumulated):
            raise ValueError(f"output parent directory is missing: {path}")
        if not accumulated.is_dir() or accumulated.is_symlink():
            raise ValueError(f"output parent is not a directory: {accumulated}")
        index += 1
    if not _lexists(accumulated):
        raise ValueError(f"output parent directory is missing: {path}")
    if accumulated.is_symlink() or not accumulated.is_dir():
        raise ValueError(f"output parent is not a directory: {accumulated}")
    return accumulated


def _open_directory_nofollow(path: Path) -> int:
    """Open a directory by walking every component with O_NOFOLLOW/O_DIRECTORY.

    Rejects intermediate ancestor symlinks after collapsing leading system aliases.
    """
    absolute = _directory_without_intermediate_symlinks(path)
    parts = absolute.parts
    flags = os.O_RDONLY
    directory_flag = getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    cloexec = getattr(os, "O_CLOEXEC", 0)
    flags |= directory_flag | cloexec
    dir_fd = os.open(parts[0], flags)
    try:
        for component in parts[1:]:
            if component in ("", "."):
                continue
            if component == "..":
                raise ValueError(f"refuses unsafe output path component: {absolute}")
            next_fd = os.open(
                component,
                flags | no_follow,
                dir_fd=dir_fd,
            )
            os.close(dir_fd)
            dir_fd = next_fd
    except FileNotFoundError as exc:
        try:
            os.close(dir_fd)
        except OSError:
            pass
        raise ValueError(f"output parent directory is missing: {path}") from exc
    except OSError as exc:
        try:
            os.close(dir_fd)
        except OSError:
            pass
        # O_NOFOLLOW on a symlink yields ELOOP or ENOTDIR depending on platform.
        if getattr(exc, "errno", None) in {
            getattr(errno, "ELOOP", None),
            getattr(errno, "ENOTDIR", None),
            getattr(errno, "EPERM", None),
        }:
            raise ValueError(f"refuses unsafe output ancestor symlink: {path}") from exc
        raise ValueError(f"refuses unsafe output parent path: {path}") from exc
    return dir_fd


def _reject_unsafe_output_path(output: Path) -> Path:
    """Reject symlink outputs and require a verifier-owned regular destination."""
    absolute = Path(os.path.abspath(output))
    if _lexists(absolute) and absolute.is_symlink():
        raise ValueError(f"refuses to write through output symlink: {absolute}")
    parent = _directory_without_intermediate_symlinks(absolute.parent)
    dir_fd = _open_directory_nofollow(parent)
    try:
        status = os.fstat(dir_fd)
        if not stat.S_ISDIR(status.st_mode):
            raise ValueError(f"output parent is not a directory: {parent}")
    finally:
        os.close(dir_fd)
    # Write under the verified real parent; keep the caller's basename only.
    return parent / absolute.name



def _write_output_atomically(output: Path, text: str) -> None:
    """Create output atomically via same-directory temp + replace on a dirfd."""
    destination = _reject_unsafe_output_path(output)
    parent = destination.parent
    name = destination.name
    if not name or name in {".", ".."}:
        raise ValueError(f"refuses unsafe output basename: {destination}")
    dir_fd = _open_directory_nofollow(parent)
    temporary_name = f".{name}.{os.getpid()}.{time.time_ns()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    cloexec = getattr(os, "O_CLOEXEC", 0)
    if no_follow:
        flags |= no_follow
    if cloexec:
        flags |= cloexec
    temporary_fd = None
    try:
        temporary_fd = os.open(temporary_name, flags, 0o600, dir_fd=dir_fd)
        with os.fdopen(temporary_fd, "w", encoding="utf-8") as handle:
            temporary_fd = None  # ownership transferred
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # Type-check the final name without opening it (FIFO open would hang).
        try:
            status = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            status = None
        except OSError as exc:
            raise ValueError(f"refuses to write through non-regular output: {destination}") from exc
        else:
            if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
                raise ValueError(f"refuses to write through non-regular output: {destination}")
        os.replace(temporary_name, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    except Exception:
        if temporary_fd is not None:
            try:
                os.close(temporary_fd)
            except OSError:
                pass
        try:
            os.unlink(temporary_name, dir_fd=dir_fd)
        except OSError:
            pass
        raise
    finally:
        os.close(dir_fd)


def _render(result: dict, output: Path | None) -> None:
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if output is None:
        sys.stdout.write(text)
    else:
        _write_output_atomically(output, text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run protected VDD conformance fixtures")
    parser.add_argument("--list", action="store_true", help="list executable case IDs")
    parser.add_argument("--case", type=int, choices=sorted(CASES))
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--output", type=Path)
    return parser

def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.list:
        print(json.dumps({"executable_cases": sorted(CASES)}))
        return 0
    if args.case is None or args.workspace is None:
        raise SystemExit("--case and --workspace are required unless --list is used")
    try:
        if args.output is not None:
            _reject_unsafe_output_path(args.output)
        result = run_case(args.case, args.workspace)
        _render(result, args.output)
    except (OSError, ValueError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2
    return 0 if result["disposition"] == "accepted" else 1


if __name__ == "__main__":
    raise SystemExit(main())
