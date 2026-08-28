"""Protected parent-side proxy for executable VDD fixture candidates."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

if __package__:
    from .candidate_executor import (
        _close_fd,
        _pipe_cloexec_outside_stdio,
        _runtime_read_roots,
        cancel_direct_child,
        close_process_pipes,
    )
else:
    from candidate_executor import (
        _close_fd,
        _pipe_cloexec_outside_stdio,
        _runtime_read_roots,
        cancel_direct_child,
        close_process_pipes,
    )


WORKER = Path(__file__).with_name("candidate_worker.py").resolve()
# The outer boundary includes worker startup, sandbox setup, executor cleanup,
# and response serialization; the candidate execution cap remains inner-owned.
WORKER_TIMEOUT_SECONDS = 30
_RUNTIME_ROOTS_LOCK = threading.Lock()
_RUNTIME_ROOTS_CACHE: tuple[str, ...] | None = None


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
    raise TypeError(f"unsupported candidate protocol value: {type(value).__name__}")


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


def _build_request(
    function: str,
    args: tuple[Any, ...],
    writable_paths: tuple[str, ...],
) -> bytes:
    global _RUNTIME_ROOTS_CACHE
    with _RUNTIME_ROOTS_LOCK:
        if _RUNTIME_ROOTS_CACHE is None:
            _RUNTIME_ROOTS_CACHE = tuple(
                str(path) for path in _runtime_read_roots()
            )
        runtime_roots = _RUNTIME_ROOTS_CACHE
    return json.dumps(
        {
            "function": function,
            "args": [_encode(arg) for arg in args],
            "writable_paths": list(writable_paths),
            "runtime_roots": list(runtime_roots),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _invoke(
    function: str,
    *args: Any,
    writable_paths: tuple[str, ...] = (),
) -> Any:
    candidate_value = os.environ.get("VDD_CANDIDATE_PATH")
    if not candidate_value:
        raise RuntimeError("VDD_CANDIDATE_PATH is required")
    candidate = Path(candidate_value).resolve()
    if not candidate.is_file():
        raise RuntimeError(f"candidate is missing: {candidate}")
    request = _build_request(function, args, writable_paths)
    lifetime_reader, lifetime_writer = _pipe_cloexec_outside_stdio()
    process: subprocess.Popen[bytes] | None = None
    try:
        try:
            process = subprocess.Popen(
                [sys.executable, str(WORKER), str(candidate), str(lifetime_reader)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                pass_fds=(lifetime_reader,),
                start_new_session=True,
            )
        finally:
            _close_fd(lifetime_reader)
        try:
            stdout, stderr = process.communicate(
                input=request,
                timeout=WORKER_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            writer = lifetime_writer
            lifetime_writer = None
            _close_fd(writer)
            cancel_direct_child(process)
            raise RuntimeError("candidate worker exceeded supervisor time budget") from exc
        except BaseException:
            writer = lifetime_writer
            lifetime_writer = None
            _close_fd(writer)
            cancel_direct_child(process)
            raise
        if process.returncode is None:
            writer = lifetime_writer
            lifetime_writer = None
            _close_fd(writer)
            cancel_direct_child(process)
            raise RuntimeError("candidate worker did not exit after response")
        if process.returncode != 0:
            raise RuntimeError(
                f"candidate worker failed with exit {process.returncode}: "
                f"{stderr.decode('utf-8', errors='replace')}"
            )
        try:
            response = json.loads(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("candidate worker returned no valid protected response") from exc
        if not isinstance(response, dict) or response.get("ok") is not True:
            detail = response.get("error") if isinstance(response, dict) else "invalid response"
            raise RuntimeError(f"candidate call failed: {detail}")
        return _decode(response.get("value"))
    finally:
        writer = lifetime_writer
        lifetime_writer = None
        _close_fd(writer)
        close_process_pipes(process)


def slugify(title: str) -> str:
    return _invoke("slugify", title)


def normalize_email(value: str) -> str:
    return _invoke("normalize_email", value)


def discount(total: int) -> int:
    return _invoke("discount", total)


def ingest_webhook(body: bytes, signature: str, timestamp: int, now: int, db_path: str):
    resolved_db = Path(db_path).resolve()
    writable_paths = () if resolved_db.is_dir() else (str(resolved_db.parent),)
    return _invoke(
        "ingest_webhook",
        body,
        signature,
        timestamp,
        now,
        db_path,
        writable_paths=writable_paths,
    )
