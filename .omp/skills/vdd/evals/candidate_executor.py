#!/usr/bin/env python3
"""Execute one candidate call behind a trusted supervisor and an OS sandbox."""
from __future__ import annotations

import base64
import fcntl
import importlib.util
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Sequence

PROTOCOL = "vdd-candidate-return-v1"
CHILD_FLAG = "--candidate-child"
SANDBOX_GUARDIAN_FLAG = "--sandbox-guardian"
SANDBOX_GATE_FLAG = "--sandbox-gate"
CANDIDATE_OUTPUT_LIMIT_BYTES = 256 * 1024
CANDIDATE_TIMEOUT_SECONDS = 10
CANDIDATE_STARTUP_PROBE_TIMEOUT_SECONDS = 5
CANDIDATE_STARTUP_PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024
SANDBOX_GUARDIAN_POLL_SECONDS = 0.05


def _encode(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"__vdd_type__": "bytes", "base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, tuple):
        return {"__vdd_type__": "tuple", "items": [_encode(item) for item in value]}
    if isinstance(value, list):
        return [_encode(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _encode(item) for key, item in value.items()}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    raise TypeError(f"unsupported candidate return value: {type(value).__name__}")


def _decode(value: Any) -> Any:
    if isinstance(value, dict) and value.get("__vdd_type__") == "bytes":
        return base64.b64decode(value["base64"], validate=True)
    if isinstance(value, dict) and value.get("__vdd_type__") == "tuple":
        return tuple(_decode(item) for item in value["items"])
    if isinstance(value, list):
        return [_decode(item) for item in value]
    if isinstance(value, dict):
        return {key: _decode(item) for key, item in value.items()}
    return value


def _load_candidate(path: Path):
    spec = importlib.util.spec_from_file_location("vdd_candidate", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load candidate: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _candidate_child(
    candidate_path: Path,
    request: dict[str, Any],
) -> int:
    try:
        candidate = _load_candidate(candidate_path)
        function = getattr(candidate, request.get("function"))
        args = [_decode(item) for item in request.get("args", [])]
        response = {"ok": True, "value": _encode(function(*args))}
    except BaseException as exc:
        response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    return 0


def _terminate_guarded_sandbox(process: subprocess.Popen[Any]) -> None:
    """Stop a guardian-owned sandbox without ever signaling an ambient group."""
    if process.pid is None or process.poll() is not None:
        return
    if os.getpgrp() == os.getpid():
        try:
            os.killpg(os.getpgrp(), signal.SIGKILL)
            return
        except ProcessLookupError:
            return
        except OSError:
            pass
    terminate_direct_child(process)


def _run_gated_sandbox(gate_fd: int, child_argv: Sequence[str]) -> int:
    """Exec the sandbox command only after the guardian authorizes startup."""
    try:
        authorized = os.read(gate_fd, 1) == b"1"
    except OSError:
        authorized = False
    finally:
        _close_fd(gate_fd)
    if not authorized:
        return 125
    try:
        os.execv(child_argv[0], list(child_argv))
    except OSError as exc:
        print(f"candidate gate could not exec sandbox: {exc}", file=sys.stderr)
        return 125


def _guard_sandbox_child(
    lifetime_fd: int,
    child_argv: Sequence[str],
    *,
    spawn: Callable[..., subprocess.Popen[Any]] = subprocess.Popen,
) -> int:
    """Own the candidate lifetime across exec and kill its live process group on EOF."""
    if _lifetime_cancelled((lifetime_fd,)):
        _close_fd(lifetime_fd)
        return 125
    cancellation = threading.Event()
    owner_dead = threading.Event()
    watcher_started = threading.Event()
    process_ready = threading.Event()
    process_holder: list[subprocess.Popen[Any]] = []
    gate_reader, gate_writer = _pipe_cloexec_outside_stdio()

    def lifetime_ended() -> bool:
        try:
            return os.read(lifetime_fd, 1) == b""
        except BlockingIOError:
            return False
        except OSError:
            return True

    def monitor_owner_and_authorize() -> None:
        os.set_blocking(lifetime_fd, False)
        if lifetime_ended():
            owner_dead.set()
        watcher_started.set()
        while not owner_dead.is_set() and not process_ready.wait(SANDBOX_GUARDIAN_POLL_SECONDS):
            if lifetime_ended():
                owner_dead.set()
                break
        if not owner_dead.is_set() and lifetime_ended():
            owner_dead.set()
        if not owner_dead.is_set() and process_holder:
            try:
                os.write(gate_writer, b"1")
            except OSError:
                pass
        _close_fd(gate_writer)
        while not owner_dead.is_set():
            if lifetime_ended():
                owner_dead.set()
                break
            cancellation.wait(SANDBOX_GUARDIAN_POLL_SECONDS)
        if process_holder:
            _terminate_guarded_sandbox(process_holder[0])
        cancellation.set()

    watcher = threading.Thread(
        target=monitor_owner_and_authorize,
        name="vdd-sandbox-lifetime",
        daemon=True,
    )
    watcher.start()
    watcher_started.wait()
    if owner_dead.is_set():
        process_ready.set()
        _close_fd(gate_reader)
        _close_fd(lifetime_fd)
        return 125
    gated_argv = [
        sys.executable,
        str(Path(__file__).resolve()),
        SANDBOX_GATE_FLAG,
        str(gate_reader),
        *child_argv,
    ]
    try:
        process = spawn(
            gated_argv,
            close_fds=True,
            pass_fds=(gate_reader,),
        )
    except OSError as exc:
        _close_fd(gate_reader)
        process_ready.set()
        _close_fd(lifetime_fd)
        print(f"candidate guardian could not start child: {exc}", file=sys.stderr)
        return 125
    _close_fd(gate_reader)
    process_holder.append(process)
    process_ready.set()
    if owner_dead.is_set() or cancellation.is_set():
        _terminate_guarded_sandbox(process)
        cancellation.set()
    try:
        while process.poll() is None:
            if cancellation.wait(SANDBOX_GUARDIAN_POLL_SECONDS):
                return 125
        return process.returncode
    finally:
        _close_fd(lifetime_fd)


def _declared_writable_roots(
    candidate_path: Path,
    request: dict[str, Any],
) -> list[Path]:
    roots: list[Path] = []
    writable_paths = request.get("writable_paths", [])
    if not isinstance(writable_paths, list) or any(
        not isinstance(value, str) or not Path(value).is_absolute()
        for value in writable_paths
    ):
        raise RuntimeError("writable_paths must contain only absolute directories")
    for value in writable_paths:
        root = Path(value).resolve()
        if not root.is_dir():
            raise RuntimeError(f"writable root must be an existing directory: {value}")
        if candidate_path == root or root in candidate_path.parents:
            raise RuntimeError("candidate source must remain outside writable roots")
        roots.append(root)
    return list(dict.fromkeys(roots))


def _sandbox_quote(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace('"', '\\"')


def _path_literals(path: Path) -> list[Path]:
    """Return distinct absolute path spellings for seatbelt literals.

    Includes the resolved path and common /var vs /private/var dual forms so a
    candidate file can be opened without granting its parent subpath (siblings).
    Lexical symlink paths are preserved alongside their real targets.
    """
    literals: list[Path] = []
    seen: set[str] = set()

    def add(value: Path) -> None:
        text = str(value)
        if not text or text in seen:
            return
        seen.add(text)
        literals.append(Path(text))
        if text.startswith("/var/"):
            private = Path("/private" + text)
            private_text = str(private)
            if private_text not in seen:
                seen.add(private_text)
                literals.append(private)
        elif text.startswith("/private/var/"):
            short = Path(text[len("/private") :])
            short_text = str(short)
            if short_text not in seen:
                seen.add(short_text)
                literals.append(short)

    add(path)
    try:
        add(path.resolve(strict=False))
    except OSError:
        pass
    try:
        add(Path(os.path.realpath(path)))
    except OSError:
        pass
    if path.is_symlink():
        try:
            add(path.parent / os.readlink(path))
        except OSError:
            pass
    return literals


def _macos_dynamic_dependencies(
    paths: set[Path],
    *,
    lifetime_fds: Sequence[int] = (),
    deadline: float | None = None,
) -> set[Path]:
    if deadline is None:
        deadline = time.monotonic() + CANDIDATE_STARTUP_PROBE_TIMEOUT_SECONDS
    pending_set: set[Path] = set()
    for path in paths:
        if path.is_file():
            pending_set.add(path)
        elif path.is_dir():
            directories = [path]
            while directories:
                directory = directories.pop()
                if _lifetime_cancelled(lifetime_fds):
                    raise _LifetimeCancelled(
                        "candidate call owner exited during sandbox startup"
                    )
                if time.monotonic() >= deadline:
                    raise RuntimeError("macOS runtime dependency discovery timed out")
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if _lifetime_cancelled(lifetime_fds):
                            raise _LifetimeCancelled(
                                "candidate call owner exited during sandbox startup"
                            )
                        if time.monotonic() >= deadline:
                            raise RuntimeError("macOS runtime dependency discovery timed out")
                        if entry.is_dir(follow_symlinks=False):
                            directories.append(Path(entry.path))
                        elif entry.name.endswith((".so", ".dylib")) and entry.is_file():
                            pending_set.add(Path(entry.path))
    pending = sorted(pending_set, key=str)
    queued = set(pending)
    cursor = 0
    dependencies: set[Path] = set()
    while cursor < len(pending):
        if _lifetime_cancelled(lifetime_fds):
            raise _LifetimeCancelled("candidate call owner exited during sandbox startup")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("macOS runtime dependency discovery timed out")
        batch = pending[cursor : cursor + 64]
        cursor += len(batch)
        process: subprocess.Popen[bytes] | None = None
        try:
            process = subprocess.Popen(
                ["otool", "-L", *(str(path) for path in batch)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={"PATH": os.defpath, "LC_ALL": "C", "LANG": "C"},
                close_fds=True,
                start_new_session=True,
                bufsize=0,
            )
        except OSError:
            continue
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                terminate_direct_child(process)
                raise RuntimeError("macOS runtime dependency discovery timed out")
            stdout, _ = _collect_bounded_output(
                process,
                request_bytes=b"",
                limit=CANDIDATE_STARTUP_PROBE_OUTPUT_LIMIT_BYTES,
                timeout=min(CANDIDATE_STARTUP_PROBE_TIMEOUT_SECONDS, remaining),
                lifetime_fds=lifetime_fds,
            )
            if process.poll() is None:
                process.wait(timeout=DIRECT_CHILD_CLEANUP_GRACE_SECONDS)
        except _LifetimeCancelled:
            terminate_direct_child(process)
            raise
        except (TimeoutError, subprocess.TimeoutExpired) as exc:
            terminate_direct_child(process)
            raise RuntimeError("macOS runtime dependency discovery timed out") from exc
        except BaseException:
            terminate_direct_child(process)
            raise
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            match = re.match(r"\s*(/[^\s]+)", line)
            if match is None:
                continue
            dependency = Path(match.group(1))
            if not dependency.exists():
                continue
            dependency = dependency.resolve(strict=False)
            if dependency not in dependencies:
                dependencies.add(dependency)
                if dependency not in queued:
                    queued.add(dependency)
                    pending.append(dependency)
    return dependencies


def _runtime_read_roots(
    *,
    lifetime_fds: Sequence[int] = (),
    deadline: float | None = None,
) -> list[Path]:
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
                lifetime_fds=lifetime_fds,
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


def _sandbox_command(
    candidate_path: Path,
    writable_roots: list[Path],
    sandbox_cwd: Path,
    *,
    lifetime_fds: Sequence[int] = (),
    runtime_roots: Sequence[Path] | None = None,
    child_lifetime_fd: int | None = None,
) -> list[str]:
    executor_path = Path(__file__).resolve()
    executable_path = Path(sys.executable).resolve()
    child = [str(executable_path), str(executor_path), CHILD_FLAG, str(candidate_path)]
    startup_deadline = time.monotonic() + CANDIDATE_STARTUP_PROBE_TIMEOUT_SECONDS
    if runtime_roots is None:
        runtime_roots = _runtime_read_roots(
            lifetime_fds=lifetime_fds,
            deadline=startup_deadline,
        )
    else:
        runtime_roots = list(runtime_roots)
    if sys.platform == "darwin":
        sandbox = shutil.which("sandbox-exec", path=os.defpath)
        if sandbox is None:
            raise RuntimeError("sandbox-exec is required for candidate isolation on macOS")
        candidate_literals = _path_literals(candidate_path)
        read_literals = [
            Path("/"),
            *candidate_literals,
            executor_path,
            executable_path,
            *(path for path in runtime_roots if path.is_file()),
        ]
        read_roots = [
            *(path for path in runtime_roots if path.is_dir()),
            *_path_literals(sandbox_cwd),
            *writable_roots,
        ]
        read_rules = [
            f'(allow file-read* (literal "{_sandbox_quote(path)}"))'
            for path in read_literals
        ]
        read_rules.extend(
            f'(allow file-read* (subpath "{_sandbox_quote(root)}"))'
            for root in read_roots
        )
        write_rules = [
            f'(allow file-write* (subpath "{_sandbox_quote(root)}"))'
            for root in writable_roots
        ]
        profile = "\n".join(
            [
                "(version 1)",
                "(deny default)",
                "(allow process-exec)",
                "(deny process-fork)",
                "(deny signal)",
                "(deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))",
                "(allow file-read-metadata)",
                "(allow sysctl-read)",
                *read_rules,
                *write_rules,
            ]
        )
        command = [sandbox, "-p", profile, *child]
        if child_lifetime_fd is not None:
            return [
                str(executable_path),
                str(executor_path),
                SANDBOX_GUARDIAN_FLAG,
                str(child_lifetime_fd),
                *command,
            ]
        return command
    if sys.platform.startswith("linux"):
        bubblewrap = shutil.which("bwrap", path=os.defpath)
        if bubblewrap is None:
            raise RuntimeError("bwrap is required for candidate isolation on Linux")
        exact_read_paths = [candidate_path, executor_path, executable_path]
        mount_paths = runtime_roots + exact_read_paths + [sandbox_cwd] + writable_roots
        command = [bubblewrap, "--unshare-all", "--die-with-parent", "--tmpfs", "/"]
        for parent in _bwrap_parent_directories(mount_paths):
            command.extend(["--dir", str(parent)])
        for root in runtime_roots:
            command.extend(["--ro-bind", str(root), str(root)])
        for path in exact_read_paths:
            if not any(path == root or root in path.parents for root in runtime_roots):
                command.extend(["--ro-bind", str(path), str(path)])
        command.extend(["--ro-bind", str(sandbox_cwd), str(sandbox_cwd)])
        for root in writable_roots:
            command.extend(["--bind", str(root), str(root)])
        command.extend(["--dev", "/dev", "--proc", "/proc", *child])
        if child_lifetime_fd is not None:
            return [
                str(executable_path),
                str(executor_path),
                SANDBOX_GUARDIAN_FLAG,
                str(child_lifetime_fd),
                *command,
            ]
        return command
    raise RuntimeError(f"candidate isolation is unsupported on {sys.platform}")


DIRECT_CHILD_CLEANUP_GRACE_SECONDS = 1


class _LifetimeCancelled(RuntimeError):
    """Raised when a trusted caller or worker ends the candidate call."""


def _close_fd(fd: int | None) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass


def _pipe_cloexec_outside_stdio() -> tuple[int, int]:
    """Create an internal pipe whose descriptors cannot alias stdin/out/err."""
    reader, writer = os.pipe()

    def move(fd: int) -> int:
        if fd > 2:
            return fd
        duplicate = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 3)
        os.close(fd)
        return duplicate

    try:
        reader = move(reader)
        writer = move(writer)
        return reader, writer
    except BaseException:
        _close_fd(reader)
        _close_fd(writer)
        raise


def close_process_pipes(process: subprocess.Popen[Any] | None) -> None:
    if process is None:
        return
    for name in ("stdin", "stdout", "stderr"):
        pipe = getattr(process, name, None)
        if pipe is not None and not getattr(pipe, "closed", False):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass


def _lifetime_cancelled(lifetime_fds: Sequence[int]) -> bool:
    """Return whether any inherited lifetime pipe has reached EOF."""
    if not lifetime_fds:
        return False
    poller = select.poll()
    for fd in lifetime_fds:
        poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    for fd, _ in poller.poll(0):
        try:
            if os.read(fd, 1) == b"":
                return True
        except BlockingIOError:
            continue
        except OSError:
            return True
    return False


def _poll_ready(
    readers: Sequence[Any],
    writers: Sequence[Any],
    timeout: float,
) -> tuple[list[Any], list[Any]]:
    """Poll arbitrary descriptor numbers without select(2)'s FD_SETSIZE cap."""
    poller = select.poll()
    objects: dict[int, Any] = {}
    reader_fds: set[int] = set()
    writer_fds: set[int] = set()
    for value in readers:
        fd = value if isinstance(value, int) else value.fileno()
        objects[fd] = value
        reader_fds.add(fd)
        poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    for value in writers:
        fd = value if isinstance(value, int) else value.fileno()
        objects[fd] = value
        writer_fds.add(fd)
        events = select.POLLOUT | select.POLLHUP | select.POLLERR
        if fd in reader_fds:
            events |= select.POLLIN
            poller.modify(fd, events)
        else:
            poller.register(fd, events)
    timeout_ms = max(0, int(timeout * 1000 + 0.999))
    readable: list[Any] = []
    writable: list[Any] = []
    for fd, events in poller.poll(timeout_ms):
        if fd in reader_fds and events & (
            select.POLLIN | select.POLLHUP | select.POLLERR | select.POLLNVAL
        ):
            readable.append(objects[fd])
        if fd in writer_fds and events & (
            select.POLLOUT | select.POLLHUP | select.POLLERR | select.POLLNVAL
        ):
            writable.append(objects[fd])
    return readable, writable


def terminate_direct_child(process: subprocess.Popen[Any]) -> None:
    """Kill and reap only a live direct child; never inspect host descendants."""
    # A live child or unreaped zombie retains its PID. Once returncode is set, it
    # has been reaped and its numeric PID may already belong to another process.
    if process.pid is None or getattr(process, "returncode", None) is not None:
        return
    try:
        process.kill()
    except (ProcessLookupError, OSError):
        pass
    try:
        process.wait(timeout=DIRECT_CHILD_CLEANUP_GRACE_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        pass


def cancel_direct_child(
    process: subprocess.Popen[Any],
) -> None:
    """Wait briefly for lifetime cancellation, then force-stop only a direct child."""
    if process.pid is None or getattr(process, "returncode", None) is not None:
        return
    try:
        process.wait(timeout=DIRECT_CHILD_CLEANUP_GRACE_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass
    except OSError:
        return
    terminate_direct_child(process)


def terminate_owned_sandbox(process: subprocess.Popen[Any]) -> None:
    """Kill and reap the executor-created sandbox process group.

    The sandbox is launched with ``start_new_session=True``. While its direct root
    remains unreaped, its PID is also the owned process-group ID and cannot be
    reused. Candidate descendants are contained by macOS fork denial or Linux's
    PID namespace; no host process-table discovery is required.
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
        process.wait(timeout=DIRECT_CHILD_CLEANUP_GRACE_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        pass


def _collect_bounded_output(
    process: subprocess.Popen[bytes],
    *,
    request_bytes: bytes,
    limit: int,
    timeout: float,
    lifetime_fds: Sequence[int] = (),
) -> tuple[bytes, bytes]:
    """Stream bounded candidate output and stop when an owner lifetime ends."""
    if process.stdin is None or process.stdout is None or process.stderr is None:
        raise RuntimeError("sandboxed candidate pipes are unavailable")
    for pipe in (process.stdin, process.stdout, process.stderr):
        flags = fcntl.fcntl(pipe.fileno(), fcntl.F_GETFL)
        fcntl.fcntl(pipe.fileno(), fcntl.F_SETFL, flags | os.O_NONBLOCK)
    for fd in lifetime_fds:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    if _lifetime_cancelled(lifetime_fds):
        raise _LifetimeCancelled("candidate call owner exited")
    deadline = time.monotonic() + timeout
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_size = 0
    stderr_size = 0
    stdin_view = memoryview(request_bytes)
    stdin_offset = 0
    stdout_open = True
    stderr_open = True
    try:
        while stdout_open or stderr_open or stdin_offset < len(request_bytes):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("sandboxed candidate exceeded time budget")
            readers = []
            writers = []
            if stdout_open:
                readers.append(process.stdout)
            if stderr_open:
                readers.append(process.stderr)
            readers.extend(lifetime_fds)
            if stdin_offset < len(request_bytes):
                writers.append(process.stdin)
            readable, writable = _poll_ready(
                readers,
                writers,
                min(remaining, 0.05),
            )
            for fd in lifetime_fds:
                if fd not in readable:
                    continue
                try:
                    if os.read(fd, 1) == b"":
                        raise _LifetimeCancelled("candidate call owner exited")
                except BlockingIOError:
                    continue
                except OSError as exc:
                    raise _LifetimeCancelled("candidate call lifetime became unavailable") from exc
            if process.stdin in writable and stdin_offset < len(request_bytes):
                try:
                    written = process.stdin.write(stdin_view[stdin_offset : stdin_offset + 65536])
                except (BrokenPipeError, OSError):
                    stdin_offset = len(request_bytes)
                else:
                    if written:
                        stdin_offset += written
                    if stdin_offset >= len(request_bytes):
                        process.stdin.close()
            if process.stdout in readable:
                try:
                    chunk = os.read(process.stdout.fileno(), 65536)
                except BlockingIOError:
                    chunk = b""
                else:
                    if not chunk:
                        stdout_open = False
                    elif stdout_size + len(chunk) > limit:
                        raise RuntimeError(
                            f"sandboxed candidate stdout exceeded bounded output limit of {limit} bytes"
                        )
                    else:
                        stdout_chunks.append(chunk)
                        stdout_size += len(chunk)
            if process.stderr in readable:
                try:
                    chunk = os.read(process.stderr.fileno(), 65536)
                except BlockingIOError:
                    chunk = b""
                else:
                    if not chunk:
                        stderr_open = False
                    elif stderr_size + len(chunk) > limit:
                        raise RuntimeError(
                            f"sandboxed candidate stderr exceeded bounded output limit of {limit} bytes"
                        )
                    else:
                        stderr_chunks.append(chunk)
                        stderr_size += len(chunk)
        return b"".join(stdout_chunks), b"".join(stderr_chunks)
    finally:
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None and not pipe.closed:
                try:
                    pipe.close()
                except OSError:
                    pass


def _supervise(
    candidate_path: Path,
    request_bytes: bytes,
    *,
    lifetime_fds: Sequence[int] = (),
) -> dict[str, Any]:
    request = json.loads(request_bytes)
    if not isinstance(request, dict):
        raise RuntimeError("candidate request must be an object")
    writable_roots = _declared_writable_roots(candidate_path, request)
    raw_runtime_roots = request.get("runtime_roots")
    runtime_roots: list[Path] | None = None
    if raw_runtime_roots is not None:
        if (
            not isinstance(raw_runtime_roots, list)
            or not raw_runtime_roots
            or len(raw_runtime_roots) > 1024
            or any(
                not isinstance(value, str) or not Path(value).is_absolute()
                for value in raw_runtime_roots
            )
        ):
            raise RuntimeError("runtime_roots must contain bounded absolute paths")
        runtime_roots = []
        for value in raw_runtime_roots:
            root = Path(value).resolve(strict=False)
            if not root.exists():
                raise RuntimeError(f"runtime root is unavailable: {value}")
            runtime_roots.append(root)
        runtime_roots = list(dict.fromkeys(runtime_roots))
    try:
        if _lifetime_cancelled(lifetime_fds):
            raise RuntimeError("candidate call owner exited before sandbox startup")
        with tempfile.TemporaryDirectory(prefix="vdd-candidate-cwd-") as sandbox_cwd:
            child_lifetime_reader, child_lifetime_writer = (
                _pipe_cloexec_outside_stdio()
            )
            try:
                try:
                    process = subprocess.Popen(
                        _sandbox_command(
                            candidate_path,
                            writable_roots,
                            Path(sandbox_cwd),
                            lifetime_fds=lifetime_fds,
                            runtime_roots=runtime_roots,
                            child_lifetime_fd=child_lifetime_reader,
                        ),
                        cwd=sandbox_cwd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        close_fds=True,
                        pass_fds=(child_lifetime_reader,),
                        start_new_session=True,
                        bufsize=0,
                    )
                finally:
                    _close_fd(child_lifetime_reader)
                    child_lifetime_reader = None
                try:
                    stdout, stderr = _collect_bounded_output(
                        process,
                        request_bytes=request_bytes,
                        limit=CANDIDATE_OUTPUT_LIMIT_BYTES,
                        timeout=CANDIDATE_TIMEOUT_SECONDS,
                        lifetime_fds=lifetime_fds,
                    )
                    if process.poll() is None:
                        try:
                            process.wait(timeout=DIRECT_CHILD_CLEANUP_GRACE_SECONDS)
                        except subprocess.TimeoutExpired:
                            raise RuntimeError(
                                "sandboxed candidate did not exit after closing output"
                            )
                    if process.returncode != 0:
                        detail = stderr.decode("utf-8", errors="replace")
                        if len(detail) > 512:
                            detail = detail[:512]
                        raise RuntimeError(
                            f"sandboxed candidate failed with exit {process.returncode}: {detail}"
                        )
                    if len(stdout) > CANDIDATE_OUTPUT_LIMIT_BYTES:
                        raise RuntimeError(
                            f"sandboxed candidate response exceeded bounded output limit of "
                            f"{CANDIDATE_OUTPUT_LIMIT_BYTES} bytes"
                        )
                    response = json.loads(stdout)
                    if (
                        not isinstance(response, dict)
                        or not isinstance(response.get("ok"), bool)
                        or (response["ok"] is True and "value" not in response)
                        or (response["ok"] is False and "error" not in response)
                    ):
                        raise RuntimeError("sandboxed candidate returned an invalid response")
                    return response
                except TimeoutError as exc:
                    terminate_owned_sandbox(process)
                    raise RuntimeError(str(exc)) from exc
                except _LifetimeCancelled as exc:
                    terminate_owned_sandbox(process)
                    raise RuntimeError(str(exc)) from exc
                except BaseException:
                    # Once a direct child is reaped, its PID/PGID can be reused. The
                    # sandbox boundary is safe to signal only while still unreaped.
                    if getattr(process, "returncode", None) is None:
                        terminate_owned_sandbox(process)
                    raise
            finally:
                _close_fd(child_lifetime_reader)
                _close_fd(child_lifetime_writer)
    finally:
        for fd in lifetime_fds:
            _close_fd(fd)


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == SANDBOX_GATE_FLAG:
        return _run_gated_sandbox(int(sys.argv[2]), sys.argv[3:])
    if len(sys.argv) >= 4 and sys.argv[1] == SANDBOX_GUARDIAN_FLAG:
        return _guard_sandbox_child(int(sys.argv[2]), sys.argv[3:])
    if len(sys.argv) == 3 and sys.argv[1] == CHILD_FLAG:
        request = json.loads(sys.stdin.buffer.read())
        return _candidate_child(Path(sys.argv[2]).resolve(), request)
    if len(sys.argv) < 2:
        print("candidate path is required", file=sys.stderr)
        return 2
    try:
        lifetime_fds = tuple(int(value) for value in sys.argv[2:])
        response = _supervise(
            Path(sys.argv[1]).resolve(),
            sys.stdin.buffer.read(),
            lifetime_fds=lifetime_fds,
        )
        response["executor_protocol"] = PROTOCOL
    except BaseException as exc:
        response = {
            "executor_protocol": PROTOCOL,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
