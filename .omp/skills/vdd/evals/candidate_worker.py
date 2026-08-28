#!/usr/bin/env python3
"""Supervise candidate execution while exclusively owning the parent protocol."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

if __package__:
    from .candidate_executor import (
        _close_fd,
        _pipe_cloexec_outside_stdio,
        cancel_direct_child,
        close_process_pipes,
    )
else:
    from candidate_executor import (
        _close_fd,
        _pipe_cloexec_outside_stdio,
        cancel_direct_child,
        close_process_pipes,
    )

EXECUTOR = Path(__file__).with_name("candidate_executor.py").resolve()
EXECUTOR_PROTOCOL = "vdd-candidate-return-v1"
# Leave room for trusted sandbox setup and bounded executor cleanup after a
# candidate has consumed its own execution budget.
EXECUTOR_TIMEOUT_SECONDS = 20


def main() -> int:
    if len(sys.argv) != 3:
        print("candidate path and proxy lifetime descriptor are required", file=sys.stderr)
        return 2
    proxy_lifetime_fd = int(sys.argv[2])
    executor_lifetime_reader: int | None = None
    executor_lifetime_writer: int | None = None
    process: subprocess.Popen[bytes] | None = None
    try:
        executor_lifetime_reader, executor_lifetime_writer = (
            _pipe_cloexec_outside_stdio()
        )
        request = sys.stdin.buffer.read()
        try:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(EXECUTOR),
                    sys.argv[1],
                    str(proxy_lifetime_fd),
                    str(executor_lifetime_reader),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                pass_fds=(proxy_lifetime_fd, executor_lifetime_reader),
                start_new_session=True,
            )
        finally:
            _close_fd(executor_lifetime_reader)
            executor_lifetime_reader = None
        try:
            stdout, stderr = process.communicate(
                input=request,
                timeout=EXECUTOR_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            writer = executor_lifetime_writer
            executor_lifetime_writer = None
            _close_fd(writer)
            cancel_direct_child(process)
            raise RuntimeError("candidate executor exceeded supervisor time budget") from exc
        except BaseException:
            writer = executor_lifetime_writer
            executor_lifetime_writer = None
            _close_fd(writer)
            cancel_direct_child(process)
            raise
        finally:
            writer = executor_lifetime_writer
            executor_lifetime_writer = None
            _close_fd(writer)
        if process.returncode is None:
            cancel_direct_child(process)
            raise RuntimeError("candidate executor did not exit after response")
        if process.returncode != 0:
            raise RuntimeError(
                f"candidate executor failed with exit {process.returncode}: "
                f"{stderr.decode('utf-8', errors='replace')}"
            )
        executor_response = json.loads(stdout)
        if (
            not isinstance(executor_response, dict)
            or executor_response.get("executor_protocol") != EXECUTOR_PROTOCOL
            or not isinstance(executor_response.get("ok"), bool)
        ):
            raise RuntimeError("candidate executor returned an invalid isolated response")
        if executor_response["ok"] is True and "value" in executor_response:
            response = {"ok": True, "value": executor_response["value"]}
        elif executor_response["ok"] is False and "error" in executor_response:
            response = {"ok": False, "error": executor_response["error"]}
        else:
            response = {
                "ok": False,
                "error": "candidate executor response omitted its result",
            }
    except BaseException as exc:
        response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        _close_fd(proxy_lifetime_fd)
        _close_fd(executor_lifetime_reader)
        writer = executor_lifetime_writer
        executor_lifetime_writer = None
        _close_fd(writer)
        close_process_pipes(process)
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
